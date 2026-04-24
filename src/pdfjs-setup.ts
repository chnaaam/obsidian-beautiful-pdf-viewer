// @ts-expect-error - virtual module provided by esbuild inlinePdfjsWorker plugin.
import workerSource from "pdfjs-worker-inline";

let initialized = false;

export async function ensurePdfjsWorker(): Promise<void> {
  if (initialized) return;
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  if (!pdfjs.GlobalWorkerOptions.workerSrc && !pdfjs.GlobalWorkerOptions.workerPort) {
    const blob = new Blob([workerSource as string], { type: "application/javascript" });
    pdfjs.GlobalWorkerOptions.workerSrc = URL.createObjectURL(blob);
  }
  initialized = true;
}
