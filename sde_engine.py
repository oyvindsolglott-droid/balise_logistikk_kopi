from copy import deepcopy
from typing import Dict, List, Optional, Tuple

from sde_models import SLOTS, Move, Scenario, Vehicle
from sde_scenarios import initial_test_status, initial_test_vehicles



def slot_is_free(status: Dict[str, Optional[str]], slot: str) -> bool:
    return status.get(slot) is None


def find_vehicle_slot(status: Dict[str, Optional[str]], vehicle: str) -> Optional[str]:
    for slot, placed_vehicle in status.items():
        if placed_vehicle == vehicle:
            return slot
    return None


SS_ROUTE_BLOCKERS = {"6SS", "7SS", "8SS"}
SS_ROUTE_AFFECTED_FROM_SOUTH = {"4S", "5S", "6SS", "7SS", "8SS"}

NORTH_ROUTE_PATHS = {
    "4S": {
        "4M": ["4M"],
        "4N": ["4M", "4N"],
    },
    "5S": {
        "5M": ["5M"],
        "5N": ["5M", "5N"],
    },
    "6SS": {
        "6S": ["6S"],
        "6N": ["6S", "6N"],
    },
    "7SS": {
        "7S": ["7S"],
        "7N": ["7S", "7N"],
    },
    "8SS": {
        "8S": ["8S"],
        "8N": ["8S", "8N"],
    },
}


def occupied_ss_route_blockers(status: Dict[str, Optional[str]]) -> set:
    return {slot for slot in SS_ROUTE_BLOCKERS if status.get(slot) is not None}


def blocks_6ss_connection(status: Dict[str, Optional[str]]) -> bool:
    # Bakoverkompatibelt navn: betyr nå blokkering fra 6SS/7SS/8SS.
    return bool(occupied_ss_route_blockers(status))


def south_bridge_route_blocked_from(status: Dict[str, Optional[str]], from_slot: str) -> bool:
    blockers = occupied_ss_route_blockers(status)
    if not blockers:
        return False

    if from_slot in {"4S", "5S"}:
        return True

    # Hvis ett SS-spor er belagt, blokkeres syd-/bro-ruten fra de andre SS-sporene.
    if from_slot in SS_ROUTE_BLOCKERS and from_slot not in blockers:
        return True

    # Kjøretøyet som faktisk står i SS-sporet kan ikke regnes som fri syd-/bro-rute.
    if from_slot in blockers:
        return True

    return False


def north_route_available(status: Dict[str, Optional[str]], from_slot: str, to_slot: str) -> bool:
    paths_from_slot = NORTH_ROUTE_PATHS.get(from_slot, {})
    path = paths_from_slot.get(to_slot)

    if not path:
        return False

    return all(status.get(slot) is None for slot in path)


def final_slot_after_service(vehicle: Vehicle) -> Optional[str]:
    prefix = "final_slot_after_service:"
    for need in vehicle.needs:
        if need.startswith(prefix):
            return need.split(":", 1)[1]
    return None


def should_allow_second_move_after_service(scenario: Scenario, vehicle_number: str) -> bool:
    vehicle = scenario.vehicles.get(vehicle_number)
    if not vehicle:
        return False

    final_slot = final_slot_after_service(vehicle)
    if not final_slot:
        return False

    current_slot = find_vehicle_slot(scenario.status, vehicle_number)
    if current_slot != "6N":
        return False

    return slot_is_free(scenario.status, final_slot)


# Spor 9, 10, 11 og 12 er buttspor.
# Det finnes ingen utkjøring mot sør; eneste vei ut er mot vaskemaskinen.
#
# Spor 10, 11 og 12 har S/N-posisjoner og derfor egen rekkefølgeregel:
# - S er innerst i buttsporet.
# - N er utkjøringsside mot vaskemaskinen.
# - Ved innkjøring må S fylles før N hvis begge posisjoner skal brukes; noe annet er ikke mulig.
# - Ved utkjøring må N normalt ut før S.
#
# Spor 9 er også buttspor, men modelleres foreløpig som én slot ("9"),
# og skal derfor ikke inn i S-før-N-regelen.
# Foreløpig håndheves innkjøringsregelen i move-generering.
S_BEFORE_N_TRACKS = {"10", "11", "12"}


def planned_target_slots_for_vehicle(vehicle: Vehicle) -> set:
    targets = set()
    for need in vehicle.needs:
        if need.startswith("preferred_slot:"):
            targets.add(need.split(":", 1)[1])
        if need.startswith("final_slot_after_service:"):
            targets.add(need.split(":", 1)[1])
    return targets


