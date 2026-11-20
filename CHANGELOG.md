# Changelog

## [Unreleased]

## [0.1.0] - 2026-11-20

First version (P0): runs on a computer.

- Core in plain TypeScript (no Node APIs): event-sourced state, user model (3 confirmations to long-term, 30-day fade, contradictions settled by the user), proactive engine (quiet hours, daily interruption budget, per-kind thresholds learned from feedback), trust ladder per action kind, routine detection, daily briefing, watches as taugraph flows, side-channel learning from conversation.
- Plugins: weather (Open-Meteo, no key) and calendar (.ics).
- Node host: append-only JSONL log with a single-process lock, system notifications (macOS, Linux), config file, `moqi` / `moqi daemon` / `moqi brief` / `moqi init`.
- OpenAI-compatible model adapter with tool calling; `noThink` for Qwen3-style local models.
