import * as cheerio from "cheerio";

import type { ArticleSource } from "../pipeline/types.js";

const paywallSignals = [
  "subscribe to continue",
  "sign in to continue",
  "log in to continue",
  "subscriber-only",
  "subscriber only",
  "members only",
  "this content is for subscribers",
  "create an account to continue",
  "region unavailable",
];

const cleanWhitespace = (value: string): string => value.replace(/\s+/g, " ").trim();

const extractReadableText = (html: string): { title?: string | undefined; text: string } => {
  const $ = cheerio.load(html);
  $("script, style, noscript, svg, iframe").remove();

  const title = cleanWhitespace($("title").first().text() || $("h1").first().text());
  const articleText = $("article").text();
  const paragraphText = $("p")
    .toArray()
    .map((node) => cleanWhitespace($(node).text()))
    .filter(Boolean)
    .join("\n\n");

  const text = cleanWhitespace(articleText).length > cleanWhitespace(paragraphText).length
    ? cleanWhitespace(articleText)
    : paragraphText;

  return {
    title: title || undefined,
    text: cleanWhitespace(text),
  };
};

const looksBlocked = (text: string): boolean => {
  const normalized = text.toLowerCase();
  return paywallSignals.some((signal) => normalized.includes(signal));
};

export class ArticleSourceService {
  public async fetchFromLink(url: string): Promise<ArticleSource> {
    try {
      const response = await fetch(url, {
        headers: {
          "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36",
          "accept-language": "en-US,en;q=0.9",
        },
        redirect: "follow",
      });

      if (!response.ok) {
        return {
          url,
          accessible: false,
          reason: `HTTP ${response.status}`,
        };
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("text/html")) {
        return {
          url,
          accessible: false,
          reason: `Unsupported content type: ${contentType}`,
        };
      }

      const html = await response.text();
      const extracted = extractReadableText(html);

      if (!extracted.text || extracted.text.length < 900 || looksBlocked(extracted.text)) {
        return {
          url,
          title: extracted.title,
          text: extracted.text,
          accessible: false,
          reason: "Insufficient accessible article text was extracted.",
        };
      }

      return {
        url,
        title: extracted.title,
        text: extracted.text,
        accessible: true,
      };
    } catch (error) {
      return {
        url,
        accessible: false,
        reason: error instanceof Error ? error.message : "Unknown fetch error",
      };
    }
  }
}
