// The moqi console. No framework and no outside requests: everything goes to the moqi on this machine.

// The key comes once in the link moqi opens; this browser remembers it, so later the short address is enough.
const fromLink = new URLSearchParams(location.hash.slice(1)).get("t");
if (fromLink) {
  localStorage.setItem("moqi.key", fromLink);
  history.replaceState(null, "", location.pathname);
}
const token = fromLink || localStorage.getItem("moqi.key") || "";
const $ = (id) => document.getElementById(id);

const OLLAMA = "http://127.0.0.1:11434/v1";
const PRESETS = {
  ollama: {
    baseURL: OLLAMA,
    model: "qwen3:4b",
    noThink: true,
    local: true,
    hint: "先在终端运行 ollama pull qwen3:4b（约 2.5 GB）",
  },
  glimmer: {
    baseURL: OLLAMA,
    model: "muse-glimmer",
    noThink: false,
    effort: "low",
    local: true,
    hint: "Meta 的本地 Muse 模型，想得比小模型好得多。约 18 GB，建议 24 GB 以上内存；先在终端运行 ollama pull muse-glimmer",
  },
  deepseek: { baseURL: "https://api.deepseek.com/v1", model: "deepseek-chat", noThink: false },
  qwen: { baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus", noThink: false },
  custom: { baseURL: "", model: "", noThink: false },
};
const IDEA_LABEL = { serve: "帮你做", ask: "了解你", world: "看世界" };

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
let effort; // reasoning strength for background work, set by the preset or the saved config
let newsPresets = [];
// Lists are rebuilt only when what they show changed: polling must never replace a box the user is typing in.
let offersKey = "";
let thoughtsKey = "";
let memoryKey = "";
const drafts = new Map(); // offer id -> what the user has typed so far

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
  if (res.status === 401) localStorage.removeItem("moqi.key");
  if (!res.ok) throw Object.assign(new Error(data.error || `出错了（HTTP ${res.status}）`), { status: res.status });
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
    banner(
      error.status === 401
        ? "钥匙不对。请在终端运行 moqi，用它打开的链接进来一次。"
        : `连不上 moqi：${error.message}。它可能已经停了，在终端运行 moqi 重新打开。`,
    );
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
  const key = JSON.stringify(state.offers);
  if (key !== offersKey) {
    offersKey = key;
    // Keep the answer the user is typing, and the cursor in it, across a rebuild.
    const active = document.activeElement;
    const typing = active?.dataset?.offer;
    const selection = typing ? [active.selectionStart, active.selectionEnd] : null;
    list.replaceChildren();
    if (state.offers.length === 0) {
      list.append(h("p", { class: "none", text: "现在没有需要你的事。moqi 有话想说时，会先放在这里。" }));
    }
    for (const o of state.offers) list.append(offerCard(o));
    for (const id of drafts.keys()) if (!state.offers.some((o) => o.id === id)) drafts.delete(id);
    const box = typing && list.querySelector(`textarea[data-offer="${CSS.escape(typing)}"]`);
    if (box) {
      box.focus({ preventScroll: true });
      box.setSelectionRange(selection[0], selection[1]);
    }
  }
  refreshTimes(list);
  renderThoughts();
}

function timeOf(at) {
  return h("span", { "data-at": String(at), text: when(at) });
}

/** Relative times ("3 分钟前") move on without rebuilding anything. */
function refreshTimes(root) {
  for (const el of root.querySelectorAll("[data-at]")) el.textContent = when(Number(el.dataset.at));
}

