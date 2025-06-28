/**
 * Feature flags system for progressive feature rollout
 * Supports environment-based and user-based feature toggles
 */

import { logger } from './logger';

export enum FeatureFlag {
  SEARCH = 'search',
  PROFILING = 'profiling',
  MCP_EXTENDED = 'mcp_extended',
  DEBUG_MODE = 'debug_mode',
  RATE_LIMIT = 'rate_limit',
  ADVANCED_MEMORY = 'advanced_memory',
  SENTIMENT_ANALYSIS = 'sentiment_analysis',
  AUTO_SUMMARIZATION = 'auto_summarization',
  MULTI_LANGUAGE = 'multi_language',
  VOICE_NOTES = 'voice_notes',
}

interface IFeatureFlagConfig {
  name: FeatureFlag;
  description: string;
  defaultValue: boolean;
  rolloutPercentage?: number;
  allowedUsers?: string[];
  blockedUsers?: string[];
}

// Feature flag configurations
const FEATURE_CONFIGS: Record<FeatureFlag, IFeatureFlagConfig> = {
  [FeatureFlag.SEARCH]: {
    name: FeatureFlag.SEARCH,
    description: 'Enable web search integration via Brave Search',
    defaultValue: true,
  },
  [FeatureFlag.PROFILING]: {
    name: FeatureFlag.PROFILING,
    description: 'Enable user personality profiling',
    defaultValue: true,
  },
  [FeatureFlag.MCP_EXTENDED]: {
    name: FeatureFlag.MCP_EXTENDED,
    description: 'Enable extended MCP server capabilities',
    defaultValue: false,
  },
  [FeatureFlag.DEBUG_MODE]: {
    name: FeatureFlag.DEBUG_MODE,
    description: 'Enable verbose debug logging',
    defaultValue: process.env.NODE_ENV === 'development',
  },
  [FeatureFlag.RATE_LIMIT]: {
    name: FeatureFlag.RATE_LIMIT,
    description: 'Enable API rate limiting',
    defaultValue: true,
  },
  [FeatureFlag.ADVANCED_MEMORY]: {
    name: FeatureFlag.ADVANCED_MEMORY,
    description: 'Enable advanced memory retrieval algorithms',
    defaultValue: false,
    rolloutPercentage: 50,
  },
  [FeatureFlag.SENTIMENT_ANALYSIS]: {
    name: FeatureFlag.SENTIMENT_ANALYSIS,
    description: 'Enable sentiment analysis on messages',
    defaultValue: false,
    rolloutPercentage: 25,
  },
  [FeatureFlag.AUTO_SUMMARIZATION]: {
    name: FeatureFlag.AUTO_SUMMARIZATION,
    description: 'Enable automatic conversation summarization',
    defaultValue: true,
  },
  [FeatureFlag.MULTI_LANGUAGE]: {
    name: FeatureFlag.MULTI_LANGUAGE,
    description: 'Enable multi-language support',
    defaultValue: false,
  },
  [FeatureFlag.VOICE_NOTES]: {
    name: FeatureFlag.VOICE_NOTES,
    description: 'Enable voice note transcription',
    defaultValue: false,
    allowedUsers: ['U001ALICE'], // Beta testers
  },
};

export class FeatureFlagService {
  private static instance: FeatureFlagService;
  private enabledFlags: Set<FeatureFlag>;
  private overrides: Map<string, Map<FeatureFlag, boolean>>;

  private constructor() {
    this.enabledFlags = new Set();
    this.overrides = new Map();
    this.loadFromEnvironment();
  }

  static getInstance(): FeatureFlagService {
    if (!FeatureFlagService.instance) {
      FeatureFlagService.instance = new FeatureFlagService();
    }
    return FeatureFlagService.instance;
  }

