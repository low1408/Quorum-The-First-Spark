export type RougeScore = {
  precision: number;
  recall: number;
  f1: number;
};

export type RougeResult = {
  rouge1: RougeScore;
  rouge2: RougeScore;
  rougeL: RougeScore;
};

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function ngrams(tokens: string[], n: number): string[] {
  if (tokens.length < n) return [];

  const result: string[] = [];
  for (let i = 0; i <= tokens.length - n; i += 1) {
    result.push(tokens.slice(i, i + n).join(' '));
  }
  return result;
}

function counts(items: string[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const item of items) {
    map.set(item, (map.get(item) || 0) + 1);
  }
  return map;
}

function overlapCount(referenceItems: string[], candidateItems: string[]): number {
  const referenceCounts = counts(referenceItems);
  const candidateCounts = counts(candidateItems);
  let overlap = 0;

  for (const [item, candidateCount] of candidateCounts.entries()) {
    overlap += Math.min(candidateCount, referenceCounts.get(item) || 0);
  }

  return overlap;
}

function prf(overlap: number, referenceTotal: number, candidateTotal: number): RougeScore {
  const precision = candidateTotal === 0 ? 0 : overlap / candidateTotal;
  const recall = referenceTotal === 0 ? 0 : overlap / referenceTotal;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1 };
}

function longestCommonSubsequenceLength(a: string[], b: string[]): number {
  const previous = new Array(b.length + 1).fill(0);
  const current = new Array(b.length + 1).fill(0);

  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = a[i - 1] === b[j - 1]
        ? previous[j - 1] + 1
        : Math.max(previous[j], current[j - 1]);
    }

    for (let j = 0; j <= b.length; j += 1) {
      previous[j] = current[j];
      current[j] = 0;
    }
  }

  return previous[b.length];
}

export function calculateRouge(reference: string, candidate: string): RougeResult {
  const referenceTokens = tokenize(reference);
  const candidateTokens = tokenize(candidate);

  const referenceUnigrams = ngrams(referenceTokens, 1);
  const candidateUnigrams = ngrams(candidateTokens, 1);
  const referenceBigrams = ngrams(referenceTokens, 2);
  const candidateBigrams = ngrams(candidateTokens, 2);

  const rouge1Overlap = overlapCount(referenceUnigrams, candidateUnigrams);
  const rouge2Overlap = overlapCount(referenceBigrams, candidateBigrams);
  const rougeLOverlap = longestCommonSubsequenceLength(referenceTokens, candidateTokens);

  return {
    rouge1: prf(rouge1Overlap, referenceUnigrams.length, candidateUnigrams.length),
    rouge2: prf(rouge2Overlap, referenceBigrams.length, candidateBigrams.length),
    rougeL: prf(rougeLOverlap, referenceTokens.length, candidateTokens.length)
  };
}

export function formatRouge(result: RougeResult): string {
  const lines = [
    ['metric', 'precision', 'recall', 'f1'],
    ['ROUGE-1', result.rouge1.precision, result.rouge1.recall, result.rouge1.f1],
    ['ROUGE-2', result.rouge2.precision, result.rouge2.recall, result.rouge2.f1],
    ['ROUGE-L', result.rougeL.precision, result.rougeL.recall, result.rougeL.f1]
  ];

  return lines
    .map((row) => row.map((cell) => typeof cell === 'number' ? cell.toFixed(4) : cell).join('\t'))
    .join('\n');
}

