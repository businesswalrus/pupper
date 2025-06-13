import axios from 'axios';
import * as cheerio from 'cheerio';
import { logger } from '@utils/logger';
import { circuitBreakers } from '@utils/circuitBreaker';
import { ApiError } from '@utils/errors';
import { redisClient } from '@db/redis';
import pLimit from 'p-limit';

const searchLimit = pLimit(5); // 5 concurrent searches max

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  source: string;
  publishedDate?: Date;
  relevanceScore?: number;
}

export interface FactCheckResult {
  claim: string;
  isAccurate: boolean;
  confidence: number;
  actualFact?: string;
  sources: SearchResult[];
  corrections?: string[];
}

export interface VerifiedFact {
  fact: string;
  sources: SearchResult[];
  confidence: number;
  consensus: boolean;
}

interface BraveSearchResponse {
  web?: {
    results: Array<{
      title: string;
      url: string;
      description: string;
      published?: string;
      score?: number;
    }>;
  };
}

class WebSearchService {
  private braveApiKey: string | undefined;
  private cachePrefix = 'search:';
  private cacheTTL = 3600; // 1 hour

  constructor() {
    this.braveApiKey = process.env.BRAVE_SEARCH_API_KEY;
    if (!this.braveApiKey) {
      logger.warn('BRAVE_SEARCH_API_KEY not set, falling back to web scraping');
    }
  }

  /**
   * Search using Brave Search API or fallback to DuckDuckGo scraping
   */
  async search(query: string, limit: number = 5): Promise<SearchResult[]> {
    return searchLimit(async () => {
      const cacheKey = `${this.cachePrefix}${query}`;
      
      // Check cache first
      const cached = await redisClient.get(cacheKey);
      if (cached) {
        logger.debug('Search cache hit', { metadata: { query } });
        return JSON.parse(cached);
      }

      try {
        const results = this.braveApiKey 
          ? await this.searchBrave(query, limit)
          : await this.searchDuckDuckGo(query, limit);

        // Cache results
        await redisClient.setEx(cacheKey, this.cacheTTL, JSON.stringify(results));
        
        return results;
      } catch (error) {
        logger.error('Search failed', { error: error as Error, metadata: { query } });
        throw error;
      }
    });
  }

  /**
   * Search using Brave Search API
   */
  private async searchBrave(query: string, limit: number): Promise<SearchResult[]> {
    return circuitBreakers.search.execute(async () => {
      const timer = logger.startTimer('BraveSearch.search');
      
      try {
        const response = await axios.get<BraveSearchResponse>('https://api.search.brave.com/res/v1/web/search', {
          headers: {
            'X-Subscription-Token': this.braveApiKey,
            'Accept': 'application/json',
          },
          params: {
            q: query,
            count: limit,
          },
          timeout: 5000,
        });

        timer();
        
        const results = response.data.web?.results || [];
        return results.map(result => ({
          title: result.title,
          url: result.url,
          snippet: result.description,
          source: new URL(result.url).hostname,
          publishedDate: result.published ? new Date(result.published) : undefined,
          relevanceScore: result.score,
        }));
      } catch (error: any) {
        logger.error('Brave Search API error', { error, metadata: { query } });
        throw new ApiError('Brave Search failed', 'BraveSearch', error);
      }
    });
  }

  /**
   * Fallback: Scrape DuckDuckGo search results
   */
  private async searchDuckDuckGo(query: string, limit: number): Promise<SearchResult[]> {
    const timer = logger.startTimer('DuckDuckGo.scrape');
    
    try {
      const response = await axios.get('https://html.duckduckgo.com/html/', {
        params: { q: query },
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; pup-ai/2.0)',
        },
        timeout: 5000,
      });

      timer();

      const $ = cheerio.load(response.data);
      const results: SearchResult[] = [];

