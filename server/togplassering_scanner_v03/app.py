from __future__ import annotations

import base64
import io
import json
import math
import os
import re
import traceback
from pathlib import Path
from typing import Any

import cv2
import numpy as np
import requests
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, HTMLResponse
from PIL import Image, ImageDraw, ImageOps
from scipy.signal import find_peaks

APP_DIR = Path(__file__).resolve().parent
STATIC_DIR = APP_DIR / "static"
OPENAI_URL = "https://api.openai.com/v1/responses"
DEFAULT_MODEL = "gpt-5.6-sol"
MAX_IMAGE_BYTES = 25 * 1024 * 1024

# Fixed template: TOGPLASSERING SKIEN. These are not OCR guesses; they describe the
# printed grid geometry of this form and are used only to select the correct line family.
VERT_TEMPLATE = np.array([0.0, 0.08696, 0.16033, 0.25000, 0.33696, 0.42391, 0.52174, 0.76630, 1.0])
HORIZ_TEMPLATE = np.array([
    0.0000, 0.0195, 0.0341, 0.0666, 0.0990, 0.1331, 0.1672, 0.2013,
    0.2403, 0.2744, 0.3084, 0.3409, 0.3734, 0.4058, 0.4383, 0.4675,
    0.4919, 0.5227, 0.5519, 0.5812, 0.6120, 0.6494, 0.6916, 0.7354,
    0.7792, 0.8198, 0.8604, 0.9010, 0.9416, 0.9756, 1.0000
])

ALLOWED_TRACKS = [
    "1N", "1S", "2N", "2S", "3N", "3M", "3S", "4N", "4M", "4S",
    "5N", "5M", "5S", "6N", "6S", "6SS", "7N", "7S", "7SS", "8N",
    "8S", "8SS", "9", "10N", "10S", "11N", "11S", "12N", "12S", "VN", "VS"
]
FIELDS = ["klokken", "fra_tog", "til_tog", "setter", "til_spor", "vd_vann", "info", "merknad"]

app = FastAPI(title="Togplassering Skien – AI-skanner", version="0.3")


# ----------------------------- image helpers ---------------------------------

def _decode_image(raw: bytes) -> Image.Image:
    if not raw:
        raise ValueError("Tom bildefil")
    if len(raw) > MAX_IMAGE_BYTES:
        raise ValueError("Bildet er større enn 25 MB")
    im = Image.open(io.BytesIO(raw))
    im = ImageOps.exif_transpose(im).convert("RGB")
    if im.width < 250 or im.height < 350:
        raise ValueError("Bildet er for lite til sikker skjemalesing")
    return im


def _to_jpeg_data_url(im: Image.Image, quality: int = 90) -> str:
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=quality, optimize=True)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


def _cv_to_pil(arr: np.ndarray) -> Image.Image:
    return Image.fromarray(cv2.cvtColor(arr, cv2.COLOR_BGR2RGB))


def _pil_to_cv(im: Image.Image) -> np.ndarray:
    return cv2.cvtColor(np.asarray(im), cv2.COLOR_RGB2BGR)


# ----------------------------- geometry engine --------------------------------

def _select_by_template(peaks: np.ndarray, template: np.ndarray, min_span: float) -> tuple[np.ndarray | None, float]:
    """Select an ordered subset of peaks that best matches a fixed normalized grid.

    Returns (selected peaks, normalized RMS mismatch). This is line-geometry matching,
    not text recognition.
    """
    peaks = np.asarray(peaks, dtype=float)
    n = len(template)
    if len(peaks) < n:
        return None, 999.0

    best = None
    best_cost = 999.0
    # Candidate outer boundaries. Limit combinatorics by requiring enough points between.
    for i in range(0, len(peaks) - n + 1):
        for j in range(i + n - 1, len(peaks)):
            span = peaks[j] - peaks[i]
            if span < min_span:
                continue
            expected = peaks[i] + span * template
            chosen = [peaks[i]]
            prev_idx = i
            ok = True
            sq = 0.0
            for k in range(1, n - 1):
                # preserve ordering and leave room for remaining points
                lo = prev_idx + 1
                hi = j - ((n - 1) - k) + 1
                if lo >= hi:
                    ok = False
                    break
                idxs = np.arange(lo, hi)
                idx = int(idxs[np.argmin(np.abs(peaks[idxs] - expected[k]))])
                err = abs(peaks[idx] - expected[k]) / span
                if err > 0.045:
                    ok = False
                    break
                chosen.append(peaks[idx])
                prev_idx = idx
                sq += err * err
            if not ok:
                continue
            chosen.append(peaks[j])
            cost = math.sqrt(sq / max(1, n - 2))
            # Prefer wide outer span if costs are similar.
            cost -= min(0.008, span / 100000.0)
            if cost < best_cost:
                best_cost = cost
                best = np.asarray(chosen, dtype=float)
    return best, best_cost


