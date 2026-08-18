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
    "TEMPLATE_REGISTRATION",
    "CELL_SEGMENTATION",
    "HANDWRITING_RECOGNITION",
    "FIELD_NORMALIZATION",
    "FORM_MAPPING",
  ]);
  const COLUMN_IDS = Object.freeze(["fromTrain", "toTrain", "vehicleId", "toTrack", "wcWater", "notes"]);
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
  const TEMPLATE = Object.freeze({
    width: 1200,
    height: 1500,
    dataTop: 285,
    dataBottom: 1465,
    columnBoundaries: Object.freeze([26, 168, 329, 484, 636, 770, 1174]),
    metadata: Object.freeze([
      Object.freeze({columnId: "date", canonicalBox: Object.freeze({x0: 155, y0: 55, x1: 390, y1: 130})}),
      Object.freeze({columnId: "signature", canonicalBox: Object.freeze({x0: 535, y0: 55, x1: 770, y1: 130})}),
      Object.freeze({columnId: "ds", canonicalBox: Object.freeze({x0: 925, y0: 55, x1: 1174, y1: 130})}),
    ]),
  });

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

  function selectFormGrid(lines, width){
    const ratios = TEMPLATE.columnBoundaries.map(value => (
      (value - TEMPLATE.columnBoundaries[0])
      / (TEMPLATE.columnBoundaries.at(-1) - TEMPLATE.columnBoundaries[0])
    ));
    const leftCandidates = lines.candidates.filter(candidate => candidate.xAtReference < width * 0.2);
    const rightCandidates = lines.candidates.filter(candidate => candidate.xAtReference > width * 0.76);
    let best = null;
    for(const left of leftCandidates){
      for(const right of rightCandidates){
        const span = right.xAtReference - left.xAtReference;
        if(span < width * 0.68) continue;
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
        const score = lineScore - (deviation * 8);
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

  function horizontalLineScore(pixels, width, height, yAtReference, slope, referenceX){
    let score = 0;
    let samples = 0;
    const xStart = Math.floor(width * 0.01);
    const xEnd = Math.ceil(width * 0.99);
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
    const start = edge === "top" ? 0 : Math.floor(height * 0.84);
    const end = edge === "top" ? Math.ceil(height * 0.16) : height - 1;
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

  function horizontalGridCandidates(pixels, width, height){
    const referenceX = width * 0.5;
    const values = [];
    for(let y = Math.floor(height * 0.14); y <= Math.ceil(height * 0.995); y += 2){
      let best = null;
      for(let slopeStep = -12; slopeStep <= 12; slopeStep += 1){
        const slope = slopeStep / 200;
        const value = horizontalLineScore(pixels, width, height, y, slope, referenceX);
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

  function selectHorizontalGrid(candidates, perspective, width, height){
    const topCandidates = candidates.filter(candidate => candidate.coverage >= 0.45 && candidate.yAtReference >= height * 0.14 && candidate.yAtReference <= height * 0.28);
    const bottomCandidates = candidates.filter(candidate => candidate.coverage >= 0.45 && candidate.yAtReference >= height * 0.9 && candidate.yAtReference <= height * 0.995);
    const canonicalX = TEMPLATE.width * 0.5;
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
            evidenceScore += choice.coverage;
          }
        }
        if(matched.length < 26) continue;
        const score = (matched.length * 100) + evidenceScore;
        const earlierTop = !best || top.yAtReference < best.topImageY - 3;
        const sameTopBetterEvidence = best && Math.abs(top.yAtReference - best.topImageY) <= 3 && score > best.score;
        if(earlierTop || sameTopBetterEvidence){
          best = {score, topImageY: top.yAtReference, topCanonicalY: topCanonical.y, bottomCanonicalY: bottomCanonical.y, matched};
        }
      }
    }
    if(!best) return null;
    return Object.freeze({
      canonicalRowBoundaries: Object.freeze(Array.from({length: 30}, (_unused, row) => (
        best.topCanonicalY + ((best.bottomCanonicalY - best.topCanonicalY) * row / 29)
      ))),
      horizontalLineCount: best.matched.length,
      averageCoverage: best.matched.reduce((sum, line) => sum + line.coverage, 0) / best.matched.length,
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
    const grid = selectFormGrid(lines, width);
    if(grid && grid.selected.length === TEMPLATE.columnBoundaries.length){
      const left = grid.selected[0];
      const right = grid.selected.at(-1);
      const leftExtent = verticalLineExtent(pixels, width, height, left, lines.referenceY);
      const rightExtent = verticalLineExtent(pixels, width, height, right, lines.referenceY);
      const topBoundary = bestHorizontalBoundary(pixels, width, height, "top");
      const bottomBoundary = bestHorizontalBoundary(pixels, width, height, "bottom");
      if(leftExtent && rightExtent
        && leftExtent.length > height * 0.76
        && rightExtent.length > height * 0.76
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
        const perspective = createPerspectiveTransform(corners, fullImageQuadrilateral(TEMPLATE.width, TEMPLATE.height));
        const horizontalGrid = selectHorizontalGrid(horizontalGridCandidates(pixels, width, height), perspective, width, height);
        if(horizontalGrid) return Object.freeze({
          corners,
          confidence: clamp((averageLineCoverage * 0.55) + (sequenceFit * 0.25) + (horizontalCoverage * 0.2), 0, 1),
          source: "FORM_GRID_RULE_SEQUENCE",
          verticalLineCount: grid.selected.length,
          horizontalBoundaryCount: 2,
          horizontalLineCount: horizontalGrid.horizontalLineCount,
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
    return Object.freeze({
      corners: Object.freeze([
        Object.freeze({x: insetX, y: insetY}),
        Object.freeze({x: width - insetX, y: insetY}),
        Object.freeze({x: width - insetX, y: height - insetY}),
        Object.freeze({x: insetX, y: height - insetY}),
      ]),
      confidence: 0.25,
      source: "FORM_GRID_REGISTRATION_FAILED",
      verticalLineCount: 0,
      verticalLines: Object.freeze([]),
      diagnostics: Object.freeze({candidateCount: lines.candidates.length, sequenceFound: Boolean(grid), candidates: Object.freeze(lines.candidates)}),
    });
  }

  function registerTemplate(input = {}){
    const imageWidth = Number(input.imageWidth);
    const imageHeight = Number(input.imageHeight);
    if(!(imageWidth > 0) || !(imageHeight > 0)) throw new Error("invalid_form_image_dimensions");
    const original = (input.quadrilateral || fullImageQuadrilateral(imageWidth, imageHeight)).map((point, index) => finitePoint(point, `corner_${index}`));
    const canonical = fullImageQuadrilateral(TEMPLATE.width, TEMPLATE.height);
    const perspective = createPerspectiveTransform(original, canonical);
    const suppliedRows = Array.isArray(input.rowBoundaries) ? input.rowBoundaries.map(Number) : [];
    const rowBoundaries = suppliedRows.length === 30
      && suppliedRows.every(Number.isFinite)
      && suppliedRows.every((value, index) => index === 0 || value > suppliedRows[index - 1])
      ? suppliedRows
      : Array.from({length: 30}, (_unused, index) => TEMPLATE.dataTop + (((TEMPLATE.dataBottom - TEMPLATE.dataTop) / 29) * index));
    const cells = [];
    for(let rowIndex = 0; rowIndex < 29; rowIndex += 1){
      for(let columnIndex = 0; columnIndex < COLUMN_IDS.length; columnIndex += 1){
        const canonicalBox = Object.freeze({
          x0: TEMPLATE.columnBoundaries[columnIndex],
          y0: rowBoundaries[rowIndex],
          x1: TEMPLATE.columnBoundaries[columnIndex + 1],
          y1: rowBoundaries[rowIndex + 1],
        });
        cells.push(Object.freeze({
          rowIndex,
          columnId: COLUMN_IDS[columnIndex],
          canonicalBox,
          boundingBox: projectBox(perspective.inverse, canonicalBox),
        }));
      }
    }
    const metadataCells = TEMPLATE.metadata.map(item => Object.freeze({
      rowIndex: null,
      columnId: item.columnId,
      canonicalBox: item.canonicalBox,
      boundingBox: projectBox(perspective.inverse, item.canonicalBox),
    }));
    return Object.freeze({
      status: "FORM_REGISTRATION_COMPLETE",
      templateVersion: "togplassering-skien-29x6-v1",
      canonicalWidth: TEMPLATE.width,
      canonicalHeight: TEMPLATE.height,
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
    if(columnId === "notes" || columnId === "signature" || columnId === "ds") return "FREE_TEXT";
    if(columnId === "date") return "DATE";
    return "TRAIN_IDENTIFIER";
  }

  function createRecognitionRequests(registration){
    if(!registration || registration.status !== "FORM_REGISTRATION_COMPLETE") throw new Error("form_registration_required");
    return Object.freeze([...registration.metadataCells, ...registration.cells].map(cell => Object.freeze({
      ...cell,
      recognizerKind: "HANDWRITING",
      normalizer: normalizerFor(cell.columnId),
      recognizerVersion: MODEL_SPEC.version,
    })));
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
    return String(value || "").normalize("NFKC").toUpperCase().replace(/\s+/g, "").replace(/(?:-|=)+>/g, "→");
  }

  function normalizeTrain(value){
    const upper = String(value || "").normalize("NFKC").trim().toUpperCase().replace(/\s+/g, "");
    if(upper === "REP") return upper;
    const normalized = upper.replace(/[OQ]/g, "0").replace(/[IL|]/g, "1").replace(/\)/g, "2");
    return /^[1-9]\d{2,3}[¹²]?$/.test(normalized) ? normalized : "";
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
    const digits = raw.replace(/\D/g, "");
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
      VEHICLE_ID: 0.98,
      CANONICAL_SLOT: 0.98,
      WC_WATER_SYMBOL: 0.98,
      TRAIN_IDENTIFIER: 0.995,
      DATE: 0.98,
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
    const mappedCellCount = cells.filter(cell => String(cell?.selectedValue || "").trim()).length;
    const allRecognizedCells = [...metadataCells, ...cells];
    const reviewedCellCount = allRecognizedCells.filter(cell => cell?.needsReview === true).length;
    let mappingStatus;
    if(input.htrCompleted !== true) mappingStatus = "RECOGNITION_FAILED";
    else if(input.registrationStatus !== "CELL_SEGMENTATION_COMPLETE" || cells.length !== 29 * 6 || metadataCells.length !== 3) mappingStatus = "MAPPING_FAILED";
    else if(mappedCellCount <= 1) mappingStatus = "MAPPING_FAILED";
    else if(reviewedCellCount > 0) mappingStatus = "FORM_MAPPING_REQUIRES_REVIEW";
    else mappingStatus = "FORM_MAPPING_COMPLETE";
    const confidenceValues = allRecognizedCells.map(cell => Number(cell?.confidence)).filter(Number.isFinite);
    return Object.freeze({
      schemaVersion: "sde-night-form-mapping-report-v2",
      mappingStatus,
      htrCompleted: input.htrCompleted === true,
      registrationStatus: String(input.registrationStatus || ""),
      templateVersion: "togplassering-skien-29x6-v1",
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

  function clamp(value, minimum, maximum){
    return Math.max(minimum, Math.min(maximum, value));
  }

  return Object.freeze({
    COLUMN_IDS,
    MODEL_SPEC,
    PIPELINE_STAGES,
    TEMPLATE,
    applyHumanCorrection,
    buildMappingReport,
    createPerspectiveTransform,
    createRecognitionRequests,
    createRecognitionSession,
    detectFormRegistration,
    normalizeRecognition,
    projectPoint,
    recordRecognition,
    registerTemplate,
    replaceRecognitionImage,
    supportsLocalRuntime,
    verifyModelBytes,
  });
});
