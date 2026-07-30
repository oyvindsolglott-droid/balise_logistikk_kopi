"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const sourcePath = process.argv[2] || path.resolve(__dirname, "../../../index.html");
const source = fs.readFileSync(sourcePath, "utf8");

function extractFunction(name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `missing function ${name}`);
  const signatureEnd = source.slice(start).match(/\)\s*\{/);
  assert.ok(signatureEnd, `missing body for ${name}`);
  const open = start + signatureEnd.index + signatureEnd[0].lastIndexOf("{");
  let depth = 0;
  let quote = "";
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (character === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }
    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`unclosed function ${name}`);
}

const central = extractFunction("getAuthoritativeVehicleStatusPresentation");
const workshop = extractFunction("getWorkshopHallOverviewStatus");
const renderer = extractFunction("renderSporplanVehicleStatusPresentation");
if(process.env.SDE_STATUS_PARITY_RENDER_ONLY === "1"){
  process.stdout.write(JSON.stringify({
    schemaVersion:"sde-status-parity-render-only-v1",
    renderedStatusParity:runRenderedStatusParityGate(),
  }) + "\n");
  process.exit(0);
}
assert.match(central, /effectiveStatus/, "central presentation must expose one effective status");
assert.match(central, /DRIFTSKLAR/, "missing status must retain default Driftsklar semantics");
assert.match(central, /IKKE_DRIFTSKLAR/, "explicit not-operational status must remain distinct");
assert.match(central, /workshopDisposition/, "disposition must remain independent of operational status");
assert.match(central, /activeFaults/, "active faults must remain independent of operational status");

assert.match(
  workshop,
  /getAuthoritativeVehicleStatusPresentation\(readback,cleanVehicleId\)/,
  "Workshop must consume the same authoritative status presentation as Sporplan and DROPS",
);
assert.doesNotMatch(
  workshop,
  /fallbackRecord|fallbackKind|currentStatus\s*===/,
  "Workshop must not maintain a parallel fallback status model",
);

for (const token of [
  "sporplan-status-operational",
  "sporplan-status-not-operational",
  "classList.remove",
  "classList.add",
  "aria-label",
  "title",
  "buildSporplanVehicleStatusBadgesHtml",
]) {
  assert.ok(renderer.includes(token), `Sporplan readback renderer is missing ${token}`);
}
assert.match(
  renderer,
  /getAuthoritativeVehicleStatusPresentation/,
  "Sporplan readback renderer must use the central status presentation",
);

const refresh = extractFunction("refreshVehicleStatusReadback");
assert.match(
  refresh,
  /renderSporplanVehicleStatusPresentation\(\)/,
  "every fresh vehicle-status readback must update the complete Sporplan status presentation",
);

const sporplanBuilder = extractFunction("buildSporplan");
assert.match(
  sporplanBuilder,
  /getSporplanVehicleStatusFrameClass/,
  "initial Sporplan render must use the same status-frame contract as polling",
);

