from dataclasses import dataclass, field
from copy import deepcopy
from typing import Dict, List, Optional, Tuple


SLOTS = [
    "1S", "1N",
    "2S", "2N",
    "3S", "3M", "3N",
    "4S", "4M", "4N",
    "5S", "5M", "5N",
    "6SS", "6S", "6N",
    "7SS", "7S", "7N",
    "8SS", "8S", "8N",
    "9",
    "10S", "10N",
    "11S", "11N",
    "12S", "12N",
]


@dataclass
class Vehicle:
    number: str
    role: str
    needs: List[str] = field(default_factory=list)
    target_train: Optional[str] = None


@dataclass
class Move:
    vehicle: str
    from_slot: str
    to_slot: str
    time: str
    reason: str
    score: int
    warnings: List[str] = field(default_factory=list)


@dataclass
class Scenario:
    status: Dict[str, Optional[str]]
    vehicles: Dict[str, Vehicle]
    moves: List[Move] = field(default_factory=list)
    score: int = 0
    warnings: List[str] = field(default_factory=list)


def initial_test_status() -> Dict[str, Optional[str]]:
    status = {slot: None for slot in SLOTS}

    status["4S"] = "74-31"
    status["6S"] = "74-40"
    status["9"] = "74-32"
    status["3S"] = "74-20"
    status["3M"] = "74-04"

    # Test for produksjonsrekkefølge 862/864
    status["5N"] = "74-62"
    status["5M"] = "74-64"

    # Verkstedplasser. Disse skal normalt være besatt og styres ikke direkte av SDE.
    status["7N"] = "74-77"
    status["8N"] = "74-88"

    return status


def initial_test_vehicles() -> Dict[str, Vehicle]:
    return {
        "74-31": Vehicle("74-31", role="arrival", needs=["empty_fill"]),
        "74-40": Vehicle("74-40", role="blocks_flow", needs=["park"]),
        "74-32": Vehicle("74-32", role="arrival", needs=["park"]),
        "74-62": Vehicle("74-62", role="morning_production", needs=["production_pair"], target_train="862"),
        "74-64": Vehicle("74-64", role="morning_production", needs=["production_pair"], target_train="864"),
        # 74-77 og 74-88 står i verksted og skal ikke inngå som flyttbare SDE-kandidater her.
        "74-20": Vehicle("74-20", role="morning_production", target_train="802"),
        "74-04": Vehicle("74-04", role="morning_production", target_train="852"),
    }


def slot_is_free(status: Dict[str, Optional[str]], slot: str) -> bool:
    return status.get(slot) is None


def find_vehicle_slot(status: Dict[str, Optional[str]], vehicle: str) -> Optional[str]:
    for slot, placed_vehicle in status.items():
        if placed_vehicle == vehicle:
            return slot
    return None


def blocks_6ss_connection(status: Dict[str, Optional[str]]) -> bool:
    return status.get("6SS") is not None


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
    # Produksjonsregel:
    # 862 settes normalt i 11N eller 12N.
    # 864 settes normalt bak 862 i samme spor, slik at 862 + 864 fyller ett spor.
    # Eksempel: 862 -> 11N og 864 -> 11S, alternativt 862 -> 12N og 864 -> 12S.
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

    if "empty_fill" in vehicle.needs and to_slot == "6N":
        score += 300
        reason_parts.append("tømming/fylling via nord")

    if from_slot == "6S" and to_slot.startswith("11"):
        score += 220
        reason_parts.append("frigjør spor 6 for videre flyt")

    production_slots = ["11S", "11N", "12S", "12N"]
    has_862_864_need = any(
        v.target_train in ["862", "864"]
        for v in vehicles.values()
    )

    if "park" in vehicle.needs and to_slot in ["10S", "10N", "11S", "11N", "12S", "12N"]:
        score += 160
        reason_parts.append("parkering uten å blokkere produksjon")

    if "park" in vehicle.needs and has_862_864_need and to_slot in production_slots:
        score -= 260
        warnings.append("Vanlig parkering bør ikke ta 11/12 når 862/864-produksjon må settes opp.")
        reason_parts.append("straff: tar produksjonsspor for 862/864")

    if vehicle.target_train == "862" and to_slot in ["11N", "12N"]:
        score += 420
        reason_parts.append("862 prioritert fremst i 11N/12N")

    if vehicle.target_train == "864":
        if to_slot == "11S" and status.get("11N") is not None:
            score += 520
            reason_parts.append("864 plasseres bak kjøretøy i 11N")
        elif to_slot == "12S" and status.get("12N") is not None:
            score += 520
            reason_parts.append("864 plasseres bak kjøretøy i 12N")
        elif to_slot in ["11S", "12S"]:
            score += 120
            reason_parts.append("864 kan bruke 11S/12S, men bør helst følge 862 i samme spor")

    if to_slot == "6SS":
        score -= 500
        warnings.append("Kjøretøy i 6SS blokkerer forbindelsen fra 7SS/8SS mot spor 1–3.")
        reason_parts.append("straff: blokkerer 6SS")

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
        if vehicle_number in already_moved:
            continue

        from_slot = find_vehicle_slot(scenario.status, vehicle_number)
        if not from_slot:
            continue

        for to_slot in preferred_targets:
            if to_slot == from_slot:
                continue
            if not slot_is_free(scenario.status, to_slot):
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


def search_best_plan(max_depth: int = 3) -> Scenario:
    start = Scenario(
        status=initial_test_status(),
        vehicles=initial_test_vehicles(),
    )

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
    print(f"- Blokkering av 6SS: {'ja' if blocks_6ss_connection(plan.status) else 'nei'}")
    workshop_occupied = workshop_positions_occupied(plan.status)
    workshop_route_problem = blocks_6ss_connection(plan.status) and workshop_route_limited(plan.status)
    print(f"- Verkstedplass 7N/8N opptatt: {'ja' if workshop_occupied else 'nei'}")
    print(f"- Begge verkstedveier 7N/8N blokkert: {'ja' if workshop_route_limited(plan.status) else 'nei'}")
    print(f"- Ruteproblem via verksted: {'ja' if workshop_route_problem else 'nei'}")
    print(f"- Score: {plan.score}")

    if plan.warnings:
        print()
        print("Advarsler i planen:")
        for warning in plan.warnings:
            print(f"- {warning}")

    print()
    print("Sluttstatus Sporplan:")
    print_status(plan.status)


def print_first_step_candidates(limit: int = 12) -> None:
    scenario = Scenario(
        status=initial_test_status(),
        vehicles=initial_test_vehicles(),
    )

    candidates = generate_candidate_moves(scenario, step=0)

    print("=== Første vurderte trekk ===")
    for index, move in enumerate(candidates[:limit], start=1):
        print(f"{index}. {move.vehicle}: {move.from_slot} -> {move.to_slot} | score {move.score} | {move.reason}")
        if move.warnings:
            for warning in move.warnings:
                print(f"   Advarsel: {warning}")
    print()


if __name__ == "__main__":
    print_first_step_candidates()
    best_plan = search_best_plan(max_depth=4)
    print_plan(best_plan)
