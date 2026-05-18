import json
from pathlib import Path

from sde_models import SLOTS, Vehicle, Scenario


SNAPSHOT_PATH = Path("sde_input_snapshot.json")
LIVE_SPORPLAN_PATH = Path("sde_live_sporplan_snapshot.json")


def load_snapshot(path=SNAPSHOT_PATH):
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def load_live_sporplan_status(path=LIVE_SPORPLAN_PATH):
    if not path.exists():
        return None

    with path.open("r", encoding="utf-8") as f:
        payload = json.load(f)

    return payload.get("sporplan_status")


def apply_live_sporplan_status(snapshot):
    live_status = load_live_sporplan_status()
    if live_status is None:
        return snapshot

    merged = dict(snapshot)
    merged["manual_sporplan_status"] = snapshot.get("sporplan_status", {})
    merged["sporplan_status"] = live_status
    merged["live_sporplan_source"] = str(LIVE_SPORPLAN_PATH)
    return merged


def snapshot_to_scenario(snapshot):
    """
    Gjør manuell SDE snapshot-data om til et Scenario-objekt.

    Denne versjonen følger dagens faktiske sde_models.py:
    - Vehicle(number, role, needs, target_train)
    - Scenario(status, vehicles)
    - Nåværende plassering ligger i scenario.status, ikke i Vehicle.
    """

    snapshot = apply_live_sporplan_status(snapshot)
    status = dict(snapshot.get("sporplan_status", {}))

    # Manuelle input kan oppgi faktisk nåværende spor for kjøretøy som
    # ikke ligger i sporplan_status ennå. Da skal snapshot-status oppdateres,
    # slik at motoren faktisk kan beregne trekk fra riktig sted.
    for item in snapshot.get("manual_inputs", []):
        number = item.get("vehicle")
        current_slot = item.get("current_slot")

        if not number or not current_slot:
            continue

        already_placed = any(placed == number for placed in status.values())
        if already_placed:
            continue

        if current_slot in status and status.get(current_slot) is None:
            status[current_slot] = number

    vehicles_by_number = {}

    def ensure_vehicle(number, role="ukjent", needs=None, target_train=None):
        if not number:
            return

        existing = vehicles_by_number.get(number)

        merged_needs = []
        if existing:
            merged_needs.extend(existing.needs)

        if needs:
            for need in needs:
                if need and need not in merged_needs:
                    merged_needs.append(need)

        vehicles_by_number[number] = Vehicle(
            number=number,
            role=role if role != "ukjent" or not existing else existing.role,
            needs=merged_needs,
            target_train=target_train if target_train is not None else (existing.target_train if existing else None)
        )

    for slot, number in status.items():
        if number:
            ensure_vehicle(number, role="står_i_sporplan")

    for row in snapshot.get("tursatt_imorgen", {}).get("trains", []):
        ensure_vehicle(
            row.get("vehicle"),
            role=row.get("role", "tursatt_imorgen"),
            target_train=str(row.get("train")) if row.get("train") is not None else None
        )

    for row in snapshot.get("turnering_kveld", []):
        for number in row.get("vehicles", []):
            ensure_vehicle(number, role="turnering_kveld")

    for row in snapshot.get("turnering_natt", []):
        for number in row.get("vehicles", []):
            ensure_vehicle(number, role="turnering_natt")

    for item in snapshot.get("manual_inputs", []):
        needs = []

        # Ny struktur: needs er en liste.
        for need in item.get("needs", []):
            if need:
                needs.append(need)

        # Bakoverkompatibilitet med første snapshot-versjon.
        if item.get("need"):
            needs.append(item.get("need"))

        if item.get("preferred_slot"):
            needs.append(f"preferred_slot:{item.get('preferred_slot')}")

        if item.get("handling_required"):
            needs.append("handling_required")

        ensure_vehicle(
            item.get("vehicle"),
            role="manual_input",
            needs=needs
        )

    return Scenario(
        status=status,
        vehicles=vehicles_by_number
    )


def validate_sporplan_status(snapshot):
    errors = []
    warnings = []

    sporplan_status = snapshot.get("sporplan_status", {})

    missing_slots = [slot for slot in SLOTS if slot not in sporplan_status]
    unknown_slots = [slot for slot in sporplan_status if slot not in SLOTS]

    if missing_slots:
        errors.append(f"Mangler spor/sloter i sporplan_status: {', '.join(missing_slots)}")

    if unknown_slots:
        errors.append(f"Ukjente spor/sloter i sporplan_status: {', '.join(unknown_slots)}")

    occupied = {
        slot: vehicle
        for slot, vehicle in sporplan_status.items()
        if vehicle
    }

    vehicles_seen = {}
    for slot, vehicle in occupied.items():
        vehicles_seen.setdefault(vehicle, []).append(slot)

    duplicates = {
        vehicle: slots
        for vehicle, slots in vehicles_seen.items()
        if len(slots) > 1
    }

    if duplicates:
        for vehicle, slots in duplicates.items():
            errors.append(f"Kjøretøy {vehicle} står i flere spor/sloter: {', '.join(slots)}")

    if sporplan_status.get("6SS"):
        warnings.append("6SS er belagt. Dette begrenser rutevalg og bør vurderes særskilt.")

    if sporplan_status.get("2S") or sporplan_status.get("2N"):
        warnings.append("Spor 2 er belagt. Plattformspor bør ikke brukes til vanlig parkering.")

    if sporplan_status.get("3S") or sporplan_status.get("3M") or sporplan_status.get("3N"):
        warnings.append("Spor 3 er belagt. Dette kan være riktig ved ankomst/produksjon, men må begrunnes.")

    return errors, warnings, occupied


