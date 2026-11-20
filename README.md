# moqi

[![CI](https://github.com/wangcao-hub/moqi/actions/workflows/ci.yml/badge.svg)](https://github.com/wangcao-hub/moqi/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/moqi-agent)](https://www.npmjs.com/package/moqi-agent) [![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

**A personal agent you don't have to ask.** moqi (默契, "tacit understanding") learns you from everyday life, speaks up first when it matters, and gets better at both the more you use it.

[中文文档](./README.zh-CN.md) · [Design (Chinese)](./docs/design.md)

Most assistants wait to be asked. moqi works the other way round: ask the same thing three mornings in a row and on the fourth it tells you unasked; if it will rain tomorrow it reminds you the evening before; thirty minutes before a meeting it says so. It also knows when to stay quiet: no interruptions at night, at most three a day, and less of whatever you keep dismissing.

The core is plain TypeScript with no Node-only APIs, so the same code runs on a computer and inside a phone app.

## Three things and one rule

|                   | What it does                                                                                                                                                                                                                                              |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Notice**        | Sources such as calendar, weather and the conversation itself are plugins. You turn each one on, and the data stays on your devices.                                                                                                                      |
| **Understand**    | A user model of facts, preferences, routines, relationships and ongoing things. A fact confirmed three times becomes long-term; one not mentioned for 30 days fades; contradictions go to you.                                                            |
| **Speak up well** | Every urge to speak is an offer. Value, urgency, quiet hours and a daily interruption budget decide whether it becomes a notification, waits in the feed, or is dropped. Your reactions (accept, ignore, mute) move the threshold for that kind of offer. |

**Trust is earned one kind of action at a time.** Anything that changes the world is asked first. After three approvals in a row for the same kind of action, moqi offers to stop asking; one refusal resets it. Forgetting memories is always asked.

## Quick start

Requires Node.js 22 or later. The npm package is `moqi-agent`; the command it installs is `moqi`.

```
npm install -g moqi-agent
moqi init        # writes ~/.moqi/config.json
moqi             # chat, while moqi keeps an eye out in the background
```

Point the config at any OpenAI-compatible model (a local Ollama works; so do DeepSeek, Qwen and others). The template uses Ollama's `qwen3:4b` (`ollama pull qwen3:4b`); if replies get cut off as a conversation grows, give Ollama a larger context window, e.g. `OLLAMA_CONTEXT_LENGTH=16384 ollama serve`. `noThink: true` appends Qwen3's `/no_think` switch to quick background requests. API keys can come from `MOQI_API_KEY` instead of the file.

Commands inside the chat: `/brief`, `/offers`, `/accept <id>`, `/dismiss <id>`, `/mute <id>`, `/memory`, `/watches`, `/trust`. `moqi daemon` runs headless with system notifications (macOS, Linux); `moqi brief` prints today's briefing.

## What it does unasked

| When                                                          | What                                                                                              | From                   |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------- |
| Every morning (`briefingAt`)                                  | A briefing: today's calendar and weather, things kept for you, decisions waiting, today's watches | core                   |
| You ask the same thing at about the same time on several days | Offers to tell you every day without being asked; accepting creates a watch                       | core (routines)        |
| A watch is due                                                | Checks, compares with last time, tells you if it changed (or every time)                          | core (a taugraph flow) |
| Two memories contradict                                       | Asks which one is right                                                                           | core                   |
| Three approvals in a row for one kind of action               | Offers to do that kind of action without asking                                                   | core                   |
| After 8 pm, if tomorrow needs an umbrella                     | Says so                                                                                           | weather plugin         |
| 30 minutes before an event                                    | Says it is coming                                                                                 | calendar plugin        |

## Plugins

A plugin contributes tools, a briefing section and work for each heartbeat. `effect: "read"` tools run freely and can be used by watches; `"write"` tools start at "ask first" and earn trust.

```ts
import { defineTool, Moqi, type Plugin } from "moqi-agent";
import { weatherPlugin } from "moqi-agent/plugins";

const moqi = new Moqi({
  model,
  plugins: [weatherPlugin({ latitude: 22.54, longitude: 113.93, place: "深圳" }), myPlugin],
});
await moqi.chat("明天要带伞吗？");
await moqi.tick(); // the proactive heartbeat; call it every minute or so
```

## Data

All state is replayed from one append-only log, `~/.moqi/events.jsonl`, one event per line. One moqi process per home directory.

## Status

Version 0.1 runs on a computer: core, CLI, weather and calendar plugins, notifications, watches, routines and side-channel learning. The phone app and multi-device sync are next; the core already follows the rules needed to run there, enforced by tests. Calendar repeats (RRULE) are not expanded yet. Small local models (4B) sometimes record one-off requests as facts; check with `/memory`.

## Development

```
pnpm install
pnpm check      # typecheck, lint, tests (pinned to Asia/Shanghai)
```

## License

[MIT](./LICENSE)
