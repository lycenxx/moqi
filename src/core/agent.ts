import { extractFacts, LEARN } from "./learn.js";
import { activeFacts, promptSection } from "./memory.js";
import type { ChatMessage } from "./model.js";
import type { Moqi } from "./moqi.js";
import { toolSpec } from "./plugin.js";
import type { MoqiEvent } from "./types.js";

export const AGENT = { maxToolRounds: 6, historyMessages: 12 } as const;

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

const GUIDE = `## 做事的方式
- 用户提到自己的情况（住哪、做什么、喜欢什么、身边的人、在忙的事），用 remember 记下：一件事调用一次，写成完整的一句话并写明关系，例如「女儿叫朵朵，5 岁」；和已记的矛盾时填 contradicts。
- 用户想让你反复留意的事（每天的天气、某个价格、到点提醒），用 watch_create 交给你在后台盯；有工具能查的填 tool，纯提醒填 remind。
- 需要用户确认的操作，moqi 会自己去问，你直接调用工具即可。
- 回答简短、直接，用中文；不知道就说不知道，不编造。`;

export function systemPrompt(moqi: Moqi): string {
  const now = new Date(moqi.clock.now());
  const time = `现在是 ${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 周${WEEKDAYS[now.getDay()]} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}。`;
  return [moqi.persona, time, promptSection(moqi.state, moqi.clock.now()), GUIDE].filter(Boolean).join("\n\n");
}

function history(events: readonly MoqiEvent[], limit: number): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const e of events) if (e.type === "message") messages.push({ role: e.role, content: e.text });
  return messages.slice(-limit);
}

/** One user turn: answer with tools, then learn on the side. */
export async function chatTurn(moqi: Moqi, text: string, signal?: AbortSignal): Promise<string> {
  const model = moqi.model;
  if (!model) throw new Error("moqi has no model; set one to chat (briefings and watches work without it)");
  const past = history(moqi.store.all(), AGENT.historyMessages);
  moqi.emit({ type: "message", role: "user", text });

  const tools = moqi.visibleTools().map(toolSpec);
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt(moqi) },
    ...past,
    { role: "user", content: text },
  ];
  let answer = "";
  for (let round = 0; round <= AGENT.maxToolRounds; round++) {
    const reply = await model.chat({
      messages,
      tools: round < AGENT.maxToolRounds ? tools : [],
      temperature: 0.3,
      ...(signal && { signal }),
    });
    if (reply.toolCalls.length === 0) {
      answer = reply.content;
      break;
    }
    messages.push({ role: "assistant", content: reply.content, toolCalls: reply.toolCalls });
    for (const call of reply.toolCalls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.arguments || "{}") as Record<string, unknown>;
      } catch {
        messages.push({ role: "tool", toolCallId: call.id, content: "参数不是合法的 JSON" });
        continue;
      }
      const result = await moqi.callTool(call.name, args, { byUser: true });
      messages.push({ role: "tool", toolCallId: call.id, content: result });
    }
  }
  answer ||= "（我这次没想好怎么回答，换个说法再试试？）";
  moqi.emit({ type: "message", role: "assistant", text: answer });
  // Learning never delays the answer. moqi.idle() waits for it.
  if (moqi.state.userMessages % LEARN.everyUserTurns === 0) moqi.track(learn(moqi, signal));
  return answer;
}

/** Side-channel extraction. Failures only cost this round's learning. */
export async function learn(moqi: Moqi, signal?: AbortSignal): Promise<number> {
  if (!moqi.model) return 0;
  const recent = moqi.store
    .all()
    .flatMap((e) => (e.type === "message" ? [{ role: e.role, text: e.text }] : []))
    .slice(-LEARN.recentMessages);
  try {
    const facts = await extractFacts(moqi.model, recent, activeFacts(moqi.state, moqi.clock.now()), signal);
    for (const fact of facts) moqi.remember(fact);
    return facts.length;
  } catch {
    return 0;
  }
}
