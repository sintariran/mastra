# Mastra Project General Rules

## 1. Project Overview

- This is a large monorepo for the Mastra project, managed with pnpm.
- The primary language is TypeScript.
- It contains core packages (`packages/`), integrations (`integrations/`), data stores (`stores/`), voice/speech capabilities (`speech/`, `voice/`), deployment helpers (`deployers/`), examples (`examples/`), and documentation (`docs/`).

## 2. Code Structure Awareness

- When working on a task, identify the relevant package(s) within the monorepo structure (e.g., `packages/core`, `integrations/github`).
- Understand that code might be spread across multiple packages. Check imports and dependencies.
- Look for tests within the relevant package (`src/` or `tests/` directories, usually ending in `.test.ts` or `.spec.ts`).
- This section (or a dedicated rule file) MUST contain an up-to-date representation of the high-level project folder structure. You may be asked to update this structure periodically based on the current state of the codebase.

## 3. Language and Formatting

- Write clean, idiomatic TypeScript code.
- Strictly follow the existing coding style, formatting, and linting rules defined by ESLint configurations (`eslint.config.js` or similar) found within the packages or the root. Adhere to existing code patterns.
- Keep functions and components focused on a single responsibility.

## 4. Package Management (pnpm)

- Use `pnpm` for all package management tasks.
- To add a dependency to a specific package: `pnpm add <dependency> --filter @mastra/<package-name>`
- To add a dev dependency to the workspace root (e.g., for scripts): `pnpm add -D -w <dependency>`
- Always check `package.json` for existing scripts before adding new ones.

## 5. Testing (Vitest)

- This project uses Vitest for testing.
- When adding new features or fixing bugs, include corresponding tests.
- Ensure existing tests pass after making changes. Run tests using `pnpm test` within the relevant package or from the root.

## 6. Commits and Documentation

- Follow Conventional Commits format for commit messages (e.g., `feat:`, `fix:`, `docs:`, `test:`, `refactor:`).
- Update relevant `README.md` files or documentation in the `docs/` directory if your changes affect usage or public APIs.
- Add TSDoc comments to exported functions, classes, and types to explain their purpose, parameters, and return values.

## 7. General Guidelines

- Do not introduce breaking changes to public APIs without careful consideration and documentation.
- Avoid adding large files or binaries to the repository.
- Unless specifically instructed, do not modify core configuration files (`tsconfig.json`, `eslint.config.js`, `vitest.config.ts`, `package.json` scripts, `pnpm-workspace.yaml`, `turbo.json`) or lockfiles (`pnpm-lock.yaml`).
- Prefer imports using workspace aliases (e.g., `@mastra/core`) over relative paths when crossing package boundaries.
  **- For specific questions about Mastra features, APIs, examples, or recent changes, utilize the available MCP tools (`mcp_mastra_mastraDocs`, `mcp_mastra_mastraExamples`, `mcp_mastra_mastraBlog`, `mcp_mastra_mastraChanges`). Consult the documentation first.**

---

**IMPORTANT REMINDER:** After modifying any `.md` file within the `rules/` directory, **ALWAYS** run `node scripts/generate-rules.mjs` to update the combined `.cursor/rules/project_rules.mdc` file. Failure to do so will result in the AI not using the latest rules.
