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

function nowOsloParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Oslo",
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
    display: `${value.day}.${value.month}.${value.year} ${value.hour}:${value.minute}:${value.second}`,
    timeZone: "Europe/Oslo"
  };
}

function addDays(isoDate, days) {
  const date = new Date(`${isoDate}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function expectedOperationalDates(now = new Date()) {
  const oslo = nowOsloParts(now);
  if (oslo.hour < 7) {
    return {
      idag: addDays(oslo.isoDate, -1),
      imorgen: oslo.isoDate,
      window: "night_before_07"
    };
  }
  if (oslo.hour < 15) {
    return { idag: oslo.isoDate, imorgen: oslo.isoDate, window: "day_07_to_15" };
  }
  return {
    idag: oslo.isoDate,
    imorgen: addDays(oslo.isoDate, 1),
    window: "after_15"
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
