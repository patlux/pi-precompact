/**
 * Demo only; not part of the npm package. A scripted local model for recording pi-precompact in a
 * real Pi 1.4.0 terminal. It uses no network and no credentials.
 *
 * Each prompt from scenario.json reads one file with Pi's real `read` tool, or none, and answers. The
 * usage after each response is scripted, so the context reaches the plugin's start and then Pi's
 * own compaction threshold. Background summary requests receive the scenario's summary.
 */
import { readFileSync } from "node:fs";
import {
  type AssistantMessage,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Message,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface Turn {
  prompt: string;
  /** A file to read with Pi's `read` tool before the answer, or null for a direct answer. */
  read: string | null;
  toolTokens: number | null;
  tokens: number;
  answer: string;
}

interface Scenario {
  model: { provider: string; id: string; name: string; contextWindow: number; maxTokens: number };
  turns: Turn[];
  summary: string;
}

const scenario: Scenario = JSON.parse(readFileSync(new URL("./scenario.json", import.meta.url), "utf8"));
const SUMMARY_SYSTEM_PROMPT = "You are a context summarization assistant";

function text(content: Message["content"]): string {
  if (typeof content === "string") return content;
  return content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

/** A response's content key, matching scripted usage to the finalized message. */
function key(message: AssistantMessage): string {
  for (const block of message.content) {
    if (block.type === "toolCall") return `read:${String(block.arguments.path)}`;
  }
  return text(message.content);
}

/** Usage as a caching provider reports it: a small uncached part, the rest read from cache. */
function usage(tokens: number, output: number) {
  const input = Math.round(tokens * 0.04);
  return { input, output, cacheRead: tokens - input - output, cacheWrite: 0, totalTokens: tokens };
}

export default function scriptedModel(pi: ExtensionAPI): void {
  const { model } = scenario;
  const faux = fauxProvider({
    provider: model.provider,
    api: model.provider,
    models: [
      { id: model.id, name: model.name, contextWindow: model.contextWindow, maxTokens: model.maxTokens },
    ],
    tokensPerSecond: 40,
  });
  const measured = new Map<string, ReturnType<typeof usage>>();
  for (const turn of scenario.turns) {
    if (turn.read && turn.toolTokens) measured.set(`read:${turn.read}`, usage(turn.toolTokens, 120));
    measured.set(turn.answer, usage(turn.tokens, 1600));
  }

  const respond = (context: { messages: Message[] }): AssistantMessage => {
    const summary = context.messages.some(
      (message) => message.role === "system" && text(message.content).includes(SUMMARY_SYSTEM_PROMPT),
    );
    if (summary) return fauxAssistantMessage(scenario.summary);
    const prompt = context.messages.findLast((message) => message.role === "user");
    const turn = scenario.turns.find(
      (candidate) => prompt && text(prompt.content).includes(candidate.prompt),
    );
    if (!turn) return fauxAssistantMessage("This demo model only answers the scripted prompts.");
    if (!turn.read || context.messages.at(-1)?.role === "toolResult")
      return fauxAssistantMessage(turn.answer);
    return fauxAssistantMessage(fauxToolCall("read", { path: turn.read }), { stopReason: "toolUse" });
  };
  faux.setResponses(Array.from({ length: 200 }, () => respond));
  pi.registerProvider(faux.provider);

  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant") return;
    const scripted = measured.get(key(event.message));
    if (scripted) return { message: { ...event.message, usage: { ...event.message.usage, ...scripted } } };
  });
}
