import { SlackEventMiddlewareArgs, SlackCommandMiddlewareArgs } from '@slack/bolt';
import { WebClient, ChatPostMessageResponse } from '@slack/web-api';

// Mock Slack message event
export const createMockMessageEvent = (overrides: any = {}): SlackEventMiddlewareArgs<'message'> => {
  const defaults = {
    message: {
      type: 'message',
      channel: 'C1234567890',
      user: 'U1234567890',
      ts: '1234567890.123456',
      text: 'Test message',
      team: 'T1234567890',
      ...overrides.message,
    },
    event: {
      type: 'message',
      channel: 'C1234567890',
      user: 'U1234567890',
      ts: '1234567890.123456',
      text: 'Test message',
      team: 'T1234567890',
      ...overrides.event,
    },
    say: jest.fn().mockResolvedValue({ ok: true }),
    ack: jest.fn().mockResolvedValue(undefined),
    respond: jest.fn().mockResolvedValue({ ok: true }),
    client: createMockWebClient(),
    logger: createMockLogger(),
    context: {
      botUserId: 'U0987654321',
      botId: 'B0987654321',
      teamId: 'T1234567890',
      userId: 'U1234567890',
      isEnterpriseInstall: false,
      ...overrides.context,
    },
    body: {
      team_id: 'T1234567890',
      api_app_id: 'A1234567890',
      event: {
        type: 'message',
        channel: 'C1234567890',
        user: 'U1234567890',
        ts: '1234567890.123456',
        text: 'Test message',
        team: 'T1234567890',
      },
      type: 'event_callback',
      event_id: 'Ev1234567890',
      event_time: 1234567890,
      ...overrides.body,
    },
    ...overrides,
  };

  return defaults as SlackEventMiddlewareArgs<'message'>;
};

// Mock Slack command
export const createMockSlashCommand = (overrides: any = {}): SlackCommandMiddlewareArgs => {
  const defaults = {
    command: {
      token: 'test-token',
      team_id: 'T1234567890',
      team_domain: 'test-team',
      channel_id: 'C1234567890',
      channel_name: 'test-channel',
      user_id: 'U1234567890',
      user_name: 'test-user',
      command: '/test',
      text: 'test command',
      api_app_id: 'A1234567890',
      is_enterprise_install: 'false',
      response_url: 'https://hooks.slack.com/test',
      trigger_id: '1234567890.123456',
      ...overrides.command,
    },
    ack: jest.fn().mockResolvedValue(undefined),
    respond: jest.fn().mockResolvedValue({ ok: true }),
    say: jest.fn().mockResolvedValue({ ok: true }),
    client: createMockWebClient(),
    logger: createMockLogger(),
    context: {
      botUserId: 'U0987654321',
      botId: 'B0987654321',
      teamId: 'T1234567890',
      userId: 'U1234567890',
      isEnterpriseInstall: false,
      ...overrides.context,
    },
    body: overrides.body || overrides.command,
    ...overrides,
  };

  return defaults as SlackCommandMiddlewareArgs;
};

// Mock WebClient
export const createMockWebClient = (overrides: any = {}): WebClient => {
  const mockClient = {
    chat: {
      postMessage: jest.fn().mockResolvedValue({
        ok: true,
        channel: 'C1234567890',
        ts: '1234567890.123456',
        message: {
          text: 'Test response',
          user: 'U0987654321',
          ts: '1234567890.123456',
          team: 'T1234567890',
        },
      } as ChatPostMessageResponse),
      update: jest.fn().mockResolvedValue({ ok: true }),
      delete: jest.fn().mockResolvedValue({ ok: true }),
      postEphemeral: jest.fn().mockResolvedValue({ ok: true }),
    },
    users: {
      info: jest.fn().mockResolvedValue({
        ok: true,
        user: {
          id: 'U1234567890',
          name: 'test-user',
          real_name: 'Test User',
          profile: {
            display_name: 'Test User',
            real_name: 'Test User',
            email: 'test@example.com',
          },
        },
      }),
      list: jest.fn().mockResolvedValue({
        ok: true,
        members: [],
      }),
    },
    conversations: {
      info: jest.fn().mockResolvedValue({
        ok: true,
        channel: {
          id: 'C1234567890',
          name: 'test-channel',
          is_channel: true,
          is_group: false,
          is_im: false,
          is_private: false,
        },
      }),
      members: jest.fn().mockResolvedValue({
        ok: true,
        members: ['U1234567890', 'U0987654321'],
      }),
      history: jest.fn().mockResolvedValue({
        ok: true,
        messages: [],
      }),
    },
    reactions: {
      add: jest.fn().mockResolvedValue({ ok: true }),
      remove: jest.fn().mockResolvedValue({ ok: true }),
    },
    ...overrides,
  };

  return mockClient as unknown as WebClient;
};

// Mock logger
export const createMockLogger = () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  setLevel: jest.fn(),
  getLevel: jest.fn(),
  setName: jest.fn(),
});

// Mock user data
export const mockUsers = {
  testUser: {
    id: 'U1234567890',
    name: 'test-user',
    real_name: 'Test User',
    profile: {
      display_name: 'Test User',
      real_name: 'Test User',
      email: 'test@example.com',
      image_512: 'https://example.com/avatar.png',
    },
  },
  botUser: {
    id: 'U0987654321',
    name: 'pup-bot',
    real_name: 'Pup Bot',
    is_bot: true,
    profile: {
      display_name: 'Pup',
      real_name: 'Pup Bot',
    },
  },
};

// Mock channel data
export const mockChannels = {
  general: {
    id: 'C1234567890',
    name: 'general',
    is_channel: true,
    is_group: false,
    is_im: false,
    is_private: false,
    is_member: true,
  },
  random: {
    id: 'C0987654321',
    name: 'random',
    is_channel: true,
    is_group: false,
    is_im: false,
    is_private: false,
    is_member: true,
  },
  dm: {
    id: 'D1234567890',
    is_im: true,
    is_channel: false,
    is_group: false,
    is_private: true,
    user: 'U1234567890',
  },
};