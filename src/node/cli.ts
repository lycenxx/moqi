#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { activeFacts } from "../core/memory.js";
import { describeSchedule } from "../core/schedule.js";
import type { Offer, Surface, Verdict } from "../core/types.js";
import { moqiHome, writeTemplate } from "./config.js";
import { type Home, openHome } from "./home.js";

const HELP = `moqi — 不用开口就懂你的个人 agent

  moqi            对话，并在后台替你留意（默认）
  moqi daemon     只在后台留意，用系统通知找你
  moqi brief      打印今天的简报
  moqi init       在 ~/.moqi/config.json 写一份配置模板

对话里的命令：
  /brief  /offers  /accept <id>  /dismiss <id>  /mute <id>  /unmute <kind>
  /memory  /watches  /trust  /help  /quit

数据都在 $MOQI_HOME（默认 ~/.moqi），events.jsonl 是全部记录。`;

const TICK_MS = 30_000;

function show(offer: Offer, surface: Surface): string {
  const head = surface === "notify" ? "[提醒]" : "[动态]";
  const action = offer.action ? `  （/accept ${offer.id}）` : "";
  return `${head} ${offer.title}${offer.body ? `\n  ${offer.body.split("\n").join("\n  ")}` : ""}${action}`;
}

function heartbeat(home: Home, onError: (e: unknown) => void): () => void {
  let busy = false;
  const beat = async () => {
    if (busy) return;
    busy = true;
    try {
      await home.moqi.tick();
    } catch (error) {
      onError(error);
    } finally {
      busy = false;
    }
  };
  void beat();
  const timer = setInterval(beat, TICK_MS);
  return () => clearInterval(timer);
}

async function command(home: Home, line: string): Promise<string | "quit"> {
  const { moqi } = home;
  const [cmd, arg = ""] = line.slice(1).trim().split(/\s+/, 2);
  const verdicts: Record<string, Verdict> = { accept: "accepted", dismiss: "dismissed", mute: "muted" };
  switch (cmd) {
    case "quit":
    case "exit":
      return "quit";
    case "help":
      return HELP;
    case "brief": {
      const b = await moqi.briefing();
      return `${b.title}\n${b.body}`;
    }
    case "offers": {
      const open = moqi.state.openOffers(moqi.clock.now());
      return open.length
        ? open.map((o) => `${o.id}  ${o.title}${o.action ? "（可接受）" : ""}`).join("\n")
        : "没有待处理的事";
    }
    case "accept":
    case "dismiss":
    case "mute":
      return arg ? moqi.feedback(arg, verdicts[cmd] as Verdict) : `用法：/${cmd} <id>`;
    case "unmute":
      if (!arg) return "用法：/unmute <kind>";
      moqi.unmute(arg);
      return `恢复提醒「${arg}」`;
    case "memory": {
      const facts = activeFacts(moqi.state, moqi.clock.now());
      return facts.length
        ? facts
            .map((f) => `${f.id}  ${f.content}  ${f.term === "long" ? "长期" : `印证 ${f.confirmations}/3`}`)
            .join("\n")
        : "还不了解你，多聊几句";
    }
    case "watches": {
      const ws = [...moqi.state.watches.values()];
      return ws.length
        ? ws.map((w) => `${w.id}  ${w.title}  ${describeSchedule(w.schedule)}`).join("\n")
        : "没有托管的事";
    }
    case "trust": {
      const rows = [...moqi.state.trust.entries()].map(([kind, t]) => `${kind}: ${t.level}（连续同意 ${t.streak} 次）`);
      return rows.length ? rows.join("\n") : "还没有需要你批准过的事";
    }
    default:
      return `不认识 /${cmd}，/help 看用法`;
  }
}

/** Lines from stdin, queued so none are lost when input is piped faster than moqi answers. */
function lineReader() {
  const rl = createInterface({ input: process.stdin, terminal: false });
  const queued: string[] = [];
  const waiting: ((line: string | undefined) => void)[] = [];
  let closed = false;
  rl.on("line", (line) => {
    const next = waiting.shift();
    if (next) next(line);
    else queued.push(line);
  });
  rl.on("close", () => {
    closed = true;
    for (const w of waiting.splice(0)) w(undefined);
  });
  return {
    next(prompt: string): Promise<string | undefined> {
      process.stdout.write(prompt);
      if (queued.length > 0) return Promise.resolve(queued.shift());
      if (closed) return Promise.resolve(undefined);
      return new Promise((resolve) => waiting.push(resolve));
    },
    close: () => rl.close(),
  };
}

async function interactive(): Promise<void> {
  const input = lineReader();
  const print = (text: string) => process.stdout.write(`${text}\n`);
  const home = openHome({
    home: moqiHome(),
    onDeliver: (offer, surface) => print(show(offer, surface)),
    confirm: async (question) => /^(y|yes|好|是|可以)/i.test(((await input.next(`${question} [y/N] `)) ?? "").trim()),
  });
  const stop = heartbeat(home, (e) => print(`（后台出错：${e instanceof Error ? e.message : String(e)}）`));
  print(`moqi 在。${home.config.model ? "" : "还没配置模型，只能用命令；moqi init 生成配置。"}/help 看用法`);
  try {
    for (;;) {
      const raw = await input.next("你：");
      if (raw === undefined) break; // input closed
      const line = raw.trim();
      if (line === "") continue;
      if (line.startsWith("/")) {
        const out = await command(home, line);
        if (out === "quit") break;
        print(out);
        continue;
      }
      if (!home.moqi.model) {
        print("还没配置模型。运行 moqi init，编辑 ~/.moqi/config.json，或设置 MOQI_BASE_URL 和 MOQI_MODEL。");
        continue;
      }
      try {
        print(`moqi：${await home.moqi.chat(line)}`);
      } catch (error) {
        print(`（出错了：${error instanceof Error ? error.message : String(error)}）`);
      }
    }
  } finally {
    stop();
    input.close();
    await home.moqi.idle(); // let background learning finish writing to the log
    home.close();
  }
}

async function main(): Promise<void> {
  const [cmd] = process.argv.slice(2);
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
  if (cmd === "--help" || cmd === "-h" || cmd === "help") return void console.log(HELP);
  if (cmd === "--version" || cmd === "-v") return void console.log(pkg.version);
  if (cmd === "init") return void console.log(`写好了：${writeTemplate(moqiHome())}`);
  if (cmd === "brief") {
    const home = openHome({ home: moqiHome() });
    try {
      const b = await home.moqi.briefing();
      console.log(`${b.title}\n${b.body}`);
    } finally {
      home.close();
    }
    return;
  }
  if (cmd === "daemon") {
    const home = openHome({ home: moqiHome(), onDeliver: (o, s) => console.log(show(o, s)) });
    heartbeat(home, (e) => console.error(`moqi: ${e instanceof Error ? e.message : String(e)}`));
    console.log(`moqi 在后台留意着（${home.logPath}）。Ctrl+C 退出。`);
    const quit = () => {
      home.close();
      process.exit(0);
    };
    process.once("SIGINT", quit);
    process.once("SIGTERM", quit);
    return;
  }
  if (cmd !== undefined) {
    console.error(`不认识 ${cmd}\n\n${HELP}`);
    process.exitCode = 2;
    return;
  }
  await interactive();
}

main().catch((error: unknown) => {
  console.error(`moqi: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
