export interface ConfirmationProps {
  formTitle: string;
  submittedAt: Date;
  summaryFields: Array<{ label: string; value: string }>;
  attachmentNames: string[];
  onReset?: () => void;
}

/**
 * Full-page confirmation shown after a successful intake form submission.
 * Matches "Public Intake Submission Confirmation" Stitch screen.
 */
export function ConfirmationPage({
  formTitle,
  submittedAt,
  summaryFields,
  attachmentNames,
  onReset,
}: ConfirmationProps) {
  const formattedTime = submittedAt.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  return (
    <main className="confirmation-page" aria-label="Submission confirmed">
      <div className="confirmation-page__card">
        <div className="confirmation-page__icon" aria-hidden="true">✓</div>
        <p className="eyebrow">Submission received</p>
        <h1 className="confirmation-page__title">{formTitle}</h1>
        <p className="confirmation-page__timestamp">Submitted {formattedTime}</p>

        {summaryFields.length > 0 && (
          <dl className="detail-list confirmation-page__summary">
            {summaryFields.map(({ label, value }) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        )}

        {attachmentNames.length > 0 && (
          <div className="confirmation-page__attachments">
            <p className="eyebrow">Attachments</p>
            <ul className="sidebar-list sidebar-list--flush">
              {attachmentNames.map((name) => (
                <li key={name} className="mono-label">{name}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="confirmation-page__next">
          <p className="eyebrow">What happens next</p>
          <p className="sidebar-copy">
            Your submission has been received and will be reviewed by the legal team. You will be
            contacted at the email address you provided if additional information is needed.
          </p>
        </div>

        {onReset && (
          <button className="secondary-button" type="button" onClick={onReset}>
            Submit another
          </button>
        )}
      </div>
    </main>
  );
}
