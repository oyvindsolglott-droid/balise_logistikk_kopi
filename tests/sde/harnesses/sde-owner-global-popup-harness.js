"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../../..");
const source = fs.readFileSync(path.join(root, "index.html"), "utf8");
const {
  ALLOWED_IDENTITY_ROLES,
  resolveIdentityRoleBinding,
  validateIdentityRoleBindingsCatalog,
} = require(path.join(root, "server/src/identityRoleBindings.js"));
const {
  CAPABILITY_IDS,
  evaluateRuntimeAuthorization,
} = require(path.join(root, "server/src/runtimeAuthorization.js"));

function extractFunction(name){
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `missing ${name}`);
  const signatureEnd = source.slice(start).match(/\)\s*\{/);
  assert.ok(signatureEnd, `missing body for ${name}`);
  const open = start + signatureEnd.index + signatureEnd[0].lastIndexOf("{");
  let depth = 0;
  let quote = "";
  let escaped = false;
  for(let index = open; index < source.length; index += 1){
    const char = source[index];
    if(quote){
      if(escaped) escaped = false;
      else if(char === "\\") escaped = true;
      else if(char === quote) quote = "";
      continue;
    }
    if(char === "'" || char === '"' || char === "`"){
      quote = char;
      continue;
    }
    if(char === "{") depth += 1;
    if(char === "}" && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unclosed ${name}`);
}

const exactRoles = [
  "admin_pilot",
  "agila",
  "drops",
  "sde_skiftere",
  "txp",
  "verksted",
];
assert.deepEqual([...ALLOWED_IDENTITY_ROLES], exactRoles);

const catalog = validateIdentityRoleBindingsCatalog({
  bindings:[{
    bindingId:"owner-six-explicit-roles",
    subject:"owner-subject",
    expectedEmail:"owner@example.invalid",
    roles:exactRoles,
    enabled:true,
  }],
});
assert.equal(catalog.valid, true);
assert.equal(catalog.bindings.length, 1);
assert.deepEqual([...catalog.bindings[0].roles], exactRoles);
assert.equal(catalog.bindings[0].role, null);

const resolved = resolveIdentityRoleBinding({
  identityVerified:true,
  identityKind:"human",
  subject:"owner-subject",
  email:"owner@example.invalid",
}, catalog);
assert.equal(resolved.roleResolved, true);
assert.deepEqual([...resolved.roles], exactRoles);
assert.equal(resolved.runtimeRoleEnforcement, false);
assert.equal(resolved.writeAuthority, false);

for(const role of ["agila", "drops", "sde_skiftere", "txp", "verksted"]){
  const decision = evaluateRuntimeAuthorization({
    identity:{
      identityVerified:true,
      identityKind:"human",
      subject:"owner-subject",
    },
    roleResult:resolved,
    capability:CAPABILITY_IDS.SEND_OPERATIONAL_MESSAGE,
  });
  assert.equal(decision.allowed, true, `${role} must retain explicit message capability`);
  assert.equal(decision.capabilitySourceRoles.includes(role), true);
}
const override = evaluateRuntimeAuthorization({
  identity:{
    identityVerified:true,
    identityKind:"human",
    subject:"owner-subject",
  },
  roleResult:resolved,
  capability:CAPABILITY_IDS.OVERRIDE,
});
assert.equal(override.allowed, false);

const activeRoleFunction = extractFunction("getActiveOperationalMessageRole");
const messageLevelRoles = Object.freeze({
  "1":"drops",
  "2":"txp",
  "3":"sde_skiftere",
  "4":"verksted",
  "5":"agila",
});
const getActiveRole = (capabilities,level="1") => new Function(
  "OPERATIONAL_MESSAGE_ROLES",
  "OPERATIONAL_MESSAGE_LEVEL_ROLES",
  "getActiveAccessLevel",
  "dropsRuntimeCapabilities",
  `return (${activeRoleFunction})();`
)(
  ["drops","txp","sde_skiftere","verksted","agila"],
  messageLevelRoles,
  () => level,
  capabilities
);
for(const [level,role] of Object.entries(messageLevelRoles)){
  assert.equal(getActiveRole({
    ok:true,
    roleResolved:true,
    role,
    roles:[role]
  },level), role);
}
for(const capabilities of [
  null,
  {ok:false,roleResolved:true,role:"drops",roles:["drops"]},
  {ok:true,roleResolved:false,role:"drops",roles:["drops"]},
  {ok:true,roleResolved:true,role:"drops",roles:["txp"]},
  {ok:true,roleResolved:true,role:"admin_pilot",roles:["admin_pilot"]},
]){
  assert.equal(
    getActiveRole(capabilities),
    "",
    "only the selected server-confirmed operational role may activate messaging"
  );
}
assert.equal(
  getActiveRole({ok:true,roleResolved:true,role:null,roles:[...exactRoles]},"1"),
  "drops",
  "a multi-role identity must activate its selected server-confirmed role"
);

let activeLevel = "1";

const visibilityFunction = extractFunction(
  "isVehicleStatusNotificationVisibleInCurrentSurface"
);
assert.doesNotMatch(
  visibilityFunction,
  /getActiveTabName|\.tab\b/,
  "notification visibility must be level-wide, not tied to one module"
);
const roleSurfaces = Object.freeze({
  drops:{level:"1",tab:"dropsMateriellstyrer"},
  txp:{level:"2",tab:"grunnoppstilling"},
  sde_skiftere:{level:"3",tab:"sdeSkiftebevegelser"},
  verksted:{level:"4",tab:"verkstedBestillinger"},
  agila:{level:"5",tab:"agilia"},
});
const visibleAtLevel = new Function(
  "getActiveAccessLevel",
  "getActiveTabName",
  "OPERATIONAL_MESSAGE_ROLE_SURFACES",
  `return (${visibilityFunction});`
)(() => activeLevel, () => activeTab, roleSurfaces);
let activeTab = "oppstilling";

for(const [role,target] of Object.entries(roleSurfaces)){
  for(const tab of [
    "oppstilling",
    "sporplan",
    "sdeSkiftebevegelser",
    "dropsMateriellstyrer",
    "verkstedBestillinger",
    "agilia",
  ]){
    activeLevel = target.level;
    activeTab = tab;
    assert.equal(
      visibleAtLevel({kind:"OPERATIONAL_MESSAGE", targetRole:role}),
      true,
      `${role} message must be visible throughout level ${target.level} on ${tab}`
    );
  }
}

for(const [notification,level] of [
  [{kind:"WORKSHOP_EXIT_REQUESTED",targetRole:"txp"},"2"],
  [{kind:"WORKSHOP_EXIT_REQUESTED",targetRole:"drops"},"1"],
  [{kind:"REPAIR_REQUESTED",targetRole:"verksted"},"4"],
  [{kind:"WORKSHOP_INGRESS_REQUESTED",targetRole:"sde_skiftere"},"3"],
  [{kind:"CLEANING_TRACK_SPACE_REQUESTED",targetRole:"txp"},"2"],
  [{kind:"CLEANING_TRACK_SPACE_REQUESTED",targetRole:"drops"},"1"],
]){
  activeLevel = level;
  activeTab = "oppstilling";
  assert.equal(visibleAtLevel(notification), true);
  activeLevel = level === "1" ? "2" : "1";
  assert.equal(visibleAtLevel(notification), false);
}

assert.equal(
  (source.match(/vehicleStatusNotificationHost/g) || []).length > 0,
  true
);
assert.match(
  extractFunction("renderVehicleStatusNotificationPopup"),
  /getNextVehicleStatusNotification\(\)/
);

console.log(JSON.stringify({
  schemaVersion:"sde-owner-global-popup-harness-v1",
  tests:62,
  explicitRoles:exactRoles,
}));
