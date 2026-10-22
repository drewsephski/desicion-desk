import { defineAgent } from "eve";
import { openrouter } from "../../lib/openrouter";

export default defineAgent({
  description: "Independently recommend a decision with Moonshot AI Kimi K3.",
  model: openrouter.chat("moonshotai/kimi-k3"),
  modelContextWindowTokens: 1_048_576,
});
