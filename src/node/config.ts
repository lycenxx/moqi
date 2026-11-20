import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const Config = z.object({
  model: z
    .object({
      baseURL: z.string().url(),
      model: z.string().min(1),
      apiKey: z.string().optional(),
      noThink: z.boolean().optional(),
    })
    .optional(),
  persona: z.string().optional(),
  briefingAt: z.string().nullable().default("08:00"),
  quiet: z.object({ from: z.string(), to: z.string() }).default({ from: "22:30", to: "08:00" }),
  dailyBudget: z.number().int().min(0).max(50).default(3),
  weather: z.object({ latitude: z.number(), longitude: z.number(), place: z.string() }).optional(),
  calendar: z.object({ ics: z.string() }).optional(),
});
export type Config = z.infer<typeof Config>;

export const TEMPLATE = {
  model: { baseURL: "http://127.0.0.1:11434/v1", model: "qwen3:4b", noThink: true },
  briefingAt: "08:00",
  quiet: { from: "22:30", to: "08:00" },
  dailyBudget: 3,
  weather: { latitude: 39.9042, longitude: 116.4074, place: "北京" },
  calendar: { ics: "~/calendar.ics" },
};

export function moqiHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.MOQI_HOME ?? join(homedir(), ".moqi");
}

export function expandHome(path: string): string {
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

/** ~/.moqi/config.json, then MOQI_BASE_URL / MOQI_MODEL / MOQI_API_KEY on top. Keys stay out of the event log. */
export function loadConfig(home: string, env: NodeJS.ProcessEnv = process.env): Config {
  const path = join(home, "config.json");
  const raw = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  const config = Config.parse(raw);
  if (env.MOQI_BASE_URL && env.MOQI_MODEL) {
    return {
      ...config,
      model: {
        baseURL: env.MOQI_BASE_URL,
        model: env.MOQI_MODEL,
        ...(env.MOQI_API_KEY && { apiKey: env.MOQI_API_KEY }),
      },
    };
  }
  if (config.model && env.MOQI_API_KEY) return { ...config, model: { ...config.model, apiKey: env.MOQI_API_KEY } };
  return config;
}

export function writeTemplate(home: string): string {
  const path = join(home, "config.json");
  if (existsSync(path)) throw new Error(`${path} already exists`);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(TEMPLATE, null, 2)}\n`, { mode: 0o600 });
  return path;
}
