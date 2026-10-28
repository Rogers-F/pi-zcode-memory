# ZCode 记忆（PI-Desktop 插件）

把 ZCode 3.16.x 的长期记忆完整搬到 PI-Desktop：记忆规则与 `MEMORY.md` 索引注入、回合结束后的后台自动提取、语义召回、Dream 整理、自定义代理持久记忆，外加一个只读的管理面板。另加 4 项有出处、可独立开关的改进（E1–E4）。

- 插件 id：`local.pi-zcode-memory`
- 数据目录：`~/.pi-desktop/zcode-memory`（不与 DSH 的 `~/.dsh/zcode-memory` 共用）
- 运行时只用 Node 内置模块；不申请任何 `net.*` 权限
- 上游行为逐行对照（含宿主源码证据）见 [docs/对齐矩阵.md](docs/对齐矩阵.md)，改进出处见 [docs/改进依据.md](docs/改进依据.md)

## 安装

两种方式用的是同一个插件 id，只用其中一种。

**方式一：加载本地插件（推荐自测，改文件后自动重载）**

1. 在 PI-Desktop 左侧导航进入「扩展」页，点「加载本地插件」（新手引导里叫「加载开发插件」）。
2. 选择本目录 `1-pi-zcode-memory`（含 `manifest.json` 的那一层）。
3. 弹出「加载 ZCode 记忆？」，列出 `ui.panel`、`agent.extension`、`agent.complete`、`models.list` 四项权限，其中 `agent.extension`、`agent.complete` 是高风险权限。点「加载插件」后四项全部授予；插件需要这四项才能工作。
4. 之后改本目录里的文件会自动重载（宿主忽略 `node_modules`、`.git`、`dist`）；只有 `manifest.json` 增加权限时才需要重新确认。

**方式二：安装插件包**

1. 在本目录执行 `npm run pack`，得到 `dist/local.pi-zcode-memory-0.1.0.piplug`。包是不压缩的 ZIP：宿主安装器只收这种格式，压缩过的包会报 `PLUGIN_INVALID: only store-compressed piplug supported`。
2. 在「扩展」页点「安装插件包」，选中该文件，提示「插件包已安装」即完成。这一步没有权限确认框，声明的四项权限在安装时全部授予。

安装完成后打开命令面板执行「ZCode 记忆：打开管理面板」，或直接打开同名的面板。设置改动对**新会话**生效（与 ZCode 一样按会话冻结）；只有「后台模型」改了立即生效。

## 默认值与开关

| 设置 | 默认 | 说明 |
| --- | --- | --- |
| 自动提取记忆 `autoExtract` | 开 | 回合成功结束后在后台提取记忆 |
| 语义召回 `semanticRecall` | 关 | 关：每次请求带上 `MEMORY.md` 索引；开：按问题挑选记忆正文，在工具批次后附加 |
| 自动整理 `autoDream` | 关 | 满足上游门槛时后台合并重复记忆；手动 Dream 始终可用 |
| 严格上游模式 `strictUpstream` | 关 | 一键关闭 E1–E4，行为与 ZCode 3.16.x 一致 |
| E1 中文门槛 `improveE1` | 开 | 中日韩文本按 Unicode 词边界计数 |
| E2 召回混合排序 `improveE2` | 开 | BM25 + 修改时间 RRF 融合 |
| E3 预载相似记忆 `improveE3` | 开 | 提取前把最相似的记忆正文放进上下文 |
| E4 先归档 `improveE4` | 开 | 改写或删除前存进 `archive/` |
| 后台模型 `backgroundModel` | 空 | 空则用会话模型；可填 `providerId/modelId` |
| 代理记忆作用域 `agentMemoryScopes` | `{}` | JSON 文本，如 `{"reviewer":"project"}` |
| Task 注入代理记忆 `taskRewrite` | 开 | 委派已配置的代理时把记忆提示追到任务文本（PI-Desktop 0.21.0 上不生效，见下文） |

## 记忆怎样进入对话

