# Mastra Basics (from Documentation)

## 1. Installation & Setup

- **Prerequisites:** Node.js v20+, LLM API Key (OpenAI, Anthropic, Google Gemini, etc.) or local setup (Ollama).
- **Recommended Method:** Use `npx create-mastra@latest`. This interactive CLI scaffolds the project, letting you choose components (Agents, Tools, Workflows), a default LLM provider, include example code, and optionally set up MCP server integration (for Cursor/Windsurf).
- **Manual Setup:** Possible via `npm/pnpm/yarn/bun`, requires installing `@mastra/core`, `typescript`, `zod`, etc., setting up `tsconfig.json`, `.env` for API keys, and manually creating initial agents/tools.
- **API Keys:** Store LLM provider API keys in the `.env` file (e.g., `OPENAI_API_KEY=...`).

## 2. Recommended Project Structure (`src/mastra`)

- `create-mastra` suggests organizing Mastra code within `src/mastra`.
- **`src/mastra/index.ts`:** The main entry point where the `Mastra` class is instantiated and components are registered.
- **`src/mastra/agents/`:** Contains Agent definitions (e.g., `weatherAgent.ts`). Often includes an `index.ts` to export agents.
- **`src/mastra/tools/`:** Contains Tool definitions (e.g., `weather-tool.ts`). Often includes an `index.ts` to export tools.
- **`src/mastra/workflows/`:** Contains Workflow definitions. Often includes an `index.ts` to export workflows.

## 3. Core Concepts (`@mastra/core`)

- **`Mastra` Class:** The central registry instantiated in `src/mastra/index.ts`. It manages:
  - `agents`: Registered Agent instances.
  - `tools`: Registered Tool instances.
  - `workflows`: Registered Workflow instances.
  - `storage`: Optional persistence layer.
  - `vectors`: Optional vector store instances (for RAG).
  - `logger`: Optional custom logger.
  - `serverMiddleware`: Optional middleware for API routes.
- **Agents:** Core reasoning units, often using LLMs and Tools to fulfill requests. Defined with instructions, a model, and associated tools.
- **Tools:** Functions that Agents can call to interact with external systems or perform specific tasks (e.g., fetching weather, searching a database). Defined with `createTool`, including `id`, `description`, `inputSchema` (Zod), `outputSchema` (Zod), and an `execute` function.
- **Workflows:** Define sequences or graphs of steps involving Agents, Tools, or other logic.

## 4. Running & Interacting

- **Development Server:** `mastra dev` (or `npm run dev`/`pnpm dev` etc.) starts a server (default: `http://localhost:4111`) exposing registered agents as REST API endpoints (e.g., `/api/agents/weatherAgent/generate`).
- **Direct Execution:** Agents can be run directly from scripts using `mastra.getAgent()` and calling methods like `agent.generate()`. Run scripts with `npx tsx src/index.ts`.
- **Client Interaction:** Use `@mastra/client-js` SDK in frontend applications to interact with the Mastra REST API in a type-safe manner.

## 5. Key Packages

- **`@mastra/core`:** The main package containing the `Mastra` class, `Agent` class, `createTool`, `createWorkflow`, etc.
- **`@ai-sdk/...`:** Used for interacting with different LLM providers (e.g., `@ai-sdk/openai`).
- **`zod`:** Used for defining input/output schemas for Tools and potentially other validation tasks.
- **`@mastra/client-js`:** Frontend SDK.
- **`create-mastra`:** Scaffolding CLI tool.
