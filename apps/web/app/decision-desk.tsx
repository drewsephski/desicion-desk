"use client";

import { MarkdownClient } from "@comark/react";
import { Client, type MessageStreamEvent } from "eve/client";
import { useEveAgent } from "eve/react";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { decisionResultSchema, type DecisionResult, type MemberId } from "../../../agent/lib/schemas";
import type { Analysis } from "./_source/schema";
import {
  buildDeskPrompt,
  dissentCounts,
  emptyMemberText,
  isDissent,
  readHistory,
  readSource,
  writeHistory,
  writeSource,
  type DeskRecord,
} from "./decision-history";
import { SourceIntake } from "./source-intake";

const members: ReadonlyArray<{ id: MemberId; label: string; model: string }> = [
  { id: "grok", label: "SpaceXAI", model: "Grok 4.7" },
  { id: "claude", label: "Anthropic", model: "Claude Opus 5.5" },
  { id: "openai", label: "OpenAI", model: "GPT-6.1 Sol" },
  { id: "kimi", label: "Moonshot AI", model: "Kimi K3" },
];

type Prompt = {
  id: string;
  label: string;
  decision: string;
  context: string;
};

const prompts: ReadonlyArray<Prompt> = [
  {
    id: "ship",
    label: "Ship or wait",
    decision: "Should we ship the rewrite this week?",
    context:
      "One engineer can review, not build. Good means we stop losing invoices. The budget is the current sprint.",
  },
  {
    id: "hire",
    label: "Hire a contractor",
    decision: "Should we hire a contractor to rebuild billing?",
    context:
      "Budget is one quarter. Good means lost invoices stop. We have one engineer who can review the work.",
  },
  {
    id: "vendor",
    label: "Switch vendors",
    decision: "Should we switch to the vendor that costs half as much?",
    context:
      "Switching takes about a month. Downtime during the move is unacceptable. The current vendor has missed two deadlines.",
  },
  {
    id: "price",
    label: "Raise the price",
    decision: "Should we raise the price 20% for new customers?",
    context:
      "Current customers keep the old price. We are not profitable yet. Good means we can hire one more person this year.",
  },
];

const memberIds = new Set<MemberId>(members.map((member) => member.id));
const tokenFormatter = new Intl.NumberFormat("en", { notation: "compact" });
const costFormatter = new Intl.NumberFormat("en-US", {
  currency: "USD",
  maximumFractionDigits: 6,
  minimumFractionDigits: 2,
  style: "currency",
});

type Usage = {
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
};

type MemberState = {
  response: string;
  status: "waiting" | "running" | "complete" | "error";
  usage: Usage;
};

const initialMembers = (): Record<MemberId, MemberState> => ({
  claude: { response: "", status: "waiting", usage: {} },
  grok: { response: "", status: "waiting", usage: {} },
  kimi: { response: "", status: "waiting", usage: {} },
  openai: { response: "", status: "waiting", usage: {} },
});