- **规则与索引**：每次向模型发请求时，插件在消息最前面放一条「请求前缀」：第一段是 ZCode 的记忆规则原文，第二段是 `MEMORY.md` 索引（与 ZCode 同一个位置、同一套 `# agentsMd` / `<system-reminder>` 包装）。前缀只用于当次请求，不写进会话记录。
- **为什么不改系统提示**：PI-Desktop 0.21.0 里扩展改的系统提示保不住——每次 Read / Write / Edit 执行前宿主会重组系统提示，把扩展加的内容撤掉，而且每次改动都会再追加一份完整的系统提示记录（源码位置见对齐矩阵 H1）。请求前缀没有这两个问题。
- **索引每会话读一次**：会话里第一次请求时读入，之后改文件、压缩都不重读；新会话读到最新内容（与 ZCode 一致）。
- **没有打开项目的会话**：宿主把这种会话的工作目录放在会话临时目录里，插件视为没有工作区，不注入也不提取。

## 权限与安全

- **数据存在本机**：记忆文件、转录、归档都在 `~/.pi-desktop/zcode-memory`；项目作用域的代理记忆写在项目里的 `.pi/zcode-memory`。插件主进程用 Node 的 `fs` 直接读写这些文件（与面板的只读预览同一套路径校验）。
- **会发出去的内容**：记忆规则与 `MEMORY.md` 索引随每次请求发给当前会话的模型；执行提取、召回或 Dream 时，会话对话文本、记忆清单与相关记忆正文会发送到你在 PI-Desktop 里选定的模型提供商（后台调用走宿主 `pi.agent.complete`）。这是记忆功能本身的代价。
- **不发出去的内容**：插件不申请 `net.*`，不声明 `manifest.net`，运行时没有任何外部包与网络请求；`npm run check` 会核对这一点。
- **后台调用上限**：宿主限制每 60 秒 8 次、单次 90 秒、系统提示 32 KiB、消息 200 000 字符、只返回文本、不能设置输出上限。插件在本地按同一窗口排队（召回优先于提取，提取优先于 Dream），仍被宿主限流时退避重试，不丢弃、不报失败。
- **面板安全**：只读渲染，全部走 `textContent`，CSP 为 `default-src 'none'`；拒绝符号链接、路径穿越、大小写别名；单文件上限 5 MiB；不加载远程资源、不执行脚本。
- **归档可恢复**：改写或删除前把旧内容放进 `archive/<projectKey>/`，使用 FreeDesktop 回收站布局（`files/` + `info/*.trashinfo`），面板可以恢复或彻底删除。

## Token 开销

- **每次请求**：请求前缀 ≈ 2.1k 字符的记忆规则（语义召回分支 ≈ 1.9k）＋（默认分支）约 0.7k 字符的包装与 `MEMORY.md` 索引本身；索引超过 200 行或 25 000 字符会被截断并附警告。前缀在每次请求里位置相同，适合提供商的提示缓存。
- **提取**：每个触发的回合最多 5 次后台模型请求；系统提示 = 记忆规则 + ≈ 1.2k 字符的文本工具协议，消息 = 本会话到这一回合为止的对话文本（超过 200 000 字符从最早处丢）。没有值得保存的内容时模型只回复 `Nothing to save.`。
- **召回**：每个用户回合最多 1 次选择器调用（系统提示 ≈ 1.6k 字符 + 记忆清单 + 本会话之前的问答）；选中记忆正文按 200 行 / 4096 字节 / 每会话 61 440 字符的预算附加。
- **Dream**：手动或自动触发，最多 50 轮；自动模式另有 24 小时间隔与 10 分钟扫描节流，并且至少要 5 个其它会话的转录在上次整理后发生过变化。
- 默认三个后台开关中只有「自动提取」是开的；关掉它就没有提取调用。

## 自定义代理持久记忆（务必先读）

在设置里给代理名配置作用域（`user` / `project` / `local`）后，父会话用 `Task` 委派这个代理时，插件把 ZCode 的代理持久记忆提示和该代理的 `MEMORY.md` 追加到任务文本末尾。三种作用域各有独立目录：`~/.pi-desktop/zcode-memory/agent-memory/<代理>`、`<项目>/.pi/zcode-memory/agent-memory/<代理>`、`<项目>/.pi/zcode-memory/agent-memory-local/<代理>`。

