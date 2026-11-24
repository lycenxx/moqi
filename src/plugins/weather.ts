// Weather from Open-Meteo (free, no API key). Uses only fetch, so it runs on desktop and phone.
import { z } from "zod";
import { activeFacts } from "../core/memory.js";
import { defineTool, type Plugin } from "../core/plugin.js";
import { dayKey, minuteOfDay } from "../core/schedule.js";

/** A place to forecast: its coordinates and the name shown to the user, e.g. "北京". */
export interface WeatherPlace {
  readonly latitude: number;
  readonly longitude: number;
  readonly place: string;
}

export interface WeatherOptions extends Partial<WeatherPlace> {
  /** From this local time on, warn about rain tomorrow (once a day). Default "20:00". */
  readonly eveningAt?: string;
  readonly fetch?: typeof fetch;
  /** Keeps a new place in the settings, when the user accepts moqi's offer to follow where they live. */
  readonly save?: (place: WeatherPlace) => void | Promise<void>;
}

export interface Forecast {
  readonly day: string;
  readonly code: number;
  readonly min: number;
  readonly max: number;
  readonly rain: number;
}

const WMO: Record<number, string> = {
  0: "晴",
  1: "大致晴",
  2: "多云",
  3: "阴",
  45: "雾",
  48: "雾凇",
  51: "毛毛雨",
  53: "毛毛雨",
  55: "毛毛雨",
  56: "冻毛毛雨",
  57: "冻毛毛雨",
  61: "小雨",
  63: "中雨",
  65: "大雨",
  66: "冻雨",
  67: "冻雨",
  71: "小雪",
  73: "中雪",
  75: "大雪",
  77: "雪粒",
  80: "阵雨",
  81: "阵雨",
  82: "强阵雨",
  85: "阵雪",
  86: "强阵雪",
  95: "雷阵雨",
  96: "雷阵雨伴冰雹",
  99: "雷阵雨伴冰雹",
};

export function describeWeather(f: Forecast, place: string, label: string): string {
  return `${place}${label}${WMO[f.code] ?? "天气未知"}，${Math.round(f.min)}~${Math.round(f.max)}°C，降水概率 ${f.rain}%`;
}

export function needsUmbrella(f: Forecast): boolean {
  return f.rain >= 60 || (f.code >= 51 && f.code <= 99 && f.rain >= 40);
}

export async function fetchForecast(
  o: { readonly latitude: number; readonly longitude: number; readonly fetch?: typeof fetch },
  signal?: AbortSignal,
): Promise<Forecast[]> {
  const url =
    "https://api.open-meteo.com/v1/forecast" +
    `?latitude=${o.latitude}&longitude=${o.longitude}` +
    "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=2";
  const response = await (o.fetch ?? fetch)(url, signal ? { signal } : {});
  if (!response.ok) throw new Error(`Open-Meteo responded ${response.status}`);
  const body = (await response.json()) as {
    daily?: {
      time?: string[];
      weather_code?: number[];
      temperature_2m_max?: number[];
      temperature_2m_min?: number[];
      precipitation_probability_max?: (number | null)[];
    };
  };
  const d = body.daily;
  if (!d?.time) throw new Error("Open-Meteo returned no daily forecast");
  return d.time.map((day, i) => ({
    day,
    code: d.weather_code?.[i] ?? -1,
    max: d.temperature_2m_max?.[i] ?? Number.NaN,
    min: d.temperature_2m_min?.[i] ?? Number.NaN,
    rain: d.precipitation_probability_max?.[i] ?? 0,
  }));
}

