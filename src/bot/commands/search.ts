import { app } from '@bot/app';
import { webSearchService } from '@services/webSearch';
import { logger } from '@utils/logger';
import type { Block, KnownBlock } from '@slack/types';

// Register /search slash command
app.command('/search', async ({ command, ack, respond }) => {
  // Acknowledge command request
  await ack();

  const query = command.text.trim();
  
  if (!query) {
    await respond({
      text: "🔍 What would you like me to search for? Use: `/search your query here`",
      response_type: 'ephemeral', // Only visible to the user
    });
    return;
  }

  try {
    // Show loading message
    await respond({
      text: `🔍 Searching for: *${query}*...`,
      response_type: 'in_channel', // Visible to everyone
    });

    // Perform search
    const results = await webSearchService.search(query, 5);

    if (results.length === 0) {
      await respond({
        text: `😅 I couldn't find anything about "${query}". Maybe try different keywords?`,
        response_type: 'in_channel',
      });
      return;
    }

    // Format results
    const blocks: (KnownBlock | Block)[] = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `🔍 *Search results for "${query}":*`,
        },
      },
    ];

    // Add result blocks
    results.forEach((result, index) => {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${index + 1}. ${result.title}*\n${result.snippet}\n<${result.url}|View Source>`,
        },
      });

      // Add divider between results
      if (index < results.length - 1) {
        blocks.push({ 
          type: 'divider' as const
        });
      }
    });

    await respond({
      blocks,
      text: `Found ${results.length} results for "${query}"`, // Fallback text
      response_type: 'in_channel',
    });

    logger.info('Search command executed', { 
      metadata: {
        userId: command.user_id,
        query,
        resultCount: results.length,
      }
    });
  } catch (error) {
    logger.error('Search command failed', { error: error as Error, metadata: { query } });
    
    await respond({
      text: `❌ Sorry, I ran into an issue while searching. Try again in a moment?`,
      response_type: 'ephemeral',
    });
  }
});

// Register /factcheck slash command
app.command('/factcheck', async ({ command, ack, respond }) => {
  await ack();

  const claim = command.text.trim();
  
  if (!claim) {
    await respond({
      text: "🔍 What claim would you like me to fact-check? Use: `/factcheck your claim here`",
      response_type: 'ephemeral',
    });
    return;
  }

  try {
    await respond({
      text: `🔍 Fact-checking: *${claim}*...`,
      response_type: 'in_channel',
    });

    // Perform fact check
    const result = await webSearchService.factCheck(claim);

    // Format response
    let text = `🔍 *Fact-check: "${claim}"*\n\n`;
    
    if (result.isAccurate) {
      text += `✅ *Verdict: Likely Accurate* (Confidence: ${Math.round(result.confidence * 100)}%)\n`;
    } else {
      text += `❌ *Verdict: Likely Inaccurate* (Confidence: ${Math.round(result.confidence * 100)}%)\n`;
    }

    if (result.corrections && result.corrections.length > 0) {
      text += `\n📝 *Corrections:*\n`;
      result.corrections.forEach(correction => {
        text += `• ${correction}\n`;
      });
    }

    if (result.sources.length > 0) {
      text += `\n📚 *Sources:*\n`;
      result.sources.slice(0, 3).forEach(source => {
        text += `• <${source.url}|${source.source}>\n`;
      });
    }

    await respond({
      text,
      response_type: 'in_channel',
    });

    logger.info('Fact-check command executed', {
      metadata: {
        userId: command.user_id,
        claim,
        isAccurate: result.isAccurate,
        confidence: result.confidence,
      }
    });
  } catch (error) {
    logger.error('Fact-check command failed', { error: error as Error, metadata: { claim } });
    
    await respond({
      text: `❌ Sorry, I couldn't fact-check that right now. Try again later?`,
      response_type: 'ephemeral',
    });
  }
});