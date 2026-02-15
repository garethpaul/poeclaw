# Position 05: Property-Based Testing

**Author:** Property-Based Testing Advocate
**Date:** 2026-02-15
**Status:** Position Paper for Development Philosophy Debate

---

## Core Thesis

Example-based tests verify that specific inputs produce specific outputs; property-based tests verify that *all* inputs satisfy *invariants*. For a codebase with cryptographic authentication, multi-tier configuration precedence, stateful sync operations, and process lifecycle management, the input space is combinatorially explosive and the consequences of missed edge cases range from data loss to security bypass. Property-based testing with frameworks like fast-check does not replace example-based tests but occupies a strictly superior position for the classes of bugs that matter most in PoeClaw: those that arise from unexpected input combinations, ordering dependencies, and state transitions that no developer would think to write by hand.

---

## Key Arguments

### 1. The `buildEnvVars` Precedence Logic Is a Textbook Case for Properties

The current `buildEnvVars` function (`src/gateway/env.ts`) implements a multi-tier precedence system: Cloudflare AI Gateway keys, legacy AI Gateway overrides, direct provider keys, token remapping, and channel configuration. The existing 15 example-based tests (`src/gateway/env.test.ts`) cover individually chosen scenarios, but they cannot cover the combinatorial space.

There are roughly 20 optional input fields. The interesting behavior lives in the *interactions* between them: when `AI_GATEWAY_API_KEY` and `AI_GATEWAY_BASE_URL` are both present, they override `ANTHROPIC_API_KEY` (line 34). When only one is present, the override doesn't fire. When `ANTHROPIC_BASE_URL` is also set, it's only used if the legacy gateway path isn't taken (line 35-37).

**The property that must hold:**

```
For all env: MoltbotEnv,
  let result = buildEnvVars(env)
  // Precedence invariant
  if env.AI_GATEWAY_API_KEY AND env.AI_GATEWAY_BASE_URL:
    result.ANTHROPIC_API_KEY === env.AI_GATEWAY_API_KEY
  else if env.ANTHROPIC_API_KEY:
    result.ANTHROPIC_API_KEY === env.ANTHROPIC_API_KEY

  // No phantom keys: output keys are a subset of known keys
  Object.keys(result) is a subset of KNOWN_OUTPUT_KEYS

  // Idempotency of URL normalization
  result.AI_GATEWAY_BASE_URL does not end with '/'

  // No credential leakage: no input value appears under an unexpected key
  for each value in Object.values(result):
    value appears in Object.values(env)
```

The existing tests check 15 hand-picked points in a space of 2^20 combinations. A property test with fast-check generates thousands of random `MoltbotEnv` configurations and verifies the precedence invariant holds across *all of them*. This is not a theoretical advantage. The precedence logic at lines 29-37 has a subtle interaction: if you set `AI_GATEWAY_API_KEY` but *not* `AI_GATEWAY_BASE_URL`, and you also set `ANTHROPIC_API_KEY`, the direct key is used. But what if `AI_GATEWAY_BASE_URL` is an empty string? The current code treats empty string as falsy, which is correct in JavaScript, but a property test would have found and documented this boundary explicitly.

### 2. JWT Verification Has Security Properties That Demand Formal Expression

The JWT verification in `src/auth/jwt.ts` delegates to `jose`, but the *wrapper* has its own logic: team domain normalization (line 22). The current tests (`src/auth/jwt.test.ts`) mock `jose` entirely, testing that `verifyAccessJWT` calls `jwtVerify` with the right arguments. This is a test of wiring, not of security properties.

The properties that matter:

```
// P1: Domain normalization is idempotent
For all domain: string,
  normalize(normalize(domain)) === normalize(domain)
  where normalize(d) = d.startsWith('https://') ? d : `https://${d}`

// P2: No domain produces an invalid URL
For all domain: string (non-empty, valid hostname chars),
  new URL(`${normalize(domain)}/cdn-cgi/access/certs`) does not throw

