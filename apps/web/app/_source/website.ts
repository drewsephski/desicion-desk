import {
  clip,
  fetchWithTimeout,
  mapLimit,
  numberFormatter,
  SourceError,
  type Collected,
  type CollectOptions,
  type Document,
} from "./collect";
import { isPrivateHost, parseSource } from "./url";

type Page = {
  url: string;
  title: string;
  description: string;
  markdown: string;
  links: string[];
};

type Provider = {
  name: string;
  concurrency: number;
  scrape(url: string, signal: AbortSignal): Promise<Page>;
  map(url: URL, limit: number, signal: AbortSignal): Promise<string[]>;
};

const PAGE_LIMIT = { surface: 2, deep: 12 } as const;
const MAP_LIMIT = { surface: 150, deep: 500 } as const;
const PAGE_CHARS = { surface: 9_000, deep: 6_000 } as const;

const PATH_WEIGHTS: ReadonlyArray<[RegExp, number]> = [
  [/pricing|plans?\b/, 10],
  [/about|company|story|mission/, 8],
  [/how-it-works|product|platform|features?/, 7],
  [/customers?|case-stud|testimonials|showcase/, 6],
  [/solutions?|use-cases?|industr/, 5],
  [/enterprise|teams?\b|business/, 5],
  [/changelog|releases|roadmap|whats-new|updates/, 5],
  [/compare|vs-|alternatives?/, 5],
  [/docs\/?$|documentation\/?$|getting-started|quickstart/, 5],
  [/integrations?|partners|marketplace|api\/?$/, 4],
  [/security|trust|compliance/, 4],
  [/careers|jobs|hiring/, 4],
  [/faq|help\/?$|support\/?$/, 4],
  [/blog\/?$|news\/?$|press/, 3],
  [/contact|demo|sales/, 2],
];
const EXCLUDED_PATH = /privacy|terms|cookie|legal|gdpr|login|signin|sign-in|signup|sign-up|register|cart|checkout|account|\/tag\/|\/tags\/|\/page\/\d|\/author\//;
const EXCLUDED_EXTENSION = /\.(pdf|png|jpe?g|gif|svg|webp|ico|xml|txt|zip|gz|mp4|mp3|css|js|json)$/i;
const LOCALE_SEGMENT = /^(?:[a-z]{2}-[a-z]{2,4}|de|fr|es|it|ja|ko|zh|pt|nl|ru|sv|pl|tr|da|fi|nb|cs|uk|he|ar|id|vi|th)$/i;

export async function collectWebsite(
  url: URL,
  { depth, emit, signal }: CollectOptions,
): Promise<Collected & { linkedRepository?: string }> {
  const provider = selectProvider();

  emit({ type: "stage", id: "resolve", label: "Reading the homepage", status: "active", detail: url.hostname });
  let home: Page;
  try {
    home = await provider.scrape(url.href, signal);
  } catch (error) {
    emit({ type: "stage", id: "resolve", label: "Reading the homepage", status: "error" });
    throw new SourceError(`Could not read ${url.hostname}. ${errorMessage(error)}`);
  }
  emit({ type: "source", source: { kind: "page", title: home.title || url.hostname, url: home.url } });
  emit({ type: "stage", id: "resolve", label: "Read the homepage", status: "done", detail: home.title || url.hostname });

  emit({ type: "stage", id: "map", label: "Mapping the site", status: "active" });
  const sameSite = (candidate: string) => isSameSite(candidate, url);
  let mapped: string[] = [];
  try {
    mapped = await provider.map(url, MAP_LIMIT[depth], signal);
  } catch {
    mapped = [];
  }
  const discovered = dedupe([...mapped, ...home.links].filter(sameSite).map(normalizePage));
  emit({
    type: "stage",
    id: "map",
    label: "Mapped the site",
    status: "done",
    detail: `${numberFormatter.format(discovered.length)} URLs found`,
  });

  const picks = rankPages(discovered, url).slice(0, PAGE_LIMIT[depth]);
  const pages: Page[] = [home];
  if (picks.length > 0) {
    const label = `Reading ${picks.length} key pages`;
    let settled = 0;
    emit({ type: "stage", id: "read", label, status: "active", detail: `0 / ${picks.length}` });
    const results = await mapLimit(picks, provider.concurrency, async (pick) => {
      try {
        const page = await provider.scrape(pick, signal);
        emit({ type: "source", source: { kind: "page", title: page.title || pathLabel(pick), url: pick } });
        return page;
      } finally {
        settled += 1;
        emit({ type: "stage", id: "read", label, status: "active", detail: `${settled} / ${picks.length}` });
      }
    });
    const read = results.filter((page): page is Page => page !== undefined && page.markdown.length > 0);
    pages.push(...read);
    emit({
      type: "stage",
      id: "read",
      label: `Read ${read.length} key pages`,
      status: read.length > 0 ? "done" : "error",
      detail: read.length < picks.length ? `${picks.length - read.length} unreadable` : "All readable",
    });
  } else {
    emit({ type: "stage", id: "read", label: "No other pages to read", status: "skipped" });
  }

  const documents: Document[] = pages.map((page) => ({
    title: page.title || pathLabel(page.url),
    url: page.url,
    content: clip(
      [page.description ? `Description: ${page.description}` : "", page.markdown].filter(Boolean).join("\n\n"),
      PAGE_CHARS[depth],
    ),
  }));

  const siteOutline = discovered.slice(0, depth === "deep" ? 120 : 60).map((link) => pathLabel(link));
  if (siteOutline.length > 0) {
    documents.push({
      title: "Site map (sampled paths)",
      url: url.href,
      content: siteOutline.join("\n"),
    });
  }

  const words = pages.reduce((total, page) => total + page.markdown.split(/\s+/).length, 0);

  return {
    name: home.title || url.hostname,
    url: home.url || url.href,
    provider: provider.name,
    documents,
    stats: [
      { label: "Pages read", value: String(pages.length) },
      { label: "URLs mapped", value: numberFormatter.format(discovered.length) },
      { label: "Words analyzed", value: numberFormatter.format(words) },
    ],
    sources: pages.map((page) => ({ kind: "page", title: page.title || pathLabel(page.url), url: page.url })),
    linkedRepository: findRepositoryLink(home.links, url),
  };
}

