// app/src/paper-recompose-runtime.mjs
var nextId = 0;
var aborted = () => new DOMException("Recomposition cancelled", "AbortError");
function createRuntime({ workerFactory = () => {
  const url = new URL("./paper-recompose-worker.mjs", import.meta.url);
  url.search = new URL(import.meta.url).search;
  return new Worker(url, { type: "module" });
} } = {}) {
  return { prepare(request = {}) {
    const signal = request.signal;
    if (signal?.aborted) return Promise.reject(aborted());
    let file = request.file, edits, bindings, revision, fileHash;
    try {
      edits = structuredClone(request.edits);
      bindings = structuredClone(request.bindings ?? []);
      revision = structuredClone(request.edits?.revision ?? request.revision ?? null);
      fileHash = request.fileHash;
      if (request.revision != null && request.edits?.revision != null && request.revision !== request.edits.revision) throw new Error("Stale revision");
      if (file instanceof Uint8Array) file = Uint8Array.from(file);
      else if (file instanceof ArrayBuffer) file = file.slice(0);
      else if (file?.bytes instanceof Uint8Array) file = { ...file, bytes: Uint8Array.from(file.bytes) };
      else if (!(typeof File !== "undefined" && file instanceof File)) throw new TypeError("Expected a File or PDF bytes");
    } catch (error) {
      return Promise.reject(error);
    }
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      let worker, done = false;
      const finish = (fn, value) => {
        if (done) return;
        done = true;
        signal?.removeEventListener("abort", onAbort);
        if (worker) {
          worker.onmessage = null;
          worker.onerror = null;
          worker.onmessageerror = null;
          worker.terminate();
        }
        fn(value);
      };
      const onAbort = () => finish(reject, aborted());
      try {
        worker = workerFactory();
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) return onAbort();
        worker.onmessage = async ({ data }) => {
          if (data?.id !== id || data?.type === "progress") return;
          if (data?.type === "error") {
            const e = new Error(data.error?.message || "Recomposition failed");
            e.code = data.error?.code;
            e.details = data.error?.details;
            return finish(reject, e);
          }
          if (data?.type !== "result" || !data.result || !(data.result.file instanceof Blob) || !/^[a-f0-9]{64}$/.test(data.result.sha256 || "") || data.result.revision !== revision) return finish(reject, new Error("Invalid recomposition worker response"));
          try {
            const bytes = new Uint8Array(await data.result.file.arrayBuffer());
            const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (x) => x.toString(16).padStart(2, "0")).join("");
            if (hash !== data.result.sha256) throw new Error("Recomposition output hash mismatch");
            const output = data.result.file instanceof File ? data.result.file : new File([bytes], "recomposed.pdf", { type: "application/pdf" });
            finish(resolve, { ...data.result, file: output });
          } catch (error) {
            finish(reject, error);
          }
        };
        worker.onerror = (e) => finish(reject, new Error(e.message || "Recomposition worker failed"));
        worker.onmessageerror = () => finish(reject, new Error("Recomposition worker message could not be decoded"));
        const buffer = file instanceof Uint8Array ? file.buffer : file instanceof ArrayBuffer ? file : file?.bytes?.buffer;
        worker.postMessage({ id, type: "prepare", request: { file, fileHash, edits, bindings, revision } }, buffer ? [buffer] : []);
      } catch (error) {
        finish(reject, error);
      }
    });
  } };
}
var prepare = createRuntime().prepare;
export {
  createRuntime,
  prepare
};
