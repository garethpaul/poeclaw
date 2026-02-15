# Position 01: Strict Test-Driven Development

**Author:** strict-tdd
**Position:** Red-Green-Refactor is non-negotiable for all production code

---

## Core Thesis

Every line of production code in this project must be justified by a failing test that was written first. The Red-Green-Refactor cycle is not a nice-to-have or a team preference — it is the only reliable method for producing code whose behavior is fully specified, whose design is driven by usage rather than implementation, and whose correctness can be verified in seconds rather than minutes of manual testing against a live Cloudflare Sandbox container.

---

## Key Arguments

### 1. This codebase already proves TDD works here — the tested modules are the most reliable

The modules with thorough unit tests — `src/auth/jwt.ts`, `src/auth/middleware.ts`, `src/gateway/env.ts`, `src/gateway/process.ts`, `src/gateway/r2.ts`, `src/gateway/sync.ts`, `src/utils/logging.ts` — are the most maintainable code in the project. Consider `buildEnvVars()` in `src/gateway/env.ts`: its 17 test cases (`src/gateway/env.test.ts`) document every mapping, every edge case (trailing slashes on URLs, legacy gateway overrides, the `MOLTBOT_GATEWAY_TOKEN` -> `OPENCLAW_GATEWAY_TOKEN` rename). When a new env var like `CF_AI_GATEWAY_MODEL` was added, the test came first, the mapping was trivial to implement, and the test suite immediately confirmed no regressions. Compare this to the *untested* modules — `src/routes/api.ts` (302 lines, 0 tests), `src/routes/cdp.ts` (1919 lines, 0 tests), `src/routes/debug.ts` (389 lines, 0 tests), `src/routes/public.ts` (70 lines, 0 tests), `src/index.ts` (450 lines, 0 tests). These are where bugs hide.

### 2. Process-finding logic is a textbook TDD success story

`findExistingMoltbotProcess()` in `src/gateway/process.ts` must distinguish between gateway processes (`openclaw gateway`, `start-openclaw.sh`) and CLI commands (`openclaw devices list`, `openclaw --version`, `openclaw onboard`). It also maintains backward compatibility with legacy command names (`clawdbot gateway`, `start-moltbot.sh`). The 10 test cases in `src/gateway/process.test.ts` were written to spec this behavior precisely. Without TDD, a developer adding legacy compatibility might have written a regex that accidentally matches `openclaw onboard` — the test at line 135 (`'does not match openclaw onboard as a gateway process'`) exists precisely because someone thought about the edge case *before* writing code. TDD forces you to enumerate the boundary conditions up front, not discover them in production.

### 3. The `timingSafeEqual` function in `cdp.ts` is untested — and it has a real bug pattern

The CDP route (`src/routes/cdp.ts:1907-1916`) implements timing-safe string comparison for secret authentication. This function has a subtle but well-known vulnerability: the early return on `a.length !== b.length` (line 1908) leaks the length of the secret via timing, partially defeating the purpose of the constant-time comparison. A TDD approach would have required writing tests that specify the contract: "comparison must not reveal information about the secret via timing." This would have forced the developer to research the correct implementation (pad both strings to the same length, or use a hash-based comparison). Instead, the function was written implementation-first and never tested, so the bug stands.

Furthermore, the entire CDP authentication pattern — checking `providedSecret`, handling missing `CDP_SECRET`, validating `BROWSER` binding — is duplicated across three route handlers (`/cdp`, `/json/version`, `/json/list`, `/json`) with no tests. TDD would have driven extraction of a shared auth guard, because writing the same test four times is painful enough to demand refactoring.

### 4. Env var validation logic in `index.ts` is complex and entirely untested

`validateRequiredEnv()` (`src/index.ts:56-92`) implements a non-trivial decision tree: it checks for `MOLTBOT_GATEWAY_TOKEN`, conditionally requires CF Access vars (skipping them in dev/test mode), and validates that at least one AI provider is configured (Cloudflare AI Gateway *or* legacy gateway *or* direct Anthropic *or* OpenAI). This function has 2^7+ possible input combinations. Without tests, we have no idea if it correctly handles the case where *only* OpenAI is configured (no Anthropic key, no gateway). We don't know if it correctly skips CF Access validation when `E2E_TEST_MODE` is set but `DEV_MODE` is not. TDD would have produced a test matrix covering these combinations *before* the function was written, guaranteeing correctness by construction.

