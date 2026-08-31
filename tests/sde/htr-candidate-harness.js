import * as ort from "../../assets/vendor/onnxruntime-web/ort.wasm.min.mjs";

ort.env.wasm.wasmPaths = "/assets/vendor/onnxruntime-web/";
ort.env.wasm.numThreads = 1;

let sessionPromise;
async function session(){
  sessionPromise ||= ort.InferenceSession.create(
    "../../assets/models/gigapdf-ocr-handwriting/model.onnx",
    {executionProviders: ["wasm"], graphOptimizationLevel: "all"},
  );
  return sessionPromise;
}

window.inspectCandidate = async function inspectCandidate(){
  const active = await session();
  return {
    inputNames: active.inputNames,
    outputNames: active.outputNames,
    inputMetadata: active.inputMetadata,
    outputMetadata: active.outputMetadata,
  };
};

document.getElementById("status").textContent = "loading-model";
window.inspectCandidate().then(result => {
  document.getElementById("status").textContent = JSON.stringify(result);
}).catch(error => {
  document.getElementById("status").textContent = `error:${error && error.message}`;
});

const analyzer = window.SdeHandwritingRuntime.createLocalHandwritingAnalyzer({
  workerUrl: new URL("../../sde_handwriting_worker.js?v=1ac7f9dba2f0f9ce2bf279da6e890269504f4bb4a4dcab15241d85228a199088", document.baseURI).href,
});
document.getElementById("privateImage").addEventListener("change", async event => {
  const file = event.target.files && event.target.files[0];
  if(!file) return;
  document.getElementById("status").textContent = "analyzing";
  try{
    const result = await analyzer.analyze(file, {
      canonicalSlots: ["1", "3N", "3S", "3M", "4N", "4S", "5N", "5S", "5M", "6N", "6S", "7N", "7S", "8N", "8S", "9", "10N", "10S", "11N", "11S", "12N", "12S", "VN", "VS"],
      vehicleCatalog: document.getElementById("vehicleCatalog").value.split(/[\s,]+/).filter(Boolean),
      trainCatalog: document.getElementById("trainCatalog").value.split(/[\s,]+/).filter(Boolean),
    }, progress => { document.getElementById("status").textContent = `${progress.status}:${progress.progress}`; });
    document.getElementById("result").textContent = JSON.stringify(result);
    document.getElementById("status").textContent = "complete";
  }catch(error){
    document.getElementById("status").textContent = `error:${error && error.message}`;
  }
});