export function DecisionDesk() {
  const [client] = useState(() => new Client({ host: "" }));
  const completedMembersRef = useRef(new Set<MemberId>());
  const decisionRef = useRef<HTMLTextAreaElement>(null);
  const draftRef = useRef("");
  const memberCallsRef = useRef(new Map<string, MemberId>());
  const memberCardsRef = useRef(new Map<MemberId, HTMLElement>());
  const memberTextRef = useRef(emptyMemberText());
  const runIdRef = useRef(0);
  const sourceRef = useRef<Analysis>(undefined);
  const synthesisStartedRef = useRef(false);
  const [activeId, setActiveId] = useState<string>();
  const [decision, setDecision] = useState("");
  const [history, setHistory] = useState<DeskRecord[]>([]);
  const [memberState, setMemberState] = useState(initialMembers);
  const [result, setResult] = useState<DecisionResult>();
  const [resultError, setResultError] = useState<string>();
  const [previewId, setPreviewId] = useState<string>();
  const [source, setSource] = useState<Analysis>();
  const [summaryUsage, setSummaryUsage] = useState<Usage>({});

  useEffect(() => {
    setHistory(readHistory());
    setSource(readSource());
  }, []);

  useEffect(() => {
    for (const member of members) {
      memberTextRef.current[member.id] = memberState[member.id].response;
    }
  }, [memberState]);

  const streamMember = useCallback(
    async (memberId: MemberId, sessionId: string, runId: number) => {
      const session = client.sessions.attach(sessionId, { streamIndex: 0 });

      try {
        for await (const event of session.stream()) {
          if (runIdRef.current !== runId) return;

          if (event.type === "message.appended") {
            setMemberState((current) => ({
              ...current,
              [memberId]: {
                ...current[memberId],
                response: `${current[memberId].response}${event.data.messageDelta}`,
                status: "running",
              },
            }));
          }

          if (event.type === "message.completed" && event.data.message) {
            setMemberState((current) => ({
              ...current,
              [memberId]: {
                ...current[memberId],
                response: event.data.message,
              },
            }));
          }

          if (event.type === "step.completed" && event.data.usage) {
            const usage = event.data.usage;
            setMemberState((current) => ({
              ...current,
              [memberId]: {
                ...current[memberId],
                usage: mergeUsage(current[memberId].usage, usage),
              },
            }));
          }

          if (event.type === "turn.completed" || event.type === "session.completed") {
            setMemberState((current) => ({
              ...current,
              [memberId]: { ...current[memberId], status: "complete" },
            }));
          }

          if (event.type === "step.failed" || event.type === "turn.failed") {
            setMemberState((current) => ({
              ...current,
              [memberId]: { ...current[memberId], status: "error" },
            }));
          }
        }
      } catch {
        if (runIdRef.current !== runId) return;
        setMemberState((current) => ({
          ...current,
          [memberId]: { ...current[memberId], status: "error" },
        }));
      }
    },
    [client],
  );

  const handleEvent = useCallback(
    (event: MessageStreamEvent) => {
      if (event.type === "task.started" && isMemberId(event.data.name)) {
        memberCallsRef.current.set(event.data.callId, event.data.name);
      }

      if (event.type === "agent.started" && isMemberId(event.data.name)) {
        const memberId = event.data.name;
        setMemberState((current) => ({
          ...current,
          [memberId]: { ...current[memberId], status: "running" },
        }));
        void streamMember(memberId, event.data.sessionId, runIdRef.current);
      }

      const settledMember =
        event.type === "task.settled" && event.data.status === "completed"
          ? { id: memberCallsRef.current.get(event.data.callId), output: event.data.output }
          : undefined;
      if (settledMember?.id !== undefined) {
        const memberId = settledMember.id;
        const output = typeof settledMember.output === "string" ? settledMember.output : "";
        if (output) memberTextRef.current[memberId] = output;
        completedMembersRef.current.add(memberId);
        synthesisStartedRef.current = completedMembersRef.current.size === members.length;
        setMemberState((current) => ({
          ...current,
          [memberId]: {
            ...current[memberId],
            response: output || current[memberId].response,
            status: "complete",
          },
        }));
      }

      if (event.type === "step.completed" && event.data.usage && synthesisStartedRef.current) {
        const usage = event.data.usage;
        setSummaryUsage((current) => mergeUsage(current, usage));
      }

      if (event.type === "result.completed") {
        const parsed = decisionResultSchema.safeParse(event.data.result);
        if (!parsed.success) {
          setResultError("The judge returned an invalid result. Ask the desk again.");
          return;
        }

        const record: DeskRecord = {
          id: crypto.randomUUID(),
          decision: draftRef.current,
          context: "",
          result: parsed.data,
          members: { ...memberTextRef.current },
          source: sourceRef.current,
          createdAt: Date.now(),
        };
        setHistory((current) => writeHistory([record, ...current]));
        setActiveId(record.id);
        setResult(parsed.data);
      }
    },
    [streamMember],
  );

  const agent = useEveAgent({ onEvent: handleEvent });
  const busy = agent.status === "submitted" || agent.status === "streaming";
  const error = resultError ?? agent.error?.message;
  const allMembersComplete = members.every((member) => memberState[member.id].status === "complete");
  const summaryRunning = !result && allMembersComplete && busy;
  const counts = dissentCounts(history);
  const activePrompts: ReadonlyArray<Prompt> = source
    ? source.prompts.map((prompt, index) => ({ ...prompt, id: `${source.id}-${index}` }))
    : prompts;

  function handlePromptKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  }

  function submit() {
    if (busy) return;
    const field = decisionRef.current;
    if (!field || !field.reportValidity()) return;

    const nextDecision = decision.trim();
    if (nextDecision.length === 0) return;

    draftRef.current = nextDecision;
    sourceRef.current = source;
    runIdRef.current += 1;
    completedMembersRef.current.clear();
    memberCallsRef.current.clear();
    synthesisStartedRef.current = false;
    setActiveId(undefined);
    setMemberState(initialMembers());
    setResult(undefined);
    setResultError(undefined);
    setSummaryUsage({});
    agent.reset();
    void agent.send(buildDeskPrompt(nextDecision, source), { outputSchema: decisionResultSchema });
  }

  function handleOpenRecord(record: DeskRecord) {
    if (busy) return;
    runIdRef.current += 1;
    setDecision(recordText(record));
    if (record.source) handleSourceChange(record.source);
    setMemberState(membersFromRecord(record));
    setResult(record.result);
    setResultError(undefined);
    setSummaryUsage({});
    setActiveId(record.id);
  }

  function handleNewDecision() {
    if (busy) return;
    runIdRef.current += 1;
    setDecision("");
    setMemberState(initialMembers());
    setResult(undefined);
    setResultError(undefined);
    setSummaryUsage({});
    setActiveId(undefined);
    decisionRef.current?.focus();
  }

  function handleOpenDissent(memberId: MemberId) {
    const card = memberCardsRef.current.get(memberId);
    card?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    card?.focus();
  }

  function handleSourceChange(next: Analysis | undefined) {
    setSource(next);
    writeSource(next);
    if (activePrompts.some((prompt) => promptText(prompt) === decision)) setDecision("");
  }

  function handleSelectPrompt(prompt: Prompt) {
    if (busy) return;
    setDecision(promptText(prompt));
    if (result || activeId) {
      runIdRef.current += 1;
      setMemberState(initialMembers());
      setResult(undefined);
      setResultError(undefined);
      setSummaryUsage({});
      setActiveId(undefined);
    }
    decisionRef.current?.focus();
  }

  const selectedPromptId = activePrompts.find((prompt) => promptText(prompt) === decision)?.id;
  const previewPrompt =
    activePrompts.find((prompt) => prompt.id === previewId) ??
    activePrompts.find((prompt) => prompt.id === selectedPromptId);

  return (
    <div className="vbg-report">
      <div className="vbg-shell">
        <a className="vbg-skip-link" href="#main-content">
          Skip to content
        </a>
        <header className="vbg-header vbg-custom-header">
          <div className="vbg-masthead">
            <span className="vbg-identity">
              <span aria-label="Vercel" className="vbg-wordmark" role="img" />
            </span>
          </div>
        </header>
        <main id="main-content">
          <section className="vbg-custom-flow">
            <div className="vbg-custom-intro">
              <p className="vbg-custom-node-kicker">Decision Desk</p>
              <h1>One choice. Four independent calls.</h1>
              <p>Point the desk at your website or repo first, and every suggestion is written for it.</p>
            </div>

            {history.length > 0 ? (
              <HistoryList
                activeId={activeId}
                counts={counts}
                history={history}
                onNewDecision={handleNewDecision}
                onOpen={handleOpenRecord}
              />
            ) : null}

            {error ? (
              <p className="vbg-custom-status-message" role="alert">
                {error}
              </p>
            ) : null}

            <SourceIntake analysis={source} disabled={busy} onChange={handleSourceChange} />

            <StraightConnector />

            <form
              aria-busy={busy}
              className="vbg-custom-prompt-node"
              onSubmit={(event) => {
                event.preventDefault();
                submit();
              }}
            >
              <div className="vbg-custom-prompt-kicker">
                <span className="vbg-custom-node-kicker">Step 2 · The choice</span>
                {source ? (
                  <span className="vbg-custom-context-chip" translate="no">
                    <span aria-hidden="true" />
                    {source.name} context attached
                  </span>
                ) : null}
              </div>
              <p className="vbg-custom-prompt-hint" id="prompt-hint">
                {source
                  ? `Suggestions tailored to ${source.name}. Pick one, or write the choice in your own words.`
                  : "Pick an example, or write the choice in your own words."}
              </p>
              <div
                aria-labelledby="prompt-hint"
                className={`vbg-custom-prompts${source ? " vbg-custom-prompts-tailored" : ""}`}
                key={source?.id ?? "examples"}
                role="group"
              >
                {activePrompts.map((prompt, index) => (
                  <button
                    aria-pressed={prompt.id === selectedPromptId}
                    disabled={busy}
                    key={prompt.id}
                    onBlur={() => setPreviewId(undefined)}
                    onClick={() => handleSelectPrompt(prompt)}
                    onFocus={() => setPreviewId(prompt.id)}
                    onMouseEnter={() => setPreviewId(prompt.id)}
                    onMouseLeave={() => setPreviewId(undefined)}
                    style={{ animationDelay: `${index * 45}ms` }}
                    type="button"
                  >
                    {prompt.label}
                  </button>
                ))}
              </div>
              <p
                aria-hidden="true"
                className="vbg-custom-prompt-preview"
                data-empty={previewPrompt ? undefined : "true"}
                key={previewPrompt?.id ?? "none"}
              >
                {previewPrompt?.decision ?? "Hover a suggestion to preview the full question."}
              </p>
              <label className="vbg-custom-field-label" htmlFor="decision">
                The choice
              </label>
              <textarea
                autoComplete="off"
                disabled={busy}
                id="decision"
                name="decision"
                onChange={(event) => setDecision(event.target.value)}
                onKeyDown={handlePromptKeyDown}
                placeholder={source ? `What is ${source.name} deciding?` : "What are you deciding?"}
                ref={decisionRef}
                required
                rows={4}
                value={decision}
              />
              <div className="vbg-custom-prompt-footer">
                <span>Enter to ask · Shift + Enter for a new line</span>
                <button disabled={busy} type="submit">
                  {busy ? "The desk is responding…" : "Ask the desk"}
                </button>
              </div>
            </form>

            <Connector direction="out" />

            <div aria-label="Desk responses" className="vbg-custom-member-list">
              {members.map((member) => (
                <MemberCard
                  cardRef={(node) => {
                    if (node) memberCardsRef.current.set(member.id, node);
                    else memberCardsRef.current.delete(member.id);
                  }}
                  dissenting={result ? isDissent(result.agreementScores[member.id]) : false}
                  key={member.id}
                  member={member}
                  state={memberState[member.id]}
                />
              ))}
            </div>

            <Connector direction="in" />

            <article
              aria-busy={summaryRunning}
              aria-live="polite"
              className={`vbg-custom-node vbg-custom-summary-node ${
                result ? "vbg-custom-complete" : summaryRunning ? "vbg-custom-running" : ""
              }`}
            >
              <div className="vbg-custom-summary-heading">
                <span className="vbg-custom-node-kicker">The call</span>
                <span aria-hidden="true" className="vbg-custom-status-dot" />
              </div>
              {result ? (
                <DecisionBrief onOpenDissent={handleOpenDissent} result={result} />
              ) : summaryRunning ? (
                <>
                  <h2>Judging…</h2>
                  <p>
                    The judge is comparing the 4 recommendations.
                    <span aria-hidden="true" className="vbg-custom-elapsed">
                      {" · "}
                      <ElapsedTime />
                    </span>
                  </p>
                </>
              ) : (
                <>
                  <h2>Pending</h2>
                  <p>The call appears after all 4 recommendations return.</p>
                </>
              )}
              <UsageDetails label="Summary usage" usage={summaryUsage} />
            </article>
          </section>
        </main>
        <footer className="vbg-footer">
          <span aria-label="Vercel" className="vbg-logo" role="img" />
          <span>Built with eve.dev</span>
        </footer>
      </div>
    </div>
  );
}

