"use strict";

const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const {
  createSharedSporplanDeleteCapabilityGuard,
  buildAuthorizedSharedSporplanDeletePayload,
  isSharedSporplanDeletePayload
} = require("../src/sharedSporplanDeleteAuthority");
const { createSchemaSql } = require("../src/schema");
const { getSharedSporplanDraft, saveSharedSporplanDraft } = require("../src/sharedSporplanDraft");

const RESET_PAYLOAD = Object.freeze({
  expectedRevision: 1,
  draft:{grunnoppstilling:{__shared_sporplan_reset__:"SDE-SYNC-M"}, grunnoppstillingRep:{}},
  audit:{actor:"untrusted-client", device:"browser", clientContext:{sharedReset:false}}
});

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

async function main(){
  assert.equal(isSharedSporplanDeletePayload(RESET_PAYLOAD), true, "reset marker must trigger authority independently of client audit flags");
  assert.equal(isSharedSporplanDeletePayload({
    ...RESET_PAYLOAD,
    draft:{grunnoppstilling:{"5M":"74-54"}, grunnoppstillingRep:{}}
  }), false, "ordinary shared-draft writes must not be classified as delete");

  const identity = Object.freeze({
    identityVerified:true,
    identityKind:"human",
    subject:"access-subject-1",
    email:"txp@example.invalid"
  });
  const catalog = {
    bindings:[{
      bindingId:"txp-test-binding",
      subject:identity.subject,
      expectedEmail:identity.email,
      roles:["txp"],
      enabled:true
    }]
  };

  const guard = createSharedSporplanDeleteCapabilityGuard({
    env:{},
    roleBindingsCatalog:catalog,
    verifyIdentityRequest:async()=>({ok:true, identity})
  });
  const authorizedRequest = {headers:{}, body:RESET_PAYLOAD};
  const authorizedResponse = responseDouble();
  let nextCalls = 0;
  await guard(authorizedRequest, authorizedResponse, ()=>{ nextCalls += 1; });
  assert.equal(nextCalls, 1, "authorized TXP must reach revisioned persistence");
  assert.equal(authorizedResponse.statusCode, null);
  assert.equal(authorizedRequest.sdeSharedSporplanDeleteIdentity.subject, identity.subject);
  assert.equal(authorizedRequest.sdeSharedSporplanDeleteIdentity.capability, "input_sporplan.delete");
  assert.deepEqual(authorizedRequest.sdeSharedSporplanDeleteIdentity.roles, ["txp"]);

  const denied = createSharedSporplanDeleteCapabilityGuard({
    env:{},
    roleBindingsCatalog:{bindings:[{bindingId:"drops-test", subject:identity.subject, roles:["drops"], enabled:true}]},
    verifyIdentityRequest:async()=>({ok:true, identity})
  });
  const deniedResponse = responseDouble();
  await denied({headers:{}, body:RESET_PAYLOAD}, deniedResponse, ()=>assert.fail("DROPS must not pass delete guard"));
  assert.equal(deniedResponse.statusCode, 403);
  assert.equal(deniedResponse.body.error, "input_sporplan_delete_capability_denied");

  const unauthenticated = createSharedSporplanDeleteCapabilityGuard({
    env:{}, roleBindingsCatalog:catalog,
    verifyIdentityRequest:async()=>({ok:false, status:401, publicError:"authentication_required"})
  });
  const unauthenticatedResponse = responseDouble();
  await unauthenticated({headers:{}, body:RESET_PAYLOAD}, unauthenticatedResponse, ()=>assert.fail("unverified identity must fail closed"));
  assert.equal(unauthenticatedResponse.statusCode, 401);

  const unavailable = createSharedSporplanDeleteCapabilityGuard({
    env:{}, roleBindingsCatalog:catalog,
    verifyIdentityRequest:async()=>{ throw new Error("verifier unavailable"); }
  });
  const unavailableResponse = responseDouble();
  await unavailable({headers:{}, body:RESET_PAYLOAD}, unavailableResponse, ()=>assert.fail("verification outage must fail closed"));
  assert.equal(unavailableResponse.statusCode, 503);

  const authorizedPayload = buildAuthorizedSharedSporplanDeletePayload(
    RESET_PAYLOAD,
    authorizedRequest.sdeSharedSporplanDeleteIdentity
  );
  assert.equal(authorizedPayload.audit.actor, identity.subject, "server identity must replace client actor");
  assert.equal(authorizedPayload.audit.clientContext.verifiedCapability, "input_sporplan.delete");
  assert.deepEqual(authorizedPayload.audit.clientContext.verifiedRoles, ["txp"]);
  assert.equal(authorizedPayload.audit.clientContext.roleBindingId, "txp-test-binding");

  const db = new DatabaseSync(":memory:");
  try{
    db.exec(createSchemaSql());
    const initial = saveSharedSporplanDraft(db, {
      expectedRevision:0,
      draft:{grunnoppstilling:{"5M":"74-54"}, grunnoppstillingRep:{}},
      audit:{actor:"seed", device:"test", clientContext:{source:"isolated-test"}}
    }, "2026-08-19T05:00:00.000Z");
    assert.equal(initial.ok, true);
    const deleted = saveSharedSporplanDraft(db, authorizedPayload, "2026-08-19T05:01:00.000Z");
    assert.equal(deleted.ok, true);
    assert.equal(deleted.readback.revision, 2);
    assert.deepEqual(deleted.readback.draft, RESET_PAYLOAD.draft);
    assert.equal(deleted.readback.audit.updatedByActor, identity.subject);
    assert.equal(deleted.readback.audit.clientContext.verifiedCapability, "input_sporplan.delete");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM events").get().count, 0, "delete contract must not write operational events");
    const replay = saveSharedSporplanDraft(db, authorizedPayload, "2026-08-19T05:02:00.000Z");
    assert.equal(replay.ok, false, "stale replay must not repeat deletion");
    assert.equal(replay.code, "revision_conflict");
    assert.deepEqual(getSharedSporplanDraft(db), deleted.readback, "fresh readback must remain canonical");
  }finally{
    db.close();
  }

  console.log("SDE Input Sporplan delete authority tests OK");
}

function responseDouble(){
  return {
    statusCode:null,
    body:null,
    status(value){ this.statusCode = value; return this; },
    json(value){ this.body = value; return this; }
  };
}
