import { useEffect, useReducer, useRef } from 'react';
import type { Surreal } from 'surrealdb';

import type { FormDefinition, FormField } from '../admin/form-builder';
import { ConfirmationPage } from './confirmation';
import { deleteOrphanedFile, uploadFileToBucket } from './file-upload';

// ─── Types ────────────────────────────────────────────────────────────────────

interface SubmittedFile {
  bucketPath: string;
  originalName: string;
}

type FieldValue = string | string[] | SubmittedFile | null;

interface State {
  formDef: FormDefinition | null;
  isLoadingForm: boolean;
  loadError: string | null;

  values: Record<string, FieldValue>;
  fieldErrors: Record<string, string>;

  isSubmitting: boolean;
  submitError: string | null;
  submittedAt: Date | null;
  submittedAttachments: string[];
}

type Action =
  | { type: 'load-start' }
  | { type: 'load-ok'; formDef: FormDefinition; draft: Record<string, FieldValue> }
  | { type: 'load-err'; error: string }
  | { type: 'set-value'; key: string; value: FieldValue }
  | { type: 'set-field-error'; key: string; error: string }
  | { type: 'clear-field-error'; key: string }
  | { type: 'submit-start' }
  | { type: 'submit-ok'; at: Date; attachments: string[] }
  | { type: 'submit-err'; error: string }
  | { type: 'reset' };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'load-start':
      return { ...state, isLoadingForm: true, loadError: null };
    case 'load-ok':
      return { ...state, isLoadingForm: false, formDef: action.formDef, values: action.draft };
    case 'load-err':
      return { ...state, isLoadingForm: false, loadError: action.error };
    case 'set-value':
      return { ...state, values: { ...state.values, [action.key]: action.value } };
    case 'set-field-error':
      return { ...state, fieldErrors: { ...state.fieldErrors, [action.key]: action.error } };
    case 'clear-field-error':
      return { ...state, fieldErrors: { ...state.fieldErrors, [action.key]: '' } };
    case 'submit-start':
      return { ...state, isSubmitting: true, submitError: null };
    case 'submit-ok':
      return {
        ...state,
        isSubmitting: false,
        submittedAt: action.at,
        submittedAttachments: action.attachments,
      };
    case 'submit-err':
      return { ...state, isSubmitting: false, submitError: action.error };
    case 'reset':
      return {
        ...state,
        values: {},
        fieldErrors: {},
        submitError: null,
        submittedAt: null,
        submittedAttachments: [],
      };
    default:
      return state;
  }
}

const INITIAL_STATE: State = {
  formDef: null,
  isLoadingForm: false,
  loadError: null,
  values: {},
  fieldErrors: {},
  isSubmitting: false,
  submitError: null,
  submittedAt: null,
  submittedAttachments: [],
};

export function buildSubmissionTransaction(
  targetTable: string,
  workspaceId: string,
  formDefinitionId: string,
  submissionToken: string,
  payload: Record<string, unknown>,
) {
  return {
    query: `BEGIN TRANSACTION;
      LET $record = CREATE type::table($tableName) CONTENT $recordData;
      LET $submission = CREATE intake_submission CONTENT $submissionData;
      RELATE $workspace->workspace_has_submission->$submission;
      RELATE $submission->submission_uses_form->$formDefinition;
      COMMIT TRANSACTION`,
    params: {
      tableName: targetTable,
      recordData: {
        workspace: workspaceId,
        submission_token: submissionToken,
        ...payload,
      },
      submissionData: {
        submission_token: submissionToken,
        payload,
        unverified: false,
      },
      workspace: workspaceId,
      formDefinition: formDefinitionId,
    },
  };
}

// ─── Draft persistence ────────────────────────────────────────────────────────

function loadDraft(formId: string): Record<string, FieldValue> {
  try {
    const raw = localStorage.getItem(`form-draft:${formId}`);
    return raw ? (JSON.parse(raw) as Record<string, FieldValue>) : {};
  } catch {
    return {};
  }
}

function saveDraft(formId: string, values: Record<string, FieldValue>): void {
  try {
    // Don't persist file uploads in localStorage — only text/select/date values.
    const saveable: Record<string, FieldValue> = {};
    for (const [k, v] of Object.entries(values)) {
      if (typeof v === 'string' || Array.isArray(v)) {
        saveable[k] = v;
      }
    }
    localStorage.setItem(`form-draft:${formId}`, JSON.stringify(saveable));
  } catch {
    // localStorage full or unavailable — non-fatal.
  }
}

