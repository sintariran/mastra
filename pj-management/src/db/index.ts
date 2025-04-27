import pgPromise from 'pg-promise';
// import pgvector from 'pgvector/pg'; // Remove pgvector import
import { env } from '../utils/env.js'; // 環境変数ユーティリティを使用

// Remove pg-promise initialization options
/*
const initOptions = {
  // event called when a new connection is created
  connect(client: pgPromise.IClient) {
    // Register pgvector types for the newly connected client
    pgvector.registerType(client);
  },
};
*/

const pgp = pgPromise({
  /* Initialization Options */
}); // Revert to original pgp initialization

const dbConfig = {
  connectionString: env.DATABASE_URL,
  // Add other options like SSL if needed
};

// For simple queries using node-postgres Pool
// export const pool = new Pool(dbConfig); // Remove unused node-postgres Pool export

// For more complex queries using pg-promise
// Consider adjusting the type if needed, e.g., pgPromise.IDatabase<{}>
export const db = pgp(dbConfig);

// Database connection test function
export async function testConnection() {
  let client;
  try {
    // client = await pool.connect(); // Use pg-promise connection method instead
    client = await db.connect();
    console.log('✅ Database connection successful');
    return true;
  } catch (error) {
    console.error('❌ Database connection failed:', error);
    return false;
  } finally {
    // client?.release(); // pg-promise client needs to be released differently
    client?.done(); // Release the connection back to the pool
  }
}

// Graceful shutdown
process.on('exit', () => {
  pgp.end();
  // pool.end();
  console.log('Database connections closed.');
});
