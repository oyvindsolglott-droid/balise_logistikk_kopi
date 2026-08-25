#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {DatabaseSync} = require("node:sqlite");
const {
  Worker,
  isMainThread,
  parentPort,
  workerData,
} = require("node:worker_threads");

const root = path.resolve(__dirname, "../../..");
const frontend = fs.readFileSync(path.join(root, "index.html"), "utf8");
const lifecycle = require(path.join(root, "server/src/vehicleStatusLifecycle.js"));
const authorization = require(path.join(root, "server/src/runtimeAuthorization.js"));
const {
  createVehicleStatusTestRepository,
} = require(path.join(root, "server/src/vehicleStatusTestRepository.js"));

const sender = Object.freeze({
  subject:"sender-subject",
  effectiveRole:"drops",
  roles:["drops"],
  capabilitySourceRoles:["drops"],
});
const sameRoleDifferentSubject = Object.freeze({
  ...sender,
  subject:"different-sender-subject",
});
const receiver = Object.freeze({
  subject:"receiver-subject",
  effectiveRole:"txp",
  roles:["txp"],
  capabilitySourceRoles:["txp"],
});

function fixedUuid(number, workerMarker = "8000"){
  return `99000000-0000-4000-${workerMarker}-${String(number).padStart(12,"0")}`;
}

function createScenario(options = {}){
  let currentTime = options.time || "2026-08-25T10:00:00.000Z";
  let uuid = options.uuidStart || 1;
  const db = options.db || new DatabaseSync(":memory:");
  const repository = createVehicleStatusTestRepository({
    db,
    now:() => currentTime,
    randomUUID:() => fixedUuid(uuid++),
  });
  return {
    db,
    repository,
    now:() => currentTime,
    setTime:value => { currentTime = value; },
  };
}

function normalize(name, input, sourceRole){
  const normalized = lifecycle.normalizeLifecycleCommand(name, input, {sourceRole});
  assert.equal(normalized.ok, true, JSON.stringify(normalized));
  return normalized.value;
}

function execute(scenario, name, input, authority, sourceRole = authority.effectiveRole){
  return scenario.repository.executeCommand(
    name,
    normalize(name, input, sourceRole),
    authority,
  );
}

function sendMessage(scenario, id, authority = sender, overrides = {}){
  return execute(
    scenario,
    lifecycle.LIFECYCLE_COMMANDS.SEND_OPERATIONAL_MESSAGE,
    {
      actionId:id,
      messageId:id,
      targetRole:authority.effectiveRole === "drops" ? "txp" : "drops",
      message:`Autoritativ testmelding ${id.slice(-4)}`,
      context:{surface:authority.effectiveRole},
      ...overrides,
    },
    authority,
  );
}

function withdrawMessage(scenario, actionId, messageId, authority = sender){
  return execute(
    scenario,
    lifecycle.LIFECYCLE_COMMANDS.WITHDRAW_OPERATIONAL_MESSAGE,
    {actionId, messageId},
    authority,
  );
}

function startReply(scenario, actionId, messageId, recipientSessionId){
  return execute(
    scenario,
    lifecycle.LIFECYCLE_COMMANDS.START_OPERATIONAL_MESSAGE_REPLY,
    {actionId, messageId, recipientSessionId},
    receiver,
  );
}

function assertBlocked(result, error, status = 409){
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.status, status, JSON.stringify(result));
  assert.equal(result.error, error, JSON.stringify(result));
}

function messageFrom(readback, messageId){
  const message = readback.operationalMessages.find(item => item.messageId === messageId);
  assert.ok(message, `missing message ${messageId}`);
  return message;
}