      $('.result').each((i, elem) => {
        if (i >= limit) return false;

        const $elem = $(elem);
        const title = $elem.find('.result__title').text().trim();
        const url = $elem.find('.result__url').attr('href') || '';
        const snippet = $elem.find('.result__snippet').text().trim();

        if (title && url) {
          results.push({
            title,
            url,
            snippet,
            source: new URL(url).hostname,
          });
        }
        return; // Continue iteration
      });

      return results;
    } catch (error) {
      logger.error('DuckDuckGo scraping failed', { error: error as Error, metadata: { query } });
      throw new ApiError('Web scraping failed', 'DuckDuckGo', error as Error);
    }
  }

  /**
   * Fact-check a claim by searching for supporting/contradicting evidence
   */
  async factCheck(claim: string): Promise<FactCheckResult> {
    logger.info('Fact-checking claim', { metadata: { claim } });

    // Search for the claim and variations
    const queries = [
      claim,
      `"${claim}" fact check`,
      `is it true that ${claim}`,
    ];

    const allResults: SearchResult[] = [];
    
    for (const query of queries) {
      try {
        const results = await this.search(query, 3);
        allResults.push(...results);
      } catch (error) {
        logger.warn('Search query failed during fact check', { error: error as Error, metadata: { query } });
      }
    }

    // Analyze results
    const analysis = this.analyzeFactCheckResults(claim, allResults);
    
    return analysis;
  }

  /**
   * Verify a fact using multiple sources
   */
  async multiSourceVerify(query: string, requiredSources: number = 3): Promise<VerifiedFact> {
    const results = await this.search(query, requiredSources * 2);
    
    if (results.length < requiredSources) {
      return {
        fact: query,
        sources: results,
        confidence: 0.5,
        consensus: false,
      };
    }

    // Simple consensus: if most sources agree in their snippets
    const consensus = results.length >= requiredSources;
    const confidence = Math.min(results.length / requiredSources, 1.0);

    return {
      fact: query,
      sources: results.slice(0, requiredSources),
      confidence,
      consensus,
    };
  }

  /**
   * Analyze search results to determine fact accuracy
   */
  private analyzeFactCheckResults(claim: string, results: SearchResult[]): FactCheckResult {
    if (results.length === 0) {
      return {
        claim,
        isAccurate: false,
        confidence: 0,
        sources: [],
        corrections: ['No information found to verify this claim'],
      };
    }

    // Simple heuristic: look for fact-checking sites and contradictions
    const factCheckSites = ['snopes.com', 'factcheck.org', 'politifact.com'];
    const factCheckResults = results.filter(r => 
      factCheckSites.some(site => r.source.includes(site))
    );

    // Look for contradicting information in snippets
    const contradictions = results.filter(r => {
      const snippet = r.snippet.toLowerCase();
      return snippet.includes('false') || 
             snippet.includes('myth') || 
             snippet.includes('incorrect') ||
             snippet.includes('actually');
    });

    const isAccurate = contradictions.length === 0 && results.length > 2;
    const confidence = Math.min(results.length / 5, 1.0) * (factCheckResults.length > 0 ? 1.5 : 1.0);

    return {
      claim,
      isAccurate,
      confidence: Math.min(confidence, 1.0),
      sources: [...factCheckResults, ...results.slice(0, 3)],
      corrections: contradictions.map(c => c.snippet),
    };
  }

  /**
   * Extract key facts from search results
   */
  extractFacts(results: SearchResult[]): string[] {
    const facts: string[] = [];
    
    for (const result of results) {
      // Extract sentences that look like facts
      const sentences = result.snippet.split(/[.!?]+/);
      for (const sentence of sentences) {
        if (
          sentence.length > 20 &&
          sentence.length < 200 &&
          /\d|%|million|billion|year|first|last/i.test(sentence)
        ) {
          facts.push(sentence.trim());
        }
      }
    }

    return [...new Set(facts)]; // Remove duplicates
  }
}

export const webSearchService = new WebSearchService();