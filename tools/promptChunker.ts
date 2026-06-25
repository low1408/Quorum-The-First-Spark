/**
 * Splits a long prompt into chunks that fit within a provider's character budget.
 *
 * All intermediate chunks are wrapped with a "do not reply" directive so the model
 * acknowledges receipt with a minimal token response (e.g. "OK (1/3)") rather than
 * generating a full answer. Only the LAST chunk is sent without the wrapper and is
 * expected to produce the real response.
 *
 * The splitter tries to break on paragraph boundaries (\n\n) to preserve semantic
 * coherence within each chunk. If no suitable boundary exists, it hard-splits at
 * the character limit.
 *
 * @param prompt    The full prompt string to split.
 * @param maxChars  Maximum characters allowed per chunk.
 * @param partLabel Human-readable label for log messages, e.g. "defense prompt".
 * @returns         An array of chunk strings. Length is always >= 1.
 *                  If the prompt fits within maxChars, returns a single-element array.
 */
export function splitPromptIntoChunks(
  prompt: string,
  maxChars: number,
  partLabel: string = 'prompt'
): string[] {
  if (prompt.length <= maxChars) {
    return [prompt];
  }

  const chunks: string[] = [];
  let offset = 0;

  while (offset < prompt.length) {
    let end = offset + maxChars;

    if (end < prompt.length) {
      // Try to split at a paragraph boundary (\n\n) in the back half of the budget
      // to avoid breaking mid-sentence. Only use the boundary if it falls in the
      // back 50% of the window so we don't create pathologically small chunks.
      const boundarySearch = prompt.lastIndexOf('\n\n', end);
      if (boundarySearch > offset + Math.floor(maxChars * 0.5)) {
        end = boundarySearch + 2; // include the trailing \n\n in this chunk
      }
    } else {
      end = prompt.length;
    }

    chunks.push(prompt.slice(offset, end));
    offset = end;
  }

  const totalParts = chunks.length;

  // Wrap every intermediate chunk (all but the last) with a do-not-reply directive.
  // The model is instructed to output only a brief acknowledgment token, avoiding
  // wasted generation on pure context-loading segments.
  return chunks.map((chunk, i) => {
    const isLast = i === totalParts - 1;
    if (isLast) {
      return chunk;
    }

    const partNumber = i + 1;
    return (
      `[CONTEXT LOADING — Part ${partNumber}/${totalParts} of ${partLabel}. ` +
      `This is background context only. Do NOT produce a reply yet. ` +
      `Acknowledge receipt only with the single token: OK (${partNumber}/${totalParts}). ` +
      `Wait for the next part before doing anything else.]\n\n` +
      chunk
    );
  });
}
