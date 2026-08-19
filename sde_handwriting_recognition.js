(function attachSdeHandwritingRecognition(root, factory){
  "use strict";
  const api = factory();
  if(typeof module === "object" && module.exports) module.exports = api;
  if(root) root.SdeHandwritingRecognition = api;
})(typeof window !== "undefined" ? window : globalThis, function createSdeHandwritingRecognition(){
  "use strict";

  const PIPELINE_STAGES = Object.freeze([
    "IMAGE",
    "ORIENTATION",
    "PERSPECTIVE_CORRECTION",
    "TEMPLATE_DETECTION",
    "TEMPLATE_REGISTRATION",
    "CELL_SEGMENTATION",
    "COLOR_LAYER_SEPARATION",
    "PRINTED_TEXT_RECOGNITION",
    "HANDWRITING_RECOGNITION",
    "FIELD_NORMALIZATION",
    "FORM_MAPPING",
  ]);
  const CANONICAL_COLUMN_IDS = Object.freeze([
    "arrivalTime", "fromTrain", "toTrain", "vehicleId", "toTrack", "wcWater", "info", "notes",
  ]);
  const TEMPLATE_A_COLUMN_IDS = Object.freeze(["fromTrain", "toTrain", "vehicleId", "toTrack", "wcWater", "notes"]);
  const TEMPLATE_B_COLUMN_IDS = CANONICAL_COLUMN_IDS;
  const COLUMN_IDS = TEMPLATE_A_COLUMN_IDS;
  const MODEL_SPEC = Object.freeze({
    id: "PaddlePaddle/latin_PP-OCRv5_mobile_rec_onnx",
    revision: "89d3a50e2c27e2e7cceeab0e944c25c807d5db4f",
    version: "latin-pp-ocrv5-mobile-rec-onnx@89d3a50e",
    modelSha256: "7888113072263cb471b93f66dd5e2ad70548dc526fa1ace760d0d973dd121498",
    runtime: "onnxruntime-web@1.27.0",
    executionProvider: "wasm",
    remoteModelsAllowed: false,
    handwritingCapable: true,
    requiresWebGpu: false,
  });
  const TEMPLATE_A = Object.freeze({
    id: "TEMPLATE_A",
    version: "togplassering-skien-template-a-29x6-v2",
    width: 1200,
    height: 1500,
    dataTop: 285,
    dataBottom: 1465,
    columns: TEMPLATE_A_COLUMN_IDS,
    columnBoundaries: Object.freeze([26, 168, 329, 484, 636, 770, 1174]),
    printedHeaders: Object.freeze(["Fra Tog", "Til Tog", "Settnr", "Til spor", "Wc/vann", "Merknad"]),
    metadataLabels: Object.freeze(["Dato", "Signatur", "ds"]),
    metadata: Object.freeze([
      Object.freeze({columnId: "date", canonicalBox: Object.freeze({x0: 155, y0: 55, x1: 390, y1: 130})}),
      Object.freeze({columnId: "signature", canonicalBox: Object.freeze({x0: 535, y0: 55, x1: 770, y1: 130})}),
      Object.freeze({columnId: "ds", canonicalBox: Object.freeze({x0: 925, y0: 55, x1: 1174, y1: 130})}),
    ]),
  });
  const TEMPLATE_B = Object.freeze({
    id: "TEMPLATE_B",
    version: "togplassering-skien-template-b-29x8-v1",
    width: 1200,
    height: 1500,
    dataTop: 285,
    dataBottom: 1465,
    columns: TEMPLATE_B_COLUMN_IDS,
    // The normalized rule sequence is the authoritative segmentation source;
    // the detector compares all nine rules and never infers a template from
    // recognized business values.
    columnBoundaries: Object.freeze([26, 106, 191, 298, 399, 503, 623, 902, 1174]),
    printedHeaders: Object.freeze(["Inn kl", "Fra Tog", "Til Tog", "Settnr", "Til spor", "WC/vann", "INFO", "Merknad"]),
    metadataLabels: Object.freeze(["Klokken", "Dato", "Signatur"]),
    metadata: Object.freeze([
      Object.freeze({columnId: "clock", canonicalBox: Object.freeze({x0: 26, y0: 25, x1: 106, y1: 58})}),
      Object.freeze({columnId: "date", canonicalBox: Object.freeze({x0: 240, y0: 25, x1: 503, y1: 58})}),
      Object.freeze({columnId: "signature", canonicalBox: Object.freeze({x0: 902, y0: 25, x1: 1174, y1: 58})}),
    ]),
  });
  const TEMPLATES = Object.freeze({TEMPLATE_A, TEMPLATE_B});
  const TEMPLATE = TEMPLATE_A;

  function templateFor(templateId){
    return TEMPLATES[String(templateId || "TEMPLATE_A")] || null;
  }

  function normalizedEvidence(value){
    return String(value || "").normalize("NFKC").toUpperCase().replace(/[^A-ZÆØÅ0-9]/g, "");
  }

  function detectTemplateVariant(input = {}){
    const title = normalizedEvidence(input.title);
    const printedHeaders = (Array.isArray(input.printedHeaders) ? input.printedHeaders : []).map(normalizedEvidence);
    const metadataLabels = (Array.isArray(input.metadataLabels) ? input.metadataLabels : []).map(normalizedEvidence);
    const verticalLineCount = Number(input.verticalLineCount);
    const titleMatch = title === "TOGPLASSERINGSKIEN" || title === "TOGPLASSERING";
    const score = template => {
      const expectedHeaders = template.printedHeaders.map(normalizedEvidence);
      const expectedMetadata = template.metadataLabels.map(normalizedEvidence);
      const headerMatches = expectedHeaders.filter(value => printedHeaders.includes(value)).length;
      const metadataMatches = expectedMetadata.filter(value => metadataLabels.includes(value)).length;
      const lineMatch = verticalLineCount === template.columnBoundaries.length;
      return {
        templateId: template.id,
        score: (titleMatch ? 2 : 0) + (lineMatch ? 4 : 0) + headerMatches + metadataMatches,
        titleMatch,
        lineMatch,
        headerMatches,
        metadataMatches,
      };
    };
    const ranked = [score(TEMPLATE_A), score(TEMPLATE_B)].sort((left, right) => right.score - left.score);
    const best = ranked[0];
    const minimumEvidence = best.lineMatch && (best.titleMatch || best.headerMatches >= Math.ceil((templateFor(best.templateId).columns.length) / 2));
    const uniqueWinner = ranked.length < 2 || best.score > ranked[1].score;
    return Object.freeze({
      templateId: minimumEvidence && uniqueWinner ? best.templateId : "TEMPLATE_UNKNOWN",
      confidence: minimumEvidence && uniqueWinner ? Math.min(1, best.score / 16) : 0,
      evidence: Object.freeze({...best}),
    });
  }

  function finitePoint(value, label){
    const point = value && typeof value === "object" ? value : {};
    const x = Number(point.x);
    const y = Number(point.y);
    if(!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`invalid_${label}_point`);
    return {x, y};
  }

  function solveLinearSystem(matrix, vector){
    const size = vector.length;
    const augmented = matrix.map((row, index) => [...row, vector[index]]);
    for(let column = 0; column < size; column += 1){
      let pivot = column;
      for(let row = column + 1; row < size; row += 1){
        if(Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
      }
      if(Math.abs(augmented[pivot][column]) < 1e-12) throw new Error("perspective_transform_singular");
      [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
      const divisor = augmented[column][column];
      for(let item = column; item <= size; item += 1) augmented[column][item] /= divisor;
      for(let row = 0; row < size; row += 1){
        if(row === column) continue;
        const factor = augmented[row][column];
        for(let item = column; item <= size; item += 1){
          augmented[row][item] -= factor * augmented[column][item];
        }
      }
    }
    return augmented.map(row => row[size]);
  }

  function homography(fromPoints, toPoints){
    if(!Array.isArray(fromPoints) || !Array.isArray(toPoints) || fromPoints.length !== 4 || toPoints.length !== 4){
      throw new Error("perspective_transform_requires_four_points");
    }
    const matrix = [];
    const vector = [];
    for(let index = 0; index < 4; index += 1){
      const from = finitePoint(fromPoints[index], "source");
      const to = finitePoint(toPoints[index], "target");
      matrix.push([from.x, from.y, 1, 0, 0, 0, -to.x * from.x, -to.x * from.y]);
      vector.push(to.x);
      matrix.push([0, 0, 0, from.x, from.y, 1, -to.y * from.x, -to.y * from.y]);
      vector.push(to.y);
    }
    const values = solveLinearSystem(matrix, vector);
    return Object.freeze([...values, 1]);
  }

  function createPerspectiveTransform(original, canonical){
    return Object.freeze({
      forward: homography(original, canonical),
      inverse: homography(canonical, original),
      applied: true,
    });
  }

  function projectPoint(transform, point){
    if(!Array.isArray(transform) || transform.length !== 9) throw new Error("invalid_perspective_transform");
    const clean = finitePoint(point, "projected");
    const divisor = (transform[6] * clean.x) + (transform[7] * clean.y) + transform[8];
    if(Math.abs(divisor) < 1e-12) throw new Error("perspective_projection_at_infinity");
    return Object.freeze({
      x: ((transform[0] * clean.x) + (transform[1] * clean.y) + transform[2]) / divisor,
      y: ((transform[3] * clean.x) + (transform[4] * clean.y) + transform[5]) / divisor,
    });
  }

  function projectBox(transform, box){
    const points = [
      projectPoint(transform, {x: box.x0, y: box.y0}),
      projectPoint(transform, {x: box.x1, y: box.y0}),
      projectPoint(transform, {x: box.x1, y: box.y1}),
      projectPoint(transform, {x: box.x0, y: box.y1}),
    ];
    return Object.freeze({
      x0: Math.min(...points.map(point => point.x)),
      y0: Math.min(...points.map(point => point.y)),
      x1: Math.max(...points.map(point => point.x)),
      y1: Math.max(...points.map(point => point.y)),
      coordinateSpace: "ORIGINAL_IMAGE",
      polygon: Object.freeze(points),
    });
  }

  function fullImageQuadrilateral(width, height){
    return [
      {x: 0, y: 0},
      {x: width, y: 0},
      {x: width, y: height},
      {x: 0, y: height},
    ];
  }

  function templateGridQuadrilateral(template){
    const left = template.columnBoundaries[0];
    const right = template.columnBoundaries.at(-1);
    return [
      {x: left, y: 0},
      {x: right, y: 0},
      {x: right, y: template.height},
      {x: left, y: template.height},
    ];
  }

  function grayscaleAtFrame(pixels, width, height, x, y){
    const boundedX = Math.max(0, Math.min(width - 1, Math.round(x)));
    const boundedY = Math.max(0, Math.min(height - 1, Math.round(y)));
    const offset = ((boundedY * width) + boundedX) * 4;
    return (Number(pixels[offset]) * 0.299)
      + (Number(pixels[offset + 1]) * 0.587)
      + (Number(pixels[offset + 2]) * 0.114);
  }

  function darkNear(pixels, width, height, x, y, radius = 1){
    for(let delta = -radius; delta <= radius; delta += 1){
      if(grayscaleAtFrame(pixels, width, height, x + delta, y) < 145) return true;
    }
    return false;
  }

  function verticalLineScore(pixels, width, height, xAtReference, slope, referenceY){
    const yStart = Math.floor(height * 0.16);
    const yEnd = Math.ceil(height * 0.985);
    let score = 0;
    let samples = 0;
    for(let y = yStart; y <= yEnd; y += 2){
      const x = xAtReference + (slope * (y - referenceY));
      if(x >= 0 && x < width){
        samples += 1;
        if(darkNear(pixels, width, height, x, y, 1)) score += 1;
      }
    }
    return {score, samples};
  }

  function bestVerticalLines(pixels, width, height){
    const referenceY = height * 0.18;
    const scored = [];
    for(let x = 0; x < width; x += 2){
      let best = {score: -1, samples: 0, slope: 0};
      for(let slopeStep = -14; slopeStep <= 14; slopeStep += 1){
        const slope = slopeStep / 100;
        const value = verticalLineScore(pixels, width, height, x, slope, referenceY);
        if(value.score > best.score) best = {...value, slope};
      }
      scored.push(Object.freeze({xAtReference: x, ...best}));
    }
    const candidates = [];
    for(let index = 0; index < scored.length; index += 1){
      const candidate = scored[index];
      if(candidate.samples < 20 || candidate.score < candidate.samples * 0.28) continue;
      const neighborhood = scored.slice(Math.max(0, index - 3), Math.min(scored.length, index + 4));
      if(neighborhood.some(item => item.score > candidate.score)) continue;
      candidates.push(candidate);
    }
    return {referenceY, candidates};
  }

  function selectFormGrid(lines, width, template){
    const ratios = template.columnBoundaries.map(value => (
      (value - template.columnBoundaries[0])
      / (template.columnBoundaries.at(-1) - template.columnBoundaries[0])
    ));
    const leftCandidates = lines.candidates.filter(candidate => candidate.xAtReference < width * 0.3);
    const rightCandidates = lines.candidates.filter(candidate => candidate.xAtReference > width * 0.55);
    let best = null;
    for(const left of leftCandidates){
      for(const right of rightCandidates){
        const span = right.xAtReference - left.xAtReference;
        if(span < width * 0.55) continue;
        const tolerance = Math.max(5, span * 0.022);
        const selected = [left];
        let deviation = 0;
        let lineScore = left.score;
        let valid = true;
        for(const ratio of ratios.slice(1, -1)){
          const expectedX = left.xAtReference + (span * ratio);
          const choices = lines.candidates
            .filter(candidate => Math.abs(candidate.xAtReference - expectedX) <= tolerance)
            .sort((a, b) => (b.score - (Math.abs(b.xAtReference - expectedX) * 1.5))
              - (a.score - (Math.abs(a.xAtReference - expectedX) * 1.5)));
          const choice = choices[0];
          if(!choice){ valid = false; break; }
          selected.push(choice);
          deviation += Math.abs(choice.xAtReference - expectedX) / tolerance;
          lineScore += choice.score;
        }
        if(!valid) continue;
        selected.push(right);
        lineScore += right.score;
        // The rule sequence is structural evidence. A full-height paper edge can
        // have higher raw coverage than the true first/last table rule, so ratio
        // fit must dominate coverage when both sequences are otherwise viable.
        const score = lineScore - (deviation * 200);
        if(!best || score > best.score) best = {score, selected, lineScore, deviation};
      }
    }
    return best;
  }

  function verticalLineExtent(pixels, width, height, line, referenceY){
    let best = null;
    let segmentStart = null;
    let lastDark = null;
    let gap = 0;
    const closeSegment = () => {
      if(segmentStart == null || lastDark == null) return;
      const length = lastDark - segmentStart + 1;
      if(!best || length > best.length) best = {start: segmentStart, end: lastDark, length};
      segmentStart = null;
      lastDark = null;
      gap = 0;
    };
    for(let y = 0; y < height; y += 1){
      const x = line.xAtReference + (line.slope * (y - referenceY));
      if(x >= 0 && x < width && darkNear(pixels, width, height, x, y, 2)){
        if(segmentStart == null) segmentStart = y;
        lastDark = y;
        gap = 0;
      }else if(segmentStart != null){
        gap += 1;
        if(gap > 10) closeSegment();
      }
    }
    closeSegment();
    return best;
  }

  function horizontalLineScore(pixels, width, height, yAtReference, slope, referenceX, scanStartX = null, scanEndX = null){
    let score = 0;
    let samples = 0;
    const xStart = Number.isFinite(scanStartX) ? Math.max(0, Math.floor(scanStartX)) : Math.floor(width * 0.01);
    const xEnd = Number.isFinite(scanEndX) ? Math.min(width - 1, Math.ceil(scanEndX)) : Math.ceil(width * 0.99);
    for(let x = xStart; x <= xEnd; x += 2){
      const y = yAtReference + (slope * (x - referenceX));
      if(y < 0 || y >= height) continue;
      samples += 1;
      let dark = false;
      for(let delta = -2; delta <= 2; delta += 1){
        if(grayscaleAtFrame(pixels, width, height, x, y + delta) < 145){ dark = true; break; }
      }
      if(dark) score += 1;
    }
    return {score, samples};
  }

  function bestHorizontalBoundary(pixels, width, height, edge){
    const referenceX = width * 0.5;
    const start = edge === "top" ? Math.floor(height * 0.015) : Math.floor(height * 0.84);
    const end = edge === "top" ? Math.ceil(height * 0.16) : Math.ceil(height * 0.97);
    const candidates = [];
    for(let y = start; y <= end; y += 2){
      for(let slopeStep = -10; slopeStep <= 10; slopeStep += 1){
        const slope = slopeStep / 200;
        const value = horizontalLineScore(pixels, width, height, y, slope, referenceX);
        const candidate = {yAtReference: y, slope, referenceX, ...value};
        if(candidate.samples > 0 && candidate.score >= candidate.samples * 0.45) candidates.push(candidate);
      }
    }
    candidates.sort((left, right) => {
      const edgeOrder = edge === "top"
        ? left.yAtReference - right.yAtReference
        : right.yAtReference - left.yAtReference;
      return edgeOrder || right.score - left.score;
    });
    return candidates[0] || null;
  }

  function intersectVerticalHorizontal(vertical, verticalReferenceY, horizontal){
    const verticalIntercept = vertical.xAtReference - (vertical.slope * verticalReferenceY);
    const horizontalIntercept = horizontal.yAtReference - (horizontal.slope * horizontal.referenceX);
    const divisor = 1 - (vertical.slope * horizontal.slope);
    const x = (verticalIntercept + (vertical.slope * horizontalIntercept)) / divisor;
    return Object.freeze({x, y: horizontalIntercept + (horizontal.slope * x)});
  }

  function horizontalGridCandidates(pixels, width, height, scanStartX, scanEndX){
    const referenceX = width * 0.5;
    const values = [];
    for(let y = Math.floor(height * 0.14); y <= Math.ceil(height * 0.995); y += 2){
      let best = null;
      for(let slopeStep = -12; slopeStep <= 12; slopeStep += 1){
        const slope = slopeStep / 200;
        const value = horizontalLineScore(pixels, width, height, y, slope, referenceX, scanStartX, scanEndX);
        const candidate = {yAtReference: y, slope, referenceX, ...value};
        if(!best || candidate.score > best.score) best = candidate;
      }
      values.push(best);
    }
    const candidates = [];
    for(let index = 0; index < values.length; index += 1){
      const candidate = values[index];
      if(!candidate || candidate.score < candidate.samples * 0.28) continue;
      const neighborhood = values.slice(Math.max(0, index - 3), Math.min(values.length, index + 4));
      if(neighborhood.some(value => value && value.score > candidate.score)) continue;
      candidates.push(Object.freeze({...candidate, coverage: candidate.score / Math.max(1, candidate.samples)}));
    }
    return Object.freeze(candidates);
  }

  function selectHorizontalGrid(candidates, perspective, width, height, template){
    const topCandidates = candidates.filter(candidate => candidate.coverage >= 0.45 && candidate.yAtReference >= height * 0.12 && candidate.yAtReference <= height * 0.28);
    const bottomCandidates = candidates.filter(candidate => candidate.coverage >= 0.45 && candidate.yAtReference >= height * 0.9 && candidate.yAtReference <= height * 0.995);
    const canonicalX = template.width * 0.5;
    let best = null;
    for(const top of topCandidates){
      for(const bottom of bottomCandidates){
        if(bottom.yAtReference - top.yAtReference < height * 0.62) continue;
        const topCanonical = projectPoint(perspective.forward, {x: width * 0.5, y: top.yAtReference});
        const bottomCanonical = projectPoint(perspective.forward, {x: width * 0.5, y: bottom.yAtReference});
        if(bottomCanonical.y <= topCanonical.y) continue;
        const averageSpacing = (bottom.yAtReference - top.yAtReference) / 29;
        const tolerance = Math.max(5, averageSpacing * 0.38);
        const matched = [];
        const matchedByRow = Array(30).fill(null);
        let evidenceScore = 0;
        for(let row = 0; row < 30; row += 1){
          const canonicalY = topCanonical.y + ((bottomCanonical.y - topCanonical.y) * row / 29);
          const expected = projectPoint(perspective.inverse, {x: canonicalX, y: canonicalY});
          const choices = candidates
            .filter(candidate => Math.abs(candidate.yAtReference - expected.y) <= tolerance)
            .sort((left, right) => (right.score - (Math.abs(right.yAtReference - expected.y) * 3))
              - (left.score - (Math.abs(left.yAtReference - expected.y) * 3)));
          const choice = choices[0];
          if(choice && !matched.includes(choice)){
            matched.push(choice);
            matchedByRow[row] = choice;
            evidenceScore += choice.coverage;
          }
        }
        if(matched.length < 26) continue;
        const score = (matched.length * 100) + evidenceScore;
        const earlierTop = !best || top.yAtReference < best.topImageY - 3;
        const sameTopBetterEvidence = best && Math.abs(top.yAtReference - best.topImageY) <= 3 && score > best.score;
        if(earlierTop || sameTopBetterEvidence){
          best = {score, topImageY: top.yAtReference, topCanonicalY: topCanonical.y, bottomCanonicalY: bottomCanonical.y, matched, matchedByRow};
        }
      }
    }
    if(!best) return null;
    const canonicalRowBoundaries = best.matchedByRow.map(line => line
      ? projectPoint(perspective.forward, {x: width * 0.5, y: line.yAtReference}).y
      : null);
    for(let row = 0; row < canonicalRowBoundaries.length; row += 1){
      if(Number.isFinite(canonicalRowBoundaries[row])) continue;
      let before = row - 1;
      let after = row + 1;
      while(before >= 0 && !Number.isFinite(canonicalRowBoundaries[before])) before -= 1;
      while(after < canonicalRowBoundaries.length && !Number.isFinite(canonicalRowBoundaries[after])) after += 1;
      if(before >= 0 && after < canonicalRowBoundaries.length){
        const ratio = (row - before) / (after - before);
        canonicalRowBoundaries[row] = canonicalRowBoundaries[before]
          + ((canonicalRowBoundaries[after] - canonicalRowBoundaries[before]) * ratio);
      }else{
        canonicalRowBoundaries[row] = best.topCanonicalY
          + ((best.bottomCanonicalY - best.topCanonicalY) * row / 29);
      }
    }
    const boundariesAreMonotonic = canonicalRowBoundaries.every((value, row) => (
      Number.isFinite(value) && (row === 0 || value > canonicalRowBoundaries[row - 1])
    ));
    const expectedSpacing = (best.bottomCanonicalY - best.topCanonicalY) / 29;
    const rowGeometryStable = boundariesAreMonotonic
      && best.matched.length === 30
      && canonicalRowBoundaries.slice(1).every((value, row) => {
        const spacing = value - canonicalRowBoundaries[row];
        return spacing >= expectedSpacing * 0.68 && spacing <= expectedSpacing * 1.32;
      });
    const resolvedBoundaries = rowGeometryStable
      ? canonicalRowBoundaries
      : Array.from({length: 30}, (_unused, row) => (
        best.topCanonicalY + ((best.bottomCanonicalY - best.topCanonicalY) * row / 29)
      ));
    return Object.freeze({
      canonicalRowBoundaries: Object.freeze(resolvedBoundaries),
      horizontalLineCount: best.matched.length,
      averageCoverage: best.matched.reduce((sum, line) => sum + line.coverage, 0) / best.matched.length,
      rowGeometryStable,
    });
  }

  function detectFormRegistration(input = {}){
    const width = Number(input.width);
    const height = Number(input.height);
    const pixels = input.pixels;
    if(!(width > 0) || !(height > 0) || !pixels || pixels.length !== width * height * 4){
      throw new Error("invalid_form_image_frame");
    }
    const lines = bestVerticalLines(pixels, width, height);
    const gridCandidates = Object.values(TEMPLATES)
      .map(template => {
        const grid = selectFormGrid(lines, width, template);
        if(!grid) return {template, grid};
        const firstRule = grid.selected[0];
        const lastRule = grid.selected.at(-1);
        const formSpanRatio = (lastRule.xAtReference - firstRule.xAtReference) / width;
        const sequenceFit = Math.max(0, 1 - (grid.deviation / Math.max(1, grid.selected.length - 2)));
        const averageCoverage = grid.selected.reduce((sum, line) => (
          sum + (line.score / Math.max(1, line.samples))
        ), 0) / grid.selected.length;
        return {template, grid, formSpanRatio, sequenceFit, averageCoverage};
      })
      .filter(candidate => candidate.grid && candidate.grid.selected.length === candidate.template.columnBoundaries.length)
      .sort((left, right) => {
        // The outer rules must describe the whole form, not a visually dense
        // interior subset. This prevents an interior Template-A column rule
        // from being treated as the right edge of a shorter nine-rule form.
        const materialSpanDifference = Math.abs(right.formSpanRatio - left.formSpanRatio) > 0.06;
        if(materialSpanDifference) return right.formSpanRatio - left.formSpanRatio;
        const fitDifference = right.sequenceFit - left.sequenceFit;
        if(Math.abs(fitDifference) > 0.025) return fitDifference;
        const coverageDifference = right.averageCoverage - left.averageCoverage;
        if(Math.abs(coverageDifference) > 0.025) return coverageDifference;
        return right.grid.selected.length - left.grid.selected.length;
      });
    const selectedCandidate = gridCandidates[0] || null;
    const grid = selectedCandidate?.grid || null;
    const template = selectedCandidate?.template || null;
    if(grid && template){
      let left = grid.selected[0];
      let right = grid.selected.at(-1);
      const stableSlopes = grid.selected.slice(1, -1).map(line => line.slope).sort((a, b) => a - b);
      const stableSlope = stableSlopes[Math.floor(stableSlopes.length / 2)] || 0;
      let leftExtent = verticalLineExtent(pixels, width, height, left, lines.referenceY);
      let rightExtent = verticalLineExtent(pixels, width, height, right, lines.referenceY);
      if(!leftExtent || leftExtent.length <= height * 0.76){
        left = Object.freeze({...left, slope: stableSlope, inferredSlopeFromInteriorRules: true});
        leftExtent = verticalLineExtent(pixels, width, height, left, lines.referenceY);
      }
      if(!rightExtent || rightExtent.length <= height * 0.76){
        right = Object.freeze({...right, slope: stableSlope, inferredSlopeFromInteriorRules: true});
        rightExtent = verticalLineExtent(pixels, width, height, right, lines.referenceY);
      }
      const topBoundary = bestHorizontalBoundary(pixels, width, height, "top");
      const bottomBoundary = bestHorizontalBoundary(pixels, width, height, "bottom");
      const interiorCoverage = grid.selected.slice(1, -1)
        .reduce((sum, line) => sum + (line.score / Math.max(1, line.samples)), 0) / Math.max(1, grid.selected.length - 2);
      const leftExtentValid = leftExtent && (leftExtent.length > height * 0.76
        || (left.inferredSlopeFromInteriorRules === true && interiorCoverage >= 0.68));
      const rightExtentValid = rightExtent && (rightExtent.length > height * 0.76
        || (right.inferredSlopeFromInteriorRules === true && interiorCoverage >= 0.68));
      if(leftExtentValid && rightExtentValid
        && topBoundary && topBoundary.score >= topBoundary.samples * 0.45
        && bottomBoundary && bottomBoundary.score >= bottomBoundary.samples * 0.45){
        const averageLineCoverage = grid.selected.reduce((sum, line) => sum + (line.score / Math.max(1, line.samples)), 0) / grid.selected.length;
        const sequenceFit = Math.max(0, 1 - (grid.deviation / Math.max(1, grid.selected.length - 2)));
        const horizontalCoverage = Math.min(
          topBoundary.score / Math.max(1, topBoundary.samples),
          bottomBoundary.score / Math.max(1, bottomBoundary.samples),
        );
        const corners = Object.freeze([
          intersectVerticalHorizontal(left, lines.referenceY, topBoundary),
          intersectVerticalHorizontal(right, lines.referenceY, topBoundary),
          intersectVerticalHorizontal(right, lines.referenceY, bottomBoundary),
          intersectVerticalHorizontal(left, lines.referenceY, bottomBoundary),
        ]);
        const perspective = createPerspectiveTransform(corners, templateGridQuadrilateral(template));
        const scanStartX = Math.min(left.xAtReference, right.xAtReference) + 2;
        const scanEndX = Math.max(left.xAtReference, right.xAtReference) - 2;
        const horizontalGrid = selectHorizontalGrid(
          horizontalGridCandidates(pixels, width, height, scanStartX, scanEndX),
          perspective,
          width,
          height,
          template,
        );
        if(horizontalGrid) return Object.freeze({
          templateId: template.id,
          templateVersion: template.version,
          corners,
          confidence: clamp((averageLineCoverage * 0.55) + (sequenceFit * 0.25) + (horizontalCoverage * 0.2), 0, 1),
          source: "FORM_GRID_RULE_SEQUENCE",
          formSpanRatio: selectedCandidate.formSpanRatio,
          templateSelectionEvidence: Object.freeze({
            formSpanRatio: selectedCandidate.formSpanRatio,
            sequenceFit: selectedCandidate.sequenceFit,
            averageCoverage: selectedCandidate.averageCoverage,
            candidateCount: gridCandidates.length,
          }),
          verticalLineCount: grid.selected.length,
          horizontalBoundaryCount: 2,
          horizontalLineCount: horizontalGrid.horizontalLineCount,
          rowGeometryStable: horizontalGrid.rowGeometryStable,
          canonicalRowBoundaries: horizontalGrid.canonicalRowBoundaries,
          horizontalLineCoverage: horizontalGrid.averageCoverage,
          verticalLines: Object.freeze(grid.selected.map(line => Object.freeze({
            xAtReference: line.xAtReference,
            slope: line.slope,
            coverage: line.score / Math.max(1, line.samples),
          }))),
        });
      }
    }
    const insetX = Math.max(1, width * 0.01);
    const insetY = Math.max(1, height * 0.01);
    const diagnosticTopBoundary = grid ? bestHorizontalBoundary(pixels, width, height, "top") : null;
    const diagnosticBottomBoundary = grid ? bestHorizontalBoundary(pixels, width, height, "bottom") : null;
    return Object.freeze({
      corners: Object.freeze([
        Object.freeze({x: insetX, y: insetY}),
        Object.freeze({x: width - insetX, y: insetY}),
        Object.freeze({x: width - insetX, y: height - insetY}),
        Object.freeze({x: insetX, y: height - insetY}),
      ]),
      confidence: 0.25,
      templateId: "TEMPLATE_UNKNOWN",
      source: "FORM_GRID_REGISTRATION_FAILED",
      verticalLineCount: 0,
      verticalLines: Object.freeze([]),
      diagnostics: Object.freeze({
        candidateCount: lines.candidates.length,
        sequenceFound: Boolean(grid),
        selectedTemplateId: template?.id || "TEMPLATE_UNKNOWN",
        selectedLines: Object.freeze((grid?.selected || []).map(line => Object.freeze({...line}))),
        leftExtent: grid ? verticalLineExtent(pixels, width, height, grid.selected[0], lines.referenceY) : null,
        rightExtent: grid ? verticalLineExtent(pixels, width, height, grid.selected.at(-1), lines.referenceY) : null,
        topBoundary: diagnosticTopBoundary,
        bottomBoundary: diagnosticBottomBoundary,
        candidates: Object.freeze(lines.candidates),
      }),
    });
  }

  function registerTemplate(input = {}){
    const imageWidth = Number(input.imageWidth);
    const imageHeight = Number(input.imageHeight);
    if(!(imageWidth > 0) || !(imageHeight > 0)) throw new Error("invalid_form_image_dimensions");
    const template = templateFor(input.templateId || "TEMPLATE_A");
    if(!template) throw new Error("unknown_form_template");
    const original = (input.quadrilateral || fullImageQuadrilateral(imageWidth, imageHeight)).map((point, index) => finitePoint(point, `corner_${index}`));
    const canonical = templateGridQuadrilateral(template);
    const perspective = createPerspectiveTransform(original, canonical);
    const suppliedRows = Array.isArray(input.rowBoundaries) ? input.rowBoundaries.map(Number) : [];
    const rowBoundaries = suppliedRows.length === 30
      && suppliedRows.every(Number.isFinite)
      && suppliedRows.every((value, index) => index === 0 || value > suppliedRows[index - 1])
      ? suppliedRows
      : Array.from({length: 30}, (_unused, index) => template.dataTop + (((template.dataBottom - template.dataTop) / 29) * index));
    const cells = [];
    for(let rowIndex = 0; rowIndex < 29; rowIndex += 1){
      for(let columnIndex = 0; columnIndex < template.columns.length; columnIndex += 1){
        const canonicalBox = Object.freeze({
          x0: template.columnBoundaries[columnIndex],
          y0: rowBoundaries[rowIndex],
          x1: template.columnBoundaries[columnIndex + 1],
          y1: rowBoundaries[rowIndex + 1],
        });
        cells.push(Object.freeze({
          rowIndex,
          columnId: template.columns[columnIndex],
          canonicalBox,
          boundingBox: projectBox(perspective.inverse, canonicalBox),
        }));
      }
    }
    const metadataCells = template.metadata.map(item => Object.freeze({
      rowIndex: null,
      columnId: item.columnId,
      canonicalBox: item.canonicalBox,
      boundingBox: projectBox(perspective.inverse, item.canonicalBox),
    }));
    return Object.freeze({
      status: "FORM_REGISTRATION_COMPLETE",
      templateId: template.id,
      templateVersion: template.version,
      columnCount: template.columns.length,
      canonicalWidth: template.width,
      canonicalHeight: template.height,
      perspectiveCorrectionApplied: true,
      perspective,
      rowBoundaries: Object.freeze(rowBoundaries),
      cells: Object.freeze(cells),
      metadataCells: Object.freeze(metadataCells),
    });
  }

  function normalizerFor(columnId){
    if(columnId === "vehicleId") return "VEHICLE_ID";
    if(columnId === "toTrack") return "CANONICAL_SLOT";
    if(columnId === "wcWater") return "WC_WATER_SYMBOL";
    if(columnId === "arrivalTime" || columnId === "clock") return "TIME";
    if(columnId === "notes" || columnId === "info" || columnId === "signature" || columnId === "ds") return "FREE_TEXT";
    if(columnId === "date") return "DATE";
    return "TRAIN_IDENTIFIER";
  }

  function createRecognitionRequests(registration){
    if(!registration || registration.status !== "FORM_REGISTRATION_COMPLETE") throw new Error("form_registration_required");
    return Object.freeze([...registration.metadataCells, ...registration.cells].map(cell => Object.freeze({
      ...cell,
      templateId: registration.templateId,
      recognizerKind: "HYBRID_PRINT_OCR_HTR",
      recognizerKinds: Object.freeze(["PRINT_OCR", "HANDWRITING_HTR"]),
      normalizer: normalizerFor(cell.columnId),
      recognizerVersion: MODEL_SPEC.version,
    })));
  }

  function separateInkLayers(input = {}){
    const width = Number(input.width);
    const height = Number(input.height);
    const pixels = input.pixels;
    const gridMask = input.gridMask || new Uint8Array(width * height);
    const handwritingLuminanceThreshold = Number.isFinite(Number(input.handwritingLuminanceThreshold))
      ? clamp(Number(input.handwritingLuminanceThreshold), 80, 220)
      : 190;
    if(!(width > 0) || !(height > 0) || !pixels || pixels.length !== width * height * 4){
      throw new Error("invalid_color_layer_frame");
    }
    const printInk = new Uint8Array(width * height).fill(255);
    const handwritingInk = new Uint8Array(width * height).fill(255);
    const combinedInk = new Uint8Array(width * height).fill(255);
    let printInkPixels = 0;
    let handwritingInkPixels = 0;
    for(let index = 0; index < width * height; index += 1){
      if(gridMask[index]) continue;
      const offset = index * 4;
      const red = Number(pixels[offset]);
      const green = Number(pixels[offset + 1]);
      const blue = Number(pixels[offset + 2]);
      const luminance = (red * 0.299) + (green * 0.587) + (blue * 0.114);
      const redHue = red - green >= 12 && red - blue >= 12 && red >= green * 1.08;
      const redPrinted = (red >= 115 && red - green >= 45 && red - blue >= 35 && red >= green * 1.3)
        || (redHue && luminance <= 140);
      // Preserve anti-aliased pen edges for the recognizer. Grid pixels have
      // already been masked, while saturated red remains exclusively print.
      const darkHandwriting = luminance <= handwritingLuminanceThreshold && !redHue;
      if(redPrinted){
        printInk[index] = 0;
        combinedInk[index] = 0;
        printInkPixels += 1;
      }
      if(darkHandwriting){
        handwritingInk[index] = 0;
        combinedInk[index] = 0;
        handwritingInkPixels += 1;
      }
    }
    return Object.freeze({
      printInk,
      handwritingInk,
      combinedInk,
      printInkRatio: printInkPixels / Math.max(1, width * height),
      handwritingInkRatio: handwritingInkPixels / Math.max(1, width * height),
      gridPixelCount: [...gridMask].reduce((sum, value) => sum + (value ? 1 : 0), 0),
    });
  }

  function firstLayerCandidate(value){
    if(!value) return null;
    const text = String(value.text || "").normalize("NFKC").trim();
    return text ? Object.freeze({text, confidence: clamp(Number(value.confidence || 0), 0, 1)}) : null;
  }

  function reconcileLayerCandidates(input = {}, context = {}){
    const columnId = String(input.columnId || "");
    const printedCandidate = firstLayerCandidate(input.printedCandidate);
    const handwrittenCandidate = firstLayerCandidate(input.handwrittenCandidate);
    const printed = printedCandidate ? normalizeRecognition({columnId, candidates: [printedCandidate]}, context) : null;
    const handwritten = handwrittenCandidate ? normalizeRecognition({columnId, candidates: [handwrittenCandidate]}, context) : null;
    const printedValue = String(printed?.selectedValue || "");
    const handwrittenValue = String(handwritten?.selectedValue || "");
    if(input.strikeThroughDetected === true){
      const reviewText = handwrittenCandidate?.text || printedCandidate?.text || "";
      return Object.freeze({
        printedCandidate,
        handwrittenCandidate,
        finalCandidate: Object.freeze({text: reviewText, confidence: 0}),
        needsReview: true,
        reason: "STRIKETHROUGH_OR_CORRECTION",
      });
    }
    if(printedValue && handwrittenValue && printedValue !== handwrittenValue){
      const reviewText = handwrittenCandidate?.text || printedCandidate?.text || "";
      return Object.freeze({
        printedCandidate,
        handwrittenCandidate,
        finalCandidate: Object.freeze({text: reviewText, confidence: 0}),
        needsReview: true,
        reason: "PRINT_HANDWRITING_CONFLICT",
      });
    }
    const selected = printedValue
      ? {value: printedValue, normalized: printed, source: "PRINT_OCR"}
      : handwrittenValue
        ? {value: handwrittenValue, normalized: handwritten, source: "HANDWRITING_HTR"}
        : null;
    if(!selected){
      const reviewCandidate = handwrittenCandidate || printedCandidate;
      return Object.freeze({
        printedCandidate,
        handwrittenCandidate,
        finalCandidate: Object.freeze({text: reviewCandidate?.text || "", confidence: 0}),
        needsReview: Boolean(printedCandidate || handwrittenCandidate),
        reason: printedCandidate || handwrittenCandidate ? "UNSUPPORTED_LAYER_CANDIDATE" : "BLANK_IMAGE_CELL",
      });
    }
    const confidence = Math.max(Number(printed?.confidence || 0), Number(handwritten?.confidence || 0));
    return Object.freeze({
      printedCandidate,
      handwrittenCandidate,
      finalCandidate: Object.freeze({text: selected.value, confidence}),
      needsReview: selected.normalized.needsReview,
      reason: selected.normalized.normalizationReason,
      selectedLayer: selected.source,
      normalized: selected.normalized,
    });
  }

  function toCanonicalRow(templateId, source = {}){
    const template = templateFor(templateId);
    if(!template) throw new Error("unknown_form_template");
    const row = {};
    for(const columnId of CANONICAL_COLUMN_IDS){
      row[columnId] = template.columns.includes(columnId) ? String(source[columnId] || "") : "";
    }
    return Object.freeze(row);
  }

  function resolveSourceMetadata(input = {}){
    const template = templateFor(input.templateId);
    if(!template) return Object.freeze({clock: "", date: "", signature: "", ds: "", needsReview: true});
    const candidates = input.candidates && typeof input.candidates === "object" ? input.candidates : {};
    const date = normalizeDate(candidates.date);
    const signature = String(candidates.signature || "").normalize("NFKC").trim();
    const clock = template.id === "TEMPLATE_B" ? String(candidates.clock || "").normalize("NFKC").trim() : "";
    const ds = template.id === "TEMPLATE_A" ? String(candidates.ds || "").normalize("NFKC").trim() : "";
    return Object.freeze({clock, date, signature, ds, needsReview: !date || !signature});
  }

  function normalizedCandidates(recognition){
    const raw = Array.isArray(recognition?.candidates) ? recognition.candidates : [];
    return raw.map(candidate => ({
      text: String(candidate?.text || "").normalize("NFKC").trim(),
      confidence: clamp(Number(candidate?.confidence || 0), 0, 1),
    })).filter(candidate => candidate.text);
  }

  function canonicalizeVehicle(value){
    const compact = String(value || "").toUpperCase().replace(/[–—]/g, "-").replace(/\s+/g, "");
    const withSeparator = /^\d{4}$/.test(compact) ? `${compact.slice(0, 2)}-${compact.slice(2)}` : compact;
    const parts = withSeparator.split("-");
    if(parts.length !== 2) return "";
    const digits = part => part.replace(/[OQ]/g, "0").replace(/[IL|]/g, "1").replace(/Z/g, "2").replace(/S/g, "5").replace(/G/g, "6").replace(/B/g, "8");
    const left = digits(parts[0]);
    const right = digits(parts[1]);
    return /^\d{2}$/.test(left) && /^\d{2}$/.test(right) ? `${left}-${right}` : "";
  }

  function canonicalizeSlot(value){
    return String(value || "").normalize("NFKC").toUpperCase().replace(/\s+/g, "")
      .replace(/(?:-|=)+>/g, "→")
      .replace(/^(\d{1,2}[NSMV]?)\/(\d{1,2}[NSMV]?)$/, "$1→$2");
  }

  function normalizeTrain(value){
    const upper = String(value || "").normalize("NFKC").trim().toUpperCase().replace(/\s+/g, "");
    if(upper === "REP") return upper;
    const normalized = upper.replace(/[OQ]/g, "0").replace(/[IL|]/g, "1").replace(/\)/g, "2");
    return /^[1-9]\d{2,3}(?:[¹²]|\/[12])?$/.test(normalized) ? normalized : "";
  }

  function wcSymbol(value){
    const compact = String(value || "").trim();
    if(/[★☆*✱✳]/.test(compact)) return "*";
    if(/[✓✔√]/.test(compact)) return "CHECK";
    if(/[✕✖×xX]/.test(compact)) return "CROSS";
    if(/[○◯⭕]/.test(compact) || /^\([^)]*\)$/.test(compact)) return "CIRCLE";
    return "";
  }

  function normalizeDate(value){
    const raw = String(value || "").normalize("NFKC").trim();
    const digits = raw.toUpperCase()
      .replace(/[OQ]/g, "0")
      .replace(/[IL|]/g, "1")
      .replace(/Z/g, "2")
      .replace(/S/g, "5")
      .replace(/[G€]/g, "6")
      .replace(/B/g, "8")
      .replace(/\D/g, "");
    if(digits.length === 8){
      const day = Number(digits.slice(0, 2));
      const month = Number(digits.slice(2, 4));
      const year = Number(digits.slice(4));
      if(day >= 1 && day <= 31 && month >= 1 && month <= 12 && year >= 2000 && year <= 2199){
        return `${digits.slice(0, 2)}.${digits.slice(2, 4)}.${digits.slice(4)}`;
      }
    }
    return raw;
  }

  function normalizeTime(value){
    const raw = String(value || "").normalize("NFKC").trim().replace(/[.;]/g, ":");
    const compact = raw.replace(/\s+/g, "");
    const match = compact.match(/^(\d{1,2}):?(\d{2})$/);
    if(!match) return "";
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59
      ? `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`
      : "";
  }

  function unique(values){
    return [...new Set(values.filter(Boolean))];
  }

  function normalizeRecognition(recognition, context = {}){
    const columnId = String(recognition?.columnId || "");
    const normalizer = normalizerFor(columnId);
    const candidates = normalizedCandidates(recognition);
    const sourceAlternatives = [];
    let selectedValue = "";
    let validationState = "UNREADABLE";
    let confidence = candidates[0]?.confidence || 0;
    if(normalizer === "VEHICLE_ID"){
      for(const candidate of candidates){
        const normalized = canonicalizeVehicle(candidate.text);
        if(normalized){
          sourceAlternatives.push(normalized);
          if(!selectedValue){ selectedValue = normalized; confidence = candidate.confidence; }
        }
      }
      validationState = selectedValue ? (Array.isArray(context.vehicleCatalog) && context.vehicleCatalog.length && !context.vehicleCatalog.includes(selectedValue) ? "REVIEW_REQUIRED" : "VALID") : "UNSUPPORTED";
    }else if(normalizer === "CANONICAL_SLOT"){
      const canonicalSlots = new Set(Array.isArray(context.canonicalSlots) ? context.canonicalSlots.map(canonicalizeSlot) : []);
      for(const candidate of candidates){
        const normalized = canonicalizeSlot(candidate.text);
        const components = normalized.split("→");
        const target = components.at(-1);
        let accepted = canonicalSlots.has(normalized) ? normalized : (components.length > 1 && canonicalSlots.has(target) ? normalized : "");
        if(!accepted && !normalized.includes("→")){
          for(const targetSlot of canonicalSlots){
            if(!normalized.endsWith(targetSlot)) continue;
            const prefix = normalized.slice(0, normalized.length - targetSlot.length);
            const match = prefix.match(/^(\d{1,2}[NSMV]?)([0O+>/-])$/);
            if(match){
              accepted = `${match[1]}→${targetSlot}`;
              break;
            }
          }
        }
        if(accepted){
          sourceAlternatives.push(accepted);
          if(!selectedValue){ selectedValue = accepted; confidence = candidate.confidence; }
        }
      }
      validationState = selectedValue ? "VALID" : "UNSUPPORTED";
    }else if(normalizer === "WC_WATER_SYMBOL"){
      for(const candidate of candidates){
        const normalized = wcSymbol(candidate.text);
        if(normalized){
          sourceAlternatives.push(normalized);
          if(!selectedValue){ selectedValue = normalized; confidence = candidate.confidence; }
        }
      }
      validationState = selectedValue ? "VALID" : "UNREADABLE";
    }else if(normalizer === "TRAIN_IDENTIFIER"){
      for(const candidate of candidates){
        const normalized = normalizeTrain(candidate.text);
        if(normalized){
          sourceAlternatives.push(normalized);
          if(!selectedValue){ selectedValue = normalized; confidence = candidate.confidence; }
        }
      }
      validationState = selectedValue ? "VALID" : "UNREADABLE";
    }else if(normalizer === "DATE"){
      for(const candidate of candidates){
        const normalized = normalizeDate(candidate.text);
        if(normalized){
          sourceAlternatives.push(normalized);
          if(!selectedValue){ selectedValue = normalized; confidence = candidate.confidence; }
        }
      }
      validationState = selectedValue ? "VALID" : "UNREADABLE";
    }else if(normalizer === "TIME"){
      for(const candidate of candidates){
        const normalized = normalizeTime(candidate.text);
        if(normalized){
          sourceAlternatives.push(normalized);
          if(!selectedValue){ selectedValue = normalized; confidence = candidate.confidence; }
        }
      }
      validationState = selectedValue ? "VALID" : "UNREADABLE";
    }else{
      for(const candidate of candidates){
        sourceAlternatives.push(candidate.text);
        if(!selectedValue){ selectedValue = candidate.text; confidence = candidate.confidence; }
      }
      validationState = selectedValue ? "VALID" : "UNREADABLE";
    }
    const alternatives = unique(sourceAlternatives);
    // Handwritten identifiers can look plausible while one glyph is wrong or a
    // small superscript is missing. Keep the proposed value visible, but accept
    // it without review only at a precision-oriented confidence level.
    const reviewThresholds = Object.freeze({
      FREE_TEXT: 0.98,
      VEHICLE_ID: 0.91,
      CANONICAL_SLOT: 0.745,
      WC_WATER_SYMBOL: 0.98,
      TRAIN_IDENTIFIER: 0.98,
      DATE: 0.98,
      TIME: 0.98,
    });
    const threshold = reviewThresholds[normalizer] ?? 0.995;
    const materialCompetition = alternatives.length > 1
      && candidates.length > 1
      && Math.abs(candidates[0].confidence - candidates[1].confidence) < 0.04;
    const needsReview = !selectedValue || confidence < threshold || validationState !== "VALID" || materialCompetition;
    const normalizationReason = !selectedValue
      ? "NO_VALID_IMAGE_BASED_CANDIDATE"
      : validationState !== "VALID"
        ? "FIELD_VALIDATION_REQUIRES_REVIEW"
        : materialCompetition
          ? "COMPETING_IMAGE_CANDIDATES"
          : confidence < threshold
            ? "CONFIDENCE_REQUIRES_REVIEW"
            : "IMAGE_CANDIDATE_PASSED_FIELD_VALIDATION";
    if(!selectedValue) confidence = Math.min(confidence, 0.49);
    return Object.freeze({
      selectedValue,
      normalizedValue: selectedValue,
      confidence,
      alternatives: Object.freeze(alternatives),
      needsReview,
      validationState,
      normalizer,
      normalizationReason,
    });
  }

  function buildMappingReport(input = {}){
    const cells = Array.isArray(input.cells) ? input.cells : [];
    const metadataCells = Array.isArray(input.metadataCells) ? input.metadataCells : [];
    const template = templateFor(input.templateId || "TEMPLATE_A");
    const expectedCellCount = template ? 29 * template.columns.length : 0;
    const expectedMetadata = template ? template.metadata.map(item => item.columnId) : [];
    const mappedCellCount = cells.filter(cell => String(cell?.selectedValue || "").trim()).length;
    const allRecognizedCells = [...metadataCells, ...cells];
    const reviewedCellCount = allRecognizedCells.filter(cell => cell?.needsReview === true).length;
    let mappingStatus;
    if(input.htrCompleted !== true) mappingStatus = "RECOGNITION_FAILED";
    else if(!template || input.registrationStatus !== "CELL_SEGMENTATION_COMPLETE" || cells.length !== expectedCellCount
      || metadataCells.length !== expectedMetadata.length
      || metadataCells.some(cell => !expectedMetadata.includes(String(cell?.columnId || "")))) mappingStatus = "MAPPING_FAILED";
    else if(mappedCellCount <= 1) mappingStatus = "MAPPING_FAILED";
    else if(reviewedCellCount > 0) mappingStatus = "FORM_MAPPING_REQUIRES_REVIEW";
    else mappingStatus = "FORM_MAPPING_COMPLETE";
    const confidenceValues = allRecognizedCells.map(cell => Number(cell?.confidence)).filter(Number.isFinite);
    return Object.freeze({
      schemaVersion: "sde-night-form-mapping-report-v3",
      mappingStatus,
      htrCompleted: input.htrCompleted === true,
      registrationStatus: String(input.registrationStatus || ""),
      templateId: template?.id || "TEMPLATE_UNKNOWN",
      templateVersion: template?.version || "unknown",
      columnCount: template?.columns.length || 0,
      recognitionMode: "HYBRID_PRINT_OCR_HTR",
      recognizerVersion: MODEL_SPEC.version,
      modelSha256: MODEL_SPEC.modelSha256,
      cellCount: cells.length,
      mappedCellCount,
      reviewedCellCount,
      requiresHumanReview: reviewedCellCount > 0 || mappingStatus !== "FORM_MAPPING_COMPLETE",
      mappingConfidence: confidenceValues.length ? confidenceValues.reduce((sum, value) => sum + value, 0) / confidenceValues.length : 0,
      cells: Object.freeze(cells.map(cell => Object.freeze({...cell}))),
      metadataCells: Object.freeze(metadataCells.map(cell => Object.freeze({...cell}))),
    });
  }

  function applyHumanCorrection(cell, finalValue){
    const selectedValue = String(finalValue == null ? "" : finalValue).normalize("NFKC").trim();
    return Object.freeze({
      ...cell,
      selectedValue,
      normalizedValue: selectedValue,
      humanFinalValue: selectedValue,
      needsReview: false,
      groundTruthSource: "HUMAN_CORRECTED_FORM",
      rawRecognizerIsGroundTruth: false,
      normalizationReason: "HUMAN_CORRECTED_FORM",
    });
  }

  function createRecognitionSession(sourceImageFingerprint){
    return Object.freeze({
      sourceImageFingerprint: String(sourceImageFingerprint || ""),
      cells: Object.freeze([]),
      status: "IMAGE_PREPROCESSING",
    });
  }

  function recordRecognition(session, cell){
    return Object.freeze({...session, cells: Object.freeze([...(session?.cells || []), Object.freeze({...cell})])});
  }

  function replaceRecognitionImage(_session, sourceImageFingerprint){
    return createRecognitionSession(sourceImageFingerprint);
  }

  async function digestSha256(bytes){
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if(globalThis.crypto?.subtle?.digest){
      const digest = await globalThis.crypto.subtle.digest("SHA-256", view);
      return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
    }
    if(typeof require === "function") return require("node:crypto").createHash("sha256").update(view).digest("hex");
    throw new Error("sha256_unavailable");
  }

  async function verifyModelBytes(bytes, manifest){
    const expected = String(manifest?.modelSha256 || "").toLowerCase();
    if(!/^[a-f0-9]{64}$/.test(expected)) throw new Error("invalid_model_manifest_hash");
    const actual = await digestSha256(bytes);
    if(actual !== expected) throw new Error("model_hash_mismatch");
    return true;
  }

  function supportsLocalRuntime(environment = globalThis){
    return typeof environment?.Worker === "function"
      && Boolean(environment?.WebAssembly)
      && typeof environment?.crypto?.subtle?.digest === "function";
  }

  function detectStrikeThrough(layer, width, height){
    if(!layer || width < 4 || height < 4 || layer.length < width * height) return false;
    const longestRunAt = y => {
      let longest = 0;
      let current = 0;
      for(let x = 0; x < width; x += 1){
        if(layer[(y * width) + x] === 0){
          current += 1;
          longest = Math.max(longest, current);
        }else{
          current = 0;
        }
      }
      return longest;
    };
    const firstRow = Math.max(1, Math.floor(height * 0.2));
    const lastRow = Math.min(height - 2, Math.ceil(height * 0.8));
    for(let y = firstRow; y <= lastRow; y += 1){
      if(longestRunAt(y) < width * 0.72) continue;
      if(Math.max(longestRunAt(y - 1), longestRunAt(y + 1)) >= width * 0.45) return true;
    }
    return false;
  }

  function clamp(value, minimum, maximum){
    return Math.max(minimum, Math.min(maximum, value));
  }

  return Object.freeze({
    CANONICAL_COLUMN_IDS,
    COLUMN_IDS,
    MODEL_SPEC,
    PIPELINE_STAGES,
    TEMPLATE,
    TEMPLATE_A,
    TEMPLATE_A_COLUMN_IDS,
    TEMPLATE_B,
    TEMPLATE_B_COLUMN_IDS,
    TEMPLATES,
    applyHumanCorrection,
    buildMappingReport,
    createPerspectiveTransform,
    createRecognitionRequests,
    createRecognitionSession,
    detectStrikeThrough,
    detectFormRegistration,
    detectTemplateVariant,
    normalizeRecognition,
    projectPoint,
    reconcileLayerCandidates,
    recordRecognition,
    registerTemplate,
    replaceRecognitionImage,
    resolveSourceMetadata,
    separateInkLayers,
    supportsLocalRuntime,
    toCanonicalRow,
    verifyModelBytes,
  });
});
