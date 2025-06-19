import { ValidationError } from '@utils/errors';
import { logger } from '@utils/logger';

interface EnvVariable {
  name: string;
  required: boolean;
  type: 'string' | 'number' | 'boolean' | 'url';
  defaultValue?: any;
  validator?: (value: any) => boolean;
}

const ENV_SCHEMA: EnvVariable[] = [
  // Slack Configuration
  {
    name: 'SLACK_BOT_TOKEN',
    required: true,
    type: 'string',
    validator: (v) => v.startsWith('xoxb-'),
  },
  {
    name: 'SLACK_APP_TOKEN',
    required: true,
    type: 'string',
    validator: (v) => v.startsWith('xapp-'),
  },
  {
    name: 'SLACK_SIGNING_SECRET',
    required: true,
    type: 'string',
  },
  {
    name: 'MY_USER_ID',
    required: true,
    type: 'string',
    validator: (v) => v.startsWith('U'),
  },
  // OpenAI Configuration
  {
    name: 'OPENAI_API_KEY',
    required: true,
    type: 'string',
    validator: (v) => v.startsWith('sk-'),
  },
  // Database Configuration
  {
    name: 'DATABASE_URL',
    required: false,
    type: 'url',
    defaultValue: 'postgresql://localhost:5432/pup_ai_v2',
  },
  // Redis Configuration
  {
    name: 'REDIS_URL',
    required: false,
    type: 'url',
    defaultValue: 'redis://localhost:6379',
  },
  // App Configuration
  {
    name: 'NODE_ENV',
    required: false,
    type: 'string',
    defaultValue: 'development',
    validator: (v) => ['development', 'production', 'test'].includes(v),
  },
  {
    name: 'PORT',
    required: false,
    type: 'number',
    defaultValue: 3000,
  },
  {
    name: 'LOG_LEVEL',
    required: false,
    type: 'string',
    defaultValue: 'info',
    validator: (v) => ['debug', 'info', 'warn', 'error'].includes(v),
  },
];

export function validateEnvironment(): void {
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const variable of ENV_SCHEMA) {
    const value = process.env[variable.name];

    // Check required variables
    if (variable.required && !value) {
      errors.push(`Missing required environment variable: ${variable.name}`);
      continue;
    }

    // Apply default values
    if (!value && variable.defaultValue !== undefined) {
      process.env[variable.name] = String(variable.defaultValue);
      logger.debug(`Using default value for ${variable.name}: ${variable.defaultValue}`);
      continue;
    }

    // Skip validation if not present and not required
    if (!value) continue;

    // Type validation
    switch (variable.type) {
      case 'number':
        if (isNaN(Number(value))) {
          errors.push(`${variable.name} must be a number, got: ${value}`);
        }
        break;
      
      case 'boolean':
        if (!['true', 'false', '1', '0'].includes(value.toLowerCase())) {
          errors.push(`${variable.name} must be a boolean, got: ${value}`);
        }
        break;
      
      case 'url':
        try {
          new URL(value);
        } catch {
          errors.push(`${variable.name} must be a valid URL, got: ${value}`);
        }
        break;
    }

    // Custom validation
    if (variable.validator && !variable.validator(value)) {
      errors.push(`${variable.name} failed validation: ${value}`);
    }
  }

  // Additional validation checks
  if (process.env.NODE_ENV === 'production') {
    // Production-specific checks
    if (!process.env.DATABASE_URL || process.env.DATABASE_URL.includes('localhost')) {
      warnings.push('Using localhost database in production');
    }
    if (!process.env.REDIS_URL || process.env.REDIS_URL.includes('localhost')) {
      warnings.push('Using localhost Redis in production');
    }
  }

  // Log warnings
  warnings.forEach(warning => logger.warn(warning));

  // Throw if there are errors
  if (errors.length > 0) {
    throw new ValidationError(
      'Environment validation failed',
      { errors }
    );
  }

  logger.info('Environment validation passed');
}

// Validate on module load
validateEnvironment();