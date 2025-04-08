import pg from 'pg';
// dotenv is not strictly needed now as we hardcode the URL for testing
// import dotenv from 'dotenv';
// dotenv.config();

const { Pool } = pg;

// Construct connection string to connect to the default 'postgres' database
const connectionString = 'postgresql://postgres:postgres@127.0.0.1:5432/postgres';

const pool = new Pool({
  connectionString: connectionString,
});

async function testConnection() {
  let client;
  try {
    console.log(`Attempting to connect to: ${connectionString}`);
    client = await pool.connect();
    console.log('Successfully connected to the "postgres" database!');

    // Try listing databases
    const res = await client.query('SELECT datname FROM pg_database WHERE datistemplate = false;');
    console.log(
      'Available databases found:',
      res.rows.map(row => row.datname),
    );

    // Check if 'mastra' is in the list
    if (res.rows.map(row => row.datname).includes('mastra')) {
      console.log('--> "mastra" database IS visible after connecting to "postgres" database.');
    } else {
      console.log('--> "mastra" database IS NOT visible after connecting to "postgres" database.');
    }
  } catch (err) {
    console.error('Error during database test:', err);
  } finally {
    if (client) {
      await client.release();
      console.log('Client released.');
    }
    await pool.end();
    console.log('Pool ended.');
  }
}

testConnection();