### 5. The WebSocket proxy in the catch-all route is the highest-risk untested code

The catch-all route in `src/index.ts:229-445` is the most complex handler in the entire codebase. It:
- Detects WebSocket upgrades
- Shows a loading page if the gateway isn't ready
- Injects gateway tokens into WebSocket requests
- Proxies bidirectional WebSocket messages
- Transforms error messages in transit
- Truncates close reasons to 123 bytes for WebSocket spec compliance
- Handles close and error events on both sides

This is 216 lines of intricate stateful logic with zero tests. The `transformErrorMessage()` function (`src/index.ts:38-48`) is also untested. In a TDD approach, each of these behaviors would have a failing test *before* implementation. The token injection logic (line 296-299) is particularly critical — it silently adds authentication credentials to requests. If this logic is wrong (e.g., if it double-adds tokens when `token` is already in the URL), it could cause authentication failures that are extremely hard to debug in production.

---

## Rebuttals to Counterarguments

### vs. "Types are tests" (TypeScript type system as primary defense)

Types catch a specific class of error — shape mismatches, null access on non-optional fields, wrong argument order when types differ. But this project's most dangerous bugs are *behavioral*, not structural. Consider `buildEnvVars()`: TypeScript confirms that the return type is `Record<string, string>`, but it cannot verify that `AI_GATEWAY_API_KEY` *overrides* `ANTHROPIC_API_KEY` when both are set (the legacy gateway behavior at `src/gateway/env.ts:29-34`). That's a behavioral contract that only a test can specify. TypeScript also cannot catch the `timingSafeEqual` timing leak — the types are correct; the *algorithm* is wrong.

Where types genuinely help in this codebase: the `MoltbotEnv` interface (`src/types.ts:6-45`) documents all 25+ env vars with their optionality. The `AppEnv` type ensures middleware sets `sandbox` and `accessUser` correctly. I acknowledge this — types and tests are complementary, not competing. But types alone are insufficient. This project has full type coverage *and* bugs in untested code.

**Honest concession:** For pure data-transformation functions where the logic is a direct mapping (like a subset of `buildEnvVars`), types do reduce the marginal value of tests. But TDD still provides documentation and regression protection that types cannot.

### vs. "Integration tests matter more than unit tests"

Integration tests are valuable, but they are *slow*, *flaky*, and *coarse-grained* in this project's context. Running an actual Cloudflare Sandbox container takes minutes for cold start (`STARTUP_TIMEOUT_MS = 180_000` — a 3-minute timeout in `src/config.ts:9`). You cannot run a red-green-refactor cycle with a 3-minute feedback loop. The existing test suite (`vitest run`) completes in seconds because it uses mocks (`src/test-utils.ts`) that simulate sandbox behavior.

Integration tests also suffer from the "test gap" problem: when an integration test fails, you don't know *which* unit is broken. If a sync-to-R2 integration test fails, is it the credential validation? The rclone config generation? The rclone command flags? The sync ordering? The unit tests in `src/gateway/r2.test.ts` and `src/gateway/sync.test.ts` pinpoint the failure location immediately.

**Honest concession:** There are real classes of bugs that only integration tests catch — the interaction between `ensureMoltbotGateway()` and the real Sandbox API, the actual WebSocket proxying behavior, race conditions between concurrent requests. I advocate for a testing pyramid: many unit tests (TDD), fewer integration tests (after implementation), rare E2E tests. But the *foundation* must be TDD'd unit tests.

### vs. "Only test critical paths" (pragmatist)

This position sounds reasonable until you ask: "Which paths are critical?" In this codebase, the answer is *almost all of them*:
- Auth middleware? Critical (security).
- JWT verification? Critical (security).
- Env var building? Critical (misconfiguration = broken containers).
- Process finding? Critical (wrong match = killing the wrong process).
- R2 sync? Critical (data loss).
- CDP secret auth? Critical (security).
- WebSocket proxy? Critical (core user-facing feature).
- Config validation? Critical (broken deployments).

The "pragmatist" ends up testing almost everything anyway, but without the discipline of TDD, they write tests *after* implementation — tests that confirm the code works as written rather than tests that specify how the code *should* work. Post-hoc tests are weaker because they're influenced by implementation knowledge. A developer who has already written the `timingSafeEqual` function will write a test that passes for the current (buggy) implementation rather than a test that specifies the correct security contract.