def _make_line_masks(gray: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    h, w = gray.shape
    # Adaptive threshold handles uneven phone-camera lighting. Morphological opening then
    # keeps only long grid strokes and suppresses most printed/handwritten glyphs.
    block = max(31, int(round(min(h, w) * 0.075)) | 1)
    if block % 2 == 0:
        block += 1
    bw = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY_INV, block, 10)
    vk = max(17, int(round(h * 0.028)))
    hk = max(31, int(round(w * 0.085)))
    vert = cv2.morphologyEx(bw, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (1, vk)))
    horiz = cv2.morphologyEx(bw, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (hk, 1)))
    return vert, horiz


def _vertical_peaks(mask: np.ndarray, y: int) -> tuple[np.ndarray, np.ndarray]:
    h, w = mask.shape
    half = max(8, int(round(h * 0.016)))
    y0, y1 = max(0, y - half), min(h, y + half + 1)
    scores = mask[y0:y1, :].sum(axis=0) / 255.0
    distance = max(7, int(round(w * 0.018)))
    height = max(5.0, (y1 - y0) * 0.50)
    peaks, props = find_peaks(scores, height=height, distance=distance, prominence=max(2.0, (y1 - y0) * 0.08))
    heights = props.get("peak_heights", np.zeros(len(peaks)))
    return peaks.astype(int), heights


def _horizontal_peaks(mask: np.ndarray, x: int) -> tuple[np.ndarray, np.ndarray]:
    h, w = mask.shape
    half = max(8, int(round(w * 0.025)))
    x0, x1 = max(0, x - half), min(w, x + half + 1)
    scores = mask[:, x0:x1].sum(axis=1) / 255.0
    distance = max(7, int(round(h * 0.011)))
    height = max(5.0, (x1 - x0) * 0.50)
    peaks, props = find_peaks(scores, height=height, distance=distance, prominence=max(2.0, (x1 - x0) * 0.08))
    heights = props.get("peak_heights", np.zeros(len(peaks)))
    return peaks.astype(int), heights


def _find_vertical_seed(mask: np.ndarray) -> tuple[int, np.ndarray, float]:
    h, w = mask.shape
    best = None
    for frac in np.linspace(0.075, 0.30, 25):
        y = int(round(h * frac))
        peaks, heights = _vertical_peaks(mask, y)
        selected, mismatch = _select_by_template(peaks, VERT_TEMPLATE, min_span=w * 0.77)
        if selected is None:
            continue
        # reward strong continuous line evidence
        strength = 0.0
        for p in selected:
            idx = int(np.argmin(np.abs(peaks - p)))
            strength += float(heights[idx]) if len(heights) else 0.0
        score = mismatch - strength / 200000.0
        if best is None or score < best[0]:
            best = (score, y, selected, mismatch)
    if best is None:
        raise ValueError("Fant ikke de 9 kolonnelinjene i skjemaet")
    return best[1], best[2], best[3]


def _find_horizontal_seed(mask: np.ndarray) -> tuple[int, np.ndarray, float]:
    h, w = mask.shape
    best = None
    for frac in np.linspace(0.40, 0.64, 25):
        x = int(round(w * frac))
        peaks, heights = _horizontal_peaks(mask, x)
        selected, mismatch = _select_by_template(peaks, HORIZ_TEMPLATE, min_span=h * 0.84)
        if selected is None:
            continue
        strength = 0.0
        for p in selected:
            idx = int(np.argmin(np.abs(peaks - p)))
            strength += float(heights[idx]) if len(heights) else 0.0
        score = mismatch - strength / 300000.0
        if best is None or score < best[0]:
            best = (score, x, selected, mismatch)
    if best is None:
        raise ValueError("Fant ikke de 31 radlinjene i skjemaet")
    return best[1], best[2], best[3]


def _robust_fit(independent: np.ndarray, dependent: np.ndarray) -> tuple[np.ndarray, float, int]:
    independent = np.asarray(independent, dtype=float)
    dependent = np.asarray(dependent, dtype=float)
    if len(independent) < 6:
        raise ValueError("For få linjepunkter til geometrisk tilpasning")
    keep = np.ones(len(independent), dtype=bool)
    coef = np.polyfit(independent, dependent, 1)
    for _ in range(4):
        pred = np.polyval(coef, independent)
        resid = dependent - pred
        med = np.median(resid[keep])
        mad = np.median(np.abs(resid[keep] - med)) + 1e-6
        sigma = 1.4826 * mad
        threshold = max(2.0, 3.2 * sigma)
        keep = np.abs(resid - med) <= threshold
        if keep.sum() < 6:
            break
        coef = np.polyfit(independent[keep], dependent[keep], 1)
    pred = np.polyval(coef, independent[keep])
    rmse = float(np.sqrt(np.mean((dependent[keep] - pred) ** 2)))
    return coef, rmse, int(keep.sum())


