import { chatTurn, learn } from "./agent.js";
import { needsConfirmation, promotionDue } from "./autonomy.js";
import { type Briefing, composeBriefing } from "./briefing.js";
import { type RememberInput, rememberEvents } from "./memory.js";
import type { ChatModel } from "./model.js";
import { actionPolicy, type OfferInput, type Plugin, type PluginContext, resultText, type Tool } from "./plugin.js";
import { decide, defaultPolicy, inQuietHours, type Policy } from "./proactive.js";
import { REFLECT, reflect } from "./reflect.js";
import { findRoutines } from "./routines.js";
import { dayKey, describeSchedule, minuteOfDay, nextRun, parseTime } from "./schedule.js";
import { State } from "./state.js";
import { STUDY, studiedOn, study } from "./study.js";
import { dueReminders, reminderOffer } from "./todo.js";
import { builtinTools, type Kernel } from "./tools.js";
import {
  type Clock,
  type EventBody,
  type EventStore,
  type Idea,
  type MoqiEvent,
  memoryEventStore,
  newId,
  type Offer,
  type Surface,
  systemClock,
  type Verdict,
} from "./types.js";
import { runWatch } from "./watch.js";

/** Read tools that make no sense on a schedule: they list moqi's own state. */
const UNWATCHABLE = ["list_memories", "watch_list", "todo_list"];

export interface MoqiOptions {
  readonly store?: EventStore;
  /** Needed for chat and learning. Briefings, watches and routines work without one. */
  readonly model?: ChatModel;
  readonly plugins?: readonly Plugin[];
  readonly clock?: Clock;
  readonly policy?: Partial<Policy>;
  /** Who moqi is to this user. Prepended to the system prompt. */
  readonly persona?: string;
  /** Local "HH:MM" for the daily briefing; null turns it off. Default "08:00". */
  readonly briefingAt?: string | null;
  /** Shows an offer: a system notification for "notify", a quiet entry for "feed". */
  readonly deliver?: (offer: Offer, surface: Surface) => void | Promise<void>;
  /** Asks the user before an action that has not earned trust yet. Without it, such actions are refused. */
  readonly confirm?: (question: string) => Promise<boolean>;
  /** Think about the user on its own between conversations (needs a model). Default true. */
  readonly reflect?: boolean;
  /** Learn on its own while the user is away: lessons from feedback, notes from articles. Default true. */
  readonly study?: boolean;
}

export interface TickReport {
  readonly watchesRun: number;
  readonly offers: readonly Offer[];
}

export class Moqi {
  readonly state: State;
  readonly store: EventStore;
  readonly clock: Clock;
  readonly model: ChatModel | undefined;
  readonly policy: Policy;
  readonly persona: string;
  readonly plugins: readonly Plugin[];
  private readonly tools = new Map<string, Tool>();
  private readonly background = new Set<Promise<unknown>>();
  private thinking: Promise<Idea[]> | undefined;
  private studying: Promise<number> | undefined;
  private readonly options: MoqiOptions;

  constructor(options: MoqiOptions = {}) {
    this.options = options;
    this.store = options.store ?? memoryEventStore();
    this.clock = options.clock ?? systemClock;
    this.model = options.model;
    this.policy = { ...defaultPolicy, ...options.policy };
    this.persona = options.persona ?? "你是 moqi（默契），用户的个人助理。你话少、靠谱，先替用户想到，再开口。";
    this.plugins = options.plugins ?? [];
    this.state = State.from(this.store.all());
    const kernel: Kernel = {
      now: () => this.clock.now(),
      remember: (input) => this.remember(input),
      emit: (body) => void this.emit(body),
      state: this.state,
      toolNames: () => [...this.tools.keys()],
      isReadTool: (name) => this.isWatchable(name),
      readTools: () => [...this.tools.values()].filter((t) => this.isWatchable(t.name)).map((t) => t.name),
    };
    for (const tool of [...builtinTools(kernel), ...this.plugins.flatMap((p) => p.tools ?? [])]) {
      if (this.tools.has(tool.name)) throw new Error(`Two tools are named "${tool.name}"`);
      this.tools.set(tool.name, tool);
    }
  }