def blocks_inbound_n_before_planned_s_in_track_10_12(
    scenario: Scenario,
    vehicle_number: str,
    to_slot: str
) -> bool:
    if to_slot not in {"10N", "11N", "12N"}:
        return False

    track = to_slot[:-1]
    if track not in S_BEFORE_N_TRACKS:
        return False

    s_slot = f"{track}S"

    # Hvis S allerede er fylt, kan N fylles.
    if scenario.status.get(s_slot):
        return False

    # Innkjøring: Hvis et annet kjent kjøretøy er planlagt til S,
    # må S-kjøretøyet inn før N-kjøretøyet sperrer adkomsten.
    for other_number, other_vehicle in scenario.vehicles.items():
        if other_number == vehicle_number:
            continue

        if s_slot not in planned_target_slots_for_vehicle(other_vehicle):
            continue

        other_current_slot = find_vehicle_slot(scenario.status, other_number)

        # Bare blokkér hvis kjøretøyet faktisk finnes i nåstatus.
        # Hvis kjøretøyet ikke er kjent ennå, skal ikke planen låses.
        if other_current_slot and other_current_slot != s_slot:
            return True

    return False


def track_availability_for_scenario(scenario: Scenario) -> dict:
    return getattr(scenario, "track_availability", {}) or {}


def out_of_service_slots_for_scenario(scenario: Scenario) -> set:
    availability = track_availability_for_scenario(scenario)
    return set(availability.get("out_of_service_slots", []) or [])


def vehicle_has_explicit_out_of_service_task(vehicle: Vehicle) -> bool:
    explicit_needs = {
        "explicit_out_of_service_task",
        "avvik_uvirksomt_spor",
        "allow_out_of_service_move",
    }
    return any(need in explicit_needs for need in vehicle.needs)


def explicit_final_target_slot(vehicle: Vehicle) -> Optional[str]:
    # Sluttmål etter service teller som endelig mål.
    final_after_service = final_slot_after_service(vehicle)
    if final_after_service:
        return final_after_service

    # Preferred slot kan være sluttmål, men 6N ved tømming/fylling er et mellomsteg.
    for need in vehicle.needs:
        if not need.startswith("preferred_slot:"):
            continue

        slot = need.split(":", 1)[1]

        if slot == "6N" and "tømming_fylling" in vehicle.needs:
            continue

        return slot

    return None


def blocks_other_vehicle_final_target(
    scenario: Scenario,
    vehicle_number: str,
    to_slot: str
) -> bool:
    # Et sluttmål fra Togplassering skal ikke brukes av andre kjøretøy.
    for other_number, other_vehicle in scenario.vehicles.items():
        if other_number == vehicle_number:
            continue

        if explicit_final_target_slot(other_vehicle) == to_slot:
            return True

    return False


def blocks_wrong_final_target_for_vehicle(
    vehicle: Vehicle,
    to_slot: str
) -> bool:
    # Hvis kjøretøyet har et eksplisitt sluttmål, skal det ikke velge et annet
    # slutt-/hensettingsspor bare fordi scoringen liker det bedre.
    target = explicit_final_target_slot(vehicle)
    if not target:
        return False

    if to_slot == target:
        return False

    # Service først er fortsatt lov.
    if to_slot == "6N" and "tømming_fylling" in vehicle.needs:
        return False

    return True


def blocks_out_of_service_move(
    scenario: Scenario,
    vehicle: Vehicle,
    from_slot: str,
    to_slot: str
) -> bool:
    availability = track_availability_for_scenario(scenario)
    out_of_service_slots = out_of_service_slots_for_scenario(scenario)

    if not out_of_service_slots:
        return False

    allow_new_moves_in = availability.get("allow_new_moves_into_out_of_service", False)
    allow_moves_out = availability.get("allow_moves_out_without_explicit_task", False)

    # Uvirksomme spor kan vises i Sporplan som nåstatus,
    # men skal ikke brukes som nye målspor.
    if to_slot in out_of_service_slots and not allow_new_moves_in:
        return True

    # Vanlig flytting ut fra uvirksomt spor er ikke tillatt.
    # Det krever eksplisitt avvik/egen oppgave.
    if from_slot in out_of_service_slots and not allow_moves_out:
        return not vehicle_has_explicit_out_of_service_task(vehicle)

    return False


def workshop_positions_occupied(status: Dict[str, Optional[str]]) -> bool:
    # 7N og 8N er verkstedplasser, ikke vanlige spor SDE skal styre.
    # De bør normalt være besatt av kjøretøy som skal repareres.
    return status.get("7N") is not None or status.get("8N") is not None


