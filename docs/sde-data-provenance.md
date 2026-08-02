# SDE static-data provenance

This contract makes a single generator run traceable without changing SDE product rules, the existing `api_idag.json` / `api_imorgen.json` schemas, or any production reader.

## Pipeline before this change

`update_static_data.py` is invoked by `.github/workflows/update-static-data.yml`. The workflow evaluates the current Europe/Oslo window and the published data dates. When an update is selected, the generator:

1. derives train-number candidates with `get_balise_train_lookup_candidates`;
2. opens `https://balise.no/tog/{trainNumber}/{operationalDate}` and selects a candidate with `select_balise_candidate_result`;
3. reads `https://balise.no/api/train/vehicles?route={routeId}` and `https://balise.no/api/train/stops?route={routeId}`;
4. normalizes source datetimes with `normalize_balise_source_datetime`;
5. resolves compositions and movements with `resolve_departure_vehicle_composition`, `resolve_departure_candidate`, and `build_skien_movement_context`;
6. builds `api_idag.json`, then `api_imorgen.json`, with `updatedAt` set from the generator's Europe/Oslo clock;
7. atomically replaces both dataset files;
8. lets the workflow stage only the allowed data files, commit, rebase on the current default branch and push; and
9. relies on the repository's normal Pages publication before Quality Engine reads the checked-out or published bytes.

Previously, `updatedAt` and Git history were the only durable clues. No generation identity tied the two datasets to the same source capture, no source hash survived, intended and actual cycle times were not bound, and Pages evidence could not be distinguished from authenticated custom-domain observability.

## Additive generation manifest

Every real generator execution now atomically writes `data/sde-data-provenance.json` alongside both existing datasets. Existing dataset schemas are unchanged. The manifest uses `sde-data-provenance/v1` and contains:

- a UUID `generationId` shared by both dataset attestations;
- `startedAt`, `completedAt`, and `timeZone: Europe/Oslo`;
- the intended cycle identity and boundary;
- workflow event/run/attempt, actual workflow start, actual generator start, and whether the generator ran;
- source endpoint identities, observation time, counts, and exact hashes;
- operational date, exact SHA-256, byte count and record count for each dataset;
- explicit pending publication state; and
- a machine-readable hash contract.

The manifest contains neither cookies, tokens, authorization headers, Cloudflare material, raw route payloads nor raw vehicle payloads.

## Exact hash contract

All SHA-256 values are lowercase hexadecimal.

- Dataset hashes cover the exact UTF-8 bytes written to disk. JSON is serialized with `ensure_ascii=false`, indentation of two spaces, insertion order preserved, and one terminal newline. Hash verification never reparses and reserializes the dataset.
- A raw station-response hash covers the exact response bytes returned by the Balise route stop endpoint after HTTP decoding and before application normalization.
- Vehicle evidence is deterministic: normalized vehicle rows are grouped with their route identity in capture order, serialized as UTF-8 canonical JSON with sorted keys and compact separators, then hashed. The raw vehicle response is never retained in the manifest.
- The generation-manifest hash in the release attestation covers the exact manifest bytes as uploaded by the workflow.

No later live observation may be reconstructed into one of these hashes or treated as evidence for this generation.

## Consistent-source capture

For each selected route, the generator reads station stops, then vehicles, then station stops again. It compares the exact first and second station hashes. One complete retry is allowed. If both attempts observe a change, the retained evidence says `snapshotStable: false`; it is not rewritten as stable and Quality Engine returns `BLOCKED`. This change records the condition but does not introduce a new publishing stop.

The manifest's aggregate station and vehicle hashes bind the route captures used by the run. `observedAt` is the generator observation, not a later Quality Engine probe.

## Intended cycle versus actual execution

The workflow calculates the most recent intended 04, 07, 15, or 21 Europe/Oslo cycle and exports it separately from the actual workflow and generator start times. A delayed GitHub Actions run therefore keeps the intended cycle identity. When the update guard skips generation, the GitHub step summary records the intended cycle, actual workflow start, decision, and reason; no false generation manifest is created.

## Non-circular release attestation and identity domains

The generation manifest deliberately leaves Git commit/tree and Pages deployment pending because a file cannot contain the hash of the commit that contains that file without a circular identity problem. After the data commit is created and pushed, `sde_data_release_attestation.py` creates `sde-data-release-attestation/v2` as a workflow artifact. V2 never treats one SHA as a universal release identity. It records four independent domains:

1. **Generation identity** — generation ID, generator workflow run/context, source observation hashes/times and intended cycle.
2. **Content identity** — data commit/tree, exact manifest and dataset hashes, and (when observed) the Pages artifact source commit, artifact ID and digest.
3. **Deployment identity** — Pages workflow run/context, build version, deployment ID/API SHA, publication time and the artifact actually deployed.
4. **Publication integrity** — exact published manifest/dataset hashes, response headers and authenticated custom-domain observability.

The workflow context SHA identifies the code context that ran a workflow. The data commit identifies the exact generated bytes. The Pages build/deployment API SHA identifies a deployment execution. Those values may legitimately differ. Equality is required only where the contract says two fields identify the same content: artifact source commit equals data commit for a checkout-built artifact; artifact ID/digest binds the Pages workflow to the deployment; and published hashes equal the attested content hashes.

The initial v2 artifact is intentionally pending for evidence that does not exist yet. A later read-only observer may populate artifact, deployment and publication fields. Missing evidence is `BLOCKED`; it is never guessed from an unrelated SHA.

Legacy `sde-data-release-attestation/v1` artifacts remain readable and are never rewritten. A v1 artifact with null deployment fields is pending external evidence. A populated `deployedCommit` that differs from the data commit is legacy-ambiguous unless separate artifact-source evidence proves the content binding; it is not by itself a hash mismatch.

## Quality Engine decision contract

Quality Engine validates structure, exact dataset integrity, consistent source evidence, intended/actual scheduling, and Git/deployment attestation independently. Results appear in JSON, Markdown, HTML, JUnit, and the GitHub step summary as an explicit chain:

`Balise snapshot -> generator run -> dataset hashes -> Git commit -> Pages deployment -> published bytes`

Missing evidence is `BLOCKED`, contradictions are `RED`, and missing evidence is never itself called a product defect. Provenance checks use the external `data-provenance` area, so a critical `BLOCKED` produces external `HOLD` while internal Quality Engine qualification remains green.

`comparisonEligibility` is true only when source observation time, source hash, generation ID, both dataset hashes, and both operational dates are present and the source capture is stable. Conflicting generation IDs or mismatched published hashes make a comparison ineligible. Legacy data without a manifest remains readable but is classified `LEGACY_DATASET_WITHOUT_MANIFEST`.

Synthetic fixtures cover complete evidence, every required missing/contradictory boundary, delayed execution, legacy data, conflicting generations and invalid schema. They are explicitly synthetic and must never be populated from production observations.
