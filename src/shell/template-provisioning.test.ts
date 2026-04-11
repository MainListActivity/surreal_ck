import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../schema/templates/legal-entity-tracker.surql?raw', () => ({
  default: 'SELECT "legal";',
}));

vi.mock('../../schema/templates/case-management.surql?raw', () => ({
  default: 'SELECT "case";',
}));

vi.mock('../../schema/templates/blank-workspace.surql?raw', () => ({
  default: 'SELECT "blank";',
}));

describe('template provisioning', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('returns workbook and workspace ids on success', async () => {
    const { provisionTemplate } = await import('./template-provisioning');
    const db = {
      query: vi.fn()
        .mockResolvedValueOnce([['workspace:harbor']])
        .mockResolvedValueOnce([['workbook:claims']])
        .mockResolvedValueOnce([[]]),
    };

    const result = await provisionTemplate(
      db as never,
      'legal-entity-tracker',
      'Harbor',
      'harbor',
      'app_user:owner',
    );

    expect(result).toEqual({
      ok: true,
      workspaceId: 'workspace:harbor',
      workbookId: 'workbook:claims',
    });
    expect(db.query).toHaveBeenCalledTimes(3);
  });

  it('runs compensating cleanup when the template script fails', async () => {
    const { provisionTemplate } = await import('./template-provisioning');
    const db = {
      query: vi.fn()
        .mockResolvedValueOnce([['workspace:harbor']])
        .mockResolvedValueOnce([['workbook:claims']])
        .mockRejectedValueOnce(new Error('template boom'))
        .mockResolvedValueOnce([[]]),
    };

    const result = await provisionTemplate(
      db as never,
      'blank-workspace',
      'Harbor',
      'harbor',
      'app_user:owner',
    );

    expect(result).toMatchObject({
      ok: false,
      step: 'template-script',
      message: 'template boom',
    });
    expect(db.query).toHaveBeenCalledTimes(5);
  });
});
