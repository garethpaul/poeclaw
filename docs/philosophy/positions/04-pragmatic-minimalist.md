# Position 04: The Pragmatic Testing Minimalist

**Author:** Pragmatist
**Position:** Test only what matters. Invest testing effort where the risk-reward ratio justifies it.

---

## Core Thesis

Testing is an economic activity, not a moral one. Every test written carries an ongoing maintenance cost that must be weighed against the bugs it will actually catch. In an experimental, rapidly-iterating project like PoeClaw — where entire subsystems may be rewritten or discarded within weeks — the correct testing strategy is surgical precision: test the invariants that protect users and data, skip the glue code that the type system already validates, and never confuse test count with test value.

---

## Key Arguments

### 1. This Project's Lifecycle Demands Testing Discipline, Not Testing Volume

PoeClaw is explicitly labeled "experimental" and "proof of concept." The design document (`docs/plans/2026-02-15-poeclaw-design.md`) lists five implementation phases, and the current codebase sits at roughly Phase 0.5 — a single-tenant sandbox wrapper. Phases 1 through 4 will introduce session-based auth (replacing the current CF Access JWT flow), Poe provider integration, per-user R2 persistence, and an entirely new chat frontend. Each of these phases will rewrite or discard existing code.

Writing exhaustive tests for code with a half-life of weeks is not engineering discipline — it is waste. The Lean Software Development principle of "decide as late as possible" applies to test investment as much as to architectural decisions. Testing the current `extractJWT` cookie-parsing logic (`src/auth/middleware.ts:32-41`) down to every edge case is futile when the design document explicitly calls for replacing it with a session-cookie system.

**What to do instead:** Test the *invariants* that will survive the rewrites. The invariant "unauthenticated requests must be rejected" will persist regardless of whether auth uses JWTs or sessions. The invariant "R2 sync must not silently lose data" will persist regardless of whether it's single-tenant or multi-tenant. Test the contract, not the implementation.

### 2. The Existing Test Suite Already Demonstrates Optimal ROI Testing

The current 7 test suites (~900 lines) are a case study in pragmatic testing done well. Consider what they cover:

