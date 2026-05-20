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






def get_free_candidate_slots(status):
    candidate_slots = [
        "1S", "1N",
        "4S", "4M", "4N",
        "5S", "5M", "5N",
        "10S", "10N",
        "11S", "11N",
        "12S", "12N",
    ]

    return [slot for slot in candidate_slots if not status.get(slot)]



def filter_n_before_s_candidates(candidates, status):
    filtered = []

    for slot in candidates:
        if slot not in {"10N", "11N", "12N"}:
            filtered.append(slot)
            continue

        track = slot[:-1]
        s_slot = f"{track}S"

        # Buttsporregel:
        # Hvis S er ledig og N er ledig, skal S vurderes før N.
        # N fjernes derfor som første kandidat inntil S er brukt eller ikke lenger er aktuell.
        if not status.get(s_slot):
            continue

        filtered.append(slot)

    return filtered


def suggest_candidate_slots_for_production(row, status):
    free = get_free_candidate_slots(status)
    to_train = str(row.get("to_train", "")).strip()

    # Første forsiktige kandidatlogikk.
    # Dette er ikke endelig sporvalg.
    if to_train == "802":
        preferred = ["1S", "1N", "11S", "11N", "12S", "12N"]
    elif to_train == "852":
        preferred = ["11S", "11N", "12S", "12N", "1S", "1N"]
    elif to_train in {"806", "856", "808"}:
        preferred = ["11S", "11N", "12S", "12N", "5N", "5M", "5S"]
    elif to_train == "2470":
        preferred = ["10S", "10N", "1S", "1N"]
    else:
        # Buttspor 10/11/12: S må vurderes før N hvis begge skal kunne brukes.
        preferred = ["11S", "11N", "12S", "12N", "10S", "10N", "5N", "5M", "5S", "4N", "4M", "4S", "1S", "1N"]

    candidates = [slot for slot in preferred if slot in free]
    candidates = filter_n_before_s_candidates(candidates, status)

    if not candidates:
        return "ingen ledige kandidatspor funnet"

    return ", ".join(candidates[:4])




def explain_reserved_slot(row, slot):
    to_train = str(row.get("to_train", "")).strip()

    if slot in {"10S", "11S", "12S"}:
        return f"{slot} valgt fordi S må fylles før N i buttspor"

    if slot in {"10N", "11N", "12N"}:
        return f"{slot} valgt fordi S i samme buttspor allerede er opptatt/reservert"

    if slot.startswith("5"):
        return f"{slot} valgt som fleksibelt kandidatspor når buttspor prioriteres bort eller er brukt"

    if slot.startswith("1"):
        return f"{slot} valgt som tilgjengelig alternativ for tog {to_train}, men må vurderes mot trafikkbildet"

    if slot.startswith("4"):
        return f"{slot} valgt som reserve-/parkeringskandidat"

    return "valgt som første ledige kandidat etter gjeldende prioritering"


def choose_first_candidate_slot(row, status):
    candidates_text = suggest_candidate_slots_for_production(row, status)

    if candidates_text == "ingen ledige kandidatspor funnet":
        return ""

    return candidates_text.split(",", 1)[0].strip()


def simulate_production_reservations(rows, base_status):
    simulated_status = dict(base_status)
    assignments = []

    for row in rows:
        if suggest_target_type_for_row(row) != "produksjonsplassering":
            continue

        slot = choose_first_candidate_slot(row, simulated_status)

        if not slot:
            assignments.append((row, "ingen kandidat", "ikke reservert"))
            continue

        simulated_status[slot] = row.get("vehicle")
        reason = explain_reserved_slot(row, slot)
        assignments.append((row, slot, "reservert", reason))

    return assignments



def row_key(row):
    return (
        row.get("time", ""),
        row.get("vehicle", ""),
        row.get("from_train", ""),
        row.get("to_train", ""),
    )


def build_production_assignment_map(reservations):
    assignment_map = {}

    for item in reservations:
        if len(item) == 4:
            row, slot, reservation_status, reason = item
        else:
            row, slot, reservation_status = item

        assignment_map[row_key(row)] = slot

    return assignment_map


def get_sde_target_for_evaluation(row, status, production_assignment_map):
    target_type = suggest_target_type_for_row(row)

    if target_type == "produksjonsplassering":
        return production_assignment_map.get(row_key(row), "")

    if target_type == "service via spor 6 før videre plassering":
        service_slot = suggest_service_slot(status)
        if service_slot.startswith("spor 6 opptatt"):
            return "spor 6 opptatt"
        return service_slot

    if target_type == "verksted-/repflyt":
        if row.get("wc_water"):
            service_slot = suggest_service_slot(status)
            if service_slot.startswith("spor 6 opptatt"):
                return "spor 6 opptatt/rep"
            return f"{service_slot}/rep"
        return "rep"

    if target_type == "deling/skjøting":
        return "deling/skjøting"

    return ""


