# SDE schedule observability v1

`sde-schedule-observability/v1` is a diagnostic-only record for the static
Balise-data workflow. It does not participate in the update gate, generator,
commit, publication, freshness, grace, intended-cycle, or concurrency logic.

The workflow emits one artifact named
`sde-schedule-observability-<run-id>-<attempt>` for every relevant run,
including manual dispatch, an up-to-date skip, and a partially failed run. A
minimal `BLOCKED` record is created before checkout and is overwritten by the
enriched record when the repository helper and GitHub Actions read API are
available.

## Trigger identity

The critical expression is decomposed into four behaviorally equivalent cron
expressions for minutes `07`, `22`, `37`, and `52`. The hourly control remains
minute `17`. `github.event.schedule` is the primary proof of the trigger class
and minute.

A concrete local/UTC slot is recorded only when exactly one matching cron slot
exists in the closed interval from one hour before `runRecordCreatedAt` through
`runRecordCreatedAt`. There is no unconditional nearest-slot fallback. Zero
matches is `BLOCKED`; multiple matches, including the repeated Oslo hour at a
DST boundary, is `AMBIGUOUS`. `runRecordCreatedAt` is the Actions run-record
creation time and is never described as the event-delivery time.

## Time domains

- `expectedSlotLocal` / `expectedSlotUTC`: bounded cron association.
- `runRecordCreatedAt`: GitHub Actions run API `created_at`.
- `runStartedAt`: GitHub Actions run API `run_started_at`.
- `firstJobStartedAt`: earliest job API `started_at`.
- `workflowObservedAt`: first workflow observation timestamp.
- `gateStartedAt` / `gateCompletedAt`: update-gate observation only.

Durations are derived only when both endpoints exist and are ordered. Negative
or contradictory timing is fail-closed.

## Security and failure behavior

Only an explicit record-field allowlist is serialized. The token is used only
for `GET` requests to the current run and jobs endpoints and is never written.
Raw event payloads, request/response bodies, headers, cookies, environment
dumps, and secrets are excluded. Missing API access produces a useful
`BLOCKED` record and does not stop the established data pipeline.

The normative machine-readable contract is
`tests/sde-quality-engine/contracts/sde-schedule-observability-v1.schema.json`.
