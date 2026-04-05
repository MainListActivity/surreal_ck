const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024; // 20 MB

export interface UploadedFile {
  bucketPath: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
}

export interface UploadError {
  type: 'too-large' | 'sanitize-failed' | 'upload-failed';
  message: string;
}

function formatUploadFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();

  if (
    normalized.includes('enospc')
    || normalized.includes('no space left on device')
    || normalized.includes('disk full')
  ) {
    return 'File upload failed because storage is full. Please retry later or contact support.';
  }

  return message || 'File upload failed. Please try again.';
}

/**
 * Sanitizes a filename: strips path separators, null bytes, and dotfiles.
 * UUID-prefixes to ensure bucket key uniqueness.
 */
export function sanitizeFilename(name: string): string {
  const stripped = name
    .replace(/[/\\]/g, '')       // strip path separators
    .replace(/\.\./g, '')         // strip parent-dir traversal
    .replace(/\x00/g, '')         // strip null bytes
    .replace(/^\.+/, '');         // strip leading dots (hidden files)

  const safe = stripped || 'upload';
  const uuid = crypto.randomUUID();
  return `${uuid}-${safe}`;
}

/**
 * Uploads a browser File to the SurrealDB bucket via db.query().
 *
 * Strategy: pass the file as ArrayBuffer via query params. If the SDK does not
 * support binary params directly, fall back to base64 encoding.
 *
 * Returns the bucket path (e.g. "spreadsheet_files:/uuid-filename.pdf") or an error.
 */
export async function uploadFileToBucket(
  db: { query: (q: string, params?: Record<string, unknown>) => Promise<unknown[]> },
  file: File,
): Promise<UploadedFile | UploadError> {
  if (file.size > MAX_FILE_SIZE_BYTES) {
    return {
      type: 'too-large',
      message: `File too large. Maximum size: 20MB. (${(file.size / 1024 / 1024).toFixed(1)} MB received)`,
    };
  }

  const sanitizedName = sanitizeFilename(file.name);
  const bucketPath = `spreadsheet_files:/${sanitizedName}`;

  try {
    const bytes = await file.arrayBuffer();
    await db.query('LET $f = type::thing("spreadsheet_files", $path); $f.put($bytes)', {
      path: sanitizedName,
      bytes,
    });

    return {
      bucketPath,
      originalName: file.name,
      mimeType: file.type || 'application/octet-stream',
      sizeBytes: file.size,
    };
  } catch (primaryError) {
    // Fallback: base64 approach if ArrayBuffer param is rejected by SDK.
    try {
      const base64 = await fileToBase64(file);
      await db.query(
        'LET $f = type::thing("spreadsheet_files", $path); $f.put(encoding::base64::decode($b64))',
        { path: sanitizedName, b64: base64 },
      );

      return {
        bucketPath,
        originalName: file.name,
        mimeType: file.type || 'application/octet-stream',
        sizeBytes: file.size,
      };
    } catch (err) {
      const primaryMessage = formatUploadFailure(primaryError);
      return {
        type: 'upload-failed',
        message:
          primaryMessage.includes('storage is full')
            ? primaryMessage
            : formatUploadFailure(err),
      };
    }
  }
}

/**
 * Deletes an orphaned bucket file after a failed transaction.
 * Best-effort: failure is non-fatal.
 */
export async function deleteOrphanedFile(
  db: { query: (q: string, params?: Record<string, unknown>) => Promise<unknown[]> },
  bucketPath: string,
): Promise<void> {
  try {
    const pathPart = bucketPath.replace('spreadsheet_files:/', '');
    await db.query('LET $f = type::thing("spreadsheet_files", $path); $f.delete()', {
      path: pathPart,
    });
  } catch {
    // Non-fatal — orphaned files are manageable via admin tooling.
  }
}

async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // Strip data URL prefix: "data:mime/type;base64,"
      const base64 = result.split(',')[1] ?? '';
      resolve(base64);
    };
    reader.onerror = () => reject(new Error('FileReader failed'));
    reader.readAsDataURL(file);
  });
}
