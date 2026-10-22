import { defineAgent } from "eve";
import { openrouter } from "../../lib/openrouter";

export default defineAgent({
  description: "Independently recommend a decision with SpaceXAI Grok 4.7.",
  model: openrouter.chat("x-ai/grok-4.7"),
  modelContextWindowTokens: 500_000,
});