// P3: Verification is a total function on the error path
For all token, domain, aud: string,
  verifyAccessJWT(token, domain, aud) either resolves to JWTPayload or rejects
  (never hangs, never returns undefined)
```

The CDP module's `timingSafeEqual` (`src/routes/cdp.ts:1907`) is another candidate. The current implementation has a known weakness: it returns `false` early when lengths differ (line 1908-1910), leaking length information via timing. A property test can express this:

```
// P4: Comparison time does not correlate with matching prefix length
For all a, b: string where a.length === b.length,
  timingSafeEqual(a, b) completes in O(n) regardless of match position
```

This is not something an example-based test can express. You'd need to write an unbounded number of examples, or you need a property.

### 3. R2 Sync Idempotency and Failure Isolation Are Compositional Properties

`syncToR2` (`src/gateway/sync.ts`) performs three sequential sync operations with different failure semantics: config sync failure is fatal (line 59-65), workspace sync is non-fatal (line 68-71), skills sync is non-fatal (line 74-76). This is a compositional property:

```
// P1: Config failure is always fatal
For all env, sandbox where configSync fails,
  syncToR2(sandbox, env).success === false

// P2: Workspace/skills failures are never fatal
For all env, sandbox where configSync succeeds AND workspaceSync fails,
  syncToR2(sandbox, env).success === true

// P3: Successful sync always produces a timestamp
For all env, sandbox where syncToR2(sandbox, env).success === true,
  syncToR2(sandbox, env).lastSync is a valid ISO 8601 string

// P4: Config directory detection is deterministic
For all sandbox state,
  detectConfigDir(sandbox) called twice yields same result
```

The existing `sync.test.ts` tests 5 scenarios. But the interaction between `ensureRcloneConfig` returning false, `detectConfigDir` returning null, config sync failing, workspace sync failing, and skills sync failing creates at least 2^5 = 32 paths. Properties test all of them implicitly.

### 4. Process Discovery Is a Classification Problem Over Structured Strings

`findExistingMoltbotProcess` (`src/gateway/process.ts:13-42`) implements a classifier: given a process command string and status, determine whether it's a running gateway. The classification logic uses substring matching with an exclusion list. This is exactly the kind of logic where property-based testing excels:

```
// P1: CLI commands are never classified as gateway processes
For all cmd containing "openclaw devices" | "openclaw --version" | "openclaw onboard",
  classify(cmd, "running") === null

// P2: Gateway commands are classified when running/starting
For all cmd containing "openclaw gateway" | "start-openclaw.sh",
  AND NOT containing any CLI command substring,
  classify(cmd, "running") !== null
  classify(cmd, "starting") !== null
  classify(cmd, "completed") === null

// P3: Classification is prefix-independent
For all prefix: string, cmd: gateway_command,
  classify(prefix + cmd, status) === classify(cmd, status)
  // This property might FAIL, revealing that substring matching
  // is sensitive to command prefixes (e.g., "/usr/bin/env openclaw gateway")
```

The existing 9 tests in `process.test.ts` cover the known cases. But property P3 would immediately reveal whether wrapping the command in a shell prefix (e.g., `bash -c 'openclaw gateway'`) breaks detection. This is the kind of bug that only manifests when the container runtime changes how it spawns processes. No human would think to write that example; fast-check generates it naturally.

### 5. CDP Session State Has Type-State Invariants

The CDP WebSocket handler (`src/routes/cdp.ts`) maintains a `CDPSession` with monotonically increasing counters (`nodeIdCounter`, `objectIdCounter`), maps that must stay consistent (`nodeMap`, `objectMap`, `pages`), and a protocol contract (response IDs must match request IDs).

```
// P1: Node IDs are unique within a session
For all sequences of querySelector/querySelectorAll calls,
  all returned nodeIds are distinct

// P2: Response ID matches request ID
For all request: CDPRequest,
  handle(session, request).id === request.id

