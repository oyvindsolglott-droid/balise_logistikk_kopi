"use strict";

const fs = require("node:fs");
const path = require("node:path");

const indexPath = path.resolve(process.argv[2]);
const source = fs.readFileSync(indexPath, "utf8");
const results = [];

function invariant(id, description, test){
  try{
    if(!test()) throw new Error(description);
    results.push({id, status:"PASS", description});
  }catch(error){
    results.push({id, status:"FAIL", description, error:String(error?.message || error)});
  }
}

const model = source.match(/const TURSATT_COLUMN_MODEL = Object\.freeze\(\[([\s\S]*?)\n\]\);/)?.[1] || "";
const build = source.match(/function buildOppstilling\(\)\{([\s\S]*?)\n\}\n\nfunction /)?.[1] || "";
const fragmentBuild = source.match(/function createTursattTableFragment\(viewModel\)\{([\s\S]*?)\n\}\n\nfunction /)?.[1] || "";

invariant("INV-TURSATT-ALIGN-001", "Tursatt has one semantic table and no cloned header tree", () =>
  (source.match(/id="oppstillingTable"/g) || []).length === 1
  && !source.includes("oppstillingMobileHeader")
  && !source.includes("oppstillingMobileHeaderTable")
);

invariant("INV-TURSATT-ALIGN-002", "one immutable fourteen-column model owns desktop and mobile widths", () =>
  (model.match(/Object\.freeze\(\{id:/g) || []).length === 14
  && (model.match(/group:"arrival"/g) || []).length === 7
  && (model.match(/group:"departure"/g) || []).length === 7
  && JSON.stringify([...model.matchAll(/track:"(\d+%)"/g)].map(match => match[1]))
    === JSON.stringify(["7%","8%","11%","5%","3%","11%","5%","7%","8%","11%","5%","3%","11%","5%"])
);

invariant("INV-TURSATT-ALIGN-003", "the canonical colgroup is installed before the single thead", () =>
  fragmentBuild.indexOf("appendTursattCanonicalColgroup(fragment);") >= 0
  && fragmentBuild.indexOf("appendTursattCanonicalColgroup(fragment);") < fragmentBuild.indexOf('document.createElement("thead")')
  && source.includes("col.dataset.tursattColumn = column.id;")
  && source.includes("col.style.width = column.track;")
);

invariant("INV-TURSATT-ALIGN-004", "group and leaf headers retain exact semantic spans", () =>
  source.includes('thArr.scope="colgroup";')
  && source.includes('thDep.scope="colgroup";')
  && source.includes("thArr.colSpan=7;")
  && source.includes("thDep.colSpan=7;")
  && source.includes('th.scope="col";')
  && source.includes("th.dataset.tursattColumn=column.id;")
);

invariant("INV-TURSATT-ALIGN-005", "body cells use the same seven-plus-seven column sequence", () =>
  fragmentBuild.includes('appendOppstillingSideCells(tr, viewModel.arrivalRows[i] || null, "arrival");')
  && fragmentBuild.includes('appendOppstillingSideCells(tr, viewModel.departureRows[i] || null, "departure");')
  && fragmentBuild.includes("if(index < 7) cell.classList.add")
  && fragmentBuild.includes("if(index >= 7) cell.classList.add")
);

invariant("INV-TURSATT-ALIGN-006", "Tursatt table has fixed layout without a table-local horizontal offset", () => {
  const css = source.match(/#oppstillingTable\{([\s\S]*?)\n\}/)?.[1] || "";
  return css.includes("table-layout:fixed;")
    && css.includes("width:100%;")
    && !/#oppstillingTable[^\{]*\{[^\}]*transform\s*:/s.test(source);
});

invariant("INV-TURSATT-ALIGN-007", "closure revision date is 20 August 2026", () =>
  source.includes("Siste revisjon: 20. august 2026")
  && !source.includes("Siste revisjon: 19. august 2026")
);

const failed = results.filter(result => result.status === "FAIL");
process.stdout.write(`${JSON.stringify({
  schemaVersion:"sde-tursatt-alignment-invariants-v1",
  counts:{total:results.length, pass:results.length - failed.length, fail:failed.length},
  results,
})}\n`);
process.exitCode = failed.length ? 1 : 0;
