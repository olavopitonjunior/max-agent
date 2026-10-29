# Google Workspace — Max implementation

Objective: professional activity/availability reads and human-confirmed schedule, cancellation and Tasks synchronization using the authenticated user's existing scope-action gateway. No commit, push or deploy performed.

Decisions: `googleMaxEnabled` must be explicitly true in the authenticated agent profile; capabilities are appended after `prefs.self` and are not implicitly granted. Broker identities are denied even if granted those strings. The model cannot choose organization, user, calendar, credentials or model. Existing HMAC transport and vectors are unchanged.

`google-workspace.ts` supplies bounded tool definitions and deterministic proposal/confirmation transitions. `graph.ts` offers these through the existing answer stage and handles pending confirmation in `conduzir`, persisting state in the same graph checkpoints. Every remote operation uses `depsDoFluxo` → `executarAcao`; no alternate Google SDK exists. Reads show at most five projected professional activities or busy intervals, without private event details. Activity IDs and authoritative versions stay in a subject-bound, expiring numbered reference map. Other numbered lists invalidate that map.

Proposals pass only allowlisted fields. Returned preview must canonically match the submitted input. The opaque server proposal digest is preserved unchanged. Only a different, immediately following human turn containing exactly `SIM` can confirm; changed instructions, expiry, authorization revocation, blocked/media turns and identity changes discard consent. Confirmation consumes local pending state even after uncertain results. A consumed-server-proposal response explains that it was already queued and never generates another operation. Gmail sending remains in the interface.

Changed files: `src/graph/google-workspace.ts`, `graph.ts`, `policy.ts`; `src/lib/acao.ts`, `cm.ts`, `runtime/catalog.ts`; Google unit and graph tests; catalog parity fixtures in policy, activities and decisions tests; this report.

Verification: initial fail-first test command could not start because the new worktree had no dependencies (`vitest: command not found`); installed with `npm ci --ignore-scripts`. The capability parity tests then failed as expected until the protocol fixtures were updated. All 48 focused confirmation/graph/policy/HMAC tests and TypeScript check pass. Production build passes. A broad rerun excluding only the DATABASE_URL-dependent multimodal file passes: 123 files, 3,060 tests; 31 files/482 tests skipped by existing environment gates. The full suite run before final parity-fixture updates had 3,062 passing tests, 484 skipped and eight failures: two updated capability fixtures and six unrelated multimodal tests that require `DATABASE_URL`. No live Google account or remote receiver was used.

Limitations: dates must be supplied to tools as ISO values; availability queries are bounded to 31 days and five displayed busy intervals. No natural-language slot-selection algorithm or Gmail send tool. Receiver deployment must precede enabling the profile flag and capabilities; the receiver rechecks organization flag, connection ownership, RBAC, version, expiry and consumed status. New server flag is optional on old profiles and therefore stays off.


Review follow-up: Tasks proposals now require `expectedUpdatedAt` from the authoritative professional activity projection; missing snapshots are rejected locally and model-provided timestamps are ignored. The receiver compares this snapshot against the current activity. All operation confirmations require and display the receiver's current `summary.title`/`summary.dueAt`; Tasks display the activity update timestamp instead of a calendar-link version. Two regression tests first failed on the old behavior, then passed after the fix. Google unit/graph tests: twelve passing. With the affected legacy activity-graph and stage-option suites, 79 tests pass; TypeScript and production build pass. Additional review fixes canonicalize optional schedule defaults (America/Sao_Paulo, no participants, no Meet), keep Google read grants independent from legacy activity.list, and invalidate Google references whenever competing numbered menus or deterministic domain flows respond.


Final verification: 123 files / 3,066 tests passed, 482 skipped; production build and typecheck passed. Multimodal file tested separately on both clean HEAD snapshot and changed workspace: the same six DATABASE_URL failures, four passing and two skipped. Protocol documented in docs/google-workspace-contract.md and ContractMaker docs/max.md. Four additive activity kinds are available on both sides. No commit, push, PR or deployment. External OAuth/staging verification remains pending.

## Correção posterior — testes multimodais (29/10/2026)

A fixture antiga de identidade (`identified`) foi substituída pela variante tipada
`resolved`, incluindo a organização. Testes unitários iniciam dentro de um contexto
de execução validado e usam MemorySaver quando não há banco. Os dois testes de
integração continuam usando o bootstrap de privacidade e PostgresSaver reais.
O guard de produção permanece intacto; um teste adicional recusa dispatch fence
de outro telefone antes da identidade/download/transcrição.

Validação: suíte completa sem exclusão de arquivo, 124 arquivos / 3.077 testes
aprovados, 484 testes pulados pelos gates de ambiente. O arquivo multimodal foi
executado também em PostgreSQL local dedicado: 13/13 aprovados, nenhum pulado.
Typecheck e build passaram. As 29 migrations foram aplicadas somente ao banco
local vazio `max_google_media`, em 127.0.0.1:55479. Sem chamadas reais ao Google,
transcrição/LLM ou transporte WhatsApp; fronteiras externas estavam simuladas.
