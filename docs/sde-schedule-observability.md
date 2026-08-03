# SDE schedule observability v1

`sde-schedule-observability/v1` is a diagnostic-only record for the static
Balise-data workflow. It does not participate in the update gate, generator,
commit, publication, freshness, grace, intended-cycle, or concurrency logic.

The workflow emits one artifact named
`sde-schedule-observability-<run-id>-<attempt>` for every relevant run,
including manual dispatch, an up-to-date skip, and a partially failed run. A
minimal `BLOCKED` record is created after the pinned Python runtime setup and
repository checkout, before the schedule gate. It is overwritten by the
enriched record when the GitHub Actions read API is available.

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

`runNumber` and `runAttempt` are valid only as positive integers. Pure ASCII
base-10 strings are accepted at the environment boundary and normalized to
integers. Missing, zero, negative, fractional, boolean, whitespace, or
otherwise invalid values make the record `BLOCKED`. In that state `rerun` is
unknown (`null`) when the attempt cannot be proved, and the record can never
be natural schedule evidence. Attempt 1 is a confirmed non-rerun; attempts
above 1 are reruns and are never natural candidates.

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

The jobs response is complete only when its non-negative integer
`total_count` exactly matches the returned job list, all job identifiers are
positive and unique, and every job has a valid `started_at`. A missing,
invalid, contradictory, duplicated, or possibly truncated response is
`BLOCKED`; `firstJobStartedAt` remains `null` rather than being inferred from
partial metadata. The fixed endpoint remains
`GET /repos/<repo>/actions/runs/<run-id>/jobs?per_page=100`.

Record output uses an exclusively created temporary file in the same
no-follow directory, flushes the complete JSON bytes, atomically replaces only
a regular output entry, and synchronizes the directory. Existing and dangling
output symlinks, symlinked parent components, and non-regular targets are
rejected. Temporary files are removed on failure. Platforms without the
required POSIX no-follow primitives fail closed. On macOS, only the verified
system alias `/var -> /private/var` is canonicalized; arbitrary parent
symlinks remain rejected.

The workflow installs Python 3.11 before the initial record, gate, optional
generator, enrichment, and artifact upload sequence. The setup is
unconditional, so selected and skipped generator paths use the same pinned
runtime. This changes no schedule, grace, intended-cycle, concurrency,
permission, or generator semantics.

The normative machine-readable contract is
`tests/sde-quality-engine/contracts/sde-schedule-observability-v1.schema.json`.
