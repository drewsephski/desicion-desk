# Decision desk

An [eve](https://eve.dev) and Next.js app that sends one decision to four models in parallel, streams their recommendations, and asks a judge for the call, the main risk, a 24-hour next step, and per-model agreement scores.

The council uses:

- SpaceXAI Grok 4.7
- Anthropic Claude Opus 5
- OpenAI GPT-5.6 Sol
- Moonshot AI Kimi K3

<img width="1123" alt="LLM council showing four model responses and a synthesized answer" src="./apps/web/public/llm-council.png" />

## Architecture

The application follows one simple flow:

```text
decision → four parallel recommendations → judge call, risk, next step, and agreement scores
```

The root [eve agent](https://eve.dev/docs/) delegates the same prompt to four declared [subagents](https://eve.dev/docs/subagents). Each subagent has a fixed OpenRouter model and runs in its own durable session. The Next.js client follows those child [session streams](https://eve.dev/docs/concepts/sessions-runs-and-streaming) so every response appears independently as it is generated.

After all four members finish, the root agent returns a concise answer and per-model agreement scores using a [structured output schema](https://eve.dev/docs/guides/client/output-schema). [`useEveAgent()`](https://eve.dev/docs/guides/frontend/nextjs) calls the eve service through the shared Vercel deployment.

The main pieces are:

- `agent/instructions.md` — fan-out and judging behavior
- `agent/subagents/` — the four fixed desk members
- `agent/lib/schemas.ts` — recommendation, risk, next step, and score schema
- `apps/web/app/decision-desk.tsx` — submission, child streaming, and rendering

## Run locally

```bash
pnpm install
pnpm dev
```

Run the complete Vercel service graph with:

```bash
pnpm dev:all
```

`pnpm dev:all` starts without a linked Vercel project. Model calls use OpenRouter, so set `OPENROUTER_API_KEY` in `.env.local` before running the council. Open the local URL printed by Next.js.

## Checks

```bash
pnpm typecheck
pnpm build
```
# desicion-desk
