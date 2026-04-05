import { describe, expect, it, vi } from 'vitest';

import { parseCsv, sanitizeCell, autoMapColumns, validateRows, commitImport } from './csv-import';

// ─── sanitizeCell ─────────────────────────────────────────────────────────────

describe('sanitizeCell', () => {
  it.each([
    ['=SUM(A1)', 'SUM(A1)'],
    ['+100', '100'],
    ['-50', '50'],
    ['@admin', 'admin'],
    ['\t\tvalue', 'value'],
    ['\rvalue', 'value'],
    ['normal text', 'normal text'],
    ['123', '123'],
    ['', ''],
  ])('sanitizes %s → %s', (input, expected) => {
    expect(sanitizeCell(input)).toBe(expected);
  });
});

// ─── parseCsv ─────────────────────────────────────────────────────────────────

describe('parseCsv', () => {
  it('parses a clean CSV correctly', () => {
    const csv = 'name,jurisdiction\nAcme Corp,Delaware\nBeta LLC,Hong Kong';
    const { headers, rows, sanitizedCount } = parseCsv(csv);
    expect(headers).toEqual(['name', 'jurisdiction']);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ name: 'Acme Corp', jurisdiction: 'Delaware' });
    expect(sanitizedCount).toBe(0);
  });

  it('counts sanitized cells and strips formula injection', () => {
    const csv = 'name\n=evil formula\nnormal';
    const { rows, sanitizedCount } = parseCsv(csv);
    expect(rows[0].name).toBe('evil formula');
    expect(sanitizedCount).toBe(1);
  });

  it('handles quoted fields with commas', () => {
    const csv = 'name,notes\n"Acme, Inc.","A company, USA"';
    const { rows } = parseCsv(csv);
    expect(rows[0].name).toBe('Acme, Inc.');
    expect(rows[0].notes).toBe('A company, USA');
  });

  it('returns empty result for blank CSV', () => {
    const { headers, rows } = parseCsv('');
    expect(headers).toEqual([]);
    expect(rows).toHaveLength(0);
  });

  it('strips formula injection from multiple rows', () => {
    const csv = 'name\n=A1\n+B2\n-C3\nnormal';
    const { sanitizedCount, rows } = parseCsv(csv);
    expect(sanitizedCount).toBe(3);
    expect(rows.map(r => r.name)).toEqual(['A1', 'B2', 'C3', 'normal']);
  });
});

// ─── autoMapColumns ───────────────────────────────────────────────────────────

describe('autoMapColumns', () => {
  const fields = [
    { key: 'name', type: 'text' },
    { key: 'jurisdiction', type: 'text' },
    { key: 'status', type: 'single_select' },
  ];

  it('maps exact matches', () => {
    const mappings = autoMapColumns(['name', 'jurisdiction'], fields);
    expect(mappings[0].fieldKey).toBe('name');
    expect(mappings[1].fieldKey).toBe('jurisdiction');
  });

  it('maps case-insensitive with space-to-underscore', () => {
    const mappings = autoMapColumns(['Name', 'Jurisdiction'], fields);
    expect(mappings[0].fieldKey).toBe('name');
  });

  it('maps unrecognized columns to null (skip)', () => {
    const mappings = autoMapColumns(['unknown_col'], fields);
    expect(mappings[0].fieldKey).toBeNull();
  });
});

// ─── validateRows ─────────────────────────────────────────────────────────────

describe('validateRows', () => {
  const mappings = [
    { csvHeader: 'name', fieldKey: 'name', fieldType: 'text' },
    { csvHeader: 'count', fieldKey: 'count', fieldType: 'number' },
    { csvHeader: 'date', fieldKey: 'date', fieldType: 'date' },
  ];

  it('passes valid rows', () => {
    const rows = [{ name: 'Acme', count: '5', date: '2026-01-01' }];
    const result = validateRows(rows, mappings, ['name']);
    expect(result.isValid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('catches missing required field', () => {
    const rows = [{ name: '', count: '5', date: '2026-01-01' }];
    const result = validateRows(rows, mappings, ['name']);
    expect(result.isValid).toBe(false);
    expect(result.errors[0].column).toBe('name');
  });

  it('catches non-numeric value in number field', () => {
    const rows = [{ name: 'Acme', count: 'not-a-number', date: '2026-01-01' }];
    const result = validateRows(rows, mappings, []);
    expect(result.isValid).toBe(false);
    expect(result.errors[0].column).toBe('count');
  });

  it('catches invalid date in date field', () => {
    const rows = [{ name: 'Acme', count: '3', date: 'not-a-date' }];
    const result = validateRows(rows, mappings, []);
    expect(result.isValid).toBe(false);
    expect(result.errors[0].column).toBe('date');
  });
});

// ─── commitImport ─────────────────────────────────────────────────────────────

describe('commitImport', () => {
  const mappings = [
    { csvHeader: 'name', fieldKey: 'name', fieldType: 'text' },
  ];

  it('inserts rows and reports progress', async () => {
    const db = { query: vi.fn(async () => [[]] as any) };
    const rows = Array.from({ length: 10 }, (_, i) => ({ name: `Entity ${i}` }));
    const progress: number[] = [];

    const result = await commitImport(db, rows, mappings, 'company', 'workspace:1', (p) => {
      progress.push(p.processedRows);
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.insertedCount).toBe(10);
    }
    expect(progress).toHaveLength(1); // 10 rows < 500 chunk size = 1 chunk
    expect(progress[0]).toBe(10);
    expect(db.query).toHaveBeenCalledOnce();
  });

  it('batches 1000 rows into 2 chunks of 500', async () => {
    const db = { query: vi.fn(async () => [[]] as any) };
    const rows = Array.from({ length: 1000 }, (_, i) => ({ name: `Row ${i}` }));

    await commitImport(db, rows, mappings, 'company', 'workspace:1', () => undefined);
    expect(db.query).toHaveBeenCalledTimes(2);
  });

  it('returns error on chunk failure and stops immediately', async () => {
    const db = {
      query: vi.fn()
        .mockResolvedValueOnce([[]] as any)   // chunk 1 succeeds
        .mockRejectedValueOnce(new Error('DB write error')), // chunk 2 fails
    };
    const rows = Array.from({ length: 600 }, (_, i) => ({ name: `Row ${i}` }));

    const result = await commitImport(db, rows, mappings, 'company', 'workspace:1', () => undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failedAtChunk).toBe(2);
      expect(result.failedAtRow).toBe(501);
    }
    // Should not have called query a third time
    expect(db.query).toHaveBeenCalledTimes(2);
  });
});
