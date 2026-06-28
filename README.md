# AI Chat Notification 🔔

> 当 AI 对话回复完成时，发送浏览器通知 —— 让你即使切换到其他标签页也能及时知道回复已就绪。

## 更新日志

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