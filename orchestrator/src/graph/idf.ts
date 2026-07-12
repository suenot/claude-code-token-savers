// Query-term IDF weighting + 3-tier seed scoring, ported from graphify's
// serve.py (_compute_idf, _score_nodes, _pick_seeds). Common terms like "error"
// that match many nodes get low weight; rare identifiers like "FooBarService"
// get high weight, so a dominant identifier wins the seed slots over noise.

import type { GraphIndex, GraphNode } from './load.ts';

const EXACT_MATCH_BONUS = 1000;
const PREFIX_MATCH_BONUS = 100;
const SUBSTRING_MATCH_BONUS = 1;
const SOURCE_MATCH_BONUS = 0.5;

/** NFKD-normalize and drop combining marks (diacritic-insensitive matching). */
export function stripDiacritics(text: unknown): string {
  const s = text == null ? '' : String(text);
  return s.normalize('NFKD').replace(/\p{Diacritic}/gu, '');
}

/** Split into word tokens (Unicode-safe), stripping punctuation and diacritics. */
export function searchTokens(text: unknown): string[] {
  return stripDiacritics(text).toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
}

/** True for Chinese/non-English tokens or English words longer than 2 chars. */
export function isSearchable(term: string): boolean {
  if (/^[a-z]+$/.test(term)) return term.length > 2;
  return true;
}

/** Tokenize a natural-language question into searchable terms. */
export function queryTerms(question: string): string[] {
  const terms: string[] = [];
  for (const raw of String(question).split(/\s+/)) {
    for (const tok of raw.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []) {
      if (isSearchable(tok)) terms.push(tok);
    }
  }
  return terms;
}

/** Normalized, lowercased label used for all matching (prefers node.norm_label). */
export function normLabel(node: GraphNode): string {
  const nl = node.norm_label;
  if (typeof nl === 'string' && nl) return nl.toLowerCase();
  return stripDiacritics(node.label ?? '').toLowerCase();
}

/** Re-tokenize raw query terms to the same normalized form node labels use. */
export function normTerms(terms: string[]): string[] {
  return terms.flatMap((t) => searchTokens(t));
}

/**
 * IDF weight per (already-normalized) term: log(1 + N/(1 + df)), where df is the
 * number of node labels containing the term. Rare terms score high.
 */
export function computeIdf(index: GraphIndex, terms: string[]): Map<string, number> {
  const N = index.nodes.size || 1;
  const uniq = [...new Set(terms)];
  const df = new Map<string, number>(uniq.map((t) => [t, 0]));
  for (const node of index.nodes.values()) {
    const label = normLabel(node);
    for (const t of uniq) {
      if (label.includes(t)) df.set(t, (df.get(t) ?? 0) + 1);
    }
  }
  const idf = new Map<string, number>();
  for (const t of uniq) idf.set(t, Math.log(1 + N / (1 + (df.get(t) ?? 0))));
  return idf;
}

/** Three-tier (exact > prefix > substring) score for each node; sorted best-first. */
export function scoreNodes(
  index: GraphIndex,
  terms: string[],
  idf: Map<string, number>,
): Array<[number, string]> {
  const norm = normTerms(terms);
  const joined = norm.join(' ');
  const joinedW = norm.length ? Math.max(...norm.map((t) => idf.get(t) ?? 1)) : 1;
  const scored: Array<[number, string]> = [];

  for (const node of index.nodes.values()) {
    const label = normLabel(node);
    const bare = label.replace(/[()]+$/, '');
    const labelTokens = searchTokens(node.label ?? '').join(' ');
    const source = String(node.source_file ?? '').toLowerCase();
    const idLower = node.id.toLowerCase();
    let score = 0;

    // Full-query tier: a multi-word query equal to (or prefixing) the whole label
    // must dominate per-token sums so path/explain resolve the same node.
    if (joined) {
      if ([label, bare, labelTokens, idLower].includes(joined)) {
        score += EXACT_MATCH_BONUS * 10 * joinedW;
      } else if (label.startsWith(joined) || bare.startsWith(joined) || labelTokens.startsWith(joined)) {
        score += PREFIX_MATCH_BONUS * 10 * joinedW;
      }
    }

    for (const t of norm) {
      const w = idf.get(t) ?? 1;
      if (t === label || t === bare) score += EXACT_MATCH_BONUS * w;
      else if (label.startsWith(t) || bare.startsWith(t)) score += PREFIX_MATCH_BONUS * w;
      else if (label.includes(t)) score += SUBSTRING_MATCH_BONUS * w;
      if (source.includes(t)) score += SOURCE_MATCH_BONUS * w;
    }

    if (score > 0) scored.push([score, node.id]);
  }

  // Score desc; ties toward the shorter label so a concise exact match beats a
  // longer superset sharing the same score; then node id for stability.
  scored.sort((a, b) => {
    if (b[0] !== a[0]) return b[0] - a[0];
    const la = (index.nodes.get(a[1])?.label ?? a[1]).length;
    const lb = (index.nodes.get(b[1])?.label ?? b[1]).length;
    if (la !== lb) return la - lb;
    return a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;
  });
  return scored;
}

/**
 * Pick up to `maxK` seed node ids, stopping once a score drops below
 * `topScore * gapRatio`. Prevents high-frequency noise from stealing seed slots
 * from a dominant identifier match.
 */
export function pickSeeds(
  index: GraphIndex,
  terms: string[],
  idf: Map<string, number>,
  maxK = 3,
  gapRatio = 0.2,
): string[] {
  const scored = scoreNodes(index, terms, idf);
  if (scored.length === 0) return [];
  const topScore = scored[0]![0];
  const seeds: string[] = [];
  for (const [score, nid] of scored.slice(0, maxK)) {
    if (seeds.length && score < topScore * gapRatio) break;
    seeds.push(nid);
  }
  return seeds;
}
