import dotenv from 'dotenv';
dotenv.config();

// Simple config with only essentials
export const config = {
  // App
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  
  // Slack
  slackBotToken: process.env.SLACK_BOT_TOKEN!,
  slackAppToken: process.env.SLACK_APP_TOKEN!,
  slackSigningSecret: process.env.SLACK_SIGNING_SECRET!,
  myUserId: process.env.SLACK_BOT_USER_ID || 'U12345678',
  
  // Database
  databaseUrl: process.env.DATABASE_URL!,
  
  // Redis
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  
  // OpenAI
  openaiApiKey: process.env.OPENAI_API_KEY!,
};

// Basic validation
const requiredVars = [
  'SLACK_BOT_TOKEN',
  'SLACK_APP_TOKEN', 
  'SLACK_SIGNING_SECRET',
  'DATABASE_URL',
  'OPENAI_API_KEY'
];

for (const varName of requiredVars) {
  if (!process.env[varName]) {
    console.error(`Missing required environment variable: ${varName}`);
    process.exit(1);
  }
}

console.log('Environment validated successfully');