# AI Chat Notification 🔔

> 当 AI 对话回复完成时，发送浏览器通知 —— 让你即使切换到其他标签页也能及时知道回复已就绪。

## 更新日志

### v1.1.12（按钮检测可用时关闭文本轮询，避免多步思考重复通知）

**用户反馈**："只监控按钮的变化可以吗，现在如果它有很多思考步骤之类的，就会导致通知好多次"

**根本原因**：

z.ai 在复杂问题上会进行多步思考（思考→输出→再思考→再输出），每一段文本稳定 1.5 秒后，文本轮询的防抖逻辑都会判定为"回复完成"并发送通知。即使有指纹去重，不同段落的文本指纹不同，仍然会发多次通知。

按钮检测（v1.1.10）已经是更可靠的主检测路径：z.ai 在整个 AI 运行期间（包括所有思考步骤）按钮都会消失，只在最终完成时才重新出现。所以按钮检测天然就是"一次运行=一次通知"。

**修复**：

- **按钮检测可用时关闭文本轮询**：`startObserving()` 中检查 `buttonDetection` 配置，如果有按钮检测就不再启动文本轮询。
- **文本轮询降级为兜底**：只在没有 `buttonDetection` 配置的站点才启用文本轮询。
- Z.AI（有 `buttonDetection`）：只监控按钮，一次运行只通知一次。
- 其他未配置按钮检测的站点：仍用文本轮询。

**影响范围**：仅影响有 `buttonDetection` 配置的站点（目前只有 Z.AI）。其他站点（ChatGPT、Claude 等）行为不变。

### v1.1.11（修复思考指示器误阻断通知）

**用户反馈**：F12 Console 日志显示 `[按钮监控] ⏭️ 检测到思考指示器仍在 DOM 中，思考阶段未结束，忽略按钮空闲信号`，然后 `状态: idle → idle` 重复 56 次，通知始终不发。

**根本原因**：

z.ai 的 `thinking-chain-container`（思考链容器）在 AI 回复完成后**仍然保留在 DOM 中**，作为可折叠的"Thought Process"面板供用户查看思考过程。

v1.1.9 引入的 `isThinkingNow()` 用 `[class*="thinking"]` 选择器匹配，会一直匹配到 `thinking-chain-container`，导致：

1. AI 完成 → 按钮重新出现且 disabled → 状态 `running → idle`
2. 触发完成检查 → `isThinkingNow()` 返回 `true`（`thinking-chain-container` 还在）
3. **跳过通知**，重置 `buttonRunningStartTime = 0`
4. 之后按钮一直是 idle，`idle → idle` 无状态转换，56 次空转
5. **通知永远发不出！**

**修复**：

1. **`checkButtonStateChange` 移除 `isThinkingNow()` 检查**：v1.1.10 已确认按钮"消失→重新出现且 disabled"是 z.ai 的可靠完成信号，不需要额外的思考指示器检查。
2. **`confirmCompletion` 移除 `isThinkingNow()` 检查**：同理，二次确认只检查按钮状态。
3. **`pollLatestAIText` 移除 `isThinkingNow()` 检查**：文本轮询的防抖机制（1.5s 文本稳定）+ 指纹去重足以避免误触发。
4. **`confirmCompletion` 移除 `if (!button) return`**：按钮在二次确认时恰好消失的边界场景也需要处理（`getState(null)` 会返回 `'running'`）。

**保留**：`isThinkingNow()` 方法本身保留（未来其他站点可能需要），`thinkingIndicators` 配置保留（不影响功能，只是不再在 z.ai 路径中使用）。

### v1.1.10（重大修正 —— 实测发现 z.ai 真实按钮机制，与之前假设完全不同）

**用户反馈**："思考时就发了通知" + 提供了完整 F12 Console 日志。

**根本原因定位**：

通过 `agent-browser` 实际访问 z.ai 发送消息，**实测发现 v1.1.7-v1.1.9 文档里描述的按钮机制是错的**！

