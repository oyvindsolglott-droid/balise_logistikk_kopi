"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {buildInventory,validate} = require("../../../scripts/sde-vehicle-id-inventory.cjs");

const indexPath = path.resolve(process.argv[2]);
const source = fs.readFileSync(indexPath,"utf8");
const rootIndexPath = path.resolve(__dirname,"../../../index.html");
const report = buildInventory({
  sourceOverrides:indexPath === rootIndexPath ? undefined : new Map([["index.html",source]])
});
const policy = validate(report);
const results = [];
const put = (id,pass,detail)=>results.push({id,status:pass?"PASS":"FAIL",detail:String(detail||"")});

put("INV-VEHICLE-ID-POLICY-001",policy.ok,policy.errors.join("; ")||"all exact vehicleId occurrences classified and no production behavior branch remains");
put("INV-VEHICLE-ID-POLICY-002",report.unclassifiedVehicleIdOccurrences===0,`unknown=${report.unclassifiedVehicleIdOccurrences}`);
put("INV-VEHICLE-ID-POLICY-003",report.vehicleSpecificBehaviorRules===0,`behavior=${report.vehicleSpecificBehaviorRules}`);
put("INV-VEHICLE-ID-POLICY-004",report.productionHistoricalFixtureImports.length===0,JSON.stringify(report.productionHistoricalFixtureImports));
put("INV-VEHICLE-ID-POLICY-005",!source.includes('vehicle === "74-20"')&&!source.includes('vehicle === "74-06"')&&!source.includes("74-24\\b/.test(detail)"),"known exact-ID decision anchors are absent");
put("INV-VEHICLE-ID-POLICY-006",source.includes("need?.preferredServiceSlot")&&source.includes("need?.platformParkingSlot"),"individual operational differences are supplied by semantic fields");

process.stdout.write(`${JSON.stringify({schemaVersion:"sde-vehicle-id-policy-invariants-v1",category:"vehicle-id-policy",results})}\n`);
process.exitCode=results.some(item=>item.status==="FAIL")?1:0;
