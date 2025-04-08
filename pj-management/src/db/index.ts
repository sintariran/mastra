import pg from 'pg';
const { Pool } = pg;

import pgPromise from 'pg-promise';
import { env } from '../utils/env.js'; // 環境変数ユーティリティを使用

const pgp = pgPromise({
  /* Initialization Options */
});

const dbConfig = {
  connectionString: env.DATABASE_URL,
  // Add other options like SSL if needed
};

// For simple queries using node-postgres Pool
export const pool = new Pool(dbConfig);

// For more complex queries using pg-promise
// Consider adjusting the type if needed, e.g., pgPromise.IDatabase<{}>
export const db = pgp(dbConfig);

// Database connection test function
export async function testConnection() {
  let client;
  try {
    client = await pool.connect();
    console.log('✅ Database connection successful');
    return true;
  } catch (error) {
    console.error('❌ Database connection failed:', error);
    return false;
  } finally {
    client?.release();
  }
}

// Graceful shutdown
process.on('exit', () => {
  pgp.end();
  pool.end();
  console.log('Database connections closed.');
});
