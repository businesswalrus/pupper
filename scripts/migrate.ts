// Simple migration runner for production
import { runMigrations } from '../src/simple/db';

async function main() {
  console.log('Running database migrations...');
  await runMigrations();
  console.log('Migrations complete!');
  process.exit(0);
}

main().catch((error) => {
  console.error('Migration failed:', error);
  process.exit(1);
});