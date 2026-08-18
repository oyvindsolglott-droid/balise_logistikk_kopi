#!/usr/bin/env python3
"""Generate privacy-safe TOGPLASSERING SKIEN HTR fixtures.

The values are synthetic and deliberately unrelated to operational data.  The
committed PNG files are TEST_FIXTURE_ONLY; this script is not used at runtime.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont


ROOT = Path(__file__).resolve().parent
WIDTH = 1200
HEIGHT = 1500
COLUMNS = [26, 168, 329, 484, 636, 770, 1174]
DATA_TOP = 285
DATA_BOTTOM = 1465
ROW_HEIGHT = (DATA_BOTTOM - DATA_TOP) / 29
PRINT_FONT = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
HAND_FONTS = [
    "/System/Library/Fonts/Noteworthy.ttc",
    "/System/Library/Fonts/Supplemental/Bradley Hand Bold.ttf",
    "/System/Library/Fonts/MarkerFelt.ttc",
]


SETS = {
    "synthetic-htr-neat": {
        "rows": [
            ["991", "1204", "73-26", "4N", "*", "Kontroll sør"],
            ["993", "REP", "75-41", "6S", "✓", "vann"],
            ["997", "1210", "76-32", "VN", "", "Etter vask"],
        ],
        "metadata": {"date": "18.08.2026", "signature": "Test A", "ds": "DS A"},
        "font": 1,
        "ink": 28,
        "variant": "neat_dark_pen",
    },
    "synthetic-htr-varied": {
        "rows": [
            ["701", "1402", "72-63", "5M", "X", "Ny test"],
            ["703", "1404", "77-25", "10S", "*", "lav kontrast"],
            ["709", "REP", "78-46", "7N", "", "klar"],
        ],
        "metadata": {"date": "19.08.2026", "signature": "Test B", "ds": "DS B"},
        "font": 2,
        "ink": 72,
        "variant": "varied_faint_pencil",
    },
}


def font(path: str, size: int, index: int = 0) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(path, size=size, index=index)


def draw_form(spec: dict[str, object]) -> Image.Image:
    image = Image.new("RGB", (WIDTH, HEIGHT), "white")
    draw = ImageDraw.Draw(image)
    line = (36, 36, 36)
    draw.rectangle((1, 1, 1198, 1498), outline=line, width=3)
    draw.line((1, 80, 1198, 80), fill=line, width=3)
    draw.line((1, 150, 1198, 150), fill=line, width=2)
    draw.line((1, DATA_TOP, 1198, DATA_TOP), fill=line, width=3)
    for x in COLUMNS:
        draw.line((x, 150, x, DATA_BOTTOM), fill=line, width=2)
    for row in range(30):
        y = round(DATA_TOP + row * ROW_HEIGHT)
        draw.line((COLUMNS[0], y, COLUMNS[-1], y), fill=(85, 85, 85), width=1)

    printed_title = font(PRINT_FONT, 47)
    printed_label = font(PRINT_FONT, 27)
    draw.text((600, 46), "TOGPLASSERING SKIEN", font=printed_title, fill=(20, 20, 20), anchor="mm")
    draw.text((40, 103), "Dato", font=printed_label, fill=(25, 25, 25))
    draw.text((415, 103), "Signatur", font=printed_label, fill=(25, 25, 25))
    draw.text((805, 103), "ds", font=printed_label, fill=(25, 25, 25))
    headers = ["Fra Tog", "Til Tog", "Settnr", "Til spor", "Wc/vann", "Merknad"]
    for index, title in enumerate(headers):
        draw.text((COLUMNS[index] + 10, 205), title, font=printed_label, fill=(25, 25, 25))

    hand_path = HAND_FONTS[int(spec["font"])]
    hand = font(hand_path, 35)
    hand_note = font(hand_path, 31)
    ink = (int(spec["ink"]),) * 3
    metadata = spec["metadata"]
    draw.text((175, 93), str(metadata["date"]), font=hand, fill=ink)
    draw.text((550, 93), str(metadata["signature"]), font=hand, fill=ink)
    draw.text((940, 93), str(metadata["ds"]), font=hand, fill=ink)
    for row_index, values in enumerate(spec["rows"]):
        y = round(DATA_TOP + row_index * ROW_HEIGHT + 8)
        for column_index, value in enumerate(values):
            if not value:
                continue
            x = COLUMNS[column_index] + (16 if column_index == 5 else 25)
            selected_font = hand_note if column_index == 5 else hand
            if column_index == 4 and value == "✓":
                draw.line((x + 2, y + 21, x + 12, y + 31), fill=ink, width=4)
                draw.line((x + 12, y + 31, x + 31, y + 5), fill=ink, width=4)
            else:
                draw.text((x, y), str(value), font=selected_font, fill=ink)
    return image


def shadow_variant(image: Image.Image) -> Image.Image:
    overlay = Image.new("L", image.size, 255)
    draw = ImageDraw.Draw(overlay)
    for x in range(WIDTH):
        shade = int(255 - 48 * max(0, 1 - abs(x - 760) / 360))
        draw.line((x, 0, x, HEIGHT), fill=shade)
    overlay = overlay.filter(ImageFilter.GaussianBlur(35))
    shaded = Image.new("RGB", image.size, (0, 0, 0))
    return Image.composite(image, shaded, overlay)


def solve_linear(matrix: list[list[float]], vector: list[float]) -> list[float]:
    augmented = [row[:] + [vector[index]] for index, row in enumerate(matrix)]
    for column in range(len(vector)):
        pivot = max(range(column, len(vector)), key=lambda row: abs(augmented[row][column]))
        augmented[column], augmented[pivot] = augmented[pivot], augmented[column]
        divisor = augmented[column][column]
        if abs(divisor) < 1e-12:
            raise ValueError("singular perspective transform")
        augmented[column] = [value / divisor for value in augmented[column]]
        for row in range(len(vector)):
            if row == column:
                continue
            factor = augmented[row][column]
            augmented[row] = [
                value - factor * augmented[column][index]
                for index, value in enumerate(augmented[row])
            ]
    return [row[-1] for row in augmented]


def perspective_coefficients(
    output_points: list[tuple[float, float]],
    source_points: list[tuple[float, float]],
) -> tuple[float, ...]:
    matrix: list[list[float]] = []
    vector: list[float] = []
    for (x, y), (u, v) in zip(output_points, source_points):
        matrix.append([x, y, 1, 0, 0, 0, -u * x, -u * y])
        vector.append(u)
        matrix.append([0, 0, 0, x, y, 1, -v * x, -v * y])
        vector.append(v)
    return tuple(solve_linear(matrix, vector))


def perspective_variant(image: Image.Image) -> Image.Image:
    output_corners = [(80, 30), (1120, 30), (1180, 1470), (20, 1470)]
    source_corners = [(0, 0), (WIDTH - 1, 0), (WIDTH - 1, HEIGHT - 1), (0, HEIGHT - 1)]
    return image.transform(
        (WIDTH, HEIGHT),
        Image.Transform.PERSPECTIVE,
        perspective_coefficients(output_corners, source_corners),
        resample=Image.Resampling.BICUBIC,
        fillcolor=(238, 238, 234),
    )


def save_fixture(name: str, spec: dict[str, object]) -> None:
    image = draw_form(spec)
    variants = [{"file": f"{name}.png", "image": image, "condition": spec["variant"]}]
    if name.endswith("neat"):
        skewed = image.rotate(2.2, resample=Image.Resampling.BICUBIC, expand=True, fillcolor=(244, 244, 240))
        variants.append({"file": f"{name}-skew.png", "image": skewed, "condition": "skewed_photo"})
        rotated = image.rotate(90, resample=Image.Resampling.BICUBIC, expand=True, fillcolor=(244, 244, 240))
        variants.append({"file": f"{name}-sideways.png", "image": rotated, "condition": "sideways_orientation"})
    else:
        low = ImageEnhance.Contrast(shadow_variant(image)).enhance(0.78)
        variants.append({"file": f"{name}-shadow.png", "image": low, "condition": "shadow_low_contrast"})
        variants.append({"file": f"{name}-perspective.png", "image": perspective_variant(image), "condition": "perspective_from_side"})

    files = []
    for variant in variants:
        output = ROOT / variant["file"]
        variant["image"].save(output, format="PNG", optimize=True)
        payload = output.read_bytes()
        files.append({
            "file": output.name,
            "condition": variant["condition"],
            "sha256": hashlib.sha256(payload).hexdigest(),
            "width": variant["image"].width,
            "height": variant["image"].height,
        })
    ground_truth = {
        "schemaVersion": "sde-synthetic-htr-fixture-v1",
        "fixtureClass": "TEST_FIXTURE_ONLY",
        "containsOperationalData": False,
        "images": files,
        "metadata": spec["metadata"],
        "rows": [
            {
                "rowIndex": index,
                "fromTrain": values[0],
                "toTrain": values[1],
                "vehicleId": values[2],
                "toTrack": values[3],
                "wcWater": {"✓": "CHECK", "X": "CROSS"}.get(values[4], values[4]),
                "notes": values[5],
            }
            for index, values in enumerate(spec["rows"])
        ],
    }
    (ROOT / f"{name}.json").write_text(json.dumps(ground_truth, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    for fixture_name, fixture_spec in SETS.items():
        save_fixture(fixture_name, fixture_spec)