def print_snapshot_report(snapshot):
    print("SDE input snapshot")
    print("==================")
    print(f"Navn: {snapshot.get('snapshot_name', '-')}")
    print(f"Dato: {snapshot.get('date', '-')}")
    print()

    snapshot = apply_live_sporplan_status(snapshot)
    errors, warnings, occupied = validate_sporplan_status(snapshot)

    if snapshot.get("live_sporplan_source"):
        print(f"Live Sporplan-status: {snapshot.get('live_sporplan_source')}")
        print()

    print("Belagte spor/sloter:")
    if occupied:
        for slot in SLOTS:
            if slot in occupied:
                print(f"  {slot}: {occupied[slot]}")
    else:
        print("  Ingen belagte spor/sloter registrert.")
    print()

    print("Produksjonsmål:")
    for goal in snapshot.get("production_goals", []):
        print(
            f"  Tog {goal.get('display_train', goal.get('train'))}: "
            f"{', '.join(goal.get('preferred_slots', []))} "
            f"({goal.get('position', '-')})"
        )
    print()

    print("Turnering kveld:")
    for row in snapshot.get("turnering_kveld", []):
        print(
            f"  {row.get('time', '-')}: tog {row.get('from_train', '-')} "
            f"kjøretøy {', '.join(row.get('vehicles', []))}"
        )
    print()

    workshop = snapshot.get("workshop", {})
    if workshop:
        print("Verksted:")
        for slot, info in workshop.get("positions", {}).items():
            print(
                f"  {slot}: "
                f"{info.get('vehicle') or '-'} "
                f"status={info.get('status', '-')} "
                f"SDE-styrbar={'ja' if info.get('controllable_by_sde') else 'nei'}"
            )

        ready_to_leave = workshop.get("ready_to_leave", [])
        needs_repair = workshop.get("needs_repair", [])
        print(f"  Ferdig fra verksted: {', '.join(ready_to_leave) if ready_to_leave else '-'}")
        print(f"  Skal inn til verksted: {', '.join(needs_repair) if needs_repair else '-'}")
        print()

    empty_fill = snapshot.get("empty_fill", {})
    if empty_fill:
        print("Tømming/fylling:")
        print(f"  Målspor: {empty_fill.get('target_slot', '-')}")
        for item in empty_fill.get("vehicles", []):
            print(
                f"  {item.get('vehicle', '-')}: "
                f"nå={item.get('current_slot', '-')} "
                f"status={item.get('status', '-')} "
                f"prioritet={item.get('priority', '-')} "
                f"grunn={item.get('reason', '-')}"
            )
        print()

    reverse_ops = snapshot.get("reverse_coupling_splitting", {})
    if reverse_ops:
        print("Omvendt skjøting/deling:")
        print(f"  Aktivert: {'ja' if reverse_ops.get('enabled') else 'nei'}")
        print(f"  Delingsspor: {', '.join(reverse_ops.get('split_tracks', [])) or '-'}")
        print(f"  Midlertidige fradelingsspor: {', '.join(reverse_ops.get('temporary_split_slots', [])) or '-'}")
        print(f"  Nordlige skjøtespor: {', '.join(reverse_ops.get('north_coupling_slots', [])) or '-'}")
        print(f"  Ankomst fra sørenden tillatt: {'ja' if reverse_ops.get('south_arrival_allowed') else 'nei'}")

        rules = reverse_ops.get("rules", [])
        if rules:
            print("  Regler:")
            for rule in rules:
                print(f"    - {rule}")

        active_operations = reverse_ops.get("active_operations", [])
        print(f"  Aktive operasjoner: {len(active_operations)}")
        print()

    print("Manuelle input:")
    for item in snapshot.get("manual_inputs", []):
        needs = list(item.get("needs", []))

        # Bakoverkompatibilitet med første snapshot-versjon.
        if item.get("need"):
            needs.append(item.get("need"))

        needs_text = ", ".join(needs) if needs else "-"

        print(
            f"  {item.get('vehicle', '-')}: "
            f"{needs_text} "
            f"nå={item.get('current_slot', '-')} "
            f"ønsket={item.get('preferred_slot', '-')} "
            f"prioritet={item.get('priority', '-')} "
            f"grunn={item.get('reason', '-')}"
        )
    print()

    if warnings:
        print("Advarsler:")
        for warning in warnings:
            print(f"  - {warning}")
        print()

    if errors:
        print("Feil:")
        for error in errors:
            print(f"  - {error}")
        raise SystemExit(1)

    print("Status: Snapshot er gyldig nok for videre SDE-testing.")


if __name__ == "__main__":
    snapshot = load_snapshot()
    print_snapshot_report(snapshot)