assert.match(
  source,
  /\.sporplan-slot-overlay\s+\.slot-bottom\.mat\s*\{[\s\S]{0,500}background:\s*rgba\(0,0,0,\.80\)/,
  "vehicle identity must remain neutral black with white text",
);
assert.match(
  source,
  /\.sporplan-slot-overlay\s+\.slot\.sporplan-status-operational\s*\{[\s\S]{0,220}border-color:\s*rgba\(74,222,128,\.78\)\s*!important/,
  "authoritative Driftsklar must override the legacy repair-slot border color",
);
assert.match(
  source,
  /\.sporplan-slot-overlay\s+\.slot\.rep-slot\s+\.slot-bottom\.mat\s*\{[\s\S]{0,300}background:\s*rgba\(0,0,0,\.80\)[\s\S]{0,180}box-shadow:\s*none/,
  "repair metadata must not recolor the neutral vehicle identity in Sporplan",
);
assert.match(
  source,
  /\.sporplan-slot-overlay\s+\.slot\s*\{[\s\S]{0,500}color:\s*#fff/,
  "vehicle identity must remain white regardless of status",
);
assert.match(
  source,
  /\.workshop-hall-overview-slot\.is-selected\s*\{[\s\S]{0,160}outline:\s*3px solid #38bdf8/,
  "selection must remain a separate visual layer",
);

function extractStyles() {
  return Array.from(source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi))
    .map(match => match[1])
    .join("\n");
}

function runRenderedStatusParityGate() {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "sde-status-parity-"));
  const fixturePath = path.join(temporaryDirectory, "fixture.html");
  const runnerPath = path.join(temporaryDirectory, "runner.py");
  const fixtureSource = `<!doctype html>
<html lang="no">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>${extractStyles()}</style>
</head>
<body>
  <main id="statusParityFixture">
    <section id="sporplanView" aria-label="Sporplan">
      <div class="sporplan-slot-overlay" style="position:relative;width:min(100%,320px);height:320px">
        <div id="operationalSlot" class="slot filled rep-slot" data-slot="7N"
             style="position:absolute;left:4px;top:4px;width:144px;height:300px">
          <span class="slot-bottom mat">74-38</span>
          <span class="sporplan-vehicle-status-host"
                data-sde-sporplan-vehicle-status data-vehicle-text="74-38"></span>
        </div>
        <div id="notOperationalSlot" class="slot filled drei-slot" data-slot="8S"
             style="position:absolute;left:164px;top:4px;width:144px;height:300px">
          <span class="slot-bottom mat">74-45</span>
          <span class="sporplan-vehicle-status-host"
                data-sde-sporplan-vehicle-status data-vehicle-text="74-45"></span>
        </div>
      </div>
    </section>
    <section id="workshopView" aria-label="Verksted" hidden>
      <div id="workshopFixture"></div>
    </section>
  </main>
<script>
"use strict";
let dropsVehicleStatusReadback = {};
function splitVehicleList(value){
  return String(value || "").split(/[+,/]/).map(item=>item.trim()).filter(Boolean);
}
function normalizeVehicleToken(value){
  return String(value || "").trim();
}
${extractFunction("getDropsVehicleStatusRecord")}
${central}
${extractFunction("getSporplanVehicleStatusPresentations")}
${extractFunction("getSporplanVehicleStatusFrameClass")}
${extractFunction("getSporplanVehicleAccessibilityLabel")}
function buildSporplanVehicleStatusBadgesHtml(){
  return "";
}
${workshop}
${renderer}

function colorSnapshot(element){
  const style = getComputedStyle(element);
  return {
    borderColor:style.borderColor,
    backgroundColor:style.backgroundColor,
    color:style.color,
    boxShadow:style.boxShadow,
    outlineColor:style.outlineColor,
    outlineStyle:style.outlineStyle,
    outlineWidth:style.outlineWidth
  };
}

function buildReadback(operationalStatus){
  return {
    ok:true,
    items:[
      {
        vehicleId:"74-38",
        currentStatus:operationalStatus,
        workshopDisposition:"TIL_REP",
        activeFaults:[{faultId:"fault-74-38",slot:1,status:"ACTIVE",category:"A1"}]
      },
      {
        vehicleId:"74-45",
        currentStatus:"IKKE_DRIFTSKLAR",
        workshopDisposition:"TIL_DREI",
        activeFaults:[{faultId:"fault-74-45",slot:1,status:"ACTIVE",category:"A1"}]
      }
    ],
    faults:[
      {vehicleId:"74-38",faultId:"fault-74-38",slot:1,status:"ACTIVE",category:"A1"},
      {vehicleId:"74-45",faultId:"fault-74-45",slot:1,status:"ACTIVE",category:"A1"}
    ],
    repairRequests:[
      {
        vehicleId:"74-38",
        repairRequestId:"repair-74-38",
        faultId:"fault-74-38",
        status:"REQUESTED",
        requestedAt:"2026-07-30T12:00:00.000Z"
      },
      {
        vehicleId:"74-45",
        repairRequestId:"repair-74-45",
        faultId:"fault-74-45",
        status:"REQUESTED",
        requestedAt:"2026-07-30T12:01:00.000Z"
      }
    ]
  };
}

function renderWorkshopFixture(){
  const host = document.getElementById("workshopFixture");
  host.innerHTML = "";
  for(const [vehicleId,selected] of [["74-38",true],["74-45",false]]){
    const status = getWorkshopHallOverviewStatus(dropsVehicleStatusReadback,vehicleId);
    const button = document.createElement("button");
    button.type = "button";
    button.id = "workshop-" + vehicleId;
    button.className = "workshop-hall-overview-slot " + status.className +
      (selected ? " is-selected" : "") + " is-occupied";
    button.style.cssText = "position:relative;width:144px;height:300px;margin:8px";
    button.innerHTML =
      '<span class="workshop-hall-overview-vehicle-id">' + vehicleId + '</span>' +
      '<span class="workshop-hall-overview-status">' + status.label + '</span>' +
      '<span class="workshop-hall-overview-disposition ' +
      status.dispositionClassName + '">' + status.dispositionLabel + '</span>';
    host.appendChild(button);
  }
}

function switchView(name){
  document.getElementById("sporplanView").hidden = name !== "sporplan";
  document.getElementById("workshopView").hidden = name !== "workshop";
}

window.runStatusParityScenario = function(){
  dropsVehicleStatusReadback = buildReadback("DRIFTSKLAR");
  renderSporplanVehicleStatusPresentation();
  renderWorkshopFixture();

  const operationalSlot = document.getElementById("operationalSlot");
  const notOperationalSlot = document.getElementById("notOperationalSlot");
  const operationalIdentity = operationalSlot.querySelector(".slot-bottom.mat");
  const notOperationalIdentity = notOperationalSlot.querySelector(".slot-bottom.mat");
  const workshopOperational = document.getElementById("workshop-74-38");
  const workshopNotOperational = document.getElementById("workshop-74-45");
  const initial = {
    sporplanOperational:colorSnapshot(operationalSlot),
    sporplanNotOperational:colorSnapshot(notOperationalSlot),
    operationalIdentity:colorSnapshot(operationalIdentity),
    notOperationalIdentity:colorSnapshot(notOperationalIdentity),
    workshopOperational:colorSnapshot(workshopOperational),
    workshopNotOperational:colorSnapshot(workshopNotOperational),
    operationalClasses:Array.from(operationalSlot.classList),
    notOperationalClasses:Array.from(notOperationalSlot.classList),
    operationalPresentation:getAuthoritativeVehicleStatusPresentation(
      dropsVehicleStatusReadback,
      "74-38"
    ),
    notOperationalPresentation:getAuthoritativeVehicleStatusPresentation(
      dropsVehicleStatusReadback,
      "74-45"
    )
  };

  switchView("workshop");
  dropsVehicleStatusReadback = buildReadback("IKKE_DRIFTSKLAR");
  renderSporplanVehicleStatusPresentation();
  const changedToNotOperational = Array.from(operationalSlot.classList);
  switchView("sporplan");
  dropsVehicleStatusReadback = buildReadback("DRIFTSKLAR");
  renderSporplanVehicleStatusPresentation();
  const changedBackToOperational = Array.from(operationalSlot.classList);

  return {
    initial,
    changedToNotOperational,
    changedBackToOperational,
    finalOperational:colorSnapshot(operationalSlot),
    viewport:{
      width:window.innerWidth,
      height:window.innerHeight,
      fixtureScrollWidth:document.getElementById("statusParityFixture").scrollWidth,
      documentClientWidth:document.documentElement.clientWidth
    }
  };
};
</script>
</body>
</html>`;

  const pythonRunner = String.raw`
import json
import pathlib
import sys
from playwright.sync_api import sync_playwright

fixture_path = pathlib.Path(sys.argv[1]).resolve()
results = []
console_errors = []
page_errors = []
write_requests = []

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    try:
        for width, height, label in ((1440, 1000, "desktop"), (390, 900, "mobile")):
            page = browser.new_page(viewport={"width": width, "height": height})
            page.on(
                "console",
                lambda message: console_errors.append(message.text)
                if message.type == "error" else None
            )
            page.on("pageerror", lambda error: page_errors.append(str(error)))
            page.on(
                "request",
                lambda request: write_requests.append(
                    {"method": request.method, "url": request.url}
                ) if request.method not in ("GET", "HEAD") else None
            )
            page.goto(fixture_path.as_uri(), wait_until="load")
            result = page.evaluate("window.runStatusParityScenario()")
            result["label"] = label
            results.append(result)
            page.close()
    finally:
        browser.close()

def require(condition, message):
    if not condition:
        raise AssertionError(message)

for result in results:
    label = result["label"]
    initial = result["initial"]
    op = initial["sporplanOperational"]
    nonop = initial["sporplanNotOperational"]
    op_id = initial["operationalIdentity"]
    nonop_id = initial["notOperationalIdentity"]
    workshop_op = initial["workshopOperational"]
    workshop_nonop = initial["workshopNotOperational"]

    require(
        op["borderColor"] == "rgba(74, 222, 128, 0.78)",
        f"{label}: Driftsklar Sporplan frame is not green: {op['borderColor']}"
    )
    require(
        nonop["borderColor"] == "rgba(248, 113, 113, 0.88)",
        f"{label}: Ikke Driftsklar Sporplan frame is not red: {nonop['borderColor']}"
    )
    for identity_name, identity in (
        ("operational", op_id),
        ("not-operational", nonop_id),
    ):
        require(
            identity["backgroundColor"] == "rgba(0, 0, 0, 0.8)",
            f"{label}: {identity_name} identity is not neutral black"
        )
        require(
            identity["color"] == "rgb(255, 255, 255)",
            f"{label}: {identity_name} identity text is not white"
        )
        require(
            identity["borderColor"] == "rgba(255, 255, 255, 0.72)",
            f"{label}: {identity_name} identity border is not neutral"
        )
        require(
            identity["boxShadow"] == "none",
            f"{label}: {identity_name} identity has a status shadow"
        )

    require(
        workshop_op["borderColor"] == "rgb(74, 222, 128)",
        f"{label}: Workshop Driftsklar frame is not green"
    )
    require(
        workshop_nonop["borderColor"] == "rgb(248, 113, 113)",
        f"{label}: Workshop Ikke Driftsklar frame is not red"
    )
    require(
        workshop_op["outlineColor"] == "rgb(56, 189, 248)"
        and workshop_op["outlineStyle"] == "solid"
        and workshop_op["outlineWidth"] == "3px",
        f"{label}: Workshop selection is not an independent cyan outline"
    )
    require(
        initial["operationalPresentation"]["effectiveStatus"] == "DRIFTSKLAR"
        and initial["operationalPresentation"]["disposition"] == "TIL_REP"
        and len(initial["operationalPresentation"]["activeFaults"]) == 1
        and len(initial["operationalPresentation"]["requestedRepairRequests"]) == 1,
        f"{label}: repair metadata changed effective Driftsklar status"
    )
    require(
        initial["notOperationalPresentation"]["effectiveStatus"] == "IKKE_DRIFTSKLAR"
        and initial["notOperationalPresentation"]["disposition"] == "TIL_DREI",
        f"{label}: turning metadata changed effective Ikke Driftsklar status"
    )
    require(
        "sporplan-status-not-operational" in result["changedToNotOperational"]
        and "sporplan-status-operational" not in result["changedToNotOperational"],
        f"{label}: status change left a stale operational class"
    )
    require(
        "sporplan-status-operational" in result["changedBackToOperational"]
        and "sporplan-status-not-operational" not in result["changedBackToOperational"],
        f"{label}: navigation/readback left a stale not-operational class"
    )
    require(
        result["finalOperational"]["borderColor"] == "rgba(74, 222, 128, 0.78)",
        f"{label}: final Sporplan presentation did not return to green"
    )
    require(
        result["viewport"]["fixtureScrollWidth"]
        <= result["viewport"]["documentClientWidth"],
        f"{label}: status parity fixture causes horizontal overflow"
    )

require(not console_errors, "browser console errors: " + " | ".join(console_errors))
require(not page_errors, "browser page errors: " + " | ".join(page_errors))
require(not write_requests, "browser write requests: " + json.dumps(write_requests))

print(json.dumps({
    "ok": True,
    "viewports": [
        {
            "label": result["label"],
            "width": result["viewport"]["width"],
            "height": result["viewport"]["height"],
            "sporplanOperationalBorder":
                result["initial"]["sporplanOperational"]["borderColor"],
            "sporplanNotOperationalBorder":
                result["initial"]["sporplanNotOperational"]["borderColor"],
            "workshopOperationalBorder":
                result["initial"]["workshopOperational"]["borderColor"],
            "workshopNotOperationalBorder":
                result["initial"]["workshopNotOperational"]["borderColor"],
            "selectionOutline":
                result["initial"]["workshopOperational"]["outlineColor"],
        }
        for result in results
    ],
    "consoleErrors": console_errors,
    "pageErrors": page_errors,
    "writeRequests": write_requests,
}))
`;

  try {
    fs.writeFileSync(fixturePath, fixtureSource);
    fs.writeFileSync(runnerPath, pythonRunner);
    const result = childProcess.spawnSync("python3", [runnerPath, fixturePath], {
      encoding: "utf8",
      timeout: 120000,
      maxBuffer: 8 * 1024 * 1024,
    });
    assert.equal(
      result.status,
      0,
      [
        "rendered/computed status parity browser gate failed",
        result.stdout,
        result.stderr,
      ].filter(Boolean).join("\n"),
    );
    const report = JSON.parse(String(result.stdout || "").trim());
    assert.equal(report.ok, true, "rendered/computed status parity report is not green");
    assert.deepEqual(
      report.viewports.map(viewport => viewport.label),
      ["desktop", "mobile"],
      "desktop and mobile rendered gates must both execute",
    );
    return report;
  } finally {
    fs.rmSync(temporaryDirectory, {recursive: true, force: true});
  }
}

const renderedStatusParity = runRenderedStatusParityGate();

process.stdout.write(JSON.stringify({
  schemaVersion: "sde-status-parity-polling-harness-v2",
  contracts: {
    centralStatusModel: true,
    noWorkshopParallelFallback: true,
    pollingUpdatesCompleteSporplanPresentation: true,
    neutralVehicleIdentity: true,
    repairMetadataCannotOverrideMainStatus: true,
    selectionIndependent: true,
    renderedComputedStyle: true,
    desktopAndMobile: true,
    navigationLeavesNoStaleStatusClass: true,
    writeFree: true,
  },
  renderedStatusParity,
}) + "\n");