function selectProvider(): Provider {
  const firecrawlKey = process.env.FIRECRAWL_API_KEY;
  if (firecrawlKey) return firecrawl(firecrawlKey);
  return jinaReader(process.env.JINA_API_KEY);
}

function firecrawl(apiKey: string): Provider {
  const headers = { authorization: `Bearer ${apiKey}`, "content-type": "application/json" };

  async function call<T>(path: string, body: unknown, signal: AbortSignal): Promise<T> {
    const response = await fetchWithTimeout(`https://api.firecrawl.dev/v2/${path}`, {
      body: JSON.stringify(body),
      headers,
      method: "POST",
      signal,
      timeoutMs: 45_000,
    });
    if (response.status === 402) throw new SourceError("The Firecrawl credit balance is exhausted.");
    if (response.status === 429) throw new SourceError("Firecrawl is rate limiting requests. Try again shortly.");
    if (!response.ok) throw new SourceError(`Firecrawl returned ${response.status}.`);
    return (await response.json()) as T;
  }

  return {
    name: "Firecrawl",
    // The free plan allows two concurrent requests.
    concurrency: Number(process.env.FIRECRAWL_CONCURRENCY ?? 2),
    async scrape(url, signal) {
      const result = await call<FirecrawlScrape>(
        "scrape",
        { url, formats: ["markdown", "links"], onlyMainContent: true, timeout: 40_000, blockAds: true },
        signal,
      );
      if (!result.success || !result.data) throw new SourceError("Firecrawl could not read the page.");
      const metadata = result.data.metadata ?? {};
      return {
        url: first(metadata.url) ?? url,
        title: first(metadata.title) ?? "",
        description: first(metadata.description) ?? "",
        markdown: result.data.markdown ?? "",
        links: result.data.links ?? [],
      };
    },
    async map(url, limit, signal) {
      const result = await call<FirecrawlMap>(
        "map",
        { url: url.href, limit, includeSubdomains: false, sitemap: "include" },
        signal,
      );
      return (result.links ?? []).map((link) => (typeof link === "string" ? link : link.url));
    },
  };
}

