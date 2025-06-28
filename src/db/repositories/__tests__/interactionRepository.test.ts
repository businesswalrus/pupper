import { interactionRepository, UserInteraction } from '../interactionRepository';
import { pool } from '@db/connection';
import { createMockPool, createMockInteraction } from '@test-utils';

jest.mock('@db/connection');

describe('InteractionRepository', () => {
  let mockPool: ReturnType<typeof createMockPool>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPool = createMockPool();
    (pool as any) = mockPool;
  });

  describe('findOrCreate', () => {
    it('should find existing interaction', async () => {
      const existingInteraction = createMockInteraction({
        user_a_id: 'U123',
        user_b_id: 'U456',
        interaction_count: 5
      });
      mockPool.query.mockResolvedValue({ rows: [existingInteraction], rowCount: 1 });

      const result = await interactionRepository.findOrCreate('U123', 'U456');

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('SELECT * FROM user_interactions'),
        ['U123', 'U456']
      );
      expect(result).toEqual(existingInteraction);
    });

    it('should create new interaction when not found', async () => {
      const newInteraction = createMockInteraction({
        user_a_id: 'U123',
        user_b_id: 'U789'
      });
      
      // First query returns empty (not found)
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      // Second query creates new interaction
      mockPool.query.mockResolvedValueOnce({ rows: [newInteraction], rowCount: 1 });

      const result = await interactionRepository.findOrCreate('U123', 'U789');

      expect(mockPool.query).toHaveBeenCalledTimes(2);
      expect(mockPool.query).toHaveBeenNthCalledWith(2,
        expect.stringContaining('INSERT INTO user_interactions'),
        ['U123', 'U789']
      );
      expect(result).toEqual(newInteraction);
    });

    it('should ensure consistent ordering of user IDs', async () => {
      mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });

      // Test both orderings result in same query
      await interactionRepository.findOrCreate('U456', 'U123');
      await interactionRepository.findOrCreate('U123', 'U456');

      // Both calls should use alphabetical ordering (U123, U456)
      expect(mockPool.query).toHaveBeenNthCalledWith(1,
        expect.any(String),
        ['U123', 'U456']
      );
      expect(mockPool.query).toHaveBeenNthCalledWith(3,
        expect.any(String),
        ['U123', 'U456']
      );
    });
  });

  describe('incrementInteraction', () => {
    it('should increment basic interaction count', async () => {
      const updatedInteraction = createMockInteraction({
        interaction_count: 6,
        last_interaction_at: new Date()
      });
      mockPool.query.mockResolvedValue({ rows: [updatedInteraction], rowCount: 1 });

      const result = await interactionRepository.incrementInteraction('U123', 'U456');

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('interaction_count = interaction_count + 1'),
        ['U123', 'U456']
      );
      expect(result).toEqual(updatedInteraction);
    });

    it('should add new topic to topics_discussed', async () => {
      const updatedInteraction = createMockInteraction({
        topics_discussed: ['javascript', 'testing']
      });
      mockPool.query.mockResolvedValue({ rows: [updatedInteraction], rowCount: 1 });

      const result = await interactionRepository.incrementInteraction(
        'U123',
        'U456',
        'testing'
      );

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('topics_discussed ='),
        ['U123', 'U456', '["testing"]']
      );
      expect(result).toEqual(updatedInteraction);
    });

    it('should update sentiment score with running average', async () => {
      const updatedInteraction = createMockInteraction({
        sentiment_score: 0.75
      });
      mockPool.query.mockResolvedValue({ rows: [updatedInteraction], rowCount: 1 });

      const result = await interactionRepository.incrementInteraction(
        'U123',
        'U456',
        undefined,
        0.8
      );

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('sentiment_score ='),
        ['U123', 'U456', 0.8]
      );
      expect(result).toEqual(updatedInteraction);
    });

    it('should update all fields when provided', async () => {
      const updatedInteraction = createMockInteraction({
        interaction_count: 10,
        topics_discussed: ['javascript', 'react', 'testing'],
        sentiment_score: 0.85
      });
      mockPool.query.mockResolvedValue({ rows: [updatedInteraction], rowCount: 1 });

      const result = await interactionRepository.incrementInteraction(
        'U123',
        'U456',
        'react',
        0.9
      );

      const query = mockPool.query.mock.calls[0][0];
      expect(query).toContain('interaction_count = interaction_count + 1');
      expect(query).toContain('topics_discussed =');
      expect(query).toContain('sentiment_score =');
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.any(String),
        ['U123', 'U456', '["react"]', 0.9]
      );
    });

    it('should create interaction if it does not exist', async () => {
      // First update returns empty (doesn't exist)
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      // findOrCreate finds nothing
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      // findOrCreate creates new
      const newInteraction = createMockInteraction();
      mockPool.query.mockResolvedValueOnce({ rows: [newInteraction], rowCount: 1 });
      // Final increment succeeds
      mockPool.query.mockResolvedValueOnce({ rows: [newInteraction], rowCount: 1 });

      const result = await interactionRepository.incrementInteraction('U123', 'U789');

      expect(mockPool.query).toHaveBeenCalledTimes(4);
      expect(result).toEqual(newInteraction);
    });

    it('should handle negative sentiment scores', async () => {
      mockPool.query.mockResolvedValue({ 
        rows: [createMockInteraction({ sentiment_score: -0.5 })], 
        rowCount: 1 
      });

      const result = await interactionRepository.incrementInteraction(
        'U123',
        'U456',
        undefined,
        -0.8
      );

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.any(String),
        ['U123', 'U456', -0.8]
      );
    });
  });

  describe('updateRelationshipNotes', () => {
    it('should update relationship notes', async () => {
      const updatedInteraction = createMockInteraction({
        relationship_notes: 'Frequently collaborate on frontend tasks'
      });
      mockPool.query.mockResolvedValue({ rows: [updatedInteraction], rowCount: 1 });

      const result = await interactionRepository.updateRelationshipNotes(
        'U123',
        'U456',
        'Frequently collaborate on frontend tasks'
      );

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('SET relationship_notes = $3'),
        ['U123', 'U456', 'Frequently collaborate on frontend tasks']
      );
      expect(result).toEqual(updatedInteraction);
    });

    it('should return null when interaction not found', async () => {
      mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });

      const result = await interactionRepository.updateRelationshipNotes(
        'U999',
        'U888',
        'Notes'
      );

      expect(result).toBeNull();
    });

    it('should handle alphabetical ordering', async () => {
      mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });

      await interactionRepository.updateRelationshipNotes('U456', 'U123', 'Notes');

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.any(String),
        ['U123', 'U456', 'Notes']
      );
    });
  });

  describe('getTopInteractions', () => {
    it('should get top interactions for a user', async () => {
      const interactions = [
        createMockInteraction({ user_a_id: 'U123', user_b_id: 'U456', interaction_count: 50 }),
        createMockInteraction({ user_a_id: 'U123', user_b_id: 'U789', interaction_count: 30 }),
        createMockInteraction({ user_a_id: 'U111', user_b_id: 'U123', interaction_count: 20 })
      ];
      mockPool.query.mockResolvedValue({ rows: interactions, rowCount: 3 });

      const result = await interactionRepository.getTopInteractions('U123');

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('WHERE user_a_id = $1 OR user_b_id = $1'),
        ['U123', 10]
      );
      expect(result).toEqual(interactions);
      expect(result).toHaveLength(3);
    });

    it('should respect custom limit', async () => {
      mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });

      await interactionRepository.getTopInteractions('U123', 5);

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('LIMIT $2'),
        ['U123', 5]
      );
    });

    it('should order by interaction_count DESC', async () => {
      mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });

      await interactionRepository.getTopInteractions('U123');

      const query = mockPool.query.mock.calls[0][0];
      expect(query).toContain('ORDER BY interaction_count DESC');
    });
  });

  describe('getInteractionStats', () => {
    it('should get interaction statistics for a user', async () => {
      const statsData = {
        total_interactions: '150',
        unique_users: '10',
        avg_sentiment: '0.75'
      };
      const topicsData = [
        { topic: 'javascript', count: 20 },
        { topic: 'react', count: 15 },
        { topic: 'testing', count: 12 }
      ];

      mockPool.query
        .mockResolvedValueOnce({ rows: [statsData], rowCount: 1 })
        .mockResolvedValueOnce({ rows: topicsData, rowCount: 3 });

      const result = await interactionRepository.getInteractionStats('U123');

      expect(result).toEqual({
        totalInteractions: 150,
        uniqueUsers: 10,
        averageSentiment: 0.75,
        topTopics: ['javascript', 'react', 'testing']
      });
    });

    it('should handle null values in stats', async () => {
      const emptyStats = {
        total_interactions: null,
        unique_users: null,
        avg_sentiment: null
      };

      mockPool.query
        .mockResolvedValueOnce({ rows: [emptyStats], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const result = await interactionRepository.getInteractionStats('U999');

      expect(result).toEqual({
        totalInteractions: 0,
        uniqueUsers: 0,
        averageSentiment: 0,
        topTopics: []
      });
    });

    it('should limit top topics to 5', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{}], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await interactionRepository.getInteractionStats('U123');

      const topicsQuery = mockPool.query.mock.calls[1][0];
      expect(topicsQuery).toContain('LIMIT 5');
    });

    it('should handle database errors gracefully', async () => {
      mockPool.query.mockRejectedValue(new Error('Database error'));

      await expect(interactionRepository.getInteractionStats('U123'))
        .rejects.toThrow('Database error');
    });
  });

  describe('getRelationshipGraph', () => {
    it('should build relationship graph data', async () => {
      const interactions = [
        { user_a_id: 'U123', user_b_id: 'U456', interaction_count: 50 },
        { user_a_id: 'U123', user_b_id: 'U789', interaction_count: 30 },
        { user_a_id: 'U456', user_b_id: 'U789', interaction_count: 20 }
      ];
      mockPool.query.mockResolvedValue({ rows: interactions, rowCount: 3 });

      const result = await interactionRepository.getRelationshipGraph();

      expect(result.nodes).toContainEqual({ id: 'U123', interactions: 80 }); // 50 + 30
      expect(result.nodes).toContainEqual({ id: 'U456', interactions: 70 }); // 50 + 20
      expect(result.nodes).toContainEqual({ id: 'U789', interactions: 50 }); // 30 + 20
      
      expect(result.edges).toEqual([
        { source: 'U123', target: 'U456', weight: 50 },
        { source: 'U123', target: 'U789', weight: 30 },
        { source: 'U456', target: 'U789', weight: 20 }
      ]);
    });

    it('should respect custom limit', async () => {
      mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });

      await interactionRepository.getRelationshipGraph(25);

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('LIMIT $1'),
        [25]
      );
    });

    it('should order by interaction_count DESC', async () => {
      mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });

      await interactionRepository.getRelationshipGraph();

      const query = mockPool.query.mock.calls[0][0];
      expect(query).toContain('ORDER BY interaction_count DESC');
    });

    it('should handle empty graph', async () => {
      mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });

      const result = await interactionRepository.getRelationshipGraph();

      expect(result).toEqual({
        nodes: [],
        edges: []
      });
    });
  });

  describe('Edge cases', () => {
    it('should handle very long topic names', async () => {
      const longTopic = 'a'.repeat(500);
      mockPool.query.mockResolvedValue({ 
        rows: [createMockInteraction()], 
        rowCount: 1 
      });

      await interactionRepository.incrementInteraction('U123', 'U456', longTopic);

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining([`["${longTopic}"]`])
      );
    });

    it('should handle special characters in relationship notes', async () => {
      const specialNotes = 'Notes with "quotes", \'apostrophes\', and\nnewlines';
      mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });

      await interactionRepository.updateRelationshipNotes('U123', 'U456', specialNotes);

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.any(String),
        ['U123', 'U456', specialNotes]
      );
    });
  });
});