def evaluate_against_fasit(sde_target, fasit_target):
    if not fasit_target:
        return "ingen fasit"

    if sde_target == fasit_target:
        return "treffer godt"

    if fasit_target in sde_target or sde_target in fasit_target:
        return "treffer godt"

    if fasit_target.startswith("6") and sde_target.startswith("6"):
        return "treffer godt"

    if "rep" in fasit_target and "rep" in sde_target:
        return "delvis riktig"

    if "deling" in fasit_target and "deling" in sde_target:
        return "treffer godt"

    if sde_target:
        return "operativt tvilsom"

    return "feil"


def suggest_production_area_for_row(row):
    to_train = str(row.get("to_train", "")).strip()

    # Første grove produksjonsregel.
    # Dette er ikke fasitspor, bare et første produksjonsområde SDE kan jobbe videre fra.
    if to_train == "802":
        return "morgenproduksjon 802: bør prioriteres lett tilgjengelig mot spor 2/3 etter eventuell service"

    if to_train == "852":
        return "morgenproduksjon 852: bør settes opp i sammenheng med 802 uten å blokkere 802"

    if to_train in {"806", "856", "808"}:
        return f"morgenproduksjon {to_train}: må plasseres slik at uttak mot togspor ikke blokkeres"

    if to_train in {"862", "864"}:
        return f"produksjon {to_train}: må ikke sperre vask-/returvei for 862"

    if to_train == "2470":
        return "fast natt-/morgenoppgave 2470: må plasseres etter faktisk Sporplan og kjente nattoppgaver"

    if to_train.isdigit():
        return f"produksjon mot tog {to_train}: finn egnet parkerings-/produksjonsspor ut fra faktisk Sporplan"

    return "produksjonsområde må avklares"


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

    return suggest_production_area_for_row(row)


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

    print("\n=== Foreslått produksjonsområde uten Til spor ===")
    for row in data.get("rows", []):
        if suggest_target_type_for_row(row) == "produksjonsplassering":
            print(f'{row["time"]} | {row["vehicle"]} | {row["from_train"]} -> {row["to_train"]}: {suggest_production_area_for_row(row)}')

    print("\n=== Foreslåtte kandidatspor uten Til spor ===")
    for row in data.get("rows", []):
        if suggest_target_type_for_row(row) == "produksjonsplassering":
            print(f'{row["time"]} | {row["vehicle"]} | {row["from_train"]} -> {row["to_train"]}: {suggest_candidate_slots_for_production(row, status)}')

    print("\n=== Simulert første reservasjon av produksjonsspor ===")
    reservations = simulate_production_reservations(data.get("rows", []), status)
    for item in reservations:
        if len(item) == 4:
            row, slot, reservation_status, reason = item
        else:
            row, slot, reservation_status = item
            reason = ""
        suffix = f" | {reason}" if reason else ""
        print(f'{row["time"]} | {row["vehicle"]} | {row["from_train"]} -> {row["to_train"]}: {slot} ({reservation_status}){suffix}')

    print("\n=== Evaluering mot fasit etter SDE-forslag ===")
    production_assignment_map = build_production_assignment_map(reservations)
    evaluation_counts = {
        "treffer godt": 0,
        "delvis riktig": 0,
        "operativt tvilsom": 0,
        "feil": 0,
        "ingen fasit": 0,
    }

    for row in data.get("rows", []):
        fasit_target = row.get("fasit_target_for_evaluation_only", "")
        sde_target = get_sde_target_for_evaluation(row, status, production_assignment_map)
        vurdering = evaluate_against_fasit(sde_target, fasit_target)
        evaluation_counts[vurdering] = evaluation_counts.get(vurdering, 0) + 1
        print(
            f'{row["time"]} | {row["vehicle"]} | {row["from_train"]} -> {row["to_train"]}: '
            f'SDE={sde_target or "-"} | fasit={fasit_target or "-"} | {vurdering}'
        )

    print("\n=== Evalueringsoppsummering ===")
    total = sum(evaluation_counts.values())
    print(f"Totalt vurdert: {total}")
    print(f"Treffer godt: {evaluation_counts.get('treffer godt', 0)}")
    print(f"Delvis riktig: {evaluation_counts.get('delvis riktig', 0)}")
    print(f"Operativt tvilsom: {evaluation_counts.get('operativt tvilsom', 0)}")
    print(f"Feil: {evaluation_counts.get('feil', 0)}")
    print(f"Ingen fasit: {evaluation_counts.get('ingen fasit', 0)}")

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