function jinaReader(apiKey: string | undefined): Provider {
  return {
    name: apiKey ? "Jina Reader" : "Jina Reader (keyless)",
    // Keyless access allows about 20 requests a minute.
    concurrency: apiKey ? 5 : 3,
    async scrape(url, signal) {
      const response = await fetchWithTimeout(`https://r.jina.ai/${url}`, {
        headers: {
          accept: "application/json",
          "x-retain-images": "none",
          "x-with-links-summary": "true",
          "x-timeout": "25",
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        signal,
        timeoutMs: 40_000,
      });
      if (response.status === 429) throw new SourceError("The reader is rate limiting requests. Try again shortly.");
      if (!response.ok) throw new SourceError(`The reader returned ${response.status}.`);
      const body = (await response.json()) as JinaResponse;
      const data = body.data;
      if (!data?.content) throw new SourceError("The page returned no readable content.");
      const links = Array.isArray(data.links)
        ? data.links.map((link) => (Array.isArray(link) ? link[1] : String(link)))
        : Object.values(data.links ?? {});
      return {
        url: data.url ?? url,
        title: data.title ?? "",
        description: data.description ?? "",
        markdown: data.content,
        links,
      };
    },
    map: sitemapUrls,
  };
}

/** Keyless site discovery from robots.txt and sitemap.xml. */
async function sitemapUrls(url: URL, limit: number, signal: AbortSignal): Promise<string[]> {
  const origin = url.origin;
  const candidates = new Set([`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`]);

  const robots = await fetchText(`${origin}/robots.txt`, signal);
  for (const match of robots.matchAll(/^sitemap:\s*(\S+)/gim)) candidates.add(match[1]!);

  const pages: string[] = [];
  const queue = [...candidates];
  const seen = new Set<string>();
  while (queue.length > 0 && seen.size < 6 && pages.length < limit) {
    const sitemap = queue.shift()!;
    if (seen.has(sitemap)) continue;
    seen.add(sitemap);
    const xml = await fetchText(sitemap, signal);
    const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((match) => decodeXml(match[1]!));
    for (const loc of locs) {
      if (/\.xml(\.gz)?$/i.test(loc)) queue.push(loc);
      else pages.push(loc);
    }
  }

  return pages.slice(0, limit);
}

async function fetchText(target: string, signal: AbortSignal): Promise<string> {
  try {
    const parsed = new URL(target);
    if (isPrivateHost(parsed.hostname)) return "";
    const response = await fetchWithTimeout(target, {
      headers: { "user-agent": "DecisionDeskBot/1.0 (+https://eve.dev)" },
      signal,
      timeoutMs: 10_000,
    });
    if (!response.ok) return "";
    const text = await response.text();
    return text.slice(0, 2_000_000);
  } catch {
    return "";
  }
}

function rankPages(urls: readonly string[], root: URL): string[] {
  const rootPath = normalizePage(root.href);
  const scored = urls
    .filter((link) => link !== rootPath)
    .map((link) => {
      const { pathname } = new URL(link);
      const path = pathname.toLowerCase();
      const segments = path.split("/").filter(Boolean);
      if (segments.length === 0 || EXCLUDED_PATH.test(path) || EXCLUDED_EXTENSION.test(path)) {
        return { link, score: -Infinity };
      }
      if (LOCALE_SEGMENT.test(segments[0]!)) {
        return { link, score: -Infinity };
      }
      const weight = PATH_WEIGHTS.reduce((best, [pattern, value]) => (pattern.test(path) ? Math.max(best, value) : best), 0);
      return { link, score: weight - (segments.length - 1) * 1.5 - path.length / 200 };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score);

  return dedupe(scored.map((entry) => entry.link));
}

/** Picks the repository most likely to be the site's own product, not an example or a dependency. */
function findRepositoryLink(links: readonly string[], site: URL): string | undefined {
  const brand = bareHost(site.hostname).split(".")[0]!;
  const scores = new Map<string, number>();
  for (const link of links) {
    if (!/github\.com\/[^/]+\/[^/?#]+/i.test(link)) continue;
    try {
      const parsed = parseSource(link);
      if (parsed.kind !== "repository") continue;
      const owner = parsed.owner.toLowerCase();
      const repo = parsed.repo.toLowerCase();
      if (/example|demo|template|starter|sample|awesome/.test(repo)) continue;
      const key = `${owner}/${repo}`;
      const bonus = scores.has(key)
        ? 1
        : 1 +
          (repo === brand ? 6 : repo.includes(brand) ? 2 : 0) +
          (owner === brand || owner.includes(brand) ? 3 : 0);
      scores.set(key, (scores.get(key) ?? 0) + bonus);
    } catch {
      continue;
    }
  }
  const [best] = [...scores.entries()].sort((left, right) => right[1] - left[1]);
  return best?.[0];
}

function isSameSite(candidate: string, root: URL): boolean {
  try {
    const parsed = new URL(candidate);
    return bareHost(parsed.hostname) === bareHost(root.hostname) && parsed.protocol.startsWith("http");
  } catch {
    return false;
  }
}

function normalizePage(link: string): string {
  const parsed = new URL(link);
  parsed.hash = "";
  parsed.search = "";
  const href = parsed.href;
  return href.endsWith("/") && parsed.pathname !== "/" ? href.slice(0, -1) : href;
}

function pathLabel(link: string): string {
  try {
    const parsed = new URL(link);
    return parsed.pathname === "/" ? parsed.hostname : parsed.pathname;
  } catch {
    return link;
  }
}

function bareHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, "");
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function first(value: string | string[] | null | undefined): string | undefined {
  const picked = Array.isArray(value) ? value[0] : value;
  return picked ?? undefined;
}

function decodeXml(value: string): string {
  return value.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

function errorMessage(error: unknown): string {
  return error instanceof SourceError ? error.message : "The site may block automated readers.";
}

type FirecrawlScrape = {
  success: boolean;
  data?: {
    markdown?: string;
    links?: string[];
    metadata?: {
      title?: string | string[];
      description?: string | string[];
      url?: string;
    };
  };
};

type FirecrawlMap = {
  success: boolean;
  links?: Array<string | { url: string }>;
};

type JinaResponse = {
  data?: {
    title?: string;
    description?: string;
    url?: string;
    content?: string;
    links?: Record<string, string> | Array<[string, string] | string>;
  };
};
