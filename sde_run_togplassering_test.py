import json
from pathlib import Path

INPUT_FILE = Path("sde_togplassering_test_2026_05_18.json")


def suggest_flow_for_row(row):
    flow = []

    vehicle = row.get("vehicle")
    from_train = row.get("from_train")
    to_train = str(row.get("to_train", "")).lower()
    wc_water = bool(row.get("wc_water"))
    note = str(row.get("note") or "").lower()

    flow.append(f"Ankommer med tog {from_train}")

    if "dele motsatt" in note:
        flow.append("må håndteres som deling/skjøting før videre plassering")

    if wc_water:
        flow.append("må via spor 6 for WC/vann")

    if to_train == "rep":
        flow.append("skal videre i verksted-/repflyt")
    else:
        flow.append(f"skal inngå i videre produksjon mot tog {row.get('to_train')}")

    flow.append("SDE skal selv beregne egnet spor ut fra faktisk Sporplan")

    return flow


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

    print("\n=== Foreslått operativ flyt uten Til spor ===")
    for row in data.get("rows", []):
        print(f'\n{row["time"]} | {row["vehicle"]} | {row["from_train"]} -> {row["to_train"]}')
        for step_no, step in enumerate(suggest_flow_for_row(row), start=1):
            print(f"  {step_no}. {step}")


if __name__ == "__main__":
    main()
