// src/mastra/memory/vectorStore.ts
// import { PgVector } from '@mastra/pg'; // Remove Mastra PgVector import
import pgvector from 'pgvector/pg'; // Import the pgvector library
import { createOpenAI } from '@ai-sdk/openai';
import { env } from '../../utils/env.js';
import { db } from '../../db/index.js'; // Use pg-promise instance

// Initialize embedding model, explicitly providing the API key
const openai = createOpenAI({ apiKey: env.OPENAI_API_KEY });
export const embeddingModel = openai.embedding('text-embedding-ada-002');

// Register the vector type with node-postgres
// This needs to be done *before* the pool is used for vector operations
async function registerVectorType() {
  const client = await db.connect();
  try {
    // pg-promise's db.connect() returns an object where .client is the raw node-postgres client
    // pgvector.registerType expects the raw client object that has .query()
    await pgvector.registerType(client.client as any);
    console.log('pgvector type registered successfully.');
  } finally {
    client.done(); // Release connection back to pg-promise pool
  }
}
registerVectorType().catch(err => console.error('Failed to register pgvector type:', err));

// Note: The `pgvector` library itself doesn't provide a high-level "VectorStore" class like LangChain or LlamaIndex.
// It primarily provides helper functions for registering the type and performing vector operations in SQL queries.
// Therefore, we don't export a `vectorStore` instance in the same way.
// Interaction with the vector store will happen through direct SQL queries using the `db` instance and pgvector functions.

// Example function (replace with actual implementation in tools/agents):
// async function performSimilaritySearch(queryEmbedding: number[], limit: number) {
//   const queryEmbeddingString = pgvector.toSql(queryEmbedding);
//   const result = await db.query(
//     `SELECT ${env.PGVECTOR_CONTENT_COLUMN}, 1 - (${env.PGVECTOR_VECTOR_COLUMN} <=> $1) AS similarity
//      FROM ${env.PGVECTOR_TABLE_NAME}
//      ORDER BY similarity DESC
//      LIMIT $2`,
//     [queryEmbeddingString, limit]
//   );
//   return result.rows;
// }

// Function to initialize the vector store table (using direct SQL)
// This should likely be part of a database migration.
export async function initializeVectorStoreTable() {
  try {
    // Check if table exists, if not create it
    const tableExistsRes = await db.query(
      `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = $1);`,
      [env.PGVECTOR_TABLE_NAME],
    );
    if (!tableExistsRes.rows[0].exists) {
      await db.query(`CREATE TABLE ${env.PGVECTOR_TABLE_NAME} (
            ${env.PGVECTOR_ID_COLUMN} TEXT PRIMARY KEY DEFAULT gen_random_uuid(), 
            ${env.PGVECTOR_CONTENT_COLUMN} TEXT, 
            ${env.PGVECTOR_METADATA_COLUMN} JSONB, 
            ${env.PGVECTOR_VECTOR_COLUMN} vector(${env.PGVECTOR_EMBEDDING_DIMENSIONS})
        );`);
      // Optional: Add indexes like HNSW or IVFFlat after creation
      // await db.query(`CREATE INDEX ON ${env.PGVECTOR_TABLE_NAME} USING hnsw (${env.PGVECTOR_VECTOR_COLUMN} vector_l2_ops);`);
      console.log(`✅ Vector store table "${env.PGVECTOR_TABLE_NAME}" created.`);
    } else {
      console.log(`✅ Vector store table "${env.PGVECTOR_TABLE_NAME}" already exists.`);
    }
    return true;
  } catch (error) {
    console.error(`❌ Failed to initialize vector store table "${env.PGVECTOR_TABLE_NAME}":`, error);
    return false;
  }
}

// We might need to specify dimensions elsewhere if required by the database or downstream usage.
// For now, we rely on the default behavior of the model and pgvector.

// Remove PgVector store initialization
// export const vectorStore = new PgVector({ ... });

// Remove the function to initialize the vector store table
// export async function initializeVectorStore() { ... }
