import { analyzeSource } from "../../_source/analyze";
import { SourceError } from "../../_source/collect";
import { analyzeRequestSchema, type AnalyzeEvent } from "../../_source/schema";

export const runtime = "nodejs";
export const maxDuration = 300;

/** Streams analysis progress as newline-delimited JSON, ending with a `result` or `error` event. */
export async function POST(request: Request): Promise<Response> {
  const parsed = analyzeRequestSchema.safeParse(await request.json().catch(() => undefined));
  if (!parsed.success) {
    return Response.json({ error: "Send a url and a depth of surface or deep." }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const { url, depth } = parsed.data;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: AnalyzeEvent) => {
        if (request.signal.aborted) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          // The client disconnected.
        }
      };

      try {
        const analysis = await analyzeSource(url, depth, send, request.signal);
        send({ type: "result", analysis });
      } catch (error) {
        if (!request.signal.aborted) {
          console.error("Source analysis failed", error);
          send({
            type: "error",
            message: error instanceof SourceError ? error.message : "Something went wrong while analyzing that source.",
          });
        }
      } finally {
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "cache-control": "no-store",
      "content-type": "application/x-ndjson; charset=utf-8",
      "x-accel-buffering": "no",
    },
  });
}