// P3: Target lifecycle consistency
For all targetId: string,
  after closeTarget(targetId),
  session.pages.has(targetId) === false
  AND any subsequent command targeting targetId returns an error

// P4: Object release prevents use-after-free
For all objectId: string,
  after releaseObject(objectId),
  callFunctionOn({objectId}) returns an error
```

The CDP module has *zero* tests currently. It's 1,920 lines of untested protocol translation. Property-based tests are the most efficient way to bootstrap coverage here: define the protocol invariants, generate random sequences of CDP commands, and verify the invariants hold. This is more effective than writing 200 individual example tests because the generator explores ordering effects and state combinations that humans systematically miss.

---

## Counterarguments and Rebuttals

### Against TDD Purists: "Properties are harder to write than examples"

**Acknowledged:** Property-based tests have a higher initial cognitive cost. Writing `fc.property(fc.string(), fc.string(), (a, b) => ...)` requires thinking about invariants rather than input/output pairs. The learning curve is real: expect 2-4 hours for a developer's first property test to be productive.

**Rebuttal:** The difficulty of writing the property *is the point*. If you cannot articulate the invariant, you do not understand the specification. The `buildEnvVars` precedence logic is a perfect example: the existing example tests encode the developer's *current understanding* of the precedence rules. A property test forces you to write the precedence rules as executable specification, which either confirms or contradicts the implementation. This is strictly more valuable than examples that confirm individual cases.

Furthermore, the cost amortizes. Once you have a `MoltbotEnv` generator (an `fc.record` with optional string fields), you reuse it across every test that touches environment configuration. The generator becomes a project asset.

**Concession:** For pure CRUD endpoints and simple data transformations, example-based tests are sufficient and more readable. I am not arguing for properties everywhere. I am arguing for properties where the input space is combinatorial and the invariants are non-trivial.

### Against Pragmatists: "This is over-engineering for a PoC"

**Acknowledged:** PoeClaw is evolving rapidly. Spending time on property tests that may be invalidated by architecture changes is a real cost.

**Rebuttal:** The components I've identified are *not* PoC-level throwaway code. JWT authentication is security infrastructure. Environment variable precedence is configuration correctness. R2 sync is data durability. These components will survive any pivot because they're foundational plumbing. A bug in `buildEnvVars` precedence means credentials route to the wrong provider. A bug in `timingSafeEqual` means authentication can be bypassed via timing attack. These are not "over-engineering" concerns; they are "the system works correctly" concerns.

Moreover, property tests for `buildEnvVars` would take approximately 30 minutes to write given the existing test infrastructure. The ROI is immediate: you get coverage of 2^20 input combinations for the cost of articulating 4-5 invariants. The pragmatic choice is the one that gives more coverage per hour of engineering time, and for combinatorial logic, that's properties.

**Concession:** I would not argue for property tests on the Hono route handlers, the WebSocket upgrade negotiation, or the HTML templates. Those are integration-level concerns better served by integration tests or manual verification. Property tests target the pure logic beneath.

### Against Integration Testers: "Properties test in isolation, not in context"

**Acknowledged:** A property test on `buildEnvVars` doesn't tell you whether the container actually receives the environment variables. A property test on `findExistingMoltbotProcess` doesn't tell you whether Cloudflare's sandbox API actually returns processes in the expected format.

**Rebuttal:** This is a misunderstanding of the testing pyramid, not an argument against properties. Property tests and integration tests answer different questions:

- **Property test:** "Does `buildEnvVars` correctly implement the precedence specification for all possible inputs?"
- **Integration test:** "Does the container receive the environment variables that `buildEnvVars` produces?"

Both are necessary. Neither subsumes the other. But the property test is *cheaper to run* (milliseconds vs. seconds for container startup), *more thorough* (thousands of inputs vs. a handful), and *more maintainable* (invariants change less frequently than wiring).

The process classification logic in `findExistingMoltbotProcess` is a pure function from `(command: string, status: string) => boolean`. Testing it with property-based methods requires no mocking, no sandbox, and no integration. The integration test confirms that `sandbox.listProcesses()` returns the expected shape. The property test confirms that the classifier handles all strings correctly. These are complementary, not competing.

### Against Anti-Mock Realists: "Property tests still use synthetic inputs"

**Acknowledged:** fast-check generates random strings, not real JWT tokens. It generates random `MoltbotEnv` objects, not real Cloudflare Worker bindings. The inputs are synthetic by definition.

**Rebuttal:** This objection conflates "synthetic" with "unrealistic." A fast-check string generator produces strings that are *more adversarial* than real-world inputs: empty strings, strings with null bytes, strings with Unicode edge cases, extremely long strings. If your `timingSafeEqual` breaks on a 0-length string, fast-check will find it. If your URL normalization chokes on a string with embedded newlines, fast-check will find it. Real-world inputs are a *subset* of what fast-check generates.

For `buildEnvVars`, the generator would be:

```typescript
const envArb = fc.record({
  ANTHROPIC_API_KEY: fc.option(fc.string()),
  AI_GATEWAY_API_KEY: fc.option(fc.string()),
  AI_GATEWAY_BASE_URL: fc.option(fc.string()),
  ANTHROPIC_BASE_URL: fc.option(fc.string()),
  // ... remaining fields
}, { requiredKeys: [] });
```

This generates realistic-shaped configurations with random presence/absence of each field. It's not testing with "fake data" - it's testing with "all possible configurations." The synthetic inputs are the *strength*, not the weakness.

**Concession:** For testing behavior that depends on specific external formats (e.g., the exact structure of Cloudflare Access JWKS responses), property tests need custom generators that reflect the real format. Naive string generation won't help. But this is a generator design problem, not a fundamental limitation.

---

## Specific Property Tests for This Codebase

### Test 1: `buildEnvVars` Precedence Properties

```typescript
import * as fc from 'fast-check';
import { buildEnvVars } from './env';

