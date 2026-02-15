# Claude Code Instructions

Guidelines for Claude Code when working on this codebase.

## Project

PoeClaw — a Cloudflare Worker that runs OpenClaw AI assistant in a Cloudflare Sandbox container. See [README.md](./README.md) for user-facing docs, [AGENTS.md](./AGENTS.md) for technical agent instructions.

## Philosophy

Read [`docs/PHILOSOPHY.md`](./docs/PHILOSOPHY.md) before making changes. It defines our layered defense strategy for quality:

- **Layer 0: CI Guardrails** — lint, format, typecheck must pass. No `--no-verify`.
- **Layer 1: Types** — minimize `as any`, use exhaustive pattern matching, share types across server/client.
- **Layer 2: Unit Tests** — test pure logic and security boundaries. Don't test route registration or HTML templates.
- **Layer 3: Property Tests** — use for combinatorial config (`buildEnvVars`), security code, classification logic.
- **Layer 4: Contract Tests** — define API boundary promises before implementing.
- **Layer 5: Integration Tests** — real dependencies for boundary behavior. Mocks are necessary lies.
- **Layer 6: Deploy Safety** — health checks and post-deploy verification.

### Key Principles

1. **Test behavior, not implementation.** Tests verify *what* code promises, not *how* it works.
2. **Security code gets the full treatment.** Auth, credentials, secrets — no shortcuts.
3. **Mocks are necessary lies.** Use for fast feedback on pure logic. Don't trust for boundary behavior.
4. **Pragmatism is not laziness.** Use the Severity x Detectability matrix: test where severity is high and detectability is low.

## Commands

```bash
npm test              # Run tests (vitest)
npm run test:watch    # Watch mode
npm run typecheck     # TypeScript strict check
npm run lint          # oxlint
npm run format:check  # oxfmt
npm run build         # Build worker + client
npm run deploy        # Build and deploy to Cloudflare
```

## Working Here

- Read [AGENTS.md](./AGENTS.md) for project structure, patterns, and common tasks.
- Read [CONTRIBUTING.md](./CONTRIBUTING.md) for contribution rules and AI policy.
- Tests are colocated: `foo.ts` → `foo.test.ts` in the same directory.
- Use the existing mock infrastructure in `src/test-utils.ts` for new tests.
- When adding a test, include a threat-model comment: what failure mode does it catch?
- Run `npm run typecheck && npm run lint && npm test` before considering work complete.