def workshop_route_limited(status: Dict[str, Optional[str]]) -> bool:
    # Rute via verksted er først reelt begrenset når både 7N og 8N er opptatt.
    # Hvis enten 7N eller 8N er ledig, kan kjøretøy i 7S/8S fortsatt skifte
    # rett inn i vaskemaskinen og videre inn i nordlige spor.
    return status.get("7N") is not None and status.get("8N") is not None


def score_move(status: Dict[str, Optional[str]], vehicles: Dict[str, Vehicle], vehicle: Vehicle, from_slot: str, to_slot: str, step: int) -> Tuple[int, str, List[str]]:
    # Produksjons-/flytregel:
    # 862 settes ofte i 11N eller 12N, men må ikke bli sperret inne.
    # 864 bak 862 i samme spor er en myk preferanse, ikke et absolutt krav.
    # Viktigste regel: 862 må kunne skiftes til vaskemaskin og tilbake til spor 2 eller 3
    # uten å bli blokkert av 864, 806, 856 eller 808.
    score = 100
    warnings = []
    reason_parts = []

    is_operational_flow = (
        "wash_flow" in vehicle.needs
        or "morning_production" in vehicle.needs
        or vehicle.target_train is not None
    )

    low_traffic_or_disruption = True  # Testscenario: kveld/lav trafikk/brudd kan senere komme fra ekte input.

    if to_slot in ["1S", "1N"]:
        if low_traffic_or_disruption:
            score += 60
            reason_parts.append("spor 1 kan brukes som hensettingsspor ved lav trafikk/brudd")
        else:
            score -= 80
            warnings.append("Spor 1 bør ikke brukes til hensetting når togtrafikken er normal.")
            reason_parts.append("svak straff: spor 1 under normal trafikk")

    if to_slot in ["2S", "2N"]:
        if is_operational_flow:
            score -= 80
            reason_parts.append("spor 2 akseptert kun som del av tog-/vask-/produksjonsflyt")
        else:
            score -= 1000
            warnings.append("Spor 2 er plattformspor og skal ikke brukes til vanlig parkering på dagtid.")
            reason_parts.append("avvist/sterkt straffet: vanlig parkering i spor 2")

    if to_slot in ["3S", "3M", "3N"]:
        if is_operational_flow:
            score += 40
            reason_parts.append("spor 3 akseptert som del av tog-/produksjonsflyt")
        else:
            score -= 350
            warnings.append("Spor 3 er plattformspor og skal ikke brukes til vanlig parkering på dagtid.")
            reason_parts.append("straff: vanlig parkering i spor 3")

    preferred_slot_need = f"preferred_slot:{to_slot}"
    is_parking_need = "park" in vehicle.needs or "parkering" in vehicle.needs
    is_empty_fill_need = "empty_fill" in vehicle.needs or "tømming_fylling" in vehicle.needs

    if preferred_slot_need in vehicle.needs:
        score += 360
        reason_parts.append(f"manuelt ønsket målspor {to_slot}")

    if is_empty_fill_need and to_slot == "6N":
        score += 300
        reason_parts.append("tømming/fylling via nord")

    final_service_slot = final_slot_after_service(vehicle)
    if from_slot == "6N" and final_service_slot and to_slot == final_service_slot:
        score += 720
        reason_parts.append(f"videre fra tømming/fylling til sluttmål {to_slot}")

    if from_slot == "6S" and to_slot.startswith("11"):
        score += 220
        reason_parts.append("frigjør spor 6 for videre flyt")

    production_slots = ["11S", "11N", "12S", "12N"]
    has_862_864_need = any(
        v.target_train in ["862", "90862", "864", "90864"]
        for v in vehicles.values()
    )

    if is_parking_need and to_slot in ["10S", "10N", "11S", "11N", "12S", "12N"]:
        score += 160
        reason_parts.append("parkering uten å blokkere produksjon")

    if is_parking_need and has_862_864_need and to_slot in production_slots:
        score -= 260
        warnings.append("Vanlig parkering bør ikke ta 11/12 når 862/864-produksjon må settes opp.")
        reason_parts.append("straff: tar produksjonsspor for 862/864")

    if vehicle.target_train in ["862", "90862"] and to_slot in ["11N", "12N"]:
        score += 420
        reason_parts.append("862/90862 prioritert fremst i 11N/12N")

    if vehicle.target_train in ["864", "90864"]:
        if to_slot == "11S" and status.get("11N") is not None:
            score += 140
            reason_parts.append("864 står praktisk bak annet kjøretøy i 11N, men dette er kun myk preferanse")
        elif to_slot == "12S" and status.get("12N") is not None:
            score += 140
            reason_parts.append("864 står praktisk bak annet kjøretøy i 12N, men dette er kun myk preferanse")
        elif to_slot in ["11S", "12S"]:
            score += 120
            reason_parts.append("864 kan bruke 11S/12S; plassering bak 862 er ønskelig, men ikke et krav")

    if to_slot in SS_ROUTE_BLOCKERS:
        score -= 500
        warnings.append("Kjøretøy i 6SS/7SS/8SS blokkerer syd-/bro-rute fra 4S, 5S og berørte SS-spor.")
        reason_parts.append("straff: SS-spor blokkerer syd-/bro-rute")

    simulated = deepcopy(status)
    simulated[from_slot] = None
    simulated[to_slot] = vehicle.number

    if blocks_6ss_connection(simulated) and workshop_route_limited(simulated):
        score -= 400
        warnings.append("6SS er blokkert samtidig som verkstedveien via 7N/8N er begrenset.")
        reason_parts.append("straff: begrenset alternativ verkstedvei")

    if to_slot in ["7N", "8N"] and blocks_6ss_connection(status):
        score -= 300
        warnings.append("7N/8N er verkstedplasser og bør ikke brukes som vanlige skiftemål.")
        reason_parts.append("straff: forsøker å bruke verkstedplass som skiftemål")

    score -= step * 15

    if not reason_parts:
        reason_parts.append("generell forbedring av plassering")

    return score, ", ".join(reason_parts), warnings


