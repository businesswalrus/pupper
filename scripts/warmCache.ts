#!/usr/bin/env tsx

import { messageRepository } from '@db/repositories';
import { cache } from '@services/cache';
import { logger } from '@utils/logger';
import { pool } from '@db/connection';

async function warmCache() {
  logger.info('Starting cache warming...');

  try {
    // Get active channels
    const channelQuery = `
      SELECT DISTINCT channel_id, COUNT(*) as message_count
      FROM messages
      WHERE created_at > NOW() - INTERVAL '7 days'
      GROUP BY channel_id
      ORDER BY message_count DESC
      LIMIT 20
    `;
    
    const result = await pool.query(channelQuery);
    const channels = result.rows.map(r => r.channel_id);
    
    logger.info(`Found ${channels.length} active channels to warm`);

    // Warm message cache
    await (messageRepository as any).warmCache(channels);
    
    // Warm frequently accessed data
    for (const channelId of channels) {
      // Recent messages
      await messageRepository.getRecentMessages(channelId, 24, 100);
      
      // Message count
      await messageRepository.countByChannel(channelId);
    }
    
    // Get cache stats
    const stats = cache.getStats();
    logger.info('Cache warming complete', { stats });
    
    process.exit(0);
  } catch (error) {
    logger.error('Cache warming failed', { error: error as Error });
    process.exit(1);
  }
}

warmCache();