  /**
   * Load feature flags from environment variables
   */
  private loadFromEnvironment(): void {
    const envFlags = process.env.FEATURE_FLAGS?.split(',').map(f => f.trim()) || [];
    
    for (const flag of Object.values(FeatureFlag)) {
      const config = FEATURE_CONFIGS[flag];
      
      // Check if explicitly enabled in environment
      if (envFlags.includes(flag)) {
        this.enabledFlags.add(flag);
        logger.debug(`Feature flag enabled from environment: ${flag}`);
      } else if (config.defaultValue) {
        this.enabledFlags.add(flag);
        logger.debug(`Feature flag enabled by default: ${flag}`);
      }
    }
  }

  /**
   * Check if a feature flag is enabled
   */
  isEnabled(flag: FeatureFlag, userId?: string): boolean {
    // Check user-specific override first
    if (userId && this.overrides.has(userId)) {
      const userOverrides = this.overrides.get(userId)!;
      if (userOverrides.has(flag)) {
        return userOverrides.get(flag)!;
      }
    }

    const config = FEATURE_CONFIGS[flag];

    // Check user allowlist/blocklist
    if (userId) {
      if (config.blockedUsers?.includes(userId)) {
        return false;
      }
      if (config.allowedUsers && !config.allowedUsers.includes(userId)) {
        return false;
      }
    }

    // Check rollout percentage
    if (config.rolloutPercentage !== undefined && userId) {
      const hash = this.hashUserId(userId);
      const percentage = (hash % 100) + 1;
      if (percentage > config.rolloutPercentage) {
        return false;
      }
    }

    return this.enabledFlags.has(flag);
  }

  /**
   * Enable a feature flag globally
   */
  enable(flag: FeatureFlag): void {
    this.enabledFlags.add(flag);
    logger.info(`Feature flag enabled: ${flag}`);
  }

  /**
   * Disable a feature flag globally
   */
  disable(flag: FeatureFlag): void {
    this.enabledFlags.delete(flag);
    logger.info(`Feature flag disabled: ${flag}`);
  }

  /**
   * Set user-specific override
   */
  setUserOverride(userId: string, flag: FeatureFlag, enabled: boolean): void {
    if (!this.overrides.has(userId)) {
      this.overrides.set(userId, new Map());
    }
    this.overrides.get(userId)!.set(flag, enabled);
    logger.debug(`User override set: ${userId} - ${flag} = ${enabled}`);
  }

  /**
   * Clear user-specific overrides
   */
  clearUserOverrides(userId: string): void {
    this.overrides.delete(userId);
    logger.debug(`User overrides cleared: ${userId}`);
  }

  /**
   * Get all enabled feature flags
   */
  getEnabledFlags(): FeatureFlag[] {
    return Array.from(this.enabledFlags);
  }

  /**
   * Get feature flag configuration
   */
  getConfig(flag: FeatureFlag): IFeatureFlagConfig {
    return FEATURE_CONFIGS[flag];
  }

  /**
   * Get all feature configurations
   */
  getAllConfigs(): IFeatureFlagConfig[] {
    return Object.values(FEATURE_CONFIGS);
  }

  /**
   * Hash user ID for rollout percentage calculation
   */
  private hashUserId(userId: string): number {
    let hash = 0;
    for (let i = 0; i < userId.length; i++) {
      const char = userId.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash);
  }
}

// Singleton instance
export const featureFlags = FeatureFlagService.getInstance();

// Helper function for easy feature flag checking
export function isFeatureEnabled(flag: FeatureFlag, userId?: string): boolean {
  return featureFlags.isEnabled(flag, userId);
}

// Decorator for feature flag gating
export function RequiresFeature(flag: FeatureFlag) {
  return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value;

    descriptor.value = async function (...args: any[]) {
      // Try to extract userId from common patterns
      const userId = args[0]?.userId || args[0]?.user?.id || args[0]?.slackUserId;
      
      if (!isFeatureEnabled(flag, userId)) {
        logger.warn(`Feature ${flag} is not enabled for user ${userId || 'unknown'}`);
        throw new Error(`Feature ${flag} is not enabled`);
      }

      return originalMethod.apply(this, args);
    };

    return descriptor;
  };
}