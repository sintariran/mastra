import { z } from 'zod';
import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

// Get directory name in ES module scope
// const __filename = fileURLToPath(import.meta.url);
// const __dirname = path.dirname(__filename);

// dotenv.config(); // Removed

// --- Load .env by walking up the directory tree ----------------------------------
// This allows us to place a single .env at the repo root while packages live in
// sub-directories (e.g. pj-management/) and compiled code runs from .mastra/output.

(() => {
  // Start from the directory of this file (compiled path at runtime)
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    const candidate = path.join(dir, '.env');
    if (fs.existsSync(candidate)) {
      loadEnv({ path: candidate });
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
})();
// -------------------------------------------------------------------------------

const envSchema = z.object({
  OPENAI_API_KEY: z.string().min(1),
  DATABASE_URL: z.string().url(),
  PORT: z.coerce.number().default(4111),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  PGVECTOR_TABLE_NAME: z.string().default('embeddings'),
  PGVECTOR_ID_COLUMN: z.string().default('id'),
  PGVECTOR_VECTOR_COLUMN: z.string().default('embedding'),
  PGVECTOR_CONTENT_COLUMN: z.string().default('content'),
  PGVECTOR_METADATA_COLUMN: z.string().default('metadata'),
  PGVECTOR_EMBEDDING_DIMENSIONS: z.coerce.number().default(1536),
});

// Log check removed

// Assume process.env is populated correctly by the time this is evaluated
export const env = envSchema.parse(process.env);
