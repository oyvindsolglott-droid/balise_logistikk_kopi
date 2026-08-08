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

function classificationModel(report) {
  const threeWay = report.results
    .find((item) => item.id === "BALISE-010-LIVE")
    ?.details?.threeWay || null;
  if (!threeWay) return null;
  return {
    releaseStatus: threeWay.releaseStatus,
    accounting: threeWay.accounting,
    uniqueUnderlyingFindings: threeWay.uniqueUnderlyingFindings,
    layerObservationCount: threeWay.layerObservationCount,
    primaryClassificationCounts: threeWay.primaryClassificationCounts,
    diagnosticLabelCounts: threeWay.diagnosticLabelCounts,
    findings: threeWay.findings.map((finding) => ({
      uniqueFindingId: finding.uniqueFindingId,
      primaryClassification: finding.primaryClassification,
      diagnosticLabels: finding.diagnosticLabels,
      comparisonEligibility: finding.comparisonEligibility,
      contractAuthority: finding.contractAuthority,
      confidence: finding.confidence,
      observedInLayers: finding.observedInLayers,
      layerObservationCount: finding.layerObservationCount
    }))
  };
}

function provenanceModel(report) {
  return report.results
    .find((item) => item.id === "PROV-001")
    ?.details?.provenance || null;
}

function provenanceIdentityDomains(provenance) {
  if (!provenance) return [];
  if (Array.isArray(provenance.identityResults)) return provenance.identityResults;
  return Object.values(provenance.identityDomains || {});
}

function relationText(value) {
  if (Array.isArray(value)) return value.join("; ");
  return JSON.stringify(value || {});
}

function canonicalGateProjection(item) {
  return {
    id: item.id,
    gateVersion: item.gateVersion,
    status: item.status,
    reasonCode: item.reasonCode,
    severity: item.severity,
    critical: item.critical,
    evidence: item.evidence || [],
    parentGate: item.parentGate,
    childGates: item.childGates || [],
    aggregate: item.aggregate,
    counted: item.counted
  };
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
      const investigation = item.recommendation || template?.action || "Avklar og dokumenter avviket.";
      return {
        id: item.id,
        recommendationId: `REC-${item.id}`,
        status: item.status,
        priority: template?.priority || "P2",
        area: item.area,
        problem: item.summary,
        finding: item.details?.threeWay?.findings?.[0]?.findingType || item.details?.findingType || "UNKNOWN",
        investigation,
        why: "Avklar om funnet skyldes SDE, testkontrakten, en autorisert overstyring eller tidsforskjell før endring vurderes.",
        risks: {
          prematureChange: "Kan endre korrekt operativ atferd eller skjule en test-orakelfeil.",
          noAction: item.critical ? "Et mulig kritisk kontraktbrudd kan bli stående uavklart." : "Observasjonen kan forbli uavklart."
        },
        requiredAuthority: "Separat, uttrykkelig systemeiergodkjenning kreves før kode, data eller kontrakt endres.",
        action: investigation
      };
    });
}

