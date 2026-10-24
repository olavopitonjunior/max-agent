# Max production release — 2026-10-21

Objective: publish the implemented Max with per-organization activation, preserve current notifications, validate WhatsApp/playground/marketing/handoff, and observe the Fincassa pilot for at least24h. No GitHub Actions. User goal authorizes production after staging validation. User selected Fincassa (canonical Max org Fincasa cms7xmtks001gf13av1wf98tb). Existing staging connection and Neon isolation verified; internal test recipient remains unprovided.

## Task 1: Explicit tenant rollout

Add a fail-closed server configuration mapping canonical org IDs to runtime, queries, handoff and marketing, under the existing environment switches. Enforce it at routing and adapter boundaries, durable execution and handoff admission. Preserve existing notifications and existing conversation behavior outside the pilot. Preserve recovery/readback of accepted work when disabling a feature. Catalog/runtime report selected-org effective state; missing org never means globally enabled. Tests first: nonpilot denied, pilot allowed only with flag+policy, invalid/missing configuration closed, direct adapters cannot bypass, disabling cancels pending approvals, human handback remains possible, notifications continue.

## Task 2: Admin and playground fidelity

Inspect current ImobPro staging source and extend org-scoped catalog/rollout display where needed. Keep HMAC contracts coordinated. Validate selected org state and backend compatibility. Complete review, local full checks and Vercel builds without Actions.

## Task 3: Stage backend and end-to-end validation

Resolve existing authorized staging access. Prove DB/integration isolation, backup+restore and normal ledger migrations022–026. Deploy Max staging and enable isolated playground. Validate two tenants/subjects, current flows, queries, handoff, quotas/idempotency and actual configured marketing including video with authorized fixtures. Record real model/product evidence without inventing human scores.

## Task 4: Production promotion and pilot

Establish canonical Fincassa org and authorized internal WhatsApp recipient. Capture baseline notifications and environment/version evidence. Apply verified migrations before code, promote the coordinated release, activate Fincassa gradually. Monitor for>=24h from actual activation, preserve reconcilers, react to regressions with category-level disable or tested compatible rollback. No approval repetition for already-authorized production scope; request only missing decisions/access.

## Task 5: Completion audit

Record hashes, configuration, migration/restore evidence, deterministic/real-provider/product checks, pilot observation series and unresolved limitations. Audit each numbered goal requirement against current authoritative state; mark complete only if all true.

## Review focus

Global switches must not activate nonpilot orgs. All tool entry points and recovered pending approvals must enforce rollout without bypass. Feature disable must not strand handoff or accepted provider jobs. Proactive notifications must not depend on rollout config; code/schema transition and rollback must preserve dedupe and delivery state. Catalog must distinguish installed/configured/enabled and require a selected org for effective availability. Do not confuse24h elapsed with24h observed.
