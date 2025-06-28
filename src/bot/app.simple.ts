import { App, ExpressReceiver } from '@slack/bolt';
import { config } from '../utils/config.simple';

// Create Express receiver with health check
const receiver = new ExpressReceiver({
  signingSecret: config.slackSigningSecret,
});

// Add health check endpoint
receiver.app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Create Bolt app
export const app = new App({
  token: config.slackBotToken,
  socketMode: true,
  appToken: config.slackAppToken,
  receiver,
});