function runContractTests(){
  assert.equal(
    lifecycle.LIFECYCLE_COMMANDS.START_OPERATIONAL_MESSAGE_REPLY,
    "start_operational_message_reply",
  );
  assert.equal(
    lifecycle.LIFECYCLE_COMMANDS.WITHDRAW_OPERATIONAL_MESSAGE,
    "withdraw_operational_message",
  );
  assert.equal(
    authorization.CAPABILITY_IDS.START_OPERATIONAL_MESSAGE_REPLY,
    "vehicle_status.start_operational_message_reply",
  );
  assert.equal(
    authorization.CAPABILITY_IDS.WITHDRAW_OPERATIONAL_MESSAGE,
    "vehicle_status.withdraw_operational_message",
  );

  // No receiver reaction: withdrawal succeeds and becomes a redacted tombstone everywhere.
  const noReceiver = createScenario();
  const rootMessageId = fixedUuid(101);
  const originalText = "Originalen skal bevares i autoritativ lagring";
  const sent = sendMessage(noReceiver, rootMessageId, sender, {message:originalText});
  assert.equal(sent.ok, true, JSON.stringify(sent));
  const withdrawn = withdrawMessage(noReceiver, fixedUuid(102), rootMessageId);
  assert.equal(withdrawn.ok, true, JSON.stringify(withdrawn));
  assert.equal(withdrawn.result.eventType, "MESSAGE_WITHDRAWN");
  for(const roles of [["drops"], ["txp"]]){
    const tombstone = messageFrom(noReceiver.repository.getReadModel({roles}), rootMessageId);
    assert.equal(tombstone.message, "");
    assert.equal(tombstone.deliveryState, "withdrawn");
    assert.equal(tombstone.withdrawnAt, withdrawn.result.withdrawnAt);
  }
  const storage = noReceiver.repository.getStorageSnapshot();
  const storedOriginal = storage.operationalMessages.find(row => row.message_id === rootMessageId);
  assert.equal(storedOriginal.message_text, originalText);
  assert.equal(storedOriginal.created_at, sent.result.createdAt);
  assert.equal(storage.operationalMessageLifecycleEvents.length, 1);
  assert.deepEqual(
    JSON.parse(storage.operationalMessageLifecycleEvents[0].payload_json),
    {
      sentAt:sent.result.createdAt,
      withdrawalDeadline:withdrawn.result.withdrawalDeadline,
      originalMessagePreservedInAuthoritativeStore:true,
    },
  );
  const withdrawnNotification = noReceiver.repository
    .getReadModel({roles:["txp"]})
    .notifications.find(item => item.payload?.messageId === rootMessageId);
  assert.equal(withdrawnNotification.payload.message, "");
  assert.equal(withdrawnNotification.withdrawnAt, withdrawn.result.withdrawnAt);
  assertBlocked(
    withdrawMessage(noReceiver, fixedUuid(103), rootMessageId),
    "message_already_withdrawn",
  );
  noReceiver.db.close();

  // The deadline is server time, not a client countdown decision.
  const expired = createScenario();
  const expiredId = fixedUuid(201);
  sendMessage(expired, expiredId);
  expired.setTime("2026-08-25T10:01:00.000Z");
  assertBlocked(
    withdrawMessage(expired, fixedUuid(202), expiredId),
    "message_undo_deadline_expired",
  );
  expired.db.close();

  // Reply-start is one semantic event per message/session and persists no draft text.
  const replyStarted = createScenario();
  const replyStartedId = fixedUuid(301);
  const sessionA = fixedUuid(302);
  sendMessage(replyStarted, replyStartedId);
  const firstStart = startReply(replyStarted, fixedUuid(303), replyStartedId, sessionA);
  const retryStart = startReply(replyStarted, fixedUuid(304), replyStartedId, sessionA);
  assert.equal(firstStart.ok, true, JSON.stringify(firstStart));
  assert.equal(firstStart.result.alreadyRecorded, false);
  assert.equal(retryStart.ok, true, JSON.stringify(retryStart));
  assert.equal(retryStart.result.alreadyRecorded, true);
  assert.equal(retryStart.result.lifecycleEventId, firstStart.result.lifecycleEventId);
  const startedRows = replyStarted.repository.getStorageSnapshot()
    .operationalMessageLifecycleEvents;
  assert.equal(startedRows.length, 1);
  assert.deepEqual(JSON.parse(startedRows[0].payload_json), {draftTextPersisted:false});
  assert.equal(startedRows[0].recipient_session_id, sessionA);
  assertBlocked(
    withdrawMessage(replyStarted, fixedUuid(305), replyStartedId),
    "message_reply_already_started",
  );
  replyStarted.db.close();

  // One of several recipient sessions reacts: withdrawal is globally blocked.
  const multiSession = createScenario();
  const multiSessionId = fixedUuid(401);
  sendMessage(multiSession, multiSessionId);
  startReply(multiSession, fixedUuid(402), multiSessionId, fixedUuid(403));
  assertBlocked(
    withdrawMessage(multiSession, fixedUuid(404), multiSessionId),
    "message_reply_already_started",
  );
  assert.equal(
    multiSession.repository.getStorageSnapshot().operationalMessageLifecycleEvents.length,
    1,
  );
  multiSession.db.close();

  // A sent reply is an independent permanent blocker.
  const replySent = createScenario();
  const replyParentId = fixedUuid(501);
  const parent = sendMessage(replySent, replyParentId);
  assert.equal(parent.ok, true, JSON.stringify(parent));
  const replyId = fixedUuid(502);
  assert.equal(sendMessage(replySent, replyId, receiver, {
    threadId:parent.result.threadId,
    rootMessageId:parent.result.rootMessageId,
    parentMessageId:replyParentId,
    message:"Ferdig svar",
  }).ok, true);
  assertBlocked(
    withdrawMessage(replySent, fixedUuid(503), replyParentId),
    "message_reply_already_sent",
  );
  replySent.db.close();

  // Existing acknowledgement is reused as the authority, not duplicated.
  const acknowledged = createScenario();
  const acknowledgedId = fixedUuid(601);
  const acknowledgedSent = sendMessage(acknowledged, acknowledgedId);
  assert.equal(execute(
    acknowledged,
    lifecycle.LIFECYCLE_COMMANDS.ACKNOWLEDGE_OPERATIONAL_MESSAGE,
    {
      actionId:fixedUuid(602),
      messageId:acknowledgedId,
      notificationId:acknowledgedSent.result.notificationId,
    },
    receiver,
  ).ok, true);
  assertBlocked(
    withdrawMessage(acknowledged, fixedUuid(603), acknowledgedId),
    "message_already_acknowledged",
  );
  acknowledged.db.close();

  // Existing presentation+dismissal tables remain the one authority for that reaction.
  const dismissed = createScenario();
  const dismissedId = fixedUuid(701);
  const dismissedSent = sendMessage(dismissed, dismissedId);
  assert.equal(execute(
    dismissed,
    lifecycle.LIFECYCLE_COMMANDS.NOTIFICATION_PRESENTED,
    {
      actionId:fixedUuid(702),
      notificationId:dismissedSent.result.notificationId,
    },
    receiver,
  ).ok, true);
  assert.equal(execute(
    dismissed,
    lifecycle.LIFECYCLE_COMMANDS.DISMISS_OPERATIONAL_MESSAGE_AFTER_AUTO_PRESENTATION,
    {
      actionId:fixedUuid(703),
      messageId:dismissedId,
      recipientSessionId:fixedUuid(704),
    },
    receiver,
  ).ok, true);
  assertBlocked(
    withdrawMessage(dismissed, fixedUuid(705), dismissedId),
    "message_already_dismissed_after_auto_presentation",
  );
  dismissed.db.close();

  // Same role is insufficient: the authenticated actor subject must be the original sender.
  const actorBound = createScenario();
  const actorBoundId = fixedUuid(801);
  sendMessage(actorBound, actorBoundId);
  assertBlocked(
    withdrawMessage(actorBound, fixedUuid(802), actorBoundId, sameRoleDifferentSubject),
    "message_source_actor_mismatch",
    403,
  );
  actorBound.db.close();

  // Root and reply withdrawals both work; later messages keep stable chronological order.
  const thread = createScenario();
  const threadRootId = fixedUuid(901);
  const threadRoot = sendMessage(thread, threadRootId);
  const firstReplyId = fixedUuid(902);
  const secondReplyId = fixedUuid(903);
  thread.setTime("2026-08-25T10:00:05.000Z");
  const firstReply = sendMessage(thread, firstReplyId, receiver, {
    threadId:threadRoot.result.threadId,
    rootMessageId:threadRoot.result.rootMessageId,
    parentMessageId:threadRootId,
  });
  assert.equal(firstReply.ok, true, JSON.stringify(firstReply));
  thread.setTime("2026-08-25T10:00:10.000Z");
  assert.equal(sendMessage(thread, secondReplyId, receiver, {
    threadId:threadRoot.result.threadId,
    rootMessageId:threadRoot.result.rootMessageId,
    parentMessageId:threadRootId,
  }).ok, true);
  thread.setTime("2026-08-25T10:00:15.000Z");
  assert.equal(withdrawMessage(
    thread,
    fixedUuid(904),
    firstReplyId,
    receiver,
  ).ok, true);
  const threadMessages = thread.repository.getReadModel({roles:["drops", "txp"]})
    .operationalMessages.filter(message => message.threadId === threadRootId);
  assert.deepEqual(threadMessages.map(message => message.messageId), [
    threadRootId,
    firstReplyId,
    secondReplyId,
  ]);
  assert.equal(messageFrom({operationalMessages:threadMessages}, firstReplyId).message, "");
  assert.notEqual(messageFrom({operationalMessages:threadMessages}, secondReplyId).message, "");
  const rootOnly = createScenario({uuidStart:1000});
  const rootOnlyId = fixedUuid(1001);
  sendMessage(rootOnly, rootOnlyId);
  assert.equal(withdrawMessage(rootOnly, fixedUuid(1002), rootOnlyId).ok, true);
  rootOnly.db.close();
  thread.db.close();

  for(const token of [
    "MESSAGE_REPLY_STARTED",
    "MESSAGE_WITHDRAWN",
    "data-sde-operational-message-undo",
    ">Angre</button>",
    "Melding trukket tilbake kl.",
    "start-operational-message-reply",
    "withdraw-operational-message",
    "operationalMessageWithdrawalClockTimer",
    "nowMs < deadline",
    "nowMs >= deadline",
    "!isOperationalMessageWithdrawn(message)",
    "message_reply_already_started",
    "vehicle_status.withdraw_operational_message",
  ]){
    assert.ok(frontend.includes(token), `frontend misses ${token}`);
  }
  assert.doesNotMatch(frontend, /delete-operational-message|operational-message\/delete/i);

  return {rootMessageId, withdrawnAt:withdrawn.result.withdrawnAt};
}

