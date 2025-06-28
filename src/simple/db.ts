import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

export interface Message {
  id?: number;
  slack_user_id: string;
  channel_id: string;
  message_text: string;
  message_ts: string;
  thread_ts?: string;
  embedding?: number[];
  created_at?: Date;
}

export async function runMigrations(): Promise<void> {
  try {
    // Create migrations table if it doesn't exist
    await pool.query(`
      CREATE TABLE IF NOT EXISTS migrations (
        id SERIAL PRIMARY KEY,
        filename VARCHAR(255) UNIQUE NOT NULL,
        executed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Get list of executed migrations
    const result = await pool.query('SELECT filename FROM migrations');
    const executed = new Set(result.rows.map(r => r.filename));
    
    // Read migration files
    const migrationsDir = path.join(process.cwd(), 'migrations');
    if (!fs.existsSync(migrationsDir)) {
      console.log('No migrations directory found, skipping migrations');
      return;
    }
    
    const files = fs.readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort();
    
    // Execute new migrations
    for (const file of files) {
      if (!executed.has(file)) {
        console.log(`Running migration: ${file}`);
        const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
        await pool.query(sql);
        await pool.query('INSERT INTO migrations (filename) VALUES ($1)', [file]);
      }
    }
    
    console.log('Migrations completed');
  } catch (error) {
    console.error('Migration error:', error);
    // Don't throw - allow app to start even if migrations fail
  }
}

export async function saveMessage(message: Message): Promise<Message> {
  const query = `
    INSERT INTO messages (
      slack_user_id, channel_id, message_text, message_ts, thread_ts
    ) VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (message_ts) DO UPDATE SET
      message_text = EXCLUDED.message_text
    RETURNING *
  `;
  
  const values = [
    message.slack_user_id,
    message.channel_id,
    message.message_text,
    message.message_ts,
    message.thread_ts || null,
  ];
  
  const result = await pool.query(query, values);
  return result.rows[0];
}

export async function getRecentMessages(
  channelId: string,
  limit: number = 20
): Promise<Message[]> {
  const query = `
    SELECT * FROM messages 
    WHERE channel_id = $1 
    ORDER BY created_at DESC 
    LIMIT $2
  `;
  
  const result = await pool.query(query, [channelId, limit]);
  return result.rows.reverse(); // Return in chronological order
}

export async function updateEmbedding(
  messageId: number,
  embedding: number[]
): Promise<void> {
  const query = `
    UPDATE messages 
    SET embedding = $1
    WHERE id = $2
  `;
  
  await pool.query(query, [`[${embedding.join(',')}]`, messageId]);
}

export async function searchSimilarMessages(
  embedding: number[],
  limit: number = 10
): Promise<Message[]> {
  const query = `
    SELECT *, 1 - (embedding <=> $1::vector) as similarity
    FROM messages
    WHERE embedding IS NOT NULL
    ORDER BY embedding <=> $1::vector
    LIMIT $2
  `;
  
  const result = await pool.query(query, [`[${embedding.join(',')}]`, limit]);
  return result.rows;
}