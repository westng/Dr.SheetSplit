import type { EngineOutput } from "./types";
import { buildWorkbookBinarySync } from "./workbookBuilderCore";

type WorkbookBuildSuccess = {
  ok: true;
  buffer: ArrayBuffer;
};

type WorkbookBuildFailure = {
  ok: false;
  error: string;
};

let workerInstance: Worker | null = null;

function getWorker(): Worker | null {
  if (typeof Worker === "undefined") {
    return null;
  }
  if (!workerInstance) {
    workerInstance = new Worker(new URL("./workbookBuilder.worker.ts", import.meta.url), {
      type: "module",
    });
  }
  return workerInstance;
}

export async function buildWorkbookBinary(engineOutput: EngineOutput): Promise<Uint8Array> {
  const worker = getWorker();
  if (!worker) {
    return buildWorkbookBinarySync(engineOutput);
  }

  return new Promise<Uint8Array>((resolve, reject) => {
    const handleMessage = (event: MessageEvent<WorkbookBuildSuccess | WorkbookBuildFailure>) => {
      worker.removeEventListener("message", handleMessage);
      worker.removeEventListener("error", handleError);

      if (!event.data.ok) {
        reject(new Error(event.data.error || "工作簿生成失败。"));
        return;
      }

      resolve(new Uint8Array(event.data.buffer));
    };

    const handleError = (event: ErrorEvent) => {
      worker.removeEventListener("message", handleMessage);
      worker.removeEventListener("error", handleError);
      reject(new Error(event.message || "工作簿生成失败。"));
    };

    worker.addEventListener("message", handleMessage);
    worker.addEventListener("error", handleError);
    worker.postMessage({ engineOutput });
  });
}
