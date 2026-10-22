import { defineAgent } from "eve";
import { openrouter } from "../../lib/openrouter";

export default defineAgent({
  description: "Independently recommend a decision with OpenAI GPT-6.1 Sol.",
  model: openrouter.chat("openai/gpt-6.1-sol"),
  modelContextWindowTokens: 1_050_000,
});
