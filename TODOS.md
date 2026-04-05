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

## Off-site backup
- **Priority:** P2 (pre-launch, not pre-MVP)
- **Status:** Not started
- **Why:** Local-only backups are a single point of failure. Disk failure = database AND backups lost. Legal data integrity concern.
- **What:** Add rsync/rclone step to backup.sh that copies nightly export to S3 or a second host. Verify restore from off-site copy.
- **Where:** backup.sh, Docker Compose (optional sidecar for S3 sync)
- **Depends on:** Cloud storage decision (S3 vs. self-hosted second disk)

## Server-side CAPTCHA verification
- **Priority:** P2 (pre-launch)
- **Status:** Not started
- **Why:** Client-side-only Turnstile verification is bypassable. Attacker can skip JS and submit directly to SurrealDB WebSocket API.
- **What:** Add server-side Turnstile token verification. Options: (a) Cloudflare Worker as reverse proxy, (b) SurrealDB custom function with outbound HTTP (if supported), (c) nginx Lua module.
- **Where:** Reverse proxy layer or SurrealDB function
- **Depends on:** SurrealDB outbound HTTP capability research

## Form rate limiting
- **Priority:** P2 (pre-launch)
- **Status:** Not started
- **Why:** Without rate limiting, a bot can spam form submissions filling the database and degrading performance for all users.
- **What:** Add rate limiting at the reverse proxy level (nginx `limit_req_zone` or Cloudflare WAF rules). Target: 10 submissions per IP per minute.
- **Where:** nginx config or Cloudflare dashboard
- **Depends on:** Reverse proxy / Cloudflare setup

## Audit trail UI
- **Priority:** P3 (post-MVP)
- **Status:** Not started
- **Why:** Legal work requires provenance. "Who changed this number and when?" is a common question. Mutations table already has the data.
- **What:** Build a "History" panel in the spreadsheet UI. Select a cell/row → see all mutations affecting it, with timestamps and user names. Scrollable, filterable by date range.
- **Where:** Univer sidebar panel, queries mutations table
- **Depends on:** Mutations table structure (already defined)
