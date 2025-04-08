import { initializeVectorStoreTable } from '../mastra/memory/vectorStore.js';
import { pool } from './index.js'; // Import pool to potentially close if needed

async function main() {
  console.log('Attempting to initialize vector store table...');
  const success = await initializeVectorStoreTable();
  if (success) {
    console.log('Vector store table initialization process completed successfully.');
  } else {
    console.error('Vector store table initialization process failed.');
    process.exitCode = 1; // Set exit code to indicate failure
  }
  // Remove explicit pool.end() call - let the process.on('exit') handler in db/index.ts handle it
  // await pool.end();
}

main();