const KNOWN_OUTPUT_KEYS = new Set([
  'CLOUDFLARE_AI_GATEWAY_API_KEY', 'CF_AI_GATEWAY_ACCOUNT_ID',
  'CF_AI_GATEWAY_GATEWAY_ID', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY',
  'AI_GATEWAY_BASE_URL', 'ANTHROPIC_BASE_URL', 'OPENCLAW_GATEWAY_TOKEN',
  'OPENCLAW_DEV_MODE', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_DM_POLICY',
  'DISCORD_BOT_TOKEN', 'DISCORD_DM_POLICY', 'SLACK_BOT_TOKEN',
  'SLACK_APP_TOKEN', 'CF_AI_GATEWAY_MODEL', 'CF_ACCOUNT_ID',
  'CDP_SECRET', 'WORKER_URL', 'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME',
]);

const moltbotEnvArb = fc.record({
  ANTHROPIC_API_KEY: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
  OPENAI_API_KEY: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
  AI_GATEWAY_API_KEY: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
  AI_GATEWAY_BASE_URL: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
  ANTHROPIC_BASE_URL: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
  CLOUDFLARE_AI_GATEWAY_API_KEY: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
  MOLTBOT_GATEWAY_TOKEN: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
  TELEGRAM_BOT_TOKEN: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
  // ... remaining fields
}, { requiredKeys: [] });

