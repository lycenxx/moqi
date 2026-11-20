// The moqi console. No framework and no outside requests: everything goes to the moqi on this machine.

const token = new URLSearchParams(location.hash.slice(1)).get("t") || "";
const $ = (id) => document.getElementById(id);

const PRESETS = {
  ollama: { baseURL: "http://127.0.0.1:11434/v1", model: "qwen3:4b", noThink: true, key: false },
  deepseek: { baseURL: "https://api.deepseek.com/v1", model: "deepseek-chat", noThink: false, key: true },
  qwen: { baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus", noThink: false, key: true },
  custom: { baseURL: "", model: "", noThink: false, key: true },
};

const ICONS = {
  trash: "M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6",
  x: "M18 6 6 18M6 6l12 12",
};

let state = null;
let view = sessionStorage.getItem("moqi.view") || "chat";
let sending = null; // the text being sent, shown until moqi answers
let lastMessages = "";
let settingsLoaded = false;
let weather = null; // { latitude, longitude, place }
let hasKey = false;
let keyFor = ""; // the endpoint the saved key belongs to
let toldAbout = ""; // the question id the user was already told about

/* Small helpers */

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", ICONS[name]);
  svg.append(path);
  return svg;
}

async function api(method, path, body) {
  const headers = { "x-moqi-token": token };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `出错了（HTTP ${res.status}）`);
  return data;
}

let toastTimer = 0;
function toast(text) {
  const el = $("toast");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 2800);
}

function banner(text) {
  $("banner").textContent = text || "";
  $("banner").hidden = !text;
}