**Honest concession:** There is genuinely low-value test territory: the static route handlers in `src/routes/public.ts` (lines 15-21, 24-31) that simply proxy to ASSETS or return a hardcoded JSON object. Testing `return c.json({ status: 'ok' })` adds no value. I accept a minimal exception for trivially correct code — but the bar for "trivially correct" must be very high.

### vs. "Mocks lie — test with real dependencies"

The mocks in this project (`src/test-utils.ts`) are well-designed and honest. `createMockSandbox()` exposes the same interface as a real Cloudflare Sandbox: `listProcesses()`, `startProcess()`, `exec()`, `writeFile()`, `containerFetch()`, `wsConnect()`. The mock contracts are verified by the fact that the tested modules (`process.ts`, `r2.ts`, `sync.ts`) work correctly in production — the mocks match reality.

But this objection has real weight in one area: the `waitForProcess()` utility (`src/gateway/utils.ts`) polls `proc.getStatus()` in a loop. A mock can't truly test the timing behavior — it resolves instantly. And the `ensureMoltbotGateway()` function (`src/gateway/process.ts:56-138`) has a complex interaction pattern (find process -> wait for port -> kill if dead -> start new -> wait again) that mocks can only partially simulate.

**Honest concession:** Mocks *can* diverge from reality, especially for the Cloudflare Sandbox API which is proprietary and evolving. When mock behavior drifts from real behavior, tests give false confidence. The mitigation is (a) keep mocks minimal — mock interfaces, not implementations, and (b) validate mock contracts with occasional integration tests against a real sandbox. But this doesn't invalidate TDD — it means TDD needs a mock-verification layer.

### vs. "Linting and CI guardrails prevent more bugs than tests"

