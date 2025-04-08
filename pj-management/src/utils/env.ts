import { z } from 'zod';
import path from 'path';
import { fileURLToPath } from 'url';

// Get directory name in ES module scope
// const __filename = fileURLToPath(import.meta.url);
// const __dirname = path.dirname(__filename);

// dotenv.config() is removed as mastra dev should handle it

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
