import { describe, expect, it } from 'vitest';

import {
  applyFormulaAutocompleteSelection,
  extractGraphTraverseStartNodeQuery,
  getFormulaAutocompleteSuggestions,
  isGraphTraverseStartNodeContext,
} from './formula-autocomplete';

const records = [
  { recordId: 'company:acme-holdings', label: 'Acme Holdings', entityType: 'company' },
  { recordId: 'company:beta-llc', label: 'Beta LLC', entityType: 'company' },
  { recordId: 'person:alice-chen', label: 'Alice Chen', entityType: 'person' },
];

describe('isGraphTraverseStartNodeContext', () => {
  it('returns true while editing the first GRAPH_TRAVERSE argument', () => {
    const formula = '=GRAPH_TRAVERSE("company:ac';
    expect(isGraphTraverseStartNodeContext(formula, formula.length)).toBe(true);
  });

  it('returns false after the first argument is complete', () => {
    const formula = '=GRAPH_TRAVERSE("company:acme", "owns", 2)';
    const cursorIndex = formula.indexOf('"owns"') + 2;
    expect(isGraphTraverseStartNodeContext(formula, cursorIndex)).toBe(false);
  });
});

describe('extractGraphTraverseStartNodeQuery', () => {
  it('extracts the partial record id without the opening quote', () => {
    const formula = '=GRAPH_TRAVERSE("company:ac';
    expect(extractGraphTraverseStartNodeQuery(formula, formula.length)).toBe('company:ac');
  });
});

describe('getFormulaAutocompleteSuggestions', () => {
  it('ranks prefix matches ahead of partial matches', () => {
    const suggestions = getFormulaAutocompleteSuggestions(records, 'comp');
    expect(suggestions[0]?.recordId).toBe('company:acme-holdings');
    expect(suggestions[1]?.recordId).toBe('company:beta-llc');
  });

  it('matches against labels as well as record ids', () => {
    const suggestions = getFormulaAutocompleteSuggestions(records, 'alice');
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]?.recordId).toBe('person:alice-chen');
  });
});

describe('applyFormulaAutocompleteSelection', () => {
  it('replaces the first argument with the selected record id', () => {
    const formula = '=GRAPH_TRAVERSE("company:ac';
    const suggestion = getFormulaAutocompleteSuggestions(records, 'company:ac')[0];
    expect(suggestion).toBeDefined();

    const result = applyFormulaAutocompleteSelection(formula, formula.length, suggestion!);

    expect(result.nextFormula).toBe('=GRAPH_TRAVERSE("company:acme-holdings"');
    expect(result.nextCursorIndex).toBe(result.nextFormula.length);
  });
});
