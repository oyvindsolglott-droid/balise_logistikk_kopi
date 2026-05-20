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


def compare_row(row: dict[str, Any], api_today: dict[str, Any], api_tomorrow: dict[str, Any]) -> dict[str, Any]:
    settnr = normalize_vehicle(row.get("settnr", ""))
    fra_tog = row.get("fra_tog", "")
    til_tog = row.get("til_tog", "")

    today_from = lookup_train(api_today, fra_tog)
    today_to = lookup_train(api_today, til_tog)

    tomorrow_from = lookup_train(api_tomorrow, fra_tog)
    tomorrow_to = lookup_train(api_tomorrow, til_tog)

    today_candidates = set(today_from["vehicles"] + today_to["vehicles"])
    tomorrow_candidates = set(tomorrow_from["vehicles"] + tomorrow_to["vehicles"])

    warnings: list[str] = []

    if not settnr:
        status = "mangler_import_kjøretøy"
        warnings.append("Import-raden mangler settnr/kjøretøy.")
    elif settnr in today_candidates:
        status = "samsvar_idag"
    elif today_candidates:
        status = "avvik_idag"
        warnings.append("Importert kjøretøy samsvarer ikke med dagens Tursatt/Balise for fra_tog eller til_tog.")
    else:
        status = "mangler_tursatt_idag"
        warnings.append("Fant ingen kjøretøy i dagens Tursatt/Balise for fra_tog eller til_tog.")

    if not api_tomorrow.get("vehicles") and not api_tomorrow.get("departureVehicles") and not api_tomorrow.get("arrivalVehicles"):
        warnings.append("Morgendagens kjøretøydata mangler foreløpig, derfor er imorgen-sammenligning ikke mulig.")
    elif settnr and settnr in tomorrow_candidates:
        warnings.append("Importert kjøretøy finnes i morgendagens Tursatt/Balise.")
    elif tomorrow_candidates:
        warnings.append("Importert kjøretøy samsvarer ikke med morgendagens Tursatt/Balise for fra_tog eller til_tog.")

    return {
        "linje": row.get("linje"),
        "klokkeslett": row.get("klokkeslett"),
        "fra_tog": fra_tog,
        "til_tog": til_tog,
        "settnr_import": row.get("settnr"),
        "spor_raw": row.get("spor_raw"),
        "status": status,
        "idag": {
            "fra_tog": today_from,
            "til_tog": today_to,
        },
        "imorgen": {
            "fra_tog": tomorrow_from,
            "til_tog": tomorrow_to,
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
