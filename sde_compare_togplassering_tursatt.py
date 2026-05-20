from __future__ import annotations

import json
from pathlib import Path
from typing import Any


IMPORT_PATH = Path("data/sde_togplassering_import_resultat.json")
API_TODAY_PATH = Path("data/api_idag.json")
API_TOMORROW_PATH = Path("data/api_imorgen.json")

OUTPUT_JSON = Path("data/sde_togplassering_tursatt_sammenligning.json")
OUTPUT_REPORT = Path("data/sde_togplassering_tursatt_sammenligning_rapport.txt")


def normalize_train(value: str) -> str:
    value = str(value or "").strip()
    if "/" in value:
        value = value.split("/", 1)[0]
    return value.strip()


def normalize_vehicle(value: str) -> str:
    return str(value or "").strip().replace(" ", "")


def vehicle_list(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, list):
        raw = value
    else:
        raw = str(value).replace(";", ",").split(",")
    return [normalize_vehicle(v) for v in raw if normalize_vehicle(v)]


def lookup_train(api: dict[str, Any], train: str) -> dict[str, Any]:
    key = normalize_train(train)
    if not key or key.lower() == "rep":
        return {
            "tog": key,
            "funnet": False,
            "vehicles": [],
            "kilde": "ikke_relevant",
        }

    sources = [
        ("departureVehicles", api.get("departureVehicles", {})),
        ("arrivalVehicles", api.get("arrivalVehicles", {})),
        ("vehicles", api.get("vehicles", {})),
    ]

    for source_name, source in sources:
        if isinstance(source, dict) and key in source:
            return {
                "tog": key,
                "funnet": True,
                "vehicles": vehicle_list(source.get(key)),
                "kilde": source_name,
            }

    return {
        "tog": key,
        "funnet": False,
        "vehicles": [],
        "kilde": "mangler",
    }


def is_after_midnight_time(value: str) -> bool:
    try:
        hour = int(str(value or "").split(":", 1)[0])
    except (ValueError, IndexError):
        return False
    return 0 <= hour < 6


def classify_match(
    settnr: str,
    today_from: dict[str, Any],
    today_to: dict[str, Any],
    til_tog: str,
) -> tuple[str, dict[str, bool], list[str]]:
    warnings: list[str] = []
    til_is_rep = normalize_train(til_tog).lower() == "rep"

    from_match = bool(settnr and settnr in set(today_from["vehicles"]))
    to_match = bool(settnr and settnr in set(today_to["vehicles"]))
    from_has_data = bool(today_from["vehicles"])
    to_has_data = bool(today_to["vehicles"])

    details = {
        "fra_tog_samsvar": from_match,
        "til_tog_samsvar": to_match,
        "fra_tog_har_data": from_has_data,
        "til_tog_har_data": to_has_data,
        "til_tog_er_rep": til_is_rep,
    }

    if not settnr:
        warnings.append("Import-raden mangler settnr/kjøretøy.")
        return "mangler_import_kjøretøy", details, warnings

    if til_is_rep:
        if from_match:
            return "rep_samsvar_fra_tog", details, warnings
        if from_has_data:
            warnings.append("Reparasjonsrad: importert kjøretøy samsvarer ikke med dagens fra_tog.")
            return "rep_avvik_fra_tog", details, warnings
        warnings.append("Reparasjonsrad: mangler Tursatt/Balise-kjøretøy for fra_tog.")
        return "rep_mangler_fra_tog", details, warnings

    if from_match and to_match:
        return "samsvar_begge_idag", details, warnings

    if from_match:
        warnings.append("Importert kjøretøy samsvarer med fra_tog, men ikke med til_tog.")
        return "samsvar_fra_tog", details, warnings

    if to_match:
        warnings.append("Importert kjøretøy samsvarer med til_tog, men ikke med fra_tog.")
        return "samsvar_til_tog", details, warnings

    if from_has_data or to_has_data:
        warnings.append("Importert kjøretøy samsvarer verken med dagens fra_tog eller til_tog.")
        return "avvik_begge_idag", details, warnings

    warnings.append("Fant ingen kjøretøy i dagens Tursatt/Balise for fra_tog eller til_tog.")
    return "mangler_tursatt_idag", details, warnings


