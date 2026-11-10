import { parseHeuristic } from './heuristic.js';
import { claudeAvailable, parseWithClaude } from './llm.js';
import { localConfig, parseWithLocal } from './local.js';

/**
 * Which model backend parses transcripts. QUICKINV_LLM picks one explicitly
 * ("local", "claude", "off"); unset means: a configured local model wins,
 * then Claude, then none.
 * @returns {'local'|'claude'|null}
 */
export function llmBackend() {
  const want = (process.env.QUICKINV_LLM || 'auto').toLowerCase();
  if (want === 'off' || want === 'none') return null;
  const local = Boolean(localConfig());
  const claude = claudeAvailable();
  if (want === 'local') return local ? 'local' : null;
  if (want === 'claude' || want === 'anthropic') return claude ? 'claude' : null;
  return local ? 'local' : claude ? 'claude' : null;
}

export const llmAvailable = () => llmBackend() !== null;

/**
 * Parse a transcript into proposed items. Never throws: the heuristic parser
 * is the fallback for a missing or failing model.
 * @returns {Promise<{parser:'claude'|'local'|'heuristic', items:object[], warning?:string}>}
 */
export async function parseTranscript(input) {
  const backend = llmBackend();
  if (backend) {
    try {
      const items = backend === 'local' ? await parseWithLocal(input) : await parseWithClaude(input);
      return { parser: backend, items };
    } catch (err) {
      console.error(`[quickinv] ${backend} parse failed, using heuristic parser:`, err?.message || err);
      return {
        parser: 'heuristic',
        items: parseHeuristic(input.transcript),
        warning: 'AI parsing was unavailable; a simpler parser was used. Review carefully.',
      };
    }
  }
  return { parser: 'heuristic', items: parseHeuristic(input.transcript) };
}