| 状态 | 之前假设 | 真实情况 |
|---|---|---|
| 空闲（无输入） | 灰色箭头，disabled | ✅ 灰色箭头，disabled，class 含 `bg-[#E0E0E0]` |
| 输入未发送 | 黑色箭头，class 含 `bg-black` | ✅ 黑色箭头，class 含 **`bg-black/80`**（注意是 `/80`）|
| **AI 运行中** | 按钮变停止图标（黑色方块） | ❌ **整个 `#send-message-button` 从 DOM 卸载！按钮消失！** |
| 完成 | 按钮变回 disabled | ✅ 按钮重新出现，disabled=true |

**两个致命 bug**：

1. **`getState(null)` 返回 `'idle'`**：按钮消失时 `document.querySelector(buttonSelector)` 返回 `null`，`getState(null)` 之前的实现返回 `'idle'`（认为按钮不存在就是空闲），完全错过了"AI 开始运行"的关键信号。而且 `checkButtonStateChange` 里还有 `if (!button) return;` 提前退出，连检查都不做。

2. **`/bg-black/` 误匹配 `bg-black/80`**：兜底正则 `/bg-black|bg-neutral-50|bg-neutral-900/i` 会匹配到 `bg-black/80`，导致**用户输入消息未发送时**就被误判为"运行中"。然后用户一点发送，按钮变 disabled，从"误判的运行"→"idle"，立刻触发通知 —— **但 AI 才刚开始思考！** 这就是"思考时发通知"的根本原因。

**修复方案**：

1. **`getState(null)` 返回 `'running'`**：按钮消失视为 AI 运行中（z.ai 的真实机制）。
2. **移除 `checkButtonStateChange` 里的 `if (!button) return;`**：按钮消失时也要执行状态检查。
3. **删除 `/bg-black/` 兜底分支**：z.ai 输入未发送时的 `bg-black/80` 是合法的 idle 状态，不应被误判为 running。兜底分支现在默认返回 `'idle'`。
4. **observer 改为监听按钮父容器**：之前直接监听按钮本身，按钮被卸载后 observer 失去目标，再也无法检测到按钮重新出现。现在监听按钮的父容器，通过 childList 变化捕获按钮的"出现/消失"。
5. **新增按钮状态轮询兜底**：每 500ms 轮询一次按钮状态，防止 MutationObserver 漏检（某些站点的按钮可能在另一个独立子树中被替换）。
6. **保留 v1.1.9 的所有防护**：最小运行时长（800ms）、延迟二次确认（200ms）、思考指示器检测、三态识别（running/thinking/idle）—— 这些防护对其他站点依然有用。

**验证方法**：通过 `agent-browser` 实测 z.ai 完整对话流程，确认按钮在 AI 运行时确实消失、完成时重新出现。

### v1.1.9（修复"思考阶段误触发通知"问题）

**用户反馈**："AI 还在思考的时候就发了通知，根本没等回复真正出来。"

**根本原因分析**：

Z.AI 等平台的回复过程实际是**两段式**的：

1. **思考阶段**（thinking / reasoning）：模型在内部推理，UI 上显示"正在思考..."气泡，AI 消息元素已经插入到 DOM 但内容为空或只有思考摘要，发送按钮已变为"停止"图标
2. **正式回复阶段**：思考完成，开始流式输出正文
3. **完成**：按钮变回箭头/disabled

v1.1.7-1.1.8 的按钮检测只看"从运行中变非运行中"这一个状态转换，**完全没有区分思考阶段和回复阶段**。在以下场景下都会误触发：

- 思考结束、准备开始流式输出时，按钮有短暂的瞬态闪动
- z.ai 重排 DOM 时按钮状态短暂抖动
- 思考摘要文本稳定 1.5 秒以上，触发文本轮询的防抖逻辑

**修复方案（三层防护）**：

