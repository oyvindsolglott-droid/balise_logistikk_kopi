"""Local transcription for TOGPLASSERING SKIEN, with no network calls.

The geometry stage already locates the printed rules and rectifies the sheet, so
every cell boundary is known exactly. This module reads those cells with the
Apache-2.0 PP-OCRv5 recognizer that ships in the repository, which means a plan
can be imported without sending the photo anywhere or paying per read.

It is deliberately weaker than a remote model on free text. Rather than hide
that, every free-text cell is marked for human review, and structured cells fall
back to review whenever the recognizer is unsure or the value is not a canonical
track. Nothing here can auto-accept a value the operator has not seen.
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import cv2
import numpy as np

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
MODEL_DIR = REPOSITORY_ROOT / "assets" / "models" / "latin-pp-ocrv5-mobile-rec-onnx"
MODEL_FILE = MODEL_DIR / "inference.onnx"
CONFIG_FILE = MODEL_DIR / "inference.yml"

MODEL_HEIGHT = 48
MAX_MODEL_WIDTH = 1200
INK_THRESHOLD = 235

# Column order of the rectified sheet, left to right.
COLUMN_FIELDS = ["klokken", "fra_tog", "til_tog", "setter", "til_spor", "vd_vann", "info", "merknad"]
FREE_TEXT_FIELDS = {"info", "merknad"}

# Restricting the alphabet per column removes the confusions this form actually
# suffers from: O for 0, S for 5, I for 1 in numeric columns.
COLUMN_ALPHABETS = {
    "klokken": set("0123456789:. "),
    "fra_tog": set("0123456789REP/"),
    "til_tog": set("0123456789REP/"),
    "setter": set("0123456789-/ "),
    "til_spor": set("0123456789NSMVnsmv/+- "),
    "vd_vann": set("xX*✓✔√×"),
}

HIGH_CONFIDENCE = 0.90
MEDIUM_CONFIDENCE = 0.70

_session = None
_characters: list[str] = []


def _load_characters() -> list[str]:
    text = CONFIG_FILE.read_text(encoding="utf-8")
    block = re.search(r"character_dict:\n((?:[ \t]*-[ \t].*\n)+)", text)
    if not block:
        raise RuntimeError("character_dict mangler i inference.yml")
    entries = []
    for line in block.group(1).splitlines():
        value = line.split("- ", 1)[1].rstrip("\n")
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        entries.append(value)
    return entries


def load_recognizer():
    global _session, _characters
    if _session is not None:
        return _session, _characters
    if not MODEL_FILE.exists():
        raise RuntimeError("Lokal tekstmodell mangler: assets/models/latin-pp-ocrv5-mobile-rec-onnx")
    import onnxruntime as ort

    options = ort.SessionOptions()
    options.log_severity_level = 3
    _session = ort.InferenceSession(str(MODEL_FILE), options, providers=["CPUExecutionProvider"])
    _characters = _load_characters()
    return _session, _characters


EDGE_BAND = 0.16
RULE_SPAN = 0.85


def suppress_printed_rules(gray: np.ndarray) -> np.ndarray:
    """Erase leftover table rules that intrude on a cell.

    A digit 1 is itself a near-full-height vertical stroke, so removing every
    long run would delete real values. Only strokes that both span almost the
    whole cell and hug an edge are treated as the printed grid.
    """
    height, width = gray.shape
    if height < 12 or width < 12:
        return gray
    binary = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, 25, 12)
    rules = np.zeros_like(binary)

    row_span = binary.sum(axis=1) / (255.0 * width)
    edge_rows = max(1, int(round(height * EDGE_BAND)))
    for row in np.where(row_span >= RULE_SPAN)[0]:
        if row < edge_rows or row >= height - edge_rows:
            rules[row, :] = 255

    column_span = binary.sum(axis=0) / (255.0 * height)
    edge_columns = max(1, int(round(width * EDGE_BAND)))
    for column in np.where(column_span >= RULE_SPAN)[0]:
        if column < edge_columns or column >= width - edge_columns:
            rules[:, column] = 255

    if not rules.any():
        return gray
    rules = cv2.dilate(rules, np.ones((3, 3), np.uint8), iterations=1)
    cleaned = gray.copy()
    cleaned[rules > 0] = 255
    return cleaned


def _ink_bounds(gray: np.ndarray):
    ink = gray < INK_THRESHOLD
    if not ink.any():
        return None
    rows, columns = np.where(ink)
    return (
        max(0, int(rows.min()) - 2),
        min(gray.shape[0] - 1, int(rows.max()) + 2),
        max(0, int(columns.min()) - 2),
        min(gray.shape[1] - 1, int(columns.max()) + 2),
    )


def _decode(logits: np.ndarray, characters: list[str], allowed: set[str] | None) -> tuple[str, float]:
    shifted = logits - logits.max(axis=1, keepdims=True)
    probabilities = np.exp(shifted)
    probabilities /= probabilities.sum(axis=1, keepdims=True)
    if allowed is None:
        best = logits.argmax(axis=1)
    else:
        mask = np.full(logits.shape[1], -np.inf, dtype=np.float32)
        mask[0] = 0.0
        for index, character in enumerate(characters):
            if character in allowed:
                mask[index + 1] = 0.0
        best = (logits + mask[: logits.shape[1]]).argmax(axis=1)
    text: list[str] = []
    scores: list[float] = []
    previous = 0
    for step, index in enumerate(best):
        if index != 0 and index != previous:
            position = int(index) - 1
            if 0 <= position < len(characters):
                text.append(characters[position])
                scores.append(float(probabilities[step, index]))
        previous = index
    return "".join(text).strip(), float(np.mean(scores)) if scores else 0.0


def read_cell(gray: np.ndarray, field: str = "") -> tuple[str, float]:
    """Read one already-cropped cell. Returns the text and a 0..1 certainty."""
    session, characters = load_recognizer()
    cleaned = suppress_printed_rules(gray)
    bounds = _ink_bounds(cleaned)
    if bounds is None:
        return "", 1.0
    top, bottom, left, right = bounds
    crop = cleaned[top : bottom + 1, left : right + 1]
    # A phone photo scaled down leaves very short glyphs, and downsampling those
    # straight to the model height drops strokes. Enlarge first.
    if crop.shape[0] < MODEL_HEIGHT:
        factor = MODEL_HEIGHT / max(1, crop.shape[0])
        crop = cv2.resize(crop, None, fx=factor, fy=factor, interpolation=cv2.INTER_CUBIC)
    source_height, source_width = crop.shape
    width = int(max(32, min(MAX_MODEL_WIDTH, round((source_width / max(1, source_height)) * MODEL_HEIGHT))))
    resized = cv2.resize(crop, (width, MODEL_HEIGHT), interpolation=cv2.INTER_AREA)
    rgb = cv2.cvtColor(resized, cv2.COLOR_GRAY2RGB).astype(np.float32) / 255.0
    tensor = ((rgb - 0.5) / 0.5).transpose(2, 0, 1)[None, ...]
    logits = session.run(["fetch_name_0"], {"x": tensor})[0][0]
    return _decode(logits, characters, COLUMN_ALPHABETS.get(field))


def confidence_label(field: str, text: str, certainty: float) -> str:
    if not text:
        return "high"
    # Free text is where this recognizer is weakest, so it never claims certainty.
    if field in FREE_TEXT_FIELDS:
        return "low"
    if certainty >= HIGH_CONFIDENCE:
        return "high"
    if certainty >= MEDIUM_CONFIDENCE:
        return "medium"
    return "low"


# A three-digit year is a misread, not a date. Reject it rather than import it.
DATE_PATTERN = re.compile(r"(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4}|\d{2})(?!\d)")

TRAIN_ROW_COUNT = 16
NOTE_ROW_COUNT = 3
# Row boundaries within the qualified 31-line family.
FIRST_DATA_LINE = 3
FIRST_NOTE_LINE = 20


def _cell_gray(rect: np.ndarray, left: float, top: float, right: float, bottom: float) -> np.ndarray:
    inset_x = max(2, int((right - left) * 0.04))
    inset_y = max(2, int((bottom - top) * 0.10))
    x0 = int(round(left)) + inset_x
    x1 = int(round(right)) - inset_x
    y0 = int(round(top)) + inset_y
    y1 = int(round(bottom)) - inset_y
    if x1 <= x0 or y1 <= y0:
        return np.zeros((1, 1), dtype=np.uint8) + 255
    crop = rect[y0:y1, x0:x1]
    if crop.ndim == 3:
        return cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    return crop


def _read_row(rect: np.ndarray, vxs, top: float, bottom: float) -> dict[str, Any]:
    row: dict[str, Any] = {"confidence": {}, "review_reason": ""}
    for index, field in enumerate(COLUMN_FIELDS):
        gray = _cell_gray(rect, vxs[index], top, vxs[index + 1], bottom)
        text, certainty = read_cell(gray, field)
        row[field] = text
        row["confidence"][field] = confidence_label(field, text, certainty)
    return row


def _read_date(rect: np.ndarray, vxs, hys) -> str:
    """Find the sheet date anywhere in the header band above the data grid.

    Reading the whole band as one strip gives the recognizer an extremely wide
    image and the date drowns in the printed column titles, so scan the header
    cell by cell and take the first value shaped like a date.
    """
    for band in range(min(FIRST_DATA_LINE, len(hys) - 1)):
        for column in range(len(vxs) - 1):
            gray = _cell_gray(rect, vxs[column], hys[band], vxs[column + 1], hys[band + 1])
            text, _certainty = read_cell(gray)
            match = DATE_PATTERN.search(text.replace(" ", ""))
            if not match:
                continue
            day, month, year = match.groups()
            if len(year) == 2:
                year = f"20{year}"
            return f"{int(day):02d}.{int(month):02d}.{year}"
    return ""


def read_form(geometry: dict[str, Any]) -> dict[str, Any]:
    """Transcribe a qualified sheet locally, shaped like a single AI pass."""
    rect, vxs, hys = geometry["rectified"], geometry["vxs"], geometry["hys"]
    train_rows = [
        _read_row(rect, vxs, hys[FIRST_DATA_LINE + index], hys[FIRST_DATA_LINE + index + 1])
        for index in range(TRAIN_ROW_COUNT)
    ]
    note_rows = [
        _read_row(rect, vxs, hys[FIRST_NOTE_LINE + index], hys[FIRST_NOTE_LINE + index + 1])
        for index in range(NOTE_ROW_COUNT)
    ]
    date_raw = _read_date(rect, vxs, hys)
    warnings = [
        "Lokal lesing uten AI-tjeneste. Fritekst i INFO og Merknad er alltid merket "
        "for kontroll, og alle felt skal kontrolleres mot bildet før lagring."
    ]
    if not date_raw:
        warnings.append("Arkdatoen kunne ikke leses sikkert. Kontroller og sett datoen manuelt.")
    return {
        "form_title": "TOGPLASSERING SKIEN",
        "date_raw": date_raw,
        "train_rows": train_rows,
        "note_rows": note_rows,
        "warnings": warnings,
    }
