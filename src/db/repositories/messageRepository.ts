import { pool } from '@db/connection';

export interface Message {
  id?: number;
  slack_user_id: string;
  channel_id: string;
  message_text: string;
  message_ts: string;
  thread_ts?: string;
  parent_user_ts?: string;
  context?: Record<string, any>;
  embedding?: number[];
  embedding_model?: string;
  created_at?: Date;
}

export interface MessageSearchOptions {
  channel_id?: string;
  user_id?: string;
  thread_ts?: string;
  limit?: number;
  offset?: number;
  start_date?: Date;
  end_date?: Date;
}

export class MessageRepository {
  async create(message: Message): Promise<Message> {
    const query = `
      INSERT INTO messages (
        slack_user_id, channel_id, message_text, message_ts,
        thread_ts, parent_user_ts, context, embedding, embedding_model
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (message_ts) DO UPDATE SET
        message_text = EXCLUDED.message_text,
        context = EXCLUDED.context
      RETURNING *
    `;

    const values = [
      message.slack_user_id,
      message.channel_id,
      message.message_text,
      message.message_ts,
      message.thread_ts || null,
      message.parent_user_ts || null,
      JSON.stringify(message.context || {}),
      message.embedding || null,
      message.embedding_model || null,
    ];

    const result = await pool.query(query, values);
    return result.rows[0];
  }

  async findByTimestamp(messageTs: string): Promise<Message | null> {
    const query = 'SELECT * FROM messages WHERE message_ts = $1';
    const result = await pool.query(query, [messageTs]);
    return result.rows[0] || null;
  }

  async findByChannel(
    channelId: string,
    options: MessageSearchOptions = {}
  ): Promise<Message[]> {
    let query = 'SELECT * FROM messages WHERE channel_id = $1';
    const values: any[] = [channelId];
    let paramCount = 2;

    if (options.thread_ts) {
      query += ` AND thread_ts = $${paramCount}`;
      values.push(options.thread_ts);
      paramCount++;
    }

    if (options.start_date) {
      query += ` AND created_at >= $${paramCount}`;
      values.push(options.start_date);
      paramCount++;
    }

    if (options.end_date) {
      query += ` AND created_at <= $${paramCount}`;
      values.push(options.end_date);
      paramCount++;
    }

    query += ' ORDER BY created_at DESC';

    if (options.limit) {
      query += ` LIMIT $${paramCount}`;
      values.push(options.limit);
      paramCount++;
    }

    if (options.offset) {
      query += ` OFFSET $${paramCount}`;
      values.push(options.offset);
    }

    const result = await pool.query(query, values);
    return result.rows;
  }

  async updateEmbedding(
    messageTs: string,
    embedding: number[],
    model: string
  ): Promise<Message | null> {
    const query = `
      UPDATE messages 
      SET embedding = $1, embedding_model = $2
      WHERE message_ts = $3
      RETURNING *
    `;

    const result = await pool.query(query, [
      `[${embedding.join(',')}]`,
      model,
      messageTs,
    ]);
    return result.rows[0] || null;
  }

  async findSimilar(
    embedding: number[],
    limit: number = 10,
    threshold: number = 0.7
  ): Promise<Message[]> {
    const query = `
      SELECT *, 1 - (embedding <=> $1::vector) as similarity
      FROM messages
      WHERE embedding IS NOT NULL
      AND 1 - (embedding <=> $1::vector) > $2
      ORDER BY embedding <=> $1::vector
      LIMIT $3
    `;

    const embeddingStr = `[${embedding.join(',')}]`;
    const result = await pool.query(query, [embeddingStr, threshold, limit]);
    return result.rows;
  }

  async getMessagesWithoutEmbeddings(limit: number = 100): Promise<Message[]> {
    const query = `
      SELECT * FROM messages 
      WHERE embedding IS NULL 
      ORDER BY created_at ASC 
      LIMIT $1
    `;
    const result = await pool.query(query, [limit]);
    return result.rows;
  }

  async countByChannel(channelId: string): Promise<number> {
    const query = 'SELECT COUNT(*) FROM messages WHERE channel_id = $1';
    const result = await pool.query(query, [channelId]);
    return parseInt(result.rows[0].count, 10);
  }

  async getRecentMessages(
    channelId: string,
    hours: number = 24,
    limit: number = 100
  ): Promise<Message[]> {
    const query = `
      SELECT * FROM messages 
      WHERE channel_id = $1 
      AND created_at >= NOW() - INTERVAL '${hours} hours'
      ORDER BY created_at DESC
      LIMIT $2
    `;
    const result = await pool.query(query, [channelId, limit]);
    return result.rows;
  }
}

export const messageRepository = new MessageRepository();