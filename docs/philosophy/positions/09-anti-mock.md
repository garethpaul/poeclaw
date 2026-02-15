# Position 09: Anti-Mock Realism

**Agent:** Anti-Mock Realist
**Date:** 2026-02-15
**Project:** PoeClaw/OpenClaw (Cloudflare Workers + Sandbox Containers)

---

## Core Thesis

Mocks are executable lies. Every mock encodes an assumption about how an external system behaves, and that assumption ossifies into the test suite while the real system continues to evolve, drift, and surprise. In a project like PoeClaw — where the dominant source of production bugs is the behavioral gap between the Cloudflare Sandbox API and what developers expect it to do — a mock-heavy test suite doesn't test your code against reality; it tests your code against your beliefs about reality. When those beliefs are wrong, the tests still pass, the deploy goes green, and the bug ships.

---

## Key Arguments

### 1. The Sandbox API's Most Important Behaviors Are Precisely What Mocks Cannot Capture

The AGENTS.md file documents four critical behavioral quirks of the sandbox API, and every single one of them is invisible to our mock-based tests:

- **`proc.status` timing**: The sandbox API's `proc.status` may not update immediately after a process completes. AGENTS.md explicitly warns: "Instead of checking `proc.status === 'completed'`, verify success by checking for expected output." Yet `createMockProcess()` in `test-utils.ts:26-36` returns an instantly-settled status. The mock process is born `completed` with `exitCode: 0` — it has never been in a liminal state. The real bug class — code that reads status too early and acts on stale data — is structurally undetectable.

- **s3fs timestamp incompatibility**: s3fs doesn't support setting timestamps, causing `rsync -a` to fail with "Input/output error." This was a real production bug that required changing to `rsync -r --no-times`. The old s3fs-based mocks would have passed with `rsync -a` just fine. Now we use rclone, but `createMockExecResult()` returns `{ success: true, exitCode: 0 }` regardless of what command string was passed. A test could assert `rclone sync` with completely fabricated flags and the mock would nod approvingly.

- **Mount state detection**: AGENTS.md says "Don't rely on `sandbox.mountBucket()` error messages to detect 'already mounted' state. Instead check `mount | grep s3fs`." The mock sandbox doesn't even include `mountBucket` — it was presumably dropped when rclone replaced s3fs. But the lesson stands: the mock had no opinion about mount semantics, so it couldn't have caught the bug.

- **`waitForPort` race conditions**: The real code comment at `process.ts:71-73` is damning: "a process can be 'running' but not ready yet (e.g., just started by another concurrent request). Using a shorter timeout causes race conditions where we kill processes that are still initializing." The mock's `waitForPort: vi.fn()` resolves instantly. It cannot reproduce the race condition that motivated the 3-minute timeout.

### 2. Sequential Mock Chains Encode Fragile Ordering Assumptions

Consider `sync.test.ts:47-54`, which tests `syncToR2`:

```typescript
execMock
  .mockResolvedValueOnce(createMockExecResult('yes'))      // rclone configured
  .mockResolvedValueOnce(createMockExecResult('openclaw'))  // config detect
  .mockResolvedValueOnce(createMockExecResult())            // rclone sync config
  .mockResolvedValueOnce(createMockExecResult())            // rclone sync workspace
  .mockResolvedValueOnce(createMockExecResult())            // rclone sync skills
  .mockResolvedValueOnce(createMockExecResult())            // date > last-sync
  .mockResolvedValueOnce(createMockExecResult(timestamp));  // cat last-sync
```

This is seven sequentially-ordered mock responses for a single function. The test is a script that says "if you call exec exactly seven times, in exactly this order, I will return these values." This has several fatal properties:

- **It's a change detector, not a behavior test.** If the implementation reorders workspace and skills sync (which are logically independent), the mock chain breaks. If someone adds a health check exec call between steps 2 and 3, every mock index shifts and the test fails — not because the code is wrong, but because the script deviated from the mock's choreography.

- **It cannot represent partial failure.** Real rclone sync can succeed for config but fail for workspace due to network flake, then succeed for skills. The mock chain either works perfectly or injects a single failure at a specific index. The combinatorial space of real partial-failure modes is vast; the mock explores exactly one path per test.

- **It cannot represent timing.** In reality, `sandbox.exec()` has variable latency. The 120-second timeout on sync operations (`sync.ts:58`) exists because rclone can legitimately take minutes on large workspaces. The mock resolves in microseconds. Any timeout-sensitive logic is untestable.

