import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { EngineOutput } from "../process/types";
import type { EngineRuleDefinition } from "../../types/engineRule";

type MappingGroupEntry = {
  source: string;
  target: string;
};

type MappingGroup = {
  id: string;
  name?: string;
  entries: readonly MappingGroupEntry[];
};

export type EngineProcessSourceInput = {
  sourceId: string;
  datasetId: string;
  sheetName: string;
  fileName: string;
};

export type EngineProcessTaskInput = {
  rule: EngineRuleDefinition;
  sources: EngineProcessSourceInput[];
  mappingGroups: readonly MappingGroup[];
  exportDirectory: string;
};

export type EngineProcessTaskStage =
  | "load_sources"
  | "join_sources"
  | "build_result"
  | "build_workbook"
  | "resolve_output_path"
  | "write_output_file";

export type EngineProcessTaskOptions = {
  onStage?: (stage: EngineProcessTaskStage) => void;
  onLog?: (message: string, level?: "info" | "success" | "error") => void;
};

export type EngineProcessTaskResult = {
  outputPath: string;
  sheetCount: number;
  rowCount: number;
  engineOutput: EngineOutput;
};

type BackendProgressEvent = {
  taskId: string;
  stage?: EngineProcessTaskStage;
  level: "info" | "success" | "error";
  message: string;
};

export async function runEngineProcessTask(
  input: EngineProcessTaskInput,
  options: EngineProcessTaskOptions = {},
): Promise<EngineProcessTaskResult> {
  const taskId = crypto.randomUUID();
  let unlisten: UnlistenFn | undefined;

  try {
    unlisten = await listen<BackendProgressEvent>("engine-process-event", (event) => {
      const payload = event.payload;
      if (payload.taskId !== taskId) {
        return;
      }
      if (payload.stage) {
        options.onStage?.(payload.stage);
      }
      if (payload.message) {
        options.onLog?.(payload.message, payload.level);
      }
    });

    return await invoke<EngineProcessTaskResult>("run_engine_process_task", {
      input: {
        taskId,
        rule: JSON.parse(JSON.stringify(input.rule)),
        sources: JSON.parse(JSON.stringify(input.sources)),
        mappingGroups: JSON.parse(JSON.stringify(input.mappingGroups)),
        exportDirectory: input.exportDirectory,
      },
    });
  } finally {
    unlisten?.();
  }
}
