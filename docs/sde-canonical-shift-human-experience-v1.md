# Canonical Shift Engine – HumanExperienceScore governance

Contract: `SDE-CANONICAL-SHIFT-HUMAN-EXPERIENCE-20260822-V1`

The canonical shift engine reuses the normative governance in
`docs/sde-night-intelligence.md`; it does not create a separate store,
provenance model, privacy model or promotion path.

## Normative data sources and provenance

- `AUTHORITATIVE_EXECUTED_RESULT` has full evidence weight only after an
  authorized `Utført` result and a matching actual final slot.
- `HUMAN_IMPORTED_PLAN`, `HUMAN_MANUAL_PLAN` and
  `CONFIRMED_WRITTEN_PLAN` have the existing weaker planned-evidence weight
  and must be human-confirmed.
- `SDE_RECOMMENDATION`, unverified OCR/HTR, diagnostic output, displayed
  cards and unexecuted SDE proposals have zero weight.
- `REPLAN_REQUIRED`, cancellation, interruption and a non-matching final
  actual slot are not positive execution evidence.

The existing `sdeMoveLearningLog`/night-intelligence persistence remains the
only browser-side source. No image bytes, handwriting, names, email
addresses or new personal identifiers are added. The engine consumes a
read-only, minimal projection with target slot, material type, outcome,
date, provenance and replan state.

## Policy boundary

`vehicleId` is identity and never policy. Experience is compared by target
slot and material type (for example type 74), never by a historical
individual vehicle identifier. Vehicle-ID permutations therefore preserve
the physical plan structure when the material context is unchanged.

HumanExperienceScore is evaluated only after P0 hard gates and may only
break ties after P1–P3 and minimum move count. It cannot make an unsafe
candidate safe, suppress a safe candidate, alter priority or authorize a
physical action. MachineLearningScore remains inactive in Phase A.

Recency uses the existing 180-day half-life. The engine exposes whether
HumanExperienceScore influenced a tie and includes this in the plan/card
explanation. No runtime training or automatic promotion occurs.