function clearDraft(formId: string): void {
  try {
    localStorage.removeItem(`form-draft:${formId}`);
  } catch {
    // non-fatal
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

export interface IntakeFormProps {
  db: Surreal;
  formSlug: string;
  workspaceId: string;
}

export function IntakeForm({ db, formSlug, workspaceId }: IntakeFormProps) {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);
  const submissionToken = useRef<string>(crypto.randomUUID());
  const uploadedFiles = useRef<SubmittedFile[]>([]);

  useEffect(() => {
    void loadForm();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formSlug]);

  // Auto-save draft on value changes.
  useEffect(() => {
    if (state.formDef) {
      saveDraft(state.formDef.slug, state.values);
    }
  }, [state.values, state.formDef]);

  async function loadForm() {
    dispatch({ type: 'load-start' });
    try {
      const [rows] = await db.query<[FormDefinition[]]>(
        `SELECT
           out.id AS id,
           out.title AS title,
           out.slug AS slug,
           out.fields AS fields,
           out.conditional_rules AS conditional_rules,
           out.auto_relations AS auto_relations,
           out->form_targets_entity_type->entity_type[0].key AS target_table
         FROM workspace_has_form_definition
         WHERE in = $ws AND out.slug = $slug
         LIMIT 1`,
        { ws: workspaceId, slug: formSlug },
      );
      const formDef = rows?.[0];
      if (!formDef) throw new Error('Form not found.');

      const draft = loadDraft(formDef.slug);
      dispatch({ type: 'load-ok', formDef, draft });
    } catch (err) {
      dispatch({ type: 'load-err', error: err instanceof Error ? err.message : 'Failed to load form.' });
    }
  }

  function validateRequiredFields(): boolean {
    if (!state.formDef) return false;
    let valid = true;
    for (const field of state.formDef.fields) {
      if (!field.required) continue;
      const value = state.values[field.key];
      if (!value || (typeof value === 'string' && !value.trim()) || (Array.isArray(value) && value.length === 0)) {
        dispatch({ type: 'set-field-error', key: field.key, error: `${field.label} is required.` });
        valid = false;
      }
    }
    return valid;
  }

  async function handleFileChange(field: FormField, file: File | null) {
    if (!file) {
      dispatch({ type: 'set-value', key: field.key, value: null });
      return;
    }

    const result = await uploadFileToBucket(db, file);
    if ('type' in result) {
      dispatch({ type: 'set-field-error', key: field.key, error: result.message });
      return;
    }

    dispatch({ type: 'clear-field-error', key: field.key });
    dispatch({ type: 'set-value', key: field.key, value: { bucketPath: result.bucketPath, originalName: result.originalName } });
    uploadedFiles.current.push({ bucketPath: result.bucketPath, originalName: result.originalName });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (state.isSubmitting || !state.formDef) return;
    if (!validateRequiredFields()) return;

    dispatch({ type: 'submit-start' });

    // Build payload — flatten file values to bucket paths.
    const payload: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(state.values)) {
      if (v !== null && typeof v === 'object' && !Array.isArray(v) && 'bucketPath' in v) {
        payload[k] = (v as SubmittedFile).bucketPath;
      } else {
        payload[k] = v;
      }
    }

    try {
      const uploadedAttachmentNames = uploadedFiles.current.map((file) => file.originalName);
      const transaction = buildSubmissionTransaction(
        state.formDef.target_table,
        workspaceId,
        state.formDef.id,
        submissionToken.current,
        payload,
      );

      await db.query(transaction.query, transaction.params);

      clearDraft(state.formDef.slug);
      // Reset token for next submission (not reused).
      submissionToken.current = crypto.randomUUID();
      uploadedFiles.current = [];

      dispatch({ type: 'submit-ok', at: new Date(), attachments: uploadedAttachmentNames });
    } catch (err) {
      // Clean up any files uploaded before the failed transaction.
      for (const uploaded of uploadedFiles.current) {
        await deleteOrphanedFile(db, uploaded.bucketPath);
      }
      uploadedFiles.current = [];

      const message = err instanceof Error ? err.message : String(err);
      const isDuplicate = message.includes('already exists') || message.includes('unique');
      dispatch({
        type: 'submit-err',
        error: isDuplicate
          ? 'Submission already received. Please contact the legal team if you need to update your information.'
          : 'Submission failed. Please try again.',
      });
    }
  }

  // ── Confirmation screen ────────────────────────────────────────────────────

  if (state.submittedAt && state.formDef) {
    const summaryFields = state.formDef.fields
      .filter((f) => f.type !== 'file')
      .slice(0, 4)
      .map((f) => {
        const v = state.values[f.key];
        return { label: f.label, value: Array.isArray(v) ? v.join(', ') : String(v ?? '') };
      })
      .filter(({ value }) => value);

    return (
      <ConfirmationPage
        formTitle={state.formDef.title}
        submittedAt={state.submittedAt}
        summaryFields={summaryFields}
        attachmentNames={state.submittedAttachments}
        onReset={() => {
          dispatch({ type: 'reset' });
          submissionToken.current = crypto.randomUUID();
        }}
      />
    );
  }

  // ── Loading / error states ─────────────────────────────────────────────────

  if (state.isLoadingForm) {
    return (
      <main className="intake-form-page">
        <p className="sidebar-copy">正在载入债权申报表单…</p>
      </main>
    );
  }

  if (state.loadError || !state.formDef) {
    return (
      <main className="intake-form-page">
        <p className="sidebar-copy" style={{ color: 'var(--color-error)' }}>
          {state.loadError ?? 'Form not found.'}
        </p>
        <button className="secondary-button" type="button" onClick={() => void loadForm()}>
          重试
        </button>
      </main>
    );
  }

  // ── Form ───────────────────────────────────────────────────────────────────

  return (
    <main className="intake-form-page" aria-label={state.formDef.title}>
      <div className="intake-form-page__card">
        <header className="intake-form-page__header">
          <p className="eyebrow">Public intake form</p>
          <h1 className="intake-form-page__title">{state.formDef.title}</h1>
          <p className="sidebar-copy">该表单会直接写入受控工作区，用于债权申报受理、补件和后续复核。</p>
        </header>

        <form className="intake-form" onSubmit={(e) => void handleSubmit(e)} noValidate>
          {state.formDef.fields.map((field) => (
            <FormFieldRenderer
              key={field.key}
              field={field}
              value={state.values[field.key] ?? null}
              error={state.fieldErrors[field.key] ?? ''}
              disabled={state.isSubmitting}
              onChange={(value) => {
                dispatch({ type: 'set-value', key: field.key, value });
                dispatch({ type: 'clear-field-error', key: field.key });
              }}
              onFileChange={(file) => void handleFileChange(field, file)}
            />
          ))}

          {state.submitError && (
            <p className="intake-form__error" role="alert">{state.submitError}</p>
          )}

          <button
            className="primary-button intake-form__submit"
            type="submit"
            disabled={state.isSubmitting}
          >
            {state.isSubmitting ? '提交中…' : '提交申报'}
          </button>
        </form>
      </div>
    </main>
  );
}

