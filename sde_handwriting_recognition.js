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
    id: "ronylicha/gigapdf-ocr-handwriting",
    revision: "9885c6b4022786860968e6f7be5ba50441cb395d",
    version: "gigapdf-crnn-handwriting@9885c6b4",
    modelSha256: "969d1899ed80afd51a1a37c888f0c239292738af9a1a08f6f4191f083565f5b3",
    runtime: "onnxruntime-web@1.27.0",
    executionProvider: "wasm",
    remoteModelsAllowed: false,
    handwritingCapable: true,
    requiresWebGpu: false,
  });
  const PRINT_MODEL_SPEC = Object.freeze({
    id: "PaddlePaddle/latin_PP-OCRv5_mobile_rec_onnx",
    revision: "89d3a50e2c27e2e7cceeab0e944c25c807d5db4f",
    version: "latin-pp-ocrv5-mobile-rec-onnx@89d3a50e",
    modelSha256: "7888113072263cb471b93f66dd5e2ad70548dc526fa1ace760d0d973dd121498",
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

  function selectFormGridWithInferredLeftBoundary(lines, width, template){
    const ratios = template.columnBoundaries.map(value => (
      (value - template.columnBoundaries[0])
      / (template.columnBoundaries.at(-1) - template.columnBoundaries[0])
    ));
    if(ratios.length < 3) return null;
    const firstObservedRatio = ratios[1];
    const firstObservedCandidates = lines.candidates.filter(candidate => candidate.xAtReference < width * 0.45);
    const rightCandidates = lines.candidates.filter(candidate => candidate.xAtReference > width * 0.55);
    let best = null;
    for(const firstObserved of firstObservedCandidates){
      for(const right of rightCandidates){
        const span = (right.xAtReference - firstObserved.xAtReference) / (1 - firstObservedRatio);
        const inferredLeftX = right.xAtReference - span;
        if(span < width * 0.75 || inferredLeftX < width * 0.005 || inferredLeftX > width * 0.2) continue;
        const tolerance = Math.max(5, span * 0.022);
        const observed = [firstObserved];
        let deviation = 0;
        let lineScore = firstObserved.score;
        let valid = true;
        for(const ratio of ratios.slice(2, -1)){
          const expectedX = inferredLeftX + (span * ratio);
          const choices = lines.candidates
            .filter(candidate => Math.abs(candidate.xAtReference - expectedX) <= tolerance)
            .sort((a, b) => (b.score - (Math.abs(b.xAtReference - expectedX) * 1.5))
              - (a.score - (Math.abs(a.xAtReference - expectedX) * 1.5)));
          const choice = choices[0];
          if(!choice){ valid = false; break; }
          observed.push(choice);
          deviation += Math.abs(choice.xAtReference - expectedX) / tolerance;
          lineScore += choice.score;
        }
        if(!valid) continue;
        observed.push(right);
        lineScore += right.score;
        const averageCoverage = observed.reduce((sum, line) => (
          sum + (line.score / Math.max(1, line.samples))
        ), 0) / observed.length;
        const sequenceFit = Math.max(0, 1 - (deviation / Math.max(1, observed.length - 2)));
        const sortedSlopes = observed.map(line => line.slope).sort((a, b) => a - b);
        const medianSlope = sortedSlopes[Math.floor(sortedSlopes.length / 2)] || 0;
        const maximumSlopeDeviation = Math.max(...observed.map(line => Math.abs(line.slope - medianSlope)));
        if(averageCoverage < 0.45 || sequenceFit < 0.78 || maximumSlopeDeviation > 0.075) continue;
        const inferredLeft = Object.freeze({
          xAtReference: inferredLeftX,
          slope: firstObserved.slope,
          score: 0,
          samples: firstObserved.samples,
          inferred: true,
        });
        const selected = [inferredLeft, ...observed];
        const score = lineScore - (deviation * 200) - (maximumSlopeDeviation * 1000);
        if(!best || score > best.score){
          best = {
            score,
            selected,
            lineScore,
            deviation,
            observedLineCount: observed.length,
            inferredBoundary: "LEFT",
          };
        }
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

  function bestHorizontalBoundary(pixels, width, height, edge, expectedSlope = null){
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
    const slopeCoherentCandidates = Number.isFinite(expectedSlope)
      ? candidates.filter(candidate => Math.abs(candidate.slope - expectedSlope) <= 0.03)
      : candidates;
    slopeCoherentCandidates.sort((left, right) => {
      const edgeOrder = edge === "top"
        ? left.yAtReference - right.yAtReference
        : right.yAtReference - left.yAtReference;
      return edgeOrder || right.score - left.score;
    });
    return slopeCoherentCandidates[0] || null;
  }

  function intersectVerticalHorizontal(vertical, verticalReferenceY, horizontal){
    const verticalIntercept = vertical.xAtReference - (vertical.slope * verticalReferenceY);
    const horizontalIntercept = horizontal.yAtReference - (horizontal.slope * horizontal.referenceX);
    const divisor = 1 - (vertical.slope * horizontal.slope);
    const x = (verticalIntercept + (vertical.slope * horizontalIntercept)) / divisor;
    return Object.freeze({x, y: horizontalIntercept + (horizontal.slope * x)});
  }

  function horizontalGridCandidates(pixels, width, height, scanStartX, scanEndX, scanStartRatio = 0.14){
    const referenceX = width * 0.5;
    const values = [];
    for(let y = Math.floor(height * scanStartRatio); y <= Math.ceil(height * 0.995); y += 2){
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

  function selectHorizontalGrid(candidates, perspective, width, height, template, diagnostics = null){
    const topCandidates = candidates.filter(candidate => candidate.coverage >= 0.45 && candidate.yAtReference >= height * 0.12 && candidate.yAtReference <= height * 0.28);
    const bottomCandidates = candidates.filter(candidate => candidate.coverage >= 0.45 && candidate.yAtReference >= height * 0.9 && candidate.yAtReference <= height * 0.995);
    const canonicalX = template.width * 0.5;
    let best = null;
    let maximumMatchedLineCount = 0;
    let maximumMatchedTop = null;
    let maximumMatchedBottom = null;
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
        if(matched.length > maximumMatchedLineCount){
          maximumMatchedLineCount = matched.length;
          maximumMatchedTop = top.yAtReference;
          maximumMatchedBottom = bottom.yAtReference;
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
    if(diagnostics && typeof diagnostics === "object"){
      diagnostics.maximumMatchedLineCount = maximumMatchedLineCount;
      diagnostics.maximumMatchedTop = maximumMatchedTop;
      diagnostics.maximumMatchedBottom = maximumMatchedBottom;
      diagnostics.topCandidateCount = topCandidates.length;
      diagnostics.bottomCandidateCount = bottomCandidates.length;
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
    let diagnosticHorizontalCandidates = Object.freeze([]);
    const diagnosticHorizontalSelection = {};
    let diagnosticTopBoundary = null;
    let diagnosticBottomBoundary = null;
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
      .filter(candidate => candidate.grid && candidate.grid.selected.length === candidate.template.columnBoundaries.length);
    if(!gridCandidates.some(candidate => candidate.template.id === "TEMPLATE_B")){
      const template = TEMPLATE_B;
      const grid = selectFormGridWithInferredLeftBoundary(lines, width, template);
      if(grid){
        const firstRule = grid.selected[0];
        const lastRule = grid.selected.at(-1);
        const formSpanRatio = (lastRule.xAtReference - firstRule.xAtReference) / width;
        const sequenceFit = Math.max(0, 1 - (grid.deviation / Math.max(1, grid.observedLineCount - 2)));
        const observedLines = grid.selected.filter(line => line.inferred !== true);
        const averageCoverage = observedLines.reduce((sum, line) => (
          sum + (line.score / Math.max(1, line.samples))
        ), 0) / observedLines.length;
        gridCandidates.push({template, grid, formSpanRatio, sequenceFit, averageCoverage});
      }
    }
    gridCandidates.sort((left, right) => {
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
      const scanStartX = Math.min(left.xAtReference, right.xAtReference) + 2;
      const scanEndX = Math.max(left.xAtReference, right.xAtReference) - 2;
      diagnosticHorizontalCandidates = horizontalGridCandidates(
        pixels,
        width,
        height,
        scanStartX,
        scanEndX,
        grid.inferredBoundary === "LEFT" ? 0.06 : 0.14,
      );
      const horizontalSlopes = diagnosticHorizontalCandidates
        .filter(line => line.coverage >= 0.45)
        .map(line => line.slope)
        .sort((a, b) => a - b);
      const expectedHorizontalSlope = grid.inferredBoundary === "LEFT"
        ? horizontalSlopes[Math.floor(horizontalSlopes.length / 2)]
        : null;
      const topBoundary = bestHorizontalBoundary(pixels, width, height, "top", expectedHorizontalSlope);
      const bottomBoundary = bestHorizontalBoundary(pixels, width, height, "bottom", expectedHorizontalSlope);
      diagnosticTopBoundary = topBoundary;
      diagnosticBottomBoundary = bottomBoundary;
      const interiorCoverage = grid.selected.slice(1, -1)
        .reduce((sum, line) => sum + (line.score / Math.max(1, line.samples)), 0) / Math.max(1, grid.selected.length - 2);
      const leftExtentValid = grid.inferredBoundary === "LEFT"
        ? interiorCoverage >= 0.68
        : leftExtent && (leftExtent.length > height * 0.76
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
        const horizontalGrid = selectHorizontalGrid(
          diagnosticHorizontalCandidates,
          perspective,
          width,
          height,
          template,
          diagnosticHorizontalSelection,
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
          observedVerticalLineCount: grid.observedLineCount || grid.selected.length,
          inferredVerticalBoundary: grid.inferredBoundary || "",
          horizontalBoundaryCount: 2,
          horizontalLineCount: horizontalGrid.horizontalLineCount,
          rowGeometryStable: horizontalGrid.rowGeometryStable,
          canonicalRowBoundaries: horizontalGrid.canonicalRowBoundaries,
          horizontalLineCoverage: horizontalGrid.averageCoverage,
          verticalLines: Object.freeze(grid.selected.map(line => Object.freeze({
            xAtReference: line.xAtReference,
            slope: line.slope,
            coverage: line.score / Math.max(1, line.samples),
            inferred: line.inferred === true,
          }))),
        });
      }
    }
    const insetX = Math.max(1, width * 0.01);
    const insetY = Math.max(1, height * 0.01);
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
        horizontalCandidateCount: diagnosticHorizontalCandidates.length,
        horizontalCandidates: Object.freeze(diagnosticHorizontalCandidates.map(line => Object.freeze({
          yAtReference: line.yAtReference,
          slope: line.slope,
          coverage: line.coverage,
        }))),
        horizontalSelection: Object.freeze({...diagnosticHorizontalSelection}),
        candidates: Object.freeze(lines.candidates),
      }),
    });
  }

  function formRegistrationFailureMessage(detected = {}){
    const diagnostics = detected?.diagnostics && typeof detected.diagnostics === "object"
      ? detected.diagnostics
      : {};
    const selectedLines = Array.isArray(diagnostics.selectedLines) ? diagnostics.selectedLines : [];
    const inferredBoundary = String(detected.inferredVerticalBoundary || (
      selectedLines.some(line => line?.inferred === true) ? "LEFT" : ""
    ));
    const templateId = String(detected.templateId || diagnostics.selectedTemplateId || "TEMPLATE_UNKNOWN");
    const verticalLineCount = Number.isFinite(Number(detected.verticalLineCount)) && Number(detected.verticalLineCount) > 0
      ? Number(detected.verticalLineCount)
      : selectedLines.length;
    const observedVerticalLineCount = Number.isFinite(Number(detected.observedVerticalLineCount))
      ? Number(detected.observedVerticalLineCount)
      : selectedLines.filter(line => line?.inferred !== true).length;
    const maximumMatchedRows = Number(detected.horizontalLineCount
      ?? diagnostics.horizontalSelection?.maximumMatchedLineCount
      ?? 0);
    const confidence = Number.isFinite(Number(detected.confidence)) ? Number(detected.confidence) : 0;
    const parts = ["form_registration_failed"];
    if(detected.source !== "FORM_GRID_RULE_SEQUENCE"){
      const candidateCount = Number(diagnostics.candidateCount || 0);
      parts.push(`ingen sikker 7-/9-linjers malsekvens; fant ${candidateCount} vertikale kandidater`);
    }
    parts.push(`mal ${templateId}`);
    if(verticalLineCount > 0){
      const inferred = inferredBoundary === "LEFT" ? "; venstre yttergrense inferert" : "";
      parts.push(`${verticalLineCount} vertikale linjer (${observedVerticalLineCount} observert${inferred})`);
    }
    if(maximumMatchedRows !== 30) parts.push(`fant ${maximumMatchedRows} av 30 radlinjer`);
    if(detected.rowGeometryStable !== true) parts.push("radgeometrien er ustabil");
    parts.push(`sikkerhet ${confidence.toFixed(3)}`);
    return parts.join(" · ");
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
      recognizerKind: "LOCAL_REAL_HTR_ENSEMBLE",
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
    return text ? Object.freeze({
      text,
      confidence: clamp(Number(value.confidence || 0), 0, 1),
      votes: Math.max(0, Math.floor(Number(value.votes || 0))),
    }) : null;
  }

  function reconcileLayerCandidates(input = {}, context = {}){
    const columnId = String(input.columnId || "");
    const printedCandidate = firstLayerCandidate(input.printedCandidate);
    const handwrittenCandidate = firstLayerCandidate(input.handwrittenCandidate);
    const printed = printedCandidate ? normalizeRecognition({columnId, candidates: [printedCandidate]}, context) : null;
    const handwritten = handwrittenCandidate ? normalizeRecognition({columnId, candidates: [handwrittenCandidate]}, context) : null;
    const printedValue = String(printed?.normalizedValue || "");
    const handwrittenValue = String(handwritten?.normalizedValue || "");
    if(input.strikeThroughDetected === true){
      const reviewText = handwrittenCandidate?.text || printedCandidate?.text || "";
      return Object.freeze({
        printedCandidate,
        handwrittenCandidate,
        finalCandidate: Object.freeze({text: reviewText, confidence: 0, votes: 0}),
        needsReview: true,
        reason: "STRIKETHROUGH_OR_CORRECTION",
      });
    }
    const unresolvedLayer = printedValue && !handwrittenValue
      ? handwrittenCandidate
      : handwrittenValue && !printedValue
        ? printedCandidate
        : null;
    const unresolvedLayerConflict = unresolvedLayer
      && Number(unresolvedLayer.votes || 0) >= 2
      && Number(unresolvedLayer.confidence || 0) >= 0.50
      && Number(unresolvedLayer.confidence || 0) < 0.75;
    const printedStrength = Number(printedCandidate?.confidence || 0) + (Math.min(4, Number(printedCandidate?.votes || 0)) * 0.05);
    const handwrittenStrength = Number(handwrittenCandidate?.confidence || 0) + (Math.min(4, Number(handwrittenCandidate?.votes || 0)) * 0.05);
    const competingLayerConflict = printedValue && handwrittenValue && printedValue !== handwrittenValue
      && Math.abs(printedStrength - handwrittenStrength) < 0.12;
    if(competingLayerConflict || unresolvedLayerConflict){
      const reviewText = handwrittenCandidate?.text || printedCandidate?.text || "";
      return Object.freeze({
        printedCandidate,
        handwrittenCandidate,
        finalCandidate: Object.freeze({text: reviewText, confidence: 0, votes: 0}),
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
        finalCandidate: Object.freeze({text: reviewCandidate?.text || "", confidence: 0, votes: reviewCandidate?.votes || 0}),
        needsReview: Boolean(printedCandidate || handwrittenCandidate),
        reason: printedCandidate || handwrittenCandidate ? "UNSUPPORTED_LAYER_CANDIDATE" : "BLANK_IMAGE_CELL",
      });
    }
    const confidence = Math.max(Number(printed?.confidence || 0), Number(handwritten?.confidence || 0));
    return Object.freeze({
      printedCandidate,
      handwrittenCandidate,
      finalCandidate: Object.freeze({text: selected.value, confidence, votes: Math.max(printedCandidate?.votes || 0, handwrittenCandidate?.votes || 0)}),
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
      votes: Math.max(0, Math.floor(Number(candidate?.votes || 0))),
      sourceLayer: String(candidate?.sourceLayer || ""),
    })).filter(candidate => candidate.text);
  }

  function classifyBlankCell(input = {}){
    const width = Math.floor(Number(input.width));
    const height = Math.floor(Number(input.height));
    const image = input.image;
    const gridMask = input.gridMask;
    if(!(width > 3) || !(height > 3) || !image || image.length < width * height){
      throw new Error("invalid_blank_classifier_frame");
    }
    const darkThreshold = clamp(Number(input.darkThreshold || 205), 80, 245);
    const foreground = new Uint8Array(width * height);
    let inkPixelCount = 0;
    for(let y = 2; y < height - 2; y += 1){
      for(let x = 2; x < width - 2; x += 1){
        const index = (y * width) + x;
        if(gridMask?.[index] || Number(image[index]) >= darkThreshold) continue;
        foreground[index] = 1;
        inkPixelCount += 1;
      }
    }
    const visited = new Uint8Array(width * height);
    let meaningfulComponentCount = 0;
    let largestComponentPixels = 0;
    let meaningfulPixels = 0;
    for(let start = 0; start < foreground.length; start += 1){
      if(!foreground[start] || visited[start]) continue;
      const queue = [start];
      visited[start] = 1;
      let cursor = 0;
      let size = 0;
      let minX = width;
      let maxX = 0;
      let minY = height;
      let maxY = 0;
      while(cursor < queue.length){
        const index = queue[cursor++];
        const x = index % width;
        const y = Math.floor(index / width);
        size += 1;
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        for(let dy = -1; dy <= 1; dy += 1){
          for(let dx = -1; dx <= 1; dx += 1){
            if(dx === 0 && dy === 0) continue;
            const nx = x + dx;
            const ny = y + dy;
            if(nx < 2 || nx >= width - 2 || ny < 2 || ny >= height - 2) continue;
            const next = (ny * width) + nx;
            if(foreground[next] && !visited[next]){ visited[next] = 1; queue.push(next); }
          }
        }
      }
      const componentWidth = maxX - minX + 1;
      const componentHeight = maxY - minY + 1;
      const gridLike = (componentWidth >= width * 0.62 && componentHeight <= 4)
        || (componentHeight >= height * 0.62 && componentWidth <= 4);
      const meaningful = !gridLike && size >= 5 && (componentWidth >= 3 || componentHeight >= 3);
      if(meaningful){
        meaningfulComponentCount += 1;
        meaningfulPixels += size;
        largestComponentPixels = Math.max(largestComponentPixels, size);
      }
    }
    const usableArea = Math.max(1, (width - 4) * (height - 4));
    const meaningfulInkRatio = meaningfulPixels / usableArea;
    const blank = meaningfulComponentCount === 0
      || (largestComponentPixels < 8 && meaningfulInkRatio < 0.004)
      || meaningfulInkRatio < 0.0018;
    return Object.freeze({
      blank,
      inkPixelCount,
      meaningfulPixels,
      meaningfulInkRatio,
      meaningfulComponentCount,
      largestComponentPixels,
      reason: blank ? "NO_MEANINGFUL_INK" : "MEANINGFUL_INK_PRESENT",
    });
  }

  function classifyWcWaterSymbol(input = {}){
    const width = Math.floor(Number(input.width));
    const height = Math.floor(Number(input.height));
    const image = input.image;
    if(!(width > 8) || !(height > 8) || !image || image.length < width * height){
      throw new Error("invalid_wc_water_symbol_frame");
    }
    const rowInk = Array.from({length: height}, () => 0);
    const columnInk = Array.from({length: width}, () => 0);
    for(let y = 2; y < height - 2; y += 1) for(let x = 2; x < width - 2; x += 1){
      if(Number(image[(y * width) + x]) < 128){ rowInk[y] += 1; columnInk[x] += 1; }
    }
    let points = [];
    for(let y = 2; y < height - 2; y += 1){
      for(let x = 2; x < width - 2; x += 1){
        if(Number(image[(y * width) + x]) < 128 && rowInk[y] < width * 0.55 && columnInk[x] < height * 0.82) points.push({x, y});
      }
    }
    if(points.length < 18) return Object.freeze({symbol: "", confidence: 0, reason: "NO_SYMBOL_INK"});
    const pointKeys = new Set(points.map(point => `${point.x}:${point.y}`));
    const visited = new Set();
    const components = [];
    for(const seed of points){
      const seedKey = `${seed.x}:${seed.y}`;
      if(visited.has(seedKey)) continue;
      const queue = [seed];
      visited.add(seedKey);
      const component = [];
      for(let cursor = 0; cursor < queue.length; cursor += 1){
        const point = queue[cursor];
        component.push(point);
        for(let dy = -1; dy <= 1; dy += 1) for(let dx = -1; dx <= 1; dx += 1){
          if(!dx && !dy) continue;
          const key = `${point.x + dx}:${point.y + dy}`;
          if(pointKeys.has(key) && !visited.has(key)){
            visited.add(key);
            queue.push({x: point.x + dx, y: point.y + dy});
          }
        }
      }
      const x0 = Math.min(...component.map(point => point.x));
      const x1 = Math.max(...component.map(point => point.x));
      const y0 = Math.min(...component.map(point => point.y));
      const y1 = Math.max(...component.map(point => point.y));
      const componentAspect = (x1 - x0 + 1) / Math.max(1, y1 - y0 + 1);
      if(component.length >= 10 && componentAspect >= 0.45 && componentAspect <= 1.9 && y1 - y0 + 1 >= height * 0.22){
        components.push({component, x0, x1, y0, y1, area: (x1 - x0 + 1) * (y1 - y0 + 1)});
      }
    }
    components.sort((left, right) => right.area - left.area);
    if(components[0]){
      const focus = components[0];
      const padX = Math.max(2, (focus.x1 - focus.x0 + 1) * 0.18);
      const padY = Math.max(2, (focus.y1 - focus.y0 + 1) * 0.18);
      points = points.filter(point => point.x >= focus.x0 - padX && point.x <= focus.x1 + padX && point.y >= focus.y0 - padY && point.y <= focus.y1 + padY);
    }
    const minX = Math.min(...points.map(point => point.x));
    const maxX = Math.max(...points.map(point => point.x));
    const minY = Math.min(...points.map(point => point.y));
    const maxY = Math.max(...points.map(point => point.y));
    const boxWidth = maxX - minX + 1;
    const boxHeight = maxY - minY + 1;
    const aspect = boxWidth / Math.max(1, boxHeight);
    const occupancy = points.length / Math.max(1, boxWidth * boxHeight);
    const centerX0 = minX + (boxWidth * 0.34);
    const centerX1 = minX + (boxWidth * 0.66);
    const centerY0 = minY + (boxHeight * 0.34);
    const centerY1 = minY + (boxHeight * 0.66);
    const centerInk = points.filter(point => point.x >= centerX0 && point.x <= centerX1 && point.y >= centerY0 && point.y <= centerY1).length;
    const centerDensity = centerInk / Math.max(1, (centerX1 - centerX0) * (centerY1 - centerY0));
    const quadrants = [
      points.some(point => point.x < centerX0 && point.y < centerY0),
      points.some(point => point.x > centerX1 && point.y < centerY0),
      points.some(point => point.x < centerX0 && point.y > centerY1),
      points.some(point => point.x > centerX1 && point.y > centerY1),
    ].filter(Boolean).length;
    const circledAsterisk = aspect >= 0.62 && aspect <= 1.55
      && boxHeight >= height * 0.32
      && occupancy >= 0.12 && occupancy <= 0.58
      && centerDensity >= 0.18
      && quadrants === 4;
    const denseCross = circledAsterisk && occupancy >= 0.48 && centerDensity >= 0.72;
    return Object.freeze({
      symbol: denseCross ? "CROSS" : circledAsterisk ? "*" : "",
      confidence: circledAsterisk ? 0.997 : 0,
      reason: denseCross ? "DENSE_CROSS_GEOMETRY" : circledAsterisk ? "CIRCLED_ASTERISK_GEOMETRY" : "UNSUPPORTED_SYMBOL_GEOMETRY",
      aspect,
      occupancy,
      centerDensity,
      quadrants,
    });
  }

  function classifySingleStrokeGlyph(input = {}){
    const width = Math.floor(Number(input.width));
    const height = Math.floor(Number(input.height));
    const image = input.image;
    if(!(width > 8) || !(height > 8) || !image || image.length < width * height){
      throw new Error("invalid_single_stroke_frame");
    }
    const rowInk = Array.from({length: height}, () => 0);
    const columnInk = Array.from({length: width}, () => 0);
    for(let y = 2; y < height - 2; y += 1) for(let x = 2; x < width - 2; x += 1){
      if(Number(image[(y * width) + x]) < 128){ rowInk[y] += 1; columnInk[x] += 1; }
    }
    const points = [];
    for(let y = 2; y < height - 2; y += 1){
      for(let x = 2; x < width - 2; x += 1){
        if(Number(image[(y * width) + x]) < 128 && rowInk[y] < width * 0.55 && columnInk[x] < height * 0.82) points.push({x, y});
      }
    }
    if(points.length < 7) return Object.freeze({value: "", confidence: 0, reason: "NO_GLYPH_INK"});
    const pointMask = new Uint8Array(width * height);
    for(const point of points) pointMask[(point.y * width) + point.x] = 1;
    const visited = new Uint8Array(width * height);
    const components = [];
    for(const point of points){
      const start = (point.y * width) + point.x;
      if(visited[start]) continue;
      const queue = [start];
      visited[start] = 1;
      let cursor = 0;
      let minX = width; let minY = height; let maxX = 0; let maxY = 0;
      while(cursor < queue.length){
        const index = queue[cursor++];
        const x = index % width;
        const y = Math.floor(index / width);
        minX = Math.min(minX, x); minY = Math.min(minY, y);
        maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
        for(let dy = -1; dy <= 1; dy += 1) for(let dx = -1; dx <= 1; dx += 1){
          if(dx === 0 && dy === 0) continue;
          const nx = x + dx; const ny = y + dy;
          if(nx < 2 || nx >= width - 2 || ny < 2 || ny >= height - 2) continue;
          const next = (ny * width) + nx;
          if(pointMask[next] && !visited[next]){ visited[next] = 1; queue.push(next); }
        }
      }
      const boxWidth = maxX - minX + 1;
      const boxHeight = maxY - minY + 1;
      if(queue.length >= 6) components.push({
        size: queue.length,
        boxWidth,
        boxHeight,
        aspect: boxWidth / Math.max(1, boxHeight),
        occupancy: queue.length / Math.max(1, boxWidth * boxHeight),
      });
    }
    const glyphSized = components.filter(component => component.boxHeight >= height * 0.22 && component.aspect <= 2.4);
    const vertical = glyphSized.filter(component => component.aspect <= 0.66 && component.boxHeight >= height * 0.32)
      .sort((left, right) => right.boxHeight - left.boxHeight || right.size - left.size);
    const focus = vertical[0] || null;
    const competingGlyph = focus && glyphSized.some(component => component !== focus
      && component.boxHeight >= focus.boxHeight * 0.58
      && component.size >= focus.size * 0.35);
    const minX = Math.min(...points.map(point => point.x));
    const maxX = Math.max(...points.map(point => point.x));
    const minY = Math.min(...points.map(point => point.y));
    const maxY = Math.max(...points.map(point => point.y));
    const boxWidth = maxX - minX + 1;
    const boxHeight = maxY - minY + 1;
    const aspect = boxWidth / Math.max(1, boxHeight);
    const heightRatio = boxHeight / height;
    const occupiedRows = new Set(points.map(point => point.y)).size / boxHeight;
    const occupancy = points.length / Math.max(1, boxWidth * boxHeight);
    const wholeCropOne = aspect <= 0.58 && heightRatio >= 0.32 && occupiedRows >= 0.72;
    const focusedOne = Boolean(focus && !competingGlyph && focus.occupancy >= 0.055);
    const one = wholeCropOne || focusedOne;
    return Object.freeze({
      value: one ? "1" : "",
      confidence: one ? 0.997 : 0,
      reason: one ? "SINGLE_VERTICAL_STROKE_GEOMETRY" : "UNSUPPORTED_SINGLE_GLYPH_GEOMETRY",
      aspect,
      heightRatio,
      occupiedRows,
      occupancy,
    });
  }

  function isGibberishCandidate(value, columnId){
    const text = String(value || "").normalize("NFKC").trim();
    if(!text) return false;
    if(columnId !== "notes" && columnId !== "info" && columnId !== "signature" && columnId !== "ds") return false;
    const letters = (text.match(/[A-Za-zÆØÅæøå]/g) || []).join("");
    if(letters.length < 8) return false;
    const vowels = (letters.match(/[AEIOUYÆØÅaeiouyæøå]/g) || []).length;
    const mixedCaseJumps = [...letters].slice(1).filter((character, index) => {
      const previous = letters[index];
      return /[a-zæøå]/.test(previous) !== /[a-zæøå]/.test(character);
    }).length;
    const noWordBoundary = !/[\s.,:;!?/-]/.test(text);
    return (noWordBoundary && vowels / letters.length < 0.18)
      || (noWordBoundary && mixedCaseJumps >= Math.max(3, Math.floor(letters.length / 4)));
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

  function normalizeTrain(value, trainCatalog = []){
    const upper = String(value || "").normalize("NFKC").trim().toUpperCase().replace(/\s+/g, "");
    if(upper === "REP") return upper;
    const normalized = upper.replace(/[OQ]/g, "0").replace(/[IL|]/g, "1").replace(/\)/g, "2");
    const occurrenceMatch = normalized.match(/^([1-9]\d{2})([12])$/);
    if(occurrenceMatch){
      const catalog = new Set((Array.isArray(trainCatalog) ? trainCatalog : []).map(item => String(item || "").trim()));
      const base = occurrenceMatch[1];
      const catalogConfirmsOccurrence = catalog.has(base)
        || catalog.has(`${base}¹`) || catalog.has(`${base}²`)
        || catalog.has(`${base}/1`) || catalog.has(`${base}/2`);
      if(catalogConfirmsOccurrence && !catalog.has(normalized)){
        return `${occurrenceMatch[1]}${occurrenceMatch[2] === "1" ? "¹" : "²"}`;
      }
    }
    return /^[1-9]\d{2,3}(?:[¹²]|\/[12])?$/.test(normalized) ? normalized : "";
  }

  function editDistance(leftValue, rightValue){
    const left = String(leftValue || "");
    const right = String(rightValue || "");
    const previous = Array.from({length: right.length + 1}, (_unused, index) => index);
    for(let row = 1; row <= left.length; row += 1){
      const current = [row];
      for(let column = 1; column <= right.length; column += 1){
        current[column] = Math.min(
          current[column - 1] + 1,
          previous[column] + 1,
          previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1),
        );
      }
      previous.splice(0, previous.length, ...current);
    }
    return previous[right.length];
  }

  function uniqueNearestCatalogValue(value, catalog, maximumDistance){
    const source = String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if(!source) return "";
    const ranked = unique((Array.isArray(catalog) ? catalog : []).map(item => String(item || "").normalize("NFKC").trim()))
      .map(item => ({item, distance: editDistance(source, item.toUpperCase().replace(/[^A-Z0-9]/g, ""))}))
      .sort((left, right) => left.distance - right.distance || left.item.localeCompare(right.item));
    if(!ranked.length || ranked[0].distance > maximumDistance) return "";
    if(ranked[1] && ranked[1].distance === ranked[0].distance) return "";
    return ranked[0].item;
  }

  function canonicalizeSlotCandidate(value, canonicalSlots){
    const canonicalCandidate = canonicalizeSlot(value);
    let normalized = canonicalCandidate
      .replace(/\|+$/g, "")
      .replace(/^B(?=[NS])/, "6")
      .replace(/^E(?=[NS])/, "6")
      .replace(/^L(?=\d)/, "1")
      .replace(/^I(?=\d)/, "1")
      .replace(/O/g, "0")
      .replace(/^S(?=[NS])/, "5");
    const directionalRouteArtifact = canonicalCandidate.match(/^(\d{1,2})([NS])(?:-D|-0|\+|>)(1[0-2])$/);
    if(directionalRouteArtifact){
      normalized = `${directionalRouteArtifact[1]}${directionalRouteArtifact[2]}→${directionalRouteArtifact[3]}${directionalRouteArtifact[2]}`;
    }
    if(canonicalCandidate === "/" || canonicalCandidate === "|" || canonicalCandidate === "I" || canonicalCandidate === "L") normalized = "1";
    const suffixFive = normalized.match(/^(\d{1,2})5$/);
    if(suffixFive && canonicalSlots.has(`${suffixFive[1]}S`)) normalized = `${suffixFive[1]}S`;
    normalized = normalized.replace(/^(\d{1,2})([NS])(?:→|-|>|\s)+(\d{1,2})$/, (_match, source, direction, target) => `${source}${direction}→${target}${direction}`);
    normalized = normalized.replace(/^(\d)([NS])$/, "$1$2");
    const components = normalized.split("→");
    const target = components.at(-1);
    if(canonicalSlots.has(normalized) || (components.length > 1 && canonicalSlots.has(target))) return normalized;
    if(!normalized.includes("→")){
      const nearest = uniqueNearestCatalogValue(normalized, [...canonicalSlots], 1);
      if(nearest) return nearest;
    }
    return normalized;
  }

  function wcSymbol(value){
    const compact = String(value || "").trim();
    if(/^CROSS$/i.test(compact)) return "CROSS";
    if(/^CHECK$/i.test(compact)) return "CHECK";
    if(/^CIRCLE$/i.test(compact)) return "CIRCLE";
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
    const evidenceRecords = [];
    const recordEvidence = (value, candidate, catalogDerived = false) => {
      if(!value) return;
      evidenceRecords.push(Object.freeze({
        value,
        confidence: candidate.confidence,
        votes: candidate.votes,
        sourceText: candidate.text,
        sourceLayer: candidate.sourceLayer,
        catalogDerived,
      }));
    };
    let proposedValue = "";
    let validationState = "UNREADABLE";
    let confidence = candidates[0]?.confidence || 0;
    if(normalizer === "VEHICLE_ID"){
      const vehicleCatalog = Array.isArray(context.vehicleCatalog) ? context.vehicleCatalog : [];
      for(const candidate of candidates){
        const imageNormalized = canonicalizeVehicle(candidate.text);
        let normalized = imageNormalized;
        let catalogDerived = false;
        if(vehicleCatalog.length && normalized && !vehicleCatalog.includes(normalized)){
          const nearest = uniqueNearestCatalogValue(normalized, vehicleCatalog, 1);
          normalized = canonicalizeVehicle(nearest);
          catalogDerived = Boolean(normalized && normalized !== imageNormalized);
        }
        if(normalized){
          sourceAlternatives.push(normalized);
          recordEvidence(normalized, candidate, catalogDerived);
          if(!proposedValue){ proposedValue = normalized; confidence = candidate.confidence; }
        }
      }
      validationState = proposedValue ? (vehicleCatalog.length && !vehicleCatalog.includes(proposedValue) ? "REVIEW_REQUIRED" : "VALID") : "UNSUPPORTED";
    }else if(normalizer === "CANONICAL_SLOT"){
      const canonicalSlots = new Set(Array.isArray(context.canonicalSlots) ? context.canonicalSlots.map(canonicalizeSlot) : []);
      for(const candidate of candidates){
        const imageNormalizedBeforeCatalog = canonicalizeSlot(candidate.text);
        const normalized = canonicalizeSlotCandidate(candidate.text, canonicalSlots);
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
          const raw = String(candidate.text || "").normalize("NFKC").toUpperCase().replace(/\s+/g, "");
          const incompleteRoute = /[→>+]/.test(raw) && !accepted.includes("→");
          const weakSingleStrokeAlias = accepted === "1" && /^[\/|IL]$/.test(raw) && candidate.confidence < 0.99;
          const catalogOnlyOne = accepted === "1" && raw !== "1";
          const catalogNearestOnly = Boolean(
            imageNormalizedBeforeCatalog
            && imageNormalizedBeforeCatalog !== accepted
            && !accepted.includes("→")
            && canonicalSlots.has(accepted)
            && !/[IL|]/.test(raw)
          );
          recordEvidence(accepted, candidate, incompleteRoute || weakSingleStrokeAlias || catalogOnlyOne || catalogNearestOnly);
          if(!proposedValue){ proposedValue = accepted; confidence = candidate.confidence; }
        }
      }
      validationState = proposedValue ? "VALID" : "UNSUPPORTED";
    }else if(normalizer === "WC_WATER_SYMBOL"){
      for(const candidate of candidates){
        const normalized = wcSymbol(candidate.text);
        if(normalized){
          sourceAlternatives.push(normalized);
          recordEvidence(normalized, candidate, false);
          if(!proposedValue){ proposedValue = normalized; confidence = candidate.confidence; }
        }
      }
      validationState = proposedValue ? "VALID" : "UNREADABLE";
    }else if(normalizer === "TRAIN_IDENTIFIER"){
      const trainCatalog = Array.isArray(context.trainCatalog) ? context.trainCatalog : [];
      for(const candidate of candidates){
        const imageNormalized = normalizeTrain(candidate.text, trainCatalog);
        let normalized = imageNormalized;
        let catalogDerived = false;
        const recognizedInCatalog = normalized === "REP" || (normalized && trainCatalog.some(value => {
          const catalogValue = String(value || "");
          const occurrenceBase = catalogValue.replace(/[¹²]$/, "").replace(/\/[12]$/, "");
          return catalogValue === normalized || `${catalogValue}¹` === normalized || `${catalogValue}²` === normalized
            || occurrenceBase === normalized;
        }));
        if(trainCatalog.length && !recognizedInCatalog){
          const compact = String(candidate.text || "").toUpperCase()
            .replace(/[OQ]/g, "0").replace(/[IL|]/g, "1").replace(/Z/g, "2").replace(/S/g, "5").replace(/G/g, "6")
            .replace(/[^A-Z0-9]/g, "");
          const nearest = uniqueNearestCatalogValue(compact, trainCatalog, compact.length <= 2 ? 2 : 1);
          normalized = normalizeTrain(nearest, trainCatalog);
          catalogDerived = Boolean(normalized && normalized !== imageNormalized);
        }
        if(normalized){
          sourceAlternatives.push(normalized);
          recordEvidence(normalized, candidate, catalogDerived);
          if(!proposedValue){ proposedValue = normalized; confidence = candidate.confidence; }
        }
      }
      const inTrainCatalog = proposedValue === "REP" || !trainCatalog.length || trainCatalog.some(value => {
        const catalogValue = String(value || "");
        const occurrenceBase = catalogValue.replace(/[¹²]$/, "").replace(/\/[12]$/, "");
        return catalogValue === proposedValue || `${catalogValue}¹` === proposedValue || `${catalogValue}²` === proposedValue
          || occurrenceBase === proposedValue;
      });
      const occurrencePairRequiresDocumentContext = /^\d{3}$/.test(proposedValue)
        && trainCatalog.some(value => [`${proposedValue}¹`, `${proposedValue}²`, `${proposedValue}/1`, `${proposedValue}/2`].includes(String(value || "")));
      validationState = proposedValue
        ? (inTrainCatalog && !occurrencePairRequiresDocumentContext ? "VALID" : "REVIEW_REQUIRED")
        : "UNREADABLE";
    }else if(normalizer === "DATE"){
      for(const candidate of candidates){
        const normalized = normalizeDate(candidate.text);
        if(normalized){
          sourceAlternatives.push(normalized);
          recordEvidence(normalized, candidate, false);
          if(!proposedValue){ proposedValue = normalized; confidence = candidate.confidence; }
        }
      }
      validationState = proposedValue ? "VALID" : "UNREADABLE";
    }else if(normalizer === "TIME"){
      for(const candidate of candidates){
        const normalized = normalizeTime(candidate.text);
        if(normalized){
          sourceAlternatives.push(normalized);
          recordEvidence(normalized, candidate, false);
          if(!proposedValue){ proposedValue = normalized; confidence = candidate.confidence; }
        }
      }
      validationState = proposedValue ? "VALID" : "UNREADABLE";
    }else{
      for(const candidate of candidates){
        sourceAlternatives.push(candidate.text);
        recordEvidence(candidate.text, candidate, false);
        if(!proposedValue){ proposedValue = candidate.text; confidence = candidate.confidence; }
      }
      validationState = proposedValue ? "VALID" : "UNREADABLE";
    }
    const alternatives = unique(sourceAlternatives);
    const evidenceGroups = [...new Set(evidenceRecords.map(record => record.value))].map(value => {
      const records = evidenceRecords.filter(record => record.value === value);
      const direct = records.filter(record => !record.catalogDerived);
      return Object.freeze({
        value,
        directVoteSupport: direct.reduce((sum, record) => sum + Math.max(1, record.votes), 0),
        directCandidateCount: direct.length,
        directConfidence: direct.reduce((maximum, record) => Math.max(maximum, record.confidence), 0),
        directSourceLayers: Object.freeze([...new Set(direct.map(record => record.sourceLayer).filter(Boolean))]),
        catalogDerivedOnly: direct.length === 0,
      });
    });
    let proposalEvidence = evidenceGroups.find(group => group.value === proposedValue) || Object.freeze({
      directVoteSupport: 0,
      directCandidateCount: 0,
      directConfidence: 0,
      catalogDerivedOnly: true,
    });
    if(proposalEvidence.catalogDerivedOnly){
      const strongestDirect = evidenceGroups.filter(group => !group.catalogDerivedOnly)
        .sort((left, right) => right.directVoteSupport - left.directVoteSupport
          || right.directConfidence - left.directConfidence)[0];
      if(strongestDirect){
        proposedValue = strongestDirect.value;
        confidence = strongestDirect.directConfidence;
        proposalEvidence = strongestDirect;
      }
    }
    if(proposedValue && proposalEvidence.catalogDerivedOnly && validationState === "VALID"){
      validationState = "REVIEW_REQUIRED";
    }
    // Handwritten identifiers can look plausible while one glyph is wrong or a
    // small superscript is missing. Keep the proposed value visible, but accept
    // it without review only at a precision-oriented confidence level.
    const reviewThresholds = Object.freeze({
      FREE_TEXT: 0.9995,
      VEHICLE_ID: 0.40,
      CANONICAL_SLOT: 0.35,
      WC_WATER_SYMBOL: 0.92,
      TRAIN_IDENTIFIER: 0.40,
      DATE: 0.95,
      TIME: 0.95,
    });
    const threshold = reviewThresholds[normalizer] ?? 0.995;
    const materialCompetition = evidenceGroups.some(group => group.value !== proposedValue
      && !group.catalogDerivedOnly
      && group.directVoteSupport >= proposalEvidence.directVoteSupport
      && Math.abs(group.directConfidence - proposalEvidence.directConfidence) < 0.08);
    const consensusVotes = proposalEvidence.directVoteSupport;
    const structuredNormalizer = ["VEHICLE_ID", "CANONICAL_SLOT", "WC_WATER_SYMBOL", "TRAIN_IDENTIFIER"].includes(normalizer);
    const dominantStructuredSegment = normalizer === "CANONICAL_SLOT"
      && proposalEvidence.directCandidateCount === 1
      && proposalEvidence.directSourceLayers?.length === 1
      && proposalEvidence.directSourceLayers[0] === "STRUCTURED_SEGMENT_OCR"
      && proposalEvidence.directConfidence >= 0.94
      && !materialCompetition;
    const imageEvidenceStrong = !structuredNormalizer || (
      !proposalEvidence.catalogDerivedOnly
      && proposalEvidence.directCandidateCount > 0
      && (proposalEvidence.directVoteSupport >= 2 || dominantStructuredSegment)
    );
    const gibberish = isGibberishCandidate(proposedValue, columnId);
    const rejected = !proposedValue || gibberish || validationState === "UNSUPPORTED" || validationState === "UNREADABLE";
    const needsReview = rejected || confidence < threshold || validationState !== "VALID" || materialCompetition || !imageEvidenceStrong;
    const normalizationReason = !proposedValue
      ? "NO_VALID_IMAGE_BASED_CANDIDATE"
      : gibberish
        ? "GIBBERISH_CANDIDATE_REJECTED"
      : validationState !== "VALID"
        ? "FIELD_VALIDATION_REQUIRES_REVIEW"
        : materialCompetition
          ? "COMPETING_IMAGE_CANDIDATES"
          : !imageEvidenceStrong
            ? "IMAGE_EVIDENCE_REQUIRES_REVIEW"
          : confidence < threshold
            ? "CONFIDENCE_REQUIRES_REVIEW"
            : "IMAGE_CANDIDATE_PASSED_FIELD_VALIDATION";
    if(!proposedValue) confidence = Math.min(confidence, 0.49);
    const disposition = rejected ? "REJECTED" : needsReview ? "REVIEW_SUGGESTION" : "AUTO_ACCEPTED";
    const selectedValue = disposition === "AUTO_ACCEPTED" ? proposedValue : "";
    const suggestedValue = disposition === "REVIEW_SUGGESTION" ? proposedValue : "";
    return Object.freeze({
      selectedValue,
      suggestedValue,
      normalizedValue: proposedValue,
      confidence,
      alternatives: Object.freeze(alternatives),
      needsReview,
      validationState,
      normalizer,
      normalizationReason,
      disposition,
      consensusVotes,
    });
  }

  function buildMappingReport(input = {}){
    const cells = Array.isArray(input.cells) ? input.cells : [];
    const metadataCells = Array.isArray(input.metadataCells) ? input.metadataCells : [];
    const template = templateFor(input.templateId || "TEMPLATE_A");
    const expectedCellCount = template ? 29 * template.columns.length : 0;
    const expectedMetadata = template ? template.metadata.map(item => item.columnId) : [];
    const mappedCellCount = cells.filter(cell => String(cell?.selectedValue || "").trim()).length;
    const suggestedCellCount = cells.filter(cell => String(cell?.suggestedValue || "").trim()).length;
    const recognizedCellCount = cells.filter(cell => String(cell?.selectedValue || cell?.suggestedValue || "").trim()).length;
    const allRecognizedCells = [...metadataCells, ...cells];
    const reviewedCellCount = allRecognizedCells.filter(cell => cell?.needsReview === true).length;
    let mappingStatus;
    if(input.htrCompleted !== true) mappingStatus = "RECOGNITION_FAILED";
    else if(!template || input.registrationStatus !== "CELL_SEGMENTATION_COMPLETE" || cells.length !== expectedCellCount
      || metadataCells.length !== expectedMetadata.length
      || metadataCells.some(cell => !expectedMetadata.includes(String(cell?.columnId || "")))) mappingStatus = "MAPPING_FAILED";
    else if(recognizedCellCount <= 1) mappingStatus = "MAPPING_FAILED";
    else if(reviewedCellCount > 0) mappingStatus = "FORM_MAPPING_REQUIRES_REVIEW";
    else mappingStatus = "FORM_MAPPING_COMPLETE";
    const confidenceValues = allRecognizedCells.map(cell => Number(cell?.confidence)).filter(Number.isFinite);
    return Object.freeze({
      schemaVersion: "sde-night-form-mapping-report-v4",
      mappingStatus,
      htrCompleted: input.htrCompleted === true,
      registrationStatus: String(input.registrationStatus || ""),
      templateId: template?.id || "TEMPLATE_UNKNOWN",
      templateVersion: template?.version || "unknown",
      columnCount: template?.columns.length || 0,
      recognitionMode: "LOCAL_REAL_HTR_ENSEMBLE",
      recognizerVersion: MODEL_SPEC.version,
      modelSha256: MODEL_SPEC.modelSha256,
      cellCount: cells.length,
      mappedCellCount,
      suggestedCellCount,
      recognizedCellCount,
      reviewedCellCount,
      requiresHumanReview: reviewedCellCount > 0 || mappingStatus !== "FORM_MAPPING_COMPLETE",
      mappingConfidence: confidenceValues.length ? confidenceValues.reduce((sum, value) => sum + value, 0) / confidenceValues.length : 0,
      cells: Object.freeze(cells.map(cell => Object.freeze({...cell}))),
      metadataCells: Object.freeze(metadataCells.map(cell => Object.freeze({...cell}))),
    });
  }

  function applyHumanCorrection(cell, finalValue, explicitDisposition){
    const selectedValue = String(finalValue == null ? "" : finalValue).normalize("NFKC").trim();
    const suggestedValue = String(cell?.suggestedValue || "");
    const recognizerSelectedValue = String(cell?.selectedValue || "");
    const recognizerSuggestedValue = suggestedValue;
    const recognizerProposal = recognizerSelectedValue || recognizerSuggestedValue;
    const recognizerDisposition = String(cell?.disposition || (recognizerSelectedValue ? "AUTO_ACCEPTED" : recognizerSuggestedValue ? "REVIEW_SUGGESTION" : "REJECTED"));
    const humanDisposition = explicitDisposition || (selectedValue
      ? selectedValue === suggestedValue ? "ACCEPT_SUGGESTION" : "EDIT_VALUE"
      : "LEAVE_BLANK");
    if(!["ACCEPT_SUGGESTION", "EDIT_VALUE", "LEAVE_BLANK"].includes(humanDisposition)){
      throw new Error("invalid_human_recognition_disposition");
    }
    return Object.freeze({
      ...cell,
      selectedValue,
      normalizedValue: selectedValue,
      humanFinalValue: selectedValue,
      humanDisposition,
      recognizerDisposition,
      recognizerSelectedValue,
      recognizerSuggestedValue,
      learningOutcome: recognizerDisposition === "AUTO_ACCEPTED" && selectedValue === recognizerSelectedValue
        ? "AUTO_ACCEPTED_UNCHANGED"
        : !selectedValue
          ? "REJECTED"
          : !recognizerProposal
            ? "ENTERED_FROM_EMPTY"
            : "CORRECTED",
      disposition: "HUMAN_CONFIRMED",
      needsReview: false,
      groundTruthSource: "HUMAN_CORRECTED_FORM",
      rawRecognizerIsGroundTruth: false,
      normalizationReason: "HUMAN_CORRECTED_FORM",
    });
  }

  function computeCorrectionBurden(cells){
    const reviewed = Array.isArray(cells) ? cells.filter(cell => [
      "ACCEPT_SUGGESTION", "EDIT_VALUE", "LEAVE_BLANK",
    ].includes(cell?.humanDisposition)) : [];
    const acceptedSuggestionCount = reviewed.filter(cell => cell.humanDisposition === "ACCEPT_SUGGESTION").length;
    const editedCellCount = reviewed.filter(cell => cell.humanDisposition === "EDIT_VALUE").length;
    const leftBlankCount = reviewed.filter(cell => cell.humanDisposition === "LEAVE_BLANK").length;
    const nonEmptyGroundTruthCells = reviewed.filter(cell => String(cell.humanFinalValue || cell.selectedValue || "").trim()).length;
    const proposalFor = cell => String(cell.recognizerSelectedValue || cell.recognizerSuggestedValue || "").trim();
    const finalFor = cell => String(cell.humanFinalValue || cell.selectedValue || "").trim();
    const autoAccepted = reviewed.filter(cell => cell.recognizerDisposition === "AUTO_ACCEPTED");
    const autoAcceptedCorrect = autoAccepted.filter(cell => proposalFor(cell) === finalFor(cell)).length;
    const autoAcceptedIncorrect = autoAccepted.length - autoAcceptedCorrect;
    const reviewSuggestions = reviewed.filter(cell => cell.recognizerDisposition === "REVIEW_SUGGESTION").length;
    const emptyRejected = reviewed.filter(cell => !finalFor(cell) && !proposalFor(cell)).length;
    const manuallyChangedCells = reviewed.filter(cell => finalFor(cell) && finalFor(cell) !== proposalFor(cell)).length;
    const fieldsEnteredFromScratch = reviewed.filter(cell => finalFor(cell) && !proposalFor(cell)).length;
    const characterEditsRequired = reviewed.reduce((sum, cell) => sum + editDistance(proposalFor(cell), finalFor(cell)), 0);
    return Object.freeze({
      reviewedCellCount: reviewed.length,
      acceptedSuggestionCount,
      editedCellCount,
      leftBlankCount,
      nonEmptyGroundTruthCells,
      autoAcceptedCorrect,
      autoAcceptedIncorrect,
      reviewSuggestions,
      emptyRejected,
      manuallyChangedCells,
      characterEditsRequired,
      fieldsEnteredFromScratch,
      manualCorrectionRate: nonEmptyGroundTruthCells ? manuallyChangedCells / nonEmptyGroundTruthCells : 0,
      manualCellEditsRequiredRate: nonEmptyGroundTruthCells ? manuallyChangedCells / nonEmptyGroundTruthCells : 0,
      characterEditDistancePerNonEmptyCell: nonEmptyGroundTruthCells ? characterEditsRequired / nonEmptyGroundTruthCells : 0,
    });
  }

  function evaluateModelCandidate(input = {}){
    const reasons = [];
    const candidateModelSha256 = String(input.candidateModelSha256 || "").toLowerCase();
    if(!/^[a-f0-9]{64}$/.test(candidateModelSha256)) reasons.push("INVALID_MODEL_HASH");
    const training = new Set(Array.isArray(input.trainingDocumentIds) ? input.trainingDocumentIds.map(String) : []);
    const holdout = new Set(Array.isArray(input.holdoutDocumentIds) ? input.holdoutDocumentIds.map(String) : []);
    if(!training.size || !holdout.size) reasons.push("MISSING_DOCUMENT_SPLIT");
    if([...holdout].some(value => training.has(value))) reasons.push("HOLDOUT_LEAKAGE");
    if(Number(input.structuredPrecision) < 0.99) reasons.push("STRUCTURED_PRECISION_BELOW_GATE");
    if(Number(input.clearCellCoverage) < 0.85) reasons.push("CLEAR_CELL_COVERAGE_BELOW_GATE");
    if(Number(input.manualCorrectionRate) > 0.10) reasons.push("CORRECTION_RATE_ABOVE_GATE");
    return Object.freeze({
      candidateModelSha256,
      trainingDocumentIds: Object.freeze([...training]),
      holdoutDocumentIds: Object.freeze([...holdout]),
      structuredPrecision: Number(input.structuredPrecision),
      clearCellCoverage: Number(input.clearCellCoverage),
      manualCorrectionRate: Number(input.manualCorrectionRate),
      promotable: reasons.length === 0,
      reasons: Object.freeze(reasons),
    });
  }

  function promoteModelCandidate(registry = {}, evaluation = {}, approval = {}){
    if(evaluation.promotable !== true || approval.humanApproved !== true){
      throw new Error("model_candidate_not_approved_for_promotion");
    }
    const previous = String(registry.activeModelSha256 || "");
    const candidate = String(evaluation.candidateModelSha256 || "");
    return Object.freeze({
      activeModelSha256: candidate,
      rollbackModelSha256: previous,
      history: Object.freeze([...(Array.isArray(registry.history) ? registry.history : []), Object.freeze({
        from: previous,
        to: candidate,
        gate: "GREEN",
        humanApproved: true,
      })]),
    });
  }

  function rollbackModel(registry = {}){
    const rollbackModelSha256 = String(registry.rollbackModelSha256 || "");
    if(!/^[a-f0-9]{64}$/.test(rollbackModelSha256)) throw new Error("rollback_model_unavailable");
    return Object.freeze({
      ...registry,
      activeModelSha256: rollbackModelSha256,
      rollbackModelSha256: String(registry.activeModelSha256 || ""),
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
    PRINT_MODEL_SPEC,
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
    classifyBlankCell,
    classifySingleStrokeGlyph,
    classifyWcWaterSymbol,
    computeCorrectionBurden,
    createPerspectiveTransform,
    createRecognitionRequests,
    createRecognitionSession,
    detectStrikeThrough,
    detectFormRegistration,
    detectTemplateVariant,
    evaluateModelCandidate,
    formRegistrationFailureMessage,
    isGibberishCandidate,
    normalizeRecognition,
    projectPoint,
    reconcileLayerCandidates,
    recordRecognition,
    registerTemplate,
    replaceRecognitionImage,
    resolveSourceMetadata,
    separateInkLayers,
    promoteModelCandidate,
    rollbackModel,
    supportsLocalRuntime,
    toCanonicalRow,
    verifyModelBytes,
  });
});
