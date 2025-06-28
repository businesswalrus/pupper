import { pool } from '../db/connection.simple';
import { logger } from '../utils/logger.simple';

export async function getRelevantMessages(
  query: string,
  channelId: string,
  limit: number = 20
): Promise<any[]> {
  try {
    // First try semantic search if we have embeddings
    const result = await pool.query(`
      SELECT 
        m.message_ts,
        m.slack_user_id,
        m.message_text,
        m.created_at,
        u.username
      FROM messages m
      LEFT JOIN users u ON m.slack_user_id = u.slack_user_id
      WHERE m.channel_id = $1
        AND m.embedding IS NOT NULL
      ORDER BY m.created_at DESC
      LIMIT $2
    `, [channelId, limit * 2]); // Get more than needed, we'll filter
    
    // If we have messages with embeddings, do semantic search
    // For now, just return recent messages
    // TODO: Implement actual vector similarity search
    
    return result.rows.slice(0, limit);
  } catch (error) {
    logger.error('Error retrieving messages:', error);
    return [];
  }
}