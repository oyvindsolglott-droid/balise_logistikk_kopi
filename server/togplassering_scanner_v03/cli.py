#!/usr/bin/env python3
"""Host-process bridge for Togplassering Skien Scanner v0.3.

Does not change geometry, transcription, merge or fail-closed behavior.
Reads a local image path and prints JSON. The "read" command transcribes on this
machine with no network access; "scan" uses the remote model and takes its key
only from the environment, never from CLI argv.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from app import (
    DEFAULT_MODEL,
    _call_openai,
    _cv_to_pil,
    _decode_image,
    _first_prompt,
    _geometry_from_image,
    _make_notes_crop,
    _make_row_contact,
    _make_track_contact,
    _merge_reads,
    _require_valid_api_key,
    _to_jpeg_data_url,
    _verify_prompt,
)
from local_reader import read_form


def _geometry_response(im):
    g = _geometry_from_image(im)
    row_sheet = _make_row_contact(g)
    track_sheet = _make_track_contact(g)
    return {
        "ok": True,
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


def _scan_response(im, *, double_check: bool, model: str):
    g = _geometry_from_image(im)
    if g["metrics"]["confidence"] == "low":
        raise ValueError("Geometrien er LOW. AI-lesing er sperret; kontroller/ta nytt bilde først.")
    key = _require_valid_api_key(os.environ.get("OPENAI_API_KEY", ""))
    rect = _cv_to_pil(g["rectified"])
    rows = _make_row_contact(g)
    tracks = _make_track_contact(g)
    notes = _make_notes_crop(g)
    images = [(rect, "original"), (rows, "high"), (tracks, "high"), (notes, "high")]
    first = _call_openai(key, model, _first_prompt(), images)
    second = _call_openai(key, model, _verify_prompt(), images) if double_check else None
    result = _merge_reads(first, second)
    result["ok"] = True
    result["geometry"] = g["metrics"]
    result["preview"] = {
        "overlay": _to_jpeg_data_url(_cv_to_pil(g["overlay"]), 88),
        "rectified": _to_jpeg_data_url(rect, 90),
        "rectified_overlay": _to_jpeg_data_url(_cv_to_pil(g["rect_overlay"]), 88),
        "row_contact": _to_jpeg_data_url(rows, 88),
        "track_contact": _to_jpeg_data_url(tracks, 88),
    }
    return result


def _read_response(im):
    """Transcribe locally. No API key, no network, no per-read cost."""
    g = _geometry_from_image(im)
    if g["metrics"]["confidence"] == "low":
        raise ValueError("Geometrien er LOW. Lesing er sperret; kontroller/ta nytt bilde først.")
    result = _merge_reads(read_form(g), None)
    result["ok"] = True
    result["engine"] = "local-pp-ocrv5"
    result["geometry"] = g["metrics"]
    rows = _make_row_contact(g)
    tracks = _make_track_contact(g)
    result["preview"] = {
        "overlay": _to_jpeg_data_url(_cv_to_pil(g["overlay"]), 88),
        "rectified": _to_jpeg_data_url(_cv_to_pil(g["rectified"]), 90),
        "rectified_overlay": _to_jpeg_data_url(_cv_to_pil(g["rect_overlay"]), 88),
        "row_contact": _to_jpeg_data_url(rows, 88),
        "track_contact": _to_jpeg_data_url(tracks, 88),
    }
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="v0.3 scanner host bridge")
    parser.add_argument("command", choices=("geometry", "read", "scan"))
    parser.add_argument("image", type=Path)
    parser.add_argument("--double-check", action="store_true", default=True)
    parser.add_argument("--no-double-check", action="store_false", dest="double_check")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    args = parser.parse_args(argv)
    raw = args.image.read_bytes()
    try:
        im = _decode_image(raw)
        if args.command == "geometry":
            payload = _geometry_response(im)
        elif args.command == "read":
            payload = _read_response(im)
        else:
            payload = _scan_response(im, double_check=args.double_check, model=args.model)
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False), file=sys.stdout)
        return 2
    print(json.dumps(payload, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
