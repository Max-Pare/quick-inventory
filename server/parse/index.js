import { parseHeuristic } from './heuristic.js';
import { llmAvailable, parseWithLLM } from './llm.js';

/**
 * Parse a transcript into proposed items. Never throws: the heuristic parser
 * is the fallback for a missing or failing LLM.
 * @returns {Promise<{parser:'llm'|'heuristic', items:object[], warning?:string}>}
 */
export async function parseTranscript(input) {
  if (llmAvailable()) {
    try {
      return { parser: 'llm', items: await parseWithLLM(input) };
    } catch (err) {
      console.error('[quickinv] LLM parse failed, using heuristic parser:', err?.message || err);
      return {
        parser: 'heuristic',
        items: parseHeuristic(input.transcript),
        warning: 'AI parsing was unavailable; a simpler parser was used. Review carefully.',
      };
    }
  }
  return { parser: 'heuristic', items: parseHeuristic(input.transcript) };
}

export { llmAvailable };
