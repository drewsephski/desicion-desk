import { SourceError, type Collected, type CollectOptions, type Emit } from "./collect";
import { collectRepository } from "./github";
import type { Analysis, Depth } from "./schema";
import { synthesize } from "./synthesize";
import { parseSource } from "./url";
import { collectWebsite } from "./website";

export async function analyzeSource(input: string, depth: Depth, emit: Emit, signal: AbortSignal): Promise<Analysis> {
  let source: ReturnType<typeof parseSource>;
  try {
    source = parseSource(input);
  } catch (error) {
    throw new SourceError(error instanceof Error ? error.message : "Enter a valid URL.");
  }
  const options: CollectOptions = { depth, emit, signal };

  let primary: Collected;
  let linked: Collected | undefined;

  if (source.kind === "repository") {
    const repo = await collectRepository(source, options);
    primary = repo;
    const homepage = depth === "deep" ? linkableHomepage(repo.homepage) : undefined;
    if (homepage) {
      linked = await collectWebsite(homepage, { depth: "surface", emit: linkedEmit(emit, "Website"), signal }).catch(() => {
        emit({ type: "stage", id: "linked-resolve", label: "Linked website could not be read", status: "skipped" });
        return undefined;
      });
    }
  } else {
    const site = await collectWebsite(source.url, options);
    primary = site;
    if (depth === "deep" && site.linkedRepository) {
      const [owner, repo] = site.linkedRepository.split("/") as [string, string];
      const repoDepth: Depth = process.env.GITHUB_TOKEN ? "deep" : "surface";
      linked = await collectRepository({ owner, repo }, { depth: repoDepth, emit: linkedEmit(emit, "Repository"), signal }).catch(
        () => {
          emit({ type: "stage", id: "linked-repo", label: "Linked repository could not be read", status: "skipped" });
          return undefined;
        },
      );
    }
  }

  emit({ type: "stage", id: "synthesize", label: "Synthesizing findings and prompts", status: "active" });
  let synthesis;
  try {
    synthesis = await synthesize({
      depth,
      documents: [...primary.documents, ...(linked?.documents ?? [])],
      emit,
      kind: source.kind,
      name: primary.name,
      signal,
      stats: primary.stats,
      url: primary.url,
    });
  } catch (error) {
    emit({ type: "stage", id: "synthesize", label: "Synthesis failed", status: "error" });
    if (signal.aborted) throw error;
    throw new SourceError("The analyst model could not summarize this source. Check OPENROUTER_API_KEY and try again.");
  }
  emit({ type: "stage", id: "synthesize", label: "Synthesized findings and prompts", status: "done" });

  return {
    ...synthesis,
    id: crypto.randomUUID(),
    url: primary.url,
    kind: source.kind,
    depth,
    provider: linked ? `${primary.provider} + ${linked.provider}` : primary.provider,
    stats: [...primary.stats, ...(linked?.stats.slice(0, 1).map((stat) => ({ ...stat, label: `Linked ${stat.label.toLowerCase()}` })) ?? [])],
    sources: [...primary.sources, ...(linked?.sources ?? [])],
    createdAt: Date.now(),
  };
}

function linkableHomepage(homepage: string | undefined): URL | undefined {
  if (!homepage) return undefined;
  try {
    const parsed = parseSource(homepage);
    return parsed.kind === "website" ? parsed.url : undefined;
  } catch {
    return undefined;
  }
}

/** Namespaces the stages of a linked source so they render as their own rows. */
function linkedEmit(emit: Emit, label: string): Emit {
  return (event) => {
    if (event.type !== "stage") return emit(event);
    emit({ ...event, id: `linked-${event.id}`, label: `${label} · ${event.label}` });
  };
}
