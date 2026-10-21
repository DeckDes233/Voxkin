# MindCraft 源码审计（只读）

## 0. 审计对象与版本

| 项 | 值 |
| --- | --- |
| 上游仓库 | https://github.com/mindcraft-bots/mindcraft |
| 本地克隆路径 | `D:\AI-Workspace\Voxkin\work\reference\mindcraft` |
| 分支 | `develop` |
| HEAD commit | `f6a9556cf756e6bd88a75cc2fa0d5aed7599b101`（`f6a9556`） |
| 提交时间 | 2026-10-02 23:28:06 -0700 |
| 提交标题 | `Merge pull request #756 from masterpatrickpl-coder/patch-1` |
| `git describe` | `v0.1.3-130-gf6a9556` |
| 历史长度 | 1671 commits |

克隆说明（事实）：本机 git 全局配置含 `url.https://git.espressif.com.cn/.insteadOf=https://github.com/`，该镜像不托管本仓库（返回 `remote: Not found`）。克隆使用 `https://github.com:443/mindcraft-bots/mindcraft.git`（该写法不匹配重写前缀）。未执行 git 写操作，未修改全局配置，仓库内文件未改动。

路径约定：以下 `文件:行号` 均相对于仓库根目录。

## 1. 结论速览

| # | 问题 | 结论 | 核心证据 |
| --- | --- | --- | --- |
| 1 | Bot 生命周期 | 主进程 MindServer + 每 bot 一个子进程；连接用 mineflayer；重连等于子进程被父进程重启 | `src/mindcraft/mindcraft.js:60-61`、`src/process/agent_process.js:32-52` |
| 2 | 玩家聊天→LLM | mineflayer `chat`/`whisper` 事件 → `respondFunc`（调用处未 await）→ `handleMessage` → `promptConvo` → `chat_model.sendRequest` | `src/agent/agent.js:173`、`:320`、`src/models/prompter.js:229` |
| 3 | 上下文构造/裁剪 | 按条数裁剪 `max_messages`；超阈值时切出 5 条做一次 LLM 摘要写入 memory | `src/agent/history.js:21`、`:72-78` |
| 4 | 工具执行/回填 | 正则解析 `!cmd(args)`，`command.perform` 的返回作为 system 消息写回 history | `src/agent/commands/index.js:226`、`src/agent/agent.js:362-368` |
| 5 | 长任务中新消息 | 没有串行队列、没有全局锁；新消息可并发进入；仅在命令层用单槽 `executing` 抢占 | `src/agent/agent.js:173`、`src/agent/action_manager.js:4`、`:87-90` |
| 6 | 取消/中断 | 协作式中断 `bot.interrupt_code`；全仓无 AbortController，LLM 请求不可取消 | `src/agent/agent.js:233-239`、`src/agent/action_manager.js:26-37` |
| 7 | LLM 请求 | 多种 provider 适配器；baseURL 可配置；全部以完整字符串为结果（两处传输层流式但立即累积）；未设置请求超时 | `src/models/gpt.js:38-55`、`src/models/ollama.js:26-31` |
| 8 | 完整回复才进 TTS | 结构性限制：整条管线以完整字符串为唯一数据形态，`speak` 在 `routeResponse`→`openChat` 末端调用 | `src/agent/agent.js:320`、`:374`、`:405-425` |
| 9 | 对外接口 | 只有 Socket.IO，没有 REST 或 HTTP POST；`send-message` 是唯一文本注入入口 | `src/mindcraft/mindserver.js:258-268` |
| 10 | 语音 | 有 TTS（OpenAI/Gemini/系统语音），无任何 STT | `src/agent/speak.js:11-27`、`:85-99` |

## 2. Bot 生命周期

### 2.1 进程与启动

- 主进程为每个 profile 创建 `AgentProcess` 并启动子进程：`src/mindcraft/mindcraft.js:60-61`。
- 子进程实际由 `spawn(process.execPath, [init_agent.js, ...])` 拉起：`src/process/agent_process.js:13-29`。
- 子进程入口：连接 MindServer、`new Agent()`、`agent.start(...)`：`src/process/init_agent.js:40-47`。
- `Agent` 构造时创建 mineflayer 实例：`this.bot = initBot(this.name)`，`src/agent/agent.js:66`；`initBot` 定义见 `src/utils/mcdata.js:55`。

### 2.2 连接与加入世界