function startRaceWorker(kind, dbPath, messageId){
  const worker = new Worker(__filename, {
    workerData:{kind, dbPath, messageId},
  });
  const ready = new Promise((resolve, reject) => {
    const onMessage = message => {
      if(message?.type === "ready"){
        worker.off("message", onMessage);
        resolve();
      }
    };
    worker.on("message", onMessage);
    worker.once("error", reject);
  });
  const result = new Promise((resolve, reject) => {
    const onMessage = message => {
      if(message?.type === "result"){
        worker.off("message", onMessage);
        resolve(message.result);
      }else if(message?.type === "error"){
        worker.off("message", onMessage);
        reject(new Error(message.error));
      }
    };
    worker.on("message", onMessage);
    worker.once("error", reject);
  });
  const exited = new Promise((resolve, reject) => {
    worker.once("exit", code => code === 0 ? resolve() : reject(new Error(`worker exit ${code}`)));
    worker.once("error", reject);
  });
  return {worker, ready, result, exited};
}

async function runConcreteRaceTest(){
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sde-message-withdraw-race-"));
  const dbPath = path.join(tempDir, "race.sqlite3");
  try{
    const setupDb = new DatabaseSync(dbPath);
    setupDb.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
    const setup = createScenario({db:setupDb, uuidStart:2000});
    const messageId = fixedUuid(2001);
    assert.equal(sendMessage(setup, messageId).ok, true);
    setupDb.close();

    const startWorker = startRaceWorker("start", dbPath, messageId);
    const withdrawWorker = startRaceWorker("withdraw", dbPath, messageId);
    await Promise.all([startWorker.ready, withdrawWorker.ready]);
    startWorker.worker.postMessage({type:"go"});
    withdrawWorker.worker.postMessage({type:"go"});
    const results = await Promise.all([startWorker.result, withdrawWorker.result]);
    await Promise.all([startWorker.exited, withdrawWorker.exited]);

    const successes = results.filter(result => result.ok);
    const failures = results.filter(result => !result.ok);
    assert.equal(successes.length, 1, JSON.stringify(results));
    assert.equal(failures.length, 1, JSON.stringify(results));
    assert.ok(
      ["message_reply_already_started", "message_already_withdrawn"]
        .includes(failures[0].error),
      JSON.stringify(results),
    );

    const verificationDb = new DatabaseSync(dbPath, {readOnly:true});
    const lifecycleRows = verificationDb.prepare(`
      SELECT event_type, message_id, recipient_session_id
      FROM vehicle_status_operational_message_lifecycle_events
      WHERE message_id=?
      ORDER BY server_timestamp, lifecycle_event_id
    `).all(messageId);
    verificationDb.close();
    assert.equal(lifecycleRows.length, 1, JSON.stringify(lifecycleRows));
    assert.ok(
      ["MESSAGE_REPLY_STARTED", "MESSAGE_WITHDRAWN"].includes(lifecycleRows[0].event_type),
    );
    return {results, committedEvent:lifecycleRows[0].event_type};
  }finally{
    fs.rmSync(tempDir, {recursive:true, force:true});
  }
}

