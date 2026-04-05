import { describe, expect, it } from 'vitest';

import { buildSubmissionTransaction } from './intake-form';

describe('buildSubmissionTransaction', () => {
  it('uses dynamic table creation syntax supported by SurrealQL', () => {
    const payload = {
      applicant_name: 'Acme Holdings',
      attachment: 'spreadsheet_files:/abc-report.pdf',
    };

    const result = buildSubmissionTransaction(
      'company',
      'workspace:legal',
      'form_definition:intake',
      'submission-1',
      payload,
    );

    expect(result.query).toContain('CREATE type::table($tableName) CONTENT $recordData');
    expect(result.params).toEqual({
      tableName: 'company',
      recordData: {
        workspace: 'workspace:legal',
        submission_token: 'submission-1',
        ...payload,
      },
      submissionData: {
        workspace: 'workspace:legal',
        form_definition: 'form_definition:intake',
        submission_token: 'submission-1',
        payload,
        unverified: false,
      },
    });
  });
});
