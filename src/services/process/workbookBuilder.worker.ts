import type { EngineOutput } from "./types";
import { buildWorkbookBinarySync } from "./workbookBuilderCore";

type WorkbookBuildRequest = {
  engineOutput: EngineOutput;
};

type WorkbookBuildSuccess = {
  ok: true;
  buffer: ArrayBuffer;
};

type WorkbookBuildFailure = {
  ok: false;
  error: string;
};

const workerScope = self as unknown as {
  postMessage: (message: WorkbookBuildSuccess | WorkbookBuildFailure, transfer?: Transferable[]) => void;
  onmessage: ((event: MessageEvent<WorkbookBuildRequest>) => void) | null;
};

workerScope.onmessage = (event: MessageEvent<WorkbookBuildRequest>) => {
  try {
    const workbookBinary = buildWorkbookBinarySync(event.data.engineOutput);
    const buffer = workbookBinary.buffer.slice(
      workbookBinary.byteOffset,
      workbookBinary.byteOffset + workbookBinary.byteLength,
    );
    const payload: WorkbookBuildSuccess = {
      ok: true,
      buffer,
    };
    workerScope.postMessage(payload, [buffer]);
  } catch (error) {
    const payload: WorkbookBuildFailure = {
      ok: false,
      error: error instanceof Error ? error.message : String(error ?? "工作簿生成失败。"),
    };
    workerScope.postMessage(payload);
  }
};

export {};