describe('buildEnvVars properties', () => {
  it('output keys are always a subset of known keys', () => {
    fc.assert(fc.property(moltbotEnvArb, (env) => {
      const result = buildEnvVars(env as any);
      for (const key of Object.keys(result)) {
        expect(KNOWN_OUTPUT_KEYS.has(key)).toBe(true);
      }
    }));
  });

  it('legacy gateway always overrides direct ANTHROPIC_API_KEY', () => {
    fc.assert(fc.property(moltbotEnvArb, (env) => {
      const result = buildEnvVars(env as any);
      if (env.AI_GATEWAY_API_KEY && env.AI_GATEWAY_BASE_URL) {
        expect(result.ANTHROPIC_API_KEY).toBe(env.AI_GATEWAY_API_KEY);
      }
    }));
  });

  it('URL normalization is idempotent', () => {
    fc.assert(fc.property(moltbotEnvArb, (env) => {
      const result = buildEnvVars(env as any);
      if (result.AI_GATEWAY_BASE_URL) {
        expect(result.AI_GATEWAY_BASE_URL).not.toMatch(/\/+$/);
      }
      if (result.ANTHROPIC_BASE_URL && env.AI_GATEWAY_API_KEY && env.AI_GATEWAY_BASE_URL) {
        expect(result.ANTHROPIC_BASE_URL).not.toMatch(/\/+$/);
      }
    }));
  });

  it('output values are always sourced from input values', () => {
    fc.assert(fc.property(moltbotEnvArb, (env) => {
      const result = buildEnvVars(env as any);
      const inputValues = new Set(Object.values(env).filter(Boolean));
      for (const value of Object.values(result)) {
        // Value is either directly from input or a normalized version
        const isFromInput = inputValues.has(value);
        const isNormalizedUrl = [...inputValues].some(
          (iv) => typeof iv === 'string' && iv.replace(/\/+$/, '') === value
        );
        expect(isFromInput || isNormalizedUrl).toBe(true);
      }
    }));
  });
});
```

### Test 2: Process Classification Properties

```typescript
const gatewayCommands = fc.oneof(
  fc.constant('openclaw gateway'),
  fc.constant('start-openclaw.sh'),
  fc.constant('clawdbot gateway'),
  fc.constant('start-moltbot.sh'),
);

const cliCommands = fc.oneof(
  fc.constant('openclaw devices'),
  fc.constant('openclaw --version'),
  fc.constant('openclaw onboard'),
  fc.constant('clawdbot devices'),
  fc.constant('clawdbot --version'),
);

const activeStatuses = fc.oneof(
  fc.constant('running' as const),
  fc.constant('starting' as const),
);

const inactiveStatuses = fc.oneof(
  fc.constant('completed' as const),
  fc.constant('failed' as const),
);

