import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';

// Load environment
dotenv.config({ path: '.env.simple' });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function setupDatabase() {
  try {
    console.log('Setting up simplified database schema...');
    
    // Read the SQL file
    const sqlPath = path.join(__dirname, '..', 'migrations', 'simple_schema.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');
    
    // Execute the SQL
    await pool.query(sql);
    
    console.log('✓ Database schema created successfully');
    
    // Check if tables exist
    const tableCheck = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name IN ('users', 'messages')
    `);
    
    console.log('✓ Tables created:', tableCheck.rows.map(r => r.table_name).join(', '));
    
    // Check if pgvector is enabled
    const extensionCheck = await pool.query(`
      SELECT * FROM pg_extension WHERE extname = 'vector'
    `);
    
    if (extensionCheck.rows.length > 0) {
      console.log('✓ pgvector extension is enabled');
    } else {
      console.log('✗ pgvector extension not found - please install it');
    }
    
  } catch (error) {
    console.error('Error setting up database:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

// Run setup
setupDatabase();