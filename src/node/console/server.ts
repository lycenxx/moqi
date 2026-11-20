// The console: a page on 127.0.0.1 for chatting, answering offers, seeing memories and changing settings.
// It is served by the running home, so the page, the terminal and (later) the phone all go through one process.
import { timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { FACT_KINDS, isFaded } from "../../core/memory.js";
import { openAICompatible } from "../../core/model.js";
import { describeSchedule } from "../../core/schedule.js";
import type { FactKind, Urgency, Verdict } from "../../core/types.js";
import { parseIcs } from "../../plugins/calendar.js";
import { NEWS_FEEDS } from "../../plugins/news.js";
import { connectAgent, disconnectAgent, findAgents } from "../agents.js";
import { ConfigSchema, expandHome, loadConfig, readConfigFile, saveConfig } from "../config.js";
import type { Home } from "../home.js";
import { CONSOLE_HOST, consoleUrl } from "./info.js";

/** M-O-Q-I on a phone keypad. */
export const DEFAULT_PORT = 6674;
const MAX_BODY = 64 * 1024;
const VERDICT_WORDS = {
  accepted: "你接受了",
  dismissed: "你拒绝了",
  ignored: "你没理",
  muted: "你关掉了这类",
} as const;
const ANSWER_TIMEOUT_MS = 5 * 60_000;

/** Questions moqi asks before an action it has not earned trust for, answered from the page. */
export interface Asker {
  ask(question: string): Promise<boolean>;
  pending(): { readonly id: string; readonly text: string } | undefined;
  answer(id: string, yes: boolean): boolean;
}

export function confirmQueue(timeoutMs = ANSWER_TIMEOUT_MS): Asker {
  let current:
    | { id: string; text: string; resolve: (yes: boolean) => void; timer: ReturnType<typeof setTimeout> }
    | undefined;
  let n = 0;
  const settle = (yes: boolean) => {
    if (!current) return;
    clearTimeout(current.timer);
    const { resolve } = current;
    current = undefined;
    resolve(yes);
  };
  return {
    ask(text) {
      settle(false); // only one question at a time; an unanswered one counts as "no"
      return new Promise((resolve) => {
        const timer = setTimeout(() => settle(false), timeoutMs);
        current = { id: `q${++n}`, text, resolve, timer };
      });
    },
    pending: () => (current ? { id: current.id, text: current.text } : undefined),
    answer(id, yes) {
      if (current?.id !== id) return false;
      settle(yes);
      return true;
    },
  };
}

export interface ConsoleOptions {
  readonly home: Home;
  readonly asker: Asker;
  readonly token: string;
  /** Tried first; a free port is used if it is taken. 0 picks any free port. */
  readonly port?: number;
  readonly fetch?: typeof fetch;
  readonly env?: NodeJS.ProcessEnv;
}

export interface Console {
  readonly port: number;
  /** Includes the token, after "#" so it never reaches a server log or a Referer header. */
  readonly url: string;
  close(): Promise<void>;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const ASSETS: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/app.css": { file: "app.css", type: "text/css; charset=utf-8" },
};

const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};

