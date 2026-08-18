(function attachSdeHandwritingRuntime(root, factory){
  "use strict";
  const api = factory(root);
  if(typeof module === "object" && module.exports) module.exports = api;
  if(root) root.SdeHandwritingRuntime = api;
})(typeof window !== "undefined" ? window : globalThis, function createSdeHandwritingRuntime(root){
  "use strict";

  function makeSessionId(){
    if(root.crypto && typeof root.crypto.randomUUID === "function") return root.crypto.randomUUID();
    return `htr-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  async function decodeImage(file, environment){
    if(typeof environment.createImageBitmap === "function"){
      const bitmap = await environment.createImageBitmap(file, {imageOrientation: "from-image"});
      return {image: bitmap, width: bitmap.width, height: bitmap.height, release(){ bitmap.close?.(); }};
    }
    const documentRef = environment.document;
    if(!documentRef || !environment.URL) throw new Error("image_decoder_unavailable");
    const image = documentRef.createElement("img");
    const objectUrl = environment.URL.createObjectURL(file);
    try{
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = () => reject(new Error("image_decode_failed"));
        image.src = objectUrl;
      });
      return {
        image,
        width: image.naturalWidth,
        height: image.naturalHeight,
        release(){ environment.URL.revokeObjectURL(objectUrl); },
      };
    }catch(error){
      environment.URL.revokeObjectURL(objectUrl);
      throw error;
    }
  }

  async function imageFrame(file, environment, maximumDimension){
    const decoded = await decodeImage(file, environment);
    try{
      // The known paper form is portrait. EXIF is applied by decodeImage; a
      // remaining landscape frame is a sideways capture and is normalized
      // before registration so row/column geometry never rotates independently.
      const rotateToPortrait = decoded.width > decoded.height;
      const orientedWidth = rotateToPortrait ? decoded.height : decoded.width;
      const orientedHeight = rotateToPortrait ? decoded.width : decoded.height;
      const scale = Math.min(1, maximumDimension / Math.max(orientedWidth, orientedHeight));
      const width = Math.max(1, Math.round(orientedWidth * scale));
      const height = Math.max(1, Math.round(orientedHeight * scale));
      const canvas = environment.document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d", {willReadFrequently: true, alpha: false});
      if(!context) throw new Error("image_preprocessing_unavailable");
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.fillStyle = "#fff";
      context.fillRect(0, 0, width, height);
      if(rotateToPortrait){
        context.save();
        context.translate(width, 0);
        context.rotate(Math.PI / 2);
        context.drawImage(decoded.image, 0, 0, height, width);
        context.restore();
      }else{
        context.drawImage(decoded.image, 0, 0, width, height);
      }
      const frame = context.getImageData(0, 0, width, height);
      return {width, height, pixels: frame.data, orientationNormalized: rotateToPortrait || true};
    }finally{
      decoded.release();
    }
  }

  function createLocalHandwritingAnalyzer(options = {}){
    const environment = options.environment || root;
    const WorkerConstructor = options.Worker || environment.Worker;
    if(typeof WorkerConstructor !== "function") throw new Error("local_htr_worker_unavailable");
    if(!environment.document) throw new Error("local_htr_canvas_unavailable");
    const workerUrl = String(options.workerUrl || new URL("sde_handwriting_worker.js", environment.document.baseURI).href);
    const maximumDimension = Math.max(1200, Math.min(2400, Number(options.maximumDimension || 1800)));
    let worker = null;
    let active = null;

    function ensureWorker(){
      if(worker) return worker;
      worker = new WorkerConstructor(workerUrl, {type: "module", name: "sde-local-handwriting-recognition"});
      return worker;
    }

    function rejectActive(error){
      if(!active) return;
      const pending = active;
      active = null;
      pending.reject(error);
    }

    return Object.freeze({
      async analyze(file, context = {}, onProgress){
        if(active) throw new Error("htr_analysis_already_running");
        const sessionId = makeSessionId();
        if(typeof onProgress === "function") onProgress({status: "IMAGE_PREPROCESSING", progress: 0});
        const frame = await imageFrame(file, environment, maximumDimension);
        const target = ensureWorker();
        return new Promise((resolve, reject) => {
          active = {sessionId, resolve, reject};
          const onMessage = event => {
            const message = event.data || {};
            if(message.sessionId !== sessionId) return;
            if(message.type === "progress"){
              if(typeof onProgress === "function") onProgress(message);
              return;
            }
            target.removeEventListener("message", onMessage);
            target.removeEventListener("error", onError);
            active = null;
            if(message.type === "complete") resolve(message.result);
            else reject(new Error(String(message.error || "htr_analysis_failed")));
          };
          const onError = event => {
            target.removeEventListener("message", onMessage);
            target.removeEventListener("error", onError);
            rejectActive(new Error(String(event?.message || "htr_worker_failed")));
          };
          target.addEventListener("message", onMessage);
          target.addEventListener("error", onError);
          target.postMessage({
            type: "analyze",
            sessionId,
            width: frame.width,
            height: frame.height,
            pixels: frame.pixels.buffer,
            canonicalSlots: Array.isArray(context.canonicalSlots) ? context.canonicalSlots : [],
            vehicleCatalog: Array.isArray(context.vehicleCatalog) ? context.vehicleCatalog : [],
          }, [frame.pixels.buffer]);
        });
      },
      async cancel(){
        if(!active || !worker) return false;
        const pending = active;
        worker.postMessage({type: "cancel", sessionId: pending.sessionId});
        return true;
      },
      dispose(){
        if(worker) worker.terminate();
        worker = null;
        rejectActive(new Error("htr_cancelled"));
      },
    });
  }

  function fieldDescriptor(cell){
    if(!cell) return undefined;
    return {
      rawValue: String(cell.recognizedText || ""),
      normalizedValue: String(cell.selectedValue || ""),
      confidence: Number(cell.confidence || 0),
      sourceRegion: {
        row: cell.rowIndex == null ? null : cell.rowIndex + 1,
        columnId: cell.columnId,
        boundingBox: cell.boundingBox,
        coordinateSpace: "ORIGINAL_IMAGE",
      },
      validationState: cell.needsReview ? "REVIEW_REQUIRED" : (cell.validationState === "BLANK_IMAGE_CELL" ? "BLANK" : "MAPPED"),
      alternatives: Array.isArray(cell.alternatives) ? [...cell.alternatives] : [],
      needsReview: cell.needsReview === true,
      recognizerVersion: String(cell.recognizerVersion || ""),
      groundTruthSource: "UNCONFIRMED_RECOGNIZER_OUTPUT",
      rawRecognizerIsGroundTruth: false,
    };
  }

  function mapResultToNightPlan(result, options = {}){
    const logic = options.logic || root.SdeNightIntelligence;
    if(!logic || typeof logic.createNightPlan !== "function") throw new Error("night_plan_logic_unavailable");
    if(!result || !Array.isArray(result.cells) || !result.mappingReport) throw new Error("invalid_htr_result");
    const entries = Array.from({length: 29}, () => ({}));
    const fieldNames = {
      fromTrain: "arrivalOccurrence",
      toTrain: "departureOccurrence",
      vehicleId: "vehicleId",
      toTrack: "desiredSlot",
      wcWater: "taskContext",
      notes: "notes",
    };
    for(const cell of result.cells){
      const row = Number(cell.rowIndex);
      const fieldName = fieldNames[cell.columnId];
      if(Number.isInteger(row) && row >= 0 && row < 29 && fieldName) entries[row][fieldName] = fieldDescriptor(cell);
    }
    const metadata = {};
    for(const cell of Array.isArray(result.metadataCells) ? result.metadataCells : []){
      if(["date", "signature", "ds"].includes(cell.columnId)) metadata[cell.columnId] = String(cell.selectedValue || "");
    }
    return logic.createNightPlan({
      planId: options.planId,
      operationalDate: options.operationalDate,
      createdAt: options.createdAt,
      createdBy: "",
      sourceType: "HUMAN_IMPORTED_PLAN",
      sourceFingerprint: options.sourceFingerprint,
      planStatus: "DRAFT",
      ocrMetadata: metadata,
      ocrMapping: result.mappingReport,
      entries,
    });
  }

  return Object.freeze({
    createLocalHandwritingAnalyzer,
    mapResultToNightPlan,
  });
});
