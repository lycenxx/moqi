// Plugins that only use fetch and pure code, so they run on desktop and phone alike.
export { type CalendarEvent, type CalendarOptions, calendarPlugin, describeEvent, parseIcs } from "./calendar.js";
export {
  describeWeather,
  type Forecast,
  fetchForecast,
  needsUmbrella,
  type WeatherOptions,
  weatherPlugin,
} from "./weather.js";
