import { describe, expect, it } from "vitest";
import { calendarPlugin, parseIcs } from "../src/plugins/calendar.js";
import { describeWeather, fetchForecast, weatherPlugin } from "../src/plugins/weather.js";
import { harness } from "./helpers.js";

const ICS = [
  "BEGIN:VCALENDAR",
  "BEGIN:VEVENT",
  "UID:a",
  "DTSTART;TZID=Asia/Shanghai:20261120T093000",
  "DTEND;TZID=Asia/Shanghai:20261120T103000",
  "SUMMARY:周会\\, 产品",
  "LOCATION:3 号会议",
  " 室",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:b",
  "DTSTART;VALUE=DATE:20261120",
  "SUMMARY:朵朵生日",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:c",
  "DTSTART:20261120T060000Z",
  "SUMMARY:和美国同事通话",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:d",
  "DTSTART:20261121T080000",
  "RRULE:FREQ=DAILY",
  "SUMMARY:每天晨跑",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

describe("calendar (.ics)", () => {
  it("parses timed, all-day and UTC events, folded lines and escapes; skips repeats", () => {
    const events = parseIcs(ICS);
    expect(events.map((e) => [e.uid, new Date(e.start).toISOString(), e.allDay, e.summary])).toEqual([
      ["b", "2026-11-19T16:00:00.000Z", true, "朵朵生日"],
      ["a", "2026-11-20T01:30:00.000Z", false, "周会, 产品"],
      ["c", "2026-11-20T06:00:00.000Z", false, "和美国同事通话"],
    ]);
    expect(events[1]?.location).toBe("3 号会议室");
  });

  it("adds today's events to the briefing and warns 30 minutes before, once", async () => {
    const { moqi, clock, delivered } = harness({
      plugins: [calendarPlugin({ load: () => ICS })],
      start: "2026-11-20T08:50:00+08:00",
    });
    expect((await moqi.briefing()).body).toContain("【今天的日程】\n· 全天 朵朵生日\n· 09:30 周会, 产品（3 号会议室）");
    await moqi.tick();
    expect(delivered.filter((d) => d.offer.kind === "calendar.soon")).toHaveLength(0);
    clock.set("2026-11-20T09:05:00+08:00");
    await moqi.tick();
    await moqi.tick();
    const soon = delivered.filter((d) => d.offer.kind === "calendar.soon");
    expect(soon).toHaveLength(1);
    expect(soon[0]).toMatchObject({
      surface: "notify",
      offer: { title: "09:30 周会, 产品", body: "25 分钟后开始，在3 号会议室" },
    });
  });
});

function fakeForecast(rainTomorrow: number) {
  const calls: string[] = [];
  const fetch = (async (url: string) => {
    calls.push(String(url));
    return new Response(
      JSON.stringify({
        daily: {
          time: ["2026-11-20", "2026-11-21"],
          weather_code: [2, 63],
          temperature_2m_max: [8, 6],
          temperature_2m_min: [-1, 2],
          precipitation_probability_max: [0, rainTomorrow],
        },
      }),
    );
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

describe("weather (Open-Meteo)", () => {
  const place = { latitude: 39.9, longitude: 116.4, place: "北京" };

  it("reads the forecast and describes it", async () => {
    const f = fakeForecast(80);
    const [today, tomorrow] = await fetchForecast({ ...place, fetch: f.fetch });
    expect(f.calls[0]).toContain("latitude=39.9&longitude=116.4");
    expect(describeWeather(today as never, "北京", "今天")).toBe("北京今天多云，-1~8°C，降水概率 0%");
    expect(tomorrow?.code).toBe(63);
  });

  it("is a tool that watches can compare", async () => {
    const f = fakeForecast(80);
    const { moqi } = harness({ plugins: [weatherPlugin({ ...place, fetch: f.fetch })] });
    expect(await moqi.callTool("weather", { day: "tomorrow" }, { byUser: true })).toBe(
      "北京明天中雨，2~6°C，降水概率 80%",
    );
  });

  it("warns about rain tomorrow in the evening, unasked and once", async () => {
    const f = fakeForecast(80);
    const { moqi, clock, delivered } = harness({
      plugins: [weatherPlugin({ ...place, fetch: f.fetch })],
      start: "2026-11-20T19:00:00+08:00",
    });
    await moqi.tick();
    expect(delivered).toHaveLength(0);
    clock.set("2026-11-20T20:10:00+08:00");
    await moqi.tick();
    await moqi.tick();
    expect(delivered.map((d) => [d.surface, d.offer.title])).toEqual([["notify", "明天记得带伞"]]);
  });

  it("says nothing when tomorrow is dry", async () => {
    const f = fakeForecast(10);
    const { moqi, delivered } = harness({
      plugins: [weatherPlugin({ ...place, fetch: f.fetch })],
      start: "2026-11-20T20:10:00+08:00",
    });
    await moqi.tick();
    expect(delivered).toHaveLength(0);
  });
});
