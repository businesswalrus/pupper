#!/usr/bin/env node

const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

async function runMigrations() {
  console.log('Running database migrations...');
  
  try {
    const { stdout, stderr } = await execAsync('npx node-pg-migrate up');
    
    if (stdout) {
      console.log('Migration output:', stdout);
    }
    
    if (stderr) {
      console.error('Migration errors:', stderr);
    }
    
    console.log('Migrations completed successfully');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error.message);
    if (error.stdout) console.log('stdout:', error.stdout);
    if (error.stderr) console.error('stderr:', error.stderr);
    process.exit(1);
  }
}

runMigrations();