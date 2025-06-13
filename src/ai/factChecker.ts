import { webSearchService, FactCheckResult } from '@services/webSearch';
import { logger } from '@utils/logger';

export interface ExtractedClaim {
  claim: string;
  type: 'fact' | 'statistic' | 'date' | 'quote' | 'general';
  confidence: number;
}

export interface FactCheckResponse {
  originalMessage: string;
  claims: ExtractedClaim[];
  verifications: FactCheckResult[];
  requiresCorrection: boolean;
  corrections: string[];
}

export class FactChecker {
  /**
   * Extract factual claims from a message
   */
  extractClaims(message: string): ExtractedClaim[] {
    const claims: ExtractedClaim[] = [];
    
    // Pattern matching for different types of claims
    const patterns = [
      {
        // Statistics and numbers
        regex: /(\w+\s+(?:is|are|was|were|has|have)\s+\d+(?:\.\d+)?(?:%|percent|million|billion|thousand)?)/gi,
        type: 'statistic' as const,
        confidence: 0.9,
      },
      {
        // Dates and time claims
        regex: /((?:in|on|at|since|from)\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{2,4}|(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2},?\s+\d{4})/gi,
        type: 'date' as const,
        confidence: 0.8,
      },
      {
        // Superlatives and absolutes
        regex: /((?:the\s+)?(?:first|last|only|biggest|smallest|largest|most|least|best|worst)\s+\w+(?:\s+\w+){0,3})/gi,
        type: 'fact' as const,
        confidence: 0.85,
      },
      {
        // "According to" statements
        regex: /according to\s+(\w+(?:\s+\w+){0,5})[,\s]+(.+?)(?:\.|,|$)/gi,
        type: 'quote' as const,
        confidence: 0.7,
      },
      {
        // Strong factual statements
        regex: /(\w+(?:\s+\w+){0,10}\s+(?:invented|discovered|created|founded|established|built)\s+\w+(?:\s+\w+){0,5})/gi,
        type: 'fact' as const,
        confidence: 0.9,
      },
    ];

    // Extract claims using patterns
    for (const pattern of patterns) {
      const matches = message.matchAll(pattern.regex);
      for (const match of matches) {
        const claim = match[0].trim();
        if (claim.length > 10) { // Skip very short matches
          claims.push({
            claim,
            type: pattern.type,
            confidence: pattern.confidence,
          });
        }
      }
    }

    // Also look for general factual statements
    const sentences = message.split(/[.!?]+/).filter(s => s.trim().length > 10);
    for (const sentence of sentences) {
      const trimmed = sentence.trim();
      
      // Check if it's a factual statement (contains "is", "are", "was", etc.)
      if (
        /\b(?:is|are|was|were|has|have|will|would|can|could)\b/i.test(trimmed) &&
        !claims.some(c => c.claim.includes(trimmed)) &&
        !this.isOpinion(trimmed) &&
        !this.isQuestion(trimmed)
      ) {
        claims.push({
          claim: trimmed,
          type: 'general',
          confidence: 0.6,
        });
      }
    }

    // Remove duplicates and sort by confidence
    const uniqueClaims = this.deduplicateClaims(claims);
    return uniqueClaims.sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * Check if a statement is likely an opinion
   */
  private isOpinion(text: string): boolean {
    const opinionWords = [
      'think', 'believe', 'feel', 'seems', 'appears', 'probably',
      'maybe', 'perhaps', 'possibly', 'likely', 'opinion', 'personally',
      'prefer', 'favorite', 'love', 'hate', 'like', 'dislike'
    ];
    
    const lower = text.toLowerCase();
    return opinionWords.some(word => lower.includes(word));
  }

  /**
   * Check if a statement is a question
   */
  private isQuestion(text: string): boolean {
    return text.trim().endsWith('?') || 
           /^(?:what|where|when|why|how|who|which|is|are|do|does|did|can|could|would|will)\b/i.test(text.trim());
  }

  /**
   * Remove duplicate or overlapping claims
   */
  private deduplicateClaims(claims: ExtractedClaim[]): ExtractedClaim[] {
    const unique: ExtractedClaim[] = [];
    
    for (const claim of claims) {
      const isDuplicate = unique.some(u => 
        u.claim === claim.claim ||
        u.claim.includes(claim.claim) ||
        claim.claim.includes(u.claim)
      );
      
      if (!isDuplicate) {
        unique.push(claim);
      }
    }
    
    return unique;
  }

  /**
   * Fact-check all claims in a message
   */
  async checkMessage(message: string): Promise<FactCheckResponse> {
    const claims = this.extractClaims(message);
    
    if (claims.length === 0) {
      return {
        originalMessage: message,
        claims: [],
        verifications: [],
        requiresCorrection: false,
        corrections: [],
      };
    }

    logger.info('Fact-checking message', { metadata: { claimCount: claims.length } });

    // Verify each claim
    const verifications: FactCheckResult[] = [];
    const corrections: string[] = [];

    for (const claim of claims.slice(0, 5)) { // Limit to top 5 claims
      try {
        const result = await webSearchService.factCheck(claim.claim);
        verifications.push(result);
        
        if (!result.isAccurate && result.confidence > 0.7) {
          if (result.actualFact) {
            corrections.push(`"${claim.claim}" → ${result.actualFact}`);
          } else if (result.corrections && result.corrections.length > 0) {
            corrections.push(`"${claim.claim}" → ${result.corrections[0]}`);
          }
        }
      } catch (error) {
        logger.warn('Failed to fact-check claim', { error: error as Error, metadata: { claim: claim.claim } });
      }
    }

    const requiresCorrection = corrections.length > 0;

    return {
      originalMessage: message,
      claims,
      verifications,
      requiresCorrection,
      corrections,
    };
  }

  /**
   * Generate a fact-based response
   */
  generateFactResponse(checkResult: FactCheckResponse): string {
    if (!checkResult.requiresCorrection) {
      if (checkResult.verifications.length > 0 && 
          checkResult.verifications.every(v => v.isAccurate && v.confidence > 0.8)) {
        return "I looked that up and you're absolutely right! 🎯";
      }
      return "";
    }

    const responses: string[] = [];
    
    // Add corrections
    if (checkResult.corrections.length > 0) {
      responses.push("Actually, let me fact-check that for you:");
      responses.push(...checkResult.corrections);
    }

    // Add sources
    const sources = checkResult.verifications
      .filter(v => v.sources.length > 0)
      .flatMap(v => v.sources.slice(0, 2))
      .map(s => `${s.source}`);
    
    if (sources.length > 0) {
      responses.push(`\nSources: ${[...new Set(sources)].slice(0, 3).join(', ')}`);
    }

    return responses.join('\n');
  }

  /**
   * Check if a message needs fact-checking
   */
  needsFactCheck(message: string): boolean {
    // Skip very short messages
    if (message.length < 20) return false;
    
    // Skip pure questions
    if (this.isQuestion(message)) return false;
    
    // Skip pure opinions
    if (this.isOpinion(message)) return false;
    
    // Check for factual indicators
    const factualIndicators = [
      /\d+(?:\.\d+)?(?:%|percent|million|billion|thousand)/i,
      /\b(?:is|are|was|were|has|have)\b.*\b(?:first|last|only|biggest|smallest)\b/i,
      /\b(?:invented|discovered|created|founded|established)\b/i,
      /\b(?:always|never|every|all|none)\b/i,
      /according to/i,
      /\b\d{4}\b/, // years
    ];
    
    return factualIndicators.some(pattern => pattern.test(message));
  }
}

export const factChecker = new FactChecker();