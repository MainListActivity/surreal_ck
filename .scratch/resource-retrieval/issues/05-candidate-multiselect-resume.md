Status: done
Label: done

# RR-005 — 候选多选与 workflow resume

## Parent

`.scratch/resource-retrieval/PRD.md`

## What to build

完成资源候选 suspend 的用户选择闭环。AI 抽屉展示中置信资源候选卡，支持多选，并提供“用选中资源回答”和“继续人工检索”两个动作。

用户选择资源后，workflow resume 只携带 resourceIds。workflow 回查资源主数据，生成带 `[1]` 引用和结构化 citations 的回答。用户选择继续人工检索时，workflow 进入人工检索 session 分支。

## Acceptance criteria

- [x] 资源候选卡支持多选，选择状态在 UI 中清晰可见。
- [x] “用选中资源回答”在至少选中一个资源后可用，并 resume workflow。
- [x] resume payload 只传 resourceIds，不传完整资源对象。
- [x] workflow resume 后从资源库回查资源并生成回答。
- [x] 回答保留 `[1]` 文本引用和结构化 citations。
- [x] “继续人工检索”不使用候选回答，而进入 manual research 分支。
- [x] 用户关闭候选卡时 workflow 可取消或保持明确状态，不产生隐式写入。
- [x] 测试覆盖候选多选状态、resume resourceIds、回查资源回答、继续人工检索分支和取消分支。

## Blocked by

- `.scratch/resource-retrieval/issues/04-resource-agent-readonly-citations.md`
