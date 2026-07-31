"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { repoRoot, summarize } = require("./core.cjs");

function escapeXml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function escapeHtml(value) {
  return escapeXml(value);
}

function recommendationsFor(report) {
  const catalog = JSON.parse(fs.readFileSync(
    path.join(repoRoot(), "tests/sde-quality-engine/recommendations/catalog.json"),
    "utf8"
  ));
  return report.results
    .filter((item) => item.status !== "GREEN")
    .map((item) => {
      const template = catalog.items.find((entry) => entry.match === item.status);
      return {
        id: item.id,
        status: item.status,
        priority: template?.priority || "P2",
        area: item.area,
        problem: item.summary,
        action: item.recommendation || template?.action || "Avklar og dokumenter avviket."
      };
    });
}

function renderMarkdown(report) {
  const summary = report.summary || summarize(report.results);
  const nonGreen = report.results.filter((item) => item.status !== "GREEN");
  const critical = report.results.filter((item) => item.critical && item.status !== "GREEN");
  const balise = report.results.filter((item) => item.area === "tursatt-balise");
  const recommendations = report.recommendations || recommendationsFor(report);
  const lines = [
    "# SDE Quality Engine",
    "",
    `Kjøring: \`${report.runId}\`  `,
    `Tidspunkt: ${report.generatedAt}  `,
    `Suite: \`${report.suite}\`  `,
    `Commit: \`${report.git.commit || "ukjent"}\``,
    "",
    "## 1. Konklusjon",
    "",
    `**${summary.classification}** — ${summary.total} kontroller: ${Object.entries(summary.counts).map(([key, value]) => `${key} ${value}`).join(", ")}.`,
    "",
    "## 2. Hva som er bygget",
    "",
    "- Uavhengig testorkestrering med eksplisitt green-contract og funksjonsmatrise.",
    "- Tursatt/Balise-paritet for dato, ferskhet, forekomst, materiell, dobbeltsett, plattformproveniens og tidsgrenser.",
    "- Integrasjon med eksisterende strict firewall, determinisme, mutasjoner, Python- og serverkontrakter.",
    "- Teknisk GET/HEAD-guard for produksjonskontroll.",
    "- JSON-, Markdown-, JUnit- og HTML-rapportering med konkrete anbefalinger.",
    "",
    "## 3. Endrede filer",
    "",
    ...report.git.changedFiles.map((file) => `- \`${file}\``),
    "",
    "## 4. Kjørte kommandoer",
    "",
    ...(report.commands.length ? report.commands.map((command) => `- \`${command}\``) : ["- Ingen eksterne kommandoer i denne suiten."]),
    "",
    "## 5. Statusfordeling",
    "",
    "| Status | Antall |",
    "|---|---:|",
    ...Object.entries(summary.counts).map(([status, count]) => `| ${status} | ${count} |`),
    "",
    "## 6. Tursatt/Balise-resultat",
    "",
    "| Kontroll | Status | Resultat |",
    "|---|---|---|",
    ...balise.map((item) => `| ${item.name} | ${item.status} | ${String(item.summary).replace(/\|/g, "\\|")} |`),
    "",
    "## 7. Kritiske funn",
    "",
    ...(critical.length
      ? critical.map((item) => `- **${item.status} ${item.id}:** ${item.summary}`)
      : ["- Ingen kritiske RED/BLOCKED/UNKNOWN-funn i den kjørte suiten."]),
    "",
    "## 8. Svakheter og manglende testbarhet",
    "",
    ...(nonGreen.length
      ? nonGreen.map((item) => `- **${item.status} ${item.id}:** ${item.summary}`)
      : ["- Ingen registrerte avvik."]),
    "",
    "## 9. Prioriterte anbefalinger",
    "",
    ...(recommendations.length
      ? recommendations.map((item) => `- **${item.priority} ${item.id}:** ${item.action}`)
      : ["- Ingen anbefalinger; alle kjørte kontroller er GREEN."]),
    "",
    "## 10. Produksjonssikkerhet",
    "",
    `- Tillatte metoder: ${report.productionSafety.allowedMethods.join(", ")}.`,
    `- Observerte produksjonskall: ${report.productionSafety.ledger.length}.`,
    `- Andre metoder avvises før nettverkskall: ${report.productionSafety.guardVerified ? "JA" : "NEI"}.`,
    "",
    "## 11. Git-status",
    "",
    `- HEAD: \`${report.git.commit || "ukjent"}\``,
    `- Branch: \`${report.git.branch || "detached"}\``,
    `- Baseline: \`${report.git.baseline || "ukjent"}\``,
    `- Arbeidskopi ved rapporttidspunkt: ${report.git.clean ? "ren" : "har forventede QE-endringer"}.`,
    `- Push utført av QE: NEI.`,
    "",
    "## 12. Begrensninger",
    "",
    "- Autentisert produksjonsbrowser og ekte fleridentitets-race krever separat, autorisert og write-fri testflate.",
    "- BLOCKED og UNKNOWN klassifiseres aldri som GREEN.",
    "- Quality Engine endrer ikke produksjonslogikk eller operativ state.",
    ""
  ];
  return lines.join("\n");
}

