import json
from pathlib import Path

from sde_models import SLOTS, Vehicle, Scenario


SNAPSHOT_PATH = Path("sde_input_snapshot.json")


def load_snapshot(path=SNAPSHOT_PATH):
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def snapshot_to_scenario(snapshot):
    """
    Gjør manuell SDE snapshot-data om til et Scenario-objekt.

    Denne versjonen følger dagens faktiske sde_models.py:
    - Vehicle(number, role, needs, target_train)
    - Scenario(status, vehicles)
    - Nåværende plassering ligger i scenario.status, ikke i Vehicle.
    """

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

    errors, warnings, occupied = validate_sporplan_status(snapshot)

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