function renderMarkdown(report) {
  const summary = report.summary || summarize(report.results);
  const nonGreen = report.results.filter((item) => item.status !== "GREEN");
  const critical = report.results.filter((item) => item.critical && item.status !== "GREEN");
  const balise = report.results.filter((item) => item.area === "tursatt-balise");
  const recommendations = report.recommendations || recommendationsFor(report);
  const accounting = report.accounting || null;
  const liveFindings = report.results
    .find((item) => item.id === "BALISE-010-LIVE")
    ?.details?.threeWay?.findings || [];
  const classifications = classificationModel(report);
  const provenance = provenanceModel(report);
  const identityDomains = provenanceIdentityDomains(provenance);
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
    ...(accounting ? [
      `Maskinlesbart regnskap: ${accounting.testCases.total} testcases/assertions, ${accounting.contracts.total} kontrakter, ${accounting.functions.total} funksjoner, ${accounting.recommendations.total} anbefalinger og ${accounting.releaseGates.total} kritiske releaseporter.`,
      `Kritisk BLOCKED/UNKNOWN: ${accounting.releaseGates.criticalBlocked.map((item) => item.id).join(", ") || "ingen"}.`,
      `QE-0-baseline: ${accounting.qe0BaselineBlockedFunctions.total}/${accounting.qe0BaselineBlockedFunctions.functionTotal} blokkerte funksjoner (${accounting.qe0BaselineBlockedFunctions.groups.map((group) => `${group.reason}=${group.ids.length}`).join(", ")}).`
    ] : ["Maskinlesbart statusregnskap bygges ved full QE-kjøring."]),
    "",
    "## 6. Tursatt/Balise-resultat",
    "",
    "| Kontroll | Status | Resultat |",
    "|---|---|---|",
    ...balise.map((item) => `| ${item.name} | ${item.status} | ${String(item.summary).replace(/\|/g, "\\|")} |`),
    "",
    "### Treveis funnbevis",
    "",
    ...(liveFindings.length ? [
      "| Test | Occurrence | Felt | Primary classification | Diagnostic labels | Comparison eligible | Reason | Available provenance | Missing provenance | Authority | Sikkerhet |",
      "|---|---|---|---|---|---|---|---|---|---|---|",
      ...liveFindings.map((finding) => `| ${finding.testId} | ${finding.occurrenceId || "–"} | ${finding.field} | ${finding.primaryClassification} | ${(finding.diagnosticLabels || []).join(", ") || "–"} | ${finding.comparisonEligibility?.eligible ? "yes" : "no"} | ${finding.comparisonEligibility?.reason || "–"} | ${(finding.comparisonEligibility?.availableProvenance || []).join(", ") || "–"} | ${(finding.comparisonEligibility?.missingProvenance || []).join(", ") || "–"} | ${finding.contractAuthority?.type || "UNKNOWN"} (${finding.contractAuthority?.normative ? "normative" : "non-normative"}) | ${finding.confidence} |`),
      "",
      `Regnskap: ${classifications?.uniqueUnderlyingFindings ?? 0} unique findings, ${classifications?.layerObservationCount ?? 0} layer observations.`,
      `Primary classifications: ${JSON.stringify(classifications?.primaryClassificationCounts || {})}.`,
      `Diagnostic labels: ${JSON.stringify(classifications?.diagnosticLabelCounts || {})}.`,
      "HOLD does not mean confirmed product defect."
    ] : ["- Ingen treveis livefunn i denne kjøringen, eller publisert kilde var utilgjengelig."]),
    "",
    "## 7. Kritiske funn",
    "",
    ...(critical.length
      ? critical.map((item) => `- **${item.status} ${item.id}:** ${item.summary}`)
      : ["- Ingen kritiske RED/BLOCKED/UNKNOWN-funn i den kjørte suiten."]),
    "",
    "### Dataproveniens",
    "",
    ...(provenance ? [
      `Generation ID: \`${provenance.generationId || "NOT AVAILABLE"}\`.`,
      `Comparison eligibility: **${provenance.comparisonEligibility?.eligible ? "eligible" : "not eligible"}** — ${provenance.comparisonEligibility?.reason || "NOT AVAILABLE"}.`,
      `Publication integrity: **${provenance.publicationIntegrity}**. Custom-domain observability: **${provenance.customDomainObservability}**.`,
      "",
      "| Identity domain | Status | Normative role | Expected relations | Actual relations |",
      "|---|---|---|---|---|",
      ...identityDomains.map((domain) => `| ${domain.name} | ${domain.status} | ${String(domain.role || "").replace(/\|/g, "\\|")} | ${relationText(domain.expectedRelations).replace(/\|/g, "\\|")} | \`${relationText(domain.actualRelations).replace(/\|/g, "\\|")}\` |`),
      "",
      "| Proveniensledd | Status | Identitet |",
      "|---|---|---|",
      ...(provenance.chain || []).map((step) => `| ${step.step} | ${step.status} | \`${step.identity || "NOT AVAILABLE"}\` |`),
      "",
      ...(provenance.findings || []).map((finding) => `- ${finding}`)
    ] : ["- Provenienssuite var ikke del av denne kjøringen."]),
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
      ? recommendations.map((item) => `- **${item.priority} ${item.recommendationId}:** ${item.investigation} Hvorfor: ${item.why} Risiko ved forhastet endring: ${item.risks.prematureChange} Risiko ved å avvente: ${item.risks.noAction} Fullmakt: ${item.requiredAuthority}`)
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
    const threeWay = item.details?.threeWay;
    const classificationEvidence = threeWay ? `\nclassification=${JSON.stringify({ uniqueUnderlyingFindings: threeWay.uniqueUnderlyingFindings, layerObservationCount: threeWay.layerObservationCount, primaryClassificationCounts: threeWay.primaryClassificationCounts, diagnosticLabelCounts: threeWay.diagnosticLabelCounts, findings: threeWay.findings.map((finding) => ({ primaryClassification: finding.primaryClassification, diagnosticLabels: finding.diagnosticLabels, comparisonEligibility: finding.comparisonEligibility, contractAuthority: finding.contractAuthority, confidence: finding.confidence })) })}` : "";
    const provenanceEvidence = item.details?.provenance ? `\nprovenance=${JSON.stringify(item.details.provenance)}` : "";
    const canonicalEvidence = `\ncanonical-gate=${JSON.stringify(canonicalGateProjection(item))}`;
    body.push(`<system-out>${escapeXml(`${item.status}: ${item.summary}\n${(item.evidence || []).join("\n")}${canonicalEvidence}${classificationEvidence}${provenanceEvidence}`)}</system-out>`);
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
    <tr data-gate-id="${escapeHtml(item.id)}" data-gate-version="${escapeHtml(item.gateVersion)}" data-gate-status="${escapeHtml(item.status)}" data-reason-code="${escapeHtml(item.reasonCode)}" data-counted="${item.counted}">
      <td><code>${escapeHtml(item.id)}</code></td>
      <td>${escapeHtml(item.area)}</td>
      <td>${escapeHtml(item.name)}</td>
      <td><span class="badge ${item.status.toLowerCase()}">${item.status}</span></td>
      <td><code>${escapeHtml(item.gateVersion)}</code></td>
      <td><code>${escapeHtml(item.reasonCode)}</code></td>
      <td>${escapeHtml(item.severity)} / ${item.critical ? "critical" : "noncritical"}</td>
      <td>${item.aggregate ? "aggregate" : "leaf"}; ${item.counted ? "counted" : "non-counted"}; parent=${escapeHtml(item.parentGate || "none")}; children=${escapeHtml((item.childGates || []).join(",") || "none")}</td>
      <td><code>${escapeHtml(JSON.stringify(item.evidence || []))}</code></td>
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
    `<li><strong>${escapeHtml(item.priority)} ${escapeHtml(item.recommendationId)}</strong> — ${escapeHtml(item.investigation)}<br><small>${escapeHtml(item.why)} Risiko: ${escapeHtml(item.risks.prematureChange)} Fullmakt: ${escapeHtml(item.requiredAuthority)}</small></li>`
  ).join("") || "<li>Ingen anbefalinger; alle kjørte kontroller er GREEN.</li>";
  const accountingPanel = report.accounting ? `
  <section class="panel"><h2>Statusregnskap</h2><p>${report.accounting.testCases.total} testcases/assertions · ${report.accounting.contracts.total} kontrakter · ${report.accounting.functions.total} funksjoner · ${report.accounting.recommendations.total} anbefalinger · ${report.accounting.releaseGates.total} kritiske releaseporter.</p><p>Kritisk BLOCKED/UNKNOWN: <code>${escapeHtml(report.accounting.releaseGates.criticalBlocked.map((item) => item.id).join(", ") || "ingen")}</code></p></section>` : "";
  const classification = classificationModel(report);
  const provenance = provenanceModel(report);
  const identityDomains = provenanceIdentityDomains(provenance);
  const provenancePanel = provenance ? `<section class="panel"><h2>Dataproveniens</h2><p>Generation ID: <code>${escapeHtml(provenance.generationId || "NOT AVAILABLE")}</code></p><p>Comparison eligibility: <strong>${provenance.comparisonEligibility?.eligible ? "eligible" : "not eligible"}</strong> — ${escapeHtml(provenance.comparisonEligibility?.reason || "NOT AVAILABLE")}</p><p>Publication integrity: <strong>${escapeHtml(provenance.publicationIntegrity)}</strong> · Custom-domain observability: <strong>${escapeHtml(provenance.customDomainObservability)}</strong></p><h3>Identity domains</h3><div class="table-wrap"><table><thead><tr><th>Domain</th><th>Status</th><th>Normative role</th><th>Expected relations</th><th>Actual relations</th></tr></thead><tbody>${identityDomains.map((domain) => `<tr><td>${escapeHtml(domain.name)}</td><td><span class="badge ${String(domain.status).toLowerCase()}">${escapeHtml(domain.status)}</span></td><td>${escapeHtml(domain.role)}</td><td>${escapeHtml(relationText(domain.expectedRelations))}</td><td><code>${escapeHtml(relationText(domain.actualRelations))}</code></td></tr>`).join("")}</tbody></table></div><h3>Evidence chain</h3><div class="table-wrap"><table><thead><tr><th>Proveniensledd</th><th>Status</th><th>Identitet</th></tr></thead><tbody>${(provenance.chain || []).map((step) => `<tr><td>${escapeHtml(step.step)}</td><td><span class="badge ${String(step.status).toLowerCase().replace(/ /g, "-")}">${escapeHtml(step.status)}</span></td><td><code>${escapeHtml(step.identity || "NOT AVAILABLE")}</code></td></tr>`).join("")}</tbody></table></div><ul>${(provenance.findings || []).map((finding) => `<li>${escapeHtml(finding)}</li>`).join("")}</ul></section>` : "";
  const classificationPanel = classification ? `<section class="panel"><h2>Fail-closed klassifisering</h2><p><strong>${classification.uniqueUnderlyingFindings}</strong> unique findings · <strong>${classification.layerObservationCount}</strong> layer observations.</p><p>Primary classifications: <code>${escapeHtml(JSON.stringify(classification.primaryClassificationCounts))}</code></p><p>Diagnostic labels: <code>${escapeHtml(JSON.stringify(classification.diagnosticLabelCounts))}</code></p><div class="table-wrap"><table><thead><tr><th>Finding</th><th>Primary</th><th>Labels</th><th>Eligible</th><th>Reason</th><th>Available provenance</th><th>Missing provenance</th><th>Authority</th><th>Confidence</th></tr></thead><tbody>${classification.findings.map((finding) => `<tr><td><code>${escapeHtml(finding.uniqueFindingId)}</code></td><td>${escapeHtml(finding.primaryClassification)}</td><td>${escapeHtml(finding.diagnosticLabels.join(", "))}</td><td>${finding.comparisonEligibility.eligible ? "yes" : "no"}</td><td>${escapeHtml(finding.comparisonEligibility.reason)}</td><td>${escapeHtml((finding.comparisonEligibility.availableProvenance || []).join(", ") || "–")}</td><td>${escapeHtml((finding.comparisonEligibility.missingProvenance || []).join(", ") || "–")}</td><td>${escapeHtml(finding.contractAuthority.type)} (${finding.contractAuthority.normative ? "normative" : "non-normative"})</td><td>${escapeHtml(finding.confidence)}</td></tr>`).join("")}</tbody></table></div><p>HOLD does not mean confirmed product defect.</p></section>` : "";
  const canonicalGatesJson = JSON.stringify({ total: summary.total, counts: summary.counts, gates: report.results.map(canonicalGateProjection) }).replace(/</g, "\\u003c");
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
  <script id="sde-canonical-gates" type="application/json">${canonicalGatesJson}</script>
  <section class="panel"><h2>Kontrollresultater</h2><div class="table-wrap"><table><thead><tr><th>ID</th><th>Område</th><th>Kontroll</th><th>Status</th><th>Versjon</th><th>Reason</th><th>Severity</th><th>Relasjon/telling</th><th>Evidensreferanser</th><th>Evidenssammendrag</th></tr></thead><tbody>${resultRows}</tbody></table></div></section>
  ${accountingPanel}
  ${classificationPanel}
  ${provenancePanel}
  <section class="panel"><h2>Funksjonsmatrise</h2><div class="table-wrap"><table><thead><tr><th>ID</th><th>Modul</th><th>Funksjon</th><th>Status</th><th>Testtyper</th></tr></thead><tbody>${matrixRows}</tbody></table></div></section>
  <section class="panel"><h2>Anbefalinger</h2><ul>${recommendationItems}</ul></section>
  <section class="panel"><h2>Produksjonssikkerhet</h2><p>Kun ${escapeHtml(report.productionSafety.allowedMethods.join("/"))}. Andre metoder avvises før fetch. Ledger: <code>${escapeHtml(JSON.stringify(report.productionSafety.ledger))}</code></p></section>