| 阶段 | 实现 | 位置 |
| --- | --- | --- |
| 建立连接 | `initBot(name)` 封装 `mineflayer.createBot` | `src/agent/agent.js:66`、`src/utils/mcdata.js:55` |
| 断线处理 | `onDisconnect` 调用 `handleDisconnection` 后 `process.exit(1)` | `src/agent/agent.js:69-78` |
| 绑定断线事件 | `kicked` / `end` 直接退出；`error` 仅在 Duplicate/ECONNREFUSED 时退出 | `src/agent/agent.js:81-89` |
| 登录 | `login` 事件向 MindServer 登录并设置皮肤 | `src/agent/agent.js:93-102` |
| 进入世界 | `spawn` 事件：初始化 vision、事件处理器、任务目标，10 秒后检查玩家 | `src/agent/agent.js:109-144` |
| 初始消息 | 有 `init_message` 时调用 `handleMessage('system', init_message, 2)` | `src/agent/agent.js:213-214` |
| 玩家消息 | `whisper` 与 `chat` 都绑定 `respondFunc` | `src/agent/agent.js:180-188` |

### 2.3 重连

- 子进程的 `exit` 事件里重启：`src/process/agent_process.js:32-52`。
- 重启条件：退出码非 0、信号不是 SIGINT、且该进程已运行至少 10 秒（`Date.now() - last_restart < 10000` 时不重启）：`src/process/agent_process.js:42-49`。
- 退出码大于 1 时父进程随之退出，不再重启：`src/process/agent_process.js:37-40`。
- 结论：重连的粒度是整个 bot 子进程，不涉及 mineflayer 连接级重连。

### 2.4 退出

- `cleanKill()` 直接 `process.exit(0)`：`src/agent/agent.js:531-536`；触发点包括 `spawn` 超时（`src/agent/agent.js:104-108`）与 `!restart`（`src/agent/commands/actions.js:77-82`）。
- 单个 agent 停止：向子进程发 `SIGINT`（`src/process/agent_process.js:61-64`）。
- 主进程退出：对所有子进程调用 `stop()`，2 秒后 `process.exit(0)`：`src/mindcraft/mindcraft.js:103-110`。

## 3. 玩家聊天消息 → LLM 的完整调用链

1. mineflayer `chat` 事件回调：`src/agent/agent.js:184-188`，先按 `only_chat_with` 过滤（`:160`）、按 `ignore_messages` 过滤（`:162`），调用 `handleEnglishTranslation`（`:172`，实现见 `src/utils/translator.js:19-30`）。
2. `this.handleMessage(username, translation)`：`src/agent/agent.js:173`。**调用处没有 await**，说明消息处理是 fire-and-forget。
3. `handleMessage` 是整个回合的入口：`src/agent/agent.js:254-382`。
   - 冷却校验：`this.checkCooldown()`（`:272`），实现为 3 秒全局冷却 `src/models/prompter.js:206-212`，默认值见 `profiles/defaults/_default.json:2`。
   - 触发打断标记 `this.bot.interrupt_code = true; this.bot.clearControlStates();`（`:273-274`）。
   - 输出被 `<`,`>` 截断（`:275`），`silent` 消息直接丢弃（`:276-281`）。
   - 行为日志与 summary（`:282-290`）。
   - `await this.history.add('user', msg)`（`:296`、`:312`）。
   - **核心等待**：`await this.prompter.promptConvo(this.convo});`（`:320`）。
   - 空回复则 break（`:324-327`）。
   - 历史写入 assistant 回复（`:329-333`）。
4. `promptConvo`：`src/models/prompter.js:214-262`。
   - 最多 3 次尝试（`:218`）。
   - 先 `chat_model.sendRequest(...)` 生成摘要（`:220-222`）。
   - 拼接 system prompt 与 history（`:229`）。
   - 再次 `sendRequest` 拿正式回复（`:229`）。
   - 只有本次调用仍是最新消息时才返回，否则返回空串（`:248-251`）。
5. 有四条消息注入路径都汇聚到 `handleMessage`：
   - 真实玩家聊天：`src/agent/agent.js:173`。
   - 会话（bot 之间）消息：`src/agent/conversation.js:340`。
   - 自主模式：`src/agent/modes.js:327`（不 await）。
   - 自我提示：`src/agent/self_prompter.js:68`（await）。

## 4. 上下文构造与裁剪