function offerCard(o) {
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
  const links = o.links.filter((l) => /^https?:\/\//i.test(l.url));
  const head = h(
    "div",
    { class: "card-head" },
    h("h3", { class: "card-title", text: o.title }),
    h("span", { class: "card-time", "data-at": String(o.at), text: when(o.at) }),
  );
  const body = o.body ? h("p", { class: "card-body", text: o.body }) : null;
  const linkList = links.length
    ? h(
        "ul",
        { class: "links" },
        links.map((l) =>
          h("li", {}, h("a", { href: l.url, target: "_blank", rel: "noopener noreferrer", text: l.title })),
        ),
      )
    : null;
  if (o.answer) {
    const box = h("textarea", {
      class: "answer",
      rows: "2",
      placeholder: "随便说说，几个字也行",
      "aria-label": "回答这个问题",
      "data-offer": o.id,
    });
    box.value = drafts.get(o.id) ?? "";
    box.addEventListener("input", () => drafts.set(o.id, box.value));
    const send = async (e) => {
      const text = box.value.trim();
      if (!text) return box.focus();
      e.currentTarget.disabled = true;
      try {
        const r = await api("POST", "/api/answer", { id: o.id, text });
        drafts.delete(o.id);
        toast(r.message);
      } catch (error) {
        toast(error.message);
      }
      refresh();
    };
    return h(
      "article",
      { class: "card question" },
      head,
      body,
      box,
      h(
        "div",
        { class: "actions" },
        h("button", { type: "button", class: "btn primary", text: "回答", onclick: send }),
        h("button", { type: "button", class: "btn", text: "不想说", onclick: respond("dismissed") }),
        h("span", { class: "spacer" }),
        h("button", { type: "button", class: "btn ghost", text: "别再问这类", onclick: respond("muted") }),
      ),
    );
  }
  return h(
    "article",
    { class: "card" },
    head,
    body,
    linkList,
    h(
      "div",
      { class: "actions" },
      h("button", {
        type: "button",
        class: "btn primary",
        text: o.action ? "好" : "有用",
        onclick: respond("accepted"),
      }),
      h("button", { type: "button", class: "btn", text: o.action ? "不用" : "不需要", onclick: respond("dismissed") }),
      h("span", { class: "spacer" }),
      h("button", { type: "button", class: "btn ghost", text: "不再提这类", onclick: respond("muted") }),
    ),
  );
}

function renderThoughts() {
  const status = $("think-status");
  const last = state.thoughts[0];
  $("think").disabled = state.thinking || !state.configured;
  $("think").textContent = state.thinking ? "正在想…" : "现在想一想";
  if (!state.configured) status.textContent = "接上模型后，moqi 每两小时、以及每次聊完都会自己想一想。";
  else if (state.thinking) status.textContent = "moqi 正在想你可能需要什么。";
  else if (last) status.textContent = `上次是${when(last.at)}。每两小时、以及每次聊完，它都会自己想一想。`;
  else status.textContent = "还没想过。每两小时、以及每次聊完，它都会自己想一想。";
  const list = $("thoughts");
  const key = JSON.stringify(state.thoughts);
  if (key === thoughtsKey) return refreshTimes(list);
  thoughtsKey = key;
  list.replaceChildren();
  for (const t of state.thoughts) {
    if (t.error) {
      list.append(
        h(
          "div",
          { class: "thought" },
          h("p", { class: "item-text", text: "这次没想成" }),
          h("p", { class: "item-meta" }, timeOf(t.at), ` · ${t.error}`),
        ),
      );
      continue;
    }
    if (t.ideas.length === 0) {
      list.append(
        h(
          "div",
          { class: "thought" },
          h("p", { class: "item-text", text: "想了想，这次没什么要说的" }),
          h("p", { class: "item-meta" }, timeOf(t.at)),
        ),
      );
    }
    for (const idea of t.ideas) {
      list.append(
        h(
          "div",
          { class: "thought" },
          h(
            "p",
            { class: "item-text" },
            h("span", { class: "tag", text: IDEA_LABEL[idea.type] || idea.type }),
            idea.title,
          ),
          h("p", { class: "item-meta" }, timeOf(t.at), ` · ${idea.outcome}`),
        ),
      );
    }
  }
}

$("think").addEventListener("click", async () => {
  $("think").disabled = true;
  $("think").textContent = "正在想…";
  try {
    const r = await api("POST", "/api/reflect", {});
    toast(r.ideas ? `想到了 ${r.ideas} 件事` : "想了想，这次没什么要说的");
  } catch (error) {
    toast(error.message);
  }
  refresh();
});

function renderMemory() {
  renderStudyStatus();
  const key = JSON.stringify([state.facts, state.watches, state.lessons, state.notes]);
  if (key === memoryKey) return; // keeps a half-done two-step delete as it is
  memoryKey = key;
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
  const learned = $("learned");
  learned.replaceChildren();
  if (state.lessons.length + state.notes.length === 0) {
    learned.append(
      h("p", { class: "none", text: "还没学到什么。你不在的时候，它会复盘自己做得怎么样，也会读和你有关的文章。" }),
    );
  }
  for (const l of state.lessons) {
    learned.append(
      h(
        "div",
        { class: "item" },
        h(
          "div",
          { class: "item-main" },
          h("p", { class: "item-text" }, h("span", { class: "tag", text: "经验" }), l.content),
          h("p", { class: "item-meta" }, "从你的反应里总结 · ", timeOf(l.at)),
        ),
        removeButton("删除这条经验", "确定删除", () => api("POST", "/api/learned/remove", { id: l.id })),
      ),
    );
  }
  for (const n of state.notes) {
    const source =
      n.source && /^https?:\/\//i.test(n.source.url)
        ? h("a", { href: n.source.url, target: "_blank", rel: "noopener noreferrer", text: n.source.title })
        : null;
    learned.append(
      h(
        "div",
        { class: "item" },
        h(
          "div",
          { class: "item-main" },
          h("p", { class: "item-text" }, h("span", { class: "tag", text: "笔记" }), n.content),
          h("p", { class: "item-meta" }, `${n.topic} · `, source ?? "", source ? " · " : "", timeOf(n.at)),
        ),
        removeButton("删除这条笔记", "确定删除", () => api("POST", "/api/learned/remove", { id: n.id })),
      ),
    );
  }
  refreshTimes(learned);
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

function renderStudyStatus() {
  const s = state.lastStudy;
  $("study").disabled = state.studying || !state.configured;
  $("study").textContent = state.studying ? "正在学…" : "现在学一学";
  let text = "你不在的时候，它一天会学几次：复盘自己做得怎么样，或者读和你有关的文章。";
  if (!state.configured) text = "接上模型后，你不在的时候它会自己学。";
  else if (state.studying) text = "moqi 正在学。";
  else if (s) {
    const what = s.mode === "lessons" ? "复盘了自己做得怎么样" : `学了「${s.topic || "新闻"}」`;
    const result = s.error ? `没学成：${s.error}` : s.skipped ? s.skipped : `记下 ${s.learned} 条`;
    text = `上次${when(s.at)}${s.mode === "world" && !s.topic ? "想学点东西" : what}，${result}。`;
  }
  $("study-status").textContent = text;
}

$("study").addEventListener("click", async () => {
  $("study").disabled = true;
  $("study").textContent = "正在学…";
  try {
    const r = await api("POST", "/api/study", {});
    toast(r.learned ? `学到了 ${r.learned} 条` : "这次没学到新东西");
  } catch (error) {
    toast(error.message);
  }
  refresh();
});

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
  if (name !== "custom") effort = p.effort;
  $("m-preset-hint").textContent = p.hint || "";
  $("m-preset-hint").hidden = !p.hint;
  keyHint(name);
}

function presetOf(model) {
  if (model.baseURL === OLLAMA) return model.model.startsWith("muse-glimmer") ? "glimmer" : "ollama";
  for (const [name, p] of Object.entries(PRESETS)) if (p.baseURL && p.baseURL === model.baseURL) return name;
  return "custom";
}

function keyHint(name) {
  const local = !!PRESETS[name]?.local;
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
$("n-on").addEventListener("change", () => toggle("n-on", "n-body"));
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
    const { config, hasKey: saved, env, newsPresets: feeds } = await api("GET", "/api/config");
    newsPresets = feeds;
    settingsLoaded = true;
    hasKey = saved;
    keyFor = config.model ? config.model.baseURL.replace(/\/+$/, "") : "";
    const model = config.model;
    const preset = model ? presetOf(model) : "ollama";
    choosePreset(preset);
    if (model) {
      $("m-base").value = model.baseURL;
      $("m-model").value = model.model;
      $("m-nothink").checked = !!model.noThink;
      effort = model.effort;
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
    showNews(config.news ? config.news.feeds : null);
    await loadAgents();
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
    effort: effort || undefined,
  };
}

async function loadAgents() {
  const box = $("agents");
  let agents = [];
  try {
    agents = (await api("GET", "/api/agents")).agents;
  } catch (error) {
    box.replaceChildren(h("p", { class: "hint", text: error.message }));
    return;
  }
  box.replaceChildren();
  if (agents.length === 0) {
    box.append(
      h("p", { class: "none", text: "没找到别的 agent。装了 Kiro、Cursor、Claude Code 之类的之后，moqi 会自己发现。" }),
    );
  }
  for (const a of agents) {
    const status = a.problem ? a.problem : a.connected ? "已接入" : "未接入";
    const button = h("button", {
      type: "button",
      class: a.connected ? "btn" : "btn primary",
      text: a.connected ? "断开" : "接入",
      disabled: !!a.problem,
    });
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        await api("POST", a.connected ? "/api/agents/disconnect" : "/api/agents/connect", { id: a.id });
        toast(
          a.connected ? `已从 ${a.name} 断开` : `已接入 ${a.name}。新开一个会话，或在它的 MCP 设置里刷新一下就能用`,
        );
      } catch (error) {
        toast(error.message);
      }
      loadAgents();
    });
    box.append(
      h(
        "div",
        { class: "item" },
        h(
          "div",
          { class: "item-main" },
          h("p", { class: "item-text" }, a.connected ? h("span", { class: "tag", text: "已接入" }) : null, a.name),
          h("p", { class: "item-meta", text: a.connected ? a.path : `${status} · ${a.path}` }),
        ),
        button,
      ),
    );
  }
}

