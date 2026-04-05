import { describe, expect, it, vi, beforeEach } from 'vitest';

import { sanitizeFilename, uploadFileToBucket, deleteOrphanedFile } from './file-upload';

// ─── sanitizeFilename ─────────────────────────────────────────────────────────

describe('sanitizeFilename', () => {
  it('strips path separators', () => {
    const result = sanitizeFilename('../../etc/passwd');
    expect(result).not.toContain('/');
    expect(result).not.toContain('\\');
    expect(result).not.toContain('..');
  });

  it('strips null bytes', () => {
    const result = sanitizeFilename('file\x00name.pdf');
    expect(result).not.toContain('\x00');
  });

  it('strips leading dots (hidden file)', () => {
    const result = sanitizeFilename('.hidden');
    // The UUID prefix comes first, so the result should not have the leading dot
    // after the UUID prefix portion
    const afterUuidPrefix = result.split('-').slice(5).join('-');
    expect(afterUuidPrefix).toBe('hidden');
  });

  it('uses "upload" as fallback for empty name', () => {
    const result = sanitizeFilename('');
    expect(result).toMatch(/upload$/);
  });

  it('prepends a UUID prefix', () => {
    const result = sanitizeFilename('report.pdf');
    // UUID v4 format: 8-4-4-4-12
    expect(result).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-report\.pdf$/);
  });
});

// ─── uploadFileToBucket ───────────────────────────────────────────────────────

function makeFile(name: string, sizeBytes: number, type = 'application/pdf'): File {
  const content = new Uint8Array(sizeBytes);
  return new File([content], name, { type });
}

describe('uploadFileToBucket', () => {
  it('rejects files over 20 MB', async () => {
    const db = { query: vi.fn() };
    const bigFile = makeFile('big.pdf', 21 * 1024 * 1024);
    const result = await uploadFileToBucket(db, bigFile);
    expect('type' in result && result.type).toBe('too-large');
    expect(db.query).not.toHaveBeenCalled();
  });

  it('uploads file via ArrayBuffer and returns bucket path', async () => {
    const db = { query: vi.fn(async () => [null]) };
    const file = makeFile('report.pdf', 1024);
    const result = await uploadFileToBucket(db, file);
    expect('bucketPath' in result).toBe(true);
    if ('bucketPath' in result) {
      expect(result.bucketPath).toMatch(/^spreadsheet_files:\//);
      expect(result.originalName).toBe('report.pdf');
      expect(result.sizeBytes).toBe(1024);
    }
    expect(db.query).toHaveBeenCalledOnce();
  });

  it('falls back to base64 if ArrayBuffer upload throws', async () => {
    const db = {
      query: vi.fn()
        .mockRejectedValueOnce(new Error('binary params not supported'))
        .mockResolvedValueOnce([null]),
    };

    // Mock FileReader for base64 fallback
    const mockReadAsDataURL = vi.fn(function (this: FileReader) {
      Object.defineProperty(this, 'result', { value: 'data:application/pdf;base64,dGVzdA==' });
      this.onload?.({} as unknown as ProgressEvent<FileReader>);
    });
    vi.spyOn(window, 'FileReader').mockImplementation(() => {
      const fr = { readAsDataURL: mockReadAsDataURL, onload: null, onerror: null } as unknown as FileReader;
      return fr;
    });

    const file = makeFile('test.pdf', 512);
    const result = await uploadFileToBucket(db, file);
    expect('bucketPath' in result).toBe(true);
    expect(db.query).toHaveBeenCalledTimes(2);
  });

  it('returns upload-failed error if both strategies fail', async () => {
    const db = {
      query: vi.fn().mockRejectedValue(new Error('bucket unavailable')),
    };

    vi.spyOn(window, 'FileReader').mockImplementation(() => {
      const fr = {
        readAsDataURL: vi.fn(function (this: FileReader) {
          this.onerror?.({} as unknown as ProgressEvent<FileReader>);
        }),
        onload: null,
        onerror: null,
      } as unknown as FileReader;
      return fr;
    });

    const file = makeFile('broken.pdf', 100);
    const result = await uploadFileToBucket(db, file);
    expect('type' in result && result.type).toBe('upload-failed');
  });
});

// ─── deleteOrphanedFile ───────────────────────────────────────────────────────

describe('deleteOrphanedFile', () => {
  it('calls db.query with the correct path extraction', async () => {
    const db = { query: vi.fn(async () => [null]) };
    await deleteOrphanedFile(db, 'spreadsheet_files:/uuid-report.pdf');
    expect(db.query).toHaveBeenCalledOnce();
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('delete'),
      expect.objectContaining({ path: 'uuid-report.pdf' }),
    );
  });

  it('does not throw if db.query fails', async () => {
    const db = { query: vi.fn(async () => { throw new Error('DB error'); }) };
    await expect(deleteOrphanedFile(db, 'spreadsheet_files:/file.pdf')).resolves.toBeUndefined();
  });
});
