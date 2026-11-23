# 操作电脑和网页设计

> 2026-11-23 定稿。实现以代码和测试为准。建立在 `2026-11-23-dangerous-actions-design.md`（安全底座）之上。

## 1. 目标

- **网页**：moqi 在一个独立的浏览器配置里打开网页、点击、翻页、读内容。每个网站在一轮对话里授权一次；输入文字、填表、上传、执行脚本仍然每次问。
- **文件**：在用户选的文件夹里列出、读取、新建文件夹、新建文件（不覆盖）、移动、改名、移到废纸篓。所有动作都能撤回。
- **macOS**：一组固定动作（打开 App、在访达里显示、截图、音量、剪贴板），加上用户挑选的快捷指令。不开放任意 AppleScript 或 shell。

和用户确认过的选择：浏览器用独立配置（不接用户正在用的 Chrome）；网页按任务授权一次；文件以整理为主（不改已有文件的内容，不永久删除）；macOS 用固定动作加快捷指令。

## 2. 做法

- 网页用 Playwright MCP（微软官方的 MCP 服务器），以"能力包"的形式一键加上。内核新增"网站授权"。
- 文件和 macOS 由 moqi 自带的插件实现，放在 `src/node`（要用 Node 的文件和进程接口），效果严格按第 1 节的选择。

没有选的做法：

- **全部用现成的 MCP 服务器**：官方 filesystem 服务器能覆盖和修改已有文件，没有移到废纸篓；社区的 macOS 服务器大多开放"运行 AppleScript"。都和用户的选择对不上。
- **自己驱动浏览器**：要重做 Playwright 已有的页面结构提取，工作量大，效果差。

实现分三段，各自测试、各自提交：网页、文件、macOS 和快捷指令。

## 3. 网页

### 3.1 浏览器能力包（`src/node/presets.ts`）

- `browserPreset(execPath, home)` 返回一项 MCP 服务器配置：
  - `command`：和当前 node 同目录的 `npx`（`join(dirname(process.execPath), "npx")`）；
  - `args`：`["-y", "@playwright/mcp@0.0.86", "--user-data-dir", "<home>/.moqi/browser/profile", "--output-dir", "<home>/.moqi/browser/output"]`；
  - `cwd`：`<home>/.moqi/browser`。
  - 这里的 `<home>/.moqi` 指 moqi 的主目录（`MOQI_HOME` 或 `~/.moqi`），路径都写成绝对路径。
- 版本固定为 0.0.86，不用 `@latest`。
- 浏览器用 Playwright 的默认设置（用户装好的 Chrome），配置和用户平时的 Chrome 分开。

### 3.2 工具分类（`src/node/presets.ts` 的 `PLAYWRIGHT_SITES`）

只对命令参数里带 `@playwright/mcp` 的服务器生效，由 `mcp-client.ts` 在包装工具时读取。

| 类别           | 工具                                                                                                                                                                                             | 标记                         |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------- |
| 只看           | `browser_snapshot`、`browser_take_screenshot`、`browser_find`、`browser_console_messages`、`browser_network_requests`、`browser_network_request`                                                 | 服务器标为只读，无需额外标记 |
| 打开网址       | `browser_navigate`；带 `url` 的 `browser_tabs`                                                                                                                                                   | `site: "goto"`               |
| 在网站里走动   | `browser_click`、`browser_hover`、`browser_navigate_back`、`browser_wait_for`、`browser_resize`、`browser_close`、`browser_drag`、`browser_emulate_media`、不带 `url` 的 `browser_tabs`          | `site: "within"`             |
| 会把东西发出去 | `browser_type`、`browser_fill_form`、`browser_press_key`、`browser_file_upload`、`browser_drop`、`browser_select_option`、`browser_evaluate`、`browser_run_code_unsafe`、`browser_handle_dialog` | 不加标记，按危险工具每次问   |

不在表里的写工具（以后新增的、`--caps` 打开的）不加标记，按危险工具每次问。

