"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../../..");
const indexPath = path.resolve(process.argv[2] || path.join(root, "index.html"));
const runtimeAuthorizationPath = path.resolve(process.argv[3] || path.join(root, "server/src/runtimeAuthorization.js"));
const deleteAuthorityPath = path.resolve(process.argv[4] || path.join(root, "server/src/sharedSporplanDeleteAuthority.js"));
const serverIndexPath = path.resolve(process.argv[5] || path.join(root, "server/src/index.js"));

const indexSource = fs.readFileSync(indexPath, "utf8");
const runtimeAuthorizationSource = fs.readFileSync(runtimeAuthorizationPath, "utf8");
const deleteAuthoritySource = fs.readFileSync(deleteAuthorityPath, "utf8");
const serverIndexSource = fs.readFileSync(serverIndexPath, "utf8");

const sectionStart = indexSource.indexOf('<section class="panel" id="grunnoppstilling">');
const sectionEnd = indexSource.indexOf("</section>", sectionStart);
const section = sectionStart >= 0 && sectionEnd > sectionStart
  ? indexSource.slice(sectionStart, sectionEnd + "</section>".length)
  : "";
const deleteAccessStart = indexSource.indexOf("function canUseSporplanDeleteInCurrentUi(){");
const deleteAccessEnd = indexSource.indexOf("function updateSporplanDeleteVisibility(){",deleteAccessStart);
const deleteAccessSource = deleteAccessStart >= 0 && deleteAccessEnd > deleteAccessStart
  ? indexSource.slice(deleteAccessStart,deleteAccessEnd)
  : "";
const projectionStart = indexSource.indexOf("function renderSharedSporplanDraftReadback(readback){");
const projectionEnd = indexSource.indexOf("function renderSharedSporplanDraftSaveState(message){",projectionStart);
const projectionSource = projectionStart >= 0 && projectionEnd > projectionStart
  ? indexSource.slice(projectionStart,projectionEnd)
  : "";

const results = [];
function invariant(id, description, condition){
  results.push({id, description, status: condition ? "PASS" : "FAIL"});
}

