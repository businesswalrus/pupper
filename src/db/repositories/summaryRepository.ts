import { pool } from '@db/connection';

export interface ConversationSummary {
  id?: number;
  channel_id: string;
  summary: string;
  key_topics?: string[];
  participant_ids?: string[];
  mood?: string;
  notable_moments?: any[];
  start_ts: string;
  end_ts: string;
  message_count?: number;
  created_at?: Date;
}

export class SummaryRepository {
  async create(summary: ConversationSummary): Promise<ConversationSummary> {
    const query = `
      INSERT INTO conversation_summaries (
        channel_id, summary, key_topics, participant_ids,
        mood, notable_moments, start_ts, end_ts, message_count
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
    `;

    const values = [
      summary.channel_id,
      summary.summary,
      JSON.stringify(summary.key_topics || []),
      JSON.stringify(summary.participant_ids || []),
      summary.mood || null,
      JSON.stringify(summary.notable_moments || []),
      summary.start_ts,
      summary.end_ts,
      summary.message_count || 0,
    ];

    const result = await pool.query(query, values);
    return result.rows[0];
  }

  async findByChannel(
    channelId: string,
    limit: number = 10
  ): Promise<ConversationSummary[]> {
    const query = `
      SELECT * FROM conversation_summaries 
      WHERE channel_id = $1 
      ORDER BY created_at DESC 
      LIMIT $2
    `;
    const result = await pool.query(query, [channelId, limit]);
    return result.rows;
  }

  async findRecent(
    hours: number = 24,
    limit: number = 20
  ): Promise<ConversationSummary[]> {
    const query = `
      SELECT * FROM conversation_summaries 
      WHERE created_at >= NOW() - INTERVAL $1
      ORDER BY created_at DESC 
      LIMIT $2
    `;
    const result = await pool.query(query, [`${hours} hours`, limit]);
    return result.rows;
  }

  async getLastSummaryTime(channelId: string): Promise<Date | null> {
    const query = `
      SELECT MAX(created_at) as last_summary 
      FROM conversation_summaries 
      WHERE channel_id = $1
    `;
    const result = await pool.query(query, [channelId]);
    return result.rows[0]?.last_summary || null;
  }

  async searchByTopics(topics: string[]): Promise<ConversationSummary[]> {
    const query = `
      SELECT * FROM conversation_summaries 
      WHERE key_topics ?| $1
      ORDER BY created_at DESC
      LIMIT 50
    `;
    const result = await pool.query(query, [topics]);
    return result.rows;
  }
}

export const summaryRepository = new SummaryRepository();