# 少确认设计

> 2026-11-23 定稿。实现以代码和测试为准。建立在 `2026-11-23-dangerous-actions-design.md`（安全底座）、`2026-11-23-computer-and-web-design.md`（网站授权）和 `2026-11-23-coding-agents-design.md`（编程任务）之上。

## 1. 目标

用户体验新功能时觉得确认太多。四处改动，和用户确认过：

- **A. 记住网站**：问"要我打开 xx 吗？"时可以选"以后都允许"。
- **B. 合并只确认一次**：动态卡片上点"合并到 main"就合并。
- **C. 普通动作在设置里放开**：不用等"连着同意 3 次"。
- **D. 放开的浏览器工具也认网站授权**：放开以后，不会因为读过网页而每点一下都问。

不变的：读过外部内容以后，危险动作仍要问（D 里在已授权网站内浏览是唯一的例外，和现在按轮授权的规则一样）；快捷指令、移到废纸篓、交编程任务、MCP 写工具的规则不变；删除记忆（`forget`）每次都问。

## 2. A：记住网站

### 2.1 数据

- 新事件：`site.remembered { host }`、`site.forgotten { host }`。
- `State.sites: Set<string>`，按事件折叠。`host` 用 `hostOf` 的结果（小写、去掉 `www.`、非默认端口带端口）。覆盖规则和按轮授权相同：含子域名，单段主机名（`localhost`）只算它自己。

### 2.2 确认接口

- `MoqiOptions.confirm(question, details?, choices?)`，`choices` 可选：`{ always: string }`（按钮文字）。返回 `Promise<boolean | "always">`。不传 `choices` 时行为不变。
- 控制台：`confirmQueue().ask(text, details, always?)`；`GET /api/state` 的 `question` 多一个 `always`（按钮文字或不出现）；`POST /api/confirm { id, yes, always? }`，`always: true` 时回答 `"always"`。确认框多一个按钮「以后都允许」，排在「好」后面。
- 终端（`moqi chat`）：问题后缀变成 `[y/N/a]`，`a` 是以后都允许。
- 只有用户在确认框里的回答能记住网站。没有工具、提议或接口能让模型或别的 agent 加网站。

### 2.3 调用工具时

- `callTool` 判断网站时，用"这一轮授权的 ∪ 记住的"：`{ granted: new Set([...how.sites.granted, ...state.sites]), current: how.sites.current }`。
- 网站问题：`要我打开 <host> 吗？`，详情不变，`choices: { always: "以后都允许" }`。回答 `true`：加进这一轮的授权（同现在）；`"always"`：同上，并记 `site.remembered`；`false`：不做。
- 输入文字、填表、上传、执行脚本这些不在 `PLAYWRIGHT_SITES` 里的工具，规则不变，每次都问。

### 2.4 设置页

- 「能力包 → 浏览器」下面列出记住的网站（按字母排序），每个带「移除」。
- `GET /api/tools` 多返回 `sites: string[]`；`POST /api/site/forget { host }` 记 `site.forgotten`，不在名单里返回 404。

## 3. B：合并只确认一次

- `callTool` 的 `how` 加 `confirmed?: true`：用户已经看着这个具体动作点了按钮。危险工具带它时按"已同意"处理，不再问。
- 只有 `feedback()` 会传它，条件全部满足才传：提议 `kind === "code.done"`、动作是 `code_merge`、`offer.about` 等于动作参数里的 `id`、这个任务的状态是 `done` 或 `failed`。其他提议带的危险动作照旧再确认（原因"offer"）。
- 合并仍然在 `merge()` 里拒绝：目录里有没提交的已跟踪改动、有冲突。
- 控制台卡片按钮写明目标分支：`GET /api/state` 的 `code` 里，状态为 `done` 或 `failed` 的任务多一个 `into`（`runner.currentBranch(project)`），按钮文字 `合并到 <into>`。
- 终端里 `/accept <id>` 走同一个 `feedback()`，同样不再二次确认。

## 4. C：普通动作在设置里放开

- 能放开的工具：可见（不是 `hidden`）、`effect: "write"`、不是危险工具、起点等级不高于 `suggest`、上限高于 `suggest`。现在是：`files_mkdir`、`files_write_new`、`files_move`、`files_rename`、`mac_clipboard_write`、`watch_create`、`watch_cancel`、`todo_remove`。`forget` 上限是 `suggest`，不在其中。
- `GET /api/tools` 多返回 `ordinary: { name, source, label, level: "ask" | "auto" }[]`：当前等级不高于 `suggest` 为 `ask`，否则为 `auto`。
- `POST /api/tool-level { tool, level: "ask" | "auto" }`：`ask` 记 `level.changed` 为 `suggest`，`auto` 记为这个工具的上限（`auto-undo`）。不符合上面条件的工具返回 400。
- 设置页「会改动东西的工具」分两组："危险动作"（现在的列表）和"普通动作"，后者每个工具两档：「先问我」「直接办，办完告诉你」。
- 和信任阶梯共用同一个等级：同意 3 次后接受"以后这类事直接办？"，设置页里也显示为"直接办"；在设置页改回"先问我"，阶梯从头计。

## 5. D：放开的浏览器工具也认网站授权

`callTool` 里网站判断的条件从"策略是 ask"改为：

- 策略 `ask`：同现在。
- 策略 `auto` 且这一轮读过外部内容：先按网站判断。在已授权或记住的网站上直接办；`goto` 到新网站，问网站问题（带「以后都允许」）；其他情况（比如页面在没授权的网站上）按现在的规则问，原因"读到了外部内容"。
- 策略 `auto` 且没读过外部内容：直接办，同现在；如果是带地址的 `goto`，把这个网站算作这一轮已授权（地址来自用户的话，不是外部内容），之后读了页面也能在这个网站上继续点。
- 策略 `normal`：走信任阶梯，不看网站，同现在。

## 6. 测试

- `test/sites.test.ts`：
  - 选"以后都允许"后，下一轮打开、点击这个网站及子域名都不问；输入文字仍问；移除后又问。
  - 只回答 `true` 时，下一轮仍问（按轮授权不变）。
  - 浏览器工具设为 `auto`：读过网页后在已授权网站上点击不问；去新网站问网站问题；没读过外部内容时直接办。
- `test/code.test.ts`：接受 `code.done` 提议直接合并、不问；伪造的同类提议（`about` 和动作 `id` 对不上、任务已合并）仍然问或拒绝。
- `test/console.test.ts`：确认框的 `always`；`/api/site/forget`；`/api/tool-level` 的允许和拒绝；`/api/tools` 的 `sites` 和 `ordinary`；`code[].into`。
- 终端确认：把回答的解析抽成一个小函数（`y`、`a`、其他），单独测试。
- 完成标准：`pnpm check` 全部通过。

## 7. 文档

- README（中英文）设计取舍或能力包表格里说明：网站可以记住，在设置里移除；普通动作可以在设置里直接放开。
- `docs/design.md` 安全一节补上记住的网站和 `confirmed`。
- `CHANGELOG.md` 加一条。