</main></body></html>`;
}

function renderGithubSummary(report) {
  const summary = report.summary || summarize(report.results);
  const provenance = provenanceModel(report);
  const identityDomains = provenanceIdentityDomains(provenance);
  const lines = [
    "# SDE Quality Engine",
    "",
    `**${summary.classification}** · commit \`${report.git.commit || "unknown"}\` · suite \`${report.suite}\``,
    "",
    "## Generation provenance",
    ""
  ];
  if (!provenance) {
    lines.push("Provenance suite was not part of this run.");
  } else {
    lines.push(
      `Generation ID: \`${provenance.generationId || "NOT AVAILABLE"}\``,
      "",
      `Comparison eligibility: **${provenance.comparisonEligibility?.eligible ? "eligible" : "not eligible"}** — ${provenance.comparisonEligibility?.reason || "NOT AVAILABLE"}`,
      "",
      "| Identity domain | Status | Normative role |",
      "|---|---|---|",
      ...identityDomains.map((domain) => `| ${domain.name} | ${domain.status} | ${String(domain.role || "").replace(/\|/g, "\\|")} |`),
      "",
      "| Chain step | Status |",
      "|---|---|",
      ...(provenance.chain || []).map((step) => `| ${step.step} | ${step.status} |`)
    );
  }
  return lines.join("\n");
}