1. **依赖宿主把同一个参数对象交给工具执行。** 插件只能在 `tool_call` 钩子里原地改 `input.task`；只有宿主把这个对象原样交给 `Task` 工具时改写才生效。PI-Desktop 0.21.0 不是这样：`resources/agent-runtime/chunks/runner-X4ZX2DU4.js` 的 `dispatch` 对 "result" 类事件（`tool_call:"result"`）先 `structuredClone` 再交给插件，`resources/agent-runtime/sidecar.js` 的 `extensionToolCall` 只认返回值里的 `block`。所以**在 0.21.0 上这项不会生效**。插件不伪造效果：它在 `tool_result` 里核对任务文本，面板状态栏会显示「Task 代理记忆 … 未生效」。测试里用把同一对象交给工具的假宿主验证改写本身。
2. **子代理不经过插件的其它钩子。** 委派的子代理由 `resources/agent-runtime/sidecar.js` 的 `var qn=class` 运行，它内部的 Agent 不挂 `transformContext` / `beforeToolCall`，所以子代理的请求里没有请求前缀、没有召回，它的回合也不会触发提取；代理记忆只能靠任务文本带进去。
3. **user 作用域的写入会触发宿主的权限确认。** user 作用域目录在工作区之外；子代理按提示去写它时，宿主的文件工具规则是「An explicit path outside the workspace and session scratch roots requires permission unless the effective mode is Auto」（`resources/agent-runtime/sidecar.js` 的 `buildToolDefinitions`），即除自动模式外都会弹权限确认。插件不绕过这道确认。

## 与 ZCode / DSH 的差异（含宿主限制）

| 项目 | ZCode 3.16.x | 本插件 | 原因（源码位置见对齐矩阵「宿主事实」） |
| --- | --- | --- | --- |
| 记忆规则 | 系统提示段 | 每次请求开头的请求前缀 | 扩展改的系统提示会被宿主撤掉（H1） |
| `MEMORY.md` 索引 | `context_prefix` 元用户消息 | 同位置、同文本 | — |
| 记忆代理的工具 | 原生工具调用 | 文本协议 `<tool_call name=…>{json}</tool_call>`，同一套权限规则 | 宿主 `agent.complete` 只返回文本（H6） |
| 提取看到的对话 | 分叉的主对话（含工具结果） | 插件转录：用户 / 助手文本 + 工具调用路径 | 插件拿不到会话上下文，`agent.complete` 只收纯文本 |
| 召回选择器输出 | 严格 JSON Schema；模型不支持就不召回 | Schema 写进系统提示；回复按同一规则校验（容忍代码围栏） | 宿主没有 `responseJsonSchema`（H6） |
| 后台模型调用 | 无固定窗口 | 每 60 秒 8 次、90 秒超时、只返回文本、不能设输出上限 | 宿主 `agent.complete` 的实现限制（H6） |
| 后台用哪个模型 | 产生该工作的回合的模型 | 同一个：设置覆盖 → 宿主 `session:modelChanged` → 会话 `ctx.model.id` 唯一匹配；找不到或有歧义就跳过并在面板说明 | 宿主只在用户改模型时广播模型键（H7） |
| 子代理 | 子代理也走记忆 | **子代理不经过插件钩子** | 宿主委派子代理不挂扩展钩子（H4） |
| 自定义代理记忆 | 注入子代理系统提示 | 追加到 `Task` 的任务文本末尾；**0.21.0 不生效** | 子代理没有钩子；`tool_call` 参数被克隆（H3） |
| 会话关闭 | 最多等 60 秒在途提取，然后取消 | 同上 | 扩展在 `session_shutdown` 留标记，主进程收尾（H5） |
| Dream | 在某个会话里跑，只提示该会话 | 主进程按项目跑，提示该项目所有开着的会话 | 插件的 Dream 不属于任何会话 |
| 项目作用域代理记忆路径 | `<workspace>/.zcode/agent-memory` | `<workspace>/.pi/zcode-memory/agent-memory` | 不占用 `.zcode`，避免与其它工具冲突 |
| 转录 | `model-io-<sessionId>.jsonl` | `transcripts/<projectKey>/<sessionId>.jsonl` | 宿主没有等价的 model-io 目录 |
| DSH 版 | — | 数据目录、设置、面板彼此独立 | 两个宿主互不共享 |

## 数据布局

