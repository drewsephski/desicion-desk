import { z } from "zod";

export const depthSchema = z.enum(["surface", "deep"]);
export type Depth = z.infer<typeof depthSchema>;

export const sourceKindSchema = z.enum(["website", "repository"]);
export type SourceKind = z.infer<typeof sourceKindSchema>;

export const analyzeRequestSchema = z.object({
  url: z.string().trim().min(1).max(2048),
  depth: depthSchema,
});

export type AnalyzeRequest = z.infer<typeof analyzeRequestSchema>;

export const tailoredPromptSchema = z.object({
  label: z.string().describe("Pill label, 2 to 4 words, title case is not required."),
  decision: z
    .string()
    .describe("A real decision the owner of this source faces, phrased as one question, at most 20 words."),
  context: z
    .string()
    .describe(
      "Two or three sentences of constraints and evidence drawn from the source data: numbers, names, and facts that make the choice concrete.",
    ),
});

export type TailoredPrompt = z.infer<typeof tailoredPromptSchema>;

export const findingSchema = z.object({
  kind: z.enum(["strength", "risk", "opportunity", "question"]),
  title: z.string().describe("At most 8 words."),
  detail: z.string().describe("One sentence grounded in the source data, at most 30 words."),
});

export type Finding = z.infer<typeof findingSchema>;

export const synthesisSchema = z.object({
  name: z.string().describe("The product, company, or project name."),
  tagline: z.string().describe("What it is, at most 14 words."),
  summary: z.string().describe("Plain-language overview, at most 70 words."),
  audience: z.string().describe("Who it serves, at most 14 words."),
  facts: z
    .array(z.object({ label: z.string(), value: z.string() }))
    .describe("Up to 6 short key facts, such as pricing, stack, stage, license, or traction. Values at most 8 words."),
  findings: z.array(findingSchema).describe("4 to 6 findings that would matter to a decision maker."),
  prompts: z.array(tailoredPromptSchema),
  brief: z
    .string()
    .describe(
      "A 150 to 250 word context brief that four independent advisors will read before deciding. Facts only, dense, no marketing language.",
    ),
});

export type Synthesis = z.infer<typeof synthesisSchema>;

export const statSchema = z.object({ label: z.string(), value: z.string() });
export type Stat = z.infer<typeof statSchema>;

export const sourceRefSchema = z.object({
  kind: z.enum(["page", "file", "api"]),
  title: z.string(),
  url: z.string(),
});

export type SourceRef = z.infer<typeof sourceRefSchema>;

export const analysisSchema = synthesisSchema.extend({
  id: z.string(),
  url: z.string(),
  kind: sourceKindSchema,
  depth: depthSchema,
  provider: z.string(),
  stats: z.array(statSchema),
  sources: z.array(sourceRefSchema),
  createdAt: z.number(),
});

export type Analysis = z.infer<typeof analysisSchema>;

export const stageStatusSchema = z.enum(["active", "done", "skipped", "error"]);
export type StageStatus = z.infer<typeof stageStatusSchema>;

export const analyzeEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("stage"),
    id: z.string(),
    label: z.string(),
    status: stageStatusSchema,
    detail: z.string().optional(),
  }),
  z.object({ type: z.literal("source"), source: sourceRefSchema }),
  z.object({ type: z.literal("draft"), labels: z.array(z.string()) }),
  z.object({ type: z.literal("result"), analysis: analysisSchema }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);

export type AnalyzeEvent = z.infer<typeof analyzeEventSchema>;
