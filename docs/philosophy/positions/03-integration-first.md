# Position 03: Integration-First Testing

**Author:** Integration-First Testing Advocate
**Date:** 2026-02-15
**Status:** Position paper for scientific debate

---

## Core Thesis

In a system whose primary purpose is to proxy, orchestrate, and relay between external boundaries — a Cloudflare Worker bridging clients, sandbox containers, R2 storage, and authentication providers — **the bugs that ship to production live at the seams, not in the functions**. Unit tests that mock `sandbox.exec()`, `sandbox.wsConnect()`, and `sandbox.containerFetch()` verify that your code calls the right mock in the right order; they do not verify that the system works. Integration tests that exercise real boundary crossings are the minimum viable correctness guarantee for this architecture.

---

## Key Arguments

### 1. The Mock Fidelity Problem Is Structural, Not Incidental

Examine `sync.test.ts`. The test for a successful R2 sync chains **seven sequential mock return values**:

```typescript
execMock
  .mockResolvedValueOnce(createMockExecResult('yes'))    // rclone configured
  .mockResolvedValueOnce(createMockExecResult('openclaw')) // config detect
  .mockResolvedValueOnce(createMockExecResult())          // rclone sync config
  .mockResolvedValueOnce(createMockExecResult())          // rclone sync workspace
  .mockResolvedValueOnce(createMockExecResult())          // rclone sync skills
  .mockResolvedValueOnce(createMockExecResult())          // date > last-sync
  .mockResolvedValueOnce(createMockExecResult(timestamp)) // cat last-sync
```

This test asserts that `syncToR2` calls `sandbox.exec()` seven times with the right strings. But the actual bug surface is: does rclone with these flags, these paths, and these credentials actually sync data to R2? Does the `--exclude='.git/**'` flag work with rclone's glob syntax or does it silently fail? Does `rclone sync` with `--s3-no-check-bucket` behave correctly when the bucket doesn't exist yet? The mock returns success unconditionally. The real system has opinions.

This is not a failure of test-writing discipline — it is a structural property of testing code whose job is to orchestrate external systems via shell commands. When the function under test is essentially a shell script builder, mocking the shell is mocking the thing you need to test.

### 2. The WebSocket Proxy Cannot Be Meaningfully Unit Tested

The WebSocket proxy in `src/index.ts:282-429` is 150 lines of bidirectional event relay with error transformation. It:

1. Creates a `WebSocketPair` (Workers runtime API)
2. Calls `sandbox.wsConnect()` (Sandbox Durable Object API)
3. Accepts both WebSockets (runtime method)
4. Attaches event listeners for message, close, and error on both sides
5. Parses JSON messages from the container, transforms error messages, re-serializes
6. Handles `readyState` checks before sending
7. Truncates close reasons to 123 bytes (WebSocket spec limit)

To unit test this, you would need to mock: `WebSocketPair`, `sandbox.wsConnect()`, WebSocket `addEventListener`, `readyState`, `send`, `close`, `accept`, and `JSON.parse` behavior on binary vs. string messages. The resulting test would be a specification of the implementation, not a specification of the behavior. Change the implementation (e.g., switch from event listeners to async iteration), and the test breaks even if the behavior is identical.

An integration test that opens a real WebSocket to a running worker, sends a message through to a real container, and verifies the response exercises the actual behavior. It would catch: WebSocket upgrade failures, event ordering bugs, readyState race conditions, binary message handling, and error transformation on real gateway responses.

### 3. The Auth Flow Requires Real Token Verification

The auth middleware (`src/auth/middleware.ts`) has two bypass modes (`DEV_MODE`, `E2E_TEST_MODE`) and a production path that:

1. Extracts JWT from `CF-Access-JWT-Assertion` header or `CF_Authorization` cookie
2. Verifies the JWT signature against Cloudflare Access's JWKS endpoint
3. Validates the audience claim
4. Returns 401/403 with appropriate content types (JSON vs HTML)

The unit tests verify JWT extraction logic and bypass mode detection — useful, but not the bug surface. The bugs that ship are: JWKS key rotation causing verification failures, audience mismatch between environments, cookie parsing edge cases in different browsers, and the interaction between CF Access's redirect flow and the WebSocket token injection (`src/index.ts:296-300`). Specifically, line 296-300 shows that when CF Access strips query params during redirect, the worker re-injects the gateway token. This interaction between auth redirect behavior and token injection is invisible to any unit test.

