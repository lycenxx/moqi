# 交给编程 agent 写代码设计

> 2026-11-23 定稿。实现以代码和测试为准。建立在安全底座（`2026-11-23-dangerous-actions-design.md`）之上。

## 1. 目标

用户在对话里说"让 Kiro 把 moqi 的依赖升级一下，跑一遍测试"，moqi 把任务交给编程 agent 在后台做，做完在动态里给出结果，用户决定合并还是丢弃。

和用户确认过的选择：

- 每个任务在单独的 git 工作区和分支里做，点"合并"之前不碰项目目录。
- agent 只能改工作区里的文件，只能跑用户为这个项目列出的命令；命令在 agent 自带的系统沙箱里跑，默认不能联网。
- 第一版接 Kiro CLI 和 Claude Code；其他命令行（Cursor、Codex、Gemini）各写一个适配器，实测确认限制能生效之后再加。
- 交任务时传任务原文，加上与写代码有关的偏好和经验，确认框里逐条列出。
- 全部沿用用户现在的登录，moqi 不要也不存任何密钥。

## 2. 做法

moqi 直接在后台调用各家的命令行（新文件 `src/node/code.ts`）。权限交给各家自己的规则和沙箱执行，moqi 负责生成一次性的配置、检查结果。

没有选的做法：通过 ACP 协议逐步控制。控制更细，但 Claude Code 要多装第三方转接包，协议要手写，而兜底的仍然是系统沙箱。

实测记录（2026-11-23，本机）：

- Kiro CLI 3.5.0：`kiro-cli chat --v3 --no-interactive "<话>"` 用现在的登录能跑，不需要 `KIRO_API_KEY`。
- Claude Code 2.1.202：登录信息在 `~/.claude/settings.json` 的 `env` 里（自定义网关）。用 `--setting-sources project` 时不加载它，所以 moqi 只把那段 `env` 交给子进程。当前在终端里直接运行 `claude -p` 也返回 401（凭证失效），要用户先修好登录。
- Cursor（`cursor-agent`）：未登录，提示 `agent login`。

## 3. 配置和项目

```json
"code": {
  "timeoutMinutes": 30,
  "projects": [
    { "path": "~/2026/claw/github/moqi", "agent": "kiro", "commands": ["pnpm test", "pnpm build", "pnpm lint"], "network": false }
  ]
}
```

- `path`：必须是 git 仓库的根目录（`git -C <path> rev-parse --show-toplevel` 等于它的真实路径），保存时检查，不是就 400。
- `agent`：`"kiro"` 或 `"claude"`。
- `commands`：每条按"命令本身，或者它后面再跟参数"放行；最多 20 条，每条最多 200 字。
- `network`：默认 `false`。
- `timeoutMinutes`：默认 30，1 到 240。

找 agent：在 `PATH` 和 `~/.local/bin`、`/opt/homebrew/bin`、`/usr/local/bin` 里找 `kiro-cli`、`claude`。

## 4. 交任务（`code_delegate`）

- 输入：`{ project: string, task: string (1–4000 字), agent?: "kiro" | "claude" }`。`project` 可以是登记过的路径，也可以是它的文件夹名。
- `effect: "write"`、`danger: true`、`source: "编程 agent"`。
- `validate`：项目没登记；agent 没找到；这个项目已有任务在跑；任务为空。
- 确认：
  - 问题：`要我让 Kiro 在 moqi 里做「<任务前 60 字>」吗？`
  - `Tool.explain(args)`（新增的可选字段，附在确认详情末尾）列出：能跑的命令、能不能联网、要一起传的偏好和经验（逐条）、`改动会落在新分支 moqi/…，从你最近一次提交开始做，没提交的改动不会带过去；你点"合并"之前不碰原目录。`
- 成功后立刻返回：`已经交给 Kiro 了（任务 <id>），做完会在动态里告诉你。`

### 4.1 挑偏好

- 来源：类型为 `preference` 的、没淡出的事实，和全部经验（lessons）。
- 筛选：内容含以下任一关键词（不分大小写）：代码、编程、提交、commit、测试、test、注释、命名、分支、branch、合并、merge、PR、lint、格式、缩进、依赖、重构、文档、README、API、TypeScript、JavaScript、Python、Go、Rust、Java、Swift、中文、英文。
- 最多 10 条；不调用模型，确认框里列的就是会传的。

## 5. 运行（`src/node/code.ts`）

### 5.1 工作区

- 目录：`<moqi 主目录>/code/<任务 id>`；分支：`moqi/<YYYYMMDD-HHMM>-<任务 id>`。
- `git -C <项目> worktree add -b <分支> <目录> HEAD`，记下起点提交 `base`。

### 5.2 交给 agent 的话

```
<任务原文>

## 关于用户（来自 moqi）
- <偏好或经验>

## 规矩
- 只在当前目录里改文件。
- 能跑的命令只有：<命令列表>；其他命令会被拒绝。<不能联网时：命令连不上网。>
- 不要提交，moqi 会替你提交。
- 做完用几句话说明改了什么、测试结果如何。
```

