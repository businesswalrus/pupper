import { pool } from '@db/connection';

export interface User {
  id?: number;
  slack_user_id: string;
  username?: string;
  real_name?: string;
  display_name?: string;
  personality_summary?: string;
  interests?: any[];
  communication_style?: string;
  memorable_quotes?: any[];
  metadata?: Record<string, any>;
  created_at?: Date;
  updated_at?: Date;
}

export class UserRepository {
  async findBySlackId(slackUserId: string): Promise<User | null> {
    const query = 'SELECT * FROM users WHERE slack_user_id = $1';
    const result = await pool.query(query, [slackUserId]);
    return result.rows[0] || null;
  }

  async create(user: User): Promise<User> {
    const query = `
      INSERT INTO users (
        slack_user_id, username, real_name, display_name,
        personality_summary, interests, communication_style,
        memorable_quotes, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
    `;
    
    const values = [
      user.slack_user_id,
      user.username || null,
      user.real_name || null,
      user.display_name || null,
      user.personality_summary || null,
      JSON.stringify(user.interests || []),
      user.communication_style || null,
      JSON.stringify(user.memorable_quotes || []),
      JSON.stringify(user.metadata || {}),
    ];

    const result = await pool.query(query, values);
    return result.rows[0];
  }

  async update(slackUserId: string, updates: Partial<User>): Promise<User | null> {
    const allowedFields = [
      'username', 'real_name', 'display_name', 'personality_summary',
      'interests', 'communication_style', 'memorable_quotes', 'metadata'
    ];

    const updateFields = [];
    const values = [];
    let paramCount = 1;

    for (const [key, value] of Object.entries(updates)) {
      if (allowedFields.includes(key)) {
        updateFields.push(`${key} = $${paramCount}`);
        if (key === 'interests' || key === 'memorable_quotes' || key === 'metadata') {
          values.push(JSON.stringify(value));
        } else {
          values.push(value);
        }
        paramCount++;
      }
    }

    if (updateFields.length === 0) {
      return this.findBySlackId(slackUserId);
    }

    values.push(slackUserId);
    const query = `
      UPDATE users 
      SET ${updateFields.join(', ')}
      WHERE slack_user_id = $${paramCount}
      RETURNING *
    `;

    const result = await pool.query(query, values);
    return result.rows[0] || null;
  }

  async upsert(user: User): Promise<User> {
    const existing = await this.findBySlackId(user.slack_user_id);
    if (existing) {
      return this.update(user.slack_user_id, user) as Promise<User>;
    }
    return this.create(user);
  }

  async findAll(): Promise<User[]> {
    const query = 'SELECT * FROM users ORDER BY created_at DESC';
    const result = await pool.query(query);
    return result.rows;
  }
}

export const userRepository = new UserRepository();