`browser_tabs` 两种情况都有：工具标 `site: "goto"`，判断时如果参数里没有 `url`，按 `within` 处理。

### 3.3 网站授权（内核）

- `Tool` 加 `site?: "goto" | "within"`。
- `chatTurn` 在这一轮里维护 `sites: Set<string>`（已授权的主机名），和 `tainted` 一起放进 `callTool` 的 `how`：`{ byUser, tainted, sites }`。
- `callTool` 对 `guarded` 且带 `site` 的工具，先于原有规则判断：
  - **打开网址**（`site: "goto"` 且参数有 `url`）：
    - 取 `new URL(args.url)`，协议必须是 `http:` 或 `https:`；主机名转小写，去掉开头的 `www.`。
    - 主机名等于某个已授权的主机，或是它的子域名（`host.endsWith("." + granted)`）：不问，直接执行。
    - 否则问。问题：`要我打开 <主机名> 吗？`；`details`：`这一轮里在 <主机名> 上打开页面、点击、翻页不再问；输入文字、上传、执行脚本仍会问。` 空一行，再附完整网址。同意后把主机名加进 `sites`。
    - 网址解析不了或协议不对：不算授权范围，按危险工具问，`details` 里显示原样的参数。
  - **在网站里走动**（`site: "within"`，或 `goto` 但没有 `url`）：浏览器当前所在页面的网站已授权时不问；否则按原有规则。当前页面取自带 `site` 的工具上一次结果里 Playwright 自己写的 `- Page URL:` 一行，只读页面内容（`### Snapshot`）之前的部分，网页上的文字冒充不了。读不到时算不在授权网站上。
- 授权是用户这一轮的明确同意，所以对授权范围内的动作，`tainted` 不会让它再问。
- 用户在设置里把这个工具改成 `auto` 或 `normal` 时，网站授权不再适用，按安全底座的规则走。
- 没有 `sites` 的调用（接受提议、托管事务、控制台直接调用）不适用网站授权。
- 下一轮 `sites` 清空。

## 4. 文件（`src/node/files.ts`）

### 4.1 开关

- 配置 `files: { folders: string[] }`，没有这一项就是关闭。设置里打开时默认 `["~/Downloads", "~/Desktop"]`。
- 保存配置时检查每个文件夹存在且是目录，否则 400，写明是哪一个。

### 4.2 工具

| 工具                              | 做什么                                                          | 类别                    |
| --------------------------------- | --------------------------------------------------------------- | ----------------------- |
| `files_list {folder}`             | 名字、类型、大小、修改时间；跳过隐藏文件；最多 200 项           | 只读，结果算外部内容    |
| `files_read {path}`               | 文本文件，最多 2 万字；含 `\0` 的当作二进制，返回说明           | 只读，结果算外部内容    |
| `files_mkdir {path}`              | 新建文件夹（上级必须已存在）                                    | 写，`local`，走信任阶梯 |
| `files_write_new {path, content}` | 新建文件，`content` 最多 1 MB；已存在就拒绝（用 `wx` 打开）     | 写，`local`，走信任阶梯 |
| `files_move {from, to}`           | `to` 是已存在的文件夹时移进去，否则当作新路径；目标已存在就拒绝 | 写，`local`，走信任阶梯 |
| `files_rename {path, name}`       | 原地改名；新名字已存在就拒绝                                    | 写，`local`，走信任阶梯 |
| `files_trash {path}`              | 移到废纸篓                                                      | 写，`danger`            |

- 走信任阶梯的工具，返回结果写明怎么撤回，例如 `已把 a.pdf 移到 ~/Downloads/发票/a.pdf，要移回去就说一声`。
- 废纸篓：macOS 上 `osascript -e 'on run argv' -e 'tell application "Finder" to delete (POSIX file (item 1 of argv) as alias)' -e 'end run' -- <path>`；Linux 上 `gio trash <path>`，没有 `gio` 就拒绝。
- `files_list` 能用在托管事务里。

### 4.3 路径安全