function HistoryList({
  activeId,
  counts,
  history,
  onNewDecision,
  onOpen,
}: {
  readonly activeId: string | undefined;
  readonly counts: Record<MemberId, number>;
  readonly history: readonly DeskRecord[];
  readonly onNewDecision: () => void;
  readonly onOpen: (record: DeskRecord) => void;
}) {
  const outliers = members
    .map((member) => ({ ...member, count: counts[member.id] }))
    .filter((member) => member.count > 0)
    .sort((left, right) => right.count - left.count);

  return (
    <section aria-labelledby="history-heading" className="vbg-custom-history">
      <div className="vbg-custom-history-heading">
        <h2 id="history-heading">Past decisions</h2>
        <button onClick={onNewDecision} type="button">
          New decision
        </button>
      </div>
      {outliers.length > 0 ? (
        <p>
          Outliers:{" "}
          {outliers
            .map((member) => `${member.model} (${member.count}/${history.length})`)
            .join(", ")}
        </p>
      ) : (
        <p>Saved decisions have agreed so far.</p>
      )}
      <ul>
        {history.map((record) => {
          const disagreed = members.filter((member) =>
            isDissent(record.result.agreementScores[member.id]),
          );

          return (
            <li key={record.id}>
              <button
                aria-current={record.id === activeId ? "true" : undefined}
                onClick={() => onOpen(record)}
                type="button"
              >
                <span>{decisionTitle(record.decision)}</span>
                <span>
                  {record.source ? `${record.source.name} · ` : ""}
                  {disagreed.length === 0
                    ? "Agreed"
                    : `${disagreed.map((member) => member.model).join(", ")} disagreed`}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function DecisionBrief({
  onOpenDissent,
  result,
}: {
  readonly onOpenDissent: (memberId: MemberId) => void;
  readonly result: DecisionResult;
}) {
  const disagreed = members
    .filter((member) => isDissent(result.agreementScores[member.id]))
    .sort(
      (left, right) => result.agreementScores[left.id] - result.agreementScores[right.id],
    );

  return (
    <>
      <div className="vbg-custom-brief">
        <div>
          <h2>Recommendation</h2>
          <p>{result.recommendation}</p>
        </div>
        <div>
          <h2>Main risk</h2>
          <p>{result.risk}</p>
        </div>
        <div>
          <h2>Next 24 hours</h2>
          <p>{result.nextStep}</p>
        </div>
      </div>
      {disagreed.length > 0 ? (
        <div className="vbg-custom-dissent-callout">
          <h3>Disagreed with the call</h3>
          <div>
            {disagreed.map((member) => (
              <button
                key={member.id}
                onClick={() => onOpenDissent(member.id)}
                type="button"
              >
                {member.model}
                <span>{result.agreementScores[member.id]}</span>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <p className="vbg-custom-unanimous">The desk landed on the same call.</p>
      )}
      <AgreementScores scores={result.agreementScores} />
    </>
  );
}

function ElapsedTime() {
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    const startedAt = Date.now();
    const interval = window.setInterval(() => {
      setSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);

    return () => window.clearInterval(interval);
  }, []);

  return (
    <>
      {seconds}s elapsed{seconds >= 30 ? " · taking longer than usual" : ""}
    </>
  );
}

function MemberCard({
  cardRef,
  dissenting,
  member,
  state,
}: {
  readonly cardRef: (node: HTMLElement | null) => void;
  readonly dissenting: boolean;
  readonly member: (typeof members)[number];
  readonly state: MemberState;
}) {
  const placeholder =
    state.status === "error"
      ? "This model did not complete its response."
      : state.status === "waiting"
        ? "Pending…"
        : "";

  return (
    <article
      aria-busy={state.status === "running"}
      className={`vbg-custom-node vbg-custom-member-node vbg-custom-${state.status}${
        dissenting ? " vbg-custom-dissent" : ""
      }`}
      ref={cardRef}
      tabIndex={-1}
    >
      <div className="vbg-custom-member-heading" translate="no">
        <div>
          <span className="vbg-custom-node-kicker">{member.label}</span>
          <h2 translate="no">{member.model}</h2>
        </div>
        {dissenting ? <span className="vbg-custom-dissent-label">Disagreed</span> : null}
        <span aria-hidden="true" className="vbg-custom-status-dot" />
      </div>
      {state.response ? (
        <MarkdownResponse markdown={state.response} streaming={state.status === "running"} />
      ) : (
        <p className="vbg-custom-response-text">{placeholder}</p>
      )}
      <UsageDetails label={`${member.model} usage`} usage={state.usage} />
    </article>
  );
}

function MarkdownResponse({
  markdown,
  streaming = false,
}: {
  readonly markdown: string;
  readonly streaming?: boolean;
}) {
  return (
    <MarkdownClient
      className="vbg-custom-response-text vbg-custom-markdown-response"
      streaming={streaming}
      value={markdown}
    />
  );
}

function AgreementScores({ scores }: { readonly scores: DecisionResult["agreementScores"] }) {
  return (
    <section aria-labelledby="agreement-heading" className="vbg-custom-agreement-scores">
      <h3 id="agreement-heading">Alignment with the call</h3>
      <dl>
        {members.map((member) => {
          const score = scores[member.id];

          return (
            <div key={member.id}>
              <dt translate="no">{member.model}</dt>
              <dd>
                <span
                  aria-label={`${score}% alignment`}
                  aria-valuemax={100}
                  aria-valuemin={0}
                  aria-valuenow={score}
                  className={`vbg-custom-meter${isDissent(score) ? " vbg-custom-meter-dissent" : ""}`}
                  role="meter"
                >
                  <span style={{ width: `${score}%` }} />
                </span>
                <span>{score}%</span>
              </dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}

function UsageDetails({ label, usage }: { readonly label: string; readonly usage: Usage }) {
  if (!hasUsage(usage)) return null;

  return (
    <dl aria-label={label} className="vbg-custom-usage">
      <div>
        <dt>Input</dt>
        <dd>
          {usage.inputTokens === undefined
            ? "-"
            : `${tokenFormatter.format(usage.inputTokens)} tokens`}
        </dd>
      </div>
      <div>
        <dt>Output</dt>
        <dd>
          {usage.outputTokens === undefined
            ? "-"
            : `${tokenFormatter.format(usage.outputTokens)} tokens`}
        </dd>
      </div>
      <div>
        <dt>Cost</dt>
        <dd>{usage.costUsd === undefined ? "-" : costFormatter.format(usage.costUsd)}</dd>
      </div>
    </dl>
  );
}

function StraightConnector() {
  return (
    <svg aria-hidden="true" className="vbg-custom-connector vbg-custom-connector-straight" preserveAspectRatio="none" viewBox="0 0 100 100">
      <path d="M 50 0 L 50 100" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Connector({ direction }: { readonly direction: "in" | "out" }) {
  const paths = [12.5, 37.5, 62.5, 87.5];

  return (
    <svg
      aria-hidden="true"
      className={`vbg-custom-connector vbg-custom-connector-${direction}`}
      preserveAspectRatio="none"
      viewBox="0 0 100 100"
    >
      {paths.map((position) => (
        <path
          d={
            direction === "out"
              ? `M 50 0 C 50 55, ${position} 45, ${position} 100`
              : `M ${position} 0 C ${position} 55, 50 45, 50 100`
          }
          key={position}
          vectorEffect="non-scaling-stroke"
        />
      ))}
      <path
        className="vbg-custom-mobile-connector"
        d="M 50 0 L 50 100"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function promptText(prompt: Prompt): string {
  return `${prompt.decision}\n\n${prompt.context}`;
}

function recordText(record: DeskRecord): string {
  if (record.context.trim().length === 0) return record.decision;
  return `${record.decision}\n\n${record.context}`;
}

function decisionTitle(decision: string): string {
  const line = decision.split("\n").find((part) => part.trim().length > 0);
  return line?.trim() ?? decision;
}

function membersFromRecord(record: DeskRecord): Record<MemberId, MemberState> {
  return {
    claude: { response: record.members.claude, status: "complete", usage: {} },
    grok: { response: record.members.grok, status: "complete", usage: {} },
    kimi: { response: record.members.kimi, status: "complete", usage: {} },
    openai: { response: record.members.openai, status: "complete", usage: {} },
  };
}

function hasUsage(usage: Usage): boolean {
  return (
    usage.inputTokens !== undefined ||
    usage.outputTokens !== undefined ||
    usage.costUsd !== undefined
  );
}

function mergeUsage(current: Usage, next: Usage): Usage {
  return {
    costUsd: sumDefined(current.costUsd, next.costUsd),
    inputTokens: sumDefined(current.inputTokens, next.inputTokens),
    outputTokens: sumDefined(current.outputTokens, next.outputTokens),
  };
}

function sumDefined(current: number | undefined, next: number | undefined): number | undefined {
  if (current === undefined && next === undefined) return undefined;
  return (current ?? 0) + (next ?? 0);
}

function isMemberId(value: string): value is MemberId {
  return memberIds.has(value as MemberId);
}
