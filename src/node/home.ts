// The "home": the always-on moqi on a computer, with its log, plugins and notifications.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openAICompatible } from "../core/model.js";
import { Moqi, type MoqiOptions } from "../core/moqi.js";
import type { Plugin } from "../core/plugin.js";
import type { EventStore, Offer, Surface } from "../core/types.js";
import { calendarPlugin } from "../plugins/calendar.js";
import { weatherPlugin } from "../plugins/weather.js";
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
}

export interface Home {
  /** The current moqi. It is replaced when the config changes, so read it each time. */
  readonly moqi: Moqi;
  readonly config: Config;
  readonly dir: string;
  readonly logPath: string;
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
  return plugins;
}

export function openHome(options: HomeOptions): Home {
  const release = options.lock === false ? () => {} : acquireLock(options.home);
  try {
    const store = fileEventStore(join(options.home, "events.jsonl"));
    const notify = options.notifier ?? desktopNotifier();
    let config = options.config ?? loadConfig(options.home);
    let moqi = build(config, store, options, notify);
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
      serial,
      reconfigure: (next) =>
        serial(async () => {
          await moqi.idle();
          moqi = build(next, store, options, notify);
          config = next;
        }),
      close: release,
    };
  } catch (error) {
    release();
    throw error;
  }
}

function build(config: Config, store: EventStore, options: HomeOptions, notify: Notifier): Moqi {
  return new Moqi({
    store,
    ...(config.model && {
      model: openAICompatible({ ...config.model, ...(options.fetch && { fetch: options.fetch }) }),
    }),
    plugins: [...pluginsFrom(config, options.fetch), ...(options.extraPlugins ?? [])],
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
