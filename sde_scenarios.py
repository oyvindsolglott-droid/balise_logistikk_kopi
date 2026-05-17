from typing import Dict, Optional

from sde_models import SLOTS, Vehicle


def initial_test_status() -> Dict[str, Optional[str]]:
    status = {slot: None for slot in SLOTS}

    status["4S"] = "74-31"
    status["6S"] = "74-40"
    status["9"] = "74-32"
    status["3S"] = "74-20"
    status["3M"] = "74-04"

    # Test for produksjonsrekkefølge 862/864
    status["5N"] = "74-71"
    status["5M"] = "74-72"

    # Verkstedplasser. Disse skal normalt være besatt og styres ikke direkte av SDE.
    status["7N"] = "74-77"
    status["8N"] = "74-88"

    return status


def initial_test_vehicles() -> Dict[str, Vehicle]:
    return {
        "74-31": Vehicle("74-31", role="arrival", needs=["empty_fill"]),
        "74-40": Vehicle("74-40", role="blocks_flow", needs=["park"]),
        "74-32": Vehicle("74-32", role="arrival", needs=["park"]),
        # Nøytrale kjøretøynummer: regelen skal følge target_train, ikke kjøretøynummer.
        "74-71": Vehicle("74-71", role="morning_production", needs=["production_pair"], target_train="90862"),
        "74-72": Vehicle("74-72", role="morning_production", needs=["production_pair"], target_train="90864"),
        # 74-77 og 74-88 står i verksted og skal ikke inngå som flyttbare SDE-kandidater her.
        "74-20": Vehicle("74-20", role="morning_production", target_train="802"),
        "74-04": Vehicle("74-04", role="morning_production", target_train="852"),
    }
