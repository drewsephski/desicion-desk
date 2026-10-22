import { defineAgent } from "eve";
import { openrouter } from "./lib/openrouter";

export default defineAgent({
  model: openrouter.chat("anthropic/claude-opus-5.5"),
  modelContextWindowTokens: 1_000_000,
});
