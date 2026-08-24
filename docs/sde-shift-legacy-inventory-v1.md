# SDE shift legacy inventory v1

Contract id: `SDE-SHIFT-LEGACY-INVENTORY-20260822-V1`

Baseline commit: `acf02a455cff4ba6275ac0ab388a138d05b47f5a`

This inventory freezes the pre-migration planning and projection surface before
the unified canonical shift engine is allowed to replace product writes.  It is
evidence for the rollback drill and is not an alternative planning contract.

## Existing candidate producers

| Producer | Current entry point | Current output/state | Migration rule |
| --- | --- | --- | --- |
| Manual graphic drag | `applySdeNightPlacementDragOverride` | `state.sdeNightPlacementManualOverrides`, shadow authorities, candidate rows | Convert the accepted drag to one `ShiftIntent`; the unified engine owns every derived step. |
| Manual plan | `buildSdeNightPlacementManualPlanMoves` | legacy candidate rows | Convert the plan order to `ShiftIntent`; no direct card materialization. |
| Drag override rows | `buildSdeNightPlacementDragOverrideMoves` | legacy candidate rows | Compatibility reader only after migration. |
| Tursatt post-arrival | `buildSdeTursattPostArrivalShiftNeeds` and `SdeTursattPostArrival` | scheduled move needs | Convert each scheduled need to an intent/obligation before slot selection. |
| Workshop exit | `buildSdeWorkshopExitMoveNeeds` | candidate rows and unresolved diagnostics | Convert unambiguous exit need to an intent; unified full-slot search decides the target. |
| Workshop ingress | `buildSdeWorkshopIngressMoveNeeds` | candidate rows | Convert to an intent; unified engine decides prerequisites and target. |
| Cancel replacement | `buildSdeCancelledReplacementMoves` | replacement rows | Send `CANCELLED` event to the active plan revision and replan its incomplete suffix. |
| Blocked source/target | `buildSdePhysicalBlockerGuardMoves` | prerequisite/dependent/return rows | Replaced by general obligation expansion and graph search. |
| Trapped egress | `buildSdeCompleteTrappedEgressPlan` / `buildSdeCompleteTrappedEgressRows` | RELEASE/MAIN/RECOVERY rows | Retained only as rollback oracle until unified N-step parity is demonstrated. |
| Automatic unresolved replan | `buildSdeCanonicalAutomaticReplanRows` | substituted legacy rows | Replaced by event-driven suffix replan; original intent remains immutable. |

## Existing mutable owners

| State | Current role | Canonical migration status |
| --- | --- | --- |
| `state.sdeNightPlacementManualOverrides` | user intent plus derived drag data | Intent adapter only; derived targets must not become authority. |
| `state.sdeActiveMoveOutcomes` | active outcome/handler authority | Execution adapter only after a canonical step is actionable. |
| `state.sdeMoveActions` | completion/cancellation history | Event source and completed-prefix evidence. |
| `state.sdePhysicalReleaseReplans` | rejected relief targets and local rounds | Replaced by versioned plan revisions and one active replan transaction. |
| `state.sdeVnRecoveryObligations` | special VN return bookkeeping | Replaced by ordinary graph dependencies; VN has no special global default. |
| `state.planSkifteRows` | operationally completed move projection | Actual-state write remains allowed only after authorized `Utført`. |

## Existing canonical projections

The post-migration projection boundary remains one-way:

1. `buildSdeCanonicalPlan`
2. `buildSdeCanonicalCardProjection`
3. `buildSdeCanonicalReservationProjection`
4. `buildSdeCanonicalGraphicProjection`
5. `buildSdeCanonicalIntegrityReport`
6. `buildSdeCanonicalProductionReaderSource`

The unified engine may feed the canonical plan adapter, but none of the card,
reservation, overlay, route-resource or handler projections may independently
invent, rank or retarget a move.

## Execution writes retained by contract

- `setSdeActiveOutcomeAuthority` may bind an already selected actionable step.
- `addSdeCompletedMoveToPlanSkifte` may update actual state only after an
  authorized `Utført` action and a fresh actual-state revalidation.
- cancellation handlers may append an event; they may not directly select a
  replacement target.
- persistence may store user intent, plan revision and audit evidence; it may
  not promote a recommendation to actual state.

## Legacy risks frozen at the boundary

- Planning is distributed over several row builders and mutable state maps.
- Specialized three-card and VN recovery paths coexist with recursive trapped
  egress logic.
- Candidate loops contain local `break`, `find` and first-valid selection paths;
  they cannot prove that the entire eligible slot set was evaluated.
- Automatic replan currently substitutes row targets downstream instead of
  publishing an atomic plan revision.
- A card can be suppressed during reconciliation after a producer has already
  accepted an intent, which is consistent with the historical silent-candidate
  diagnostic for 70-11 / 10S to 8S.
- Ranking and feasibility are not represented as separate typed results across
  all producers.

## Disable criterion

Legacy planning writes are disabled only after all of the following have passed:

1. exact producer-to-intent parity tests;
2. general N-step exhaustive-oracle tests inside the frozen search boundary;
3. atomic projection/ledger tests;
4. an actual revert-commit rollback drill;
5. the exact historical 70-11 / 10S to 8S regression fixture.

If the final fixture cannot preserve its historical occupancy, infrastructure,
resources, reservations, eligibility and revision inputs, the phase remains
`HOLD` and the legacy writers stay enabled.