### 4. The Gateway Lifecycle Has Concurrency Bugs That Only Manifest Under Load

`ensureMoltbotGateway()` in `src/gateway/process.ts` implements a check-then-act pattern:

1. Check for existing process (`findExistingMoltbotProcess`)
2. If found, wait for port readiness (3-minute timeout)
3. If timeout, kill and restart
4. If not found, start new process

The comment on line 71-73 is telling:

> *"Always use full startup timeout — a process can be 'running' but not ready yet (e.g., just started by another concurrent request). Using a shorter timeout causes race conditions where we kill processes that are still initializing."*

This is a concurrency bug that was discovered in production, not in unit tests. The unit test for `findExistingMoltbotProcess` verifies pattern matching on command strings — it cannot exercise the race condition where two concurrent requests both find no existing process and both start a new gateway. An integration test that sends two concurrent requests to a cold worker would expose this class of bug immediately.

### 5. The CDP Shim Has Zero Unit Tests Because It Can't Be Meaningfully Unit Tested

The CDP (Chrome DevTools Protocol) shim in `src/routes/cdp.ts` implements 50+ CDP methods by translating CDP JSON-RPC over WebSocket into Puppeteer calls against Cloudflare Browser Rendering. It has zero unit tests. This is not an oversight — it's an admission that mocking Puppeteer's behavior (page navigation timing, DOM mutation, screenshot encoding, request interception) would produce tests that verify nothing about whether the CDP translation is correct.

The only meaningful test for this module is an integration test that connects a CDP client (like Playwright or chrome-remote-interface), sends real CDP commands, and verifies real browser behavior. The existing E2E tests partially cover this (they use Playwright through the CDP shim), but targeted integration tests for individual CDP domains would catch protocol translation bugs that neither unit tests nor full E2E tests efficiently surface.

---

## Counterarguments and Rebuttals

### Against TDD Purists: "You need fast feedback loops"

**The argument:** Unit tests run in milliseconds. Integration tests take seconds to minutes. Fast feedback loops are essential for developer productivity and TDD's red-green-refactor cycle.

**The rebuttal:** I concede the speed advantage entirely. Unit tests are faster. But speed is not the only dimension of a feedback loop — *signal quality* matters too. A test suite that runs in 200ms and tells you "your mocks behave as expected" provides fast feedback about the wrong thing. A test suite that runs in 30 seconds and tells you "your worker correctly proxies a WebSocket connection through a real sandbox container" provides slower feedback about the right thing.

The pragmatic synthesis: run integration tests on save for the module you're editing (scoped, not full suite). Use `vitest --watch` with a test filter. The feedback loop for a single integration test hitting a local miniflare instance is 2-5 seconds — fast enough for productive iteration.

**Honest concession:** For pure logic functions (JWT parsing, command string building, config validation), unit tests are the right tool. I don't advocate eliminating them. I advocate demoting them from the primary testing strategy to a supplementary one.

### Against Type Advocates: "Types catch it at compile time"

**The argument:** TypeScript's type system catches interface mismatches, missing fields, wrong argument types. With strict types, many integration bugs become compile errors.

**The rebuttal:** Types operate within a single compilation unit. They cannot span the worker-container boundary. The `Sandbox` type says `exec()` returns `Promise<ExecResult>` — it cannot express that `rclone sync` with `--s3-no-check-bucket` silently succeeds but syncs zero files when the endpoint URL is wrong. The `WebSocket` type says `send()` accepts `string | ArrayBuffer` — it cannot express that the container's WebSocket sends binary frames for certain message types that the JSON parse in the error transformer will silently skip.

Types are a necessary condition for correctness at boundaries, not a sufficient one. The type of `sandbox.exec(command)` is always `Promise<ExecResult>` regardless of whether `command` is a valid rclone invocation or gibberish. The boundary is stringly-typed by nature.

**Honest concession:** For the Hono route definitions, TypeScript's type system does catch real bugs (wrong response types, missing middleware). Types and integration tests are complementary, not competing.

