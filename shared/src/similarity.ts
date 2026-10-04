/**
 * Text overlap used to *suggest* which reference-PDF page shows which slide.
 * Suggestions always require creator verification; counts never prove order.
 */

const STOP = new Set(['the', 'and', 'for', 'are', 'with', 'that', 'this', 'from', 'into', 'then', 'they', 'you', 'your', 'our', 'its', 'not', 'any', 'all', 'can']);

export function tokens(text: string): Set<string> {
  const norm = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ');
  return new Set(norm.split(' ').filter((w) => w.length >= 3 && !STOP.has(w)));
}

export function overlap(a: Set<string>, b: Set<string>): { shared: number; score: number } {
  if (a.size === 0 || b.size === 0) return { shared: 0, score: 0 };
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return { shared, score: shared / Math.min(a.size, b.size) };
}

export interface PageSuggestion {
  slideId: string;
  pageNumber: number | null;
  sharedWords: number;
}

/**
 * Order-preserving alignment of slides to pages (gaps allowed for hidden
 * slides or extra pages). A pair is only suggested when it shares at least two
 * distinctive words and half of the smaller vocabulary.
 */
export function suggestPageMapping(slides: Array<{ id: string; text: string }>, pages: Array<{ number: number; text: string }>): PageSuggestion[] {
  const st = slides.map((s) => tokens(s.text));
  const pt = pages.map((p) => tokens(p.text));
  const n = slides.length;
  const m = pages.length;
  const sim: number[][] = st.map((a) => pt.map((b) => {
    const o = overlap(a, b);
    return o.shared >= 2 && o.score >= 0.5 ? o.score : 0;
  }));
  // DP over (i, j): best total similarity aligning first i slides with first j pages.
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!, dp[i - 1]![j - 1]! + sim[i - 1]![j - 1]!);
    }
  }
  const result: PageSuggestion[] = slides.map((s) => ({ slideId: s.id, pageNumber: null, sharedWords: 0 }));
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    const s = sim[i - 1]![j - 1]!;
    if (s > 0 && dp[i]![j] === dp[i - 1]![j - 1]! + s) {
      result[i - 1] = { slideId: slides[i - 1]!.id, pageNumber: pages[j - 1]!.number, sharedWords: overlap(st[i - 1]!, pt[j - 1]!).shared };
      i--;
      j--;
    } else if (dp[i]![j] === dp[i - 1]![j]) i--;
    else j--;
  }
  return result;
}
