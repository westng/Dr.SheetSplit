const TITLE_TEMPLATE_VARIABLE_PATTERN = /\{\{\s*([^{}]+?)\s*\}\}/g;

export function extractTitleTemplateVariables(template: string): string[] {
  const variables = new Set<string>();
  let match: RegExpExecArray | null = TITLE_TEMPLATE_VARIABLE_PATTERN.exec(template);

  while (match) {
    const variableKey = match[1]?.trim();
    if (variableKey) {
      variables.add(variableKey);
    }
    match = TITLE_TEMPLATE_VARIABLE_PATTERN.exec(template);
  }

  TITLE_TEMPLATE_VARIABLE_PATTERN.lastIndex = 0;
  return Array.from(variables);
}

export function toExcelColumnLabel(index: number): string {
  if (index < 1) {
    return "A";
  }

  let current = index;
  let result = "";

  while (current > 0) {
    const remainder = (current - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    current = Math.floor((current - 1) / 26);
  }

  return result;
}