### Against Pragmatists: "Integration tests are slow and flaky"

**The argument:** Integration tests require infrastructure setup, are sensitive to timing, and produce intermittent failures that erode trust in the test suite.

**The rebuttal:** This is the strongest counterargument and I take it seriously. Integration test flakiness is a real engineering problem, not a strawman. My response has three parts:

1. **Flakiness is a solvable engineering problem, not an inherent property.** The existing E2E tests in `test/e2e/` use Terraform to deploy real infrastructure and run Playwright against it. That's maximally flaky. I'm not proposing that. I'm proposing integration tests against `miniflare` (Cloudflare's local simulator) with a real sandbox container, which eliminates network variance and deployment timing.

2. **The alternative is worse.** The current test suite has 130+ unit tests and zero integration tests (the E2E tests are a separate, heavy-weight suite). This means there is no automated verification that the worker correctly proxies requests, handles auth, or syncs to R2. The choice is not "flaky integration tests vs. reliable unit tests" — it's "flaky integration tests vs. no boundary testing at all."

3. **Flaky tests that catch real bugs are more valuable than stable tests that catch hypothetical bugs.** A flaky WebSocket proxy integration test that fails 5% of the time due to timing — but catches real relay bugs the other 95% — provides more value than a stable unit test that verifies mock call ordering.

**Honest concession:** Integration test infrastructure requires maintenance. Someone has to keep miniflare configs working, manage test container images, and handle the inevitable "works on my machine" problems. This is real cost that must be budgeted.

### Against Anti-Mock Realists: Distinguishing Our Position

**The argument:** Anti-mock advocates say "don't mock what you don't own." We largely agree but draw a different conclusion.

**The distinction:** Anti-mock realism says: don't mock external interfaces, write thin wrappers, and test your logic in isolation. This is correct as far as it goes, but for PoeClaw it doesn't go far enough. The worker's logic *is* the orchestration of external interfaces. There is no "business logic" to isolate behind thin wrappers — the business logic is: "proxy this WebSocket, inject this token, transform this error, sync these files." If you extract the orchestration into thin wrappers and test the wrappers' callers in isolation, you've just moved the mocks one level up.

The integration-first position says: stop trying to isolate the logic from the boundaries. The logic is the boundaries. Test the boundaries.

**Point of agreement:** We share the core insight that mocks create a parallel universe that diverges from reality. Where we diverge is the remedy: anti-mock realists restructure code to minimize the need for mocks; integration-first advocates structure *tests* to minimize the need for mocks by testing against real systems.

---

## Concrete Examples: Bugs Integration Tests Would Catch

### Example 1: The rclone `--exclude` Flag Syntax Bug

`syncToR2` passes `--exclude='*.lock'` to rclone via `sandbox.exec()`. But rclone's exclude syntax depends on the shell parsing. If the exec environment doesn't invoke a shell (direct exec), the single quotes are passed literally to rclone, which interprets `'*.lock'` as a literal filename pattern including quotes. The unit test mocks `sandbox.exec()` and never discovers this. An integration test running the actual rclone command in a real container would fail immediately.

### Example 2: The WebSocket Token Injection Race

Lines 296-300 of `src/index.ts` inject the gateway token into the WebSocket URL when CF Access strips query params. But `sandbox.wsConnect()` may not support URL mutation after the initial handshake in certain Sandbox versions. A unit test mocks `wsConnect` and returns a successful response regardless. An integration test would reveal that the mutated URL causes a 400 from the sandbox.

### Example 3: The Gateway Process Kill-Restart Race

When `ensureMoltbotGateway` kills a stuck process and starts a new one, the old process may hold the port briefly during teardown. The new process's `waitForPort` may succeed against the dying old process, then lose the connection. The unit test mocks `kill()` as instantly successful and `waitForPort` as deterministic. An integration test with a real container would expose the port-binding race.

### Example 4: The R2 Sync Partial Failure Silencing

`syncToR2` marks workspace and skills sync as non-fatal (`|| true`). If rclone silently fails on workspace sync (e.g., permission denied on a file), the function returns `{ success: true }` with only config actually synced. The user sees "sync successful" but their workspace isn't persisted. A unit test mocks all execs as successful. An integration test with a real file that has restricted permissions would reveal the silent data loss.

