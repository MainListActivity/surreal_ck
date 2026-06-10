/**
 * RR-012 人工检索 panel 的纯逻辑状态机（UI 框架无关，单测覆盖）。
 *
 * 一个 panel 会话对应一个 research_session：展示 query / resourceType、
 * 维护手动粘贴的证据篮与资源草稿、驱动 SSE 保存动作的进度状态，
 * 保存失败时完整保留草稿与证据（V1 没有重试队列，用户改完再点保存）。
 * 同一会话可保存多个资源；完成检索 = finishAction（置 completed + resume workflow）。
 */
import {
  validateResearchSaveRequest,
  type ResearchSaveEvent,
  type ResearchSaveStage,
  type ResourceEvidenceDTO,
} from "@surreal-ck/shared";

export type ResearchPanelContext = {
  sessionId: string;
  /** 来自 manual-research suspend 的 run；proactive 检索时为空，完成后不 resume。 */
  runId?: string;
  query: string;
  resourceType: string;
};

export type EvidenceInput = {
  text: string;
  sourceUrl?: string;
  sourceTitle?: string;
};

export type ResearchDraftFields = {
  resourceType: string;
  title: string;
  summary: string;
  sourceUrl: string;
  sourceTitle: string;
  tags: string[];
};

export type ResearchSaveProgress = "idle" | ResearchSaveStage;

export type ResearchPanelState = {
  context: ResearchPanelContext;
  evidence: ResourceEvidenceDTO[];
  draft: ResearchDraftFields;
  saveProgress: ResearchSaveProgress;
  saveError: { stage: ResearchSaveStage | "transport"; message: string } | null;
  savedResourceIds: string[];
  canSave: boolean;
  canFinish: boolean;
  finishing: boolean;
  finished: boolean;
  finishError: string | null;
};

export type ResearchPanelOptions = {
  context: ResearchPanelContext;
  /** SSE 保存动作（research-save-client.save）。 */
  saveAction: (request: unknown, onEvent: (event: ResearchSaveEvent) => void) => Promise<void>;
  /** 完成检索：浏览器直连置 research_session completed，并（有 runId 时）resume workflow。 */
  finishAction?: (input: { sessionId: string; runId?: string; resourceIds: string[] }) => Promise<void>;
  now?: () => string;
  onChange?: (state: ResearchPanelState) => void;
};

export type ResearchPanelSession = {
  snapshot(): ResearchPanelState;
  addEvidence(input: EvidenceInput): void;
  removeEvidence(order: number): void;
  updateDraft(patch: Partial<ResearchDraftFields>): void;
  save(): Promise<void>;
  finish(): Promise<void>;
};

function emptyDraft(resourceType: string): ResearchDraftFields {
  return { resourceType, title: "", summary: "", sourceUrl: "", sourceTitle: "", tags: [] };
}

export function createResearchPanelSession(options: ResearchPanelOptions): ResearchPanelSession {
  const now = options.now ?? (() => new Date().toISOString());

  let evidence: ResourceEvidenceDTO[] = [];
  let draft = emptyDraft(options.context.resourceType);
  let saveProgress: ResearchSaveProgress = "idle";
  let saveError: ResearchPanelState["saveError"] = null;
  let savedResourceIds: string[] = [];
  let finishing = false;
  let finished = false;
  let finishError: string | null = null;

  function snapshot(): ResearchPanelState {
    return {
      context: { ...options.context },
      evidence: evidence.map((item) => ({ ...item })),
      draft: { ...draft, tags: [...draft.tags] },
      saveProgress,
      saveError: saveError ? { ...saveError } : null,
      savedResourceIds: [...savedResourceIds],
      canSave: saveProgress === "idle" && !finishing && !finished && evidence.length > 0,
      canFinish: saveProgress === "idle" && !finishing && !finished && savedResourceIds.length > 0,
      finishing,
      finished,
      finishError,
    };
  }

  function emit(): void {
    options.onChange?.(snapshot());
  }

  function buildRequest(): unknown {
    return {
      sessionId: options.context.sessionId,
      draft: {
        resourceType: draft.resourceType,
        title: draft.title,
        summary: draft.summary,
        sourceUrl: draft.sourceUrl.trim() || undefined,
        sourceTitle: draft.sourceTitle.trim() || undefined,
        evidence,
        tags: draft.tags,
      },
    };
  }

  return {
    snapshot,

    addEvidence(input) {
      const text = input.text.trim();
      if (!text) return;
      evidence = [
        ...evidence,
        {
          text,
          sourceUrl: input.sourceUrl?.trim() || undefined,
          sourceTitle: input.sourceTitle?.trim() || undefined,
          capturedAt: now(),
          order: evidence.length,
        },
      ];
      emit();
    },

    removeEvidence(order) {
      evidence = evidence
        .filter((item) => item.order !== order)
        .map((item, index) => ({ ...item, order: index }));
      emit();
    },

    updateDraft(patch) {
      draft = { ...draft, ...patch, tags: patch.tags ? [...patch.tags] : draft.tags };
      emit();
    },

    async save() {
      if (saveProgress !== "idle" || finishing || finished) return;

      const request = buildRequest();
      const validation = validateResearchSaveRequest(request);
      if (!validation.ok) {
        const detail = validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
        saveError = { stage: "validating", message: detail };
        emit();
        return;
      }

      saveError = null;
      saveProgress = "validating";
      emit();

      let failed = false;
      try {
        await options.saveAction(request, (event) => {
          if (event.kind === "error") {
            failed = true;
            saveError = { stage: event.stage, message: event.message };
            emit();
            return;
          }
          if (event.kind === "done") {
            savedResourceIds = [...savedResourceIds, event.resourceId];
            // 本资源已落库：清空草稿与证据篮，准备同一会话的下一个资源
            evidence = [];
            draft = emptyDraft(options.context.resourceType);
            emit();
            return;
          }
          if (event.kind === "validating" || event.kind === "embedding" || event.kind === "persisting") {
            saveProgress = event.kind === "embedding" ? "embedding" : event.kind;
            emit();
            return;
          }
          if (event.kind === "session-updated") {
            saveProgress = "session-updated";
            emit();
          }
        });
      } catch (error) {
        failed = true;
        saveError = {
          stage: "transport",
          message: error instanceof Error ? error.message : String(error),
        };
      }

      // 失败时草稿与证据原样保留（failed 分支没有清空动作），可直接再次点保存
      void failed;
      saveProgress = "idle";
      emit();
    },

    async finish() {
      if (finishing || finished || saveProgress !== "idle" || savedResourceIds.length === 0) return;
      if (!options.finishAction) return;

      finishing = true;
      finishError = null;
      emit();
      try {
        await options.finishAction({
          sessionId: options.context.sessionId,
          runId: options.context.runId,
          resourceIds: [...savedResourceIds],
        });
        finished = true;
      } catch (error) {
        finishError = error instanceof Error ? error.message : String(error);
      }
      finishing = false;
      emit();
    },
  };
}
