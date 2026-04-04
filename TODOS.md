# TODOS

## File upload disk-full error handling
- **Priority:** Medium
- **Status:** Not started
- **Why:** Silent failure on disk-full = lost client documents. Legal data integrity concern.
- **What:** Check available disk space before writing uploaded files. Return clear error to client if insufficient. Log the failure.
- **Where:** Form server file upload handler
- **Depends on:** Form server implementation (Week 2)

## GRAPH_TRAVERSE recalculation debouncing
- **Priority:** Medium
- **Status:** Not started
- **Why:** LIVE SELECT triggering 50+ simultaneous GRAPH_TRAVERSE recalculations could freeze UI and overload SurrealDB.
- **What:** Debounce formula recalculations. Batch all dirty GRAPH_TRAVERSE formulas, recalculate after 500ms quiet period. Prevents cascade of 150+ concurrent queries on a single entity update.
- **Where:** Univer custom formula reactivity layer
- **Depends on:** GRAPH_TRAVERSE + LIVE SELECT reactivity (Week 2)

## Chinese legal data residency compliance
- **Priority:** Low (pre-launch, not pre-MVP)
- **Status:** Not started
- **Why:** China's Data Security Law and PIPL may restrict where legal case data can be hosted and processed.
- **What:** Research: (1) Does legal case data fall under 'important data' classification? (2) Cross-border transfer restrictions? (3) China-hosted SurrealDB options?
- **Where:** Research task, not code
- **Depends on:** Target market decision (mainland China vs. HK/overseas)