- History 只保存 role/content 两种字段的 turns：`src/agent/history.js:15`、`:70`；上限取 `settings.max_messages`：`:21`。
- 每次 `add` 后若 `turns.length >= max_messages`：切出最早 5 条（`summary_chunk_size`）：`:24`、`:72-73`，再把紧随其后的 assistant 消息一并切走，保证分块以 user/system 开头：`:74-75`。
- 切出的分块交给 `promptMemSaving` 做一次 LLM 摘要写入 memory，摘要超过 500 字会被截断：`src/agent/history.js:77`、`:33-43`；同一分块追加到完整历史文件：`:78`、`:45-59`。
- memory 与 turns 持久化到 `bots/<name>/memory.json`：`:82-98`；启动时读回：`:100-115`。
- 上下文组装：agent 取 `getHistory()`（`:29-31`）后传给 `promptConvo`（`src/agent/agent.js:319-320`），`promptConvo` 通过 `replaceStrings` 把 history 注入 profile 模板再发请求（`src/models/prompter.js:224-229`）。
- 直接后果：每次请求的 prompt 长度与 `max_messages` 成正比；每累计 5 条消息额外触发一次摘要 LLM 调用。

## 5. 工具/命令执行与结果回填

- 命令清单：`src/agent/commands/index.js:7-11` 合并 `actionsList`（`actions.js`，41 个 `!` 命令）与 `queryList`（`queries.js`）。
- 识别：`containsCommand` 用正则 `src/agent/commands/index.js:29`、`:32-37`。
- 解析：`parseCommandMessage` 解析 `!cmd(args)` 形式的参数：`src/agent/commands/index.js:97-174`。
- 文档注入：`getCommandDocs` 把全部可用命令文档拼进 prompt，`relevant_docs_count` 只影响 `$CODE_DOCS` 技能文档：`src/agent/commands/index.js:246-257`。
- 执行：`executeCommand` → `command.perform(agent, ...)`：`src/agent/commands/index.js:212-230`（`perform` 在 `:226`）。
- 回填：`await command.executeCommand(...)`（`src/agent/agent.js:362`），结果封装为 system 消息 `await this.history.add('system', 'Command output: ...')`（`:367-368`）。
- 代码类命令 `!newAction` 会额外走代码生成：`src/agent/commands/actions.js:28-52`；代码生成内部还有 5 次尝试（`src/agent/coder.js:38-39`、`:43-47`），并检查中断标记（`:44`、`:48`）。

## 6. 长任务期间的新消息处理、串行队列与阻塞

### 6.1 没有串行队列，也没有全局锁

- 消息入口 `respondFunc` 未 await `handleMessage`（`src/agent/agent.js:173`；socket 侧同样未 await，`src/agent/mindserver_proxy.js:64-70`）。
- 全仓搜索 `AbortController`、`abortSignal` 无结果；没有 mutex/semaphore。
- 因此“普通聊天被建造任务阻塞”的机制不是队列，而是回合内部的串行等待。

### 6.2 实际存在的串行化/互斥点

| 机制 | 作用域 | 位置 |
| --- | --- | --- |
| `ActionManager.executing` 单槽 | 同一时间只允许一个命令执行 | `src/agent/action_manager.js:4`、`:95`、`:108` |
| `Prompt.awaiting_coding` | 代码生成期间阻止再次进入 `promptCoding` | `src/models/prompter.js:265-269` |
| `checkCooldown` 3 秒 | 同一 prompter 实例上的全局最小间隔 | `src/models/prompter.js:206-212`、`profiles/defaults/_default.json:2` |
| `speak.isSpeaking` / `speakingQueue` | TTS 播放串行 | `src/agent/speak.js:8-9` |
| `Conversation.in_queue` | 只用于 bot 之间的会话消息 | `src/agent/conversation.js:15` |

### 6.3 回合内的阻塞点

- `await promptConvo`：在 LLM 完整生成前不返回（`src/agent/agent.js:320`）。
- `await this.history.add(...)`：可能先触发一次摘要 LLM 调用（`src/agent/history.js:72-78` → `src/models/prompter.js:280-291`）。
- `await command.executeCommand`：命令执行全程在回合内（`src/agent/agent.js:362`）；`!collectBlocks` 上限 10 分钟（`src/agent/commands/actions.js:256-265`），`!followPlayer` 是无限循环（`src/agent/library/skills.js:1353`），`!stay` 同理（`:1492`）。
- `ActionManager._executeAction` 内部 `await actionFn()`：`src/agent/action_manager.js:105`，超时由 `_startTimeout` 控制（`:168-175`）。
- `Mineflayer` 层面没有逐个动作的 await：`src/agent/library/skills.js` 多数循环是“发出即继续”，例如 `:1029`、`:1056`。

