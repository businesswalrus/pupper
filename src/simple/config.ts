import { config as dotenvConfig } from 'dotenv';

// Load environment variables
dotenvConfig();

// Validate required environment variables
const requiredEnvVars = [
  'SLACK_BOT_TOKEN',
  'SLACK_APP_TOKEN',
  'OPENAI_API_KEY',
  'DATABASE_URL',
];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    throw new Error(`Missing required environment variable: ${envVar}`);
  }
}

export const config = {
  slack: {
    botToken: process.env.SLACK_BOT_TOKEN!,
    appToken: process.env.SLACK_APP_TOKEN!,
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY!,
    model: 'gpt-3.5-turbo',
    maxTokens: 150,
    temperature: 0.8,
  },
  db: {
    connectionString: process.env.DATABASE_URL!,
    maxConnections: 10,
  },
  app: {
    contextMessageCount: 10,
    responseTimeout: 10000, // 10 seconds
  },
} as const;