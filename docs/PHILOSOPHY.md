# Development Philosophy

**How we build, test, and ship PoeClaw.**

> This document emerged from a structured debate between ten competing philosophical positions on test-driven development, type safety, and deployment guardrails — each arguing for a different approach to software quality in this codebase. The positions attacked each other's weaknesses and defended their own. What follows is the consensus that survived the debate. The original position papers are preserved in [`docs/philosophy/positions/`](./philosophy/positions/) for reference.

---

## The Core Insight: PoeClaw Is a Gateway

PoeClaw is not a computation engine. It is a **proxy, orchestrator, and boundary-crossing system**. Its value is entirely in the promises it makes at its interfaces: browser clients, the Poe API, the Cloudflare Sandbox container, R2 storage, and chat platform integrations.

This architectural fact determines everything about our quality strategy. The bugs that ship to production live at the seams between systems, not inside pure functions. Our testing and quality approach must reflect this.

---

## Layered Defense

Quality is not one thing. It is a stack of defenses, each catching different classes of defects at different costs. We invest in all layers, in order of cost-effectiveness:

```
Layer 0: CI Guardrails ........... cheapest, broadest, always on
Layer 1: Type System ............. compile-time structural safety
Layer 2: Unit Tests .............. pure logic verification
Layer 3: Property Tests .......... combinatorial & security invariants
Layer 4: Contract Tests .......... API boundary verification
Layer 5: Integration Tests ....... real dependency behavior
Layer 6: Deploy Safety ........... production health verification
```

Lower layers are prerequisites for higher layers. There is no value running integration tests against code that doesn't type-check. There is no value deploying code that fails contract tests.

---

## Layer 0: CI Guardrails

**Principle: Raise the floor before raising the ceiling.**

Static analysis prevents entire categories of defects at near-zero ongoing cost. The CI pipeline gates (lint → format → typecheck → test) are the most cost-effective quality investment we make.

### Rules

- **No code merges without green guardrails.** Lint, format, and typecheck gates are non-negotiable. No `--no-verify` bypasses.
- **Warnings are technical debt.** Every oxlint warning should be promoted to error or explicitly suppressed with a comment explaining why. The `warn` level is for evaluating new rules, not a permanent state.
- **Guardrails run first in CI.** Cheap checks gate expensive checks. The current pipeline order (lint → format → typecheck → test) must be preserved.
- **Security lint rules are errors.** Enable oxlint's `security` category at error severity for a codebase that handles JWT authentication, API credentials, and WebSocket proxying.

---

## Layer 1: Type System

**Principle: Types eliminate categories; tests eliminate instances.**

A single type annotation prevents a class of bugs across every call site. A single test prevents one bug in one scenario. For structural correctness, types win on cost-effectiveness.

### Rules

- **`typecheck` is the first CI gate.** Type errors indicate structural problems that make test results unreliable.
- **Minimize `as any` and `as unknown as`.** Each type assertion is an unverified assumption. Prefer runtime validation + type narrowing. When assertions are necessary, comment why.
- **Use exhaustive pattern matching.** For discriminated unions (process status, middleware response type), use `switch` + `never` default so the compiler flags unhandled cases.
- **Share types across boundaries.** Server response types and client API types should be imported from a shared module, not independently maintained duplicates.
- **Type-safe test utilities.** Mock factories should implement typed interfaces. No `as any` in test infrastructure — it defeats the purpose of the type system.

### Honest Limitation

Types have no runtime presence. They cannot validate that `ANTHROPIC_API_KEY` contains a valid key, only that it's `string | undefined`. Runtime validation is essential at system boundaries.

---

## Layer 2: Unit Tests

**Principle: Test the contract, not the implementation.**

Unit tests verify pure logic — functions whose correctness depends on their inputs, not on external system behavior. For orchestration and boundary-crossing code, unit tests with mocks provide fast feedback but limited confidence.

### What to Unit Test (Non-Negotiable)

| Category | Why | Examples |
|----------|-----|---------|
| Security boundaries | Failures are silent and critical | JWT verification, credential redaction |
| Data integrity invariants | Failures cause data loss | R2 sync direction, exclusion patterns |
| Complex discrimination logic | Non-obvious edge cases | Process matching (4 gateway patterns, 5 CLI patterns, 2 statuses) |
| Configuration building | Conditional precedence with many optional fields | `buildEnvVars` env var mapping |

### What NOT to Unit Test

| Category | Why |
|----------|-----|
| Route registration | Tests Hono's router, not your code. A 404 is immediately visible. |
| Static HTML/templates | String literal assertions test nothing. Visual bugs are caught visually. |
| One-line delegations | The type system validates the call. The test is a tautology. |
| Code slated for replacement | The design document marks it for rewrite. Don't test throwaway code. |