### 5.3 Claude Code 适配器

- 命令：`claude -p <话> --output-format json --setting-sources project --strict-mcp-config --mcp-config {"mcpServers":{}} --settings <JSON>`，`cwd` 为工作区，标准输入关闭。
- `--settings`：

```json
{
  "permissions": {
    "defaultMode": "acceptEdits",
    "allow": ["Bash(pnpm test)", "Bash(pnpm test *)"],
    "deny": ["WebFetch", "WebSearch"]
  },
  "sandbox": {
    "enabled": true,
    "allowUnsandboxedCommands": false,
    "network": { "allowedDomains": [] }
  }
}
```

`network: true` 时 `allowedDomains` 的写法在实现时实测确定。

- 环境变量：`process.env` 去掉 `MOQI_` 开头的，再加上 `~/.claude/settings.json` 的 `env`（只读这一段，不写日志）。
- 结果：解析输出 JSON 的 `result`、`is_error`。

### 5.4 Kiro 适配器

- 写 `<工作区>/.kiro/agents/moqi-task.json`：

```json
{
  "name": "moqi-task",
  "description": "A task moqi handed over: this worktree only, the listed commands only",
  "prompt": "You work only inside the current directory, a git worktree moqi made for this task.",
  "tools": ["read", "write", "shell"],
  "excludedTools": ["web"],
  "mcpServers": {},
  "includeMcpJson": false,
  "includePowers": false,
  "permissions": {
    "rules": [
      { "capability": "fs_read", "match": ["./**"], "effect": "allow" },
      { "capability": "fs_write", "match": ["./**"], "effect": "allow" },
      { "capability": "shell", "match": ["pnpm test", "pnpm test *"], "effect": "allow" },
      { "capability": "shell", "match": ["*"], "exclude": ["pnpm test", "pnpm test *"], "effect": "deny" },
      { "capability": "web_fetch", "effect": "deny" },
      { "capability": "web_search", "effect": "deny" },
      { "capability": "mcp", "effect": "deny" }
    ]
  }
}
```

- 命令：`kiro-cli chat --v3 --no-interactive --agent moqi-task --output-format stream-json <话>`，`cwd` 为工作区，不加任何 `--trust` 参数；能断网时加 `--sandbox`（实现时实测）。
- 结果：从 stream-json 里取最后的回答文字；出现 `type: "runError"` 或退出码非 0 算失败。
- 跑完先删掉这个 agent 文件。

### 5.5 超时和停止

- 子进程单独成组（`detached`），超时或"停下"时杀掉整个进程组。
- 停下或超时后照常提交已有改动，原因分别写 `你让它停下了`、`超过 N 分钟，停下了`。

## 6. 跑完以后

### 6.1 提交

- `git -C <工作区> add -A`，有改动就 `commit -m "moqi: <任务第一行，最多 72 字>" -m "由 <agent> 完成，moqi 代为提交"`；仓库没有 git 身份时用 `-c user.name=moqi -c user.email=moqi@localhost`。
- 记下 `git diff --stat <base>..<分支>` 和改动文件列表。

### 6.2 事件和提议

- 事件：`code.started { task }`、`code.finished { taskId, ok, summary, files, stat, error? }`、`code.merged { taskId }`、`code.discarded { taskId }`。`State.codeTasks` 折叠出每个任务的状态。
- 提议 `code.done`：
  - 标题：`Kiro 做完了：<任务前 30 字>`、`Kiro 做完了，没有改动：…` 或 `Kiro 没做完：…`。
  - 正文：agent 的说明（前 600 字）、`改了 N 个文件：a、b、c…`、`在分支 moqi/…`。
  - `value: 0.8`，`urgency: "today"`，动作 `code_merge {id}`（没有改动时不带动作）。
- 控制台对 `code.done` 卡片特殊处理：`合并`（接受）、`看改动`（展开 `GET /api/code/diff?id=`，最多 100 KB）、`丢弃`（两步确认，`POST /api/code/discard`，同时给提议记"拒绝"）、`先留着`（不动）。
- 动态顶部列出正在跑的任务：agent、项目、任务、已跑多久、`停下`（`POST /api/code/stop`）。

### 6.3 合并（`code_merge`，隐藏工具，`danger: true`）

- 确认详情列出：合并到项目当前的分支名、改动统计。
- 项目目录有未提交的已跟踪改动（`git status --porcelain --untracked-files=no` 非空）就拒绝：`你的目录里有没提交的改动，先提交或暂存再合并`。
- `git merge --no-ff --no-edit <分支>`；失败就 `git merge --abort`，返回 `有冲突，没有合并；分支 <分支> 还在，可以自己合并`。
- 成功后 `git worktree remove <目录>`、`git branch -d <分支>`，记 `code.merged`。

### 6.4 丢弃（`code_discard`，隐藏工具，写、走信任阶梯）