- 接受绝对路径和 `~/` 开头的路径，其他一律拒绝。
- 已存在的路径用 `realpath` 解析；新路径解析上级目录再接上名字。结果必须等于某个允许文件夹的真实路径，或在它之下（前缀加路径分隔符）。
- 允许的文件夹本身不能被移动、改名、移到废纸篓。
- 名字（`files_rename` 的 `name`，以及新路径的最后一段）不能含 `/` 或 `\0`，不能是 `.` 或 `..`，不能为空。

## 5. macOS（`src/node/mac.ts`）

### 5.1 开关

- 配置 `mac: { shortcuts: string[] }`，没有这一项就是关闭；只在 `process.platform === "darwin"` 时生效。
- 所有命令用 `execFile`（参数列表），不经过 shell；文字只作为参数、标准输入或临时文件传入。

### 5.2 固定动作

| 工具                          | 做什么                                                                               | 类别                                |
| ----------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------- |
| `mac_open_app {name}`         | `open -a <name>`；名字不能含 `/`                                                     | 写，`local`，`start: "auto"`        |
| `mac_reveal {path}`           | `open -R <path>`；绝对路径或 `~/` 开头                                               | 写，`local`，`start: "auto"`        |
| `mac_screenshot {}`           | `screencapture -x <桌面>/moqi-截图-YYYYMMDD-HHMMSS.png`，返回路径                    | 写，`local`，`start: "auto"`        |
| `mac_volume {level?, muted?}` | `level` 0 到 100 的整数；`muted` 布尔；至少填一个；写死的 AppleScript，数值走 `argv` | 写，`local`，`start: "auto"`        |
| `mac_clipboard_read {}`       | `pbpaste`，最多 2 万字                                                               | 只读，`start: "suggest"`，`noWatch` |
| `mac_clipboard_write {text}`  | `pbcopy`，文字走标准输入，最多 1 MB                                                  | 写，`local`，走信任阶梯             |

- `Tool` 加 `noWatch?: true`：带它的只读工具不能用在托管事务和习惯识别里。
- 截图第一次会触发 macOS 的"屏幕录制"权限；不给权限时截出来只有桌面背景。设置里写明。

### 5.3 快捷指令

- `GET /api/shortcuts` 运行 `shortcuts list`（5 秒超时），返回 `{ available, shortcuts }`。不是 macOS、或没有 `shortcuts` 命令时 `available: false`。
- `mac.shortcuts` 里列出的、并且 `shortcuts list` 里确实存在的，才变成工具：
  - 名字：`shortcut_` 加快捷指令名字的 FNV-1a 32 位哈希（8 位十六进制）。
  - 描述：`运行快捷指令「<名字>」。input 是交给它的文字，可以不填。`
  - 输入：`{ input?: string }`，最多 2 万字，写进临时文件，`shortcuts run <名字> --input-path <文件> --output-path <文件>`。
  - 结果：读回输出文件，最多 2 万字；结果算外部内容。超过 60 秒中止。
  - `effect: "write"`、`danger: true`、`source: "快捷指令"`。
- 插件构造时运行一次 `shortcuts list`；设置保存后 moqi 重建，随之刷新。

## 6. 设置页的"能力包"（`src/node/console/`）

- 一组新的"能力包"，放在"其他 agent"上面：
  - **浏览器（Playwright）**：状态（未加上 / 启动中 / 已就绪 / 出错及原因，来自现有的 MCP 状态）和"加上"或"移除"按钮。`POST /api/preset {name: "browser", on: boolean}` 写入或删除 `mcp.servers.browser`。提示第一次启动要联网下载。
  - **文件**：开关和文件夹列表（一行一个），随"保存"写入。
  - **macOS 操作**：只在 macOS 上显示。开关和快捷指令勾选列表，随"保存"写入；页面提示截图需要"屏幕录制"权限。

## 7. 出错处理

