import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readConfigFile } from "../src/node/config.js";
import { type Console, confirmQueue, startConsole } from "../src/node/console/server.js";
import { type Home, openHome } from "../src/node/home.js";

type Reply = { content?: string; tool_calls?: { id: string; function: { name: string; arguments: string } }[] };

/** Plays the model, the geocoder and anything else moqi would fetch. */
function fakeNet(model: (body: { messages: { role: string; content: string }[] }) => Reply) {
  const seen: { url: string; auth: string | null; body: unknown }[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const headers = new Headers(init?.headers);
    seen.push({ url, auth: headers.get("authorization"), body });
    if (url.includes("geocoding-api.open-meteo.com")) {
      return Response.json({
        results: [{ name: "深圳", admin1: "广东", country: "中国", latitude: 22.54554, longitude: 114.0683 }],
      });
    }
    if (url.endsWith("/chat/completions")) return Response.json({ choices: [{ message: model(body) }] });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetch: impl, seen };
}

const open: { home: Home; ui: Console }[] = [];

async function start(
  config: Record<string, unknown>,
  model: Parameters<typeof fakeNet>[0] = () => ({ content: "好" }),
) {
  const dir = mkdtempSync(join(tmpdir(), "moqi-console-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify(config));
  const net = fakeNet(model);
  const asker = confirmQueue();
  const home = openHome({ home: dir, notifier: async () => {}, fetch: net.fetch, confirm: (q) => asker.ask(q) });
  const ui = await startConsole({ home, asker, token: "t".repeat(32), port: 0, fetch: net.fetch, env: {} });
  open.push({ home, ui });
  const api = async (method: string, path: string, body?: unknown, token = "t".repeat(32)) => {
    const res = await fetch(`http://127.0.0.1:${ui.port}${path}`, {
      method,
      headers: { "x-moqi-token": token, ...(body !== undefined && { "content-type": "application/json" }) },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    return {
      status: res.status,
      // biome-ignore lint/suspicious/noExplicitAny: tests read whatever shape each endpoint returns
      data: (await res.json()) as Record<string, any>,
    };
  };
  return { dir, home, ui, api, net };
}

afterEach(async () => {
  for (const { home, ui } of open.splice(0)) {
    await ui.close();
    await home.moqi.idle();
    home.close();
  }
});

const MODEL = { baseURL: "http://model.test/v1", model: "m1" };

describe("console", () => {
  it("serves the page under a strict CSP, and the API only with the token", async () => {
    const { ui, api } = await start({});
    const page = await fetch(`http://127.0.0.1:${ui.port}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(page.headers.get("content-security-policy")).toContain("connect-src 'self'");
    expect(await page.text()).toContain('<script src="/app.js"');
    expect((await fetch(`http://127.0.0.1:${ui.port}/app.js`)).headers.get("content-type")).toContain("javascript");
    expect(ui.url).toBe(`http://127.0.0.1:${ui.port}/#t=${"t".repeat(32)}`);

    expect((await api("GET", "/api/state", undefined, "wrong")).status).toBe(401);
    expect((await api("GET", "/api/state", undefined, "")).status).toBe(401);
    const ok = await api("GET", "/api/state");
    expect(ok.status).toBe(200);
    expect(ok.data).toMatchObject({
      configured: false,
      messages: [],
      offers: [],
      facts: [],
      watches: [],
      question: null,
    });
  });

  it("refuses a request whose Host is not this machine, so other sites cannot reach it by DNS rebinding", async () => {
    const { ui } = await start({});
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: ui.port,
          path: "/api/state",
          headers: { host: `evil.example:${ui.port}`, "x-moqi-token": "t".repeat(32) },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  it("rejects bodies that are not JSON, so a plain HTML form cannot post to it", async () => {
    const { ui } = await start({ model: MODEL });
    const res = await fetch(`http://127.0.0.1:${ui.port}/api/chat`, {
      method: "POST",
      headers: { "x-moqi-token": "t".repeat(32), "content-type": "text/plain" },
      body: '{"text":"hi"}',
    });
    expect(res.status).toBe(415);
  });

  it("chats, and asks on the page before an action that has not earned trust", async () => {
    const { api } = await start({ model: MODEL, briefingAt: null }, (body) => {
      const last = body.messages.at(-1);
      if (last?.role === "user" && last.content.includes("提醒我早点睡")) {
        const args = { title: "早点睡", schedule: { every: "day", at: "22:00" }, remind: "早点睡" };
        return {
          content: "",
          tool_calls: [{ id: "c1", function: { name: "watch_create", arguments: JSON.stringify(args) } }],
        };
      }
      return { content: last?.role === "tool" ? "好，每天 22:00 提醒你" : "你好" };
    });

    expect((await api("POST", "/api/chat", { text: "你好" })).data.reply).toBe("你好");

    const turn = api("POST", "/api/chat", { text: "每天晚上 10 点提醒我早点睡" });
    let question: { id: string; text: string } | null = null;
    for (let i = 0; i < 50 && !question; i++) {
      await new Promise((r) => setTimeout(r, 20));
      const s = await api("GET", "/api/state");
      question = s.data.question;
      if (question) expect(s.data.busy).toBe(true);
    }
    expect(question?.text).toContain("22:00");
    expect((await api("POST", "/api/confirm", { id: question?.id, yes: true })).status).toBe(200);
    expect((await turn).data.reply).toBe("好，每天 22:00 提醒你");
    expect((await api("POST", "/api/confirm", { id: question?.id, yes: true })).status).toBe(409); // answered already

    const after = await api("GET", "/api/state");
    expect(after.data.question).toBeNull();
    expect(after.data.watches).toMatchObject([{ title: "早点睡", schedule: "每天 22:00" }]);
    expect(after.data.messages.map((m: { role: string }) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
  });

  it("says so instead of chatting when no model is set", async () => {
    const { api } = await start({});
    const res = await api("POST", "/api/chat", { text: "你好" });
    expect(res.status).toBe(409);
    expect(res.data.error).toContain("还没配置模型");
  });

  it("answers offers, forgets memories and cancels watches for the user, without asking again", async () => {
    const { home, api } = await start({ briefingAt: null });
    const offer = await home.moqi.offer({
      kind: "test.note",
      title: "一件事",
      body: "细节",
      value: 0.9,
      urgency: "today",
    });
    home.moqi.remember({ kind: "basic", content: "住在深圳南山" });
    await home.moqi.callTool(
      "watch_create",
      { title: "早点睡", schedule: { every: "day", at: "22:00" }, remind: "早点睡" },
      { byUser: true, preApproved: true },
    );
    const before = await api("GET", "/api/state");
    expect(before.data.offers).toMatchObject([{ id: offer.id, title: "一件事", action: false }]);
    const fact = before.data.facts[0];
    expect(fact).toMatchObject({ content: "住在深圳南山", term: "short", confirmations: 1, faded: false });
    const watch = before.data.watches[0];

    expect((await api("POST", "/api/offer", { id: offer.id, verdict: "nonsense" })).status).toBe(400);
    expect((await api("POST", "/api/offer", { id: offer.id, verdict: "accepted" })).status).toBe(200);
    expect((await api("POST", "/api/forget", { id: fact.id })).data.message).toContain("已忘掉");
    expect((await api("POST", "/api/watch/cancel", { id: watch.id })).status).toBe(200);

    const after = await api("GET", "/api/state");
    expect(after.data).toMatchObject({ offers: [], facts: [], watches: [], question: null });
    expect(home.moqi.state.kind("test.note").accepted).toBe(1);

    // A kind the user muted is dropped, so it never shows up in the feed.
    const muted = await home.moqi.offer({ kind: "test.note", title: "又一件", body: "", value: 0.9, urgency: "today" });
    expect((await api("POST", "/api/offer", { id: muted.id, verdict: "muted" })).status).toBe(200);
    await home.moqi.offer({ kind: "test.note", title: "不该出现", body: "", value: 0.9, urgency: "today" });
    expect((await api("GET", "/api/state")).data.offers).toEqual([]);
  });

  it("never sends the API key to the page, keeps it when the field is left blank, and applies changes at once", async () => {
    const { dir, home, api, net } = await start({ model: { ...MODEL, apiKey: "sk-secret" }, briefingAt: null });
    const got = await api("GET", "/api/config");
    expect(JSON.stringify(got.data)).not.toContain("sk-secret");
    expect(got.data).toMatchObject({ hasKey: true, config: { model: MODEL, dailyBudget: 3 } });

    const first = home.moqi;
    const config = {
      ...got.data.config,
      model: { ...MODEL, model: "m2" },
      dailyBudget: 5,
      persona: "叫我小王",
    };
    expect((await api("POST", "/api/config", { config })).data).toEqual({ ok: true });
    const file = readConfigFile(dir);
    expect(file).toMatchObject({
      model: { ...MODEL, model: "m2", apiKey: "sk-secret" },
      dailyBudget: 5,
    });
    expect(statSync(join(dir, "config.json")).mode & 0o777).toBe(0o600);

    // The running moqi changed without a restart.
    expect(home.moqi).not.toBe(first);
    expect(home.moqi.policy.dailyBudget).toBe(5);
    expect(home.moqi.persona).toBe("叫我小王");
    await api("POST", "/api/chat", { text: "你好" });
    const call = net.seen.findLast((s) => s.url === "http://model.test/v1/chat/completions");
    expect(call?.auth).toBe("Bearer sk-secret");
    expect(JSON.stringify(call?.body)).toContain("叫我小王");

    const bad = await api("POST", "/api/config", { config: { ...config, quiet: { from: "25:00", to: "08:00" } } });
    expect(bad.status).toBe(400);
    expect(bad.data.error).toContain("quiet.from");
    expect(readConfigFile(dir).quiet.from).toBe("22:30"); // unchanged

    expect((await api("POST", "/api/config", { config: { ...config, model: null } })).status).toBe(200);
    expect(readConfigFile(dir).model).toBeUndefined();
    expect(home.moqi.model).toBeUndefined();
  });

  it("never carries a saved key over to a different endpoint", async () => {
    const { dir, api, net } = await start({ model: { ...MODEL, apiKey: "sk-deepseek" }, briefingAt: null });
    const other = { baseURL: "http://elsewhere.test/v1", model: "m" };
    await api("POST", "/api/model/test", { model: other });
    expect(net.seen.find((x) => x.url.startsWith("http://elsewhere.test"))?.auth).toBeNull();

    const { config } = (await api("GET", "/api/config")).data;
    expect((await api("POST", "/api/config", { config: { ...config, model: other } })).status).toBe(200);
    expect(readConfigFile(dir).model).toEqual(other); // the old key is gone, not moved
  });

  it("tests a model connection, looks up a city and checks a calendar file", async () => {
    const { dir, api, net } = await start({ model: { ...MODEL, apiKey: "sk-saved" } }, () => ({
      content: "<think>嗯</think>你好呀",
    }));
    const test = await api("POST", "/api/model/test", {
      model: { ...MODEL, model: "m", noThink: true },
    });
    expect(test.data).toMatchObject({ ok: true, reply: "你好呀" });
    const sent = net.seen.find((s) => s.url === "http://model.test/v1/chat/completions");
    expect(sent?.auth).toBe("Bearer sk-saved"); // same endpoint: falls back to the saved key
    expect(JSON.stringify(sent?.body)).toContain("/no_think");
    expect((await api("POST", "/api/model/test", { model: { baseURL: "ftp://x", model: "m" } })).status).toBe(400);

    const city = await api("GET", `/api/geocode?q=${encodeURIComponent("深圳")}`);
    expect(city.data.results).toEqual([
      { name: "深圳", region: "广东 · 中国", latitude: 22.54554, longitude: 114.0683 },
    ]);

    const ics = join(dir, "cal.ics");
    writeFileSync(
      ics,
      "BEGIN:VCALENDAR\nBEGIN:VEVENT\nSUMMARY:周会\nDTSTART:20261120T100000\nDTEND:20261120T110000\nEND:VEVENT\nEND:VCALENDAR\n",
    );
    expect((await api("POST", "/api/calendar/check", { path: ics })).data).toEqual({ exists: true, events: 1 });
    expect((await api("POST", "/api/calendar/check", { path: join(dir, "nope.ics") })).data).toEqual({
      exists: false,
      events: 0,
    });
    expect(readFileSync(ics, "utf8")).toContain("周会");
  });
});

describe("confirm queue", () => {
  it("treats an unanswered question as no, and only one question is open at a time", async () => {
    const asker = confirmQueue(30);
    const first = asker.ask("A？");
    const firstId = asker.pending()?.id ?? "";
    const second = asker.ask("B？");
    expect(await first).toBe(false); // replaced by the newer question
    expect(asker.answer(firstId, true)).toBe(false);
    expect(asker.pending()?.text).toBe("B？");
    expect(await second).toBe(false); // timed out
    expect(asker.pending()).toBeUndefined();
  });
});