function showNews(feeds) {
  const on = feeds !== null && feeds.length > 0;
  const chosen = new Set((feeds || []).map((f) => f.url));
  const box = $("n-presets");
  box.replaceChildren();
  for (const f of newsPresets) {
    const check = h("input", { type: "checkbox", value: f.url });
    check.checked = on ? chosen.has(f.url) : newsPresets.indexOf(f) < 3;
    box.append(h("label", { class: "check" }, check, f.name));
  }
  const known = new Set(newsPresets.map((f) => f.url));
  $("n-extra").value = (feeds || [])
    .filter((f) => !known.has(f.url))
    .map((f) => f.url)
    .join("\n");
  $("n-on").checked = on;
  toggle("n-on", "n-body");
}

function newsInput() {
  const picked = [...$("n-presets").querySelectorAll("input:checked")].map((c) =>
    newsPresets.find((f) => f.url === c.value),
  );
  const extra = $("n-extra")
    .value.split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((url) => ({ name: new URL(url).hostname.replace(/^www\./, ""), url }));
  return [...picked, ...extra];
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
  let feeds = [];
  try {
    feeds = $("n-on").checked ? newsInput() : [];
  } catch {
    return setResult(out, "有一个 RSS 地址不对，要以 https:// 开头", "bad");
  }
  if ($("n-on").checked && feeds.length === 0) return setResult(out, "新闻开着，但一个来源都没选", "bad");
  const config = {
    model: m.baseURL ? m : null,
    persona: $("persona").value.trim() || undefined,
    briefingAt: $("b-on").checked ? $("b-at").value : null,
    quiet: { from: $("q-from").value, to: $("q-to").value },
    dailyBudget: Number($("budget").value),
    weather: $("w-on").checked ? weather : undefined,
    calendar: $("c-on").checked ? { ics: $("c-path").value.trim() } : undefined,
    news: { feeds }, // an empty list turns news off; leaving it out would mean the default feeds
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
  const fast = sending !== null || !!state?.question || !!state?.thinking || !!state?.studying;
  setTimeout(loop, document.hidden ? 10_000 : fast ? 800 : 3000);
}

if (!token) {
  banner("这个浏览器还没有 moqi 的钥匙。请在终端运行 moqi，用它打开的链接进来一次，之后直接输入地址就行。");
} else {
  refresh().then(() => {
    if (state && !state.configured && view === "chat") view = "settings";
    show(view);
    loop();
  });
}
