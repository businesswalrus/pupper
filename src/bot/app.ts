import { App } from '@slack/bolt';
import { config } from '@utils/config';

export const app = new App({
  token: config.slack.botToken,
  signingSecret: config.slack.signingSecret,
  socketMode: true,
  appToken: config.slack.appToken,
  customRoutes: [
    {
      path: '/health',
      method: ['GET'],
      handler: async (req, res) => {
        const { healthCheckHandler } = await import('@utils/health');
        await healthCheckHandler(req, res);
      },
    },
  ],
});