  /** Appends an event and folds it into the state. The only way state changes. */
  emit(body: EventBody): MoqiEvent {
    const event = { ...body, id: newId("e", this.clock), at: this.clock.now() } as MoqiEvent;
    this.store.append(event);
    this.state.apply(event);
    return event;
  }

  /** Keeps a background job (like learning) alive until it settles. Errors are swallowed by the job itself. */
  track(job: Promise<unknown>): void {
    const settled = job.catch(() => {}).finally(() => this.background.delete(settled));
    this.background.add(settled);
  }

  /** Resolves when background work started so far has finished. */
  async idle(): Promise<void> {
    while (this.background.size > 0) await Promise.all([...this.background]);
  }

  /** One conversation turn. Learns about the user on the side every few turns. */
  chat(text: string, signal?: AbortSignal): Promise<string> {
    return chatTurn(this, text, signal);
  }

  /** Read tools a watch may call on a schedule. */
  private isWatchable(name: string): boolean {
    const tool = this.tools.get(name);
    return !!tool && tool.effect === "read" && !tool.hidden && !UNWATCHABLE.includes(name);
  }

  visibleTools(): Tool[] {
    return [...this.tools.values()].filter((t) => !t.hidden);
  }

  tool(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /** Read tools a watch may use, e.g. for reflection to suggest one. */
  watchableTools(): Tool[] {
    return [...this.tools.values()].filter((t) => this.isWatchable(t.name));
  }

  /** What is wrong with a call, without running it or asking anyone; undefined when it would work. */
  checkTool(name: string, args: unknown): string | undefined {
    const tool = this.tools.get(name);
    if (!tool) return `没有工具 ${name}`;
    const parsed = tool.input.safeParse(args);
    if (!parsed.success) return parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ");
    return tool.validate?.(parsed.data, { now: () => this.clock.now(), state: this.state });
  }

  get isReflecting(): boolean {
    return this.thinking !== undefined;
  }

  get isStudying(): boolean {
    return this.studying !== undefined;
  }

  /** Learns something now: lessons when there is new feedback to review, otherwise from an article. */
  study(trigger: "timer" | "user" = "user"): Promise<number> {
    if (this.studying) return this.studying;
    const run = study(this, trigger).finally(() => {
      this.studying = undefined;
    });
    this.studying = run;
    this.track(run);
    return run;
  }

  /** The user deletes something moqi learned. */
  forgetLearned(id: string): string {
    if (this.state.lessons.has(id)) {
      this.emit({ type: "lesson.removed", lessonId: id });
      return "这条经验删掉了";
    }
    if (this.state.notes.has(id)) {
      this.emit({ type: "note.removed", noteId: id });
      return "这条笔记删掉了";
    }
    return `没有 ${id}`;
  }

  /** Thinks about the user now and offers what comes of it. One reflection at a time. */
  reflect(trigger: "timer" | "chat" | "user" = "user"): Promise<Idea[]> {
    if (this.thinking) return this.thinking;
    const run = reflect(this, trigger).finally(() => {
      this.thinking = undefined;
    });
    this.thinking = run;
    this.track(run);
    return run;
  }

  /** The user's answer to a question moqi asked. It goes into the conversation and is learned from at once. */
  async answer(offerId: string, text: string): Promise<string> {
    const record = this.state.offers.get(offerId);
    if (!record) return `没有 ${offerId}`;
    if (record.offer.answer !== "text") return "这条不是问题";
    if (record.verdict) return "这条已经处理过了";
    const reply = text.trim().slice(0, 1000);
    if (reply === "") return "回答是空的";
    this.emit({ type: "offer.feedback", offerId, verdict: "accepted" });
    this.emit({ type: "message", role: "assistant", text: record.offer.title });
    this.emit({ type: "message", role: "user", text: reply });
    this.track(learn(this));
    return "记下了，谢谢";
  }

  /** Remembers, confirms, or raises a contradiction for the user to settle. Returns a short note. */
  remember(input: RememberInput): string {
    const events = rememberEvents(this.state, input, this.clock);
    for (const body of events) {
      this.emit(body);
      if (body.type === "fact.contradicted") {
        const c = this.state.conflicts.get(body.factId);
        if (c) {
          void this.offer({
            kind: "memory.conflict",
            title: "需要你定一下",
            body: `你之前说「${c.old}」，现在说「${c.new}」。接受＝以新的为准，忽略＝保留原来的。`,
            value: 0.6,
            urgency: "whenever",
            action: { tool: "resolve_conflict", args: { id: c.factId, keep: "new" } },
          });
        }
      }
    }
    const e = events[0];
    if (!e) return "没什么新的要记";
    if (e.type === "fact.added") return `记住了：${e.fact.content}`;
    if (e.type === "fact.confirmed") return "这条之前就记着，又印证了一次";
    return "这和之前记的不一样，已经请用户定";
  }

  /**
   * Runs a tool through the trust gate. Actions that have not earned trust are confirmed first
   * (`preApproved` when the user already said yes, e.g. by accepting an offer).
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    how: { byUser: boolean; preApproved?: boolean },
  ): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) return `没有工具 ${name}`;
    const parsed = tool.input.safeParse(args);
    if (!parsed.success)
      return `参数不对：${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`;
    const ctx = { now: () => this.clock.now(), state: this.state };
    const problem = tool.validate?.(parsed.data, ctx);
    if (problem) return `参数不对：${problem}`; // back to the model; never ask the user to approve a broken call
    const policy = actionPolicy(tool);
    const asked = !how.preApproved && needsConfirmation(this.state, name, policy);
    if (asked || how.preApproved) {
      const what = tool.describe?.(parsed.data) ?? describeAction(tool, parsed.data as Record<string, unknown>);
      const approved = how.preApproved || (await this.ask(`要我${what}吗？`));
      if (tool.effect === "write") this.emit({ type: "approval", kind: name, approved });
      if (!approved) return "用户没有同意，这一步没做";
    }
    let text: string;
    try {
      text = resultText(await tool.run(parsed.data, ctx));
      this.emit({ type: "tool.called", tool: name, args, byUser: how.byUser, ok: true });
    } catch (error) {
      this.emit({ type: "tool.called", tool: name, args, byUser: how.byUser, ok: false });
      return `出错了：${error instanceof Error ? error.message : String(error)}`;
    }
    if (tool.effect === "write") await this.offerPromotion(tool);
    return text;
  }

  private async ask(question: string): Promise<boolean> {
    return this.options.confirm ? this.options.confirm(question) : false;
  }

  private async offerPromotion(tool: Tool): Promise<void> {
    const next = promotionDue(this.state, tool.name, actionPolicy(tool));
    if (!next) return;
    const pending = this.state
      .openOffers(this.clock.now())
      .some((o) => o.kind === "trust.promote" && o.action?.args.kind === tool.name);
    if (pending) return;
    await this.offer({
      kind: "trust.promote",
      title: "以后这类事直接办？",
      body: `「${tool.name}」你已经连着同意了好几次。接受后，这类事我直接办，办完告诉你；你随时可以收回。`,
      value: 0.55,
      urgency: "whenever",
      action: { tool: "set_level", args: { kind: tool.name, level: next } },
    });
  }

  /** Creates an offer and lets the policy decide whether it interrupts, waits in the feed, or is dropped. */
  async offer(input: OfferInput): Promise<Offer> {
    const now = this.clock.now();
    const ttl = input.urgency === "whenever" ? 7 * 86_400_000 : 86_400_000;
    const offer: Offer = {
      ...input,
      id: newId("o", this.clock),
      createdAt: now,
      expiresAt: input.expiresAt ?? now + ttl,
    };
    this.emit({ type: "offer.created", offer });
    const decision = decide(this.state, this.policy, offer, now);
    if (decision.surface === "drop") {
      this.emit({ type: "offer.dropped", offerId: offer.id, reason: decision.reason });
    } else {
      this.emit({ type: "offer.delivered", offerId: offer.id, surface: decision.surface, reason: decision.reason });
      await this.options.deliver?.(offer, decision.surface);
    }
    return offer;
  }

  /** The user's answer to an offer. Accepting runs its action with the user's consent. */
  async feedback(offerId: string, verdict: Verdict): Promise<string> {
    const record = this.state.offers.get(offerId);
    if (!record) return `没有 ${offerId}`;
    if (record.verdict) return "这条已经处理过了";
    this.emit({ type: "offer.feedback", offerId, verdict });
    const { offer } = record;
    if (offer.kind === "memory.conflict" && offer.action) {
      const keep = verdict === "accepted" ? "new" : "old";
      return this.callTool("resolve_conflict", { ...offer.action.args, keep }, { byUser: true, preApproved: true });
    }
    if (verdict === "accepted" && offer.action)
      return this.callTool(offer.action.tool, offer.action.args, { byUser: true, preApproved: true });
    if (verdict === "muted") return `以后不再提「${offer.kind}」这类事（/unmute ${offer.kind} 恢复）`;
    return "好";
  }

  unmute(kind: string): void {
    this.emit({ type: "kind.unmuted", kind });
  }

  /** What plugins get: the clock, the state, and a way to observe and to offer. */
  pluginContext(): PluginContext {
    return {
      now: () => this.clock.now(),
      state: this.state,
      observe: (source, data) => void this.emit({ type: "observation", source, data }),
      offer: (input) => {
        const placeholder = { ...input, id: "pending", createdAt: this.clock.now() } as Offer;
        void this.offer(input);
        return placeholder;
      },
    };
  }

  async briefing(): Promise<Briefing> {
    const ctx = this.pluginContext();
    const sections = [];
    for (const plugin of this.plugins) {
      try {
        const section = await plugin.briefing?.(ctx);
        if (section) sections.push(section);
      } catch {
        // One broken source must not cost the user the whole briefing.
      }
    }
    return composeBriefing(this.state, this.clock.now(), sections);
  }

  /** The proactive heartbeat. Call it every minute or so; it is cheap when nothing is due. */
  async tick(): Promise<TickReport> {
    const now = this.clock.now();
    const before = this.state.offers.size;
    for (const { offer, verdict } of [...this.state.offers.values()]) {
      if (!verdict && offer.expiresAt !== undefined && offer.expiresAt <= now) {
        this.emit({ type: "offer.feedback", offerId: offer.id, verdict: "ignored" });
      }
    }
    const watchesRun = await this.runDueWatches(now);
    await this.remindTodos(now);
    const ctx = this.pluginContext();
    for (const plugin of this.plugins) {
      try {
        await plugin.tick?.(ctx);
      } catch {
        // A failing source is skipped this round.
      }
    }
    await this.maybeBrief(now);
    await this.offerRoutines(now);
    this.maybeReflect(now);
    this.maybeStudy(now);
    const offers = [...this.state.offers.values()].slice(before).map((r) => r.offer);
    return { watchesRun, offers };
  }

  private async runDueWatches(now: number): Promise<number> {
    const due = [...this.state.watches.values()].filter((w) => w.nextAt <= now).sort((a, b) => a.nextAt - b.nextAt);
    for (const watch of due) {
      const nextAt = nextRun(watch.schedule, now);
      try {
        const outcome = await runWatch(watch, {
          callTool: async (name, args) => {
            const tool = this.tools.get(name);
            if (tool?.effect !== "read") throw new Error(`托管事务只能用只读工具，${name} 不行`);
            return tool.run(tool.input.parse(args), { now: () => this.clock.now(), state: this.state });
          },
          alert: (headline) => {
            void this.offer({ kind: "watch.alert", title: watch.title, body: headline, value: 0.75, urgency: "today" });
          },
        });
        this.emit({
          type: "watch.ran",
          watchId: watch.id,

          value: outcome.value,
          headline: outcome.headline,
          changed: outcome.changed,
          nextAt,
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.emit({
          type: "watch.ran",
          watchId: watch.id,

          value: watch.last?.value ?? "",
          headline: `这次没查成：${reason}`,
          changed: false,
          nextAt,
        });
      }
    }
    return due.length;
  }

  /** Todos whose reminder time has come. The offer goes first: a reminder twice beats none. */
  private async remindTodos(now: number): Promise<void> {
    for (const todo of dueReminders(this.state, now)) {
      await this.offer(reminderOffer(todo, now));
      this.emit({ type: "todo.reminded", todoId: todo.id });
    }
  }

  /** Every couple of hours while the user is awake, and soon after a conversation settles. In the background. */
  private maybeReflect(now: number): void {
    if (!this.model || this.options.reflect === false || this.thinking || this.studying) return;
    if (inQuietHours(this.policy, now)) return;
    const last = this.state.thoughts.at(-1)?.at ?? 0;
    if (now - last < REFLECT.minGapMs) return;
    const settled = this.state.lastUserMessageAt > last && now - this.state.lastUserMessageAt >= REFLECT.afterChatMs;
    if (settled) void this.reflect("chat");
    else if (now - last >= REFLECT.everyMs) void this.reflect("timer");
  }

  /** While the user is away and awake hours last: a few times a day, never alongside a reflection. */
  private maybeStudy(now: number): void {
    if (!this.model || this.options.study === false || this.thinking || this.studying) return;
    if (inQuietHours(this.policy, now)) return;
    if (now - this.state.lastUserMessageAt < STUDY.idleMs) return;
    if (studiedOn(this.state, now) >= STUDY.perDay) return;
    const last = [...this.state.studies].reverse().find((s) => s.trigger === "timer")?.at ?? 0;
    if (now - last < STUDY.minGapMs) return;
    void this.study("timer");
  }

  private async maybeBrief(now: number): Promise<void> {
    const at = this.options.briefingAt === undefined ? "08:00" : this.options.briefingAt;
    if (at === null) return;
    const { hours, minutes } = parseTime(at);
    if (minuteOfDay(now) < hours * 60 + minutes) return;
    const today = dayKey(now);
    const done = [...this.state.offers.values()].some(
      (r) => r.offer.kind === "briefing" && dayKey(r.offer.createdAt) === today,
    );
    if (done) return;
    const b = await this.briefing();
    await this.offer({
      kind: "briefing",
      title: b.title,
      body: b.body,
      value: b.sections > 0 ? 0.8 : 0.3,
      urgency: "today",
    });
  }

  private async offerRoutines(now: number): Promise<void> {
    const offered = new Set(
      [...this.state.offers.values()]
        .filter((r) => r.offer.kind === "routine.automate")
        .map((r) => String(r.offer.action?.args.routineKey)),
    );
    const watched = new Set(
      [...this.state.watches.values()].map((w) =>
        "tool" in w.check ? `${w.check.tool}:${JSON.stringify(w.check.args)}` : "",
      ),
    );
    const automatable = (name: string) => {
      const tool = this.tools.get(name);
      return !!tool && tool.effect === "read" && !tool.hidden && !UNWATCHABLE.includes(name);
    };
    for (const r of findRoutines(this.state, now, automatable)) {
      if (offered.has(r.key) || watched.has(`${r.tool}:${JSON.stringify(r.args)}`)) continue;
      const when = describeSchedule(r.schedule);
      await this.offer({
        kind: "routine.automate",
        title: "以后不用你问了？",
        body: `这 ${r.days} 天你差不多同一时间都会让我查「${r.tool}」。要不要${when}直接告诉你？`,
        value: 0.6,
        urgency: "whenever",
        action: {
          tool: "watch_create",
          args: {
            title: `${when}的${r.tool}`,
            schedule: r.schedule,
            tool: r.tool,
            args: r.args,
            notify: "always",
            routineKey: r.key,
          },
        },
      });
    }
  }
}

function describeAction(tool: Tool, args: Record<string, unknown>): string {
  const detail = Object.entries(args)
    .filter(([, v]) => (typeof v === "string" && v !== "") || typeof v === "number")
    .map(([k, v]) => `${k}=${String(v)}`)
    .join("，");
  return `执行「${tool.name}」${detail ? `（${detail}）` : ""}`;
}
