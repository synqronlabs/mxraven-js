# AGENTS.md

## Project

`mxraven-js` is the TypeScript SDK for the **mail-facing** mxRaven runtime
surfaces:

- **SMTP submission** — the default entry point (`@mxraven/mail`).
- **Webhook verification and decoding** — `@mxraven/mail/webhook`.
- **Recipient feedback and RFC 8058 one-click unsubscribe** — `@mxraven/mail/feedback`.

It is the TypeScript counterpart of the Go SDK at
`github.com/synqronlabs/mxraven-go/mail` and must expose equivalent capabilities
behind an idiomatic TypeScript API.

Control-plane administration — suppression lists, deliverability reporting,
mail analytics, API-key management — is **out of scope**. It lives in the Go
`admin` SDK.

The Go SDK and the upstream `raven` SMTP library are kept under `tmp/`
(gitignored) for reference. Read them to understand behavior, wire formats, and
edge cases, but **never import from, depend on, or ship anything under `tmp/`**.

## Core Principles

- Write code that is easy to read, review, test, and maintain.
- Prefer the Node.js standard library. The SDK currently has **zero runtime
  dependencies** and should keep it that way unless a dependency provides clear,
  substantial value that cannot be reasonably implemented locally.
- Keep abstractions proportional to the problem. Do not add interfaces,
  generics, wrappers, or configuration layers speculatively.
- Minimize the exported API. Every exported symbol is a long-lived compatibility
  commitment.
- Preserve backward compatibility unless a breaking change is intentional,
  documented, and released under the appropriate SemVer major version.
- Leave the codebase simpler than you found it.

## Tech Stack

| Concern                | Tool                                                      | Config                              |
| ---------------------- | --------------------------------------------------------- | ----------------------------------- |
| Package manager        | pnpm (pin the version in `packageManager`)                | `package.json`                      |
| Language / typecheck   | TypeScript via `tsc --noEmit`, strict, NodeNext           | `tsconfig.json`                     |
| Build (dual ESM + CJS) | tsdown (Rolldown), declarations + source maps             | `tsdown.config.ts`                  |
| Testing                | Vitest                                                    | `vitest.config.ts`                  |
| Lint                   | oxlint (native plugins + `eslint-plugin-tsdoc`)           | `.oxlintrc.json`                    |
| Format                 | oxfmt                                                     | `.oxfmtrc.json`                     |
| API docs               | TypeDoc + `typedoc-plugin-markdown`                       | `typedoc.json`                      |
| Versioning / release   | Changesets, published from GitHub Actions with provenance | `.changeset/`, `.github/workflows/` |
| Types                  | `@types/node`                                             | `tsconfig.json` `types`             |

## Commands

```sh
pnpm install          # install dependencies
pnpm run build        # tsdown: dual ESM + CJS + declarations
pnpm run typecheck    # tsc --noEmit
pnpm run test         # vitest run
pnpm run test:watch   # vitest watch
pnpm run lint         # oxlint (includes tsdoc/syntax)
pnpm run lint:fix     # oxlint --fix
pnpm run format       # oxfmt (writes)
pnpm run format:check # oxfmt --check
pnpm run docs         # typedoc -> docs/
pnpm run check        # format:check + lint + typecheck + test + build
pnpm run changeset    # record a release note
```

Run `pnpm run check` before considering any change complete. Add new files to
the appropriate ignore lists (`.oxlintrc.json`, `.oxfmtrc.json`) only when
necessary.

## TypeScript Style

### Module system

- The package is **ESM-first** (`"type": "module"`) and compiles to both ESM and
  CJS. Write source in ESM only.
- `module` and `moduleResolution` are `NodeNext`. **Relative imports and exports
  must include the `.js` extension**, even though the source is `.ts`:

  ```ts
  import { SmtpClient } from "./client.js";
  ```

- Use `import type` / `export type` for type-only imports and re-exports.
  `verbatimModuleSyntax` is enabled, so a value import that is only used as a
  type will not be elided.
- **Use named exports only.** Do not use default exports.
- Import Node built-ins with the `node:` protocol:

  ```ts
  import { createHmac, timingSafeEqual } from "node:crypto";
  ```

### Types

- `strict` is enabled. Do not weaken it, and do not add per-file `@ts-ignore` or
  `@ts-expect-error` without an adjacent justification.
- **Do not use `any`.** Use `unknown` and narrow it.
- Prefer precise, narrow types and discriminated unions over optional-field
  grab bags.
- Use `interface` for public object shapes and `type` for unions, aliases, and
  utility compositions.
- Mark values that must not be mutated as `readonly`; prefer `readonly T[]` or
  `ReadonlyArray<T>` for array inputs.
- **Avoid `enum`.** Use a `const` object plus a derived union so the values are
  tree-shakeable and map cleanly to the wire format:

  ```ts
  /** Lifecycle state reported by a delivery-status webhook. */
  export const statusOutcome = {
    /** A delivery attempt started. */
    attempted: "attempted",
    /** The destination accepted the message. */
    delivered: "delivered",
  } as const;

  /** Lifecycle state reported by a delivery-status webhook. */
  export type StatusOutcome = (typeof statusOutcome)[keyof typeof statusOutcome];
  ```

