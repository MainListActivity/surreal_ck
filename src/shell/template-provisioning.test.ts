import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../schema/templates/legal-entity-tracker.surql', () => ({
  default: 'SELECT "legal";',
}));

vi.mock('../../schema/templates/case-management.surql', () => ({
  default: 'SELECT "case";',
}));

vi.mock('../../schema/templates/blank-workspace.surql', () => ({
  default: 'SELECT "blank";',
}));

describe('template provisioning', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('returns workbook and workspace ids on success', async () => {
    const { provisionTemplate } = await import('./template-provisioning');
    const db = {
      create: vi.fn().mockResolvedValue({ id: 'workbook:claims', workspace: 'workspace:harbor' }),
      query: vi.fn().mockResolvedValueOnce([[]]),
      delete: vi.fn(),
      merge: vi.fn(),
      upsert: vi.fn(),
      subscribe: vi.fn(),
    };

    const result = await provisionTemplate(
      db as never,
      'legal-entity-tracker',
      'workspace:harbor',
      '债权申报总表',
    );

    expect(result).toEqual({
      ok: true,
      workspaceId: 'workspace:harbor',
      workbookId: 'workbook:claims',
    });
    expect(db.create).toHaveBeenCalledWith('workbook', {
      workspace: 'workspace:harbor',
      name: '债权申报总表',
      template_key: 'legal-entity-tracker',
    });
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it('runs compensating cleanup when the template script fails', async () => {
    const { provisionTemplate } = await import('./template-provisioning');
    const db = {
      create: vi.fn().mockResolvedValueOnce({ id: 'workbook:claims', workspace: 'workspace:harbor' }),
      query: vi.fn()
        .mockRejectedValueOnce(new Error('template boom'))
        .mockResolvedValueOnce([{ id: 'sheet:s1', workbook: 'workbook:claims' }])
        .mockResolvedValueOnce([{ id: 'form:f1', workspace: 'workspace:harbor', target_sheet: 'sheet:s1' }]),
      delete: vi.fn().mockResolvedValue(undefined),
      merge: vi.fn(),
      upsert: vi.fn(),
      subscribe: vi.fn(),
    };

    const result = await provisionTemplate(
      db as never,
      'blank-workspace',
      'workspace:harbor',
      '空白工作簿',
    );

    expect(result).toMatchObject({
      ok: false,
      step: 'template-script',
      message: 'template boom',
    });
    expect(db.delete).toHaveBeenCalledTimes(3);
  });
});
