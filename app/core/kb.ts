import type { KbArticle } from "./types";

const STOP = new Set("the and for that this with have has had was are you your can not but all any our from there when what how who why does did into out about just very been will would could should one two get got".split(" "));
const tok = (s: string) => s.toLowerCase().split(/[^a-zäöüß0-9]+/).filter((w) => w.length > 2 && !STOP.has(w));

/** Small BM25 ranker. In Convex you'd swap this for a searchIndex / vector index. */
export function searchKb(articles: KbArticle[], query: string, limit: number): KbArticle[] {
  const q = tok(query);
  const docs = articles.map((a) => tok(a.title + " " + a.title + " " + a.body));
  const avg = docs.reduce((n, d) => n + d.length, 0) / (docs.length || 1);
  const k1 = 1.4, b = 0.75;
  return articles
    .map((a, i) => {
      let score = 0;
      for (const t of new Set(q)) {
        const tf = docs[i].filter((w) => w === t).length;
        if (!tf) continue;
        const df = docs.filter((d) => d.includes(t)).length;
        const idf = Math.log(1 + (docs.length - df + 0.5) / (df + 0.5));
        score += (idf * tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * docs[i].length) / avg));
      }
      return { a, score };
    })
    .filter((x) => x.score >= 0.5) // drop weak, incidental matches
    .sort((x, y) => y.score - x.score)
    .slice(0, limit)
    .map((x) => x.a);
}