- Avoid non-null assertions (`!`) and unchecked casts (`as`). When a cast is
  unavoidable — for example immediately after parsing untrusted JSON — keep it
  at the boundary and document why.
- Prefer `satisfies` to assert shape without widening.

### Naming

- `PascalCase` for types, interfaces, classes, and error classes.
- `camelCase` for functions, methods, variables, parameters, and properties.
- `UPPER_SNAKE_CASE` only for true module-level constants.
- Prefix booleans with `is`, `has`, `can`, or `should`.
- Do not use Hungarian prefixes (`IUser`, `TValue`).
- Match the Go SDK's public concept names where practical so the two SDKs stay
  recognizable, but follow TypeScript casing.

### Functions and control flow

- Keep functions small and focused on one responsibility.
- Prefer early returns over nested conditionals.
- Prefer an **options object** over three or more positional parameters.
- Use `async`/`await`. Never mix callback and promise styles.
- Any operation that performs network or filesystem I/O should accept an
  `AbortSignal` (typically as `options.signal`) so callers can cancel it. This is
  the TypeScript equivalent of the Go SDK's `context.Context` parameter.
- Do not hold a lock across arbitrary user-provided callbacks.

## Public API Design

Treat every exported symbol as long-lived API.

- Keep the public surface as small as possible. Do not export implementation
  details.
- New exported APIs require TSDoc and tests.
- Prefer APIs that are hard to misuse.
- Do not export a type or interface solely so callers can mock an
  implementation.
- Avoid adding methods to existing public interfaces; it is a breaking change.
- Clearly document, in TSDoc, the ownership, mutation, and concurrency rules of
  any accepted or returned buffers, streams, maps, and objects.
- Accept `Uint8Array` for raw bytes. Do not assume callers hold `Buffer`, and do
  not expose `Buffer` in the public API unless necessary.
- Constructor options should be a single readonly options object with sensible
  defaults.

## Error Handling

**Don't just check errors; handle them gracefully.** Errors are part of the
public API.

- Give errors stable programmatic identity with exported custom error classes
  when callers need to branch on them. Mirror the Go SDK's semantics:

  ```ts
  /** An SMTP reply that rejected a submission. */
  export class SMTPError extends Error {
    /** The three-digit SMTP reply code. */
    readonly code: number;

    /** The RFC 3463 enhanced status code, when the server supplied one. */
    readonly enhancedCode?: string;

    constructor(options: { code: number; enhancedCode?: string; message: string }) {
      super(options.message);
      this.name = "SMTPError";
      this.code = options.code;
      this.enhancedCode = options.enhancedCode;
    }

    /** Reports whether the failure is permanent (5xx). */
    get permanent(): boolean {
      return this.code >= 500 && this.code < 600;
    }
  }
  ```

- Always set `name` on custom error classes.
- Use the `cause` option when wrapping to preserve the original error:

  ```ts
  throw new Error("mail: acquire connection", { cause: err });
  ```

- Add context only when the layer contributes useful information. Do not
  mechanically wrap at every frame.
- **Never make control flow depend on matching an error message string.** Branch
  on `instanceof`, error properties, or documented fields.
- Document thrown errors with `@throws` in TSDoc when they are part of the
  contract.
- Do not log ordinary operation errors in library code. Return them and let the
  application decide how to report them.
- Do not swallow errors. If a cleanup or close operation can fail and the
  failure matters, propagate it.
- Use `AggregateError` when multiple independent failures must be preserved.

## TSDoc

Documentation is part of the API. TSDoc syntax is validated by oxlint via
`tsdoc/syntax`, so malformed comments fail `pnpm run lint`.

- Every entry point starts with a `@packageDocumentation` block.
- Every exported type, interface, class, function, method, and constant has a
  TSDoc block.
- Every public symbol is tagged `@public`. Use `@beta` / `@alpha` while an API
  is unstable, and `@internal` for symbols that must not appear in the public
  documentation or API surface. TypeDoc is configured with `excludeInternal`.
- Start with a one-sentence summary. Use `@remarks` for detail that does not
  belong in the summary.
- Use `@param`, `@returns`, `@throws`, `@typeParam`, `@defaultValue`, and
  `@example` as appropriate.
- Use `{@link Symbol}` for cross-references and `{@link https://url}` for
  external links.
- Reference code identifiers with backticks, not `{@link}`.
- Include an `@example` (fenced `ts` block) whenever correct use is not obvious.
- Explain **why**, invariants, constraints, surprising decisions, ownership
  rules, and error semantics. Do not merely restate the identifier.
- Use TSDoc tags only. Do not use JSDoc-only tags such as `@typedef`,
  `@callback`, or `@property`; model those with TypeScript types instead.

Example:

