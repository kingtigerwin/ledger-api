import type { Locale } from "./schemas";

/**
 * The first language Ledger has, from a browser's `Accept-Language` (`zh-CN,zh;q=0.9,en;q=0.8`), taken in order
 * of the `q` weights. Any Chinese, Traditional included, gets Simplified: closer for its reader than English.
 */
export function localeFromAcceptLanguage(header: string | undefined): Locale | undefined {
  const tags = (header ?? "")
    .split(",")
    .map((part, index) => {
      const [tag = "", ...params] = part.trim().split(";");
      const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
      return { tag: tag.trim().toLowerCase(), weight: q ? Number(q.slice(2)) : 1, index };
    })
    .filter(({ tag, weight }) => tag && weight > 0)
    .sort((a, b) => b.weight - a.weight || a.index - b.index);
  for (const { tag } of tags) {
    if (tag === "zh" || tag.startsWith("zh-")) return "zh-CN";
    if (tag === "en" || tag.startsWith("en-")) return "en";
  }
  return undefined;
}