// ─── Field renderer ───────────────────────────────────────────────────────────

interface FieldRendererProps {
  field: FormField;
  value: FieldValue;
  error: string;
  disabled: boolean;
  onChange: (value: FieldValue) => void;
  onFileChange: (file: File | null) => void;
}

function FormFieldRenderer({ field, value, error, disabled, onChange, onFileChange }: FieldRendererProps) {
  const id = `field-${field.key}`;

  return (
    <div className="intake-field">
      <label className="intake-field__label" htmlFor={id}>
        {field.label}
        {field.required && <span className="intake-field__required" aria-label="required"> *</span>}
      </label>

      {field.type === 'text' && (
        <input
          id={id}
          className="intake-field__input"
          type="text"
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          aria-required={field.required}
          aria-invalid={!!error}
          aria-describedby={error ? `${id}-error` : undefined}
        />
      )}

      {field.type === 'number' && (
        <input
          id={id}
          className="intake-field__input"
          type="number"
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          aria-required={field.required}
          aria-invalid={!!error}
        />
      )}

      {field.type === 'date' && (
        <input
          id={id}
          className="intake-field__input"
          type="date"
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          aria-required={field.required}
          aria-invalid={!!error}
        />
      )}

      {field.type === 'single_select' && (
        <select
          id={id}
          className="intake-field__input"
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          aria-required={field.required}
          aria-invalid={!!error}
        >
          <option value="">Select…</option>
          {(field.options ?? []).map((opt) => (
            <option key={opt} value={opt}>{opt}</option>
          ))}
        </select>
      )}

      {field.type === 'multi_select' && (
        <select
          id={id}
          className="intake-field__input"
          multiple
          value={Array.isArray(value) ? value : []}
          onChange={(e) => {
            const selected = Array.from(e.target.selectedOptions, (o) => o.value);
            onChange(selected);
          }}
          disabled={disabled}
          aria-required={field.required}
          aria-invalid={!!error}
        >
          {(field.options ?? []).map((opt) => (
            <option key={opt} value={opt}>{opt}</option>
          ))}
        </select>
      )}

      {field.type === 'file' && (
        <input
          id={id}
          className="intake-field__input"
          type="file"
          onChange={(e) => onFileChange(e.target.files?.[0] ?? null)}
          disabled={disabled}
          aria-required={field.required}
          aria-invalid={!!error}
        />
      )}

      {error && (
        <p id={`${id}-error`} className="intake-field__error" role="alert">{error}</p>
      )}
    </div>
  );
}