async function runRaceWorker(){
  const marker = workerData.kind === "start" ? "8001" : "8002";
  let uuid = workerData.kind === "start" ? 3000 : 4000;
  const db = new DatabaseSync(workerData.dbPath);
  db.exec("PRAGMA busy_timeout=5000;");
  const repository = createVehicleStatusTestRepository({
    db,
    now:() => "2026-08-25T10:00:30.000Z",
    randomUUID:() => fixedUuid(uuid++, marker),
  });
  parentPort.postMessage({type:"ready"});
  await new Promise(resolve => parentPort.once("message", resolve));
  const input = workerData.kind === "start"
    ? {
        actionId:fixedUuid(3001, marker),
        messageId:workerData.messageId,
        recipientSessionId:fixedUuid(3002, marker),
      }
    : {
        actionId:fixedUuid(4001, marker),
        messageId:workerData.messageId,
      };
  const commandName = workerData.kind === "start"
    ? lifecycle.LIFECYCLE_COMMANDS.START_OPERATIONAL_MESSAGE_REPLY
    : lifecycle.LIFECYCLE_COMMANDS.WITHDRAW_OPERATIONAL_MESSAGE;
  const authority = workerData.kind === "start" ? receiver : sender;
  const result = repository.executeCommand(
    commandName,
    normalize(commandName, input, authority.effectiveRole),
    authority,
  );
  db.close();
  parentPort.postMessage({type:"result", result});
}

async function main(){
  const contract = runContractTests();
  await runConcreteRaceTest();
  console.log(JSON.stringify({
    schemaVersion:"sde-operational-message-withdrawal-harness-v2",
    tests:58,
    rootMessageId:contract.rootMessageId,
    withdrawnAt:contract.withdrawnAt,
    concreteConcurrentRace:true,
    raceInvariant:"EXACTLY_ONE_COMMIT_AND_ONE_REJECTION",
    raceCompetingEvents:["MESSAGE_REPLY_STARTED", "MESSAGE_WITHDRAWN"],
  }));
}

if(isMainThread){
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}else{
  runRaceWorker().catch(error => {
    parentPort.postMessage({type:"error", error:error.stack || String(error)});
    process.exitCode = 1;
  });
}
