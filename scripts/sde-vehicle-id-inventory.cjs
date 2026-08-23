#!/usr/bin/env node
"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const inventoryRelativePath = "artifacts/sde-vehicle-id-inventory.json";
const inventoryPath = path.join(root, inventoryRelativePath);
const vehiclePattern = /(?<![0-9A-Z])(?:69|70|72|74|75)-\d{2}/g;
const classifications = new Set([
  "VALIDATION_CATALOG",
  "CURRENT_OR_HISTORICAL_DATA",
  "TEST_FIXTURE",
  "UI_DISPLAY_EXAMPLE",
  "IDENTITY_LOOKUP",
  "SEMANTIC_ATTRIBUTE_DERIVATION",
  "VEHICLE_SPECIFIC_BEHAVIOR_RULE",
  "UNKNOWN",
]);

function listFiles(){
  return childProcess.execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {cwd:root})
    .toString("utf8").split("\0").filter(Boolean)
    .filter(file=>file !== inventoryRelativePath);
}

function isBinary(buffer){
  return buffer.includes(0);
}

function isTestFixture(file){
  const name = path.basename(file);
  return file.startsWith("tests/") || file.startsWith("server/scripts/test-") ||
    /^test_.*\.(?:py|js|cjs)$/.test(name) || /_test(?:_|\.)/.test(name) ||
    ["decision_test.html","sde_scenarios.py"].includes(name);
}

function isCurrentOrHistoricalData(file){
  const name = path.basename(file);
  return file.startsWith("data/") || file.startsWith("archive_7_0/") ||
    ["sde_input_snapshot.json","sde_togplassering_test_2026_05_18.json"].includes(name) ||
    /^sde_togplassering_.*\.(?:json|txt)$/.test(name);
}

function isDocumentation(file){
  return file.startsWith("docs/") || /(?:^|\/)README\.md$/.test(file);
}

function surroundingSymbol(lines, lineIndex, file){
  const patterns = file.endsWith(".py")
    ? [/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/, /^\s*class\s+([A-Za-z_]\w*)/]
    : [/^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/, /^\s*class\s+([A-Za-z_$][\w$]*)/];
  for(let index=lineIndex; index>=Math.max(0,lineIndex-300); index-=1){
    for(const pattern of patterns){
      const match = lines[index].match(pattern);
      if(match) return match[1];
    }
  }
  return `file:${path.basename(file)}`;
}

function classify(file, symbol, line){
  if(isTestFixture(file)) return "TEST_FIXTURE";
  if(isCurrentOrHistoricalData(file)) return "CURRENT_OR_HISTORICAL_DATA";
  if(isDocumentation(file)) return "UI_DISPLAY_EXAMPLE";
  if(file === "server/src/vehicleRegistry.js") return "VALIDATION_CATALOG";
  if(file === "server/src/index.js" && symbol === "vehicleStatusLifecycleAllowedVehicleIds") return "TEST_FIXTURE";
  if(file === "index.html" && (
    /(?:VALID_.*VEHICLES|VALID_.*SETS|VEHICLE_CATALOG|VehicleCatalog|VehicleNumberValidation)/i.test(symbol) ||
    /Ugyldig kjøretøynummer:/.test(line)
  )) return "VALIDATION_CATALOG";
  return "UNKNOWN";
}

function metadataFor(classification){
  if(classification === "VALIDATION_CATALOG") return {action:"preserve",replacement:"none",testCoverage:"SDE-NO-EXACT-VEHICLE-ID-BEHAVIOR-POLICY + vehicle validation tests"};
  if(classification === "CURRENT_OR_HISTORICAL_DATA") return {action:"preserve_as_data",replacement:"none",testCoverage:"data provenance and fixture isolation policy"};
  if(classification === "TEST_FIXTURE") return {action:"preserve_test_only",replacement:"none",testCoverage:"fixture isolation + owning regression harness"};
  if(classification === "UI_DISPLAY_EXAMPLE") return {action:"preserve_non_authoritative",replacement:"none",testCoverage:"static policy classification"};
  if(classification === "IDENTITY_LOOKUP") return {action:"preserve_identity_only",replacement:"none",testCoverage:"identity linkage tests"};
  if(classification === "SEMANTIC_ATTRIBUTE_DERIVATION") return {action:"preserve_authoritative_semantics",replacement:"none",testCoverage:"semantic-state invariance"};
  return {action:"remove_before_release",replacement:"semantic fields or topology",testCoverage:"policy must fail closed"};
}

function runtimeReachable(file, classification){
  if(classification === "TEST_FIXTURE" || classification === "UI_DISPLAY_EXAMPLE") return false;
  if(file.startsWith("archive_7_0/")) return false;
  return classification === "VALIDATION_CATALOG" || file === "index.html" || file.startsWith("server/src/") || file.startsWith("data/");
}