````ts
/**
 * Sends a composed message and returns the server's result.
 *
 * A result is returned alongside an error when the server replied but
 * rejected the transaction, because per-recipient detail remains useful.
 *
 * @param message - The message to submit. It may be sent more than once.
 * @param options - Optional cancellation signal.
 * @returns The server's result for the submission.
 * @throws {@link SMTPError} When the server rejects the transaction.
 *
 * @example
 * ```ts
 * const result = await client.send(message, { signal });
 * ```
 *
 * @public
 */
````

## Testing

- Tests use Vitest and are co-located as `src/**/*.test.ts`.
- Test observable behavior and the public contract, not implementation details.
- Include edge cases and failure paths. Cover error semantics with
  `expect(...).toBeInstanceOf` / `rejects.toThrow`.
- Prefer `it.each` for table-driven cases over repetitive tests.
- Keep tests independent and order-insensitive. Use `beforeEach`/`afterEach` for
  setup and teardown.
- **Never depend on the real network.** Use `vi.stubGlobal`, dependency
  injection, a local in-process fake SMTP/HTTP server, or fixtures. The webhook
  and feedback clients talk to `fetch`; stub it.
- Use `vi.useFakeTimers()` for time-dependent behavior rather than real delays.
- Do not assert on complete error message strings unless the human-readable
  output is explicitly contractual.
- Add a regression test for every bug fix.
- **Port the relevant cases from the Go SDK and `raven` test suites** whenever
  you implement behavior that mirrors them (`tmp/mxraven-go`, `tmp/raven`).
  Parity must be verified, not assumed. Adapt table-driven Go tests with
  `it.each`, and note any deliberate divergence in the test or TSDoc.

## Build and Packaging

- `tsdown` produces dual ESM + CJS output with `.d.ts` / `.d.cts` declarations
  and source maps. **Never edit `dist/` or `docs/` by hand** — both are
  generated and gitignored.
- Public entry points are declared in `package.json` `exports`. When you add a
  subpath (for example `./webhook`), add it to:
  1. `tsdown.config.ts` `entry`
  2. `typedoc.json` `entryPoints`
  3. `package.json` `exports`
- Each entry point gets its own `src/<name>/index.ts` and
  `@packageDocumentation` block.
- Generated declaration files are part of the contract. Run `pnpm run build` and
  inspect the emitted `.d.ts` whenever the public API changes.
- The build is validated with `publint` (`pnpm dlx publint`) whenever `exports`
  or the output layout changes. Keep `exports` and file extensions consistent
  (`./dist/index.js`, `./dist/index.cjs`, `./dist/index.d.ts`,
  `./dist/index.d.cts`).

## Versioning and Releases

- The package follows Semantic Versioning.
- Record every user-visible change with `pnpm run changeset`, describing the
  change and the required SemVer bump. `feat` → minor, `fix` → patch,
  breaking → major.
- Do not use the pre-1.0 status as an excuse for unnecessary API churn.
- Deprecate before removing public APIs whenever practical, using a `@deprecated`
  TSDoc tag that names the replacement.
- Releases run through the Changesets GitHub Actions workflow, which publishes
  to npm with provenance (`npm publish --provenance`). Do not publish manually
  from a workstation.

## Commits

Use Conventional Commits:

```text
<type>[optional scope][!]: <description>
```

Common types: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `build`, `ci`,
`chore`. Use imperative, concise descriptions without a trailing period. Mark
breaking changes with `!` and a `BREAKING CHANGE:` footer.

Keep commits focused. Do not mix unrelated refactoring with functional changes.
Only commit when explicitly asked.

## Dependencies

Before adding a dependency:

1. Determine whether the Node.js standard library is sufficient.
2. Evaluate the maintenance, bundle, and compatibility cost.
3. Confirm it solves substantially more than a small local implementation would.
4. Avoid exposing dependency-specific types through the public API.

Prefer zero runtime dependencies. Dev dependencies for tooling are acceptable
when they are already part of the established toolchain.

## Security

- Never log or embed secrets: the SMTP submission secret, the webhook signing
  secret, and raw-email access tokens are all sensitive.
- Compare signatures and tokens with a timing-safe comparison
  (`node:crypto` `timingSafeEqual`), not `===`.
- Treat all external input (HTTP responses, webhook bodies, SMTP replies) as
  untrusted and validate or bound it before use.
- Bound network reads with explicit size limits and timeouts, and expose an
  `AbortSignal` so callers can cancel.

## Concurrency

- Document whether each public type is safe for concurrent use.
- The SMTP client maintains a bounded pool of connections; keep the pool
  implementation free of data races and do not hold locks across I/O callbacks.
- Prefer synchronous, deterministic logic unless concurrency provides a
  measurable or structural benefit.
- Never start a task without a clear termination path; avoid unhandled promise
  rejections.

## Definition of Done

A change is complete when:

- the implementation is idiomatic, appropriately simple TypeScript;
- error cases are handled deliberately and preserve useful context;
- exported APIs have complete, valid TSDoc and a `@public` / `@internal` tag;
- tests cover the new or changed behavior, including failure paths;
- `pnpm run check` succeeds (format, lint, typecheck, test, build);
- `pnpm run docs` succeeds and the generated output looks correct;
- public compatibility and the required SemVer impact have been considered;
- a changeset describes the user-visible effect.
