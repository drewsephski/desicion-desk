import { defineAgent } from "eve";
import { openrouter } from "../../lib/openrouter";

export default defineAgent({
  description: "Independently recommend a decision with Anthropic Claude Opus 5.5.",
  model: openrouter.chat("anthropic/claude-opus-5.5"),
  modelContextWindowTokens: 1_000_000,
});