function renderJUnit(report) {
  const summary = report.summary || summarize(report.results);
  const failures = report.results.filter((item) => item.status === "RED").length;
  const skipped = report.results.filter((item) => ["BLOCKED", "UNKNOWN"].includes(item.status)).length;
  const cases = report.results.map((item) => {
    const attrs = `classname="${escapeXml(item.area)}" name="${escapeXml(`${item.id} ${item.name}`)}" time="${(item.durationMs / 1000).toFixed(3)}"`;
    const body = [];
    if (item.status === "RED") {
      body.push(`<failure message="${escapeXml(item.summary)}">${escapeXml(JSON.stringify(item.details || {}, null, 2))}</failure>`);
    } else if (["BLOCKED", "UNKNOWN"].includes(item.status)) {
      body.push(`<skipped message="${escapeXml(`${item.status}: ${item.summary}`)}"/>`);
    }
    body.push(`<system-out>${escapeXml(`${item.status}: ${item.summary}\n${(item.evidence || []).join("\n")}`)}</system-out>`);
    return `    <testcase ${attrs}>${body.join("")}</testcase>`;
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuite name="SDE Quality Engine" tests="${summary.total}" failures="${failures}" skipped="${skipped}" timestamp="${escapeXml(report.generatedAt)}">`,
    ...cases,
    "</testsuite>",
    ""
  ].join("\n");
}

function renderHtml(report) {
  const summary = report.summary || summarize(report.results);
  const recommendations = report.recommendations || recommendationsFor(report);
  const statusCards = Object.entries(summary.counts)
    .map(([status, count]) => `<div class="metric ${status.toLowerCase()}"><strong>${count}</strong><span>${status}</span></div>`)
    .join("");
  const resultRows = report.results.map((item) => `
    <tr>
      <td><code>${escapeHtml(item.id)}</code></td>
      <td>${escapeHtml(item.area)}</td>
      <td>${escapeHtml(item.name)}</td>
      <td><span class="badge ${item.status.toLowerCase()}">${item.status}</span></td>
      <td>${escapeHtml(item.summary)}</td>
    </tr>`).join("");
  const matrixRows = report.functionMatrix.map((item) => `
    <tr>
      <td><code>${escapeHtml(item.id)}</code></td>
      <td>${escapeHtml(item.module)}</td>
      <td>${escapeHtml(item.name)}</td>
      <td><span class="badge ${item.status.toLowerCase()}">${item.status}</span></td>
      <td>${escapeHtml(item.testTypes.join(", "))}</td>
    </tr>`).join("");
  const recommendationItems = recommendations.map((item) =>
    `<li><strong>${escapeHtml(item.priority)} ${escapeHtml(item.id)}</strong> — ${escapeHtml(item.action)}</li>`
  ).join("") || "<li>Ingen anbefalinger; alle kjørte kontroller er GREEN.</li>";
  return `<!doctype html>
<html lang="no">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>SDE Quality Engine — ${escapeHtml(report.runId)}</title>
  <style>
    :root{color-scheme:dark;--bg:#07111f;--panel:#101d30;--line:#2a3d57;--text:#edf5ff;--muted:#9fb3ca}
    *{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at top,#123052,var(--bg) 48%);color:var(--text);font:15px/1.5 system-ui,sans-serif}
    main{max-width:1500px;margin:auto;padding:28px}.hero,.panel{background:rgba(16,29,48,.94);border:1px solid var(--line);border-radius:18px;padding:22px;margin-bottom:18px;box-shadow:0 16px 40px #0007}
    h1,h2{margin-top:0}.sub{color:var(--muted)}.metrics{display:grid;grid-template-columns:repeat(5,minmax(90px,1fr));gap:12px}
    .metric{padding:14px;border-radius:14px;background:#0b1728;border:1px solid var(--line);display:flex;gap:8px;align-items:baseline}.metric strong{font-size:30px}
    .green,.badge.green{color:#60e6a8}.amber,.badge.amber{color:#ffd166}.red,.badge.red{color:#ff667d}.blocked,.badge.blocked{color:#d7a5ff}.unknown,.badge.unknown{color:#9fb3ca}
    .badge{font-weight:800}.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse;min-width:850px}th,td{padding:10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{position:sticky;top:0;background:#101d30}
    code{color:#8ed5ff}li{margin:.45rem 0}@media(max-width:700px){main{padding:12px}.metrics{grid-template-columns:repeat(2,1fr)}.hero,.panel{padding:15px}}
  </style>
</head>
<body><main>
  <section class="hero">
    <p class="sub">SDE Quality Engine · ${escapeHtml(report.generatedAt)} · ${escapeHtml(report.git.commit || "ukjent")}</p>
    <h1>${escapeHtml(summary.classification)}</h1>
    <p>Suite <code>${escapeHtml(report.suite)}</code> · ${summary.total} kontroller · production requests ${report.productionSafety.ledger.length}</p>
    <div class="metrics">${statusCards}</div>
  </section>
  <section class="panel"><h2>Kontrollresultater</h2><div class="table-wrap"><table><thead><tr><th>ID</th><th>Område</th><th>Kontroll</th><th>Status</th><th>Evidenssammendrag</th></tr></thead><tbody>${resultRows}</tbody></table></div></section>
  <section class="panel"><h2>Funksjonsmatrise</h2><div class="table-wrap"><table><thead><tr><th>ID</th><th>Modul</th><th>Funksjon</th><th>Status</th><th>Testtyper</th></tr></thead><tbody>${matrixRows}</tbody></table></div></section>
  <section class="panel"><h2>Anbefalinger</h2><ul>${recommendationItems}</ul></section>
  <section class="panel"><h2>Produksjonssikkerhet</h2><p>Kun ${escapeHtml(report.productionSafety.allowedMethods.join("/"))}. Andre metoder avvises før fetch. Ledger: <code>${escapeHtml(JSON.stringify(report.productionSafety.ledger))}</code></p></section>
</main></body></html>`;
}

function writeReports(report, directory) {
  fs.mkdirSync(directory, { recursive: true });
  report.summary = report.summary || summarize(report.results);
  report.recommendations = report.recommendations || recommendationsFor(report);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  const markdown = `${renderMarkdown(report)}\n`;
  const junit = renderJUnit(report);
  const html = renderHtml(report);
  const files = {
    json: path.join(directory, "latest.json"),
    markdown: path.join(directory, "latest.md"),
    junit: path.join(directory, "latest.junit.xml"),
    html: path.join(directory, "latest.html")
  };
  fs.writeFileSync(files.json, json);
  fs.writeFileSync(files.markdown, markdown);
  fs.writeFileSync(files.junit, junit);
  fs.writeFileSync(files.html, html);
  return {
    files,
    bytes: Object.fromEntries(Object.entries(files).map(([name, file]) => [name, fs.statSync(file).size])),
    rendered: { json, markdown, junit, html }
  };
}

module.exports = {
  recommendationsFor,
  renderHtml,
  renderJUnit,
  renderMarkdown,
  writeReports
};