### 3. The Auth Mocks Replace a Security Boundary With a Rubber Stamp

The JWT verification tests mock the entire `jose` library:

```typescript
vi.mock('jose', () => ({
  createRemoteJWKSet: vi.fn(() => 'mock-jwks'),
  jwtVerify: vi.fn(),
}));
```

This replaces the JWKS-fetching, cryptographic-verification, and claim-validation pipeline with `vi.fn()`. The test then programs `jwtVerify` to return a payload and asserts that the code reads the email from it. But:

- The mock cannot catch a real JWKS endpoint returning unexpected key formats.
- The mock cannot catch clock skew issues with `exp`/`iat` claims (the test uses `Math.floor(Date.now() / 1000) + 3600`, which will always be valid).
- The mock cannot catch the Cloudflare Access team domain URL construction edge cases (with/without `https://` prefix) in the actual HTTP call — only in the string-construction unit logic.
- `createRemoteJWKSet` returns the string `'mock-jwks'`. In production, it returns a function. If any code path ever inspects or calls the JWKS set directly rather than passing it through `jwtVerify`, the mock would not catch the type mismatch.

For a security-critical path, this level of mocking is not testing authentication — it's testing that your code can read properties from an object.

### 4. `createMockSandbox` Encodes a Frozen API Surface That Silently Diverges

The mock sandbox in `test-utils.ts:62-90` implements six methods: `listProcesses`, `startProcess`, `containerFetch`, `exec`, `writeFile`, and `wsConnect`. The cast `as unknown as Sandbox` explicitly discards type safety:

```typescript
const sandbox = {
  listProcesses: listProcessesMock,
  // ... 5 more methods
} as unknown as Sandbox;
```

When the real `@cloudflare/sandbox` SDK adds a new method (say `readFile`, or `getMetrics`), the mock won't break — it simply won't have the method, and any test using it will get `undefined` instead of a function. The `as unknown as Sandbox` double-cast means TypeScript won't catch this either. The mock is a snapshot of the API as someone understood it at one point in time, with no mechanism to detect staleness.

### 5. Mocks Make the Test Suite a Mirror of the Implementation, Not a Specification of Behavior

Look at `r2.test.ts:52-71`. The test for "writes rclone config when not configured" is:

```typescript
execMock
  .mockResolvedValueOnce(createMockExecResult('no'))  // flag check
  .mockResolvedValueOnce(createMockExecResult())      // mkdir
  .mockResolvedValueOnce(createMockExecResult());     // touch flag
```

This doesn't test "can the container access R2?" It tests "does `ensureRcloneConfig` call `exec` three times and `writeFile` once in the expected order?" The test is a line-by-line transliteration of the implementation into mock-language. If someone refactored `ensureRcloneConfig` to use a single `exec` call with `&&`-chained commands (functionally equivalent), the test would fail. If someone introduced a subtle bug in the rclone config format that R2 rejects (wrong endpoint format, missing `no_check_bucket`), the test would pass — because `writeFile` is mocked and never validates the content against R2's actual requirements.

---

## Counterarguments and Rebuttals

### Against TDD Purists: "Mocks Enable Fast Feedback"

**Their argument:** Mocks let you run the test suite in milliseconds. Fast feedback loops accelerate development. Real dependencies make tests slow and flaky.

**Rebuttal:** Fast feedback on the wrong thing is not feedback — it's false confidence. The PoeClaw test suite runs in ~2 seconds. It "covers" rclone sync, JWT verification, process management, and R2 configuration. But when the team discovered that `proc.status` doesn't update immediately, that s3fs can't handle timestamps, and that `waitForPort` needs a 3-minute timeout for race conditions — none of those discoveries came from the test suite. They came from production. The fast feedback loop told the team "everything works" while the slow feedback loop (production) told them "nothing works the way you assumed."

I do not argue for eliminating all fast tests. Pure functions like `buildEnvVars` and `detectConfigDir` (with real exec output) are fine. The problem is mocking the *boundaries* — the sandbox API, the auth pipeline, the storage layer — where the real bugs live.

### Against Type Advocates: "Typed Mocks at Least Match the Interface"

**Their argument:** If the mock implements the same TypeScript interface as the real dependency, you get compile-time guarantees that the contract is respected.