- **`jwt.test.ts`**: Signature validation, expiry, audience/issuer checks. These are *security invariants* — a failure here means unauthorized access. High-severity, hard to catch by inspection. Correct to test.
- **`process.test.ts`**: Gateway vs. CLI command discrimination (`src/gateway/process.ts:19-31`). This is subtle string-matching logic with legacy compatibility requirements across four command patterns. A regression here means the worker kills the gateway or fails to find it. Correct to test.
- **`sync.test.ts`**: R2 persistence correctness — the difference between `rclone sync` (propagates deletions) and `rclone copy` (doesn't) is a data-loss bug. The exclusion patterns (`.git`, `.lock`, `.log`, `.tmp`) protect against syncing transient files. Correct to test.
- **`logging.test.ts`**: Sensitive parameter redaction. A failure means leaking tokens/passwords to logs. Correct to test.

Now consider what they *don't* test:

- `src/routes/public.ts` (70 lines): Health checks and asset serving. If these break, you'll know in seconds — the page won't load.
- `src/routes/admin-ui.ts` (19 lines): A one-line route delegation. The type system guarantees this compiles correctly. Testing it tests Hono's router, not your code.
- `src/assets/`: Static HTML templates. Testing markup structure is testing string literals.
- `src/index.ts` WebSocket relay logic (lines 282-429): Complex, but it's orchestration glue between the Sandbox SDK and the WebSocket API. The failure mode is visible immediately (the connection drops), and the logic is hard to unit-test without mocking away the parts that matter.

This selective approach is not laziness. It is the recognition that testing effort follows a power law: a small number of well-chosen tests catch a disproportionate share of real bugs.

### 3. Over-Testing Creates Concrete Costs That Under-Testing Advocates Ignore

Every test has three costs beyond the initial writing:

1. **Maintenance cost**: When the implementation changes, tests must be updated. The `sync.test.ts` suite has 7 sequential mock resolutions per test case (`execMock.mockResolvedValueOnce(...)` chained 7 times). If the sync implementation adds a step — say, a pre-sync integrity check — every test case breaks. This is not hypothetical; the codebase has already undergone a `clawdbot → openclaw` rename and an `s3fs/rsync → rclone` migration (git log: `95307a3`).
2. **False confidence cost**: A green test suite creates psychological permission to deploy. But if those tests are testing mocked interactions rather than real behaviors, the confidence is misplaced. The `sync.test.ts` tests verify that the correct rclone CLI strings are constructed — they do *not* verify that rclone actually syncs data correctly. That's an integration concern that unit tests fundamentally cannot address.
3. **Velocity cost**: In a project where the design document has 5 open questions ("Does `api.poe.com/v1/models` return a stable user/account ID?", "Can OpenClaw run in 1 GiB RAM?"), the scarce resource is iteration speed, not test coverage percentage. Every hour spent writing tests for code that may be deleted next week is an hour not spent answering those existential questions.

### 4. The Risk Profile of This Codebase Is Highly Non-Uniform

Not all code in PoeClaw carries equal risk. A testing strategy must respect this asymmetry:

| Component | Severity if Broken | Detectability | Test Value |
|-----------|-------------------|---------------|------------|
| JWT verification | **Critical** — unauthorized access | Low (silent) | **High** |
| Process discrimination | **High** — kills gateway or starts duplicates | Medium (logs) | **High** |
| R2 sync correctness | **High** — data loss | Low (silent until next restore) | **High** |
| Credential redaction | **High** — secret leakage | Low (requires log review) | **High** |
| Env var building | Medium — wrong AI provider config | High (immediate error) | Medium |
| WebSocket relay | Medium — connection drops | High (user sees immediately) | Low |
| Route registration | Low — 404s | High (immediate) | **None** |
| HTML templates | Low — visual glitch | High (immediate) | **None** |
| Admin UI (React) | Low — cosmetic | High (immediate) | **None** |

The correct strategy is to concentrate testing effort in the upper-left quadrant: high severity, low detectability. These are the bugs that slip through manual testing and cause real harm. Everything in the lower-right quadrant — low severity, high detectability — will be caught by the first person who opens the page.

### 5. The 80/20 Rule Is Empirically Supported

The Pareto principle in software defects is well-documented. Studies from Microsoft Research (Nagappan et al., 2005) and IBM (Fenton & Ohlsson, 2000) consistently show that a small fraction of modules contain most defects. In PoeClaw:

- The `src/gateway/` directory (4 files, ~330 lines) handles process lifecycle, R2 persistence, and environment configuration — the three areas where silent failures cause real damage.
- The `src/auth/` directory (2 files, ~190 lines) handles the security boundary.
- Together, these ~520 lines represent about 8.5% of the production codebase but contain nearly all the high-severity bug surface.

The existing ~900 lines of tests are almost entirely focused on these two directories. That's the 80/20 rule in action: 8.5% of the code gets nearly 100% of the testing attention.

---

## Counterarguments and Rebuttals

### Against the TDD Purist: "You're just being lazy"

**Their claim:** Every function should be test-driven. Writing tests first ensures design quality and prevents regression. Skipping tests is a slippery slope to technical debt.

**Rebuttal:** The TDD purist conflates the *discipline* of TDD (think before coding) with the *artifact* of TDD (a comprehensive test suite). I advocate for the discipline — careful design, consideration of edge cases, defensive coding — without insisting that every moment of thought be serialized into a `.test.ts` file.

Consider `src/routes/admin-ui.ts` (19 lines). The TDD approach would have me write a test asserting that `GET /admin` returns an HTML response. But the entire file is:

```typescript
app.route('/admin', adminUIRoutes);
```

What am I testing? That Hono's router works? That's Hono's test suite's job. The TDD purist would counter that this test catches regressions if someone changes the route. But a route change is a *deliberate* act, not an accidental regression — and the test would need to be updated to match, adding cost with zero bug-catching value.

Laziness is writing no tests for JWT verification. Discipline is recognizing that some code doesn't warrant tests and investing that time where it matters.

### Against the Type Advocate: "Types + tests = belt and suspenders"

**Their claim:** TypeScript catches type errors at compile time, but runtime behavior can still diverge. You need both static types and dynamic tests for full confidence.

**Rebuttal:** I agree with the premise but dispute the conclusion. Types and tests are not additive — they are *substitutive* in many cases. When TypeScript's strict mode guarantees that `buildEnvVars(env: MoltbotEnv)` receives a `MoltbotEnv` object, I don't need a test asserting that it throws on `null` input. The compiler already makes that impossible at the call site.

Where types and tests are genuinely complementary is at *system boundaries*: the JWT that arrives as an opaque string, the rclone stdout that's parsed as text, the process list that comes from the Sandbox SDK. These boundaries are where runtime behavior diverges from type assumptions, and these are exactly where the current test suite focuses.

The belt-and-suspenders metaphor proves my point. You wear a belt *or* suspenders — wearing both is redundancy, not safety. The question is which tool is better suited to each risk. For structural correctness (does this function accept the right types?), use the type system. For behavioral correctness (does this JWT verification reject expired tokens?), use tests. Don't use both for the same risk.

### Against the Integration Tester: "You still need system-level verification"

**Their claim:** Unit tests with mocks don't prove the system works end-to-end. You need integration tests that verify real Sandbox interactions, real R2 syncs, and real WebSocket connections.

**Rebuttal:** I don't disagree — I agree that integration tests are valuable. My position is about *where the line is*, not whether integration tests exist. The project already has an `test/e2e/` directory with Terraform fixtures and browser automation for precisely this purpose.

But the integration tester's argument actually *strengthens* my position against over-unit-testing. If the ultimate proof that `syncToR2` works is an integration test that actually syncs to R2, then the unit test that verifies the rclone command string is constructed correctly is a *lower-fidelity proxy* for the same assertion. It's not worthless — it catches regressions in the command construction cheaply and fast — but it's also not the kind of test you should be adding more and more of. The marginal unit test for sync has diminishing returns precisely because the integration test is where real confidence comes from.

The pragmatic hierarchy is: a few high-fidelity integration tests for end-to-end confidence, plus targeted unit tests for complex logic that's hard to exercise through integration tests (JWT crypto, process matching heuristics). What you *don't* need is unit tests for the glue between them.

### Against the CI Guardrails Advocate: "Automation covers what you skip"

**Their claim:** If tests are automated in CI, the maintenance cost is near-zero. Just write them, add them to the pipeline, and let the machines do the work.

**Rebuttal:** The CI advocate correctly identifies that *running* tests is cheap. But they undercount the cost of *maintaining* tests when code changes. CI doesn't write test updates for you — developers do.

In PoeClaw's case, the `sync.test.ts` suite demonstrates the problem clearly. Each test case requires mocking 7 sequential `sandbox.exec()` calls in the exact right order with the exact right return values. When the sync implementation changed from s3fs/rsync to rclone (`95307a3`), every mock chain in this file had to be rewritten. CI caught the *failures* instantly, yes. But a developer still had to spend time rewriting the tests. If those had been 20 test cases instead of 7, that's 3x the developer time for a migration that the team had already decided to make.

CI guardrails are most valuable for tests that are *stable* — tests for invariants that don't change when implementations change. Those are exactly the tests I advocate writing. The tests I advocate *not* writing are the ones that break on every refactor, turning CI from a guardrail into a speed bump.

---

## Testing Framework for PoeClaw

### ALWAYS Test (Non-Negotiable)

| Category | Why | Example in Codebase |
|----------|-----|-------------------|
| **Security boundaries** | Failures are silent and critical | JWT verification (`auth/jwt.ts`), credential redaction (`utils/logging.ts`) |
| **Data integrity invariants** | Failures cause data loss | R2 sync direction (`rclone sync` vs `copy`), exclusion patterns |
| **Complex discrimination logic** | Multiple interacting conditions with non-obvious edge cases | Process matching (`gateway/process.ts:19-31`) — 4 gateway patterns, 5 CLI patterns, 2 status checks |
| **State machine transitions** | Wrong state = wrong behavior, hard to catch visually | Gateway lifecycle (starting → running → stuck → killed → restarted) |
| **Parsing and extraction** | Untrusted input from outside the type system | JWT extraction from cookies, JSON parsing from CLI stdout |

### SOMETIMES Test (Judgment Call)

| Category | When to test | When to skip |
|----------|-------------|-------------|
| **Configuration builders** | When the mapping is non-obvious or has conditional logic | When it's a 1:1 property mapping that TypeScript validates |
| **Error handling paths** | When the error response contains security-sensitive information or user-facing messages | When it's a generic 500 with a logged stack trace |
| **Orchestration logic** | When the ordering of operations matters (e.g., rclone config before sync) | When it's "call A, then call B" with no branching |

### NEVER Test (Actively Resist)

| Category | Why | Example in Codebase |
|----------|-----|-------------------|
| **Route registration** | Tests Hono, not your code. A 404 is immediately visible. | `routes/admin-ui.ts`, `routes/public.ts` |
| **Static HTML/templates** | String literal assertions test nothing. Visual bugs are caught visually. | `src/assets/*.html` |
| **One-line delegations** | The type system validates the call. The test is a tautology. | `app.route('/admin', adminUIRoutes)` |
| **Third-party SDK behavior** | Not your bug, not your test. Mock it at the boundary. | Testing that `sandbox.startProcess()` actually starts a process |
| **Console.log/debug output** | Format changes are not bugs. Log assertions are the most brittle tests. | `console.log('[Gateway] OpenClaw gateway is ready!')` |
| **Code slated for replacement** | The design document marks it for rewrite. Testing it is writing throwaway code to protect throwaway code. | Current cookie-parsing JWT extraction (being replaced by session auth) |

---

## Proposed Rules for PoeClaw

### Rule 1: The Severity × Detectability Test

Before writing a test, answer two questions:

1. **If this code breaks, how bad is it?** (Critical / High / Medium / Low)
2. **If this code breaks, how quickly will someone notice?** (Seconds / Minutes / Hours / Days+)

Only write tests when severity is High+ AND detectability is Hours+. Everything else is caught by types, by the user, or by integration tests.

### Rule 2: Test Contracts, Not Implementations

Tests should assert *what* the code promises, not *how* it does it. Good: "unauthenticated requests return 401." Bad: "the middleware calls `verifyAccessJWT` with the token from the `CF-Access-JWT-Assertion` header." The first survives a refactor. The second breaks on any internal change.

### Rule 3: One Invariant, One Test

Each test should protect exactly one invariant. If you can't name the invariant in the `describe` block (e.g., "rejects expired tokens," "propagates deletions via rclone sync"), the test is probably testing implementation details rather than behavior.

### Rule 4: Mocking Budget — Three Deep, No More

If a test requires mocking more than 3 layers of dependencies, it's a sign that the code under test is orchestration glue, not testable logic. Extract the logic into a pure function and test that, or accept that it's integration-test territory and test it there.

### Rule 5: Delete Tests That Cry Wolf

If a test has broken more than twice due to non-bug refactors (implementation changes where the behavior was preserved), delete it. It's testing implementation details, and its maintenance cost has exceeded its bug-catching value. Track this informally — if updating a test feels routine rather than alarming, that's the signal.

### Rule 6: New Tests Require a Threat Model

When adding a new test, include a one-line comment stating the threat: what specific failure mode does this test catch? This forces the author to articulate the test's value and makes it easy to evaluate during refactors whether the threat still applies.

```typescript
// Threat: CLI commands (e.g., "openclaw devices list") incorrectly matched as gateway process
it('returns null when only CLI commands are running', async () => { ... });
```

### Rule 7: Coverage Targets Are Forbidden

Do not set coverage thresholds. A coverage target incentivizes writing low-value tests to hit a number. Instead, review *which* code is covered and ask: "Is the uncovered code high-severity and low-detectability?" If not, leave it uncovered.

---

## Conclusion

The pragmatic minimalist position is not anti-testing — it is anti-waste. The current PoeClaw test suite is approximately right: it focuses on security boundaries, data integrity, and complex discrimination logic while leaving route registration, HTML templates, and orchestration glue untested. The correct response to "we should have more tests" is not "no," but "where, and why?" If the answer doesn't reference a specific failure mode with high severity and low detectability, the test isn't worth writing.

In an experimental project with a 5-phase roadmap and multiple open design questions, the highest-leverage use of developer time is answering those questions — not writing tests for code that may not exist next month. Test the invariants that will survive the rewrites. Skip everything else. This is not laziness; it is the engineering judgment to allocate scarce resources where they create the most value.
