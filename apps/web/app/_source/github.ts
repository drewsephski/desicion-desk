import {
  clip,
  fetchWithTimeout,
  mapLimit,
  numberFormatter,
  SourceError,
  type Collected,
  type CollectOptions,
  type Document,
  type Emit,
} from "./collect";
import type { Depth, SourceRef, Stat } from "./schema";

const MANIFESTS = [
  "package.json",
  "pnpm-workspace.yaml",
  "pyproject.toml",
  "requirements.txt",
  "Cargo.toml",
  "go.mod",
  "Gemfile",
  "composer.json",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "mix.exs",
  "Package.swift",
  "deno.json",
  "Dockerfile",
  "docker-compose.yml",
  "vercel.json",
  "netlify.toml",
  "fly.toml",
  "turbo.json",
  "tsconfig.json",
];
const DOCS = ["CONTRIBUTING.md", "CHANGELOG.md", "ROADMAP.md", "SECURITY.md", "ARCHITECTURE.md", "AGENTS.md", "CLAUDE.md"];
const README_CHARS = { surface: 12_000, deep: 16_000 } as const;
const FILE_CHARS = 4_000;
const TREE_LINES = 350;

type Repo = {
  full_name: string;
  name: string;
  description: string | null;
  homepage: string | null;
  html_url: string;
  default_branch: string;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  subscribers_count?: number;
  language: string | null;
  license: { spdx_id: string | null; name: string } | null;
  topics?: string[];
  archived: boolean;
  fork: boolean;
  created_at: string;
  pushed_at: string;
  size: number;
};

type TreeEntry = { path: string; type: "blob" | "tree" | "commit"; size?: number };