function writeReports(report, directory) {
  fs.mkdirSync(directory, { recursive: true });
  report.summary = report.summary || summarize(report.results);
  report.recommendations = report.recommendations || recommendationsFor(report);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  const markdown = `${renderMarkdown(report)}\n`;
  const junit = renderJUnit(report);
  const html = renderHtml(report);
  const githubSummary = `${renderGithubSummary(report)}\n`;
  const files = {
    json: path.join(directory, "latest.json"),
    markdown: path.join(directory, "latest.md"),
    junit: path.join(directory, "latest.junit.xml"),
    html: path.join(directory, "latest.html"),
    githubSummary: path.join(directory, "latest.github-summary.md")
  };
  fs.writeFileSync(files.json, json);
  fs.writeFileSync(files.markdown, markdown);
  fs.writeFileSync(files.junit, junit);
  fs.writeFileSync(files.html, html);
  fs.writeFileSync(files.githubSummary, githubSummary);
  return {
    files,
    bytes: Object.fromEntries(Object.entries(files).map(([name, file]) => [name, fs.statSync(file).size])),
    rendered: { json, markdown, junit, html, githubSummary }
  };
}

module.exports = {
  canonicalGateProjection,
  classificationModel,
  provenanceModel,
  provenanceIdentityDomains,
  recommendationsFor,
  renderGithubSummary,
  renderHtml,
  renderJUnit,
  renderMarkdown,
  writeReports
};
