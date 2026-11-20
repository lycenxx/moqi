// The "home": the always-on moqi on a computer, with its log, plugins and notifications.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openAICompatible } from "../core/model.js";
import { Moqi, type MoqiOptions } from "../core/moqi.js";
import type { Plugin } from "../core/plugin.js";
import type { Offer, Surface } from "../core/types.js";
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
}

export interface Home {
  readonly moqi: Moqi;
  readonly config: Config;
  readonly logPath: string;
  close(): void;
}

export function pluginsFrom(config: Config): Plugin[] {
  const plugins: Plugin[] = [];
  if (config.weather) plugins.push(weatherPlugin(config.weather));
  if (config.calendar) {
    const path = expandHome(config.calendar.ics);
    plugins.push(calendarPlugin({ load: () => readFileSync(path, "utf8") }));
  }
  return plugins;
}

export function openHome(options: HomeOptions): Home {
  const config = options.config ?? loadConfig(options.home);
  const release = options.lock === false ? () => {} : acquireLock(options.home);
  const store = fileEventStore(join(options.home, "events.jsonl"));
  const notify = options.notifier ?? desktopNotifier();
  const moqi = new Moqi({
    store,
    ...(config.model && { model: openAICompatible(config.model) }),
    plugins: [...pluginsFrom(config), ...(options.extraPlugins ?? [])],
    ...(config.persona && { persona: config.persona }),
    briefingAt: config.briefingAt,
    policy: { quietFrom: config.quiet.from, quietTo: config.quiet.to, dailyBudget: config.dailyBudget },
    ...(options.confirm && { confirm: options.confirm }),
    deliver: async (offer, surface) => {
      options.onDeliver?.(offer, surface);
      if (surface === "notify") await notify(offer.title, offer.body.split("\n").slice(0, 3).join("\n"));
    },
  });
  return { moqi, config, logPath: store.path, close: release };
}