function when(at) {
  const d = new Date(at);
  const diff = Date.now() - at;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return `今天 ${hm}`;
  const yesterday = new Date(today.getTime() - 86_400_000);
  if (d.toDateString() === yesterday.toDateString()) return `昨天 ${hm}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

function setResult(el, text, kind) {
  el.textContent = text;
  el.className = `${el.className.replace(/\b(ok|bad)\b/g, "").trim()}${kind ? ` ${kind}` : ""}`;
}

/* Tabs */

const TABS = ["chat", "feed", "memory", "settings"];

function show(next, focus) {
  view = next;
  sessionStorage.setItem("moqi.view", next);
  for (const name of TABS) {
    const tab = $(`tab-${name}`);
    const on = name === next;
    tab.setAttribute("aria-selected", String(on));
    tab.tabIndex = on ? 0 : -1;
    $(`view-${name}`).hidden = !on;
    if (on && focus) tab.focus();
  }
  if (next === "settings" && !settingsLoaded) loadSettings();
  if (next === "chat") {
    scrollToEnd();
    $("input").focus({ preventScroll: true });
  }
  render();
}

for (const name of TABS) {
  const tab = $(`tab-${name}`);
  tab.addEventListener("click", () => show(name));
  tab.addEventListener("keydown", (e) => {
    const i = TABS.indexOf(name);
    if (e.key === "ArrowRight") show(TABS[(i + 1) % TABS.length], true);
    else if (e.key === "ArrowLeft") show(TABS[(i + TABS.length - 1) % TABS.length], true);
    else return;
    e.preventDefault();
  });
}

/* State and rendering */

async function refresh() {
  try {
    state = await api("GET", "/api/state");
    banner("");
    render();
  } catch (error) {
    banner(`连不上 moqi：${error.message}。它可能已经停了，在终端运行 moqi 重新打开。`);
  }
}

function render() {
  if (!state) return;
  const count = state.offers.length;
  $("feed-count").hidden = count === 0;
  $("feed-count").textContent = String(count);
  renderAsk();
  if (view === "chat") renderChat();
  if (view === "feed") renderFeed();
  if (view === "memory") renderMemory();
}

function scrollToEnd() {
  requestAnimationFrame(() => window.scrollTo({ top: document.body.scrollHeight }));
}

function renderChat() {
  const list = $("messages");
  const key = JSON.stringify([state.messages.length, state.messages.at(-1)?.at, sending, state.configured]);
  if (key === lastMessages) return;
  lastMessages = key;
  list.replaceChildren();
  if (!state.configured) {
    list.append(
      h(
        "div",
        { class: "empty" },
        h("strong", { text: "先给 moqi 接一个模型" }),
        "本机 Ollama 或云端模型都可以，一分钟就好。",
        h("br"),
        h("button", { type: "button", class: "btn primary", text: "去设置", onclick: () => show("settings") }),
      ),
    );
  } else if (state.messages.length === 0 && !sending) {
    list.append(
      h(
        "div",
        { class: "empty" },
        h("strong", { text: "跟 moqi 说说你自己" }),
        "住在哪、做什么、在忙什么。它会慢慢记住，在合适的时候先开口。",
      ),
    );
  }
  for (const m of state.messages) {
    list.append(h("div", { class: `msg ${m.role === "user" ? "user" : "moqi"}`, text: m.text }));
  }
  if (sending !== null) {
    const last = state.messages.at(-1);
    if (!(last && last.role === "user" && last.text === sending))
      list.append(h("div", { class: "msg user", text: sending }));
    list.append(h("div", { class: "msg moqi thinking", text: "moqi 在想" }));
  }
  $("input").disabled = !state.configured;
  $("send").disabled = !state.configured || sending !== null;
  scrollToEnd();
}

function renderAsk() {
  const q = state.question;
  $("ask").hidden = !q;
  if (!q) return;
  $("ask-text").textContent = q.text;
  $("ask").dataset.id = q.id;
  if (view !== "chat" && toldAbout !== q.id) {
    toldAbout = q.id;
    toast("moqi 有件事想问你，在「对话」里");
  }
}

async function answer(yes) {
  const id = $("ask").dataset.id;
  $("ask").hidden = true;
  try {
    await api("POST", "/api/confirm", { id, yes });
  } catch (error) {
    toast(error.message);
  }
  refresh();
}
$("ask-yes").addEventListener("click", () => answer(true));
$("ask-no").addEventListener("click", () => answer(false));

function renderFeed() {
  const list = $("offers");
  list.replaceChildren();
  if (state.offers.length === 0) {
    list.append(h("p", { class: "none", text: "现在没有需要你的事。moqi 有话想说时，会先放在这里。" }));
    return;
  }
  for (const o of state.offers) {
    const respond = (verdict) => async (e) => {
      e.currentTarget.disabled = true;
      try {
        const r = await api("POST", "/api/offer", { id: o.id, verdict });
        toast(r.message);
      } catch (error) {
        toast(error.message);
      }
      refresh();
    };
    list.append(
      h(
        "article",
        { class: "card" },
        h(
          "div",
          { class: "card-head" },
          h("h3", { class: "card-title", text: o.title }),
          h("span", { class: "card-time", text: when(o.at) }),
        ),
        o.body ? h("p", { class: "card-body", text: o.body }) : null,
        h(
          "div",
          { class: "actions" },
          h("button", {
            type: "button",
            class: "btn primary",
            text: o.action ? "好" : "有用",
            onclick: respond("accepted"),
          }),
          h("button", {
            type: "button",
            class: "btn",
            text: o.action ? "不用" : "不需要",
            onclick: respond("dismissed"),
          }),
          h("span", { class: "spacer" }),
          h("button", { type: "button", class: "btn ghost", text: "不再提这类", onclick: respond("muted") }),
        ),
      ),
    );
  }
}

function renderMemory() {
  const facts = $("facts");
  facts.replaceChildren();
  if (state.facts.length === 0) facts.append(h("p", { class: "none", text: "还不了解你。多聊几句，它会记下来。" }));
  for (const f of state.facts) {
    facts.append(
      h(
        "div",
        { class: `item${f.faded ? " faded" : ""}` },
        h(
          "div",
          { class: "item-main" },
          h("p", { class: "item-text", text: f.content }),
          h(
            "p",
            { class: "item-meta" },
            f.term === "long" ? h("span", { class: "tag", text: "长期" }) : `印证 ${f.confirmations}/3`,
            f.faded ? (f.term === "long" ? "已淡出" : " · 已淡出") : null,
          ),
        ),
        removeButton("删除这条记忆", "确定删除", () => api("POST", "/api/forget", { id: f.id })),
      ),
    );
  }
  const watches = $("watches");
  watches.replaceChildren();
  if (state.watches.length === 0)
    watches.append(h("p", { class: "none", text: "没有托管的事。对 moqi 说「每天早上告诉我天气」试试。" }));
  for (const w of state.watches) {
    watches.append(
      h(
        "div",
        { class: "item" },
        h(
          "div",
          { class: "item-main" },
          h("p", { class: "item-text", text: w.title }),
          h("p", { class: "item-meta", text: w.last ? `${w.schedule} · 上次：${w.last}` : w.schedule }),
        ),
        removeButton("取消这件事", "确定取消", () => api("POST", "/api/watch/cancel", { id: w.id }), "x"),
      ),
    );
  }
}

/** Two steps, so one stray click never deletes anything. */
function removeButton(label, confirmText, run, iconName = "trash") {
  const wrap = h("div", {});
  const first = h("button", { type: "button", class: "icon-btn", "aria-label": label, title: label }, icon(iconName));
  first.addEventListener("click", () => {
    const sure = h("button", { type: "button", class: "btn danger", text: confirmText });
    sure.addEventListener("click", async () => {
      sure.disabled = true;
      try {
        const r = await run();
        toast(r.message);
      } catch (error) {
        toast(error.message);
      }
      refresh();
    });
    wrap.replaceChildren(sure);
    sure.focus();
    setTimeout(() => {
      if (wrap.contains(sure) && !sure.disabled) wrap.replaceChildren(first);
    }, 4000);
  });
  wrap.append(first);
  return wrap;
}

/* Chat */

const input = $("input");

function autosize() {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
}
input.addEventListener("input", autosize);
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $("composer").requestSubmit();
  }
});

$("composer").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || sending !== null) return;
  sending = text;
  input.value = "";
  autosize();
  render();
  try {
    await api("POST", "/api/chat", { text });
  } catch (error) {
    toast(error.message);
    if (!input.value) input.value = text;
  }
  sending = null;
  await refresh();
});

/* Settings */

function choosePreset(name) {
  for (const r of document.querySelectorAll('input[name="preset"]')) r.checked = r.value === name;
  const p = PRESETS[name];
  if (name !== "custom") {
    $("m-base").value = p.baseURL;
    $("m-model").value = p.model;
  }
  $("m-nothink").checked = p.noThink;
  keyHint(name);
}

function presetOf(baseURL) {
  for (const [name, p] of Object.entries(PRESETS)) if (p.baseURL && p.baseURL === baseURL) return name;
  return "custom";
}

function keyHint(name) {
  const local = name === "ollama";
  const kept = hasKey && $("m-base").value.trim().replace(/\/+$/, "") === keyFor;
  $("m-key").placeholder = kept ? "已保存，留空就不改" : local ? "不用填" : "sk-…";
  $("m-key-hint").textContent = local ? "本机模型不用填" : "只存在这台电脑上，不会显示在页面里";
}

for (const r of document.querySelectorAll('input[name="preset"]'))
  r.addEventListener("change", () => choosePreset(r.value));

$("m-base").addEventListener("input", () =>
  keyHint(document.querySelector('input[name="preset"]:checked')?.value || "custom"),
);

function toggle(id, bodyId) {
  const on = $(id).checked;
  $(bodyId).classList.toggle("off", !on);
  for (const el of $(bodyId).querySelectorAll("input, button")) el.disabled = !on;
}
$("w-on").addEventListener("change", () => toggle("w-on", "w-body"));
$("c-on").addEventListener("change", () => toggle("c-on", "c-body"));
$("b-on").addEventListener("change", () => {
  $("b-at").disabled = !$("b-on").checked;
});

function showWeather() {
  $("w-chosen").textContent = weather
    ? `已选：${weather.place}（${weather.latitude.toFixed(2)}, ${weather.longitude.toFixed(2)}）`
    : "还没选城市";
}

async function loadSettings() {
  try {
    const { config, hasKey: saved, env } = await api("GET", "/api/config");
    settingsLoaded = true;
    hasKey = saved;
    keyFor = config.model ? config.model.baseURL.replace(/\/+$/, "") : "";
    const model = config.model;
    const preset = model ? presetOf(model.baseURL) : "ollama";
    choosePreset(preset);
    if (model) {
      $("m-base").value = model.baseURL;
      $("m-model").value = model.model;
      $("m-nothink").checked = !!model.noThink;
    }
    keyHint(preset);
    const notes = [];
    if (env.model) notes.push("现在实际用的是环境变量 MOQI_BASE_URL 和 MOQI_MODEL 指定的模型，它优先于这里的设置。");
    if (env.apiKey) notes.push("API Key 来自环境变量 MOQI_API_KEY。");
    $("env-note").textContent = notes.join(" ");
    $("env-note").hidden = notes.length === 0;
    $("persona").value = config.persona || "";
    weather = config.weather || null;
    $("w-on").checked = !!config.weather;
    $("w-q").value = config.weather ? config.weather.place : "";
    showWeather();
    toggle("w-on", "w-body");
    $("c-on").checked = !!config.calendar;
    $("c-path").value = config.calendar ? config.calendar.ics : "";
    toggle("c-on", "c-body");
    $("b-on").checked = config.briefingAt !== null;
    $("b-at").value = config.briefingAt || "08:00";
    $("b-at").disabled = config.briefingAt === null;
    $("q-from").value = config.quiet.from;
    $("q-to").value = config.quiet.to;
    $("budget").value = String(config.dailyBudget);
  } catch (error) {
    toast(error.message);
  }
}

$("m-test").addEventListener("click", async (e) => {
  const button = e.currentTarget;
  const out = $("m-test-result");
  button.disabled = true;
  setResult(out, "正在连接…");
  try {
    const r = await api("POST", "/api/model/test", { model: modelInput() });
    const secs = (r.ms / 1000).toFixed(1);
    if (r.ok) setResult(out, r.reply ? `连上了（${secs} 秒）：${r.reply}` : `连上了（${secs} 秒）`, "ok");
    else setResult(out, `连不上：${r.error}`, "bad");
  } catch (error) {
    setResult(out, error.message, "bad");
  }
  button.disabled = false;
});

function modelInput() {
  return {
    baseURL: $("m-base").value.trim(),
    model: $("m-model").value.trim(),
    apiKey: $("m-key").value.trim() || undefined,
    noThink: $("m-nothink").checked || undefined,
  };
}

async function searchCity() {
  const q = $("w-q").value.trim();
  const box = $("w-results");
  if (!q) return;
  box.replaceChildren(h("p", { class: "hint", text: "正在查…" }));
  try {
    const { results } = await api("GET", `/api/geocode?q=${encodeURIComponent(q)}`);
    box.replaceChildren();
    if (results.length === 0)
      box.append(h("p", { class: "hint", text: "没找到，换个写法试试，比如「深圳」或「Shenzhen」" }));
    for (const r of results) {
      const radio = h("input", { type: "radio", name: "city" });
      radio.addEventListener("change", () => {
        weather = { latitude: r.latitude, longitude: r.longitude, place: r.name };
        showWeather();
      });
      box.append(h("label", {}, radio, h("span", {}, r.name, h("small", { text: r.region }))));
    }
  } catch (error) {
    box.replaceChildren(h("p", { class: "hint", text: error.message }));
  }
}
$("w-search").addEventListener("click", searchCity);
$("w-q").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.isComposing) {
    e.preventDefault();
    searchCity();
  }
});

$("c-check").addEventListener("click", async () => {
  const out = $("c-result");
  const path = $("c-path").value.trim();
  if (!path) return setResult(out, "先填文件路径", "bad");
  try {
    const r = await api("POST", "/api/calendar/check", { path });
    if (r.exists) setResult(out, `找到 ${r.events} 个日程`, "ok");
    else setResult(out, "找不到这个文件", "bad");
  } catch (error) {
    setResult(out, error.message, "bad");
  }
});

$("settings").addEventListener("submit", async (e) => {
  e.preventDefault();
  const out = $("save-result");
  const m = modelInput();
  if ((m.baseURL && !m.model) || (!m.baseURL && m.model)) return setResult(out, "接口地址和模型名要一起填", "bad");
  if ($("w-on").checked && !weather) return setResult(out, "天气开着，但还没选城市", "bad");
  if ($("c-on").checked && !$("c-path").value.trim()) return setResult(out, "日历开着，但还没填文件路径", "bad");
  const config = {
    model: m.baseURL ? m : null,
    persona: $("persona").value.trim() || undefined,
    briefingAt: $("b-on").checked ? $("b-at").value : null,
    quiet: { from: $("q-from").value, to: $("q-to").value },
    dailyBudget: Number($("budget").value),
    weather: $("w-on").checked ? weather : undefined,
    calendar: $("c-on").checked ? { ics: $("c-path").value.trim() } : undefined,
  };
  $("save").disabled = true;
  setResult(out, "正在保存…");
  try {
    await api("POST", "/api/config", { config });
    $("m-key").value = "";
    settingsLoaded = false;
    await loadSettings();
    setResult(out, "已保存，已经生效", "ok");
    await refresh();
  } catch (error) {
    setResult(out, error.message, "bad");
  }
  $("save").disabled = false;
});

/* Start */

async function loop() {
  await refresh();
  const fast = sending !== null || !!state?.question;
  setTimeout(loop, document.hidden ? 10_000 : fast ? 800 : 3000);
}

if (!token) {
  banner("这个链接少了钥匙。请在终端运行 moqi，用它打开的链接进入。");
} else {
  refresh().then(() => {
    if (state && !state.configured && view === "chat") view = "settings";
    show(view);
    loop();
  });
}