/** Coordinates for a place name, from Open-Meteo's geocoder; undefined when it knows no such place. */
export async function geocode(
  name: string,
  doFetch: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<WeatherPlace | undefined> {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1&language=zh&format=json`;
  const response = await doFetch(url, signal ? { signal } : {});
  if (!response.ok) throw new Error(`Open-Meteo geocoding responded ${response.status}`);
  const body = (await response.json()) as { results?: { name?: string; latitude?: number; longitude?: number }[] };
  const hit = body.results?.[0];
  if (typeof hit?.latitude !== "number" || typeof hit.longitude !== "number") return undefined;
  return { latitude: hit.latitude, longitude: hit.longitude, place: hit.name || name };
}

/**
 * Where the user says they live, from their own words ("住在南京市江宁区" → "南京"), or undefined. The Han
 * characters after the keyword, cut before 市/省/区/县, and the first two when still longer than three.
 */
export function homeCity(text: string): string | undefined {
  const m = /(?:住在|家在)([\u4e00-\u9fa5]{2,8})/.exec(text);
  if (!m?.[1]) return undefined;
  const cut = m[1].split(/[市省区县]/)[0] ?? "";
  const city = cut.length > 3 ? cut.slice(0, 2) : cut;
  return city.length >= 2 ? city : undefined;
}

const PLACE_KIND = "weather.place";

export function weatherPlugin(options: WeatherOptions): Plugin {
  const evening = options.eveningAt ?? "20:00";
  const [eh, em] = evening.split(":").map(Number) as [number, number];
  const doFetch = options.fetch ?? fetch;
  const own: WeatherPlace | undefined =
    options.latitude !== undefined && options.longitude !== undefined && options.place
      ? { latitude: options.latitude, longitude: options.longitude, place: options.place }
      : undefined;
  const found = new Map<string, Promise<WeatherPlace | undefined>>();
  const lookUp = (name: string, signal?: AbortSignal) => {
    const key = name.trim();
    if (!found.has(key)) {
      const asked = geocode(key, doFetch, signal);
      found.set(key, asked);
      asked.catch(() => found.delete(key)); // a failed lookup is tried again next time
    }
    return found.get(key) as Promise<WeatherPlace | undefined>;
  };
  return {
    name: "weather",
    tools: [
      defineTool({
        name: "weather",
        description: own
          ? `Weather forecast, today or tomorrow. Without place: ${own.place}, the user's own place. For any other city, give place.`
          : "Weather forecast, today or tomorrow, for the city in place. No place of the user's is set yet, so always give place.",
        input: z.object({
          day: z.enum(["today", "tomorrow"]).default("today"),
          place: z.string().min(1).max(40).optional().describe("A city name, e.g. 南京"),
        }),
        effect: "read",
        run: async ({ day, place }, ctx) => {
          const where = place ? await lookUp(place, ctx.signal) : own;
          if (!where)
            throw new Error(place ? `找不到「${place}」这个地方` : "还没设天气地点：告诉我城市，或者在设置里搜一下");
          const forecast = await fetchForecast({ ...where, fetch: doFetch }, ctx.signal);
          const f = forecast[day === "today" ? 0 : 1];
          if (!f) throw new Error("no forecast for that day");
          const headline = describeWeather(f, where.place, day === "today" ? "今天" : "明天");
          return { value: `${f.day}:${f.code}:${Math.round(f.min)}:${Math.round(f.max)}:${f.rain}`, headline };
        },
      }),
      defineTool({
        name: "weather_use_place",
        description: "Make a city the user's own place for the weather.",
        input: z.object({ place: z.string().min(1).max(40) }),
        effect: "write",
        hidden: true, // only from the user accepting moqi's offer
        run: async ({ place }, ctx) => {
          if (!options.save) throw new Error("这里改不了天气地点，去设置里搜一下城市");
          const where = await lookUp(place, ctx.signal);
          if (!where) throw new Error(`找不到「${place}」这个地方`);
          await options.save(where);
          return `好，天气改成${where.place}了`;
        },
      }),
    ],
    async briefing() {
      if (!own) return undefined;
      const today = (await fetchForecast({ ...own, fetch: doFetch }))[0];
      if (!today) return undefined;
      const lines = [describeWeather(today, own.place, "今天")];
      if (needsUmbrella(today)) lines.push("记得带伞");
      return { title: "天气", lines };
    },
    async tick(ctx) {
      const now = ctx.now();
      // Where the user lives and where the weather is from should agree; ask once per city when they do not.
      const city = activeFacts(ctx.state, now)
        .filter((f) => f.by === undefined)
        .map((f) => homeCity(f.content))
        .find((c) => c !== undefined);
      const ownName = own?.place.replace(/市$/, "");
      const agrees = city !== undefined && ownName !== undefined && (city.includes(ownName) || ownName.includes(city));
      const asked = [...ctx.state.offers.values()].some(
        (r) => r.offer.kind === PLACE_KIND && r.offer.action?.args.place === city,
      );
      if (city && !agrees && !asked) {
        ctx.offer({
          kind: PLACE_KIND,
          title: `天气要改成${city}吗？`,
          body: own ? `你说过住在${city}，天气现在设的是${own.place}。` : `你说过住在${city}，天气还没设地点。`,
          value: 0.6,
          urgency: "whenever",
          action: { tool: "weather_use_place", args: { place: city } },
        });
      }
      // Unasked: in the evening, say so if tomorrow needs an umbrella. Once per day.
      if (!own || minuteOfDay(now) < eh * 60 + em) return;
      const today = dayKey(now);
      const done = [...ctx.state.offers.values()].some(
        (r) => r.offer.kind === "weather.tomorrow" && dayKey(r.offer.createdAt) === today,
      );
      if (done) return;
      const tomorrow = (await fetchForecast({ ...own, fetch: doFetch }))[1];
      if (!tomorrow || !needsUmbrella(tomorrow)) return;
      ctx.offer({
        kind: "weather.tomorrow",
        title: "明天记得带伞",
        body: describeWeather(tomorrow, own.place, "明天"),
        value: 0.7,
        urgency: "today",
      });
    },
  };
}
