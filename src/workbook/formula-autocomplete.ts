export interface FormulaAutocompleteRecord {
  recordId: string;
  label: string;
  entityType: string;
}

export interface FormulaAutocompleteSuggestion extends FormulaAutocompleteRecord {
  replacement: string;
}

const GRAPH_TRAVERSE_PREFIX = '=GRAPH_TRAVERSE(';

export function isGraphTraverseStartNodeContext(formula: string, cursorIndex: number): boolean {
  const upperFormula = formula.toUpperCase();
  const prefixIndex = upperFormula.indexOf(GRAPH_TRAVERSE_PREFIX);

  if (prefixIndex === -1 || cursorIndex < prefixIndex + GRAPH_TRAVERSE_PREFIX.length) {
    return false;
  }

  const startIndex = prefixIndex + GRAPH_TRAVERSE_PREFIX.length;
  const beforeCursor = formula.slice(startIndex, cursorIndex);
  let inString = false;

  for (const character of beforeCursor) {
    if (character === '"') {
      inString = !inString;
      continue;
    }

    if (character === ',' && !inString) {
      return false;
    }
  }

  return true;
}

export function extractGraphTraverseStartNodeQuery(formula: string, cursorIndex: number): string {
  if (!isGraphTraverseStartNodeContext(formula, cursorIndex)) {
    return '';
  }

  const startIndex = formula.toUpperCase().indexOf(GRAPH_TRAVERSE_PREFIX) + GRAPH_TRAVERSE_PREFIX.length;
  const rawValue = formula.slice(startIndex, cursorIndex).trimStart();
  return rawValue.replace(/^"/, '');
}

export function getFormulaAutocompleteSuggestions(
  records: FormulaAutocompleteRecord[],
  rawQuery: string,
  limit = 8,
): FormulaAutocompleteSuggestion[] {
  const query = rawQuery.trim().toLowerCase();

  const ranked = [...records].sort((left, right) => {
    const leftPrefix = scoreMatch(left, query);
    const rightPrefix = scoreMatch(right, query);
    if (leftPrefix !== rightPrefix) {
      return rightPrefix - leftPrefix;
    }

    return left.label.localeCompare(right.label);
  });

  return ranked
    .filter((record) => scoreMatch(record, query) > 0)
    .slice(0, limit)
    .map((record) => ({
      ...record,
      replacement: `"${record.recordId}"`,
    }));
}

export function applyFormulaAutocompleteSelection(
  formula: string,
  cursorIndex: number,
  suggestion: FormulaAutocompleteSuggestion,
): { nextFormula: string; nextCursorIndex: number } {
  const prefixIndex = formula.toUpperCase().indexOf(GRAPH_TRAVERSE_PREFIX);
  const startIndex = prefixIndex + GRAPH_TRAVERSE_PREFIX.length;
  const suffix = formula.slice(cursorIndex);
  const nextFormula = `${formula.slice(0, startIndex)}${suggestion.replacement}${suffix}`;
  const nextCursorIndex = startIndex + suggestion.replacement.length;

  return { nextFormula, nextCursorIndex };
}

function scoreMatch(record: FormulaAutocompleteRecord, query: string): number {
  if (!query) {
    return 1;
  }

  const recordId = record.recordId.toLowerCase();
  const label = record.label.toLowerCase();

  if (recordId.startsWith(query)) {
    return 4;
  }

  if (label.startsWith(query)) {
    return 3;
  }

  if (recordId.includes(query)) {
    return 2;
  }

  if (label.includes(query)) {
    return 1;
  }

  return 0;
}