1. **按钮三态识别**：`isRunning()` 返回的 boolean 改为 `getState()` 返回三态值
   - `'running'`：AI 正在生成回复（流式输出中）
   - `'thinking'`：AI 正在思考（reasoning 阶段，识别 `data-state="thinking"`、`data-thinking="true"` 等属性）
   - `'idle'`：空闲
   
   thinking 和 running 都视为"未完成"，思考→运行的状态切换不会触发通知。

2. **思考指示器检测**：新增 `thinkingIndicators` 选择器列表（`[class*="thinking"]`、`[data-state="thinking"]` 等）。即使按钮显示空闲，只要页面仍存在思考指示器，就视为思考阶段未结束，不发通知。文本轮询也会在思考阶段重置防抖计时器。

3. **最小运行时长保护**：从按钮进入运行/思考状态到离开必须超过 `minRunTimeMs`（默认 800ms），否则视为瞬态抖动忽略。过滤掉 z.ai 重排 DOM 时按钮状态短暂抖动造成的误触发。

4. **延迟二次确认**：按钮变 idle 后不立即发通知，等待 `buttonConfirmDelay`（默认 200ms）后再查一次状态。如果此时按钮又变回 running/thinking（说明刚才只是思考→输出阶段切换的瞬间闪动），就跳过通知。

**新增诊断统计**（`Ctrl+Shift+L` 可查看）：
- `skippedThinking`：因思考指示器仍在而跳过的次数
- `skippedTooShort`：因运行时长过短而跳过的次数
- `skippedConfirmFail`：二次确认失败的次数

### v1.1.8（关键 bug 修复 —— 通知无法触发的多个根本原因）

**用户反馈**："测试通知能收到，但 AI 回复时收不到通知。" 经全面代码审查发现 v1.1.7 引入的按钮状态检测存在多个关键 bug，导致通知触发逻辑失效。

**修复的问题**：

1. **按钮 Observer 漏处理 `childList` 变化（最严重）**
   - **问题**：v1.1.7 的按钮 observer 配置开启了 `childList: true, subtree: true`（注释里也写了"SVG 图标可能整个被替换"），但回调里**只处理 `attributes` 类型**。如果 z.ai 把"停止图标"整个 SVG 替换成"箭头图标"（而不是改 `disabled` 或 `class`），observer 触发了但回调直接忽略，**关键状态转换被漏掉，通知永远发不出**。
   - **修复**：回调现在同时响应 `attributes` 和 `childList` 变化，并扩展监听的属性列表（新增 `aria-disabled`）。

2. **`isRunning` 判断过度依赖硬编码 SVG path**
   - **问题**：v1.1.7 用 `path.getAttribute('d').includes('13.3333')` 判断是否为箭头图标。`13.3333` 是 z.ai 当前箭头 path 里的坐标值，**只要 z.ai 改一次图标设计**，判断就失效。同样 `bg-black`、`bg-neutral-50` 都是 Tailwind 类名，主题调整就会破坏检测。
   - **修复**：重写为多信号判定，按可靠性优先级：
     1. `aria-label` / `title` 含停止/发送语义（最可靠）
     2. `data-state` / `data-loading` / `data-streaming` 显式状态属性
     3. SVG 内部结构（rect vs path）
     4. class 颜色推断（兜底）
   - **回退选择器**：`buttonSelector` 也从单一 `#send-message-button` 扩展为多个回退选择器（按 `aria-label`、`data-testid` 匹配），应对 z.ai DOM 调整。

3. **指纹去重过于激进，会"误吃"新消息**
   - **问题**：v1.1.5 的兜底指纹只用"文本前 200 字"。AI 经常回复以"好的，我来帮你..."、"Sure, I can help..."开头 —— 两次回复前 200 字完全相同 → 第二次直接被 `isAlreadyNotified` 判定为已通知 → **静默跳过**。
   - **修复**：兜底指纹改为"前 100 字 + 总长度 + 后 50 字"组合，前缀相同但内容不同的消息不再被误判。

