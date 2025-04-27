### 8.2. Type Safety

- Strictly avoid the `any` type. Use specific interfaces, types, or `unknown` with type guards.
- For Tool `execute` functions, correctly type the `executionContext` argument using `ToolExecutionContext<typeof inputSchema>` (import from `@mastra/core`).
- When using `pg-promise`, ensure query results are properly typed, especially when dealing with `JSONB` (`client_info` etc.) which maps to `unknown`.
- For vector-related functionality with `pgvector`:
  - Properly type vector embeddings as number arrays with the correct dimensions.
  - Use appropriate type assertions (with `as const` or explicit types) when working with vector similarity queries.
- In Plan-Execute patterns (Auto-Run), ensure plan schemas enforce a strict contract:
  - Use discriminated unions (`z.discriminatedUnion`) with action types.
  - Properly type dynamic toolId lookup to catch invalid tool references at runtime.
  - Apply narrowing techniques to handle conditional parameter requirements.

### 8.5. Environment Variables and Local Development

- Store environment variables in a `.env` file **in the package root directory** where the `mastra dev` command will be executed.
- Do not rely on environment variables from parent directories in a monorepo - they may not be correctly loaded.
- Apply strict validation in `src/utils/env.ts` using Zod schemas:
  - Required variables should use `z.string().min(1)` or `.url()` to enforce presence and correct format.
  - Optional variables should provide sensible defaults (`z.string().default("default-value")`).
- When troubleshooting environment variable issues:
  - Create test scripts (e.g., `test-env.mjs`) to verify basic `dotenv` functionality.
  - For persistent issues with `mastra dev`, use direct environment variable passing as a workaround:
    - `DATABASE_URL="..." OPENAI_API_KEY="..." pnpm exec mastra dev`
- Minimize replication of environment setup across scripts; prefer centralizing validation in `env.ts`.
- Document all required environment variables in a `.env.example` file for team onboarding.