### 6.4 新消息在两种时机到达的后果

**时机 A：上一回合正在等 LLM 返回。**
新消息进入 `handleMessage` 后再次调用 `promptConvo`，`most_recent_msg_time` 被更新为该新消息（`src/models/prompter.js:215-216`、`:219`）；上一回合在 `promptConvo` 返回处的校验（`:248-251`）发现不匹配，返回空串，上一回合在 `:324-327` 直接 break。结果是旧回合被丢弃，新回合继续，没有报错、没有排队。

**时机 B：上一回合正在执行命令。**
新消息会得到一次完整 LLM 回合；若其回复包含命令，`ActionManager._executeAction` 先 `await this.stop()`（`src/agent/action_manager.js:90`），`stop()` 设置 `bot.interrupt_code = true`（`src/agent/agent.js:233-239`），最多等 10 秒（`src/agent/action_manager.js:28-30`），仍未停则 `bot.cleanKill()`（`:29`）。

以上均为源码阅读得出的调用路径；实际交错结果需要运行时观测，见第 12 节。

## 7. 任务取消/中断；conversation 是否可打断

- 动作取消：`bot.interrupt_code` 标志（`src/agent/agent.js:233-239`），`!stop`（`src/agent/commands/actions.js:54-66`），`ActionManager.stop()` 的 10 秒轮询与强杀（`src/agent/action_manager.js:26-37`），中断时代码执行直接返回空串（`:152-166`，`:154`）。
- LLM 请求不可取消：没有 AbortController/Signal，`promptConvo` 只能靠返回后丢弃结果来“打断”（`src/models/prompter.js:248-251`）。
- 会话层：`forceEndCurrentConversation` 通过向对方发送 `!endConversation` 并本地结束来收尾：`src/agent/conversation.js:249-255`；`!stfu` 调 `shutUp()` 结束全部会话（`src/agent/agent.js:246-252`、`src/agent/conversation.js:240-247`）；`!endConversation` 定义见 `src/agent/commands/actions.js:424`。
- 结论：动作可以协作式中断；正在生成的 LLM 回复不能中断，只能等待并丢弃；因此实时语音场景下的“打断”无法由上游保证。

## 8. LLM 请求：provider、base URL、流式、首 token、超时重试

### 8.1 provider 与模型选择

- `_model_map.js` 按模型名前缀选择适配器：`src/models/_model_map.js:10-31`；`selectAPI` 依据 `api` 字段或模型名：`:33-76`；其后按 `prompt`/`speak_model` 分别构造：`:78-89`。
- 适配器覆盖 OpenAI、Anthropic、Google、Ollama、vLLM、LM Studio、OpenRouter、Replicate、HuggingFace、Groq、Cerebras、Hyperbolic、Novita、Mercury、DeepSeek、Qwen、Grok、Mistral 等；TTS 模型分派见 `src/models/prompter.js:59-60`。

### 8.2 base URL

| 适配器 | 可配置字段 | 位置 |
| --- | --- | --- |
| OpenAI 通用 | `model.url` | `src/models/gpt.js:13-14` |
| Anthropic | `model.url` | `src/models/claude.js:12-13` |
| DeepSeek | `model.url` 默认 `https://api.deepseek.com` | `src/models/deepseek.js:13` |
| Ollama | `model.url` | `src/models/ollama.js:8` |
| OpenRouter | 常量覆盖 | `src/models/openrouter.js:11` |
| Qwen | 默认 DashScope 兼容地址 | `src/models/qwen.js:12` |
| vLLM / LM Studio / Grok / Mistral / Mercury / Novita | 各有默认常量或 `model.url` | `src/models/vllm.js:18`、`src/models/lmstudio.js:10`、`src/models/grok.js:16`、`src/models/mercury.js:14`、`src/models/novita.js:10` |

### 8.3 是否流式

- 全部适配器把结果聚合成一个完整字符串返回，调用方拿不到增量 token。
- 明确非流式：`src/models/cerebras.js:24`、`src/models/groq.js:54`、`src/models/hyperbolic.js:35`、`src/models/ollama.js:29`。
- 传输层流式但立即累积：`src/models/replicate.js:66-74`（`for await (const event of replicate.stream(...))` 拼进 `full_response`），`src/models/huggingface.js:40-46`（`chatCompletionStream` 同样拼完再返回）。
- OpenAI 系调用用的是非流式 `create`：`src/models/gpt.js:50`、`src/models/claude.js:33-38`、`src/models/deepseek.js:35-39`。

