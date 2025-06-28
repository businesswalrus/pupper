#!/usr/bin/env node

// Production start script that handles migrations and startup
const { exec } = require('child_process');
const path = require('path');

console.log('Starting pup.ai v2 in production mode...');

// Check if we need to run migrations
const runMigrations = process.env.RUN_MIGRATIONS !== 'false';

if (runMigrations) {
  console.log('Running database migrations...');
  
  exec('node scripts/migrate.js', (error, stdout, stderr) => {
    if (error) {
      console.error('Migration error:', error);
      console.error('stderr:', stderr);
      // Don't exit on migration error - the app might still work
    } else {
      console.log('Migrations completed successfully');
      console.log(stdout);
    }
    
    // Start the application regardless of migration status
    startApp();
  });
} else {
  console.log('Skipping migrations (RUN_MIGRATIONS=false)');
  startApp();
}

function startApp() {
  console.log('Starting application...');
  require('../dist/bootstrap.js');
}