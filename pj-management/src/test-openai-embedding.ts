import { openai } from '@ai-sdk/openai';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Load .env explicitly (relative to this file in src/)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') }); // Go one level up from src

async function testEmbedding() {
  console.log('Testing OpenAI Embedding API call directly...');
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    console.error('❌ OPENAI_API_KEY not found in environment variables.');
    process.exit(1);
    return;
  }
  console.log(`Using API Key starting with: ${apiKey.substring(0, 10)}...`);

  try {
    // Initialize embedding model - it should pick up the env var automatically
    const embeddingModel = openai.embedding('text-embedding-ada-002');

    // Alternatively, try initializing the provider instance explicitly (though docs imply automatic)
    // const openaiProvider = createOpenAI({ apiKey }); // Check if createOpenAI exists
    // const embeddingModel = openaiProvider.embedding('text-embedding-ada-002');

    console.log('Calling doEmbed...');
    const result = await embeddingModel.doEmbed({ values: ['Test embedding string'] });
    console.log('✅ Embedding API call successful!');
    console.log('Embedding vector (first 5 dimensions):', result.embeddings[0].slice(0, 5));
  } catch (error) {
    console.error('❌ Error calling OpenAI Embedding API:');
    console.error(error); // Log the full error
    process.exitCode = 1;
  }
}

testEmbedding();