invariant("INV-INPUT-CLEANUP-001", "Input Sporplan contains one infrastructure disclosure host", (section.match(/id="txpUnavailableInfrastructurePanel"/g) || []).length === 1);
invariant("INV-INPUT-CLEANUP-002", "Infrastructure controls render inside native details disclosure", /<details class="txp-unavailable-disclosure"/.test(indexSource));
invariant("INV-INPUT-CLEANUP-003", "Disclosure summary preserves the canonical TXP label", /<summary[^>]*>TXP driftsbegrensning \/ uvirksom infrastruktur<\/summary>/.test(indexSource));
invariant("INV-INPUT-CLEANUP-004", "Disclosure begins collapsed and exposes aria-expanded false", /aria-expanded="\$\{wasExpanded \? "true" : "false"\}"/.test(indexSource));
invariant("INV-INPUT-CLEANUP-005", "Disclosure does not carry an unconditional open attribute", !/<details class="txp-unavailable-disclosure"\s+open>/.test(indexSource));
invariant("INV-INPUT-CLEANUP-006", "Disclosure expansion state is captured before rerender", /const wasExpanded = disclosure\?\.open === true;/.test(indexSource));
invariant("INV-INPUT-CLEANUP-007", "Disclosure expansion state is restored across rerender", /\$\{wasExpanded \? "open" : ""\}/.test(indexSource));
invariant("INV-INPUT-CLEANUP-008", "Disclosure toggle synchronizes aria-expanded", /nextDisclosure\?\.addEventListener\("toggle"[\s\S]*setAttribute\("aria-expanded", nextDisclosure\.open \? "true" : "false"\)/.test(indexSource));
invariant("INV-INPUT-CLEANUP-009", "All slot availability checkboxes remain wired", /querySelectorAll\("\[data-txp-unavailable-slot\]"\)/.test(indexSource));
invariant("INV-INPUT-CLEANUP-010", "All track availability checkboxes remain wired", /querySelectorAll\("\[data-txp-unavailable-track\]"\)/.test(indexSource));
invariant("INV-INPUT-CLEANUP-011", "Infrastructure changes retain existing persistence", /setTxpUnavailableSlot\([\s\S]*persist\(true\)/.test(indexSource) && /setTxpUnavailableTrack\([\s\S]*persist\(true\)/.test(indexSource));
invariant("INV-INPUT-CLEANUP-012", "Ground-placement explanatory banner is absent", !section.includes("Grunnoppstilling</strong> er fysisk registrert tomtestatus"));
invariant("INV-INPUT-CLEANUP-013", "Shared-draft status text container is absent", !section.includes('id="sharedSporplanDraftStatus"'));
invariant("INV-INPUT-CLEANUP-014", "Placement-summary readback container is absent", !section.includes('id="sharedSporplanDraftReadback"'));
invariant("INV-INPUT-CLEANUP-015", "Shared-draft write-state text is absent", !section.includes('id="sharedSporplanDraftWriteState"'));
invariant("INV-INPUT-CLEANUP-016", "Read shared draft button is absent", !section.includes("Les delt draft") && !section.includes('id="sharedSporplanDraftRefreshBtn"'));
invariant("INV-INPUT-CLEANUP-017", "Save shared parked-where button is absent", !section.includes("Lagre delt parkert-hvor") && !section.includes('id="sharedSporplanDraftSaveBtn"'));
invariant("INV-INPUT-CLEANUP-018", "No orphan shared-draft toolbar remains", !section.includes('aria-label="Delt sporplan-draft"'));
invariant("INV-INPUT-CLEANUP-019", "Exactly one canonical destructive action is present", (indexSource.match(/id="deleteSporplanBtn"/g) || []).length === 1 && !indexSource.includes('id="resetBtn"'));
invariant("INV-INPUT-CLEANUP-020", "Canonical destructive action label is Slett Sporplan", /id="deleteSporplanBtn"[^>]*>Slett Sporplan<\/button>/.test(section));
invariant("INV-INPUT-CLEANUP-021", "Destructive action occupies the former draft action area before the infrastructure panel", section.includes('id="deleteSporplanBtn"') && section.indexOf('id="deleteSporplanBtn"') < section.indexOf('id="txpUnavailableInfrastructurePanel"') && !section.includes('id="sharedSporplanDraftSaveBtn"'));
invariant("INV-INPUT-CLEANUP-022", "Frontend requires server capability input_sporplan.delete", /capabilities\?\.\["input_sporplan\.delete"\]/.test(deleteAccessSource));
invariant("INV-INPUT-CLEANUP-023", "Frontend restricts destructive action to Input Sporplan and TXP-capable levels", /activeTab === "grunnoppstilling"/.test(deleteAccessSource) && /SDE_SPORPLAN_DELETE_ALLOWED_LEVELS\.includes\(level\)/.test(deleteAccessSource));
invariant("INV-INPUT-CLEANUP-024", "Frontend fail-closes on unresolved identity or denied capability", /dropsRuntimeCapabilities\?\.ok === true/.test(deleteAccessSource) && /dropsRuntimeCapabilities\?\.roleResolved === true/.test(deleteAccessSource) && /capability\?\.allowed === true/.test(deleteAccessSource));
invariant("INV-INPUT-CLEANUP-025", "Hidden destructive action is disabled and removed from tab order", /button\.disabled = !allowed;/.test(indexSource) && /button\.tabIndex = allowed \? 0 : -1;/.test(indexSource));
invariant("INV-INPUT-CLEANUP-026", "Deletion requires explicit scoped confirmation", /confirm\("Slette gjeldende Sporplan\? Dette sletter bare delt Input Sporplan-draft\. Faktisk plassering og øvrig operativ tilstand endres ikke\."\)/.test(indexSource));
invariant("INV-INPUT-CLEANUP-027", "Projection removal and deletion do not clear unrelated placement or whole-app state", !/state\.grunnoppstilling\s*=\s*\{\}/.test(projectionSource) && !/deleteSporplanBtn[\s\S]{0,1600}localStorage\.removeItem/.test(indexSource) && !/deleteSporplanBtn[\s\S]{0,1600}state=makeDefaultState/.test(indexSource));
invariant("INV-INPUT-CLEANUP-028", "Server guards reset tombstone with capability, verified audit identity and revisioned persistence", /INPUT_SPORPLAN_DELETE:\s*"input_sporplan\.delete"/.test(runtimeAuthorizationSource) && /createSharedSporplanDeleteCapabilityGuard/.test(deleteAuthoritySource) && /buildAuthorizedSharedSporplanDeletePayload/.test(deleteAuthoritySource) && /serverAuthorizedDelete:true/.test(deleteAuthoritySource) && /verifiedCapability:verifiedIdentity\.capability/.test(deleteAuthoritySource) && /sharedSporplanDeleteCapabilityGuard/.test(serverIndexSource) && /saveSharedSporplanDraft\(db, authorizedPayload\)/.test(serverIndexSource));

const failed = results.filter(result => result.status === "FAIL");
process.stdout.write(`${JSON.stringify({
  schemaVersion:"sde-input-sporplan-ui-cleanup-invariants-v1",
  counts:{total:results.length, pass:results.length - failed.length, fail:failed.length},
  results
})}\n`);
process.exitCode = failed.length ? 1 : 0;
