import json
from pathlib import Path

INPUT_FILE = Path("sde_togplassering_test_2026_05_18.json")



def load_sporplan_status():
    path = Path("sde_live_sporplan_snapshot.json")
    if not path.exists():
        return {}, "mangler sde_live_sporplan_snapshot.json"

    data = json.loads(path.read_text())
    return data.get("sporplan_status", {}), data.get("snapshot_name", "ukjent snapshot")


def suggest_service_slot(status):
    if not status.get("6N"):
        return "6N"

    if not status.get("6S"):
        return "6S"

    return "spor 6 opptatt - må frigjøres før WC/vann"


def suggest_target_type_for_row(row):
    to_train = str(row.get("to_train", "")).lower()
    note = str(row.get("note") or "").lower()

    if "dele motsatt" in note:
        return "deling/skjøting"

    if to_train == "rep":
        return "verksted-/repflyt"

    if row.get("wc_water"):
        return "service via spor 6 før videre plassering"

    return "produksjonsplassering"



def suggest_action_type_for_row(row):
    target_type = suggest_target_type_for_row(row)

    if target_type == "service via spor 6 før videre plassering":
        return "først servicebevegelse til spor 6, deretter ny vurdering for sluttplassering"

    if target_type == "verksted-/repflyt":
        if row.get("wc_water"):
            return "først WC/vann via spor 6, deretter verksted-/repflyt"
        return "verksted-/repflyt må planlegges mot ledig/egnet verkstedtilgang"

    if target_type == "deling/skjøting":
        return "deling/skjøting må planlegges før kjøretøy settes videre mot produksjon"

    return "direkte produksjonsplassering må beregnes ut fra faktisk Sporplan"




def suggest_first_action_for_row(row, status=None):
    status = status or {}
    target_type = suggest_target_type_for_row(row)

    if target_type == "service via spor 6 før videre plassering":
        service_slot = suggest_service_slot(status)
        if service_slot.startswith("spor 6 opptatt"):
            return service_slot
        return f"skift kjøretøyet til {service_slot} for WC/vann"

    if target_type == "verksted-/repflyt":
        if row.get("wc_water"):
            service_slot = suggest_service_slot(status)
            if service_slot.startswith("spor 6 opptatt"):
                return f"{service_slot}; deretter verksted-/repflyt"
            return f"skift kjøretøyet til {service_slot} for WC/vann før verksted-/repflyt"
        return "vurder ledig/egnet verkstedvei og flytt mot rep"

    if target_type == "deling/skjøting":
        return "planlegg deling/skjøting før videre plassering"

    return "finn beste produksjonsplassering ut fra faktisk Sporplan"


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

    print("\n=== Foreslått måltype uten Til spor ===")
    for row in data.get("rows", []):
        target_type = suggest_target_type_for_row(row)
        print(f'{row["time"]} | {row["vehicle"]} | {row["from_train"]} -> {row["to_train"]}: {target_type}')

    print("\n=== Foreslått handlingstype uten Til spor ===")
    for row in data.get("rows", []):
        print(f'{row["time"]} | {row["vehicle"]} | {row["from_train"]} -> {row["to_train"]}: {suggest_action_type_for_row(row)}')

    status, snapshot_name = load_sporplan_status()
    print("\n=== Sporplan brukt for første handling ===")
    print(f"Snapshot: {snapshot_name}")
    print(f"6N: {status.get('6N') or '-'}")
    print(f"6S: {status.get('6S') or '-'}")

    print("\n=== Foreslått første handling uten Til spor ===")
    for row in data.get("rows", []):
        print(f'{row["time"]} | {row["vehicle"]} | {row["from_train"]} -> {row["to_train"]}: {suggest_first_action_for_row(row, status)}')

    print("\n=== Foreslått operativ flyt uten Til spor ===")
    for row in data.get("rows", []):
        print(f'\n{row["time"]} | {row["vehicle"]} | {row["from_train"]} -> {row["to_train"]}')
        print(f'  Måltype: {suggest_target_type_for_row(row)}')
        print(f'  Handlingstype: {suggest_action_type_for_row(row)}')
        print(f'  Første handling: {suggest_first_action_for_row(row, status)}')
        for step_no, step in enumerate(suggest_flow_for_row(row), start=1):
            print(f"  {step_no}. {step}")


if __name__ == "__main__":
    main()
