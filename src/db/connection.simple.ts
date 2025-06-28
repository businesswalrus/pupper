import { Pool } from 'pg';
import { config } from '../utils/config.simple';

// Simple connection pool
export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 10, // Basic pool size
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Test connection
export async function testConnection() {
  try {
    const client = await pool.connect();
    await client.query('SELECT 1');
    client.release();
    console.log('Database connection successful');
  } catch (error) {
    console.error('Database connection failed:', error);
    throw error;
  }
}

// Close pool
export async function closePool() {
  await pool.end();
}