- `git worktree remove --force <目录>`、`git branch -D <分支>`，记 `code.discarded`。控制台按钮调用时已经两步确认，所以以 `preApproved` 调用。

### 6.5 重启

- moqi 启动时，`code.started` 之后没有 `code.finished` 的任务，记 `code.finished { ok: false, error: "moqi 重启了，任务中断" }` 并发提议；工作区保留。

### 6.6 越用越懂

- `code.done` 的接受（合并）和拒绝（丢弃）和其他提议一样进入复盘；总结出的经验在下次交任务时按 4.1 的规则传过去。

## 7. 设置页

- "能力包"里加"编程 agent"：找到的 agent 和状态（Kiro、Claude Code：已找到 / 没找到；Cursor：暂不支持）；项目列表（路径、默认 agent、命令、能否联网，可增删）；超时。
- `GET /api/code/agents` 返回 `{ kiro: boolean, claude: boolean }`；项目随"保存"写入配置。

## 8. 出错处理

| 情况                            | 结果                                   |
| ------------------------------- | -------------------------------------- |
| 建工作区失败、agent 找不到      | 工具返回原因，不建任务                 |
| agent 退出码非 0 或结果标着出错 | 记失败，提议"没做完：原因"，工作区保留 |
| 超时、停下                      | 杀进程组，照常提交已有改动             |
| 没有改动                        | "做完了，没有改动"，只能丢弃           |
| 合并时有未提交改动、有冲突      | 不合并，分支保留                       |

## 9. 测试

- `test/code.test.ts`：临时 git 仓库，替身 agent（写文件、返回结果）。覆盖：确认详情（命令、网络、偏好）；偏好关键词筛选；建工作区和分支；提交和提议；合并成功并清理；丢弃；有未提交改动时拒绝合并；冲突时撤销；超时；重启标记中断；同一项目只能跑一个。
- 适配器：Claude 的参数和 `--settings`、Kiro 的 agent 文件，逐字对比。
- `test/console.test.ts`：`/api/code/discard`、`/api/code/diff`、`/api/code/stop`、`/api/code/agents`，项目路径校验。
- 真机：用 Kiro 在临时仓库跑小任务，确认能改工作区文件、列出的命令能跑、没列出的命令被拒、写工作区外被拒、联网命令失败。Claude Code 等登录修好后同样测。实测不通过的项在设置页和 README 里写明。
- 完成标准：`pnpm check` 全部通过。

## 10. 文档

- README（中英文）"能力包"表加"编程 agent"一行；"设计取舍"加一行：任务在单独的分支和工作区里做，点"合并"才回到你的目录。
- `docs/design.md` 第 4 节"操作电脑"后加"编程 agent"小节。
- `CHANGELOG.md` 加一条。

## 11. 不做

- 不接未经实测的命令行。
- 不在项目目录里直接改。
- 不自动合并；合并只由用户点。
- 不在任务里开放 MCP 服务器和联网查资料的工具。

## 12. 补充：实现和实测之后（2026-11-23）

- Kiro 用 `--output-format text`：stdout 只有回答文字，日志在 stderr，比解析 stream-json 简单可靠。
- 真机实测 Kiro（临时仓库，任务让它改 README、跑 `node check.js`、再试 `ls ~` 和写 `/tmp`）：README 的改动只在工作区并提交到任务分支，`node check.js` 跑了，`ls ~` 和写 `/tmp` 都被 agent 文件里的 deny 规则拒绝，项目目录没变。
- Kiro 的 agent 文件只限制能跑哪些命令，不断开列出的命令的网络。`CodeRunner.offline(agent)`：Claude Code 为真，Kiro 为假；为假时确认框写"没有断网：Kiro 跑你列出的命令时能联网，没列出的命令一律被拒"，交给 agent 的话也不再说"命令连不上网"。
- Claude Code 当前登录返回 401，没有真机实测；`network: true` 时 `allowedDomains: ["*"]` 的写法未经验证。
- 隐藏的危险工具（`code_merge`）不出现在设置页的"会改动东西的工具"里，也不能在那里放开：它只在用户点"合并"时运行。
- 问题以英文字母或数字结尾时，"吗"前加一个空格。
- 审查后修的两处：moqi 自己跑的 git 命令（工作区里的提交、项目里的合并等）一律加 `-c core.hooksPath=/dev/null`，不跑任何 hook。否则仓库用相对路径的 `core.hooksPath`（如 husky）时，agent 在工作区写的 hook 会在 moqi 提交时在沙箱外运行（已复现）。代价是 moqi 合并时你项目的 hook 也不跑。Claude Code 改用 `--setting-sources ""`（实测可用），不读你的和仓库里的任何设置，`--settings` 里加 `disableAllHooks: true`；原来的 `project` 会读仓库自带的 `.claude/settings.json`，它的放行规则和 hook 能绕过"只跑列出的命令"。
- 没有改动的任务，提议不带动作；提议的 `about` 字段记着任务 id，控制台据此找到任务。
