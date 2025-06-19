import { pool } from '@db/connection';

export interface UserInteraction {
  id?: number;
  user_a_id: string;
  user_b_id: string;
  interaction_count?: number;
  topics_discussed?: string[];
  relationship_notes?: string;
  sentiment_score?: number;
  last_interaction_at?: Date;
  updated_at?: Date;
}

export class InteractionRepository {
  async findOrCreate(userAId: string, userBId: string): Promise<UserInteraction> {
    // Ensure consistent ordering (alphabetical)
    const [user1, user2] = [userAId, userBId].sort();

    // Try to find existing interaction
    const existingQuery = `
      SELECT * FROM user_interactions 
      WHERE user_a_id = $1 AND user_b_id = $2
    `;
    const existing = await pool.query(existingQuery, [user1, user2]);

    if (existing.rows.length > 0) {
      return existing.rows[0];
    }

    // Create new interaction
    const createQuery = `
      INSERT INTO user_interactions (user_a_id, user_b_id)
      VALUES ($1, $2)
      RETURNING *
    `;
    const result = await pool.query(createQuery, [user1, user2]);
    return result.rows[0];
  }

  async incrementInteraction(
    userAId: string, 
    userBId: string,
    topic?: string,
    sentiment?: number
  ): Promise<UserInteraction> {
    const [user1, user2] = [userAId, userBId].sort();

    // Build update query
    const updateParts = [
      'interaction_count = interaction_count + 1',
      'last_interaction_at = CURRENT_TIMESTAMP'
    ];
    const values: any[] = [user1, user2];
    let paramCount = 3;

    if (topic) {
      updateParts.push(`topics_discussed = 
        CASE 
          WHEN NOT topics_discussed @> $${paramCount}::jsonb 
          THEN topics_discussed || $${paramCount}::jsonb
          ELSE topics_discussed
        END`);
      values.push(JSON.stringify([topic]));
      paramCount++;
    }

    if (sentiment !== undefined) {
      updateParts.push(`sentiment_score = 
        CASE 
          WHEN sentiment_score IS NULL THEN $${paramCount}
          ELSE (sentiment_score * interaction_count + $${paramCount}) / (interaction_count + 1)
        END`);
      values.push(sentiment);
      paramCount++;
    }

    const query = `
      UPDATE user_interactions
      SET ${updateParts.join(', ')}
      WHERE user_a_id = $1 AND user_b_id = $2
      RETURNING *
    `;

    const result = await pool.query(query, values);
    
    if (result.rows.length === 0) {
      // Create if doesn't exist
      await this.findOrCreate(user1, user2);
      return this.incrementInteraction(userAId, userBId, topic, sentiment);
    }

    return result.rows[0];
  }

  async updateRelationshipNotes(
    userAId: string,
    userBId: string,
    notes: string
  ): Promise<UserInteraction | null> {
    const [user1, user2] = [userAId, userBId].sort();

    const query = `
      UPDATE user_interactions
      SET relationship_notes = $3
      WHERE user_a_id = $1 AND user_b_id = $2
      RETURNING *
    `;

    const result = await pool.query(query, [user1, user2, notes]);
    return result.rows[0] || null;
  }

  async getTopInteractions(
    userId: string,
    limit: number = 10
  ): Promise<UserInteraction[]> {
    const query = `
      SELECT * FROM user_interactions
      WHERE user_a_id = $1 OR user_b_id = $1
      ORDER BY interaction_count DESC
      LIMIT $2
    `;

    const result = await pool.query(query, [userId, limit]);
    return result.rows;
  }

  async getInteractionStats(userId: string): Promise<{
    totalInteractions: number;
    uniqueUsers: number;
    averageSentiment: number;
    topTopics: string[];
  }> {
    const statsQuery = `
      SELECT 
        SUM(interaction_count) as total_interactions,
        COUNT(*) as unique_users,
        AVG(sentiment_score) as avg_sentiment
      FROM user_interactions
      WHERE user_a_id = $1 OR user_b_id = $1
    `;

    const topicsQuery = `
      SELECT jsonb_array_elements_text(topics_discussed) as topic, COUNT(*) as count
      FROM user_interactions
      WHERE (user_a_id = $1 OR user_b_id = $1) AND topics_discussed IS NOT NULL
      GROUP BY topic
      ORDER BY count DESC
      LIMIT 5
    `;

    const [statsResult, topicsResult] = await Promise.all([
      pool.query(statsQuery, [userId]),
      pool.query(topicsQuery, [userId]),
    ]);

    const stats = statsResult.rows[0];
    const topTopics = topicsResult.rows.map((row: any) => row.topic);

    return {
      totalInteractions: parseInt(stats.total_interactions || '0'),
      uniqueUsers: parseInt(stats.unique_users || '0'),
      averageSentiment: parseFloat(stats.avg_sentiment || '0'),
      topTopics,
    };
  }

  async getRelationshipGraph(limit: number = 50): Promise<{
    nodes: Array<{ id: string; interactions: number }>;
    edges: Array<{ source: string; target: string; weight: number }>;
  }> {
    const query = `
      SELECT user_a_id, user_b_id, interaction_count
      FROM user_interactions
      ORDER BY interaction_count DESC
      LIMIT $1
    `;

    const result = await pool.query(query, [limit]);
    
    const nodes = new Map<string, number>();
    const edges = result.rows.map((row: any) => {
      // Track nodes
      nodes.set(row.user_a_id, (nodes.get(row.user_a_id) || 0) + row.interaction_count);
      nodes.set(row.user_b_id, (nodes.get(row.user_b_id) || 0) + row.interaction_count);

      return {
        source: row.user_a_id,
        target: row.user_b_id,
        weight: row.interaction_count,
      };
    });

    return {
      nodes: Array.from(nodes.entries()).map(([id, interactions]) => ({
        id,
        interactions,
      })),
      edges,
    };
  }
}

export const interactionRepository = new InteractionRepository();