### 8.4 首 token 与完整回复

- 首 token 在仓库内不可观测：没有任何代码读取增量块。
- 完整回复是唯一的交接形态：`promptConvo` 在 `await sendRequest` 之后才 `routeResponse(res)`（`src/agent/agent.js:319-320`、`:372-376`）。

### 8.5 超时与重试

- 未对 LLM HTTP 请求设置超时；仅有的超时是 `spawn_timeout`（`src/agent/agent.js:104-108`）和代码执行 `code_timeout_mins`（`src/agent/action_manager.js:168-175`）。第三方 SDK 自身的默认超时不属本仓库配置（见第 12 节）。
- 重试：`promptConvo` 最多 3 次（`src/models/prompter.js:218`）；Ollama 5 次重试（`src/models/ollama.js:17-21`）；上下文超长时截断重试（`src/models/gpt.js:76-78`、`src/models/qwen.js:41-43`、`src/models/deepseek.js:42-44`）；Ollama 网络错误兜底（`src/models/ollama.js:38-40`）；Qwen 嵌入接口 429 退避（`src/models/qwen.js:56-77`）。

## 9. 为什么“完整回复”才送去 TTS；工具参数与口语文本在哪里分离

- 主回复路径：`handleMessage` 在 `await promptConvo` 之后调用 `routeResponse(res)`（`src/agent/agent.js:320`、`:372-376`）。
- `routeResponse` 遍历回复文本，命中命令则执行，否则 `openChat(res)`（`src/agent/agent.js:384-402`）。
- `openChat` 是唯一调用 `speak` 的地方：`src/agent/agent.js:423-425`。参数 `to_translate` 来自 `:405-413`：有命令时取命令之前的整段文本，没有命令时取整段回复。
- `speak(text)` 一次性把整段文本丢进播放队列并整段合成：`src/agent/speak.js:11-27`；远程 TTS 一次性请求整段（`src/models/gpt.js:138-141`、`src/models/gemini.js:124-137`）。
- 因此“等待完整回复才发声”是接口形态决定的：LLM 适配器的返回值是完整字符串，`routeResponse`/`openChat`/`speak` 的入参也都是完整字符串，整条链路没有增量文本入口。
- 工具参数与口语文本的分离方式是字符串截断，不是结构化字段：`src/agent/agent.js:407-413`（截出命令前的口语文本），`src/agent/commands/index.js:97-174`（用正则解析命令与参数）。history 里保存的是截断后的文本（`src/agent/agent.js:329-333`）。
- 附带影响：TTS 播放前会等待 `speak_model` 的语音配置（`src/agent/speak.js:76`），远程音频下载完成后才播放（`:29-55`、`:114-143`）。

## 10. 对外 HTTP/WebSocket 服务接口

### 10.1 HTTP 端点

- 服务器为 `express` + `http.Server` + Socket.IO：`src/mindcraft/mindserver.js:49-51`。
- 只注册了两条 HTTP 路由：静态目录 `express.static`（`:55`）与贴图代理 `GET /assets/item/:agent/:name.png`（`:58-114`）。
- 没有 `express.json()`，没有 REST 风格的 `POST` 业务接口；外部程序无法通过纯 HTTP 注入文本。
- 监听地址固定为 `localhost`：`:282-285`；`host_public` 分支只打印“暂不支持”（`:279-281`）。

### 10.2 Socket.IO 事件

| 事件 | 方向 | 用途 | 位置 |
| --- | --- | --- | --- |
| `connection` | 客户端 → 服务端 | 新连接，立即推送一次 `agents-status` | `src/mindcraft/mindserver.js:117-121` |
| `create-agent` | 客户端 → 服务端 | 按 settings 创建 agent | `:123-159` |
| `get-settings` | 子进程 → 服务端 | 请求配置 | `:161-167` |
| `connect-agent-process` | 子进程 → 服务端 | 注册 command socket | `:169-174` |
| `login-agent` | 子进程 → 服务端 | 标记已进入游戏并广播状态 | `:176-186` |
| `disconnect` | 客户端 → 服务端 | 清理在线状态与监听器 | `:188-198` |
| `chat-message` | 任意客户端 → 服务端 | bot 间消息，要求目标已登录 | `:200-207` |
| `set-agent-settings` | 客户端 → 服务端 | 更新配置并触发 `restart-agent` | `:209-215` |
| `restart-agent` / `stop-agent` / `start-agent` | 客户端 → 服务端 | 进程控制 | `:217-228` |
| `destroy-agent` / `stop-all-agents` / `shutdown` | 客户端 → 服务端 | 销毁、全部停止、退出 | `:230-256` |
| `send-message` | 客户端 → 服务端 | **文本注入入口**，转发给指定 agent | `:258-268` |
| `bot-output` | 子进程 → 服务端 | 广播输出 | `:270-272` |
| `listen-to-agents` | 客户端 → 服务端 | 开始接收状态推送 | `:274-276` |
| `agents-status` | 服务端 → 客户端 | 在线状态 | `:290-305` |
| `get-full-state` | 服务端 → 子进程 | 每个监听器每秒拉取一次完整状态 | `:308-332` |

