#!/usr/bin/env tsx

/**
 * Database seeding script for development environment
 * Creates sample users, messages, and interactions
 */

import { config } from 'dotenv';
import { Pool } from 'pg';
import { OpenAI } from 'openai';
import { createHash } from 'crypto';

// Load environment variables
config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

interface SeedUser {
  slackId: string;
  name: string;
  realName: string;
  personality: {
    traits: string[];
    communicationStyle: string;
    interests: string[];
  };
}

interface SeedMessage {
  userId: string;
  text: string;
  channel: string;
  threadTs?: string;
  daysAgo: number;
}

// Sample users with different personalities
const SEED_USERS: SeedUser[] = [
  {
    slackId: 'U001ALICE',
    name: 'alice',
    realName: 'Alice Johnson',
    personality: {
      traits: ['analytical', 'direct', 'helpful'],
      communicationStyle: 'formal',
      interests: ['data science', 'machine learning', 'coffee'],
    },
  },
  {
    slackId: 'U002BOB',
    name: 'bob',
    realName: 'Bob Smith',
    personality: {
      traits: ['creative', 'humorous', 'collaborative'],
      communicationStyle: 'casual',
      interests: ['design', 'music', 'memes'],
    },
  },
  {
    slackId: 'U003CAROL',
    name: 'carol',
    realName: 'Carol Davis',
    personality: {
      traits: ['organized', 'supportive', 'detail-oriented'],
      communicationStyle: 'professional',
      interests: ['project management', 'hiking', 'cooking'],
    },
  },
  {
    slackId: 'U004DAVE',
    name: 'dave',
    realName: 'Dave Wilson',
    personality: {
      traits: ['technical', 'curious', 'introverted'],
      communicationStyle: 'concise',
      interests: ['programming', 'gaming', 'sci-fi'],
    },
  },
];

// Sample conversations
const SEED_MESSAGES: SeedMessage[] = [
  // Technical discussion thread
  {
    userId: 'U001ALICE',
    text: 'Has anyone tried the new pgvector extension? I\'m thinking of using it for our recommendation system.',
    channel: 'C001GENERAL',
    daysAgo: 7,
  },
  {
    userId: 'U004DAVE',
    text: 'Yeah, I\'ve been experimenting with it. The performance is impressive for similarity searches.',
    channel: 'C001GENERAL',
    threadTs: '1',
    daysAgo: 7,
  },
  {
    userId: 'U001ALICE',
    text: 'Great! What embedding dimensions are you using? I\'m torn between 768 and 1536.',
    channel: 'C001GENERAL',
    threadTs: '1',
    daysAgo: 7,
  },
  
  // Casual conversation
  {
    userId: 'U002BOB',
    text: 'who else is ready for the weekend? 🎉',
    channel: 'C002RANDOM',
    daysAgo: 5,
  },
  {
    userId: 'U003CAROL',
    text: 'Looking forward to it! Planning to hit the trails if the weather holds up.',
    channel: 'C002RANDOM',
    threadTs: '4',
    daysAgo: 5,
  },
  
  // Project discussion
  {
    userId: 'U003CAROL',
    text: 'Quick update on Project Phoenix: We\'re on track for the Q4 deadline. I\'ve updated the Gantt chart.',
    channel: 'C003PROJECTS',
    daysAgo: 3,
  },
  {
    userId: 'U001ALICE',
    text: 'Thanks Carol! The data pipeline is nearly complete. Should have metrics flowing by next week.',
    channel: 'C003PROJECTS',
    threadTs: '6',
    daysAgo: 3,
  },
  
  // Recent messages
  {
    userId: 'U004DAVE',
    text: 'Found a bug in the authentication flow. PR incoming.',
    channel: 'C001GENERAL',
    daysAgo: 1,
  },
  {
    userId: 'U002BOB',
    text: 'Anyone else getting coffee? ☕ Making a run to the kitchen.',
    channel: 'C002RANDOM',
    daysAgo: 0,
  },
  {
    userId: 'U003CAROL',
    text: 'Yes please! The usual for me.',
    channel: 'C002RANDOM',
    threadTs: '9',
    daysAgo: 0,
  },
];

async function generateEmbedding(text: string): Promise<number[]> {
  try {
    const response = await openai.embeddings.create({
      input: text,
      model: 'text-embedding-3-small',
    });
    return response.data[0].embedding;
  } catch (error) {
    console.warn('Failed to generate embedding, using placeholder:', error);
    // Return a placeholder embedding for development
    return Array(1536).fill(0).map(() => Math.random() - 0.5);
  }
}