- 浏览器服务器启动失败（没有 `npx`、下载失败、没装 Chrome）：设置页显示原因（现有机制）。
- 文件操作出错：`EACCES`、`EPERM` → `没有权限…`；`ENOENT` → `找不到…`；`EEXIST` → `已经有同名的…`；其他返回原始信息。
- 快捷指令失败或超时：`快捷指令「<名字>」没跑完：<原因>`。
- `shortcuts` 命令不存在：不生成快捷指令工具，设置页写明需要 macOS 12 以上。

## 8. 测试

都不真的启动浏览器，不动真实的文件和系统。

- `test/sites.test.ts`：每个网站每轮只问一次，子域名算授权；`within` 授权后不问、没授权时问；会把东西发出去的工具总是问；下一轮清零；`tainted` 不让授权范围内的动作再问；非 http(s) 网址总是问；接受提议不适用授权；工具被设为 `auto` 后不适用授权。
- `test/presets.test.ts`：浏览器能力包的命令、参数、版本、`cwd`；分类只对 `@playwright/mcp` 生效；不在表里的写工具保持危险、没有 `site`。
- `test/files.test.ts`：临时目录里测每个工具；不覆盖；越界、符号链接越界被拒绝；允许的文件夹本身受保护；非法名字被拒绝；废纸篓用替身函数。
- `test/mac.test.ts`：替身执行器；每个动作的参数列表；音量范围；剪贴板走标准输入；快捷指令列表解析、哈希命名稳定、只有勾选的成为工具、输入输出走临时文件、超时报错；`noWatch` 让剪贴板读取不出现在可托管的工具里。
- `test/console.test.ts`：`/api/preset`、`/api/shortcuts`（替身）、文件夹校验。
- 手动：在这台电脑上用真实的 Playwright MCP 打开一个网页、读出标题，确认网站授权的确认框。
- 完成标准：`pnpm check` 全部通过。

## 9. 文档

- README（中英文）：新增"能力包"一节（浏览器、文件、macOS 和快捷指令，各自能做什么、怎么打开）；"设计取舍"加一行网站授权；"现状与限制"写明 macOS 动作只在 macOS 上有，Linux 只有文件和浏览器。
- `docs/design.md`："不做：操作别的 App"改成"只通过固定动作和用户挑选的快捷指令操作别的 App，不开放任意脚本"；第 4 节加"操作电脑"一小节。
- `CHANGELOG.md` 的 Unreleased 加一条。

## 10. 不做

- 不接用户正在用的 Chrome（扩展模式）。
- 不修改已有文件的内容，不永久删除。
- 不开放任意 AppleScript 或 shell。
- 不做 Windows。
- 托管事务不能调用写工具（沿用现状）。

## 11. 补充：独立检查后的修正（2026-11-23）

- **"在网站里走动"看当前页面**：只有浏览器当前所在的网站已授权时才不问。当前网站取自浏览器工具结果里 Playwright 自己写的 `- Page URL:` 一行（只读 `### Snapshot` 之前的部分）。浏览器的任何工具都会更新它，比如按回车可能提交表单、跳到别处；带 `site` 的工具结果里没写网址时，算不知道在哪，下一步照常问。所以点击跳到授权以外的网站、切到上一轮留下的标签页、后退回别的网站，下一步都会问。
- **`browser_select_option` 改为每次都问**：它是用模型选的值填表单，和填表同类。
- **主机名带端口**：`localhost:3000` 和 `localhost:4567` 算两个网站；只有一段的主机名（`localhost`、`com`）不覆盖子域名。公共后缀（如 `github.io`）仍按普通域名处理，确认框里显示的主机名就是会被授权的范围。
- **移动和改名不会覆盖**：普通文件先建硬链接到目标（名字已被占用时直接失败，哪怕检查之后刚有文件落地），再删掉原来的链接；不支持硬链接的磁盘退回为"再查一次再改名"。文件夹仍用改名，改名最多替换一个空文件夹，不会丢东西。
- **确认框写出链接指向哪里**：路径中途经过符号链接时，问题里写成 `~/Downloads/a-link（链接，实际是 ~/Desktop/重要资料）`。