### 10.3 外部注入协议

- 客户端 emit `send-message`，payload 为 `(agentName, { from, message })`，服务端要求该 agent 已注册：`src/mindcraft/mindserver.js:258-268`。
- 服务端把同名事件转发到该 agent 的 command socket：`:264`。
- 子进程收到后调用 `this.agent.respondFunc(data.from, data.message)`：`src/agent/mindserver_proxy.js:64-70`。
- `respondFunc` 最终调用 `handleMessage(from, message)`：`src/agent/agent.js:157-173`。
- 限制：`only_chat_with` 为空时接受任意 `from`（`src/agent/agent.js:160`）；`from` 只是普通字符串，UI 固定传 `'ADMIN'`（`src/mindcraft/public/index.html:1083-1090`）。
- 子进程与服务的握手：`connect` 后请求 `get-settings`，成功后 emit `connect-agent-process`，登录游戏后再 emit `login-agent`：`src/agent/mindserver_proxy.js:83-97`、`:112-114`。

## 11. 语音：TTS/STT

- TTS：`speak(text)` 决定 provider（`src/agent/speak.js:11-27`）。`openai` 走 `/audio/speech`（`src/models/gpt.js:119-142`），`google` 走 Gemini TTS（`src/models/gemini.js:121-150`），`system` 在 Windows 用 PowerShell `System.Speech`、macOS 用 `say`、Linux 用 `espeak`（`src/agent/speak.js:85-99`）。播放统一调用 `ffplay`（`:114-143`）。
- 语音模型名称从 profile 的 `speak_model` 读取，默认值见 `profiles/defaults/_default.json:14`；README 说明语音合成当前仅支持 `openai` 与 `google` 两种模型字符串（`README.md:217`）。
- STT：没有实现。全仓搜索 `stt`、`microphone`、`whisper` 无相关代码；输入只有 mineflayer 聊天事件（`src/agent/agent.js:182-188`）与 `send-message`（第 10 节）。

## 12. 推测待验证

以下内容来自代码推断，尚未运行验证：

1. 两条消息几乎同时到达时，两个 `handleMessage` 并发执行，`promptConvo` 的 `most_recent_msg_time` 校验会让先到者被丢弃（`src/models/prompter.js:248-251`），后到者照常回复。真实交错结果与丢弃比例需要运行时埋点。
2. 新命令触发 `ActionManager.stop()` 后，实际动作能否在 10 秒内停止，取决于具体 mineflayer 动作实现（`src/agent/action_manager.js:28-36`）。
3. 第三方 SDK（OpenAI/Anthropic）的默认网络超时可能长达数分钟；仓库未覆盖该配置。
4. 在 profile 的 `params` 里传 `stream: true` 会破坏 `completion.choices[0].message.content` 的解析（`src/models/gpt.js:54`），因为调用方假定非流式响应；`params` 的透传能力见 `README.md:205`。
5. TTS 端到端首音延迟由“完整生成 + 整段合成 + 写临时文件/启动 ffplay”组成，具体数值未测。

## 13. 明确“未发现”的实现

- 没有 LLM 增量 token 消费；没有 `AbortController`/`abortSignal`。
- 没有 STT、麦克风采集或语音输入。
- 没有面向业务的 HTTP POST/REST 接口。
- 没有消息队列或全局锁；只有第 6.2 节列出的单槽标志。
- 没有针对玩家消息的优先级或抢占队列。

## 14. 复现命令

```powershell
git clone --depth 1 --branch develop https://github.com:443/mindcraft-bots/mindcraft.git work\reference\mindcraft
git -C work\reference\mindcraft log -1 --format="%H %ad %s"
git -C work\reference\mindcraft describe --tags --always
```