```
~/.pi-desktop/zcode-memory/
  memories/projects/<slug>-<hash16>/memory/   # 每个工作区的记忆（MEMORY.md + 一事一文件）
  memories/projects/<slug>-<hash16>/project.json
  agent-memory/<agentKey>/                     # user 作用域
  transcripts/<projectKey>/<sessionId>.jsonl
  archive/<projectKey>/{files,info}/           # FreeDesktop 回收站布局
  state/
    settings.json            # 主进程 → 扩展：有效设置
    sessions/<id>.json       # 扩展 → 主进程：工作区、冻结的设置、会话模型
    turns/<id>.json          # 扩展 → 主进程：成功结束的回合
    recall/<id>.req.json     # 召回请求；<id>.res.json 为结果
    notices/<key>.json       # Dream 改动的一次性提示
    closed/<id>.json         # 会话已关闭
    status.json  task-rewrite.json  session-models.json  models.json
<workspace>/.pi/zcode-memory/
  agent-memory/<agentKey>/                     # project 作用域
  agent-memory-local/<agentKey>/               # local 作用域
```

## 卸载

1. 在 PI-Desktop 的「扩展」页禁用并卸载「ZCode 记忆」。
2. 需要一并删除记忆时，删除整个 `~/.pi-desktop/zcode-memory` 目录（PowerShell：`Remove-Item -Recurse -Force "$HOME\.pi-desktop\zcode-memory"`）。
3. 项目里如果用过代理记忆，删除项目下的 `.pi/zcode-memory` 目录。
4. 卸载后管理面板不再可用；记忆文件是普通 Markdown，删除前可以直接备份。

## 实机验收清单

- [ ] 加载本地插件（或安装插件包）后，面板能打开且显示「工作区 / 文件」两栏与开关；后台模型、代理作用域两个文本设置在宿主设置页。
- [ ] 在一个打开了项目的新会话里发「记住：发布前要跑冒烟测试」（不加空格）；回合结束后面板里出现对应 `.md`，`MEMORY.md` 多出一行。
- [ ] 另开新会话问「我的记忆索引里有哪些条目？」，模型能复述那一行；压缩一次后再问，仍能复述。
- [ ] 打开「语义召回」并新开会话，先让模型执行一次工具，再问一个需要旧记忆的问题：记忆正文只附加一次（面板状态栏「召回：完成」）。
- [ ] 面板点「立即整理（Dream）」，重复条目被合并；被改写 / 删除的旧内容出现在「归档」，能恢复。
- [ ] 在设置里填一个不存在的后台模型（如 `x/y`）：面板状态栏显示模型被跳过及原因；清空后恢复。
- [ ] 配置 `{"reviewer":"project"}` 后用 `Task` 委派 `reviewer`：面板显示「Task 代理记忆 reviewer：未生效」（0.21.0 的宿主限制，见上文）。
- [ ] 关掉「自动提取」并新开会话后，新回合不再产生后台模型调用（宿主用量里可见）。
- [ ] 打开「严格上游模式」后，E1–E4 四个开关变灰（行为回到上游）。
- [ ] 卸载后按需删除 `~/.pi-desktop/zcode-memory`，插件注册表里不再有 `local.pi-zcode-memory`。

## 开发

```powershell
npm install        # 开发依赖（jsdom、esbuild、marked、yaml），不进插件包
npm run check      # 清单 / 权限 / 运行时依赖 / 对齐矩阵测试名 / 打包规则
npm test           # 用 PI-Desktop 自带的 Node 24 跑全部测试
npm run eval       # 离线评估 E1–E4 与严格上游模式
npm run pack       # 生成 dist/local.pi-zcode-memory-<版本>.piplug（不压缩的 ZIP，宿主安装器只收这种）
```

`npm test` 由 `scripts/test.mjs` 启动：它找到 `PI-Desktop.exe`（也可用环境变量 `PI_DESKTOP_EXE` 指定），以 `ELECTRON_RUN_AS_NODE=1` 运行 `node --test`，把 HOME / USERPROFILE 指到一次性临时目录；输出里打印 Node 版本，要求失败、跳过、待办都是 0，并核对真实的 `~/.pi-desktop/zcode-memory` 在测试前后存在状态不变。测试只用假宿主与脚本化模型，不联网、不调用真实模型、不使用任何凭据。

`test/fixtures/upstream-prompts.json` 由 `node scripts/gen-upstream-fixtures.mjs <ZCode 的 apps/zcode-cli/packages/core/src>` 从上游源码生成。`npm run pack` 产出的包里不含 `node_modules`、`test/`、`scripts/`。

## 许可证

Apache-2.0。上游 ZCode 的署名、改动说明与逐文件 SHA-256 见 [NOTICE.md](NOTICE.md)，许可证全文见 [LICENSE](LICENSE)。
