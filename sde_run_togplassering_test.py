import json
from pathlib import Path

INPUT_FILE = Path("sde_togplassering_test_2026_05_18.json")


def main():
    data = json.loads(INPUT_FILE.read_text())

    print("=== SDE Togplassering-test ===")
    print("Navn:", data.get("name"))
    print("Til spor utelatt:", data.get("target_slot_is_intentionally_omitted"))
    print("Antall rader:", len(data.get("rows", [])))

    print("\n=== Inndata uten Til spor ===")
    for row in data.get("rows", []):
        wc = "WC/vann" if row.get("wc_water") else "-"
        note = row.get("note") or ""
        print(
            f'{row.get("time")} | '
            f'{row.get("from_train")}'
            f'{("/" + row.get("from_set")) if row.get("from_set") else ""} -> '
            f'{row.get("to_train")}'
            f'{("/" + row.get("to_set")) if row.get("to_set") else ""} | '
            f'{row.get("vehicle")} | {wc} | {note}'
        )

    print("\n=== Foreløpig klassifisering ===")
    for row in data.get("rows", []):
        needs = []

        if row.get("wc_water"):
            needs.append("må via spor 6 for WC/vann")

        if str(row.get("to_train", "")).lower() == "rep":
            needs.append("skal til reparasjon/verkstedflyt")

        if row.get("note"):
            needs.append(row["note"])

        if not needs:
            needs.append("produksjonsplassering")

        print(f'{row["time"]} | {row["vehicle"]}: ' + "; ".join(needs))


if __name__ == "__main__":
    main()
