// The "home": the always-on moqi on a computer, with its log, plugins and notifications.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openAICompatible } from "../core/model.js";
import { Moqi, type MoqiOptions } from "../core/moqi.js";
import type { Plugin } from "../core/plugin.js";
import type { EventStore, Offer, Surface } from "../core/types.js";
import { calendarPlugin } from "../plugins/calendar.js";
import { newsPlugin } from "../plugins/news.js";
import { weatherPlugin } from "../plugins/weather.js";
import { type AgentsPluginOptions, agentsPlugin } from "./agents.js";
import { type Config, expandHome, loadConfig } from "./config.js";
import { acquireLock, fileEventStore } from "./file-store.js";
import { desktopNotifier, type Notifier } from "./notify.js";

export interface HomeOptions {
  readonly home: string;
  readonly config?: Config;
  readonly notifier?: Notifier;
  /** Also told about every delivery, e.g. to print it in the terminal. */
  readonly onDeliver?: (offer: Offer, surface: Surface) => void;
  readonly confirm?: MoqiOptions["confirm"];
  readonly extraPlugins?: readonly Plugin[];
  readonly lock?: boolean;
  /** Used for the model and the weather plugin. Tests pass a fake. */
  readonly fetch?: typeof fetch;
  /** Looking for other agents to connect over MCP. Default: the user's home, launching this moqi; false turns it off. */
  readonly agents?: AgentsPluginOptions | false;
}

/** How other agents launch this very moqi: absolute paths, and the same home when it is not the default one. */
export function defaultAgentsOptions(env: NodeJS.ProcessEnv = process.env): AgentsPluginOptions {
  return {
    home: homedir(),
    command: {
      command: process.execPath,
      args: [fileURLToPath(new URL("./cli.js", import.meta.url)), "mcp"],
      ...(env.MOQI_HOME && { env: { MOQI_HOME: env.MOQI_HOME } }),
    },
  };
}

export interface Home {
  /** The current moqi. It is replaced when the config changes, so read it each time. */
  readonly moqi: Moqi;
  readonly config: Config;
  readonly dir: string;
  readonly logPath: string;
  /** Where moqi looks for other agents, and how they launch it; undefined when that is off. */
  readonly agents: AgentsPluginOptions | undefined;
  /** Runs jobs that use moqi one after another, so a config change never lands in the middle of one. */
  serial<T>(job: () => Promise<T>): Promise<T>;
  /** Rebuilds moqi from a new config on the same log, after the jobs before it and background learning settle. */
  reconfigure(config: Config): Promise<void>;
  close(): void;
}

export function pluginsFrom(config: Config, fetchImpl?: typeof fetch): Plugin[] {
  const plugins: Plugin[] = [];
  if (config.weather) plugins.push(weatherPlugin({ ...config.weather, ...(fetchImpl && { fetch: fetchImpl }) }));
  if (config.calendar) {
    const path = expandHome(config.calendar.ics);
    plugins.push(calendarPlugin({ load: () => readFileSync(path, "utf8") }));
  }
  if (config.news && config.news.feeds.length > 0)
    plugins.push(newsPlugin({ feeds: config.news.feeds, ...(fetchImpl && { fetch: fetchImpl }) }));
  return plugins;
}

export function openHome(options: HomeOptions): Home {
  const release = options.lock === false ? () => {} : acquireLock(options.home);
  try {
    const store = fileEventStore(join(options.home, "events.jsonl"));
    const notify = options.notifier ?? desktopNotifier();
    const agents = options.agents === false ? undefined : (options.agents ?? defaultAgentsOptions());
    let config = options.config ?? loadConfig(options.home);
    let moqi = build(config, store, options, notify, agents);
    let chain: Promise<unknown> = Promise.resolve();
    const serial = <T>(job: () => Promise<T>): Promise<T> => {
      const run = chain.then(job, job);
      chain = run.catch(() => {});
      return run;
    };
    return {
      get moqi() {
        return moqi;
      },
      get config() {
        return config;
      },
      dir: options.home,
      logPath: store.path,
      agents,
      serial,
      reconfigure: (next) =>
        serial(async () => {
          await moqi.idle();
          moqi = build(next, store, options, notify, agents);
          config = next;
        }),
      close: release,
    };
  } catch (error) {
    release();
    throw error;
  }
}

function build(
  config: Config,
  store: EventStore,
  options: HomeOptions,
  notify: Notifier,
  agents: AgentsPluginOptions | undefined,
): Moqi {
  return new Moqi({
    store,
    ...(config.model && {
      model: openAICompatible({ ...config.model, ...(options.fetch && { fetch: options.fetch }) }),
    }),
    plugins: [
      ...pluginsFrom(config, options.fetch),
      ...(agents ? [agentsPlugin(agents)] : []),
      ...(options.extraPlugins ?? []),
    ],
    ...(config.persona && { persona: config.persona }),
    briefingAt: config.briefingAt,
    policy: { quietFrom: config.quiet.from, quietTo: config.quiet.to, dailyBudget: config.dailyBudget },
    ...(options.confirm && { confirm: options.confirm }),
    deliver: async (offer, surface) => {
      options.onDeliver?.(offer, surface);
      if (surface === "notify") await notify(offer.title, offer.body.split("\n").slice(0, 3).join("\n"));
    },
  });
}