This project uses `oxlint` (`src/` scope) and `oxfmt` for formatting. These catch stylistic issues and some correctness problems (unused variables, no-await-in-loop without justification). But linters cannot catch:
- The `timingSafeEqual` timing leak (it's syntactically and semantically valid JS)
- The env var override precedence (linters don't understand business logic)
- The process-matching logic edge cases (no lint rule for "don't match `openclaw onboard`")
- The WebSocket token injection correctness (linters can't verify URL manipulation logic)

Linting is a complement to TDD, not a substitute. The `eslint-disable-next-line` comments scattered through the codebase (e.g., `src/gateway/utils.ts:21`, `src/routes/api.ts:163`) show where lint rules are *intentionally* violated — a test would verify the *reason* for the violation is still valid.

**Honest concession:** The `typecheck` script (`tsc --noEmit`) catches a meaningful class of integration-level errors (mismatched function signatures across modules) that unit tests don't target. CI-enforced type checking is genuinely valuable and catches bugs that TDD alone would miss.

---

## Specific Example: How Strict TDD Would Have Caught a Real Bug Class

### The CDP Authentication Duplication Problem

`src/routes/cdp.ts` contains four route handlers (`/`, `/json/version`, `/json/list`, `/json`) that each independently implement the same authentication sequence:

```typescript
// This pattern is repeated 4 times (lines 156-170, 211-227, 262-278, 318-334):
const providedSecret = url.searchParams.get('secret');
const expectedSecret = c.env.CDP_SECRET;

if (!expectedSecret) {
  return c.json({ error: 'CDP endpoint not configured' }, 503);
}

if (!providedSecret || !timingSafeEqual(providedSecret, expectedSecret)) {
  return c.json({ error: 'Unauthorized' }, 401);
}

if (!c.env.BROWSER) {
  return c.json({ error: 'Browser Rendering not configured' }, 503);
}
```

In a TDD approach, the developer would write tests for the first route:

```typescript
it('returns 503 when CDP_SECRET is not set', ...)
it('returns 401 when secret is missing', ...)
it('returns 401 when secret is wrong', ...)
it('returns 503 when BROWSER binding is missing', ...)
it('returns 401 for timing-safe comparison', ...)
```

When they reach the second route handler, they would need to write the same five tests again. At this point, the TDD cycle creates natural pressure to extract a shared `cdpAuth` middleware — because *writing duplicate tests is painful*. This is TDD's design pressure at work. The developer extracts a `verifyCDPSecret()` middleware, writes tests for it once, and all four routes share the same tested auth logic.

Without TDD, the developer copies the auth block four times (as happened here), and any future change to the auth logic (e.g., fixing the timing-safe comparison) must be applied in four places. If one copy is missed, one route has a security vulnerability while the other three are patched — a silent, partial fix that's extremely hard to detect.

Additionally, if TDD had been applied, the developer would have been forced to write a test for `timingSafeEqual` itself. A proper test spec would include:

```typescript
it('returns true for equal strings', ...)
it('returns false for different strings of same length', ...)
it('returns false for different strings of different length', ...)
it('does not short-circuit on length difference (timing safety)', ...)
```

The fourth test is the key one. It forces the developer to think about *why* they're using timing-safe comparison. The current implementation fails this contract because `if (a.length !== b.length) return false` is an early exit that leaks length information. A TDD developer would either (a) fix the implementation to not leak length, or (b) explicitly document and test the accepted risk, or (c) use the Web Crypto API's `crypto.subtle.timingSafeEqual` (available in Workers runtime) instead of a hand-rolled implementation.

---

## Proposed Rules for This Project

### Rule 1: No production code without a failing test first

Every new function, route handler, middleware, and utility must begin with a test that fails. The test describes the desired behavior; the implementation makes it pass. This applies to:
- Gateway logic (`src/gateway/`)
- Auth middleware (`src/auth/`)
- Route handlers (`src/routes/`)
- Utility functions (`src/utils/`)
- Configuration validation (`src/index.ts`)

### Rule 2: Test file co-location

Tests live next to their source files (e.g., `foo.ts` and `foo.test.ts` in the same directory). This pattern is already established in the project. New routes like `src/routes/api.ts` must have a corresponding `src/routes/api.test.ts`.

### Rule 3: Use the existing mock infrastructure

`src/test-utils.ts` provides `createMockEnv()`, `createMockSandbox()`, `createMockExecResult()`, and `suppressConsole()`. All new tests should use these utilities. Extend them when new sandbox capabilities are needed (e.g., mock `wsConnect()` for WebSocket proxy tests).

### Rule 4: Test the contract, not the implementation

Tests should verify *what* a function does, not *how* it does it. For example, `buildEnvVars()` tests verify output key-value pairs, not whether the function uses `if` statements or a mapping table. This allows refactoring without breaking tests.

### Rule 5: Minimum coverage targets for new code

- Security-critical code (auth, secret handling, token validation): 100% branch coverage
- Core business logic (env building, process management, sync): 90%+ branch coverage
- Route handlers: test all status codes and error paths
- Pure utilities: 100% coverage (they're easy to test)

### Rule 6: Extract shared logic when tests reveal duplication

If writing tests for a new route handler requires duplicating test setups from another handler's tests, extract the shared logic into a testable middleware or utility function. This is TDD's design feedback — listen to it.

### Rule 7: Acknowledge the testing pyramid

TDD produces the *base* of the pyramid: fast, isolated unit tests. The project should also have:
- **Integration tests** (slower, test module interactions, run in CI)
- **E2E tests** (slowest, test the full Worker against a real sandbox, run pre-deploy)

But these are in addition to, not instead of, TDD'd unit tests.

---

## Weaknesses in This Position (Intellectual Honesty)

1. **Cold start testing is genuinely hard to TDD.** The 3-minute sandbox boot process, race conditions between concurrent requests, and Durable Object state management are inherently integration-level concerns. Unit-testing `ensureMoltbotGateway()` with mocks can verify the happy path and error handling, but cannot catch real timing bugs.

2. **The Cloudflare Sandbox API is a moving target.** Mock contracts (`src/test-utils.ts`) may drift from the real API as `@cloudflare/sandbox` evolves. Tests can pass while production breaks. This is a real risk that requires periodic integration test validation.

3. **TDD adds upfront time.** For a project in rapid prototyping phase (which PoeClaw is, per the design doc), strict TDD can slow initial velocity. The counter-argument is that untested code accrues tech debt that slows future velocity — but the honest truth is that for a project that might pivot significantly, some of those tests become throwaway work.

4. **Some code in this project is genuinely hard to unit test.** The WebSocket proxy (`src/index.ts:283-429`) involves bidirectional event listeners, WebSocketPair construction, and `executionCtx.waitUntil()`. Mocking all of this is possible but produces tests that are fragile and tightly coupled to implementation details — exactly what TDD should avoid.

5. **The React admin UI (`src/client/`) is excluded from this analysis.** Frontend component testing follows different patterns (component testing, snapshot testing) that don't map cleanly to classical TDD. This position focuses on the Worker backend.