export async function collectRepository(
  target: { owner: string; repo: string; ref?: string },
  { depth, emit, signal }: CollectOptions,
): Promise<Collected & { homepage?: string }> {
  const api = github(signal);
  const slug = `${target.owner}/${target.repo}`;
  const stage = "repo";
  const label = "Reading the repository";

  emit({ type: "stage", id: stage, label, status: "active", detail: slug });
  let repo: Repo;
  try {
    repo = await api.json<Repo>(`/repos/${slug}`);
  } catch (error) {
    emit({ type: "stage", id: stage, label, status: "error", detail: slug });
    throw error;
  }
  const ref = target.ref ?? repo.default_branch;
  const sources: SourceRef[] = [{ kind: "api", title: repo.full_name, url: repo.html_url }];
  emit({ type: "source", source: sources[0]! });

  const [readme, languages, releases] = await Promise.all([
    api.text(`/repos/${slug}/readme`, "application/vnd.github.raw").catch(() => ""),
    api.json<Record<string, number>>(`/repos/${slug}/languages`).catch(() => ({})),
    api.json<Array<{ tag_name: string; name: string | null; published_at: string; body: string | null }>>(
      `/repos/${slug}/releases?per_page=${depth === "deep" ? 5 : 1}`,
    ).catch(() => []),
  ]);
  if (readme) addSource(emit, sources, { kind: "file", title: "README", url: `${repo.html_url}#readme` });

  const documents: Document[] = [
    {
      title: `${repo.full_name} metadata`,
      url: repo.html_url,
      content: repoMetadata(repo, languages, releases),
    },
  ];
  if (readme) documents.push({ title: "README", url: `${repo.html_url}#readme`, content: clip(readme, README_CHARS[depth]) });

  let tree: TreeEntry[] = [];
  let truncatedTree = false;
  if (depth === "deep") {
    const result = await api
      .json<{ tree: TreeEntry[]; truncated: boolean }>(`/repos/${slug}/git/trees/${encodeURIComponent(ref)}?recursive=1`)
      .catch(() => ({ tree: [] as TreeEntry[], truncated: false }));
    tree = result.tree;
    truncatedTree = result.truncated;
  } else {
    const listing = await api
      .json<Array<{ path: string; type: string; size: number }>>(`/repos/${slug}/contents?ref=${encodeURIComponent(ref)}`)
      .catch(() => []);
    tree = listing.map((entry) => ({ path: entry.path, type: entry.type === "dir" ? "tree" : "blob", size: entry.size }));
  }
  if (tree.length > 0) {
    documents.push({ title: "File tree", url: `${repo.html_url}/tree/${ref}`, content: describeTree(tree, truncatedTree) });
  }
  emit({ type: "stage", id: stage, label: "Read the repository", status: "done", detail: slug });

  if (depth === "deep") {
    emit({ type: "stage", id: "read", label: "Reading code, issues, and history", status: "active" });
    const paths = new Set(tree.filter((entry) => entry.type === "blob").map((entry) => entry.path));
    const workflowFiles = [...paths].filter((path) => path.startsWith(".github/workflows/")).slice(0, 3);
    const nestedManifests = [...paths]
      .filter((path) => /^(apps|packages|services|crates)\/[^/]+\/(package\.json|Cargo\.toml|pyproject\.toml|go\.mod)$/.test(path))
      .slice(0, 6);
    const wanted = [...MANIFESTS, ...DOCS].filter((path) => paths.has(path)).concat(nestedManifests, workflowFiles);

    const [files, commits, issues, pulls, contributors] = await Promise.all([
      mapLimit(wanted.slice(0, 18), 6, async (path) => {
        const content = await raw(slug, ref, path, signal);
        addSource(emit, sources, { kind: "file", title: path, url: `${repo.html_url}/blob/${ref}/${path}` });
        return { path, content };
      }),
      api.json<Array<{ commit: { message: string; author: { name: string; date: string } | null } }>>(
        `/repos/${slug}/commits?sha=${encodeURIComponent(ref)}&per_page=25`,
      ).catch(() => []),
      api.json<Array<{ number: number; title: string; comments: number; labels: Array<{ name: string }>; pull_request?: unknown; created_at: string; reactions?: { total_count: number } }>>(
        `/repos/${slug}/issues?state=open&sort=comments&direction=desc&per_page=30`,
      ).catch(() => []),
      api.json<Array<{ number: number; title: string; draft: boolean; created_at: string }>>(
        `/repos/${slug}/pulls?state=open&per_page=15`,
      ).catch(() => []),
      api.json<Array<{ login: string; contributions: number; type: string }>>(
        `/repos/${slug}/contributors?per_page=12`,
      ).catch(() => []),
    ]);

    for (const file of files) {
      if (!file?.content) continue;
      documents.push({ title: file.path, url: `${repo.html_url}/blob/${ref}/${file.path}`, content: clip(file.content, FILE_CHARS) });
    }
    if (commits.length > 0) {
      addSource(emit, sources, { kind: "api", title: "Recent commits", url: `${repo.html_url}/commits/${ref}` });
      documents.push({
        title: "Recent commits",
        url: `${repo.html_url}/commits/${ref}`,
        content: commits
          .map((entry) => `${entry.commit.author?.date.slice(0, 10) ?? ""} ${entry.commit.author?.name ?? ""}: ${entry.commit.message.split("\n")[0]}`)
          .join("\n"),
      });
    }
    const openIssues = issues.filter((issue) => !issue.pull_request);
    if (openIssues.length > 0) {
      addSource(emit, sources, { kind: "api", title: "Open issues", url: `${repo.html_url}/issues` });
      documents.push({
        title: "Most discussed open issues",
        url: `${repo.html_url}/issues`,
        content: openIssues
          .slice(0, 20)
          .map((issue) => `#${issue.number} ${issue.title} (${issue.comments} comments${issue.labels.length ? `; ${issue.labels.map((l) => l.name).join(", ")}` : ""})`)
          .join("\n"),
      });
    }
    if (pulls.length > 0) {
      addSource(emit, sources, { kind: "api", title: "Open pull requests", url: `${repo.html_url}/pulls` });
      documents.push({
        title: "Open pull requests",
        url: `${repo.html_url}/pulls`,
        content: pulls.map((pull) => `#${pull.number} ${pull.title}${pull.draft ? " (draft)" : ""} opened ${pull.created_at.slice(0, 10)}`).join("\n"),
      });
    }
    if (contributors.length > 0) {
      documents.push({
        title: "Top contributors",
        url: `${repo.html_url}/graphs/contributors`,
        content: contributors.map((person) => `${person.login}: ${person.contributions} commits${person.type === "Bot" ? " (bot)" : ""}`).join("\n"),
      });
    }
    emit({
      type: "stage",
      id: "read",
      label: `Read ${files.filter(Boolean).length} files, ${commits.length} commits, ${openIssues.length} issues`,
      status: "done",
    });
  }

  return {
    name: repo.name,
    url: repo.html_url,
    provider: "GitHub API",
    documents,
    stats: repoStats(repo, languages, tree, depth),
    sources,
    homepage: repo.homepage || undefined,
  };
}