async function seedUsers() {
  console.log('🌱 Seeding users...');
  
  for (const user of SEED_USERS) {
    await pool.query(
      `INSERT INTO users (slack_id, username, real_name, personality_profile, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW())
       ON CONFLICT (slack_id) DO UPDATE SET
         username = EXCLUDED.username,
         real_name = EXCLUDED.real_name,
         personality_profile = EXCLUDED.personality_profile,
         updated_at = NOW()`,
      [user.slackId, user.name, user.realName, JSON.stringify(user.personality)]
    );
    console.log(`  ✓ Created user: ${user.realName}`);
  }
}

async function seedMessages() {
  console.log('🌱 Seeding messages...');
  
  let messageCount = 0;
  for (const [index, message] of SEED_MESSAGES.entries()) {
    const timestamp = new Date();
    timestamp.setDate(timestamp.getDate() - message.daysAgo);
    timestamp.setHours(9 + index % 8, index % 60); // Spread throughout workday
    
    const messageTs = timestamp.getTime() / 1000;
    const threadTs = message.threadTs ? 
      (timestamp.getTime() / 1000 - parseInt(message.threadTs) * 3600).toString() : 
      null;
    
    // Generate unique message ID
    const messageId = createHash('sha256')
      .update(`${message.channel}-${messageTs}`)
      .digest('hex')
      .substring(0, 12);
    
    // Generate embedding
    const embedding = await generateEmbedding(message.text);
    
    await pool.query(
      `INSERT INTO messages (
        id, slack_user_id, text, channel_id, message_ts, thread_ts, 
        embedding, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (id) DO NOTHING`,
      [
        messageId,
        message.userId,
        message.text,
        message.channel,
        messageTs.toString(),
        threadTs,
        `[${embedding.join(',')}]`,
        timestamp,
      ]
    );
    messageCount++;
  }
  
  console.log(`  ✓ Created ${messageCount} messages`);
}

async function seedInteractions() {
  console.log('🌱 Seeding user interactions...');
  
  // Create some interactions based on message threads
  const interactions = [
    { user1: 'U001ALICE', user2: 'U004DAVE', type: 'collaboration', count: 5 },
    { user1: 'U002BOB', user2: 'U003CAROL', type: 'casual', count: 3 },
    { user1: 'U003CAROL', user2: 'U001ALICE', type: 'project', count: 4 },
  ];
  
  for (const interaction of interactions) {
    await pool.query(
      `INSERT INTO user_interactions (
        user_id_1, user_id_2, interaction_type, interaction_count, 
        last_interaction, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, NOW(), NOW(), NOW())
      ON CONFLICT (user_id_1, user_id_2) DO UPDATE SET
        interaction_count = user_interactions.interaction_count + EXCLUDED.interaction_count,
        last_interaction = NOW(),
        updated_at = NOW()`,
      [
        interaction.user1,
        interaction.user2,
        interaction.type,
        interaction.count,
      ]
    );
  }
  
  console.log('  ✓ Created user interactions');
}

async function seedSummaries() {
  console.log('🌱 Seeding conversation summaries...');
  
  const summaries = [
    {
      channel: 'C001GENERAL',
      date: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
      summary: 'Technical discussion about pgvector implementation and embedding dimensions for recommendation system.',
      keyTopics: ['pgvector', 'embeddings', 'recommendations'],
    },
    {
      channel: 'C003PROJECTS',
      date: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
      summary: 'Project Phoenix status update: on track for Q4, data pipeline nearing completion.',
      keyTopics: ['project phoenix', 'q4 deadline', 'data pipeline'],
    },
  ];
  
  for (const summary of summaries) {
    await pool.query(
      `INSERT INTO conversation_summaries (
        channel_id, summary_date, summary_text, key_topics, created_at
      ) VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (channel_id, summary_date) DO UPDATE SET
        summary_text = EXCLUDED.summary_text,
        key_topics = EXCLUDED.key_topics`,
      [
        summary.channel,
        summary.date,
        summary.summary,
        JSON.stringify(summary.keyTopics),
      ]
    );
  }
  
  console.log('  ✓ Created conversation summaries');
}

async function main() {
  try {
    console.log('🚀 Starting database seeding...\n');
    
    // Test database connection
    await pool.query('SELECT 1');
    console.log('✅ Database connection established\n');
    
    // Run seeding functions
    await seedUsers();
    await seedMessages();
    await seedInteractions();
    await seedSummaries();
    
    console.log('\n✨ Database seeding completed successfully!');
    console.log('\nYou can now start the bot with sample data to interact with.');
    
  } catch (error) {
    console.error('❌ Seeding failed:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

// Run seeding if called directly
if (require.main === module) {
  main();
}