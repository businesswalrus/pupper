import { openai } from '@ai/openai';
import { logger } from '@utils/logger';
import { circuitBreakers } from '@utils/circuitBreaker';

export interface ExtractedClaim {
  claim: string;
  type: 'fact' | 'statistic' | 'date' | 'quote' | 'general';
  confidence: number;
}

export interface ExtractionResult {
  claims: ExtractedClaim[];
  questions: string[];
  topics: string[];
  entities: string[];
}

export class ClaimExtractor {
  /**
   * Use AI to extract claims, questions, and topics from a message
   */
  async extractWithAI(
    message: string,
    context?: string[]
  ): Promise<ExtractionResult> {
    try {
      const contextStr = context ? `\nContext: ${context.join(' ')}` : '';
      
      const response = await circuitBreakers.openai.execute(async () => {
        const completion = await openai.chat.completions.create({
          model: 'gpt-3.5-turbo',
          messages: [
            {
              role: 'system',
              content: `Extract factual claims, questions, topics, and named entities from the message. 
                       Return a JSON object with:
                       - claims: array of {claim: string, type: 'fact'|'statistic'|'date'|'quote'|'general', confidence: 0-1}
                       - questions: array of questions asked
                       - topics: array of main topics discussed
                       - entities: array of named entities (people, places, organizations)`
            },
            {
              role: 'user',
              content: `Message: ${message}${contextStr}`
            }
          ],
          temperature: 0.3,
          max_tokens: 500,
          response_format: { type: 'json_object' },
        });

        return completion.choices[0].message.content || '{}';
      });

      const parsed = JSON.parse(response) as ExtractionResult;
      
      // Ensure all fields exist
      return {
        claims: parsed.claims || [],
        questions: parsed.questions || [],
        topics: parsed.topics || [],
        entities: parsed.entities || [],
      };
    } catch (error) {
      logger.error('AI claim extraction failed', { error: error as Error });
      
      // Fallback to basic extraction
      return this.basicExtraction(message);
    }
  }

  /**
   * Basic extraction without AI
   */
  private basicExtraction(message: string): ExtractionResult {
    const result: ExtractionResult = {
      claims: [],
      questions: [],
      topics: [],
      entities: [],
    };

    // Extract questions
    const questionPatterns = [
      /(?:^|\s)(?:what|where|when|why|how|who|which|is|are|do|does|did|can|could|would|will)[^.!?]*\?/gi,
      /[^.!?]*\?/g // Any sentence ending with ?
    ];

    for (const pattern of questionPatterns) {
      const matches = message.match(pattern);
      if (matches) {
        result.questions.push(...matches.map(q => q.trim()));
      }
    }

    // Extract potential topics (capitalized words)
    const topicMatches = message.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g);
    if (topicMatches) {
      result.topics = [...new Set(topicMatches)];
      result.entities = result.topics; // Use same for entities in basic mode
    }

    return result;
  }

  /**
   * Generate search queries from extraction results
   */
  generateSearchQueries(extraction: ExtractionResult): string[] {
    const queries: string[] = [];

    // Add top claims
    queries.push(...extraction.claims.slice(0, 2).map(c => c.claim));

    // Add questions
    queries.push(...extraction.questions.slice(0, 2));

    // Add topic searches if no claims/questions
    if (queries.length === 0 && extraction.topics.length > 0) {
      queries.push(...extraction.topics.slice(0, 2).map(t => `${t} facts`));
    }

    return queries;
  }

  /**
   * Determine if we should search for a topic
   */
  shouldSearchTopic(message: string, topics: string[]): boolean {
    // Don't search for casual conversation
    const casualIndicators = [
      /^(hi|hello|hey|bye|thanks|thank you|good morning|good night)/i,
      /^(lol|haha|hmm|oh|ah|yeah|yep|nope|ok|okay)/i,
    ];

    if (casualIndicators.some(pattern => pattern.test(message))) {
      return false;
    }

    // Search if asking about specific topics
    const searchTriggers = [
      /tell me about/i,
      /what.*know about/i,
      /latest.*news/i,
      /update.*on/i,
      /research/i,
    ];

    return topics.length > 0 && searchTriggers.some(pattern => pattern.test(message));
  }
}

export const claimExtractor = new ClaimExtractor();