function github(signal: AbortSignal) {
  const token = process.env.GITHUB_TOKEN;
  async function request(path: string, accept: string): Promise<Response> {
    const response = await fetchWithTimeout(`https://api.github.com${path}`, {
      headers: {
        accept,
        "x-github-api-version": "2022-11-28",
        "user-agent": "decision-desk",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      signal,
      timeoutMs: 20_000,
    });
    if (response.status === 404) throw new SourceError("That repository was not found or is private.");
    if (response.status === 403 || response.status === 429) {
      throw new SourceError(
        token
          ? "GitHub rate limited this request. Try again shortly."
          : "GitHub's anonymous rate limit was reached. Add GITHUB_TOKEN to raise it.",
      );
    }
    if (!response.ok) throw new SourceError(`GitHub returned ${response.status}.`);
    return response;
  }
  return {
    async json<T>(path: string): Promise<T> {
      return (await (await request(path, "application/vnd.github+json")).json()) as T;
    },
    async text(path: string, accept: string): Promise<string> {
      return (await request(path, accept)).text();
    },
  };
}

async function raw(slug: string, ref: string, path: string, signal: AbortSignal): Promise<string> {
  const response = await fetchWithTimeout(
    `https://raw.githubusercontent.com/${slug}/${encodeURIComponent(ref)}/${path.split("/").map(encodeURIComponent).join("/")}`,
    { signal, timeoutMs: 15_000 },
  );
  if (!response.ok) return "";
  return (await response.text()).slice(0, 200_000);
}

function repoMetadata(
  repo: Repo,
  languages: Record<string, number>,
  releases: Array<{ tag_name: string; name: string | null; published_at: string; body: string | null }>,
): string {
  const lines = [
    `Repository: ${repo.full_name}`,
    `Description: ${repo.description ?? "none"}`,
    `Homepage: ${repo.homepage || "none"}`,
    `Stars: ${repo.stargazers_count}, forks: ${repo.forks_count}, open issues and PRs: ${repo.open_issues_count}`,
    `Primary language: ${repo.language ?? "unknown"}`,
    `Languages by bytes: ${languageShare(languages).map(([name, share]) => `${name} ${share}%`).join(", ") || "unknown"}`,
    `License: ${repo.license?.spdx_id ?? repo.license?.name ?? "none"}`,
    `Topics: ${repo.topics?.join(", ") || "none"}`,
    `Created ${repo.created_at.slice(0, 10)}, last push ${repo.pushed_at.slice(0, 10)}${repo.archived ? ", archived" : ""}${repo.fork ? ", fork" : ""}`,
    `Default branch: ${repo.default_branch}`,
  ];
  for (const release of releases) {
    lines.push(
      `Release ${release.tag_name} (${release.published_at?.slice(0, 10) ?? "unpublished"}): ${clip(release.body ?? release.name ?? "", 600)}`,
    );
  }
  return lines.join("\n");
}

function describeTree(tree: readonly TreeEntry[], truncated: boolean): string {
  const blobs = tree.filter((entry) => entry.type === "blob");
  const extensions = new Map<string, number>();
  for (const entry of blobs) {
    const extension = /\.([a-z0-9]+)$/i.exec(entry.path)?.[1]?.toLowerCase() ?? "(none)";
    extensions.set(extension, (extensions.get(extension) ?? 0) + 1);
  }
  const topExtensions = [...extensions.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  const directories = tree
    .filter((entry) => entry.type === "tree" && entry.path.split("/").length <= 3)
    .map((entry) => `${entry.path}/`);
  const shallowFiles = blobs.filter((entry) => entry.path.split("/").length <= 2).map((entry) => entry.path);
  const listing = [...directories, ...shallowFiles].sort().slice(0, TREE_LINES);

  return [
    `${blobs.length} files${truncated ? " (tree truncated by GitHub)" : ""}. Extensions: ${topExtensions.map(([ext, count]) => `${ext} ${count}`).join(", ")}`,
    "",
    ...listing,
  ].join("\n");
}

function repoStats(repo: Repo, languages: Record<string, number>, tree: readonly TreeEntry[], depth: Depth): Stat[] {
  const stats: Stat[] = [
    { label: "Stars", value: numberFormatter.format(repo.stargazers_count) },
    { label: "Language", value: languageShare(languages)[0]?.[0] ?? repo.language ?? "—" },
    { label: "Last push", value: relativeDate(repo.pushed_at) },
  ];
  if (depth === "deep") {
    stats.push({ label: "Files", value: numberFormatter.format(tree.filter((entry) => entry.type === "blob").length) });
  } else {
    stats.push({ label: "Forks", value: numberFormatter.format(repo.forks_count) });
  }
  return stats;
}

function languageShare(languages: Record<string, number>): Array<[string, number]> {
  const total = Object.values(languages).reduce((sum, bytes) => sum + bytes, 0);
  if (total === 0) return [];
  return Object.entries(languages)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([name, bytes]) => [name, Math.round((bytes / total) * 100)]);
}

function relativeDate(iso: string): string {
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  if (days < 1) return "Today";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

function addSource(emit: Emit, sources: SourceRef[], source: SourceRef) {
  sources.push(source);
  emit({ type: "source", source });
}
