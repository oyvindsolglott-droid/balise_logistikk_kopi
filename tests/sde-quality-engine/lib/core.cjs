"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const STATUSES = Object.freeze(["GREEN", "AMBER", "RED", "BLOCKED", "UNKNOWN"]);
const STATUS_ORDER = Object.freeze({ GREEN: 0, AMBER: 1, UNKNOWN: 2, BLOCKED: 3, RED: 4 });

function repoRoot() {
  return path.resolve(__dirname, "../../..");
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function zonedParts(now, timeZone = "Europe/Oslo") {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    isoDate: `${value.year}-${value.month}-${value.day}`,
    hour: Number(value.hour),
    minute: Number(value.minute),
    second: Number(value.second),
    display: `${value.day}.${value.month}.${value.year} ${value.hour}:${value.minute}:${value.second}`,
    timeZone
  };
}

function nowOsloParts(now = new Date()) {
  return zonedParts(now, "Europe/Oslo");
}

function addDays(isoDate, days) {
  const date = new Date(`${isoDate}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function localDateTimeInstant(isoDate, hour, minute, second, timeZone) {
  const [year, month, day] = String(isoDate).split("-").map(Number);
  const desiredLocal = Date.UTC(year, month - 1, day, hour, minute, second);
  let candidate = desiredLocal;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const observed = zonedParts(new Date(candidate), timeZone);
    const observedLocal = Date.UTC(
      Number(observed.isoDate.slice(0, 4)),
      Number(observed.isoDate.slice(5, 7)) - 1,
      Number(observed.isoDate.slice(8, 10)),
      observed.hour,
      observed.minute,
      observed.second
    );
    const correction = desiredLocal - observedLocal;
    candidate += correction;
    if (correction === 0) break;
  }
  const verified = zonedParts(new Date(candidate), timeZone);
  if (
    verified.isoDate !== isoDate ||
    verified.hour !== hour ||
    verified.minute !== minute ||
    verified.second !== second
  ) {
    throw new Error(`Ugyldig lokal tid ${isoDate} ${hour}:${minute}:${second} i ${timeZone}`);
  }
  return new Date(candidate);
}

function validatePublicationContract(contract) {
  const cycleHours = [...new Set(contract?.cycleHours || [])].map(Number).sort((a, b) => a - b);
  const attemptMinutes = [...new Set(contract?.attemptMinutes || [])].map(Number).sort((a, b) => a - b);
  const publicationGraceMinutes = Number(contract?.publicationGraceMinutes);
  const timeZone = String(contract?.timeZone || "");
  if (!timeZone || !cycleHours.length || !attemptMinutes.length || !Number.isFinite(publicationGraceMinutes)) {
    throw new Error("Ufullstendig Balise-publiseringskontrakt");
  }
  if (cycleHours.some((value) => value < 0 || value > 23) || attemptMinutes.some((value) => value < 0 || value > 59)) {
    throw new Error("Ugyldige syklus- eller forsøksverdier i Balise-publiseringskontrakten");
  }
  return { cycleHours, attemptMinutes, publicationGraceMinutes, timeZone };
}

function effectivePublicationBoundary(now, contract, options = {}) {
  const currentTime = new Date(now);
  if (!Number.isFinite(currentTime.getTime())) throw new Error("Ugyldig testtid for publiseringsgrense");
  const normalized = validatePublicationContract(contract);
  const local = zonedParts(currentTime, normalized.timeZone);
  const dates = [addDays(local.isoDate, -1), local.isoDate, addDays(local.isoDate, 1)];
  const cycles = dates.flatMap((isoDate) => normalized.cycleHours.map((cycleHour) => {
    const nominal = localDateTimeInstant(isoDate, cycleHour, 0, 0, normalized.timeZone);
    const firstAttempt = localDateTimeInstant(
      isoDate,
      cycleHour,
      normalized.attemptMinutes[0],
      0,
      normalized.timeZone
    );
    const effective = new Date(firstAttempt.getTime() + normalized.publicationGraceMinutes * 60_000);
    return { isoDate, cycleHour, nominal, firstAttempt, effective };
  })).sort((a, b) => a.nominal - b.nominal);
  const attempts = dates.flatMap((isoDate) => normalized.cycleHours.flatMap((cycleHour) =>
    normalized.attemptMinutes.map((minute) => localDateTimeInstant(
      isoDate,
      cycleHour,
      minute,
      0,
      normalized.timeZone
    ))
  )).sort((a, b) => a - b);
  const requestedHour = options.cycleHour == null ? null : Number(options.cycleHour);
  const activeCycle = requestedHour == null
    ? cycles.filter((cycle) => cycle.nominal <= currentTime).at(-1)
    : cycles.find((cycle) => cycle.isoDate === local.isoDate && cycle.cycleHour === requestedHour);
  const latestEligibleCycle = cycles.filter((cycle) => cycle.effective <= currentTime).at(-1);
  const nextAttempt = attempts.find((attempt) => attempt > currentTime) || null;
  if (!activeCycle || !latestEligibleCycle) throw new Error("Kunne ikke beregne Balise-publiseringsgrensen");
  const timeRemainingSeconds = Math.max(0, (activeCycle.effective - currentTime) / 1000);
  const withinPublicationGrace = activeCycle.nominal <= currentTime && currentTime < activeCycle.effective;
  return {
    currentTime: currentTime.toISOString(),
    currentTimeLocal: local.display,
    timeZone: normalized.timeZone,
    cycleHour: activeCycle.cycleHour,
    nominalCycleBoundary: activeCycle.nominal.toISOString(),
    firstScheduledAttempt: activeCycle.firstAttempt.toISOString(),
    publicationGraceMinutes: normalized.publicationGraceMinutes,
    effectiveBoundary: activeCycle.effective.toISOString(),
    effectiveBoundaryReached: currentTime >= activeCycle.effective,
    withinPublicationGrace,
    timeRemainingSeconds,
    requiredRefreshBoundary: latestEligibleCycle.nominal.toISOString(),
    latestEligibleEffectiveBoundary: latestEligibleCycle.effective.toISOString(),
    nextScheduledAttempt: nextAttempt?.toISOString() || null
  };
}

function defaultPublicationContract() {
  return readJson(path.join(repoRoot(), "tests/sde-quality-engine/fixtures/balise-freshness-contract.json"));
}

function expectedOperationalDates(now = new Date(), contract = defaultPublicationContract()) {
  const oslo = nowOsloParts(now);
  const todayBoundary = effectivePublicationBoundary(now, contract, { cycleHour: 7 });
  const tomorrowBoundary = effectivePublicationBoundary(now, contract, { cycleHour: 15 });
  if (!todayBoundary.effectiveBoundaryReached) {
    return {
      idag: addDays(oslo.isoDate, -1),
      imorgen: oslo.isoDate,
      window: "night_before_07",
      boundaries: { idag: todayBoundary, imorgen: tomorrowBoundary }
    };
  }
  if (!tomorrowBoundary.effectiveBoundaryReached) {
    return {
      idag: oslo.isoDate,
      imorgen: oslo.isoDate,
      window: "day_07_to_15",
      boundaries: { idag: todayBoundary, imorgen: tomorrowBoundary }
    };
  }
  return {
    idag: oslo.isoDate,
    imorgen: addDays(oslo.isoDate, 1),
    window: "after_15",
    boundaries: { idag: todayBoundary, imorgen: tomorrowBoundary }
  };
}

function result({ id, contractId, area, name, status, critical = false, summary, evidence = [], details = {}, recommendation = null, durationMs = 0 }) {
  if (!STATUSES.includes(status)) {
    throw new Error(`Ugyldig QE-status ${status} for ${id || contractId || name}`);
  }
  return {
    id: id || contractId,
    contractId: contractId || id,
    area,
    name,
    status,
    critical: Boolean(critical),
    summary,
    evidence: Array.isArray(evidence) ? evidence : [evidence],
    details,
    recommendation,
    durationMs
  };
}

function summarize(results) {
  const counts = Object.fromEntries(STATUSES.map((status) => [status, 0]));
  for (const item of results) counts[item.status] += 1;
  const criticalRed = results.filter((item) => item.critical && item.status === "RED");
  const criticalUnproven = results.filter((item) =>
    item.critical && ["BLOCKED", "UNKNOWN"].includes(item.status)
  );
  const blocked = results.filter((item) => item.status === "BLOCKED");
  const unknown = results.filter((item) => item.status === "UNKNOWN");
  const classification = criticalRed.length
    ? "NO-GO"
    : criticalUnproven.length
      ? "HOLD"
      : blocked.length || unknown.length || counts.AMBER
      ? "GO MED AVVIK"
      : "GO";
  return {
    counts,
    total: results.length,
    criticalRed: criticalRed.length,
    criticalUnproven: criticalUnproven.length,
    classification
  };
}

function runCommand(command, args, options = {}) {
  const started = Date.now();
  const env = { ...process.env, ...(options.env || {}) };
  const child = spawnSync(command, args, {
    cwd: options.cwd || repoRoot(),
    env,
    encoding: "utf8",
    timeout: options.timeoutMs || 15 * 60 * 1000,
    maxBuffer: options.maxBuffer || 20 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"]
  });
  return {
    command: [command, ...args].join(" "),
    status: child.status,
    signal: child.signal,
    error: child.error ? String(child.error.message || child.error) : null,
    stdout: child.stdout || "",
    stderr: child.stderr || "",
    durationMs: Date.now() - started,
    ok: child.status === 0 && !child.error
  };
}

function gitValue(args) {
  const output = runCommand("git", args, { timeoutMs: 30_000 });
  return output.ok ? output.stdout.trim() : null;
}

function redact(value) {
  const text = String(value == null ? "" : value);
  return text
    .replace(/(authorization|cookie|token|secret|password)(\s*[:=]\s*)[^\s,;]+/gi, "$1$2[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, "Bearer [REDACTED]");
}

function compactOutput(commandResult, limit = 4000) {
  const combined = redact(`${commandResult.stdout}\n${commandResult.stderr}`).trim();
  if (combined.length <= limit) return combined;
  return `${combined.slice(0, limit)}\n… [avkortet ${combined.length - limit} tegn]`;
}

module.exports = {
  STATUSES,
  STATUS_ORDER,
  addDays,
  compactOutput,
  effectivePublicationBoundary,
  expectedOperationalDates,
  gitValue,
  nowOsloParts,
  readJson,
  redact,
  repoRoot,
  result,
  runCommand,
  sha256,
  summarize
};
