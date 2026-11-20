# moqi（默契）

[![CI](https://github.com/wangcao-hub/moqi/actions/workflows/ci.yml/badge.svg)](https://github.com/wangcao-hub/moqi/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/moqi)](https://www.npmjs.com/package/moqi) [![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

**不用开口就懂你的个人 agent。** 它从你的日常里了解你，在合适的时候先开口，越用越懂你。

[English](./README.md) · [设计](./docs/design.md)

大多数助理等你来问。moqi 反过来：你问过三次的事，第四次它直接告诉你；明天要下雨，它前一晚提醒你带伞；会议 30 分钟后开始，它先说一声。它也知道什么时候该闭嘴：晚上不打扰、一天最多打扰三次、你嫌烦的那类事它会越来越少说。

内核是纯 TypeScript，不依赖 Node 专有 API，同一份代码可以跑在电脑上，也可以放进手机 App。

## 三件事加一条原则

|            | 做什么                                                                                                                                                   |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **看得到** | 日历、天气、对话……每个来源都是插件，需要你开启，数据只在你自己的设备上                                                                                   |
| **懂得多** | 用户模型：事实、偏好、习惯、关系、在忙的事。同一件事印证 3 次转为长期；30 天没再提起就淡出；前后矛盾时交给你定                                           |
| **说得准** | 每一次"想开口"都是一条提议，按价值、紧急程度、免打扰时段和每日打扰额度决定是弹通知、放进动态，还是不说；你的反应（接受、忽略、关掉）会调整这一类事的门槛 |

**信任按事情一件一件挣**：会改变外部世界的动作先问你；同一类事你连续同意 3 次，moqi 才问"以后要不要直接办"；拒绝一次就降回去。删除记忆这类动作永远先问。

## 快速开始

需要 Node.js 22 或更高版本。

```
npm install -g moqi
moqi init        # 在 ~/.moqi/config.json 写一份配置模板
moqi             # 对话，并在后台替你留意
```

配置里填一个 OpenAI 兼容的模型。本机 Ollama 可以直接用（模板里是 `qwen3:4b`，先 `ollama pull qwen3:4b`），DeepSeek、通义千问等也可以。对话长了回答被截断的话，调大 Ollama 的上下文窗口，例如 `OLLAMA_CONTEXT_LENGTH=16384 ollama serve`。

```json
{
  "model": { "baseURL": "http://127.0.0.1:11434/v1", "model": "qwen3:4b", "noThink": true },
  "briefingAt": "08:00",
  "quiet": { "from": "22:30", "to": "08:00" },
  "dailyBudget": 3,
  "weather": { "latitude": 22.54, "longitude": 113.93, "place": "深圳" },
  "calendar": { "ics": "~/calendar.ics" }
}
```

`noThink` 用在 Qwen3 这类会先"思考"的模型上：后台的短请求会带上 `/no_think`，避免小模型把 token 全花在思考上。API key 也可以用环境变量 `MOQI_API_KEY` 传，不写进文件。

```
你：我住在深圳南山，在一家互联网公司做产品
moqi：记住了
你：每天晚上 10 点提醒我早点睡
要我每天 22:00提醒你「早点睡」吗？ [y/N] y
moqi：好，每天 22:00 替你提醒「早点睡」
```

对话里的命令：`/brief` 简报、`/offers` 待处理的提议、`/accept <id>` / `/dismiss <id>` / `/mute <id>`、`/memory` 它记住了什么、`/watches` 托管的事、`/trust` 各类动作的信任等级。

- `moqi daemon`：只在后台留意，用系统通知找你（macOS、Linux）。
- `moqi brief`：打印今天的简报。

## 它会主动做的事

| 什么时候                           | 做什么                                                             | 来自                  |
| ---------------------------------- | ------------------------------------------------------------------ | --------------------- |
| 每天早上（`briefingAt`）           | 简报：今天的日程、天气、替你留意的事、需要你定的事、今天要盯的事   | 内核                  |
| 你连续几天差不多同一时间问同一件事 | 问你"以后要不要每天这个时候直接告诉你"，你接受后自动建一件托管事务 | 内核（习惯识别）      |
| 托管事务到点                       | 查一次，和上次比，有变化（或设成每次）就告诉你                     | 内核（taugraph 流程） |
| 记忆前后矛盾                       | 请你定以哪个为准                                                   | 内核                  |
| 某类事你连续同意 3 次              | 问你以后要不要直接办                                               | 内核                  |
| 晚上 8 点后，明天要下雨            | 提醒带伞                                                           | 天气插件              |
| 日程前 30 分钟                     | 提醒你快开始了                                                     | 日历插件              |

## 写一个插件

插件提供工具、简报里的一节，以及每次心跳时要做的事：

```ts
import { defineTool, Moqi, type Plugin } from "moqi";
import { z } from "zod";

const water: Plugin = {
  name: "water",
  tools: [
    defineTool({
      name: "water_log",
      description: "今天喝了几杯水",
      input: z.object({}),
      effect: "read",
      run: () => ({ value: "3", headline: "今天喝了 3 杯水" }),
    }),
  ],
  briefing: () => ({ title: "喝水", lines: ["昨天只喝了 3 杯"] }),
  tick: (ctx) => {
    // 观察世界，在需要时用 ctx.offer(...) 提议；moqi 决定送不送、怎么送
  },
};

const moqi = new Moqi({ plugins: [water] });
```

`effect: "read"` 的工具随时可用，也能被托管事务调用；`"write"` 的工具从"先问你"开始，靠你的同意一步步获得信任。

## 数据

所有状态都由事件日志重放得到：`~/.moqi/events.jsonl`，只追加，一行一个事件。换机器、备份、排查问题都只需要这一个文件。同一个目录同时只能有一个 moqi 进程。

## 现状与限制

这是第一版（P0），只在电脑上运行。已经可用的：内核、命令行、天气与日历插件、系统通知、托管事务、习惯识别、对话中的旁路学习。

- 手机 App 和多设备同步还没做（P1）。内核已经按能跑在手机里的标准写，有测试检查。
- 日历只读单次日程，重复日程（RRULE）暂时不展开。
- 用本机 4B 小模型时，后台抽取偶尔会把一次性的请求当成事实；换更大的模型会好很多。你随时可以用 `/memory` 查看，用"忘掉某某"删除。
- "办完可撤销"这一级目前的意思是"直接办，并告诉你"，撤销要靠对应的取消操作。

## 开发

```
pnpm install
pnpm check      # 类型检查、lint、测试（测试固定在 Asia/Shanghai 时区）
```

## 许可证

[MIT](./LICENSE)