### Example 5: The CDP Screenshot Encoding Mismatch

The CDP shim implements `Page.captureScreenshot` by calling Puppeteer's `page.screenshot()` and returning base64-encoded data. If Puppeteer returns a `Buffer` and the CDP response expects a base64 string without the data URI prefix, the client receives corrupted data. No unit test can catch this because there's no Puppeteer to return a real `Buffer`. An integration test with a real browser connection would catch the encoding mismatch immediately.

---

## Proposed Rules for PoeClaw

### Rule 1: Every System Boundary Gets an Integration Test

For each boundary crossing (Worker ↔ Container, Worker ↔ R2, Worker ↔ Client, Worker ↔ CF Access), write at least one integration test that exercises the real protocol. No mocks at the boundary.

### Rule 2: Unit Tests for Pure Logic Only

Unit tests are appropriate for:
- `buildEnvVars()` — pure data transformation
- `findExistingMoltbotProcess()` — pattern matching (though integration tests should also cover it)
- JWT extraction logic — string parsing
- `transformErrorMessage()` — pure string transformation
- Config validation — predicate logic

Unit tests are **not** appropriate for:
- `syncToR2()` — shell command orchestration
- `ensureMoltbotGateway()` — process lifecycle with concurrency
- WebSocket proxy — runtime API interaction
- CDP shim — protocol translation
- Auth middleware end-to-end — multi-step verification

### Rule 3: Use Miniflare for Local Integration Tests

The integration test environment should be `miniflare` + a real sandbox container (or a lightweight container stub). This is faster than full deployment (E2E) but exercises real APIs. Target: individual integration tests complete in under 10 seconds.

### Rule 4: Integration Tests Are First-Class CI Citizens

Integration tests run in CI on every PR, not as a nightly job or manual step. If they're too slow for PR checks, that's a signal to invest in faster test infrastructure, not to demote them.

### Rule 5: Flaky Tests Get Fixed, Not Deleted

A flaky integration test is a test that's detecting a real timing-dependent bug. Investigate the flake. Add retries with backoff for infrastructure variance, but never silence a flaky test by deleting it or marking it as skipped without understanding the root cause.

### Rule 6: The Test Pyramid Is Inverted for Proxy Architectures

The traditional test pyramid (many unit tests, fewer integration tests, few E2E tests) assumes that most logic is internal computation. For a proxy/orchestrator like PoeClaw, most logic is boundary crossing. The appropriate shape is:

```
     /‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾\       E2E (few, full deployment)
    /‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾\    Integration (many, real boundaries)
    \_______________________/    Unit (few, pure logic only)
```

---

## Acknowledged Weaknesses

1. **Setup complexity.** Integration tests require a running sandbox container, R2 credentials (or emulator), and miniflare configuration. This is more infrastructure than `vitest` alone.

2. **Slower feedback.** A full integration test suite will take 30-120 seconds vs. < 1 second for unit tests. This is a real cost for iterative development.

3. **Environment parity.** Miniflare is not identical to the Cloudflare Workers runtime. There will be gaps. The CDP shim in particular requires real Browser Rendering, which is not available locally.

4. **Debugging difficulty.** When an integration test fails, the failure may be in any layer of the stack. Unit test failures point directly at the broken function. Integration test failures require investigation.

5. **Test data management.** Integration tests that touch R2 need bucket setup/teardown. Tests that start gateway processes need cleanup. This is ongoing maintenance burden.

These are real costs. I argue they are worth paying because the alternative — a test suite that validates nothing about the system's actual boundary behavior — is more expensive in production incidents.

---

## Summary

PoeClaw is not a computation engine. It is a proxy, orchestrator, and boundary-crossing system. Its correctness properties are defined at the seams between components, not within them. A testing strategy that focuses on unit-testing isolated functions with mocked boundaries is testing the wrong thing with great precision. Integration tests that exercise real boundary crossings — real sandbox containers, real WebSocket connections, real rclone invocations — test the right thing with acceptable imprecision.

The question is not "are integration tests harder to write?" They are. The question is "do integration tests catch the bugs that matter?" In a proxy architecture, they do. That is why they should be first.