def compare_row(row: dict[str, Any], api_today: dict[str, Any], api_tomorrow: dict[str, Any]) -> dict[str, Any]:
    settnr = normalize_vehicle(row.get("settnr", ""))
    fra_tog = row.get("fra_tog", "")
    til_tog = row.get("til_tog", "")
    klokkeslett = row.get("klokkeslett", "")

    today_from = lookup_train(api_today, fra_tog)
    today_to = lookup_train(api_today, til_tog)

    tomorrow_from = lookup_train(api_tomorrow, fra_tog)
    tomorrow_to = lookup_train(api_tomorrow, til_tog)

    status, match_details, warnings = classify_match(
        settnr=settnr,
        today_from=today_from,
        today_to=today_to,
        til_tog=til_tog,
    )

    tomorrow_available = bool(
        api_tomorrow.get("vehicles")
        or api_tomorrow.get("departureVehicles")
        or api_tomorrow.get("arrivalVehicles")
    )

    after_midnight = is_after_midnight_time(klokkeslett)

    if after_midnight:
        warnings.append("Rad etter midnatt: bør vurderes mot morgendagens kjøretøydata når de finnes.")

    if not tomorrow_available:
        warnings.append("Morgendagens kjøretøydata mangler foreløpig, derfor er imorgen-sammenligning ikke mulig.")
    else:
        tomorrow_candidates = set(tomorrow_from["vehicles"] + tomorrow_to["vehicles"])
        if settnr and settnr in tomorrow_candidates:
            warnings.append("Importert kjøretøy finnes i morgendagens Tursatt/Balise.")
        elif tomorrow_candidates:
            warnings.append("Importert kjøretøy samsvarer ikke med morgendagens Tursatt/Balise for fra_tog eller til_tog.")

    return {
        "linje": row.get("linje"),
        "klokkeslett": klokkeslett,
        "fra_tog": fra_tog,
        "til_tog": til_tog,
        "settnr_import": row.get("settnr"),
        "spor_raw": row.get("spor_raw"),
        "status": status,
        "match": match_details,
        "rad_etter_midnatt": after_midnight,
        "idag": {
            "fra_tog": today_from,
            "til_tog": today_to,
        },
        "imorgen": {
            "fra_tog": tomorrow_from,
            "til_tog": tomorrow_to,
            "kjoretoydata_tilgjengelig": tomorrow_available,
        },
        "advarsler": warnings,
    }


def build_report(result: dict[str, Any]) -> str:
    lines: list[str] = []
    lines.append("SDE sammenligning – Togplassering mot Tursatt/Balise")
    lines.append("=" * 58)
    lines.append("")
    lines.append(f"Importkilde: {result['importkilde']}")
    lines.append(f"Tursatt i dag: {result['api_idag_date']} | {result['api_idag_updatedAt']}")
    lines.append(f"Tursatt i morgen: {result['api_imorgen_date']} | {result['api_imorgen_updatedAt']}")
    lines.append("")
    lines.append("Oppsummering")
    lines.append("-" * 12)
    for key, value in result["oppsummering"].items():
        lines.append(f"{key}: {value}")
    lines.append("")

    lines.append("Rader")
    lines.append("-" * 5)
    for row in result["rader"]:
        lines.append(
            f"Linje {row['linje']} | {row['klokkeslett']} | "
            f"{row['fra_tog']} -> {row['til_tog']} | import: {row['settnr_import']} | status: {row['status']}"
        )

        today_from = ", ".join(row["idag"]["fra_tog"]["vehicles"]) or "-"
        today_to = ", ".join(row["idag"]["til_tog"]["vehicles"]) or "-"
        lines.append(f"  I dag fra_tog {row['idag']['fra_tog']['tog']}: {today_from}")
        lines.append(f"  I dag til_tog {row['idag']['til_tog']['tog']}: {today_to}")
        lines.append(
            "  Samsvar: "
            f"fra_tog={row.get('match', {}).get('fra_tog_samsvar', False)}, "
            f"til_tog={row.get('match', {}).get('til_tog_samsvar', False)}, "
            f"rep={row.get('match', {}).get('til_tog_er_rep', False)}, "
            f"etter_midnatt={row.get('rad_etter_midnatt', False)}"
        )

        for warning in row["advarsler"]:
            lines.append(f"  ADVARSEL: {warning}")
        lines.append("")

    return "\n".join(lines).rstrip() + "\n"


def main() -> None:
    imported = json.loads(IMPORT_PATH.read_text(encoding="utf-8"))
    api_today = json.loads(API_TODAY_PATH.read_text(encoding="utf-8"))
    api_tomorrow = json.loads(API_TOMORROW_PATH.read_text(encoding="utf-8"))

    rows = [
        compare_row(row, api_today, api_tomorrow)
        for row in imported.get("rader", [])
    ]

    summary: dict[str, int] = {}
    for row in rows:
        summary[row["status"]] = summary.get(row["status"], 0) + 1

    result = {
        "importkilde": imported.get("kilde"),
        "api_idag_date": api_today.get("date"),
        "api_idag_updatedAt": api_today.get("updatedAt"),
        "api_imorgen_date": api_tomorrow.get("date"),
        "api_imorgen_updatedAt": api_tomorrow.get("updatedAt"),
        "oppsummering": dict(sorted(summary.items())),
        "rader": rows,
    }

    OUTPUT_JSON.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    OUTPUT_REPORT.write_text(build_report(result), encoding="utf-8")

    print(f"Skrev {OUTPUT_JSON}")
    print(f"Skrev {OUTPUT_REPORT}")
    print("Oppsummering:")
    for key, value in result["oppsummering"].items():
        print(f"  {key}: {value}")


if __name__ == "__main__":
    main()