4. **扩展重载后旧按钮 observer 仍会触发错误**
   - **问题**：v1.1.6 给 `pollLatestAIText` 和 `sendNotification` 加了 `isExtensionContextValid()` 检查，但**按钮 observer 的回调 `checkButtonStateChange` 没有**。扩展重载后旧脚本的按钮 observer 仍在运行，调用 `chrome.runtime.sendMessage` 时抛 `Extension context invalidated` 错误刷屏。
   - **修复**：`checkButtonStateChange` 开头加上下文检查，失效时直接停掉 observer。

5. **测试通知会"骗"用户**
   - **问题**：`TEST_NOTIFICATION` 不检查 `settings.enabled`。用户关闭主开关后点测试仍能收到通知，让用户误以为通知功能正常，但实际 AI 回复时收不到，非常困惑。
   - **修复**：popup.js 的"发送测试通知"按钮先检查主开关，关闭时给出明确提示"通知已被全局禁用，请先打开上方主开关"。

### v1.1.7（按钮状态检测 —— 即时通知，无需防抖等待）

**用户洞察**：用户观察到 Z.AI 的发送按钮（`#send-message-button`）有三种状态，可以精确判断 AI 是否在运行：

| 按钮状态 | 含义 |
|---|---|
| 灰色箭头（`disabled=true`） | 空闲，无输入或 AI 已完成 |
| 黑色箭头（`disabled=false`，箭头图标） | 有输入内容，未发送 |
| 黑色方块（`disabled=false`，停止图标） | **AI 正在运行** |

**关键转换**：按钮从"黑色方块"变回"灰色箭头"的瞬间，就是 AI 回复完成的精确时刻。

**改进**：

1. **新增按钮状态检测** —— 用 MutationObserver 监听 `#send-message-button` 的 `disabled` 属性和 `class` 变化，以及 SVG 图标变化（`childList`）。
2. **精确判断逻辑**：
   - `disabled=true` → 非运行（空闲）
   - `disabled=false` 且 class 含 `bg-black` 且 SVG path 含 `13.3333` → 黑色箭头（有输入未发送）
   - `disabled=false` 且 class 含 `bg-black` 且 SVG path 不含 `13.3333` → 黑色方块（**运行中**）
3. **即时通知** —— 当按钮从"运行中"变为"非运行中"时，立即发通知，无需等待 1.5 秒防抖。比文本稳定性检测更快、更准。
4. **文本轮询保留作为兜底** —— 按钮检测失败时（如选择器不匹配）仍能用文本轮询工作。
5. **共用去重机制** —— 按钮检测和文本轮询共用 `notifiedFingerprints` Set，不会重复通知。

**技术细节**：通过 `agent-browser` 实际访问 z.ai 检测按钮 DOM 结构确认了三种状态的精确差异。

### v1.1.6（防御性修复：扩展上下文失效）

**问题**：用户反馈 F12 Console 出现 `Uncaught Error: Extension context invalidated.`，堆栈指向 `sendNotification` → `pollLatestAIText`。

**原因**：这不是扩展代码本身的 bug，而是**扩展重载的副作用**。当你重新加载扩展（升级到 v1.1.5）时，z.ai 页面上**旧版 content script 还在运行**（轮询定时器没停），它尝试调用 `chrome.runtime.sendMessage()` 发通知时，发现扩展上下文已失效（因为扩展被重载了），于是抛出错误。旧脚本会反复触发这个错误，刷屏 Console。

**修复**：

1. **新增 `isExtensionContextValid()` 检测函数** —— 通过 `chrome.runtime.id` 是否为 undefined 判断扩展上下文是否有效。
2. **`pollLatestAIText` 开头检测上下文** —— 失效时立即停止轮询定时器，输出一条提示，不再反复报错。
3. **`sendNotification` 用 try/catch 包裹** —— 即使检测漏了，同步抛出的错误也能被捕获，输出警告而非 Uncaught Error，并停止轮询。