**Rebuttal:** PoeClaw's own codebase refutes this. `createMockSandbox` uses `as unknown as Sandbox` — a double-cast that explicitly bypasses the type system. The mock doesn't implement the `Sandbox` interface; it impersonates it via type erasure. Even if the cast were removed, TypeScript interfaces describe *shape*, not *behavior*. The `Sandbox` interface says `exec` returns `Promise<ExecResult>`. It doesn't say "exec can take 120 seconds," "exec might fail silently if the container is under memory pressure," or "exec output may include unexpected ANSI escape codes." The behavioral contract — the part that causes bugs — is not in the types.

### Against Integration Testers: Distinguishing Contract Testing from Reality Testing

**Their argument (my natural allies):** "We agree — test against real dependencies at the integration layer."

**My distinction:** Integration testing often still uses controlled, sanitized environments. A staging Cloudflare Sandbox is not a production Cloudflare Sandbox. The quirks documented in AGENTS.md — timing, mount semantics, process state — may differ between environments. My position is stronger: where feasible, use the *actual* Cloudflare Sandbox API in tests, running against the same infrastructure that production uses. The e2e tests in `test/e2e/` already do this with `cctr` and real containers. That's the right direction. The gap is that the unit tests mock everything, and the e2e tests are run rarely and manually.

The ideal is a layered approach: (1) no-mock unit tests for pure logic, (2) real-sandbox contract tests for API interactions, (3) e2e smoke tests for full flows. Layer 2 is currently missing entirely.

### Against Pragmatists: "Real Dependencies Are Slow and Unreliable"

**Their argument:** Running tests against real Cloudflare Sandbox containers takes 1-2 minutes for cold start alone. It requires real credentials, real network access, and real money. Tests become flaky due to network issues, rate limits, and shared state.

**Rebuttal:** I acknowledge this is the strongest counterargument, and I do not dismiss it. The cost is real. But consider the alternative cost: the team has already documented at least four classes of bugs (in AGENTS.md) that were discovered in production because tests couldn't catch them. Each of these bugs required emergency debugging in a live system. The 20-second `CLI_TIMEOUT_MS` and 180-second `STARTUP_TIMEOUT_MS` constants in the codebase are scar tissue from production incidents that mocked tests couldn't predict.

My practical proposal is not "run the full sandbox in CI on every commit." It is:

1. **Record-replay for sandbox interactions.** Capture real `exec` output, real timing, real error messages from actual sandbox sessions. Replay them in tests. This is still faster than mocks to write (no manual mock construction) and captures real behavioral quirks.
2. **Contract tests on nightly or merge.** Run a focused set of tests against a real sandbox in CI on merge to main. This catches API drift.
3. **Reserve mocks for pure logic.** `buildEnvVars`, string parsing, config validation — these don't need a sandbox. Test them without mocks, with real data structures.

### Against Deploy Safety Advocates: "Production Testing Validates What Mocks Can't"

**Their argument (partial ally):** Production is the ultimate test environment. Canary deploys, feature flags, and observability catch what pre-production tests miss.

**My distinction:** I agree that production testing is necessary, but it is not sufficient as the *only* validation of external behavior. Production testing tells you "it's broken" after deployment. Real-dependency testing tells you "it's broken" before deployment. The ideal is both: pre-merge contract tests against real sandbox APIs to catch behavioral drift early, plus production observability to catch the long tail of issues that only manifest under real load and real data.

The deploy safety position is about how to recover from failures. My position is about how to prevent failures from reaching production in the first place.

---

## Specific Examples: Where Mocks Hide Real Bugs

### Example 1: The `proc.status` Stale Read

**Bug class:** Code checks `proc.status === 'running'` immediately after `startProcess()`. In production, the status may still be `'starting'` or even undefined for a brief window. The mock at `test-utils.ts:31` returns `status: 'completed'` by default, and `createFullMockProcess` at `process.test.ts:10` returns `status: 'running'`. Neither reproduces the transient states.

**What would catch it:** A real sandbox test where `startProcess()` is called and status is polled over time, revealing the actual state transition sequence.

### Example 2: The rclone Config Format

**Bug class:** `ensureRcloneConfig` writes an rclone config to the container via `sandbox.writeFile()`. The config includes `no_check_bucket = true`. If this flag were misspelled (`no_check_buket = true`) or if a future rclone version changed the option name, the mock test would still pass — `writeFileMock` accepts any string. The bug would surface only when `rclone sync` fails in production with a cryptic error.

**What would catch it:** A test that writes the config and then runs `rclone lsd r2:` to verify the config is parseable and the connection works.

### Example 3: The Exec Output Parsing

