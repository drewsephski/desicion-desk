"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  analyzeEventSchema,
  type Analysis,
  type Depth,
  type Finding,
  type SourceRef,
  type StageStatus,
} from "./_source/schema";
import { displayUrl, parseSource } from "./_source/url";

const tiers: ReadonlyArray<{ id: Depth; label: string; time: string; website: string; repository: string }> = [
  {
    id: "surface",
    label: "Surface scan",
    time: "~20s",
    website: "Homepage, site map, and the two most telling pages.",
    repository: "Metadata, README, languages, and top-level files.",
  },
  {
    id: "deep",
    label: "Deep dive",
    time: "~1 min",
    website: "Up to 13 key pages, the full site map, and any linked GitHub repo.",
    repository: "Full file tree, manifests, commits, issues, PRs, and the linked website.",
  },
];

const findingLabels: Record<Finding["kind"], string> = {
  strength: "Strength",
  risk: "Risk",
  opportunity: "Opportunity",
  question: "Open question",
};

type Stage = { id: string; label: string; status: StageStatus; detail?: string };

type Run = {
  url: string;
  depth: Depth;
  stages: Stage[];
  sources: SourceRef[];
  drafts: string[];
  startedAt: number;
};

export function SourceIntake({
  analysis,
  disabled,
  onChange,
}: {
  readonly analysis: Analysis | undefined;
  readonly disabled: boolean;
  readonly onChange: (analysis: Analysis | undefined) => void;
}) {
  const abortRef = useRef<AbortController>(undefined);
  const inputRef = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState("");
  const [depth, setDepth] = useState<Depth>("surface");
  const [run, setRun] = useState<Run>();
  const [error, setError] = useState<string>();
  const [editing, setEditing] = useState(false);

  useEffect(() => () => abortRef.current?.abort(), []);

  const detected = detectKind(url);
  const running = run !== undefined;

  async function analyze(target: string, nextDepth: Depth) {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setError(undefined);
    setRun({ url: target, depth: nextDepth, stages: [], sources: [], drafts: [], startedAt: Date.now() });

    try {
      const response = await fetch("/api/analyze", {
        body: JSON.stringify({ url: target, depth: nextDepth }),
        headers: { "content-type": "application/json" },
        method: "POST",
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        const body = (await response.json().catch(() => undefined)) as { error?: string } | undefined;
        throw new Error(body?.error ?? `The analyzer returned ${response.status}.`);
      }

      let finished = false;
      for await (const line of readLines(response.body)) {
        const parsed = analyzeEventSchema.safeParse(safeJson(line));
        if (!parsed.success) continue;
        const event = parsed.data;

        if (event.type === "stage") {
          setRun((current) => current && { ...current, stages: upsertStage(current.stages, event) });
        } else if (event.type === "source") {
          setRun((current) => current && { ...current, sources: [...current.sources, event.source] });
        } else if (event.type === "draft") {
          setRun((current) => current && { ...current, drafts: event.labels });
        } else if (event.type === "result") {
          finished = true;
          setEditing(false);
          onChange(event.analysis);
        } else {
          finished = true;
          setError(event.message);
        }
      }
      if (!finished) throw new Error("The analysis stopped before it finished. Try again.");
    } catch (caught) {
      if (controller.signal.aborted) return;
      setError(caught instanceof Error ? caught.message : "The analysis failed. Try again.");
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = undefined;
        setRun(undefined);
      }
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || running) return;
    if (detected.error) {
      setError(detected.error);
      return;
    }
    void analyze(url.trim(), depth);
  }

  function handleCancel() {
    abortRef.current?.abort();
    abortRef.current = undefined;
    setRun(undefined);
  }

  function handleEdit() {
    setEditing(true);
    setError(undefined);
    if (analysis) setUrl(displayUrl(analysis.url));
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  if (run) {
    return <SourceProgress onCancel={handleCancel} run={run} />;
  }

  if (analysis && !editing) {
    return (
      <SourceProfile
        analysis={analysis}
        disabled={disabled}
        onClear={() => onChange(undefined)}
        onDeepen={() => void analyze(analysis.url, "deep")}
        onEdit={handleEdit}
      />
    );
  }

  return (
    <form aria-labelledby="source-heading" className="vbg-custom-source-node" noValidate onSubmit={handleSubmit}>
      <div className="vbg-custom-source-heading">
        <div>
          <span className="vbg-custom-node-kicker">Step 1 · Optional</span>
          <h2 id="source-heading">Ground the desk in a source</h2>
        </div>
        {analysis ? (
          <button className="vbg-custom-text-button" onClick={() => setEditing(false)} type="button">
            Keep {analysis.name}
          </button>
        ) : null}
      </div>
      <p className="vbg-custom-source-lede">
        Paste a website or GitHub repository. The desk reads it, then tailors every suggested decision to it.
      </p>

      <label className="vbg-custom-field-label vbg-custom-source-label" htmlFor="source-url">
        Website or repository
      </label>
      <div className="vbg-custom-url-field" data-kind={detected.kind ?? "none"}>
        <span aria-hidden="true" className="vbg-custom-url-icon">
          {detected.kind === "repository" ? <GitHubIcon /> : <GlobeIcon />}
        </span>
        <input
          aria-describedby="source-kind"
          autoCapitalize="off"
          autoComplete="off"
          disabled={disabled}
          id="source-url"
          inputMode="url"
          name="url"
          onChange={(event) => {
            setUrl(event.target.value);
            setError(undefined);
          }}
          placeholder="acme.com or github.com/acme/app"
          ref={inputRef}
          spellCheck={false}
          type="text"
          value={url}
        />
        <span className="vbg-custom-url-kind" id="source-kind">
          {detected.kind === "repository" ? "GitHub repo" : detected.kind === "website" ? "Website" : ""}
        </span>
      </div>

      <fieldset className="vbg-custom-tiers">
        <legend className="vbg-custom-field-label">Depth</legend>
        <div>
          {tiers.map((tier) => (
            <label data-checked={depth === tier.id} key={tier.id}>
              <input
                checked={depth === tier.id}
                disabled={disabled}
                name="depth"
                onChange={() => setDepth(tier.id)}
                type="radio"
                value={tier.id}
              />
              <span className="vbg-custom-tier-title">
                {tier.label}
                <span>{tier.time}</span>
              </span>
              <span className="vbg-custom-tier-detail">
                {detected.kind === "repository" ? tier.repository : tier.website}
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {error ? (
        <p className="vbg-custom-source-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="vbg-custom-prompt-footer">
        <span>Public pages only. Nothing is stored on the server.</span>
        <button disabled={disabled || url.trim().length === 0} type="submit">
          Analyze source
        </button>
      </div>
    </form>
  );
}

function SourceProgress({ onCancel, run }: { readonly onCancel: () => void; readonly run: Run }) {
  const seconds = useElapsed(run.startedAt);
  const kind = detectKind(run.url).kind;
  const recent = run.sources.slice(-5).reverse();

  return (
    <section aria-busy="true" aria-labelledby="source-progress-heading" aria-live="polite" className="vbg-custom-source-node vbg-custom-running">
      <div className="vbg-custom-source-heading">
        <div>
          <span className="vbg-custom-node-kicker">
            {run.depth === "deep" ? "Deep dive" : "Surface scan"} · {kind === "repository" ? "GitHub repo" : "Website"}
          </span>
          <h2 id="source-progress-heading" translate="no">
            {displayUrl(run.url)}
          </h2>
        </div>
        <span aria-hidden="true" className="vbg-custom-status-dot" />
      </div>

      <ol className="vbg-custom-stages">
        {run.stages.length === 0 ? (
          <li data-status="active">
            <span aria-hidden="true" className="vbg-custom-stage-mark" />
            <span>Connecting…</span>
          </li>
        ) : (
          run.stages.map((stage) => (
            <li data-status={stage.status} key={stage.id}>
              <span aria-hidden="true" className="vbg-custom-stage-mark" />
              <span>{stage.label}</span>
              {stage.detail ? <span className="vbg-custom-stage-detail">{stage.detail}</span> : null}
            </li>
          ))
        )}
      </ol>

      {run.drafts.length > 0 ? (
        <div className="vbg-custom-reading">
          <p>Drafting tailored decisions</p>
          <div className="vbg-custom-prompts vbg-custom-prompts-tailored vbg-custom-drafts">
            {run.drafts.map((label) => (
              <span key={label}>{label}</span>
            ))}
          </div>
        </div>
      ) : recent.length > 0 ? (
        <div className="vbg-custom-reading">
          <p>
            Read {run.sources.length} {run.sources.length === 1 ? "source" : "sources"}
          </p>
          <ul>
            {recent.map((source) => (
              <li key={`${source.url}-${source.title}`}>
                <span aria-hidden="true">{sourceGlyph(source)}</span>
                <span>{source.title}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="vbg-custom-prompt-footer">
        <span className="vbg-custom-elapsed">
          {seconds}s elapsed{seconds >= (run.depth === "deep" ? 90 : 40) ? " · large sources take longer" : ""}
        </span>
        <button onClick={onCancel} type="button">
          Cancel
        </button>
      </div>
    </section>
  );
}

function SourceProfile({
  analysis,
  disabled,
  onClear,
  onDeepen,
  onEdit,
}: {
  readonly analysis: Analysis;
  readonly disabled: boolean;
  readonly onClear: () => void;
  readonly onDeepen: () => void;
  readonly onEdit: () => void;
}) {
  return (
    <section aria-labelledby="source-profile-heading" className="vbg-custom-source-node vbg-custom-complete">
      <div className="vbg-custom-source-heading">
        <div>
          <span className="vbg-custom-node-kicker">
            {analysis.kind === "repository" ? "GitHub repo" : "Website"} ·{" "}
            {analysis.depth === "deep" ? "Deep dive" : "Surface scan"}
          </span>
          <h2 id="source-profile-heading" translate="no">
            {analysis.name}
          </h2>
        </div>
        <span aria-hidden="true" className="vbg-custom-status-dot" />
      </div>
      <p className="vbg-custom-source-tagline">{analysis.tagline}</p>
      <a className="vbg-custom-source-link" href={analysis.url} rel="noreferrer" target="_blank" translate="no">
        {displayUrl(analysis.url)}
        <span aria-hidden="true"> ↗</span>
      </a>

      {analysis.stats.length > 0 ? (
        <dl className="vbg-custom-source-stats">
          {analysis.stats.map((stat) => (
            <div key={stat.label}>
              <dt>{stat.label}</dt>
              <dd>{stat.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      <p className="vbg-custom-source-summary">{analysis.summary}</p>

      {analysis.facts.length > 0 ? (
        <dl className="vbg-custom-source-facts">
          {analysis.facts.map((fact) => (
            <div key={fact.label}>
              <dt>{fact.label}</dt>
              <dd>{fact.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      <details className="vbg-custom-disclosure">
        <summary>
          {analysis.findings.length} findings
          <span>{analysis.audience}</span>
        </summary>
        <ul className="vbg-custom-findings">
          {analysis.findings.map((finding) => (
            <li data-kind={finding.kind} key={finding.title}>
              <span>{findingLabels[finding.kind]}</span>
              <strong>{finding.title}</strong>
              <p>{finding.detail}</p>
            </li>
          ))}
        </ul>
      </details>

      <details className="vbg-custom-disclosure">
        <summary>
          {analysis.sources.length} sources read
          <span>via {analysis.provider}</span>
        </summary>
        <ul className="vbg-custom-source-list">
          {analysis.sources.map((source) => (
            <li key={`${source.url}-${source.title}`}>
              <span aria-hidden="true">{sourceGlyph(source)}</span>
              <a href={source.url} rel="noreferrer" target="_blank">
                {source.title}
              </a>
            </li>
          ))}
        </ul>
      </details>

      <div className="vbg-custom-prompt-footer">
        <span>The desk reads this brief with every decision.</span>
        <div className="vbg-custom-source-actions">
          <button className="vbg-custom-text-button" disabled={disabled} onClick={onClear} type="button">
            Remove
          </button>
          <button className="vbg-custom-text-button" disabled={disabled} onClick={onEdit} type="button">
            Change source
          </button>
          {analysis.depth === "surface" ? (
            <button disabled={disabled} onClick={onDeepen} type="button">
              Run deep dive
            </button>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function useElapsed(startedAt: number): number {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const interval = window.setInterval(() => setSeconds(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => window.clearInterval(interval);
  }, [startedAt]);
  return seconds;
}

function detectKind(input: string): { kind?: "website" | "repository"; error?: string } {
  if (input.trim().length === 0) return {};
  try {
    return { kind: parseSource(input).kind };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Enter a valid URL." };
  }
}

function upsertStage(stages: readonly Stage[], next: Stage): Stage[] {
  const index = stages.findIndex((stage) => stage.id === next.id);
  if (index === -1) return [...stages, next];
  return stages.map((stage, position) =>
    position === index ? { ...next, detail: next.detail ?? stage.detail } : stage,
  );
}

function sourceGlyph(source: SourceRef): string {
  if (source.kind === "file") return "◇";
  if (source.kind === "api") return "◆";
  return "○";
}

async function* readLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) yield line;
      newline = buffer.indexOf("\n");
    }
  }
  if (buffer.trim()) yield buffer.trim();
}

function safeJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

function GlobeIcon() {
  return (
    <svg fill="none" height="16" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 16 16" width="16">
      <circle cx="8" cy="8" r="6.25" />
      <path d="M1.75 8h12.5M8 1.75c1.7 1.8 2.5 3.9 2.5 6.25S9.7 12.45 8 14.25C6.3 12.45 5.5 10.35 5.5 8S6.3 3.55 8 1.75Z" />
    </svg>
  );
}

function GitHubIcon() {
  return (
    <svg fill="currentColor" height="16" viewBox="0 0 16 16" width="16">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}