**用户操作**：如果看到这个错误，**刷新 z.ai 页面**（F5 或 Ctrl+R）即可加载新版本，错误消失。以后升级扩展后，记得刷新所有打开的 AI 对话页面。

### v1.1.5（修复重复通知）

**问题**：用户反馈"能收到通知了，但是通知了不止一次"。

**根本原因**：之前用 `(fingerprint === lastFingerprint && text === lastText)` 双重条件判定"同一条消息"。但 Svelte/React 应用在流式输出结束后还会重新渲染 UI（代码高亮、Markdown 重新解析、按钮出现等），这些渲染会让 `textContent` 产生细微变化（空格/换行/字符规范化），导致 `text !== lastText` 成立，从而触发重复通知。

**修复**：

1. **新增 `notifiedFingerprints` Set 去重** —— 一条 AI 消息只要指纹不变（id/data-id 稳定，或文本前缀相同），无论文本是否细微变化，**只通知一次**。
2. **指纹优先级**：`id` > `data-id`/`data-message-id`/`data-turn-id`/`data-response-id` > 文本前 200 字（之前 100 字太短，长回复前缀可能相同）。
3. **Set 大小限制为 50**，超过自动清空，避免内存泄漏。
4. **即使标签页聚焦时跳过通知，也记录指纹** —— 避免用户看一眼回复又切走时重复发通知。
5. SPA 导航时**不清空** `notifiedFingerprints`，因为同一会话内不同 URL 可能仍引用同一消息。
6. 诊断信息（Ctrl+Shift+L）增加"已通知指纹数量"显示，便于验证去重效果。

### v1.1.4（解决 content script 不注入 + 改为失焦即通知）

**用户反馈**：截图显示 F12 Console 里**完全没有 `[🔔 AI Notify]` 开头的日志**，只有 Z.AI 自身的 Svelte 日志。这说明 content script 根本没注入到页面。

**根本原因**：manifest 的 `matches` 规则只匹配了 `https://z.ai/*` 等具体 URL，但 Z.AI 实际的聊天 URL 可能是 `chat.z.ai` 之外的其他形式（比如带 share 路径、或重定向到其他子域），导致规则没匹配上，content script 完全不加载。

**修复**：

1. **manifest `matches` 改为 `<all_urls>`** —— content.js 在所有网站都加载，但在 `buildSiteConfig()` 中识别站点，非 AI 站点直接退出（不打扰普通网页浏览）。
2. **启动时立即输出醒目日志**（不受 DEBUG 控制）—— 在 F12 Console 中会看到一条紫色高亮的 `[🔔 AI Notify] Content script 已加载于 https://...`，可立刻确认注入是否成功。
3. **"仅后台通知"改为"失焦时通知"** —— 按用户要求，只要标签页失去焦点（切到其他标签页、切到其他应用、点桌面等）就发通知，不再要求标签页完全隐藏。判定逻辑改为 `document.visibilityState === 'hidden' || !document.hasFocus()`。
4. **未知站点提前退出时输出调试日志** + **重试耗尽时输出警告**（不受 DEBUG 控制），便于诊断。

### v1.1.3（彻底重构检测策略）

**问题**：v1.1.2 删除了 `[class*="cursor"]` 后仍有问题。诊断日志显示 `[class*="streaming"]` 等其他选择器在 React/Tailwind 应用中同样误匹配，导致 `[轮询] 仍有流式指示器，等待` 无限循环。F12 Console 被频满刷屏。

**根本性修复**：完全放弃"流式指示器检测"这种不可靠的方式。

**理由**：AI 真正在流式输出时，文本本身每几百毫秒就在变，根本不需要靠光标/动画判断。任何 CSS 类名选择器（`[class*="streaming"]`、`[class*="cursor"]`、`[class*="typing"]`...）都可能在 React/Tailwind 应用中误匹配到无关元素。

