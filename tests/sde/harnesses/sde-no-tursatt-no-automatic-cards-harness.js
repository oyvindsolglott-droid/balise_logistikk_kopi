"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const base = fs.readFileSync(path.join(__dirname, "sde-canonical-buttspor-vn-chain-t-harness.js"), "utf8");
const prefix = base.slice(0, base.indexOf("const chain10"));

eval(prefix + String.raw`
(()=>{
  const placements = [["5N","74-12"],["5M","74-41"],["5S","70-06"],["11S","74-10"]];
  resetState(placements);

  const physicalEngineResult = ctx.buildSdeAutomaticTrappedReadinessMoves([]);
  assert.equal(physicalEngineResult.length,1,"the physical chain engine must remain available for an operational order");

  const noTursatt = ctx.buildSdeLimitedPlanningData("FRESH_NO_TURSATT_ASSIGNMENTS","Ingen tursatte bevegelser");
  assert.equal(noTursatt.automaticMoveCount,0,"no tursatt assignments must produce zero automatic main plans");
  assert.equal(
    noTursatt.moves.some(row=>ctx.isSdeAutomaticTrappedReadinessMove(row)),
    false,
    "physical occupancy alone must not become an operative automatic order"
  );
  assert.equal(
    ctx.buildSdeLimitedPlanningCardsHtml(noTursatt).includes("Automatisk fysisk plan"),
    false,
    "no automatic release/main/recovery cards may appear after the operational work is finished"
  );

  const notReady = ctx.buildSdeLimitedPlanningData("DATA_NOT_FRESH","Datagrunnlag ikke klart");
  assert.equal(notReady.automaticMoveCount,0,"incomplete tursatt context must also fail closed without automatic orders");

  console.log(JSON.stringify({
    schemaVersion:"sde-no-tursatt-no-automatic-cards-harness-v1",
    status:"PASS",
    physicalEngineCandidates:physicalEngineResult.length,
    noTursattAutomaticMoves:noTursatt.automaticMoveCount,
    notReadyAutomaticMoves:notReady.automaticMoveCount
  }));
})();
`);
