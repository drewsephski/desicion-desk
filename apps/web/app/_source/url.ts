export type ParsedSource =
  | { kind: "website"; url: URL }
  | { kind: "repository"; url: URL; owner: string; repo: string; ref?: string };

const REPO_SHORTHAND = /^([a-z\d](?:[a-z\d-]{0,38}))\/([\w.-]{1,100})$/i;
const RESERVED_GITHUB_PATHS = new Set([
  "about",
  "collections",
  "enterprise",
  "explore",
  "features",
  "login",
  "marketplace",
  "orgs",
  "pricing",
  "settings",
  "sponsors",
  "topics",
  "trending",
]);

/** Parses user input into a website or GitHub repository. Throws a readable message on bad input. */
export function parseSource(input: string): ParsedSource {
  const trimmed = input.trim();
  const shorthand = REPO_SHORTHAND.exec(trimmed);
  if (shorthand && !shorthand[1]!.includes(".")) {
    return repository(shorthand[1]!, shorthand[2]!);
  }

  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    throw new Error("Enter a website or GitHub repository URL.");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Only http and https URLs are supported.");
  }
  if (!url.hostname.includes(".") || isPrivateHost(url.hostname)) {
    throw new Error("Enter a public website or GitHub repository.");
  }

  const host = url.hostname.replace(/^www\./, "").toLowerCase();
  if (host === "github.com") {
    const [owner, rawRepo, section, ref] = url.pathname.split("/").filter(Boolean);
    if (!owner || !rawRepo || RESERVED_GITHUB_PATHS.has(owner.toLowerCase())) {
      throw new Error("Paste a GitHub repository URL, like github.com/owner/repo.");
    }
    return repository(owner, rawRepo.replace(/\.git$/, ""), section === "tree" ? ref : undefined);
  }

  url.hash = "";
  return { kind: "website", url };
}

export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return true;
  }
  if (host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80")) {
    return host.includes(":");
  }

  const octets = host.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part))) return false;
  const [a, b] = octets as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

export function displayUrl(url: string): string {
  return url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
}

function repository(owner: string, repo: string, ref?: string): ParsedSource {
  return {
    kind: "repository",
    owner,
    repo,
    ref,
    url: new URL(`https://github.com/${owner}/${repo}`),
  };
}
