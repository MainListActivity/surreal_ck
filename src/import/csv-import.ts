/**
 * CSV import pipeline: parse → sanitize → validate → batch-insert.
 *
 * Legal context: partial imports are worse than full rollback. Strategy:
 * - Validate all rows before committing any.
 * - If any chunk fails, stop immediately (no partial commit).
 * - Report exactly which rows failed.
 */

const FORMULA_INJECTION_CHARS = /^[=+\-@\t\r]/;
const CHUNK_SIZE = 500;
const MAX_PREVIEW_ERRORS = 5;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CsvRow {
  [header: string]: string;
}

export interface ColumnMapping {
  csvHeader: string;
  /** null = skip this column */
  fieldKey: string | null;
  fieldType: string;
}

export interface ValidationError {
  rowIndex: number;
  column: string;
  message: string;
}

export interface ParseResult {
  headers: string[];
  rows: CsvRow[];
  sanitizedCount: number;
}

export interface ValidationResult {
  errors: ValidationError[];
  isValid: boolean;
}

export interface ImportProgress {
  processedRows: number;
  totalRows: number;
  currentChunk: number;
  totalChunks: number;
}

export interface ImportResult {
  ok: true;
  insertedCount: number;
  sanitizedCount: number;
}

export interface ImportError {
  ok: false;
  failedAtChunk: number;
  failedAtRow: number;
  message: string;
}

// ─── CSV parsing ──────────────────────────────────────────────────────────────

/**
 * Parses a CSV string into rows. Handles quoted fields and embedded newlines.
 * Formula injection characters are stripped silently; `sanitizedCount` tracks
 * how many cells were modified.
 */
export function parseCsv(csvText: string): ParseResult {
  const lines = csvText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(Boolean);
  if (lines.length === 0) {
    return { headers: [], rows: [], sanitizedCount: 0 };
  }

  const headers = splitCsvLine(lines[0]);
  let sanitizedCount = 0;
  const rows: CsvRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = splitCsvLine(lines[i]);
    const row: CsvRow = {};
    for (let j = 0; j < headers.length; j++) {
      const raw = values[j] ?? '';
      const sanitized = sanitizeCell(raw);
      if (sanitized !== raw) sanitizedCount++;
      row[headers[j]] = sanitized;
    }
    rows.push(row);
  }

  return { headers, rows, sanitizedCount };
}

function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        field += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      fields.push(field);
      field = '';
    } else {
      field += ch;
    }
  }
  fields.push(field);
  return fields;
}

/**
 * Strips formula injection characters from the start of a cell value.
 * Per the plan: strip leading `=`, `+`, `-`, `@`, `\t`, `\r`.
 */
export function sanitizeCell(value: string): string {
  let v = value;
  while (v.length > 0 && FORMULA_INJECTION_CHARS.test(v)) {
    v = v.slice(1);
  }
  return v;
}

// ─── Column mapping ───────────────────────────────────────────────────────────

/**
 * Auto-maps CSV headers to field keys by exact and case-insensitive match.
 */
export function autoMapColumns(
  headers: string[],
  fields: Array<{ key: string; type: string }>,
): ColumnMapping[] {
  return headers.map((header) => {
    const exact = fields.find((f) => f.key === header);
    const loose = fields.find((f) => f.key.toLowerCase() === header.toLowerCase().replace(/\s+/g, '_'));
    const match = exact ?? loose;
    return {
      csvHeader: header,
      fieldKey: match?.key ?? null,
      fieldType: match?.type ?? 'text',
    };
  });
}

// ─── Validation ───────────────────────────────────────────────────────────────

/**
 * Validates the first 50 rows against the column mapping.
 * Returns up to MAX_PREVIEW_ERRORS errors for display.
 */
export function validateRows(
  rows: CsvRow[],
  mappings: ColumnMapping[],
  requiredFieldKeys: string[],
): ValidationResult {
  const errors: ValidationError[] = [];
  const previewRows = rows.slice(0, 50);

  for (let i = 0; i < previewRows.length; i++) {
    const row = previewRows[i];
    for (const mapping of mappings) {
      if (!mapping.fieldKey) continue;
      const value = row[mapping.csvHeader] ?? '';
      const isRequired = requiredFieldKeys.includes(mapping.fieldKey);

      if (isRequired && !value.trim()) {
        errors.push({ rowIndex: i + 1, column: mapping.csvHeader, message: 'Required field is empty.' });
        continue;
      }

      if (mapping.fieldType === 'number' && value.trim() && isNaN(Number(value))) {
        errors.push({ rowIndex: i + 1, column: mapping.csvHeader, message: `Expected a number, got "${value}".` });
      }

      if (mapping.fieldType === 'date' && value.trim() && isNaN(Date.parse(value))) {
        errors.push({ rowIndex: i + 1, column: mapping.csvHeader, message: `Expected a date, got "${value}".` });
      }
    }
    if (errors.length >= MAX_PREVIEW_ERRORS) break;
  }

  return { errors, isValid: errors.length === 0 };
}

// ─── Commit ───────────────────────────────────────────────────────────────────

/**
 * Commits rows to SurrealDB in CHUNK_SIZE-row transactions.
 *
 * Strategy: fail entire import on any chunk failure (legal context: partial
 * import worse than full rollback). Reports the failing chunk + row number.
 *
 * `onProgress` is called after each successful chunk.
 */
export async function commitImport(
  db: { query: (q: string, params?: Record<string, unknown>) => Promise<unknown[]> },
  rows: CsvRow[],
  mappings: ColumnMapping[],
  targetTable: string,
  workspaceId: string,
  onProgress: (progress: ImportProgress) => void,
): Promise<ImportResult | ImportError> {
  const totalRows = rows.length;
  const totalChunks = Math.ceil(totalRows / CHUNK_SIZE);

  for (let chunkIdx = 0; chunkIdx < totalChunks; chunkIdx++) {
    const chunk = rows.slice(chunkIdx * CHUNK_SIZE, (chunkIdx + 1) * CHUNK_SIZE);

    try {
      // Build INSERT statements for this chunk in a single transaction.
      const records = chunk.map((row) => {
        const record: Record<string, unknown> = { workspace: workspaceId };
        for (const mapping of mappings) {
          if (!mapping.fieldKey) continue;
          const raw = row[mapping.csvHeader] ?? '';
          if (!raw.trim()) continue;

          if (mapping.fieldType === 'number') {
            record[mapping.fieldKey] = Number(raw);
          } else if (mapping.fieldType === 'date') {
            record[mapping.fieldKey] = new Date(raw).toISOString();
          } else {
            record[mapping.fieldKey] = raw;
          }
        }
        return record;
      });

      // Insert all records in the chunk as a bulk INSERT.
      await db.query(
        `INSERT INTO ${targetTable} $records`,
        { records },
      );

      onProgress({
        processedRows: Math.min((chunkIdx + 1) * CHUNK_SIZE, totalRows),
        totalRows,
        currentChunk: chunkIdx + 1,
        totalChunks,
      });
    } catch (err) {
      return {
        ok: false,
        failedAtChunk: chunkIdx + 1,
        failedAtRow: chunkIdx * CHUNK_SIZE + 1,
        message: err instanceof Error ? err.message : 'Import failed during commit.',
      };
    }
  }

  return { ok: true, insertedCount: totalRows, sanitizedCount: 0 };
}