**新策略**：纯文本驱动，零依赖 CSS。
- 只要文本稳定 ≥ 防抖时间（默认 1.5s），就发通知。
- 流式指示器检查仅作为诊断信息输出，不阻断通知。
- 内容聚焦模式下完全禁用 MutationObserver 触发的 `checkForCompletedResponse`，避免与轮询冲突、产生重复日志。
- 高频日志限流（每 10 次轮询输出 1 次），避免 F12 被刷屏。

### v1.1.2（彻底修复流式指示器误判）

**根本原因定位**：用户反馈"测试通知能收到，但 AI 回复完成时收不到"。通过 Ctrl+Shift+L 诊断日志发现 `[轮询] 仍有流式指示器，等待` 无限循环。

**问题根源**：`[class*="cursor"]` 这个流式指示器选择器会匹配到 Tailwind 的 `cursor-pointer`、`cursor-text`、`cursor-default` 等常见类名（几乎所有按钮、链接都有这些类），导致 `hasStreamingIndicator` 永远返回 true，通知永远发不出。

**修复**：

1. **彻底删除所有站点的 `[class*="cursor"]` 选择器** —— 这个选择器带来的误匹配远多于真正的流式光标检测。改为只匹配 `[class*="cursor-blink"]`、`[class*="typing-indicator"]`、`[class*="streaming"]`、`[class*="loading-dots"]` 等更精确的类名。
2. **新增"防卡死保障"机制** —— 文本稳定超过 `debounceTime × 3`（默认 4.5 秒）后，即使流式指示器检查返回 true 也强制发通知。任何选择器误匹配都不会再让通知卡死。
3. 同样删除了 `[class*="typing"]`、`[class*="pulse"]` 等过于宽泛的选择器，避免类似问题。

### v1.1.1（检测可靠性修复）

针对"测试通知能收到，但 AI 回复完成时收不到通知"的问题做了三项关键修复：

1. **配置选择器未匹配时不再直接 return** —— 当站点 DOM 结构变化导致 `selectors.aiMsg` 失效时，回退到"整个聊天区域文本"作为检测源，保证基础功能可用。
2. **修复流式指示器检查永远阻断通知的隐藏 bug** —— `[class*="cursor"]` 会匹配到 `cursor-pointer` 等常见 Tailwind 类名，导致 `hasStreamingIndicator` 永远返回 true。回退模式下跳过此检查。
3. **开启 DEBUG 日志 + 新增 `Ctrl+Shift+L` 诊断快捷键** —— 在 AI 对话页面按此快捷键可输出完整诊断信息（聊天容器、AI 消息数量、标签页可见性、轮询统计、跳过原因等），快速定位问题。

### v1.1.0（修复版）

修复了多个导致通知不工作的问题：

1. **`manifest.json` 缺少 `tabs` 权限** —— 通知点击后无法激活聊天标签页。已添加 `tabs` 权限。
2. **MV3 Service Worker 终止导致通知点击失效** —— 原先将 tab↔notification 映射保存在内存 Map 中，SW 被回收后映射丢失。现在将 tabId 直接编码进 notificationId，即使 SW 重启也能恢复映射。
3. **`queryAll` 返回顺序错误** —— 原实现按选择器分组返回，`aiMessages[length-1]` 不是文档中真正的"最新"消息。改为合并选择器后用 `querySelectorAll` 一次取回（浏览器原生按文档顺序返回）。
4. **页面加载/SPA 导航时误触发通知** —— 首次轮询将已有 AI 消息误判为"文本变化"，导致页面打开就收到旧消息的通知。新增 `snapshotInitialized` 标记，首次轮询只初始化快照，不视为变化。
5. **`document.hasFocus()` 语义错误** —— README 设计意图是"标签页可见时不通知"，但 `hasFocus()` 仅在标签页有键盘焦点时为 true。改为 `document.visibilityState === 'hidden'`，更贴合"用户切换到其他标签页"的真实场景。
6. **最小文本长度阈值过高** —— 原为 10 字符，导致短回复（"好的"、"完成"）无法触发通知。降低为 2 字符。
7. **`getSiteConfig()` 重复调用** —— 每次 mutation 都重新计算站点配置。改为实例化时缓存一次。
8. **URL 监听性能优化** —— 原先对整个 body 注册 MutationObserver 监听 URL 变化。改为拦截 `history.pushState/replaceState` + `popstate` + `hashchange` 事件。
9. **新增测试通知按钮** —— Popup 中可一键验证通知权限是否正常工作。

