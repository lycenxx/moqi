// Weather from Open-Meteo (free, no API key). Uses only fetch, so it runs on desktop and phone.
import { z } from "zod";
import { defineTool, type Plugin } from "../core/plugin.js";
import { dayKey, minuteOfDay } from "../core/schedule.js";

export interface WeatherOptions {
  readonly latitude: number;
  readonly longitude: number;
  /** Shown to the user, e.g. "北京". */
  readonly place: string;
  /** From this local time on, warn about rain tomorrow (once a day). Default "20:00". */
  readonly eveningAt?: string;
  readonly fetch?: typeof fetch;
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

export async function fetchForecast(o: WeatherOptions, signal?: AbortSignal): Promise<Forecast[]> {
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

export function weatherPlugin(options: WeatherOptions): Plugin {
  const evening = options.eveningAt ?? "20:00";
  const [eh, em] = evening.split(":").map(Number) as [number, number];
  return {
    name: "weather",
    tools: [
      defineTool({
        name: "weather",
        description: `Weather forecast for ${options.place}, today or tomorrow.`,
        input: z.object({ day: z.enum(["today", "tomorrow"]).default("today") }),
        effect: "read",
        run: async ({ day }, ctx) => {
          const forecast = await fetchForecast(options, ctx.signal);
          const f = forecast[day === "today" ? 0 : 1];
          if (!f) throw new Error("no forecast for that day");
          const headline = describeWeather(f, options.place, day === "today" ? "今天" : "明天");
          return { value: `${f.day}:${f.code}:${Math.round(f.min)}:${Math.round(f.max)}:${f.rain}`, headline };
        },
      }),
    ],
    async briefing() {
      const today = (await fetchForecast(options))[0];
      if (!today) return undefined;
      const lines = [describeWeather(today, options.place, "今天")];
      if (needsUmbrella(today)) lines.push("记得带伞");
      return { title: "天气", lines };
    },
    async tick(ctx) {
      // Unasked: in the evening, say so if tomorrow needs an umbrella. Once per day.
      const now = ctx.now();
      if (minuteOfDay(now) < eh * 60 + em) return;
      const today = dayKey(now);
      const done = [...ctx.state.offers.values()].some(
        (r) => r.offer.kind === "weather.tomorrow" && dayKey(r.offer.createdAt) === today,
      );
      if (done) return;
      const tomorrow = (await fetchForecast(options))[1];
      if (!tomorrow || !needsUmbrella(tomorrow)) return;
      ctx.offer({
        kind: "weather.tomorrow",
        title: "明天记得带伞",
        body: describeWeather(tomorrow, options.place, "明天"),
        value: 0.7,
        urgency: "today",
      });
    },
  };
}
