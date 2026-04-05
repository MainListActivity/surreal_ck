# Collaboration Spike

This spike is the Week 0 decision gate for collaborative editing. It exists to validate the proposed mutation replay architecture before the main workbook implementation depends on it.

## Files

- `spike/collab-test.html`
- `spike/collab-test.ts`

## What To Validate

1. `univerAPI.addEvent(univerAPI.Event.CommandExecuted, callback)` emits all workbook mutations needed for MVP collaboration.
2. `executeCommand(commandId, params, { fromCollab: true })` in open-source Univer suppresses re-broadcast and does not create an infinite loop.
3. Formatting or other `syncOnly` mutations are observable through `CommandExecuted`; if not, test `onMutationExecutedForCollab` as the supplemental event source.
4. Unknown command IDs can be skipped safely and logged without breaking the replay stream.

## Manual Test Matrix

| Scenario | Expected result | Status |
|---|---|---|
| Tab A edits a string cell | Tab B updates in under 1 second | Pending |
| Tab A edits a number cell | Tab B preserves the numeric value and type | Pending |
| Tab A applies bold formatting | Tab B replays formatting | Pending |
| Tab A enters `=SUM(A1:A5)` | Tab B recalculates the formula | Pending |
| Tab A inserts or deletes a row | Tab B matches row structure | Pending |
| Tab A replays a mutation received from Tab B | Tab A does not re-broadcast the replay | Pending |
| Unknown command ID is inserted manually | Receiver skips it and logs the event | Pending |
| 50-cell paste | Receiver applies the full grouped change set | Pending |

## Decision Gate

- If more than three core commands fail replay, move collaborative sync to snapshot-first fallback for MVP.
- If `fromCollab: true` is ignored, add a client-side sender guard keyed by `client_id`.
- If formatting is invisible to `CommandExecuted`, subscribe to `onMutationExecutedForCollab` in addition to the command event stream.

## Current Findings

- Scaffolding for the harness is in place.
- Runtime verification against actual Univer instances is still pending.
- The main app should not ship collaborative replay until the table above is executed and captured here.