### Test Quality Over Quantity

- **Test files are colocated** with source files (`foo.ts` → `foo.test.ts`). This pattern is established; maintain it.
- **Each test protects one invariant.** If you can't name the invariant in the `describe` block, the test is probably testing implementation details.
- **Threat model comments.** When adding a test, include a one-line comment stating what failure mode it catches:
  ```typescript
  // Threat: CLI commands incorrectly matched as gateway process
  it('returns null when only CLI commands are running', ...)
  ```
- **No coverage targets.** Coverage percentages incentivize low-value tests. Instead, review *which* code is covered and ask: is the uncovered code high-severity and low-detectability?

---

## Layer 3: Property Tests

**Principle: Invariants over examples.**

For functions with combinatorial input spaces or security-critical algebraic properties, property-based tests (fast-check) are strictly superior to hand-written examples. They explore the full input space and find edge cases humans systematically miss.

### When to Use Properties

- **Combinatorial configuration:** `buildEnvVars` has 20+ optional fields. Properties verify precedence invariants across all 2^20 combinations. Examples cover O(n) cases.
- **Security-critical code:** `timingSafeEqual` must be reflexive, symmetric, and agree with strict equality. Properties encode these universally.
- **Classification logic:** `findExistingMoltbotProcess` classifies command strings. Properties verify that CLI commands are never misclassified as gateway processes for all strings, not just the ones someone thought to try.
- **Failure isolation:** `syncToR2` has fatal vs. non-fatal failure semantics. Properties verify the 2^n failure matrix implicitly.

### When NOT to Use Properties

- Simple CRUD or data transformation where examples are clearer
- Integration-level behavior that requires real system interaction
- UI components

### Rules

- Properties complement examples, never replace them. Every property test file should include at least one example test as documentation.
- Invest in generators as reusable project assets (`src/test-generators.ts`).
- Start with the three highest-value targets: `buildEnvVars`, `findExistingMoltbotProcess`, and any timing-safe comparison functions. Expand reactively when bugs surface that properties would have caught.

---

## Layer 4: Contract Tests

**Principle: The interfaces ARE the product.**

PoeClaw is a gateway. Its correctness is determined by whether it honors the promises it makes at its boundaries. Contract tests verify those promises explicitly.

### Boundaries That Need Contracts

1. **Authentication** — login, session cookies, logout
2. **Gateway status** — health checks, process state
3. **Chat completions proxy** — streaming, error handling
4. **Device management** — pairing, approval
5. **Storage/sync** — R2 backup status, manual sync
6. **WebSocket proxy** — message relay, error transformation, close propagation

### Rules

- **Define before implement.** Write the contract test first. The implementation is done when the contract passes.
- **Contracts are versioned promises.** Changing a response shape requires updating the contract explicitly. The diff is reviewable.
- **Use Hono's test client.** No external HTTP servers or Pact brokers needed. `app.request()` exercises the real route handlers.
- **No contracts for internal interfaces.** Contracts are for external boundaries where a different system is on the other side.

---

## Layer 5: Integration Tests

**Principle: The bugs that matter live at the seams.**

For a proxy architecture, the traditional test pyramid is inverted. Most logic IS boundary crossing. Integration tests that exercise real dependencies catch the bugs that unit tests structurally cannot.

### The Mock Problem (Honestly Stated)

The AGENTS.md documents four behavioral quirks of the Cloudflare Sandbox API that were all discovered in production, not in tests:

1. `proc.status` doesn't update immediately after process completion
2. s3fs doesn't support setting timestamps (caused rsync failures)
3. Mount state detection requires `mount | grep`, not error message parsing
4. `waitForPort` race conditions require 3-minute timeouts

Our mocks return instant success with perfect behavior. The real system has opinions. Every mock is a bet that the real system works as you imagine — and in this codebase, that bet has been wrong at least four documented times.

### Rules

- **Every system boundary gets at least one integration test** that exercises the real protocol. No mocks at the boundary.
- **Prefer record-replay over hand-written mocks.** Captured real `ExecResult` output carries actual stdout format, actual timing characteristics, and actual error messages.
- **Pure logic needs no mocks.** `buildEnvVars`, config validation, string parsing — test these with real data structures, not mocked services.
- **Integration tests are first-class CI citizens.** They run on every PR, not as a nightly job.
- **Flaky tests get investigated, not deleted.** A flaky integration test is detecting a real timing-dependent behavior.

---

## Layer 6: Deploy Safety

**Principle: If you can't ship with confidence, your tests are wrong.**

Testing exists to enable safe deployment. A test suite that passes but leaves you afraid to deploy has failed at its actual job.

