# Changelog

## [Unreleased]

## [0.5.0] - 2026-11-23

- Todos: a list of what you mean to do, by day, with reminders at a time you set. Those reminders always arrive, in quiet hours and past the daily budget, without using it; a reminder more than half an hour late is treated as an ordinary offer. Unfinished todos roll over and show how many days they were put off; at 21:00 (`todoReviewAt`) moqi lists what is left. Add them in chat ("明天下午三点提醒我交报告"), in the console's new 待办 tab, or from other agents with `moqi_todo`. moqi also learns from them: reflection hears todos you mentioned without asking and offers to keep them, a todo added for three days becomes a daily reminder offer, and study reviews which reminders get done and which get put off.
- Study: while the user is away (half an hour without a message, outside quiet hours, at most three times a day), moqi learns on its own. With enough new reactions to review, it writes lessons about how to help this user and retires ones proven wrong; otherwise it picks a topic from the profile, reads one or two articles its feeds listed, and keeps notes with their source. Lessons and notes go into every chat and reflection, show in the Memory tab with sources, and can be deleted. A "现在学一学" button studies on demand.
- A2A server: the running moqi publishes an agent card at `/.well-known/agent-card.json` and answers `SendMessage` (A2A 1.0) and `message/send` (0.3) over JSON-RPC with its own key (`moqi a2a` shows it). Other agents' messages are marked as theirs in the conversation. Tested with the official A2A JS client.
- MCP client: servers in `mcp.servers` become moqi's tools; read-only ones run freely and can drive watches, the rest are asked first. moqi offers once to use the MCP servers other agents have configured. Settings show each server's state and tools, with add, import and remove.
- A2A client: agents in `a2a.agents` become `ask_<name>` tools, asked first because what moqi sends is shared. Works with 1.0 and 0.3 agents.
- MCP server: `moqi_tell` and `moqi_ask` name the calling agent from its MCP handshake; `moqi_profile` includes the lessons moqi learned.

## [0.4.0] - 2026-11-20

- Finding other agents: moqi looks for Kiro, Cursor, Claude Code, Claude Desktop, VS Code, Windsurf and Gemini CLI, and for unknown agents by their MCP config in the home directory, then offers once in the feed to connect the ones not connected yet. Settings list every agent found with connect and disconnect buttons. Only the `moqi` entry is added or removed; the rest of the file and its permissions are kept, the file is backed up once as `.moqi-backup`, and unreadable files are left alone. Entries use absolute paths so GUI apps find moqi without a shell PATH.
- `moqi mcp`: an MCP server over stdio so other agents (Kiro, Cursor, Claude Code) can read the user's profile, record what they learned about the user, tell the user something through moqi's attention rules (per agent, so one can be muted alone), talk to moqi, and read its feed and briefing. It starts moqi in the background when needed. No new runtime dependency; tested with the official MCP client and with Kiro CLI.
- Fix: in the console, the answer box of a question lost focus and what was typed every few seconds. The feed and memory lists are now rebuilt only when what they show changes, and a draft answer and its cursor survive a rebuild.

## [0.3.0] - 2026-11-20

- Reflection: every two hours while the user is awake, and ten minutes after a conversation settles, moqi asks the model for up to three ideas: something to do (with a ready action), a question to know the user better (at most two a day; answers are learned from at once), or news that matters to them. Ideas are offers like everything else; only timely ones may interrupt, near-duplicates within a week are skipped, and small-model replies are read leniently.
- Console: "moqi 在想" lists every idea and what became of it, with a "现在想一想" button; questions have an answer box; news links open the article. The address is now `http://moqi.localhost:6674` (MOQI on a phone keypad) and the browser remembers the key after the first visit.
- News plugin: RSS and Atom feeds, a `news` tool for chat and watches, headlines for reflection. On by default with 少数派, IT之家 and Solidot, also for existing configs; `"news": { "feeds": [] }` turns it off.
- Model presets in settings include Muse Glimmer (local); `model.effort` sends `reasoning_effort` with background requests.
- Decisions about offers now carry a reason in plain Chinese, also for dropped offers.

## [0.2.0] - 2026-11-20

- Console: `moqi` now starts moqi in the background and opens a page on 127.0.0.1 with chat, feed, memory and settings. Settings apply at once without a restart; model presets with a connection test, city search for the weather, a check for the calendar file. The page needs a per-home key, refuses foreign `Host` headers, loads nothing from outside and never receives a saved API key; a saved key is only ever sent to the endpoint it was saved for.
- `moqi stop`; `moqi brief` asks the running moqi instead of failing on its lock. The terminal chat moved to `moqi chat`.
- Config: times must be `HH:MM`.

## [0.1.0] - 2026-11-20

First version (P0): runs on a computer.

- Core in plain TypeScript (no Node APIs): event-sourced state, user model (3 confirmations to long-term, 30-day fade, contradictions settled by the user), proactive engine (quiet hours, daily interruption budget, per-kind thresholds learned from feedback), trust ladder per action kind, routine detection, daily briefing, watches as taugraph flows, side-channel learning from conversation.
- Plugins: weather (Open-Meteo, no key) and calendar (.ics).
- Node host: append-only JSONL log with a single-process lock, system notifications (macOS, Linux), config file, `moqi` / `moqi daemon` / `moqi brief` / `moqi init`.
- OpenAI-compatible model adapter with tool calling; `noThink` for Qwen3-style local models.
