"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../../..");
const indexPath = path.resolve(process.argv[2]);
const index = fs.readFileSync(indexPath, "utf8");
const moduleBytes = fs.readFileSync(path.join(root, "sde_tursatt_live_arrival.js"));
const moduleSource = moduleBytes.toString("utf8");
const adapterSource = fs.readFileSync(path.join(root, "server/src/tursattLiveArrivals.js"), "utf8");
const results = [];

function invariant(id, description, check) {
  try {
    if (!check()) throw new Error(description);
    results.push({id, status: "PASS", description});
  } catch (error) {
    results.push({id, status: "FAIL", description, error: String(error?.message || error)});
  }
}

const expectedModuleHash = crypto.createHash("sha256").update(moduleBytes).digest("hex");
const markerStart = index.indexOf("function refreshTursattPostArrivalParkingMarkers(");
const markerEnd = index.indexOf("function handleOppstillingVehicleChange(", markerStart);
const markerSource = markerStart >= 0 && markerEnd > markerStart ? index.slice(markerStart, markerEnd) : "";
const buildStart = index.indexOf("function buildOppstilling(){");
const buildEnd = index.indexOf("function slotKind(", buildStart);
const buildSource = buildStart >= 0 && buildEnd > buildStart ? index.slice(buildStart, buildEnd) : "";

invariant("INV-TURSATT-LIVE-001", "revision is 31 August 2026", () =>
  index.includes("Siste revisjon: 31. august 2026")
);

invariant("INV-TURSATT-LIVE-002", "the live-arrival module is hash-bound before the inline app", () =>
  index.includes(`<script src="sde_tursatt_live_arrival.js?v=${expectedModuleHash}"></script>`)
  && index.indexOf("sde_tursatt_live_arrival.js?v=") < index.indexOf("<script>\nconst STORAGE_KEY")
);

invariant("INV-TURSATT-LIVE-003", "exact occurrence identity includes every required binding field", () =>
  ["operationalDate", "trainNumber", "stationRef", "direction", "plannedArrival", "routeId", "stopId", "occurrenceId", "sourceRevision"]
    .every(field => moduleSource.includes(`"${field}"`))
  && moduleSource.includes("EXACT_IDENTITY_FIELDS.every")
);

invariant("INV-TURSATT-LIVE-004", "delay thresholds preserve planned primary text", () =>
  moduleSource.includes('delayMinutes >= 4 ? "long-delay" : delayMinutes > 0 ? "short-delay" : "on-time"')
  && moduleSource.includes('const suffixText = delayMinutes > 0 ? `+${delayMinutes}` : "";')
  && index.includes('className = "tursatt-planned-arrival"')
);

invariant("INV-TURSATT-LIVE-005", "unknown and stale records are planned-only", () =>
  moduleSource.includes('freshness !== "fresh"')
  && moduleSource.includes('freshness === "stale" ? "STALE" : "UNAVAILABLE"')
  && index.includes("markTursattLiveArrivalRecordsStale()")
);

invariant("INV-TURSATT-LIVE-006", "the adapter has a fixed Balise origin and rejects unsafe route ids", () =>
  adapterSource.includes('const BALISE_STOPS_ORIGIN = "https://balise.no";')
  && adapterSource.includes("SAFE_ROUTE_ID.test")
  && adapterSource.includes('redirect: "error"')
  && !index.includes("routeId=${")
);

invariant("INV-TURSATT-LIVE-007", "the browser performs one date-batch request and no per-row request", () =>
  (index.match(/fetch\(`\/api\/tursatt\/live-arrivals\?date=/g) || []).length === 1
  && !index.includes("/api/train/stops")
);

invariant("INV-TURSATT-LIVE-008", "parking markers are projected from canonical forced MAIN needs without fixed identities", () =>
  markerSource.includes("const bindings = buildSdeTursattVehicleBindings();")
  && markerSource.includes("const plan = buildSdeTursattPostArrivalShiftNeeds(bindings);")
  && markerSource.includes('bindings.filter(binding=>binding?.role === "arrival")')
  && markerSource.includes("if(!need?.requiresPostArrivalShunt || !need?.forcedTrainRule) return;")
  && markerSource.includes("canonicalOccurrencePartKey")
  && !/["'](?:835|837|839)["']/.test(markerSource)
  && !/["'](?:69|70|72|74|75)-\d{2}["']/.test(markerSource)
);

invariant("INV-TURSATT-LIVE-009", "PARKERES reuses the established red removal styling", () =>
  index.includes('hint.textContent = "PARKERES";')
  && index.includes('td.classList.add("opp-split-remove-cell")')
  && index.includes('hint.className = "opp-split-remove-hint"')
);

invariant("INV-TURSATT-LIVE-010", "marker authority refreshes before a table fragment is built", () =>
  buildSource.indexOf("refreshTursattPostArrivalParkingMarkers()") >= 0
  && buildSource.indexOf("refreshTursattPostArrivalParkingMarkers()") < buildSource.indexOf("createTursattTableFragment(viewModel)")
);

const failed = results.filter(item => item.status === "FAIL");
process.stdout.write(`${JSON.stringify({
  schemaVersion: "sde-tursatt-live-arrival-invariants-v1",
  counts: {total: results.length, pass: results.length - failed.length, fail: failed.length},
  results
})}\n`);
process.exitCode = failed.length ? 1 : 0;
