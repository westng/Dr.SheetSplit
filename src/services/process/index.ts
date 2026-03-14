import { resolveOutputPath, writeBinaryToPath } from "./fileOutput";
import { runPythonTransform } from "./pythonEngine";
import { buildWorkbookBinary } from "./workbookBuilder";
import type { ProcessTaskInput, ProcessTaskOptions, ProcessTaskResult } from "./types";

export async function runProcessTask(
  input: ProcessTaskInput,
  options: ProcessTaskOptions = {},
): Promise<ProcessTaskResult> {
  options.onStage?.("invoke_engine");
  const engineOutput = await runPythonTransform(input);

  options.onStage?.("build_workbook");
  const workbookBinary = buildWorkbookBinary(engineOutput);

  options.onStage?.("resolve_output_path");
  const outputPath = await resolveOutputPath(
    input.sourceFileName,
    input.rule.name,
    input.exportDirectory,
  );

  options.onStage?.("write_output_file");
  await writeBinaryToPath(outputPath, workbookBinary);

  return {
    outputPath,
    sheetCount: engineOutput.sheetCount,
    rowCount: engineOutput.rowCount,
    engineOutput,
  };
}