describe('findExistingMoltbotProcess properties', () => {
  it('active gateway commands are always detected', () => {
    fc.assert(fc.asyncProperty(gatewayCommands, activeStatuses, async (cmd, status) => {
      const proc = createFullMockProcess({ command: cmd, status });
      const { sandbox, listProcessesMock } = createMockSandbox();
      listProcessesMock.mockResolvedValue([proc]);
      const result = await findExistingMoltbotProcess(sandbox);
      expect(result).not.toBeNull();
    }));
  });

  it('CLI commands are never detected as gateway', () => {
    fc.assert(fc.asyncProperty(cliCommands, activeStatuses, async (cmd, status) => {
      const proc = createFullMockProcess({ command: cmd, status });
      const { sandbox, listProcessesMock } = createMockSandbox();
      listProcessesMock.mockResolvedValue([proc]);
      const result = await findExistingMoltbotProcess(sandbox);
      expect(result).toBeNull();
    }));
  });

  it('inactive gateway processes are never returned', () => {
    fc.assert(fc.asyncProperty(gatewayCommands, inactiveStatuses, async (cmd, status) => {
      const proc = createFullMockProcess({ command: cmd, status });
      const { sandbox, listProcessesMock } = createMockSandbox();
      listProcessesMock.mockResolvedValue([proc]);
      const result = await findExistingMoltbotProcess(sandbox);
      expect(result).toBeNull();
    }));
  });
});
```

### Test 3: `timingSafeEqual` Security Properties

```typescript
describe('timingSafeEqual properties', () => {
  it('is reflexive: every string equals itself', () => {
    fc.assert(fc.property(fc.string(), (s) => {
      expect(timingSafeEqual(s, s)).toBe(true);
    }));
  });

  it('is symmetric: equal(a, b) === equal(b, a)', () => {
    fc.assert(fc.property(fc.string(), fc.string(), (a, b) => {
      expect(timingSafeEqual(a, b)).toBe(timingSafeEqual(b, a));
    }));
  });

  it('agrees with strict equality for same-length strings', () => {
    fc.assert(fc.property(fc.string(), fc.string(), (a, b) => {
      if (a.length === b.length) {
        expect(timingSafeEqual(a, b)).toBe(a === b);
      }
    }));
  });

  it('rejects all strings that differ from the secret', () => {
    fc.assert(fc.property(fc.string({ minLength: 1 }), fc.string({ minLength: 1 }), (a, b) => {
      fc.pre(a !== b);
      expect(timingSafeEqual(a, b)).toBe(false);
    }));
  });
});
```

### Test 4: JWT Domain Normalization Properties

```typescript
describe('JWT domain normalization properties', () => {
  const validDomain = fc.stringMatching(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/);

  it('normalization is idempotent', () => {
    fc.assert(fc.property(validDomain, (domain) => {
      const once = domain.startsWith('https://') ? domain : `https://${domain}`;
      const twice = once.startsWith('https://') ? once : `https://${once}`;
      expect(once).toBe(twice);
    }));
  });

  it('normalized domain always starts with https://', () => {
    fc.assert(fc.property(validDomain, (domain) => {
      const normalized = domain.startsWith('https://') ? domain : `https://${domain}`;
      expect(normalized.startsWith('https://')).toBe(true);
    }));
  });

  it('normalized domain never has double https://', () => {
    fc.assert(fc.property(
      fc.oneof(validDomain, fc.constant('https://').chain(prefix => validDomain.map(d => prefix + d))),
      (domain) => {
        const normalized = domain.startsWith('https://') ? domain : `https://${domain}`;
        expect(normalized).not.toContain('https://https://');
      },
    ));
  });
});
```

### Test 5: R2 Sync Failure Isolation Properties

```typescript
describe('syncToR2 failure isolation properties', () => {
  const syncOutcome = fc.oneof(
    fc.constant('success'),
    fc.constant('config-fail'),
    fc.constant('workspace-fail'),
    fc.constant('skills-fail'),
  );

  it('config failure implies overall failure', () => {
    fc.assert(fc.asyncProperty(syncOutcome, async (outcome) => {
      const sandbox = createMockSandbox(/* configured for outcome */);
      if (outcome === 'config-fail') {
        const result = await syncToR2(sandbox, env);
        expect(result.success).toBe(false);
      }
    }));
  });

  it('workspace/skills failure does not imply overall failure', () => {
    fc.assert(fc.asyncProperty(
      fc.oneof(fc.constant('workspace-fail'), fc.constant('skills-fail')),
      async (outcome) => {
        // Configure sandbox where config succeeds but workspace/skills fail
        const result = await syncToR2(sandbox, env);
        expect(result.success).toBe(true);
      },
    ));
  });

  it('successful sync always includes a timestamp', () => {
    fc.assert(fc.asyncProperty(envArb, async (env) => {
      // Configure sandbox for full success
      const result = await syncToR2(sandbox, env);
      if (result.success) {
        expect(result.lastSync).toBeDefined();
        expect(() => new Date(result.lastSync!).toISOString()).not.toThrow();
      }
    }));
  });
});
```

---

## Proposed Rules for This Project

### Rule 1: Property Tests Are Required for Functions with Combinatorial Input Spaces

Any function that accepts a record/object with 5+ optional fields, or that implements conditional precedence logic, must have at least one property test asserting its core invariants. Currently applies to: `buildEnvVars`, `findExistingMoltbotProcess`, and future configuration builders.

**Rationale:** The number of meaningful input combinations grows exponentially with optional fields. Example-based tests cover O(n) cases; property tests cover O(2^n) implicitly.

### Rule 2: Security-Critical Code Gets Property Tests for Algebraic Properties

Any function involved in authentication, authorization, or secret comparison must have property tests for reflexivity, symmetry, transitivity (where applicable), and totality (it always returns, never hangs). Currently applies to: `timingSafeEqual`, `verifyAccessJWT` domain normalization, JWT middleware `extractJWT`.

**Rationale:** Security functions must be correct for *all* inputs, not just the ones an attacker hasn't tried yet. Properties encode this universality.

### Rule 3: Failure Isolation Properties for Multi-Step Operations

Any operation that performs multiple sub-operations with different failure semantics (fatal vs. non-fatal) must have a property test that generates all 2^n failure combinations and verifies the overall success/failure matches the specification. Currently applies to: `syncToR2`.

**Rationale:** Failure isolation bugs are the hardest to find by example because they only manifest in specific failure combinations. They are the easiest to find by property because the generator naturally explores the failure matrix.

### Rule 4: Invest in Generators as Reusable Project Assets

Create and maintain a `src/test-generators.ts` file containing fast-check `Arbitrary` definitions for the project's core types: `MoltbotEnv`, `Process` (with realistic command strings), `CDPRequest` (with valid method/params combinations), and `SyncResult`. These generators are shared across all property tests.

**Rationale:** The upfront cost of building good generators pays dividends across every test that uses them. A `MoltbotEnv` generator is written once and used by every test touching configuration logic.

### Rule 5: Properties Complement, Never Replace, Examples

Every property test file should include at least one traditional example test as documentation. The example shows what the function does; the property proves it does it correctly for all inputs. Property tests without examples are hard to read. Examples without properties are incomplete.

**Rationale:** Properties are specifications, not documentation. A developer reading `fc.property(envArb, (env) => { ... })` needs a concrete example to build intuition before understanding the abstract invariant.

### Rule 6: Start with Three, Expand with Bugs

Begin by adding property tests to the three highest-value targets: `buildEnvVars`, `timingSafeEqual`, and `findExistingMoltbotProcess`. For all other modules, add property tests reactively: whenever a bug is found that *could have been caught by a property*, write the property. This bounds the upfront investment while building the property test suite organically around actual failure modes.

**Rationale:** The pragmatists are right that unbounded investment is wasteful. But the solution isn't to avoid properties; it's to invest them where the cost-benefit ratio is highest and expand based on evidence.

---

## Honest Assessment of Costs

1. **Dependency:** Adds `fast-check` (~150KB, no transitive deps, well-maintained). Minimal risk.
2. **Learning curve:** 2-4 hours for first productive property test. Team-wide fluency in ~1 week with pair programming on the initial generators.
3. **Test runtime:** Property tests run 100 iterations by default (configurable). For pure functions like `buildEnvVars`, this adds <100ms. For async functions with mock setup, ~1-2 seconds. Negligible compared to container-based integration tests.
4. **Maintenance:** Properties change when *specifications* change, not when implementations change. This is more stable than example tests, which break on any refactor that changes intermediate behavior.
5. **Shrinking:** fast-check automatically shrinks failing inputs to minimal counterexamples. When a property fails, you get the *simplest* input that triggers the bug, not a 200-character random string. This makes debugging faster than with hand-written edge case tests.

---

## Conclusion

The PoeClaw codebase already has well-structured, testable pure functions (`buildEnvVars`, `findExistingMoltbotProcess`, `timingSafeEqual`, `verifyAccessJWT` normalization logic) surrounded by integration boundaries (sandbox API, R2 storage, WebSocket connections). Property-based testing is maximally effective precisely at this architecture: test the pure logic exhaustively with properties, test the integration boundaries with a smaller number of targeted integration tests. The result is a test suite that is both more thorough and more maintainable than either approach alone.

The question is not "property tests vs. example tests." The question is "which invariants does your codebase enforce, and can you prove it?" If you can write the invariant as a sentence, you can write it as a property. And a property that runs against 10,000 generated inputs is worth more than 10 hand-written examples that confirm what you already believe.
