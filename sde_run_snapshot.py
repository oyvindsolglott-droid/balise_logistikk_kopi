from sde_engine import (
    print_first_step_candidates_for_scenario,
    print_plan,
    search_best_plan_for_scenario,
)
from sde_input_loader import load_snapshot, snapshot_to_scenario


def main():
    snapshot = load_snapshot()
    scenario = snapshot_to_scenario(snapshot)

    print("=== SDE snapshot-kjøring ===")
    print(f"Snapshot: {snapshot.get('snapshot_name', '-')}")
    print(f"Dato: {snapshot.get('date', '-')}")
    print()

    print_first_step_candidates_for_scenario(scenario)
    best_plan = search_best_plan_for_scenario(scenario, max_depth=4)
    print_plan(best_plan)


if __name__ == "__main__":
    main()
