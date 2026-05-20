from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any


INPUT_PATH = Path("data/sde_togplassering_import_test.txt")
OUTPUT_PATH = Path("data/sde_togplassering_import_resultat.json")


VALID_SINGLE_SLOTS = {
    "9",
    "1S", "1N",
    "2S", "2N",
    "3S", "3M", "3N",
    "4S", "4M", "4N",
    "5S", "5M", "5N",
    "6SS", "6S", "6N",
    "7SS", "7S", "7N",
    "8SS", "8S", "8N",
    "10S", "10N",
    "11S", "11N",
    "12S", "12N",
}


def normalize_token(value: str) -> str:
    return value.strip()


def normalize_slot_token(token: str) -> tuple[str, list[str]]:
    """
    Normaliserer én spor-token.

    Eksempler:
    3n   -> 3N
    6ss  -> 6SS
    6    -> 6 + advarsel fordi spor 6 alene er tvetydig
    bos  -> BOS + advarsel fordi dette ikke er et fysisk spor
    """
    warnings: list[str] = []
    raw = token.strip()
    upper = raw.upper()

    if not upper:
        return "", warnings

    if upper == "BOS":
        warnings.append("BOS er tolket som merknad/område, ikke som presist spor.")
        return upper, warnings

    if upper in {"1", "2", "3", "4", "5", "6", "7", "8", "10", "11", "12"}:
        warnings.append(f"Spor '{upper}' mangler posisjon, for eksempel S/M/N/SS.")
        return upper, warnings

    if upper not in VALID_SINGLE_SLOTS:
        warnings.append(f"Ukjent eller ikke-standard sporverdi: '{raw}'.")

    return upper, warnings


def parse_spor_flyt(value: str) -> tuple[list[str], list[str]]:
    """
    Tolker felt som:
    5s-3m
    6ss-3n
    6-11s
    1s-bos
    """
    warnings: list[str] = []
    value = value.strip()

    if not value:
        return [], warnings

    parts = [p.strip() for p in value.split("-") if p.strip()]
    normalized: list[str] = []

    for part in parts:
        slot, slot_warnings = normalize_slot_token(part)
        if slot:
            normalized.append(slot)
        warnings.extend(slot_warnings)

    return normalized, warnings


def parse_extra_field(field: str) -> tuple[str | None, str]:
    """
    Tolker valgfrie felt som:
    WC/vann: x
    Info: 804 vis klar
    Merknad: Enkelt!
    """
    if ":" not in field:
        return None, field.strip()

    key, value = field.split(":", 1)
    return key.strip().lower(), value.strip()


def classify_action(til_tog: str, spor_flyt: list[str], wc_vann: bool, merknad: str) -> list[str]:
    tags: list[str] = []

    if til_tog.lower() == "rep":
        tags.append("reparasjon")

    if wc_vann:
        tags.append("wc_vann")

    if any(slot.startswith("6") for slot in spor_flyt):
        tags.append("via_spor_6")

    if len(spor_flyt) > 1:
        tags.append("spor_flyt")

    if "dele" in merknad.lower():
        tags.append("deling")

    if "enkelt" in merknad.lower():
        tags.append("enkeltsett")

    return tags


def evaluate_operational_risk(
    spor_flyt: list[str],
    wc_vann: bool,
    til_tog: str,
    merknad: str,
    warnings: list[str],
) -> dict[str, Any]:
    """
    Første enkle SDE-vurdering av importert togplassering.

    Dette er ikke en endelig fasit. Den skal bare peke ut rader som
    bør kontrolleres før de brukes i en operativ plan.
    """
    notes: list[str] = []
    risk_points = 0

    if warnings:
        risk_points += 2
        notes.append("Rad har tolkningsadvarsler og må kontrolleres manuelt.")

    if not spor_flyt:
        risk_points += 3
        notes.append("Mangler planlagt spor/flyt. SDE kan ikke planlegge sikkert.")

    if "6SS" in spor_flyt or "7SS" in spor_flyt or "8SS" in spor_flyt:
        risk_points += 3
        notes.append("SS-spor kan blokkere sør/bru-rute hvis kjøretøy blir stående.")

    if "6" in spor_flyt:
        risk_points += 2
        notes.append("Spor 6 uten S/N/SS er tvetydig og må presiseres.")

    if any(slot in {"10S", "11S", "12S"} for slot in spor_flyt):
        notes.append("Buttspor S-posisjon: kontroller at innsetting følger S før N-regelen.")

    if any(slot in {"10N", "11N", "12N"} for slot in spor_flyt):
        notes.append("Buttspor N-posisjon: kontroller at S-posisjon ikke blir sperret inne feil.")

    if wc_vann and not any(slot.startswith("6") for slot in spor_flyt):
        risk_points += 2
        notes.append("WC/vann er markert, men spor 6 inngår ikke i planlagt flyt.")

    if til_tog.lower() == "rep":
        notes.append("Reparasjon/verkstedflyt: bør vurderes mot ledig verkstedkapasitet og faktisk Sporplan.")

    if "dele" in merknad.lower():
        risk_points += 2
        notes.append("Deling/omvendt skjøting krever særskilt kontroll av spor, retning og uttak.")

    if any(slot in {"2S", "2N", "3S", "3M", "3N"} for slot in spor_flyt):
        notes.append("Plattformspor inngår i flyten. Kontroller at dette er kortvarig/operativt begrunnet.")

    if risk_points >= 5:
        level = "høy"
    elif risk_points >= 2:
        level = "middels"
    else:
        level = "lav"

    return {
        "risikonivå": level,
        "risikopoeng": risk_points,
        "sde_merknader": notes,
    }