def generate_candidate_moves(scenario: Scenario, step: int) -> List[Move]:
    candidates = []

    already_moved = {move.vehicle for move in scenario.moves}

    preferred_targets = [
        "6N",

        # Målrettet sør-/produksjonsflyt. Skal ikke brukes som vanlig parkering.
        "1S", "2S", "3S",

        # Vanlige parkerings-/hensettingsspor.
        "11S", "11N",
        "10N", "10S",
        "12N", "12S",
        "5N", "5M", "5S",
        "4N", "4M", "4S",
    ]

    for vehicle_number, vehicle in scenario.vehicles.items():
        if vehicle_number in already_moved and not should_allow_second_move_after_service(scenario, vehicle_number):
            continue

        # Ikke flytt kjøretøy bare fordi de finnes i Sporplan eller Turnering Kveld/Natt.
        # SDE skal bare vurdere kjøretøy som faktisk har et operativt behov,
        # produksjonsmål eller eksplisitt manuell håndtering.
        passive_roles = {"står_i_sporplan", "turnering_kveld", "turnering_natt"}
        if vehicle.role in passive_roles and not vehicle.needs and vehicle.target_train is None:
            continue

        from_slot = find_vehicle_slot(scenario.status, vehicle_number)
        if not from_slot:
            continue

        dynamic_targets = list(preferred_targets)
        final_service_slot = final_slot_after_service(vehicle)
        if from_slot == "6N" and final_service_slot:
            dynamic_targets = [final_service_slot] + [slot for slot in dynamic_targets if slot != final_service_slot]

        for to_slot in dynamic_targets:
            if to_slot == from_slot:
                continue
            if not slot_is_free(scenario.status, to_slot):
                continue

            if blocks_out_of_service_move(scenario, vehicle, from_slot, to_slot):
                continue

            if blocks_other_vehicle_final_target(scenario, vehicle_number, to_slot):
                continue

            if blocks_wrong_final_target_for_vehicle(vehicle, to_slot):
                continue

            if blocks_inbound_n_before_planned_s_in_track_10_12(scenario, vehicle_number, to_slot):
                continue

            if south_bridge_route_blocked_from(scenario.status, from_slot):
                if not north_route_available(scenario.status, from_slot, to_slot):
                    continue

            score, reason, warnings = score_move(
                scenario.status,
                scenario.vehicles,
                vehicle,
                from_slot,
                to_slot,
                step,
            )

            if score <= 0:
                continue

            candidates.append(
                Move(
                    vehicle=vehicle_number,
                    from_slot=from_slot,
                    to_slot=to_slot,
                    time=minute_to_time(21 * 60 + 12 + step * 13),
                    reason=reason,
                    score=score,
                    warnings=warnings,
                )
            )

    candidates.sort(key=lambda move: move.score, reverse=True)
    return candidates[:8]


def apply_move(scenario: Scenario, move: Move) -> Scenario:
    new_scenario = deepcopy(scenario)
    new_scenario.status[move.from_slot] = None
    new_scenario.status[move.to_slot] = move.vehicle
    new_scenario.moves.append(move)
    new_scenario.score += move.score

    for warning in move.warnings:
        if warning not in new_scenario.warnings:
            new_scenario.warnings.append(warning)

    return new_scenario