def _track_vertical(mask: np.ndarray, seed_y: int, seeds: np.ndarray) -> list[dict[str, Any]]:
    h, w = mask.shape
    step = max(8, int(round(h * 0.015)))
    tol = max(6.0, w * 0.016)
    results = []
    for seed_x in seeds:
        pts: list[tuple[float, float]] = [(float(seed_y), float(seed_x))]
        for direction in (1, -1):
            last_i = float(seed_y)
            last_d = float(seed_x)
            slope = 0.0
            if direction > 0:
                iterator = range(seed_y + step, int(h * 0.985), step)
            else:
                iterator = range(seed_y - step, max(0, int(h * 0.02)) - 1, -step)
            for y in iterator:
                peaks, _ = _vertical_peaks(mask, y)
                if len(peaks) == 0:
                    continue
                pred = last_d + slope * (y - last_i)
                nearest = float(peaks[int(np.argmin(np.abs(peaks - pred)))])
                if abs(nearest - pred) <= tol:
                    di = float(y) - last_i
                    if abs(di) > 1e-6:
                        new_slope = (nearest - last_d) / di
                        slope = 0.65 * slope + 0.35 * new_slope
                    pts.append((float(y), nearest))
                    last_i, last_d = float(y), nearest
        pts = sorted({(round(y, 3), round(x, 3)) for y, x in pts})
        ys = np.array([p[0] for p in pts])
        xs = np.array([p[1] for p in pts])
        coef, rmse, n = _robust_fit(ys, xs)  # x = a*y+b
        results.append({"coef": coef, "rmse": rmse, "n": n, "points": pts})
    return results


def _track_horizontal(mask: np.ndarray, seed_x: int, seeds: np.ndarray) -> list[dict[str, Any]]:
    h, w = mask.shape
    step = max(8, int(round(w * 0.025)))
    tol = max(4.5, h * 0.0065)
    results = []
    for seed_y in seeds:
        pts: list[tuple[float, float]] = [(float(seed_x), float(seed_y))]
        for direction in (1, -1):
            last_i = float(seed_x)
            last_d = float(seed_y)
            slope = 0.0
            if direction > 0:
                iterator = range(seed_x + step, int(w * 0.985), step)
            else:
                iterator = range(seed_x - step, max(0, int(w * 0.02)) - 1, -step)
            for x in iterator:
                peaks, _ = _horizontal_peaks(mask, x)
                if len(peaks) == 0:
                    continue
                pred = last_d + slope * (x - last_i)
                nearest = float(peaks[int(np.argmin(np.abs(peaks - pred)))])
                if abs(nearest - pred) <= tol:
                    di = float(x) - last_i
                    if abs(di) > 1e-6:
                        new_slope = (nearest - last_d) / di
                        slope = 0.65 * slope + 0.35 * new_slope
                    pts.append((float(x), nearest))
                    last_i, last_d = float(x), nearest
        pts = sorted({(round(x, 3), round(y, 3)) for x, y in pts})
        xs = np.array([p[0] for p in pts])
        ys = np.array([p[1] for p in pts])
        coef, rmse, n = _robust_fit(xs, ys)  # y = a*x+b
        results.append({"coef": coef, "rmse": rmse, "n": n, "points": pts})
    return results

def _intersect(vcoef: np.ndarray, hcoef: np.ndarray) -> np.ndarray:
    # vertical: x = av*y+bv ; horizontal: y = ah*x+bh
    av, bv = float(vcoef[0]), float(vcoef[1])
    ah, bh = float(hcoef[0]), float(hcoef[1])
    denom = 1.0 - av * ah
    if abs(denom) < 1e-6:
        raise ValueError("Ustabil linjegeometri")
    x = (av * bh + bv) / denom
    y = ah * x + bh
    return np.array([x, y], dtype=float)


def _perspective_transform_point(pt: np.ndarray, M: np.ndarray) -> np.ndarray:
    arr = np.asarray([[[float(pt[0]), float(pt[1])]]], dtype=np.float32)
    return cv2.perspectiveTransform(arr, M)[0, 0].astype(float)