### The Deployment Reality

`npm run deploy` = `wrangler deploy` = instant 100% production rollout. No staging. No canary. No automated rollback. The blast radius is every connected client across every channel (HTTP, Telegram, Discord, Slack, CDP).

### Rules

- **Every deploy is verified.** Post-deploy smoke tests against the production health endpoint are not optional.
- **Health checks are test artifacts.** A `/healthz` endpoint that verifies worker response, sandbox availability, and R2 accessibility is maintained with the same rigor as unit tests.
- **Deploy events are observable.** Every deploy is logged, timestamped, and correlated with the git commit.
- **Rollback is practiced.** The team knows how to execute `wrangler rollback` and has verified it works.

---

## The Decision Framework

Before writing a test, answer two questions:

1. **If this code breaks, how bad is it?** (Critical / High / Medium / Low)
2. **If this code breaks, how quickly will someone notice?** (Seconds / Hours / Days)

| | Noticed in seconds | Noticed in hours+ |
|---|---|---|
| **Critical severity** | Contract test | Unit test + property test + integration test |
| **High severity** | Contract test | Unit test + integration test |
| **Medium severity** | No test needed | Unit test |
| **Low severity** | No test needed | No test needed |

Security-critical code (auth, credentials, secrets) is always "Critical severity, noticed in hours+" — it gets the full treatment regardless of detectability estimates, because the consequences of being wrong are catastrophic.

---

## What We Believe (Consensus)

These principles survived the debate:

1. **Quality is a stack, not a choice.** Types, tests, properties, contracts, integration tests, and deploy safety are complementary layers. No single approach is sufficient.

2. **Test behavior, not implementation.** Tests should verify *what* code promises, not *how* it works internally. Implementation changes should not break tests unless behavior changes.

3. **The type system is the first line of defense.** It's the cheapest, broadest quality tool we have. Invest in precise types. Don't bypass them with `as any`.

4. **Mocks are necessary lies.** Use them for fast feedback on pure logic. Don't trust them for boundary behavior. Verify mock assumptions with periodic integration tests.

5. **Security code gets the full treatment.** JWT verification, credential handling, secret comparison, and auth middleware deserve unit tests, property tests, integration tests, AND mutation testing verification. No shortcuts.

6. **Pragmatism is not laziness.** Not testing route registration is engineering judgment. Not testing JWT verification is negligence. Know the difference.

7. **The deployment boundary is part of the testing story.** "Tests pass" and "production is healthy" are different claims. Bridge the gap with health checks and post-deploy verification.

8. **Testing effort follows a power law.** A small number of well-chosen tests catch a disproportionate share of real bugs. Invest testing effort where severity is high and detectability is low.

---

## Further Reading

The ten position papers that produced this consensus are preserved for reference. Each contains detailed analysis of specific code patterns, concrete examples, and honest assessments of its own weaknesses:

| Position | Paper | Key Insight |
|----------|-------|-------------|
| Strict TDD | [`01-strict-tdd.md`](./philosophy/positions/01-strict-tdd.md) | TDD's design pressure drives extraction of shared logic (e.g., CDP auth duplication) |
| Type System First | [`02-type-system.md`](./philosophy/positions/02-type-system.md) | `as unknown as` casts and duplicated client/server types reveal under-investment in types |
| Integration First | [`03-integration-first.md`](./philosophy/positions/03-integration-first.md) | For a proxy architecture, the traditional test pyramid should be inverted |
| Pragmatic Minimalist | [`04-pragmatic-minimalist.md`](./philosophy/positions/04-pragmatic-minimalist.md) | The Severity x Detectability matrix determines what's worth testing |
| Property-Based Testing | [`05-property-based.md`](./philosophy/positions/05-property-based.md) | `buildEnvVars` has 2^20 input combinations; properties test them all implicitly |
| Mutation Testing | [`06-mutation-testing.md`](./philosophy/positions/06-mutation-testing.md) | The `\|\|` to `&&` mutation in R2 credential validation survives the current test suite |
| Contract/API-First | [`07-contract-first.md`](./philosophy/positions/07-contract-first.md) | Gateway interfaces ARE the product; contracts test what users care about |
| Deployment Safety | [`08-deploy-safety.md`](./philosophy/positions/08-deploy-safety.md) | `wrangler deploy` is instant 100% rollout with no automated rollback |
| Anti-Mock Realism | [`09-anti-mock.md`](./philosophy/positions/09-anti-mock.md) | Four documented sandbox API quirks were all discovered in production, not tests |
| CI Guardrails | [`10-guardrails.md`](./philosophy/positions/10-guardrails.md) | Guardrails are O(1) to add; tests are O(n). The cost curves are fundamentally different |