def build_import_summary(rows: list[dict[str, Any]]) -> dict[str, Any]:
    risk_counts = {"lav": 0, "middels": 0, "høy": 0}
    action_counts: dict[str, int] = {}
    warning_counts: dict[str, int] = {}

    for row in rows:
        vurdering = row.get("operativ_vurdering", {})
        risk = vurdering.get("risikonivå", "ukjent")
        if risk in risk_counts:
            risk_counts[risk] += 1

        for tag in row.get("handlingstyper", []):
            action_counts[tag] = action_counts.get(tag, 0) + 1

        for warning in row.get("advarsler", []):
            warning_counts[warning] = warning_counts.get(warning, 0) + 1

    return {
        "antall_rader": len(rows),
        "tolkning": {
            "ok": sum(1 for row in rows if row["tolkningsstatus"] == "ok"),
            "må_kontrolleres": sum(1 for row in rows if row["tolkningsstatus"] != "ok"),
        },
        "risiko": risk_counts,
        "handlingstyper": dict(sorted(action_counts.items())),
        "advarsler": dict(sorted(warning_counts.items())),
    }


def parse_line(line: str, line_no: int) -> dict[str, Any]:
    warnings: list[str] = []

    raw_parts = [p.strip() for p in line.split("|")]
    while len(raw_parts) < 5:
        raw_parts.append("")

    klokkeslett = normalize_token(raw_parts[0])
    fra_tog = normalize_token(raw_parts[1])
    til_tog = normalize_token(raw_parts[2])
    settnr = normalize_token(raw_parts[3])
    spor_raw = normalize_token(raw_parts[4])

    spor_flyt, spor_warnings = parse_spor_flyt(spor_raw)
    warnings.extend(spor_warnings)

    wc_vann = False
    info = ""
    merknad = ""

    for extra in raw_parts[5:]:
        if not extra:
            continue

        key, value = parse_extra_field(extra)

        if key in {"wc/vann", "wc", "vann"}:
            wc_vann = value.lower() in {"x", "j", "ja", "true", "1"}
        elif key == "info":
            info = value
        elif key == "merknad":
            merknad = value
        else:
            warnings.append(f"Ukjent tilleggsfelt: '{extra}'.")

    if not re.fullmatch(r"\d{2}:\d{2}", klokkeslett):
        warnings.append(f"Klokkeslett har uventet format: '{klokkeslett}'.")

    if not settnr:
        warnings.append("Mangler settnr/kjøretøy.")

    if not spor_flyt:
        warnings.append("Mangler planlagt spor/flyt.")

    action_tags = classify_action(til_tog, spor_flyt, wc_vann, merknad)
    operational_risk = evaluate_operational_risk(
        spor_flyt=spor_flyt,
        wc_vann=wc_vann,
        til_tog=til_tog,
        merknad=merknad,
        warnings=warnings,
    )

    return {
        "linje": line_no,
        "råtekst": line,
        "klokkeslett": klokkeslett,
        "fra_tog": fra_tog,
        "til_tog": til_tog,
        "settnr": settnr,
        "spor_raw": spor_raw,
        "spor_flyt": spor_flyt,
        "wc_vann": wc_vann,
        "info": info,
        "merknad": merknad,
        "handlingstyper": action_tags,
        "tolkningsstatus": "må_kontrolleres" if warnings else "ok",
        "advarsler": warnings,
        "operativ_vurdering": operational_risk,
    }


def main() -> None:
    lines = [
        line.strip()
        for line in INPUT_PATH.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]

    rows = [parse_line(line, idx + 1) for idx, line in enumerate(lines)]

    summary = build_import_summary(rows)

    result = {
        "kilde": str(INPUT_PATH),
        "antall_rader": len(rows),
        "antall_ok": summary["tolkning"]["ok"],
        "antall_må_kontrolleres": summary["tolkning"]["må_kontrolleres"],
        "oppsummering": summary,
        "rader": rows,
    }

    OUTPUT_PATH.write_text(
        json.dumps(result, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    print(f"Skrev {OUTPUT_PATH}")
    print(f"Antall rader: {result['antall_rader']}")
    print(f"OK: {result['antall_ok']}")
    print(f"Må kontrolleres: {result['antall_må_kontrolleres']}")
    print()
    print("Importanalyse:")
    print(f"  Lav risiko: {summary['risiko']['lav']}")
    print(f"  Middels risiko: {summary['risiko']['middels']}")
    print(f"  Høy risiko: {summary['risiko']['høy']}")
    print("  Handlingstyper:")
    for tag, count in summary["handlingstyper"].items():
        print(f"    {tag}: {count}")

    for row in rows:
        if row["advarsler"]:
            print()
            print(f"Linje {row['linje']}: {row['råtekst']}")
            for warning in row["advarsler"]:
                print(f"  - {warning}")


if __name__ == "__main__":
    main()
