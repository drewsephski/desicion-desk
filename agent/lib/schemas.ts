import { z } from "zod";

const agreementScoreSchema = z.number().int().min(0).max(100);

export const decisionResultSchema = z.object({
  recommendation: z
    .string()
    .describe("The call, at most 40 words, leading with the decision."),
  risk: z.string().describe("The main risk of that call, at most 30 words."),
  nextStep: z
    .string()
    .describe("One concrete action for the next 24 hours, at most 25 words."),
  agreementScores: z.object({
    claude: agreementScoreSchema,
    grok: agreementScoreSchema,
    kimi: agreementScoreSchema,
    openai: agreementScoreSchema,
  }),
});

export type DecisionResult = z.infer<typeof decisionResultSchema>;
export type MemberId = keyof DecisionResult["agreementScores"];
