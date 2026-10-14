import type { Analysis, Progress } from "../core/model";
import type { WorkerRequest, WorkerResponse } from "./pipeline.worker";

export interface AnalyzeHandlers {
  onProgress(p: Progress): void;
}

export class AnalyzeError extends Error {
  constructor(
    public code: string,
    message: string,
    public resetAt?: number,
  ) {
    super(message);
  }
}

let current: Worker | null = null;

/** Runs the fetch + analysis pipeline in a worker. Starting a new one cancels the previous. */
export function analyzeRepo(input: string, handlers: AnalyzeHandlers, force = false): Promise<{ analysis: Analysis; fromCache: boolean }> {
  current?.terminate();
  const worker = new Worker(new URL("./pipeline.worker.ts", import.meta.url), { type: "module" });
  current = worker;
  return new Promise((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const msg = event.data;
      if (msg.type === "progress") handlers.onProgress(msg.progress);
      else {
        worker.terminate();
        if (current === worker) current = null;
        if (msg.type === "done") resolve({ analysis: msg.analysis, fromCache: msg.fromCache });
        else reject(new AnalyzeError(msg.code, msg.message, msg.resetAt));
      }
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new AnalyzeError("network", event.message || "Worker crashed"));
    };
    worker.postMessage({ type: "analyze", input, force } satisfies WorkerRequest);
  });
}

export function cancelAnalysis() {
  current?.terminate();
  current = null;
}