def search_best_plan_for_scenario(start: Scenario, max_depth: int = 3) -> Scenario:
    scenarios = [start]

    for step in range(max_depth):
        next_scenarios = []

        for scenario in scenarios:
            moves = generate_candidate_moves(scenario, step)

            for move in moves:
                next_scenarios.append(apply_move(scenario, move))

        if not next_scenarios:
            break

        next_scenarios.sort(
            key=lambda s: (
                s.score,
                -len(s.moves),
                not blocks_6ss_connection(s.status),
                not workshop_route_limited(s.status),
            ),
            reverse=True,
        )

        scenarios = next_scenarios[:20]

    scenarios.sort(key=lambda s: (s.score, -len(s.moves)), reverse=True)
    return scenarios[0]


def search_best_plan(max_depth: int = 3) -> Scenario:
    start = Scenario(
        status=initial_test_status(),
        vehicles=initial_test_vehicles(),
    )

    return search_best_plan_for_scenario(start, max_depth=max_depth)


def minute_to_time(minutes: int) -> str:
    hour = minutes // 60
    minute = minutes % 60
    return f"{hour:02d}:{minute:02d}"


def print_status(status: Dict[str, Optional[str]]) -> None:
    for slot in SLOTS:
        value = status.get(slot) or "-"
        print(f"{slot:>4}: {value}")


def print_plan(plan: Scenario) -> None:
    print("=== SDE anbefalt handlingsplan ===")

    if not plan.moves:
        print("Ingen anbefalte trekk funnet.")
        return

    for index, move in enumerate(plan.moves, start=1):
        print(f"{index}. {move.time} Flytt {move.vehicle} fra {move.from_slot} til {move.to_slot}")
        print(f"   Begrunnelse: {move.reason}")
        print(f"   Score: {move.score}")
        if move.warnings:
            print("   Advarsler:")
            for warning in move.warnings:
                print(f"   - {warning}")
        print()

    uses_track_2 = any(move.to_slot in ["2S", "2N"] for move in plan.moves)
    uses_track_3 = any(move.to_slot in ["3S", "3M", "3N"] for move in plan.moves)

    print("Samlet vurdering:")
    print(f"- Antall trekk: {len(plan.moves)}")
    print(f"- Bruk av spor 2: {'ja' if uses_track_2 else 'nei'}")
    print(f"- Bruk av spor 3 før 21:10: {'ja' if uses_track_3 else 'nei'}")
    print(f"- Blokkering av SS-rute 6SS/7SS/8SS: {'ja' if blocks_6ss_connection(plan.status) else 'nei'}")
    workshop_occupied = workshop_positions_occupied(plan.status)
    ss_blockers = sorted(occupied_ss_route_blockers(plan.status))
    south_bridge_limited = bool(ss_blockers)
    print(f"- Verkstedplass 7N/8N opptatt: {'ja' if workshop_occupied else 'nei'}")
    print(f"- Begge verkstedveier 7N/8N opptatt: {'ja' if workshop_route_limited(plan.status) else 'nei'}")
    print(f"- SS-spor som blokkerer syd-/bro-rute: {', '.join(ss_blockers) if ss_blockers else '-'}")
    print(f"- Syd-/bro-rute fra 4S/5S og berørte SS-spor blokkert: {'ja' if south_bridge_limited else 'nei'}")
    print("- Nordlig skifting fra berørte spor vurderes separat mot frie nordlige slotter")
    print(f"- Score: {plan.score}")

    if plan.warnings:
        print()
        print("Advarsler i planen:")
        for warning in plan.warnings:
            print(f"- {warning}")

    print()
    print("Sluttstatus Sporplan:")
    print_status(plan.status)


def print_first_step_candidates_for_scenario(scenario: Scenario, limit: int = 12) -> None:
    candidates = generate_candidate_moves(scenario, step=0)

    print("=== Første vurderte trekk ===")
    for index, move in enumerate(candidates[:limit], start=1):
        print(f"{index}. {move.vehicle}: {move.from_slot} -> {move.to_slot} | score {move.score} | {move.reason}")
        if move.warnings:
            for warning in move.warnings:
                print(f"   Advarsel: {warning}")
    print()


def print_first_step_candidates(limit: int = 12) -> None:
    scenario = Scenario(
        status=initial_test_status(),
        vehicles=initial_test_vehicles(),
    )

    print_first_step_candidates_for_scenario(scenario, limit=limit)


if __name__ == "__main__":
    print_first_step_candidates()
    best_plan = search_best_plan(max_depth=4)
    print_plan(best_plan)
