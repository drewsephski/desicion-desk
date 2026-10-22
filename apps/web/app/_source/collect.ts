import type { AnalyzeEvent, Depth, SourceRef, Stat } from "./schema";

export type Emit = (event: AnalyzeEvent) => void;

/** One piece of evidence handed to the synthesizer. */
export type Document = {
  title: string;
  url: string;
  content: string;
};

export type Collected = {
  name: string;
  url: string;
  provider: string;
  documents: Document[];
  stats: Stat[];
  sources: SourceRef[];
};

export type CollectOptions = {
  depth: Depth;
  emit: Emit;
  signal: AbortSignal;
};

export class SourceError extends Error {}

export async function fetchWithTimeout(
  input: string,
  init: RequestInit & { timeoutMs?: number; signal: AbortSignal },
): Promise<Response> {
  const { timeoutMs = 30_000, signal, ...rest } = init;
  return fetch(input, {
    ...rest,
    signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
  });
}

/** Runs `task` over `items` with at most `limit` in flight, preserving order. Failed items resolve to undefined. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<Array<R | undefined>> {
  const results: Array<R | undefined> = new Array(items.length);
  let next = 0;

  async function worker() {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = await task(items[index]!, index);
      } catch {
        results[index] = undefined;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export function clip(text: string, max: number): string {
  const clean = text.replace(/\n{3,}/g, "\n\n").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max)}\n…[truncated]`;
}

export const numberFormatter = new Intl.NumberFormat("en", { notation: "compact" });