**Bug class:** `detectConfigDir` in `sync.ts:24-32` parses the stdout of a shell command that chains `test -f ... && echo ... || ...`. The mock returns clean strings like `'openclaw'` or `'clawdbot'`. Real exec output might include trailing newlines, ANSI escape codes, or stderr leaking into stdout. The `.trim()` on line 28 handles newlines, but other output contamination would break the `=== 'openclaw'` comparison silently.

**What would catch it:** Running the actual shell command in a real container and parsing the actual output.

### Example 4: The 120-Second Timeout

**Bug class:** `syncToR2` passes `{ timeout: 120000 }` to `sandbox.exec()` for rclone operations (`sync.ts:58`). The mock ignores this parameter entirely. If the timeout were accidentally removed, or if rclone sync legitimately exceeds 120 seconds for a large workspace, the mock test passes. The real behavior — does the sandbox API actually respect the timeout parameter? Does it kill the process or let it run? — is unknown to the test suite.

**What would catch it:** A real sandbox test that syncs a non-trivial amount of data and verifies the timeout behavior.

### Example 5: The `waitForPort` Mode

**Bug class:** `process.ts:76` calls `waitForPort(MOLTBOT_PORT, { mode: 'tcp', timeout: STARTUP_TIMEOUT_MS })`. The mock's `waitForPort: vi.fn()` ignores both the mode and the timeout. If the sandbox API doesn't support `mode: 'tcp'` (or if it defaults to HTTP and the gateway isn't HTTP-ready at that point), the mock wouldn't know. Real discovery of this would require a real container where the port is open at TCP level but not yet HTTP-ready.

---

## Proposed Rules for This Project

### Rule 1: No Mocking of `@cloudflare/sandbox` API Methods

The sandbox is the core external dependency. Its behavioral quirks are the primary source of production bugs. Mocking it creates a parallel universe where those quirks don't exist.

**Instead:** For unit tests, extract pure logic into functions that take plain data (not `Sandbox` objects). For integration tests, use a real sandbox or recorded real outputs.

### Rule 2: No Mocking of Security Boundaries

JWT verification, JWKS fetching, and Cloudflare Access validation must not be mocked. These are the authentication perimeter.

**Instead:** Use real (test) JWTs signed with known keys. Test the full `jose` verification pipeline with test keys, not `vi.fn()`.

### Rule 3: Record-Replay Over Hand-Written Mocks

When real dependencies are too slow for CI, capture real interaction transcripts and replay them. A recorded `ExecResult` from a real `rclone sync` command carries the actual stdout format, actual timing characteristics, and actual error messages.

**Instead of:**
```typescript
execMock.mockResolvedValueOnce(createMockExecResult('yes'))
```

**Use:**
```typescript
execMock.mockResolvedValueOnce(recordedExecResult('rclone-config-check-positive'))
```

Where the recorded result was captured from an actual sandbox session, warts and all.

### Rule 4: Pure Logic Needs No Mocks

Functions like `buildEnvVars`, `getR2BucketName`, and `rcloneRemote` are pure transformations. Test them with real data structures, not mocked environments. `createMockEnv` is acceptable for constructing test data, but the function under test should take the data directly, not a mocked service.

### Rule 5: Contract Tests Run on Every Merge to Main

A focused set of tests that call the real Cloudflare Sandbox API must run before code reaches production. These tests verify:
- `sandbox.exec()` returns the expected `ExecResult` shape with real stdout/stderr
- `sandbox.startProcess()` status transitions behave as documented
- `sandbox.writeFile()` content is readable back via `sandbox.exec('cat ...')`
- `waitForPort` actually waits and times out as specified

### Rule 6: Delete Mock Infrastructure That Encodes Behavioral Assumptions

`createMockProcess` with a default `status: 'completed'` is a lie about process lifecycle. `createMockExecResult` with a default `exitCode: 0` is a lie about command success rates. If these utilities must exist during transition, they should be marked `@deprecated` with comments explaining what real behavior they fail to capture.

---

## Conclusion

The PoeClaw test suite is a monument to good intentions: high coverage, fast execution, clear assertions. But it tests the developer's mental model of the Cloudflare Sandbox, not the Cloudflare Sandbox itself. The four documented quirks in AGENTS.md are four bugs that passed through a mock-heavy test suite and were discovered in production. The mock didn't fail because the code was correct — the mock succeeded because the mock was wrong.

Real systems are strange. They have timing windows, partial failures, format surprises, and behavioral evolution. A mock is a bet that none of that matters. In a project where the entire value proposition depends on orchestrating a container runtime with known quirks, that bet is irresponsible. Test with real dependencies, or accept that your green test suite is a green lie.
