import type { EngineOutput } from "../process/types";
import {
  runEngineProcessComputation,
  type EngineProcessComputationInput,
  type EngineProcessTaskStage,
} from "./index";

type EngineProcessWorkerRequest = {
  input: EngineProcessComputationInput;
};

type EngineProcessWorkerSuccess = {
  ok: true;
  engineOutput: EngineOutput;
};

type EngineProcessWorkerFailure = {
  ok: false;
  error: string;
};

type EngineProcessWorkerProgress = {
  ok: null;
  stage?: EngineProcessTaskStage;
  log?: {
    message: string;
    level: "info" | "success" | "error";
  };
};

const workerScope = self as unknown as {
  postMessage: (
    message: EngineProcessWorkerSuccess | EngineProcessWorkerFailure | EngineProcessWorkerProgress,
  ) => void;
  onmessage: ((event: MessageEvent<EngineProcessWorkerRequest>) => void) | null;
};

workerScope.onmessage = (event: MessageEvent<EngineProcessWorkerRequest>) => {
  try {
    const engineOutput = runEngineProcessComputation(event.data.input, {
      onStage: (stage) => {
        workerScope.postMessage({
          ok: null,
          stage,
        });
      },
      onLog: (message, level = "info") => {
        workerScope.postMessage({
          ok: null,
          log: {
            message,
            level,
          },
        });
      },
    });
    workerScope.postMessage({
      ok: true,
      engineOutput,
    });
  } catch (error) {
    workerScope.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : String(error ?? "结果构建失败。"),
    });
  }
};

export {};