export async function startConsole(options: ConsoleOptions): Promise<Console> {
  const { home, asker } = options;
  const env = options.env ?? process.env;
  const doFetch = options.fetch ?? fetch;
  const assets = Object.fromEntries(
    Object.entries(ASSETS).map(([path, a]) => [
      path,
      { body: readFileSync(new URL(`./assets/${a.file}`, import.meta.url)), type: a.type },
    ]),
  );
  const expected = Buffer.from(options.token);
  let chatting = 0;
  let port = 0;

  /** The saved key, only for the endpoint it was saved with: switching providers must never send it elsewhere. */
  const savedKeyFor = (baseURL: string) => {
    const saved = readConfigFile(home.dir).model;
    return saved?.apiKey && saved.baseURL.replace(/\/+$/, "") === baseURL.replace(/\/+$/, "")
      ? saved.apiKey
      : undefined;
  };

  const tokenOk = (value: string | string[] | undefined) => {
    if (typeof value !== "string") return false;
    const given = Buffer.from(value);
    return given.length === expected.length && timingSafeEqual(given, expected);
  };

  const routes: Record<string, (body: Record<string, unknown>, url: URL) => Promise<unknown> | unknown> = {
    "GET /api/state": () => {
      const moqi = home.moqi;
      const now = moqi.clock.now();
      const messages = moqi.store
        .all()
        .flatMap((e) => (e.type === "message" ? [{ role: e.role, text: e.text, at: e.at }] : []))
        .slice(-60);
      const offers = moqi.state.openOffers(now).flatMap((o) => {
        const record = moqi.state.offers.get(o.id);
        if (!record?.surface) return []; // dropped offers never show
        return [
          {
            id: o.id,
            kind: o.kind,
            title: o.title,
            body: o.body,
            at: o.createdAt,
            action: !!o.action,
            answer: o.answer === "text",
            links: o.links ?? [],
            surface: record.surface,
          },
        ];
      });
      const thoughts = moqi.state.thoughts
        .slice(-8)
        .reverse()
        .map((t) => ({
          at: t.at,
          trigger: t.trigger,
          error: t.error ?? null,
          ideas: t.ideas.map((idea) => {
            const record = idea.offerId ? moqi.state.offers.get(idea.offerId) : undefined;
            const verdict = record?.verdict ? VERDICT_WORDS[record.verdict] : "";
            const outcome = idea.skipped ? `没说：${idea.skipped}` : (record?.reason ?? "");
            return {
              type: idea.type,
              title: idea.title,
              value: idea.value,
              outcome: verdict ? `${outcome} · ${verdict}` : outcome,
            };
          }),
        }));
      const facts = [...moqi.state.facts.values()]
        .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
        .map((f) => ({
          id: f.id,
          kind: f.kind,
          content: f.content,
          term: f.term,
          confirmations: f.confirmations,
          faded: isFaded(f, now),
        }));
      const watches = [...moqi.state.watches.values()].map((w) => ({
        id: w.id,
        title: w.title,
        schedule: describeSchedule(w.schedule),
        last: w.last?.headline ?? null,
      }));
      return {
        configured: !!moqi.model,
        busy: chatting > 0,
        question: asker.pending() ?? null,
        thinking: moqi.isReflecting,
        messages,
        offers,
        facts,
        watches,
        thoughts,
      };
    },

    "POST /api/chat": async (body) => {
      const text = str(body.text, "text").trim();
      if (text === "") throw new HttpError(400, "说点什么吧");
      if (text.length > 4000) throw new HttpError(400, "一次说得太长了");
      if (!home.moqi.model) throw new HttpError(409, "还没配置模型，先去设置里接一个");
      chatting++;
      try {
        return { reply: await home.serial(() => home.moqi.chat(text)) };
      } catch (error) {
        throw new HttpError(502, `模型出错了：${message(error)}`);
      } finally {
        chatting--;
      }
    },

    "POST /api/answer": async (body) => {
      const id = str(body.id, "id");
      const text = str(body.text, "text");
      return { message: await home.serial(() => home.moqi.answer(id, text)) };
    },

    // For other agents (through `moqi mcp`): what they learned about the user, and what they want to tell them.
    "POST /api/remember": async (body) => {
      const content = str(body.content, "content").trim();
      if (content === "") throw new HttpError(400, "content 是空的");
      const kind =
        typeof body.kind === "string" && FACT_KINDS.includes(body.kind as FactKind) ? (body.kind as FactKind) : "other";
      return { message: await home.serial(async () => home.moqi.remember({ kind, content })) };
    },

    "POST /api/tell": async (body) => {
      const title = str(body.title, "title").trim().slice(0, 120);
      if (title === "") throw new HttpError(400, "title 是空的");
      const from = (typeof body.from === "string" ? body.from : "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 32);
      const urgency = ["now", "today", "whenever"].includes(String(body.urgency)) ? (body.urgency as Urgency) : "today";
      const value = Math.min(0.85, Math.max(0, typeof body.value === "number" ? body.value : 0.6)); // never breaks quiet hours
      const offer = await home.serial(() =>
        home.moqi.offer({
          kind: `agent.${from || "other"}`,
          title,
          body: typeof body.body === "string" ? body.body.slice(0, 2000) : "",
          value,
          urgency,
        }),
      );
      const record = home.moqi.state.offers.get(offer.id);
      return { id: offer.id, surface: record?.dropped ? "drop" : record?.surface, reason: record?.reason ?? "" };
    },

    "GET /api/agents": () => {
      const a = home.agents;
      if (!a) return { agents: [] };
      return { agents: findAgents(a.home, a.platform).map((x) => ({ ...x, path: tilde(x.path, a.home) })) };
    },

    "POST /api/agents/connect": (body) => {
      const a = home.agents;
      if (!a) throw new HttpError(404, "没有开启找 agent");
      try {
        return { path: tilde(connectAgent(str(body.id, "id"), a.command, a.home, a.platform), a.home) };
      } catch (error) {
        throw new HttpError(409, message(error));
      }
    },

    "POST /api/agents/disconnect": (body) => {
      const a = home.agents;
      if (!a) throw new HttpError(404, "没有开启找 agent");
      try {
        return { path: tilde(disconnectAgent(str(body.id, "id"), a.home, a.platform), a.home) };
      } catch (error) {
        throw new HttpError(409, message(error));
      }
    },

    "POST /api/reflect": async () => {
      if (!home.moqi.model) throw new HttpError(409, "还没配置模型，先去设置里接一个");
      const ideas = await home.moqi.reflect("user");
      return { ideas: ideas.length };
    },

    "POST /api/confirm": (body) => {
      if (!asker.answer(str(body.id, "id"), body.yes === true)) throw new HttpError(409, "这个问题已经过期了");
      return { ok: true };
    },

    "POST /api/offer": async (body) => {
      const verdict = str(body.verdict, "verdict");
      if (!["accepted", "dismissed", "muted"].includes(verdict)) throw new HttpError(400, "verdict 不对");
      const id = str(body.id, "id");
      return { message: await home.serial(() => home.moqi.feedback(id, verdict as Verdict)) };
    },

    "POST /api/forget": async (body) => {
      const id = str(body.id, "id");
      // Pressing "delete" on the page is the user's own decision, so it does not ask again.
      return {
        message: await home.serial(() => home.moqi.callTool("forget", { id }, { byUser: true, preApproved: true })),
      };
    },

    "POST /api/watch/cancel": async (body) => {
      const id = str(body.id, "id");
      return {
        message: await home.serial(() =>
          home.moqi.callTool("watch_cancel", { id }, { byUser: true, preApproved: true }),
        ),
      };
    },

    "GET /api/briefing": async () => {
      const b = await home.moqi.briefing();
      return { title: b.title, body: b.body };
    },

    "GET /api/config": () => {
      const file = readConfigFile(home.dir);
      const { apiKey, ...model } = file.model ?? { baseURL: "", model: "" };
      return {
        config: { ...file, model: file.model ? model : null },
        hasKey: !!apiKey,
        newsPresets: NEWS_FEEDS,
        env: { model: !!(env.MOQI_BASE_URL && env.MOQI_MODEL), apiKey: !!env.MOQI_API_KEY },
      };
    },

    "POST /api/config": async (body) => {
      if (asker.pending()) throw new HttpError(409, "moqi 正在等你回答一个问题，先回答再保存");
      const raw = (body.config ?? {}) as Record<string, unknown>;
      const model = raw.model as Record<string, unknown> | null | undefined;
      const saved = savedKeyFor(typeof model?.baseURL === "string" ? model.baseURL : "");
      if (model && !model.apiKey && saved) model.apiKey = saved; // a blank key field keeps the saved key
      if (model && model.apiKey === "") delete model.apiKey;
      if (raw.model === null) delete raw.model;
      const parsed = ConfigSchema.safeParse(raw);
      if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
        throw new HttpError(
          400,
          `有 ${issues.length} 处要改：${issues.map((i) => `${i.path} ${i.message}`).join("；")}`,
        );
      }
      saveConfig(home.dir, parsed.data);
      await home.reconfigure(loadConfig(home.dir, env));
      return { ok: true };
    },

    "POST /api/model/test": async (body) => {
      const m = (body.model ?? {}) as Record<string, unknown>;
      const baseURL = str(m.baseURL, "baseURL");
      if (!/^https?:\/\//.test(baseURL)) throw new HttpError(400, "接口地址要以 http:// 或 https:// 开头");
      const apiKey = (typeof m.apiKey === "string" && m.apiKey) || env.MOQI_API_KEY || savedKeyFor(baseURL);
      const model = openAICompatible({
        baseURL,
        model: str(m.model, "model"),
        ...(apiKey && { apiKey }),
        ...(m.noThink === true && { noThink: true }),
        fetch: doFetch,
      });
      const started = Date.now();
      try {
        const reply = await model.chat({
          messages: [{ role: "user", content: "用一句话打个招呼。" }],
          maxTokens: 1024,
          reasoning: "off",
          signal: AbortSignal.timeout(60_000),
        });
        return { ok: true, ms: Date.now() - started, reply: reply.content.trim().slice(0, 200) };
      } catch (error) {
        return { ok: false, ms: Date.now() - started, error: message(error) };
      }
    },

    "GET /api/geocode": async (_body, url) => {
      const q = (url.searchParams.get("q") ?? "").trim();
      if (q === "" || q.length > 60) throw new HttpError(400, "城市名不对");
      const api = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=6&language=zh&format=json`;
      let data: { results?: Record<string, unknown>[] };
      try {
        const response = await doFetch(api, { signal: AbortSignal.timeout(15_000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        data = (await response.json()) as typeof data;
      } catch (error) {
        throw new HttpError(502, `查不到城市：${message(error)}`);
      }
      return {
        results: (data.results ?? []).map((r) => ({
          name: String(r.name ?? ""),
          region: [r.admin1, r.country].filter((x) => typeof x === "string" && x !== "").join(" · "),
          latitude: Number(r.latitude),
          longitude: Number(r.longitude),
        })),
      };
    },

    "POST /api/calendar/check": (body) => {
      const path = expandHome(str(body.path, "path").trim());
      if (!existsSync(path) || !statSync(path).isFile()) return { exists: false, events: 0 };
      if (statSync(path).size > 5 * 1024 * 1024) throw new HttpError(400, "文件太大了，不像日历");
      try {
        return { exists: true, events: parseIcs(readFileSync(path, "utf8")).length };
      } catch {
        throw new HttpError(400, "读不懂这个文件，确认是 .ics 日历");
      }
    },
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const host = req.headers.host ?? "";
    // Only the names a browser on this machine would use; blocks DNS rebinding from other sites.
    if (![CONSOLE_HOST, "localhost", "127.0.0.1"].some((name) => host === `${name}:${port}`))
      return send(res, 403, { error: "forbidden" });
    const url = new URL(req.url ?? "/", `http://${host}`);
    const asset = req.method === "GET" ? assets[url.pathname] : undefined;
    if (asset) {
      res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": asset.type });
      return void res.end(asset.body);
    }
    const route = routes[`${req.method} ${url.pathname}`];
    if (!route) return send(res, 404, { error: "没有这个地址" });
    if (!tokenOk(req.headers["x-moqi-token"])) return send(res, 401, { error: "需要从 moqi 打开的链接进入" });
    try {
      const body = req.method === "POST" ? await readJson(req) : {};
      send(res, 200, await route(body, url));
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      send(res, status, { error: message(error) });
    }
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((error) => send(res, 500, { error: message(error) }));
  });
  port = await listen(server, options.port ?? DEFAULT_PORT);
  return {
    port,
    url: consoleUrl(port, options.token),
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

function listen(server: ReturnType<typeof createServer>, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE" && port !== 0) {
        server.listen(0, "127.0.0.1");
        return;
      }
      reject(error);
    };
    server.on("error", onError);
    server.once("listening", () => {
      server.off("error", onError);
      resolve((server.address() as AddressInfo).port);
    });
    server.listen(port, "127.0.0.1");
  });
}

function send(res: ServerResponse, status: number, data: unknown): void {
  if (res.headersSent) return void res.end();
  res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!(req.headers["content-type"] ?? "").startsWith("application/json")) throw new HttpError(415, "只收 JSON");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "内容太长");
    chunks.push(chunk as Buffer);
  }
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (typeof data !== "object" || data === null || Array.isArray(data)) throw new Error("not an object");
    return data as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "JSON 格式不对");
  }
}

function tilde(path: string, home: string): string {
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function str(value: unknown, name: string): string {
  if (typeof value !== "string") throw new HttpError(400, `缺少 ${name}`);
  return value;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
