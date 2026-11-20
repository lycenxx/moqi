# Changelog

## [Unreleased]

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
