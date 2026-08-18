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
B_COLUMNS = [20, 100, 185, 292, 393, 497, 617, 896, 1178]
B_DATA_TOP = 270
B_DATA_BOTTOM = 1450
B_ROW_HEIGHT = (B_DATA_BOTTOM - B_DATA_TOP) / 29
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


B_SETS = {
    "synthetic-template-b-hybrid-a": {
        "rows": [
            ["06:11", "9901/1", "9902/1", "91-01", "3N", "X", "TEST INFO A", "syntetisk rad A"],
            ["07:22", "9903/2", "9904/2", "91-02", "5M", "", "", "syntetisk rad B"],
            ["08:33", "9905", "REP", "91-03", "VN", "X", "TEST INFO C", ""],
        ],
        "metadata": {"clock": "", "date": "31.12.2099", "signature": "QA"},
        "variant": "red_print_black_handwriting",
        "correction": True,
    },
    "synthetic-template-b-hybrid-b": {
        "rows": [
            ["09:14", "9801/1", "9802/1", "92-11", "4S", "", "TEST INFO D", "syntetisk sett B"],
            ["10:25", "9803/2", "9804/2", "92-12", "7N", "X", "", ""],
            ["11:36", "9805", "9806", "92-13", "12S", "", "TEST INFO F", "slutt"],
        ],
        "metadata": {"clock": "", "date": "30.12.2099", "signature": "QB"},
        "variant": "independent_content_set",
        "correction": False,
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


def draw_template_b(spec: dict[str, object]) -> Image.Image:
    image = Image.new("RGB", (WIDTH, HEIGHT), (244, 244, 239))
    draw = ImageDraw.Draw(image)
    line = (35, 35, 35)
    red = (177, 48, 44)
    black = (20, 20, 20)
    form_top = 120
    form_left = B_COLUMNS[0]
    form_right = B_COLUMNS[-1]
    draw.rectangle((form_left, form_top, form_right, B_DATA_BOTTOM), outline=line, width=3)
    draw.line((form_left, 135, form_right, 135), fill=line, width=2)
    draw.line((form_left, 190, form_right, 190), fill=line, width=2)
    draw.line((form_left, B_DATA_TOP, form_right, B_DATA_TOP), fill=line, width=3)
    for x in B_COLUMNS:
        draw.line((x, 135, x, B_DATA_BOTTOM), fill=line, width=2)
    for row in range(30):
        y = round(B_DATA_TOP + row * B_ROW_HEIGHT)
        draw.line((form_left, y, form_right, y), fill=(78, 78, 78), width=1)

    title_font = font(PRINT_FONT, 25)
    label_font = font(PRINT_FONT, 18)
    value_font = font(PRINT_FONT, 21)
    hand_font = font(HAND_FONTS[1], 25)
    note_font = font(HAND_FONTS[1], 21)
    draw.text(((form_left + form_right) / 2, 127), "TOGPLASSERING SKIEN", font=title_font, fill=black, anchor="mm")
    draw.text((form_left + 5, 142), "Klokken", font=label_font, fill=black)
    draw.text((B_COLUMNS[1] + 5, 142), "Dato", font=label_font, fill=black)
    draw.text((B_COLUMNS[2] + 70, 140), str(spec["metadata"]["date"]), font=value_font, fill=red)
    draw.text((B_COLUMNS[-2] + 120, 140), str(spec["metadata"]["signature"]), font=value_font, fill=black)
    headers = ["Inn kl", "Fra Tog", "Til Tog", "Settnr", "Til spor", "Wc/vann", "INFO", "Merknad"]
    for index, header in enumerate(headers):
        draw.text((B_COLUMNS[index] + 5, 218), header, font=label_font, fill=black)

    for row_index, values in enumerate(spec["rows"]):
        y = round(B_DATA_TOP + row_index * B_ROW_HEIGHT + 8)
        for column_index, value in enumerate(values):
            if not value:
                continue
            x = B_COLUMNS[column_index] + (8 if column_index >= 6 else 6)
            selected_font = note_font if column_index >= 6 else value_font
            draw.text((x, y), str(value), font=selected_font, fill=red)
    if spec.get("correction"):
        row_y = round(B_DATA_TOP + B_ROW_HEIGHT + 19)
        start_x = B_COLUMNS[2] + 4
        end_x = B_COLUMNS[3] - 5
        draw.line((start_x, row_y, end_x, row_y - 5), fill=black, width=3)
        draw.text((start_x + 8, row_y - 14), "9907/2", font=hand_font, fill=black)
        track_x = B_COLUMNS[4] + 8
        draw.line((track_x, row_y, B_COLUMNS[5] - 6, row_y - 4), fill=black, width=3)
        draw.text((track_x + 8, row_y - 13), "8N", font=hand_font, fill=black)
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


def save_template_b_fixture(name: str, spec: dict[str, object]) -> None:
    image = draw_template_b({**spec, "correction": False})
    empty_spec = {**spec, "rows": [], "correction": False, "variant": "empty_rows"}
    variants = [
        {"file": f"{name}.png", "image": image, "condition": spec["variant"]},
    ]
    if name.endswith("-a"):
        variants.extend([
            {"file": f"{name}-correction.png", "image": draw_template_b({**spec, "correction": True}), "condition": "strike_through_and_black_correction"},
            {"file": f"{name}-perspective.png", "image": perspective_variant(image), "condition": "perspective_from_side"},
            {"file": f"{name}-shadow.png", "image": ImageEnhance.Contrast(shadow_variant(image)).enhance(0.82), "condition": "shadow_low_contrast"},
            {"file": f"{name}-empty.png", "image": draw_template_b(empty_spec), "condition": "empty_rows"},
        ])
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
        "schemaVersion": "sde-synthetic-hybrid-form-fixture-v1",
        "fixtureClass": "TEST_FIXTURE_ONLY",
        "containsOperationalData": False,
        "productionImportAllowed": False,
        "templateId": "TEMPLATE_B",
        "templateVersion": "togplassering-skien-template-b-29x8-v1",
        "recognitionMode": "HYBRID_PRINT_OCR_HTR",
        "images": files,
        "metadata": spec["metadata"],
        "rows": [
            {
                "rowIndex": index,
                "arrivalTime": values[0],
                "fromTrain": values[1],
                "toTrain": values[2],
                "vehicleId": values[3],
                "toTrack": values[4],
                "wcWater": {"X": "CROSS"}.get(values[5], values[5]),
                "info": values[6],
                "notes": values[7],
            }
            for index, values in enumerate(spec["rows"])
        ],
        "layerGroundTruth": {
            "red": "PRINT_OCR",
            "black": "HANDWRITING_HTR",
            "grid": "EXCLUDED",
            "strikeThroughAutoAccepted": False,
        },
    }
    (ROOT / f"{name}.json").write_text(
        json.dumps(ground_truth, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def save_legacy_compatibility_fixture() -> None:
    """Keep the permanent legacy fixture paths without retaining operational data."""
    spec = SETS["synthetic-htr-neat"]
    output = ROOT / "historical-togplassering-skien.png"
    image = draw_form(spec)
    image.save(output, format="PNG", optimize=True)
    payload = output.read_bytes()
    compatibility = {
        "schemaVersion": "sde-synthetic-htr-compatibility-fixture-v1",
        "fixtureClass": "TEST_FIXTURE_ONLY",
        "containsOperationalData": False,
        "productionImportAllowed": False,
        "legacyPathRetainedForPermanentTestPolicy": True,
        "canonicalSyntheticFixture": "synthetic-htr-neat.json",
        "image": {
            "file": output.name,
            "sha256": hashlib.sha256(payload).hexdigest(),
            "width": image.width,
            "height": image.height,
        },
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
    (ROOT / "historical-togplassering-skien.json").write_text(
        json.dumps(compatibility, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    for fixture_name, fixture_spec in SETS.items():
        save_fixture(fixture_name, fixture_spec)
    for fixture_name, fixture_spec in B_SETS.items():
        save_template_b_fixture(fixture_name, fixture_spec)
    save_legacy_compatibility_fixture()
