import { webSearchService } from '@services/webSearch';
import { factChecker } from '@ai/factChecker';
import { claimExtractor } from '@ai/claimExtractor';
import { logger } from '@utils/logger';

export interface SearchContext {
  shouldSearch: boolean;
  searchType: 'fact_check' | 'question' | 'topic_research' | 'verification';
  queries: string[];
  priority: 'high' | 'medium' | 'low';
}

export interface SearchEnhancedResponse {
  originalMessage: string;
  searchResults: any[];
  factCheckResults?: any;
  suggestedResponse: string;
  citations: string[];
  corrections: string[];
}

export class SearchIntegration {
  /**
   * Determine if a message requires searching
   */
  async analyzeSearchNeed(
    message: string,
    _userId: string,
    context?: string[]
  ): Promise<SearchContext> {
    // Always check factual claims
    if (factChecker.needsFactCheck(message)) {
      const claims = factChecker.extractClaims(message);
      return {
        shouldSearch: true,
        searchType: 'fact_check',
        queries: claims.slice(0, 3).map(c => c.claim),
        priority: 'high',
      };
    }

    // Use AI to extract claims and questions
    const analysis = await claimExtractor.extractWithAI(message, context);
    
    if (analysis.questions.length > 0) {
      return {
        shouldSearch: true,
        searchType: 'question',
        queries: analysis.questions,
        priority: 'high',
      };
    }

    if (analysis.claims.length > 0) {
      return {
        shouldSearch: true,
        searchType: 'verification',
        queries: claimExtractor.generateSearchQueries(analysis),
        priority: 'medium',
      };
    }

    // Check for topic research triggers
    if (claimExtractor.shouldSearchTopic(message, analysis.topics)) {
      return {
        shouldSearch: true,
        searchType: 'topic_research',
        queries: analysis.topics.map(t => `${t} facts latest news`),
        priority: 'low',
      };
    }

    return {
      shouldSearch: false,
      searchType: 'fact_check',
      queries: [],
      priority: 'low',
    };
  }

  /**
   * Perform searches and integrate results
   */
  async searchAndIntegrate(
    message: string,
    searchContext: SearchContext
  ): Promise<SearchEnhancedResponse> {
    logger.info('Performing search integration', { 
      metadata: {
        type: searchContext.searchType,
        queryCount: searchContext.queries.length,
      }
    });

    const response: SearchEnhancedResponse = {
      originalMessage: message,
      searchResults: [],
      suggestedResponse: '',
      citations: [],
      corrections: [],
    };

    // Perform searches
    for (const query of searchContext.queries) {
      try {
        const results = await webSearchService.search(query, 3);
        response.searchResults.push(...results);
        
        // Extract unique sources
        const sources = results.map(r => r.source);
        response.citations.push(...new Set(sources));
      } catch (error) {
        logger.error('Search failed', { error: error as Error, metadata: { query } });
      }
    }

    // Handle based on search type
    switch (searchContext.searchType) {
      case 'fact_check':
        const factCheckResult = await factChecker.checkMessage(message);
        response.factCheckResults = factCheckResult;
        response.corrections = factCheckResult.corrections;
        
        if (factCheckResult.requiresCorrection) {
          response.suggestedResponse = this.generateCorrectionResponse(factCheckResult);
        } else {
          response.suggestedResponse = this.generateVerificationResponse(response.searchResults);
        }
        break;

      case 'question':
        response.suggestedResponse = this.generateAnswerResponse(
          searchContext.queries[0],
          response.searchResults
        );
        break;

      case 'topic_research':
        response.suggestedResponse = this.generateTopicResponse(
          searchContext.queries[0],
          response.searchResults
        );
        break;

      case 'verification':
        response.suggestedResponse = this.generateVerificationResponse(response.searchResults);
        break;
    }

    return response;
  }

  /**
   * Generate a correction response
   */
  private generateCorrectionResponse(factCheckResult: any): string {
    const lines: string[] = [];
    
    lines.push("🔍 Actually, let me fact-check that...");
    
    if (factCheckResult.corrections.length > 0) {
      lines.push("\nHere's what I found:");
      lines.push(...factCheckResult.corrections.map((c: string) => `• ${c}`));
    }

    if (factCheckResult.verifications.length > 0) {
      const sources = factCheckResult.verifications
        .flatMap((v: any) => v.sources.slice(0, 2))
        .map((s: any) => s.source);
      
      if (sources.length > 0) {
        lines.push(`\n📚 Sources: ${[...new Set(sources)].slice(0, 3).join(', ')}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Generate an answer response
   */
  private generateAnswerResponse(_question: string, results: any[]): string {
    if (results.length === 0) {
      return "🤔 I couldn't find a definitive answer to that question.";
    }

    const lines: string[] = [];
    lines.push("📖 Based on my search:");
    
    // Extract key facts from results
    const facts = webSearchService.extractFacts(results);
    if (facts.length > 0) {
      lines.push(...facts.slice(0, 3).map(f => `• ${f}`));
    } else {
      // Fallback to snippets
      lines.push(...results.slice(0, 2).map(r => `• ${r.snippet}`));
    }

    // Add sources
    const sources = results.map(r => r.source);
    lines.push(`\n📚 Sources: ${[...new Set(sources)].slice(0, 3).join(', ')}`);

    return lines.join('\n');
  }

  /**
   * Generate a topic research response
   */
  private generateTopicResponse(topic: string, results: any[]): string {
    if (results.length === 0) {
      return `🔍 I couldn't find current information about ${topic}.`;
    }

    const lines: string[] = [];
    lines.push(`📰 Here's what I found about ${topic}:`);
    
    // Group by recency if available
    const recent = results.filter(r => r.publishedDate);
    const other = results.filter(r => !r.publishedDate);

    if (recent.length > 0) {
      lines.push("\nRecent updates:");
      lines.push(...recent.slice(0, 2).map(r => `• ${r.title} - ${r.snippet}`));
    }

    if (other.length > 0 && recent.length < 2) {
      lines.push("\nGeneral info:");
      lines.push(...other.slice(0, 2).map(r => `• ${r.snippet}`));
    }

    return lines.join('\n');
  }

  /**
   * Generate a verification response
   */
  private generateVerificationResponse(results: any[]): string {
    if (results.length === 0) {
      return "";
    }

    const lines: string[] = [];
    lines.push("✅ I verified that information:");
    
    const sources = results.map(r => r.source);
    lines.push(`Sources confirm: ${[...new Set(sources)].slice(0, 3).join(', ')}`);

    return lines.join('\n');
  }

  /**
   * Format citations naturally in a response
   */
  formatCitations(response: string, citations: string[]): string {
    if (citations.length === 0) return response;

    const uniqueCitations = [...new Set(citations)].slice(0, 3);
    
    // Add citations at the end if not already included
    if (!response.includes('Source')) {
      return `${response}\n\n[${uniqueCitations.join(', ')}]`;
    }

    return response;
  }
}

export const searchIntegration = new SearchIntegration();