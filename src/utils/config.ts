import * as dotenv from 'dotenv';

dotenv.config();

interface Config {
  slack: {
    botToken: string;
    appToken: string;
    signingSecret: string;
    myUserId: string;
  };
  openai: {
    apiKey: string;
  };
  database: {
    url: string;
  };
  redis: {
    url: string;
  };
  app: {
    port: number;
    nodeEnv: string;
  };
}

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config: Config = {
  slack: {
    botToken: getRequiredEnv('SLACK_BOT_TOKEN'),
    appToken: getRequiredEnv('SLACK_APP_TOKEN'),
    signingSecret: getRequiredEnv('SLACK_SIGNING_SECRET'),
    myUserId: getRequiredEnv('MY_USER_ID'),
  },
  openai: {
    apiKey: getRequiredEnv('OPENAI_API_KEY'),
  },
  database: {
    url: process.env.DATABASE_URL || 'postgresql://localhost:5432/pup_ai_v2',
  },
  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
  },
  app: {
    port: parseInt(process.env.PORT || '3000', 10),
    nodeEnv: process.env.NODE_ENV || 'development',
  },
};