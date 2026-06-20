// Scores a brain diagnosis against the mechanic's confirmed truth.
//
// ponytail: term-overlap recall — of the significant words in the confirmed
// diagnosis, how many did the brain's text mention (substring match). Crude on
// purpose. Upgrade path when it stops discriminating: an LLM-as-judge that
// reads both and rates clinical agreement. Kept pure (no DB / no LLM) so it's
// unit-testable and free to run.

const STOPWORDS = new Set([
  "and",
  "the",
  "for",
  "was",
  "were",
  "are",
  "with",
  "from",
  "that",
  "this",
  "its",
  "it",
  "is",
  "of",
  "to",
  "in",
  "on",
  "or",
  "an",
  "a",
  "be",
  "at",
  "as",
]);

/** Significant lowercase terms in a free-text diagnosis: length >= 3, not a
 *  stopword, de-duplicated. */
export function significantTerms(text: string): string[] {
  const terms = text
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
  return [...new Set(terms)];
}

export interface DiagnosisScore {
  /** matched / total significant truth terms, in [0, 1]. 0 when truth is empty. */
  score: number;
  matched: string[];
  missed: string[];
}

/** Recall of the confirmed truth's significant terms within the brain's text. */
export function scoreDiagnosis(brainText: string, confirmedTruth: string): DiagnosisScore {
  const terms = significantTerms(confirmedTruth);
  const hay = brainText.toLowerCase();
  const matched = terms.filter((t) => hay.includes(t));
  const missed = terms.filter((t) => !hay.includes(t));
  const score = terms.length === 0 ? 0 : matched.length / terms.length;
  return { score, matched, missed };
}