def _geometry_from_image(im: Image.Image) -> dict[str, Any]:
    orig = _pil_to_cv(im)
    oh, ow = orig.shape[:2]
    # Normalize for line analysis. Uniform scaling preserves projective geometry while
    # making morphology thresholds resolution-independent.
    target_h = 1000
    scale = target_h / oh
    work_w = max(300, int(round(ow * scale)))
    work = cv2.resize(orig, (work_w, target_h), interpolation=cv2.INTER_CUBIC if scale > 1 else cv2.INTER_AREA)
    gray = cv2.cvtColor(work, cv2.COLOR_BGR2GRAY)
    gray = cv2.createCLAHE(clipLimit=1.7, tileGridSize=(8, 8)).apply(gray)
    vert_mask, horiz_mask = _make_line_masks(gray)

    vy, vseeds, vmismatch = _find_vertical_seed(vert_mask)
    hx, hseeds, hmismatch = _find_horizontal_seed(horiz_mask)
    vlines = _track_vertical(vert_mask, vy, vseeds)
    hlines = _track_horizontal(horiz_mask, hx, hseeds)
    if len(vlines) != 9 or len(hlines) != 31:
        raise ValueError(f"Ufullstendig rutenett: {len(vlines)}/9 kolonnelinjer og {len(hlines)}/31 radlinjer")

    vc = [v["coef"] for v in vlines]
    hc = [h["coef"] for h in hlines]
    corners_work = np.array([
        _intersect(vc[0], hc[0]),
        _intersect(vc[-1], hc[0]),
        _intersect(vc[-1], hc[-1]),
        _intersect(vc[0], hc[-1]),
    ], dtype=float)

    # Validate quadrilateral and map back to original pixels.
    x_ok = (corners_work[:, 0] > -0.08 * work_w).all() and (corners_work[:, 0] < 1.08 * work_w).all()
    y_ok = (corners_work[:, 1] > -0.08 * target_h).all() and (corners_work[:, 1] < 1.08 * target_h).all()
    if not (x_ok and y_ok):
        raise ValueError("Skjemaets ytterhjørner kunne ikke bestemmes sikkert")
    corners_orig = corners_work / scale

    top_w = np.linalg.norm(corners_orig[1] - corners_orig[0])
    bot_w = np.linalg.norm(corners_orig[2] - corners_orig[3])
    left_h = np.linalg.norm(corners_orig[3] - corners_orig[0])
    right_h = np.linalg.norm(corners_orig[2] - corners_orig[1])
    ratio = ((top_w + bot_w) / 2) / max(1.0, (left_h + right_h) / 2)
    out_h = 2400
    out_w = int(round(out_h * ratio))
    out_w = max(1150, min(1750, out_w))

    src = corners_orig.astype(np.float32)
    dst = np.float32([[0, 0], [out_w - 1, 0], [out_w - 1, out_h - 1], [0, out_h - 1]])
    M_orig = cv2.getPerspectiveTransform(src, dst)
    rectified = cv2.warpPerspective(orig, M_orig, (out_w, out_h), borderValue=(245, 245, 245))

    # Map fitted grid to original scale, then through the rectification transform.
    vc_orig = [np.array([c[0], c[1] / scale], dtype=float) for c in vc]  # x_orig = a*y_orig + b/scale
    hc_orig = [np.array([c[0], c[1] / scale], dtype=float) for c in hc]  # y_orig = a*x_orig + b/scale
    # Slopes remain unchanged under uniform scale; intercepts scale.
    mid_h = hc_orig[len(hc_orig)//2]
    mid_v = vc_orig[len(vc_orig)//2]
    vxs = []
    for c in vc_orig:
        p = _perspective_transform_point(_intersect(c, mid_h), M_orig)
        vxs.append(float(p[0]))
    hys = []
    for c in hc_orig:
        p = _perspective_transform_point(_intersect(mid_v, c), M_orig)
        hys.append(float(p[1]))
    vxs = np.asarray(vxs)
    hys = np.asarray(hys)

    if not (np.all(np.diff(vxs) > out_w * 0.025) and np.all(np.diff(hys) > out_h * 0.008)):
        raise ValueError("Rutenettet ble ikke monotont etter perspektivkorrigering")

    # Original overlay: exact fitted line equations and recovered outer corners.
    overlay = orig.copy()
    for c in vc_orig:
        a, b = c
        x0 = int(round(a * 0 + b))
        x1 = int(round(a * (oh - 1) + b))
        cv2.line(overlay, (x0, 0), (x1, oh - 1), (0, 190, 0), max(1, ow // 500), cv2.LINE_AA)
    for c in hc_orig:
        a, b = c
        y0 = int(round(b))
        y1 = int(round(a * (ow - 1) + b))
        cv2.line(overlay, (0, y0), (ow - 1, y1), (0, 90, 255), max(1, ow // 500), cv2.LINE_AA)
    for p in corners_orig:
        cv2.circle(overlay, tuple(np.int32(np.round(p))), max(4, ow // 100), (255, 0, 255), -1, cv2.LINE_AA)

    rect_overlay = rectified.copy()
    for x in vxs:
        cv2.line(rect_overlay, (int(round(x)), 0), (int(round(x)), out_h - 1), (0, 180, 0), 2, cv2.LINE_AA)
    for y in hys:
        cv2.line(rect_overlay, (0, int(round(y))), (out_w - 1, int(round(y))), (0, 80, 255), 2, cv2.LINE_AA)

    vrmse = float(np.mean([v["rmse"] for v in vlines]))
    hrmse = float(np.mean([h["rmse"] for h in hlines]))
    min_vpts = min(v["n"] for v in vlines)
    min_hpts = min(h["n"] for h in hlines)
    # Work-image RMSE thresholds. Geometric scan is fail-closed below medium.
    if vrmse <= 1.8 and hrmse <= 1.8 and vmismatch < 0.025 and hmismatch < 0.018 and min_vpts >= 18 and min_hpts >= 14:
        confidence = "high"
    elif vrmse <= 3.0 and hrmse <= 3.0 and vmismatch < 0.04 and hmismatch < 0.03:
        confidence = "medium"
    else:
        confidence = "low"

    return {
        "orig": orig,
        "rectified": rectified,
        "overlay": overlay,
        "rect_overlay": rect_overlay,
        "vxs": vxs,
        "hys": hys,
        "corners_orig": corners_orig,
        "metrics": {
            "vertical_lines": 9,
            "horizontal_lines": 31,
            "vertical_rmse": round(vrmse, 3),
            "horizontal_rmse": round(hrmse, 3),
            "vertical_template_mismatch": round(float(vmismatch), 4),
            "horizontal_template_mismatch": round(float(hmismatch), 4),
            "min_vertical_support": int(min_vpts),
            "min_horizontal_support": int(min_hpts),
            "confidence": confidence,
        },
    }


def _crop_rect(rect: np.ndarray, x0: float, y0: float, x1: float, y1: float, pad: int = 0) -> np.ndarray:
    h, w = rect.shape[:2]
    xa = max(0, int(round(x0)) + pad)
    xb = min(w, int(round(x1)) - pad)
    ya = max(0, int(round(y0)) + pad)
    yb = min(h, int(round(y1)) - pad)
    if xb <= xa or yb <= ya:
        raise ValueError("Ugyldig celleutsnitt")
    return rect[ya:yb, xa:xb]


def _make_row_contact(g: dict[str, Any]) -> Image.Image:
    rect, vxs, hys = g["rectified"], g["vxs"], g["hys"]
    strips = []
    for i in range(16):
        # data bands h3->h19
        crop = _crop_rect(rect, vxs[0], hys[3+i], vxs[-1], hys[4+i], pad=2)
        target_w = 1900
        s = target_w / crop.shape[1]
        rh = max(92, int(round(crop.shape[0] * s)))
        resized = cv2.resize(crop, (target_w, rh), interpolation=cv2.INTER_CUBIC)
        strips.append((i+1, resized))
    label_w = 110
    gap = 6
    H = sum(s.shape[0] for _, s in strips) + gap * (len(strips)-1)
    sheet = Image.new("RGB", (label_w+1900, H), "white")
    draw = ImageDraw.Draw(sheet)
    y = 0
    for idx, strip in strips:
        pim = _cv_to_pil(strip)
        draw.text((18, y + max(8, pim.height//3)), f"R{idx:02d}", fill="black")
        sheet.paste(pim, (label_w, y))
        y += pim.height + gap
    return sheet


def _make_track_contact(g: dict[str, Any]) -> Image.Image:
    rect, vxs, hys = g["rectified"], g["vxs"], g["hys"]
    strips = []
    for i in range(16):
        # Exact Til spor + Vd/vann columns: v4 -> v6
        crop = _crop_rect(rect, vxs[4], hys[3+i], vxs[6], hys[4+i], pad=2)
        target_w = 900
        s = target_w / crop.shape[1]
        rh = max(120, int(round(crop.shape[0] * s)))
        resized = cv2.resize(crop, (target_w, rh), interpolation=cv2.INTER_CUBIC)
        strips.append((i+1, resized))
    label_w = 110
    gap = 7
    H = sum(s.shape[0] for _, s in strips) + gap * (len(strips)-1)
    sheet = Image.new("RGB", (label_w+900, H), "white")
    draw = ImageDraw.Draw(sheet)
    y = 0
    for idx, strip in strips:
        pim = _cv_to_pil(strip)
        draw.text((18, y + max(8, pim.height//3)), f"R{idx:02d}", fill="black")
        sheet.paste(pim, (label_w, y))
        y += pim.height + gap
    return sheet


def _make_notes_crop(g: dict[str, Any]) -> Image.Image:
    rect, vxs, hys = g["rectified"], g["vxs"], g["hys"]
    crop = _crop_rect(rect, vxs[0], hys[20], vxs[-1], hys[23], pad=2)
    target_w = 1900
    s = target_w / crop.shape[1]
    resized = cv2.resize(crop, (target_w, max(300, int(round(crop.shape[0]*s)))), interpolation=cv2.INTER_CUBIC)
    return _cv_to_pil(resized)


# ------------------------------ AI transcription -------------------------------

def _schema() -> dict[str, Any]:
    conf_props = {f: {"type": "string", "enum": ["high", "medium", "low"]} for f in FIELDS}
    row_props = {
        "row_no": {"type": "integer"},
        **{f: {"type": "string"} for f in FIELDS},
        "confidence": {
            "type": "object",
            "additionalProperties": False,
            "properties": conf_props,
            "required": FIELDS,
        },
        "review_reason": {"type": "string"},
    }
    row_schema = {
        "type": "object",
        "additionalProperties": False,
        "properties": row_props,
        "required": ["row_no", *FIELDS, "confidence", "review_reason"],
    }
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "form_title": {"type": "string"},
            "date_raw": {"type": "string"},
            "train_rows": {"type": "array", "minItems": 16, "maxItems": 16, "items": row_schema},
            "note_rows": {"type": "array", "minItems": 3, "maxItems": 3, "items": row_schema},
            "warnings": {"type": "array", "items": {"type": "string"}},
        },
        "required": ["form_title", "date_raw", "train_rows", "note_rows", "warnings"],
    }


def _extract_output_text(payload: dict[str, Any]) -> str:
    if isinstance(payload.get("output_text"), str):
        return payload["output_text"]
    for item in payload.get("output", []) or []:
        if item.get("type") == "message":
            for content in item.get("content", []) or []:
                if content.get("type") in ("output_text", "text") and isinstance(content.get("text"), str):
                    return content["text"]
    raise RuntimeError("AI-svaret manglet output_text")


API_KEY_PATTERN = re.compile(r"\A[A-Za-z0-9._\-]+\Z")


def _require_valid_api_key(api_key: str) -> str:
    # requests puts the whole rejected header value in its exception message, and
    # that message is surfaced to the user. A key pasted with a newline or a stray
    # space would therefore print itself on screen, so reject the format here and
    # never let the value reach the exception.
    key = (api_key or "").strip()
    if not key:
        raise ValueError("Mangler OpenAI API-nøkkel")
    if not API_KEY_PATTERN.match(key):
        raise ValueError(
            "OPENAI_API_KEY har ugyldig format. Nøkkelen skal være én sammenhengende "
            "linje uten mellomrom eller linjeskift. Verdien vises ikke."
        )
    return key


def _authorization_header(api_key: str) -> str:
    return f"Bearer {_require_valid_api_key(api_key)}"


def _call_openai(api_key: str, model: str, prompt: str, images: list[tuple[Image.Image, str]]) -> dict[str, Any]:
    content: list[dict[str, Any]] = [{"type": "input_text", "text": prompt}]
    for im, detail in images:
        content.append({"type": "input_image", "image_url": _to_jpeg_data_url(im, 92), "detail": detail})
    body = {
        "model": model,
        "store": False,
        "reasoning": {"effort": "high"},
        "input": [{"role": "user", "content": content}],
        "text": {
            "format": {
                "type": "json_schema",
                "name": "togplassering_skien_v03",
                "strict": True,
                "schema": _schema(),
            }
        },
        "max_output_tokens": 14000,
    }
    r = requests.post(OPENAI_URL, headers={"Authorization": _authorization_header(api_key), "Content-Type": "application/json"}, json=body, timeout=240)
    if r.status_code >= 400:
        raise RuntimeError(f"AI-tjenesten svarte HTTP {r.status_code}: {r.text[:1800]}")
    payload = r.json()
    return json.loads(_extract_output_text(payload))


def _first_prompt() -> str:
    tracks = ", ".join(ALLOWED_TRACKS)
    return f"""
Du transkriberer ett bestemt norsk jernbaneskjema: «TOGPLASSERING SKIEN».
Dette er dokumenttranskripsjon. IKKE fyll inn noe ut fra hva du tror burde stå der.

BILDEGRUNNLAGET ER GEOMETRISK KVALIFISERT FØR DU SER DET:
- Bilde 1 er hele skjemaet perspektivkorrigert.
- Bilde 2 er 16 EKSAKTE datarader, merket R01–R16. Hver stripe er avgrenset av de fysisk detekterte tabellinjene; radene overlapper ikke.
- Bilde 3 er de samme 16 radene, men kun de eksakte kolonnene «Til spor» + «Vd/vann», kraftig forstørret.
- Bilde 4 er de tre eksakte notatradene nederst.

Kolonnene i hver datarad er, fra venstre:
Klokken | Fra tog | Til tog | Setter | Til spor | Vd/vann | INFO | Merknad.

Krav:
1. train_rows skal ha nøyaktig 16 elementer i rekkefølge R01..R16, row_no=1..16.
2. note_rows skal ha nøyaktig 3 elementer i rekkefølge ovenfra og ned, row_no=1..3.
3. Bevar skråstreker, bindestreker, m/n/s-bokstaver og x nøyaktig. Normaliser IKKE håndskrift til en forventet verdi.
4. Tom celle = tom streng. Uleselig celle = tom streng + confidence low + forklaring i review_reason.
5. Les håndskriften i «Til spor» fra det forstørrede Bilde 3, men bruk hele raden som kontekst.
6. Vd/vann er egen kolonne. Ikke flytt en håndskrevet verdi mellom Til spor og Vd/vann.
7. Mulige Skien-spor inkluderer {tracks}, men listen er bare valideringskontekst. Hvis pennen faktisk viser noe annet, transkriber råteksten og sett lav confidence fremfor å tvinge den til listen.
8. Skill nøye mellom 1/I/l, 5/S, 6/G, 0/O, N/M og S/5.
9. Maskinskrevet tekst skal også vurderes visuelt; ikke anta at trykt tekst alltid er lettlest.
""".strip()


def _verify_prompt() -> str:
    return """
Gjør en HELT UAVHENGIG andrelesing av «TOGPLASSERING SKIEN». Du får ikke se første leseres svar.
Geometrien er allerede kontrollert: Bilde 2 inneholder 16 eksakte radstriper R01–R16 uten overlapp; Bilde 3 viser eksakt «Til spor» + «Vd/vann» for de samme radene.
Returner samme strukturerte skjema. Ikke resonnér ut fra toglogikk og ikke korriger noe til det du forventer. Les bare det som faktisk kan sees. Ved reell tvil: tom streng eller beste råtranskripsjon med confidence low og kort review_reason.
""".strip()


def _normalize_track(raw: str) -> tuple[str, bool]:
    if not raw or not raw.strip():
        return "", True
    s = raw.strip().upper().replace(" ", "")
    # common separators are preserved; validate each token if it is clearly a list/compound.
    if s in ALLOWED_TRACKS:
        return s, True
    parts = re.split(r"[/,+]", s)
    if len(parts) > 1 and all(p in ALLOWED_TRACKS for p in parts if p):
        return s, True
    return s, False


def _merge_reads(a: dict[str, Any], b: dict[str, Any] | None) -> dict[str, Any]:
    out = {
        "form_title": a.get("form_title", ""),
        "date_raw": a.get("date_raw", ""),
        "rows": [],
        "warnings": list(a.get("warnings", []) or []),
        "ai_double_checked": b is not None,
    }
    conflicts = []
    def merge_group(name: str, row_type: str):
        ar = a.get(name, []) or []
        br = (b or {}).get(name, []) or [] if b is not None else []
        n = 16 if name == "train_rows" else 3
        for i in range(n):
            ra = ar[i] if i < len(ar) else {}
            rb = br[i] if i < len(br) else None
            row = {"row_no": i+1, "row_type": row_type, "confidence": {}, "review_reason": ra.get("review_reason", "")}
            for f in FIELDS:
                va = str(ra.get(f, "") or "").strip()
                ca = (ra.get("confidence", {}) or {}).get(f, "low")
                if rb is None:
                    row[f] = va
                    row["confidence"][f] = ca
                    continue
                vb = str(rb.get(f, "") or "").strip()
                cb = (rb.get("confidence", {}) or {}).get(f, "low")
                if va == vb:
                    row[f] = va
                    row["confidence"][f] = "high" if ca == "high" and cb == "high" else ("low" if "low" in (ca, cb) else "medium")
                elif not va and vb:
                    row[f] = vb
                    row["confidence"][f] = "low"
                    conflicts.append({"row_type": row_type, "row": i+1, "field": f, "first": va, "second": vb})
                elif va and not vb:
                    row[f] = va
                    row["confidence"][f] = "low"
                    conflicts.append({"row_type": row_type, "row": i+1, "field": f, "first": va, "second": vb})
                else:
                    # Never silently adjudicate disagreement. Keep pass 1 visible and flag it.
                    row[f] = va
                    row["confidence"][f] = "low"
                    conflicts.append({"row_type": row_type, "row": i+1, "field": f, "first": va, "second": vb})
            norm, valid = _normalize_track(row["til_spor"])
            row["til_spor_normalized"] = norm
            row["til_spor_valid"] = valid
            if row_type == "train" and row["til_spor"] and not valid:
                row["confidence"]["til_spor"] = "low"
                row["review_reason"] = (row["review_reason"] + " | " if row["review_reason"] else "") + "Til spor matcher ikke direkte gyldig sporformat; kontroller rå håndskrift."
            out["rows"].append(row)
    merge_group("train_rows", "train")
    merge_group("note_rows", "note")
    out["conflicts"] = conflicts
    out["needs_review"] = bool(conflicts) or any(
        c == "low" for row in out["rows"] for c in row.get("confidence", {}).values()
    )
    if b is not None:
        if a.get("date_raw", "") != b.get("date_raw", ""):
            out["warnings"].append(f"AI-uenighet om dato: første='{a.get('date_raw','')}', andre='{b.get('date_raw','')}'")
    return out


# ---------------------------------- routes -------------------------------------

@app.get("/", response_class=HTMLResponse)
def home() -> HTMLResponse:
    return HTMLResponse((APP_DIR / "index.html").read_text(encoding="utf-8"))


@app.get("/sample.jpg")
def sample() -> FileResponse:
    return FileResponse(STATIC_DIR / "eksempel_2108.jpg", media_type="image/jpeg")


@app.post("/api/geometry")
async def geometry(file: UploadFile = File(...)):
    try:
        raw = await file.read()
        im = _decode_image(raw)
        g = _geometry_from_image(im)
        row_sheet = _make_row_contact(g)
        track_sheet = _make_track_contact(g)
        return {
            "metrics": g["metrics"],
            "corners": [[round(float(x), 2), round(float(y), 2)] for x, y in g["corners_orig"]],
            "preview": {
                "overlay": _to_jpeg_data_url(_cv_to_pil(g["overlay"]), 91),
                "rectified": _to_jpeg_data_url(_cv_to_pil(g["rectified"]), 92),
                "rectified_overlay": _to_jpeg_data_url(_cv_to_pil(g["rect_overlay"]), 91),
                "row_contact": _to_jpeg_data_url(row_sheet, 90),
                "track_contact": _to_jpeg_data_url(track_sheet, 90),
            },
        }
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"Geometrikontroll feilet: {exc}") from exc


@app.post("/api/scan")
async def scan(
    file: UploadFile = File(...),
    api_key: str = Form(""),
    model: str = Form(DEFAULT_MODEL),
    double_check: str = Form("true"),
):
    try:
        raw = await file.read()
        im = _decode_image(raw)
        g = _geometry_from_image(im)
        if g["metrics"]["confidence"] == "low":
            raise ValueError("Geometrien er LOW. AI-lesing er sperret; kontroller/ta nytt bilde først.")
        key = _require_valid_api_key(api_key or os.environ.get("OPENAI_API_KEY", ""))
        rect = _cv_to_pil(g["rectified"])
        rows = _make_row_contact(g)
        tracks = _make_track_contact(g)
        notes = _make_notes_crop(g)
        images = [(rect, "original"), (rows, "high"), (tracks, "high"), (notes, "high")]
        first = _call_openai(key, model, _first_prompt(), images)
        second = None
        if double_check.lower() in ("1", "true", "yes", "on"):
            second = _call_openai(key, model, _verify_prompt(), images)
        result = _merge_reads(first, second)
        result["geometry"] = g["metrics"]
        result["preview"] = {
            "overlay": _to_jpeg_data_url(_cv_to_pil(g["overlay"]), 88),
            "rectified": _to_jpeg_data_url(rect, 90),
            "rectified_overlay": _to_jpeg_data_url(_cv_to_pil(g["rect_overlay"]), 88),
            "row_contact": _to_jpeg_data_url(rows, 88),
            "track_contact": _to_jpeg_data_url(tracks, 88),
        }
        return result
    except Exception as exc:
        traceback.print_exc()
        raise HTTPException(status_code=422, detail=f"Skanning feilet: {exc}") from exc


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8788)