function buildInventory(options={}){
  const sourceOverrides = options?.sourceOverrides instanceof Map
    ? options.sourceOverrides
    : new Map(Object.entries(options?.sourceOverrides || {}));
  const readSourceBuffer = file=>sourceOverrides.has(file)
    ? Buffer.from(String(sourceOverrides.get(file)),"utf8")
    : fs.readFileSync(path.join(root,file));
  const readSourceText = file=>readSourceBuffer(file).toString("utf8");
  const occurrences = [];
  const scannedComponents = new Set();
  const binaryFiles = [];
  for(const file of listFiles()){
    const absolute = path.join(root,file);
    if(!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) continue;
    const buffer = readSourceBuffer(file);
    if(isBinary(buffer)){
      binaryFiles.push(file);
      continue;
    }
    const text = buffer.toString("utf8");
    const lines = text.split(/\r?\n/);
    scannedComponents.add(file.split("/")[0]);
    lines.forEach((line,lineIndex)=>{
      vehiclePattern.lastIndex = 0;
      for(const match of line.matchAll(vehiclePattern)){
        const symbol = surroundingSymbol(lines,lineIndex,file);
        const classification = classify(file,symbol,line);
        const meta = metadataFor(classification);
        occurrences.push({
          file,
          line:lineIndex+1,
          column:match.index+1,
          literal:match[0],
          surroundingSymbol:symbol,
          classification,
          runtimeReachable:runtimeReachable(file,classification),
          plannerRelevant:file === "index.html" && classification !== "VALIDATION_CATALOG",
          action:meta.action,
          replacement:meta.replacement,
          testCoverage:meta.testCoverage,
        });
      }
    });
  }
  const distribution = Object.fromEntries([...classifications].map(name=>[name,occurrences.filter(item=>item.classification===name).length]));
  const productionImports = listFiles().filter(file=>file !== "scripts/sde-vehicle-id-inventory.cjs" && /\.(?:js|cjs|mjs|py|html)$/.test(file) && !isTestFixture(file) && !isCurrentOrHistoricalData(file) && !isDocumentation(file))
    .flatMap(file=>{
      const source = readSourceText(file);
      return source.split(/\r?\n/).flatMap((line,index)=>/\b(?:import|require|fetch)\b/.test(line) && /(?:tests?\/fixtures|sde_scenarios)/.test(line)
        ? [{file,line:index+1,text:line.trim()}]
        : []);
    });
  return {
    schemaVersion:"sde-vehicle-id-inventory-v1",
    policyId:"SDE-NO-EXACT-VEHICLE-ID-BEHAVIOR-POLICY",
    generatedFrom:"working-tree",
    scannedFileCount:listFiles().length,
    scannedComponents:[...scannedComponents].sort(),
    skippedBinaryFiles:binaryFiles.sort(),
    totalExactVehicleIdOccurrences:occurrences.length,
    classificationDistribution:distribution,
    unclassifiedVehicleIdOccurrences:distribution.UNKNOWN,
    vehicleSpecificBehaviorRules:distribution.VEHICLE_SPECIFIC_BEHAVIOR_RULE,
    productionHistoricalFixtureImports:productionImports,
    occurrences,
  };
}

function pythonAstReport(){
  const run = childProcess.spawnSync("python3", [path.join(root,"scripts/sde-no-exact-vehicle-id-ast.py")], {cwd:root,encoding:"utf8"});
  let report = null;
  try{ report = JSON.parse(String(run.stdout || "").trim()); }catch{}
  return {status:run.status,stderr:String(run.stderr || "").trim(),report};
}

function validate(report){
  const python = pythonAstReport();
  const errors = [];
  if(report.unclassifiedVehicleIdOccurrences !== 0) errors.push(`${report.unclassifiedVehicleIdOccurrences} unclassified exact vehicleId occurrences`);
  if(report.vehicleSpecificBehaviorRules !== 0) errors.push(`${report.vehicleSpecificBehaviorRules} exact vehicleId behavior rules`);
  if(report.productionHistoricalFixtureImports.length) errors.push("production imports historical fixture data");
  if(python.status !== 0 || python.stderr || !python.report || python.report.violations?.length) errors.push("Python AST policy found an exact vehicleId branch or parse failure");
  return {ok:errors.length===0,errors,pythonAst:python.report};
}

if(require.main === module){
  const report = buildInventory();
  const validation = validate(report);
  const output = {...report,validation};
  if(process.argv.includes("--write")){
    fs.mkdirSync(path.dirname(inventoryPath),{recursive:true});
    fs.writeFileSync(inventoryPath,`${JSON.stringify(output,null,2)}\n`);
  }
  process.stdout.write(`${JSON.stringify({
    policyId:output.policyId,
    totalExactVehicleIdOccurrences:output.totalExactVehicleIdOccurrences,
    classificationDistribution:output.classificationDistribution,
    unclassifiedVehicleIdOccurrences:output.unclassifiedVehicleIdOccurrences,
    vehicleSpecificBehaviorRules:output.vehicleSpecificBehaviorRules,
    productionHistoricalFixtureImports:output.productionHistoricalFixtureImports.length,
    pythonAstFiles:output.validation.pythonAst?.parsedFiles ?? null,
    status:validation.ok?"PASS":"FAIL",
    errors:validation.errors,
  })}\n`);
  process.exitCode = validation.ok ? 0 : 1;
}

module.exports = {buildInventory,validate,inventoryPath};