### v1.0.0

- 初版发布
- 内容聚焦模式（contentFocused）
- 支持 Z.AI、ChatGPT、Claude、Gemini、Kimi、MiniMax、DeepSeek

## 为什么需要这个扩展？

在使用 AI 对话工具（如 Z.AI、ChatGPT、Claude 等）时，AI 的回复通常需要几秒到几十秒。如果你在等待期间切换到其他标签页处理别的事情，很难知道 AI 什么时候回复完毕。

MiniMax 等产品已经内置了这个功能，但很多 AI 平台（包括 Z.AI）还没有。这个扩展就是为了填补这个空白。

## 工作原理

```
┌──────────────────────────────────────────────────────────┐
│  1. 用户发送消息，然后切换到其他标签页                      │
│                          ↓                               │
│  2. Content Script 持续监听聊天区域的 DOM 变化             │
│     (通过 MutationObserver)                               │
│                          ↓                               │
│  3. AI 流式输出时，DOM 不断变化 → 防抖计时器持续重置        │
│                          ↓                               │
│  4. AI 输出完成，DOM 不再变化                              │
│     → 防抖计时器到期（默认 3 秒）                           │
│                          ↓                               │
│  5. 检测到最新 AI 消息内容 → 发送通知请求到 Background      │
│                          ↓                               │
│  6. Background Service Worker 创建浏览器通知               │
│     → 点击通知自动聚焦回对话标签页                          │
└──────────────────────────────────────────────────────────┘
```

**核心检测策略：MutationObserver + 防抖（Debounce）**

- AI 流式输出时，DOM 每几十毫秒就会更新一次
- 当 AI 回复完成，DOM 不再变化
- 如果 DOM 连续 N 秒没有新变化（默认 3 秒），则判定回复完成
- 同时检查是否存在流式输出指示器（闪烁光标、loading 动画等）作为辅助判断

## 支持的平台

| 平台 | 域名 | 状态 |
|------|------|------|
| Z.AI | z.ai, chatglm.cn | ✅ 支持 |
| ChatGPT | chatgpt.com | ✅ 支持 |
| Claude | claude.ai | ✅ 支持 |
| Gemini | gemini.google.com | ✅ 支持 |
| MiniMax | minimax.chat | ✅ 支持 |
| Kimi | kimi.moonshot.cn | ✅ 支持 |
| DeepSeek | deepseek.com | ✅ 支持 |

## 安装方法

### 从源码安装（开发者模式）

1. 克隆本仓库：
   ```bash
   git clone https://github.com/liudw347-collab/z-ai-notification.git
   ```

2. 打开 Chrome，进入扩展管理页面：
   - 地址栏输入 `chrome://extensions/`
   - 或者菜单 → 更多工具 → 扩展程序

3. 打开右上角的 **「开发者模式」** 开关

4. 点击 **「加载已解压的扩展程序」**

5. 选择本项目的根目录（包含 `manifest.json` 的目录）

6. 扩展安装完成！你会在工具栏看到铃铛图标

### 验证安装

- 访问任意支持的 AI 对话网站
- 点击工具栏的铃铛图标，确认 Popup 正常弹出
- 发送一条消息，然后切换到其他标签页，等待 AI 回复完成

