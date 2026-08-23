# SDE canonical shift search boundary V1

Contract id: `SDE-SHIFT-SEARCH-BOUNDARY-20260822-V1`

This contract was fixed on 22 August 2026 before the first Phase A production-code change. Its machine-readable authority is `config/sde-shift-search-boundary-v1.json`.

## Fixed boundary

| Field | Locked value |
| --- | ---: |
| `MAX_SEARCHED_STATES` | 250,000 |
| `MAX_WALL_CLOCK_MS` | 1,800 |
| `MAX_CONNECTED_VEHICLES` | 16 |
| `MAX_CONNECTED_SLOTS` | 31 |
| `MAX_PLAN_STEPS_IF_A_HARD_LIMIT_IS_USED` | no hard step limit |
| `MAX_BRANCHING_FACTOR` | 31 |

The state and wall-clock limits terminate a search; plan length is not separately capped. The branch limit matches the complete canonical Skien slot register. An expansion selects the next unresolved obligation or physical blocker and may assess every slot, rather than generating arbitrary moves for every vehicle.

`SEARCH_LIMIT_REACHED` is a first-class result and must never be translated to `NO_SAFE_PLAN`.

## Evidence used to choose the values

- The current canonical slot register contains 31 entries, including contextual `VN` and route-resource-only `VS`.
- Existing recursive physical fixtures demonstrate up to five ordered moves and expose the cost of repeatedly parsing the monolithic `index.html`.
- The representative production boundary is 16 connected vehicles, the full 31-slot catalog and eight active intents with exactly one active replan.
- The bounded exhaustive oracle is intentionally smaller: eight vehicles, twelve slots, four intents and an optimum of at most eight moves. Claims of minimum move count are limited to this finite domain.
- The locked host is an Apple M4 (`arm64`, 10 physical CPU cores, 16 GiB RAM), using Node `v26.3.1` and npm `11.16.0`.

Measured legacy harness wall times on this host were 2.76 seconds for the butt-track/VN matrix, 6.89 seconds for the trapped-egress matrix, and 0.08 seconds for direct graphic-drag ordering. Those figures include loading and evaluating the full page and are not accepted as planner performance. They establish why Phase A uses an isolated pure planner and a separate projection adapter.

## Performance claim scope

The `p95 <= 2,000 ms` requirement applies only to the versioned representative fixtures, this hardware/runtime profile, the fixed boundary and one active replan. Each fixture receives five warmups and forty recorded samples. No claim is made for arbitrary future states.

## Change control

This contract is immutable for Phase A. A later change requires a new version, an explicit justification, rerunning all exhaustive-oracle and performance fixtures, and prominent disclosure in merge readiness evidence. It must never be tuned merely to make a failing fixture pass.
