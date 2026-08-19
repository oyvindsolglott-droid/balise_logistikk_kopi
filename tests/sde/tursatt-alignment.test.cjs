"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "../..");
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");

test("Tursatt bruker én semantisk tabell og én canonical kolonnemodell", () => {
  assert.equal((html.match(/id="oppstillingTable"/g) || []).length, 1);
  assert.equal(html.includes('id="oppstillingMobileHeaderTable"'), false);
  assert.equal(html.includes("buildOppstillingMobileHeader"), false);
  assert.match(html, /TURSATT_COLUMN_MODEL/);
  assert.match(html, /document\.createElement\("colgroup"\)/);
});

test("Tursatt-layouten har ingen desktop-offset eller separat headerspor", () => {
  assert.equal(/#oppstillingTable[^}]*transform\s*:\s*translateX/i.test(html), false);
  assert.equal(/oppstillingMobileHeader/.test(html), false);
  assert.match(html, /table-layout\s*:\s*fixed/);
});