## 使用说明

### 基本使用

安装后无需额外配置，扩展会自动在支持的网站上工作：

1. 打开 AI 对话页面（如 z.ai）
2. 发送一条消息
3. 切换到其他标签页做别的事情
4. AI 回复完成后，你会收到浏览器通知
5. 点击通知即可跳转回对话页面

### 配置选项

点击工具栏的铃铛图标打开 Popup 面板：

- **全局开关**：一键启用/禁用所有通知
- **平台开关**：单独控制每个 AI 平台是否发送通知
- **提示音**：控制通知是否播放提示音
- **仅后台通知**：标签页可见时不发送通知（避免干扰）
- **等待时间**：调整判定回复完成的等待时间（1-8 秒）
  - 较短的等待时间 = 更快收到通知，但可能误判
  - 较长的等待时间 = 更准确，但通知会稍晚

## 项目结构

```
z-ai-notification/
├── manifest.json          # 扩展清单（Manifest V3）
├── background.js          # 后台 Service Worker（通知管理）
├── content.js             # 内容脚本（DOM 监控引擎）
├── popup.html             # Popup 界面
├── popup.css              # Popup 样式
├── popup.js               # Popup 逻辑
├── icons/                 # 扩展图标
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
├── generate_icons.py      # 图标生成脚本（开发用）
└── README.md              # 本文件
```

### 核心文件说明

| 文件 | 职责 |
|------|------|
| `content.js` | 注入到 AI 对话页面，使用 MutationObserver 监听 DOM 变化，通过防抖策略判定回复完成，向 background 发送通知请求 |
| `background.js` | 接收 content script 消息，创建 `chrome.notifications` 通知，处理通知点击事件（聚焦标签页），管理设置 |
| `popup.js` | Popup 面板交互逻辑，读取/保存用户设置 |

## 技术细节

### 智能过滤

Content Script 不会对所有 DOM 变化做出反应，而是智能过滤：

- ❌ **排除**：用户输入框的变化（打字不会触发通知）
- ❌ **排除**：样式/属性变化（hover 效果、焦点切换等）
- ❌ **排除**：SCRIPT、STYLE、LINK 标签的变化
- ✅ **关注**：聊天消息区域的新增内容和文本变化

### 防重复通知

- 通过消息指纹（ID、内容哈希）追踪已通知的消息
- 同一条回复只会通知一次

### SPA 导航支持

- 监听 URL 变化，自动重新初始化监控器
- 适配单页应用（React/Vue/Angular）的页面切换

### 仅后台通知

- 默认开启，使用 `document.hasFocus()` 检测标签页是否激活
- 当用户正在查看对话页面时，不会发送多余的通知

## 添加新平台支持

在 `content.js` 的 `SITE_PATTERNS` 数组中添加新的配置：

```javascript
{
  match: /new-platform\.com/,    // URL 匹配正则
  name: 'NewPlatform',            // 通知中显示的名称
  selectors: {
    chatArea: ['CSS选择器1', 'CSS选择器2'],   // 聊天容器
    aiMsg: ['CSS选择器1', 'CSS选择器2'],      // AI 消息
    streaming: ['CSS选择器1'],                // 流式输出指示器
    inputArea: ['CSS选择器1']                 // 输入区域
  }
}
```

然后在 `manifest.json` 的 `content_scripts.matches` 中添加 URL 匹配规则。

## 开发

### 调试 Content Script

1. 打开 AI 对话页面
2. 按 F12 打开开发者工具
3. 在 Console 中可以看到 `[🔔 AI Notify]` 开头的日志
4. 要启用详细日志，修改 `content.js` 中的 `const DEBUG = false` 改为 `true`

### 调试 Background Service Worker

1. 进入 `chrome://extensions/`
2. 找到本扩展，点击「Service Worker」链接
3. 在打开的 DevTools 中查看日志

## 许可证

MIT License