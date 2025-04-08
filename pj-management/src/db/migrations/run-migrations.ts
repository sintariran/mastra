import pg from 'pg';
const { Pool } = pg;
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

// Get current directory using import.meta.url
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../../../.env') }); // Now __dirname is defined

// Log the DATABASE_URL being used by this script
console.log('Migration script using DATABASE_URL:', process.env.DATABASE_URL);

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function runMigrations() {
  const client = await pool.connect();
  try {
    const migrationsDir = __dirname; // Assumes script is in migrations dir
    const files = fs
      .readdirSync(migrationsDir)
      .filter(file => file.endsWith('.sql'))
      .sort(); // Ensure order

    for (const file of files) {
      console.log(`Applying migration: ${file}`);
      const filePath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(filePath, 'utf-8');
      await client.query(sql);
      console.log(`Applied migration: ${file}`);
    }
    console.log('All migrations applied successfully.');
  } catch (err) {
    console.error('Migration failed:', err);
    // Consider adding transaction rollback here if needed
  } finally {
    client.release();
    await pool.end();
  }
}

runMigrations();
