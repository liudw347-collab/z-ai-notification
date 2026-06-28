/**
 * AI Chat Notification - Content Script
 *
 * 核心检测引擎：通过 MutationObserver + 防抖策略检测 AI 回复完成。
 *
 * v1.1.2 关键修复（根据用户反馈定位的真凶）：
 *   9. 彻底删除所有站点的 [class*="cursor"] 流式指示器选择器 ——
 *      这个选择器会匹配到 cursor-pointer/cursor-text/cursor-default 等
 *      Tailwind 常见类名，导致 hasStreamingIndicator 永远返回 true，
 *      通知永远发不出。这是"测试通知能收到但 AI 回复收不到"的根本原因。
 *  10. 新增"防卡死保障"：文本稳定超过 debounceTime * 3 后，
 *      即使流式指示器检查返回 true 也强制发通知（避免任何选择器误匹配卡死）。
 *  11. hasStreamingIndicator 改为只在"最新 AI 消息内"查找，
 *      不再检查整个聊天容器（避免被旧消息的按钮误匹配）。
 *
 * v1.1.1 改进：
 *   6. 配置选择器未匹配时回退到聊天区域文本。
 *   7. 回退模式下跳过流式指示器检查。
 *   8. 开启 DEBUG 日志 + Ctrl+Shift+L 诊断快捷键。
 *
 * v1.1 改进（修复版）：
 *   1-5. queryAll 顺序、初始化快照、document.hidden、缓存配置、降低文本阈值。
 */

(function () {
  'use strict';

  // ✨ v1.1.1: 默认开启 DEBUG，方便排查。问题解决后可改回 false。
  const DEBUG = true;
  const log = (...args) => DEBUG && console.log('[🔔 AI Notify]', ...args);
  const warn = (...args) => console.warn('[🔔 AI Notify]', ...args);

  // ====================================================================
  //  站点配置
  // ====================================================================

  const SITE_PATTERNS = [
    {
      match: /z\.ai|chatglm\.cn/,
      name: 'Z.AI',
      // ✨ 内容聚焦模式：只关注 AI 文本区域的变化，忽略外围 UI
      contentFocused: true,
      // 文本内容区域的 CSS 选择器 —— 只有这些元素内的变化才重置计时器
      contentSelectors: ['.markdown-prose'],
      selectors: {
        chatArea: [
          '#messages-container',
          '#chat-container',
          '[class*="chat-messages"]',
          '[role="log"]',
          'main'
        ],
        aiMsg: [
          '.markdown-prose',
          '[id^="response-content-container"]',
          '[class*="assistant"]',
          '[data-role="assistant"]'
        ],
        streaming: [
          '#loading-message',
          '[class*="streaming"]',
          '[class*="typing-indicator"]',
          '[class*="loading-dots"]'
        ],
        inputArea: [
          '#chat-input',
          '.messageInputContainer',
          '#send-message-button',
          'textarea',
          '[contenteditable="true"]',
          '[role="textbox"]'
        ]
      }
    },
    {
      match: /chatgpt\.com|chat\.openai\.com/,
      name: 'ChatGPT',
      contentFocused: false,
      selectors: {
        chatArea: [
          '[data-testid="conversation-turn-"]',
          '[class*="conversation"]',
          'main'
        ],
        aiMsg: [
          '[data-message-author-role="assistant"]',
          '[class*="assistant"]'
        ],
        streaming: [
          '[class*="result-streaming"]',
          '[class*="typing-indicator"]'
        ],
        inputArea: [
          '#prompt-textarea',
          '[contenteditable="true"]',
          '[role="textbox"]'
        ]
      }
    },
    {
      match: /claude\.ai/,
      name: 'Claude',
      contentFocused: false,
      selectors: {
        chatArea: [
          '[class*="flex flex-col gap-"]',
          '[class*="conversation"]',
          'main'
        ],
        aiMsg: [
          '[class*="Assistant"]',
          '[data-testid="assistant-turn"]'
        ],
        streaming: [
          '[class*="typing-indicator"]',
          '[class*="cursor-blink"]'
        ],
        inputArea: [
          '[contenteditable="true"]',
          'div[role="textbox"]'
        ]
      }
    },
    {
      match: /gemini\.google\.com/,
      name: 'Gemini',
      contentFocused: false,
      selectors: {
        chatArea: [
          '[class*="conversation-container"]',
          '.response-container',
          'main'
        ],
        aiMsg: [
          'model-response',
          '[class*="response"]'
        ],
        streaming: [
          '[class*="streaming"]',
          '.loading-dots'
        ],
        inputArea: [
          '[contenteditable="true"]',
          'rich-textarea'
        ]
      }
    },
    {
      match: /minimax\.chat/,
      name: 'MiniMax',
      contentFocused: false,
      selectors: {
        chatArea: [
          '.chat-messages',
          '[class*="message-list"]',
          'main'
        ],
        aiMsg: [
          '[class*="bot"]',
          '[class*="assistant"]'
        ],
        streaming: [
          '[class*="typing-indicator"]',
          '[class*="cursor-blink"]'
        ],
        inputArea: [
          'textarea',
          '[contenteditable="true"]'
        ]
      }
    },
    {
      match: /kimi\.moonshot\.cn/,
      name: 'Kimi',
      contentFocused: false,
      selectors: {
        chatArea: [
          '[class*="chat"]',
          '[class*="message"]',
          'main'
        ],
        aiMsg: [
          '[class*="bot"]',
          '[class*="assistant"]'
        ],
        streaming: [
          '[class*="typing-indicator"]',
          '[class*="cursor-blink"]'
        ],
        inputArea: [
          'textarea',
          '[contenteditable="true"]'
        ]
      }
    },
    {
      match: /deepseek\.com/,
      name: 'DeepSeek',
      contentFocused: false,
      selectors: {
        chatArea: [
          '[class*="chat"]',
          '[class*="message"]',
          '[class*="conversation"]',
          'main'
        ],
        aiMsg: [
          '[class*="assistant"]',
          '[class*="bot"]',
          '[data-role="assistant"]'
        ],
        streaming: [
          '[class*="streaming"]',
          '[class*="typing-indicator"]',
          '[class*="cursor-blink"]'
        ],
        inputArea: [
          'textarea',
          '[contenteditable="true"]',
          '[role="textbox"]'
        ]
      }
    }
  ];

  const GENERIC_SELECTORS = {
    chatArea: [
      '[class*="message"]',
      '[class*="chat"]',
      '[role="log"]',
      '[class*="conversation"]',
      '[class*="thread"]',
      'main',
      'body'
    ],
    aiMsg: [
      '[class*="assistant"]',
      '[class*="bot"]',
      '[class*="ai"]',
      '[data-role="assistant"]',
      '[class*="model"]'
    ],
    streaming: [
      '[class*="streaming"]',
      '[class*="typing-indicator"]',
      '[class*="loading-dots"]'
    ],
    inputArea: [
      'textarea',
      '[contenteditable="true"]',
      '[role="textbox"]',
      '[class*="input"]'
    ]
  };

  // ====================================================================
  //  工具函数
  // ====================================================================

  function buildSiteConfig() {
    const hostname = window.location.hostname;
    for (const pattern of SITE_PATTERNS) {
      if (pattern.match.test(hostname)) {
        return {
          name: pattern.name,
          contentFocused: pattern.contentFocused || false,
          contentSelectors: pattern.contentSelectors || [],
          selectors: pattern.selectors
        };
      }
    }
    return {
      name: document.title || 'AI Chat',
      contentFocused: false,
      contentSelectors: [],
      selectors: GENERIC_SELECTORS
    };
  }

  function queryFirst(selectors, root) {
    root = root || document;
    for (const sel of selectors) {
      try {
        const el = root.querySelector(sel);
        if (el) return el;
      } catch (e) { /* skip */ }
    }
    return null;
  }

  /**
   * ✨ v1.1 修复：按文档顺序返回所有匹配元素
   *
   * 旧实现按"选择器顺序"返回元素，导致 aiMessages[length-1] 不是文档中
   * 最后一个 AI 消息，而是最后一个选择器匹配的最后一个元素。
   *
   * 新实现合并所有选择器为单个 querySelectorAll 调用，浏览器原生按文档顺序返回，
   * 自然去重。这样 aiMessages[length-1] 才是真正的"最新" AI 消息。
   */
  function queryAll(selectors, root) {
    root = root || document;
    if (!selectors || selectors.length === 0) return [];

    // 合并所有选择器为逗号分隔的单一选择器
    // querySelectorAll 原生返回文档顺序、自动去重
    const combined = selectors.join(', ');
    try {
      return Array.from(root.querySelectorAll(combined));
    } catch (e) {
      // 某些选择器可能无效，退回到逐个查询
      const seen = new Set();
      const results = [];
      for (const sel of selectors) {
        try {
          const els = root.querySelectorAll(sel);
          for (const el of els) {
            if (!seen.has(el)) {
              seen.add(el);
              results.push(el);
            }
          }
        } catch { /* skip */ }
      }
      // 手动按文档位置排序
      results.sort((a, b) => {
        if (a === b) return 0;
        const pos = a.compareDocumentPosition(b);
        if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
        if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
        return 0;
      });
      return results;
    }
  }

  function isInsideInput(el, inputSelectors) {
    if (!el) return false;
    const combined = inputSelectors.join(', ');
    try {
      return !!el.closest(combined);
    } catch {
      return false;
    }
  }

  function hasStreamingIndicator(el, streamingSelectors) {
    if (!el) return false;
    for (const sel of streamingSelectors) {
      try {
        // 既检查后代，也检查元素自身
        if (el.matches?.(sel)) return true;
        if (el.querySelector(sel)) return true;
      } catch { /* skip */ }
    }
    return false;
  }

  function getCleanText(el) {
    if (!el) return '';
    return (el.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function getElementFingerprint(el) {
    if (!el) return '';
    if (el.id) return 'id:' + el.id;
    const dataId = el.getAttribute('data-id') || el.getAttribute('data-message-id');
    if (dataId) return 'data:' + dataId;
    const text = getCleanText(el);
    return 'text:' + text.substring(0, 100);
  }

  /**
   * 判断标签页是否处于"后台"状态（不可见）
   *
   * ✨ v1.1 修复：使用 document.visibilityState === 'hidden' 而非 document.hasFocus()
   *
   * 原因：README 设计意图是"标签页可见时不发送通知"。
   * - document.hasFocus() 仅在标签页有键盘焦点时为 true
   * - document.visibilityState === 'hidden' 只在标签页完全不可见时为 true
   *   （用户切换到了其他标签页，或最小化了窗口）
   * 后者更贴合"用户去干别的"的真实场景。
   */
  function isTabHidden() {
    return document.visibilityState === 'hidden';
  }

  // ====================================================================
  //  聊天监控器 v1.1 —— 支持内容聚焦模式 + 修复多项 bug
  // ====================================================================

  class ChatMonitor {
    constructor() {
      // ✨ 缓存 siteConfig，避免每次 mutation 都重新计算
      this.siteConfig = buildSiteConfig();
      this.observer = null;
      this.debounceTimer = null;
      this.textPollingTimer = null;
      this.lastFingerprint = '';
      this.lastText = '';
      this.lastTextSnapshot = '';
      this.lastTextChangeTime = 0;
      this.snapshotInitialized = false; // ✨ v1.1: 标记快照是否已初始化
      this.chatContainer = null;
      this.active = false;
      this.retryCount = 0;
      this.maxRetries = 15;
      this.retryDelay = 2000;
      this.initCalled = false;
      this.debounceTime = 1500;
      this.onlyWhenHidden = true;
      // ✨ v1.1.1: 诊断信息，可通过 Ctrl+Shift+L 查看
      this.diagnosticInfo = {
        initTime: Date.now(),
        mutationsReceived: 0,
        significantMutations: 0,
        textPolls: 0,
        notificationsSent: 0,
        skippedVisible: 0,
        skippedDuplicate: 0,
        skippedStreaming: 0,
        lastPollTime: null,
        lastMutationTime: null,
      };
    }

    async init() {
      if (this.initCalled) return;
      this.initCalled = true;

      log('正在初始化，站点:', this.siteConfig.name, '内容聚焦:', this.siteConfig.contentFocused);

      const settings = await this.getSettings();
      const hostname = window.location.hostname;
      const siteKey = this.findSiteKey(hostname);

      if (!settings.enabled) { log('通知已全局禁用'); return; }
      if (siteKey && settings.sites && settings.sites[siteKey] === false) {
        log('该站点通知已禁用:', siteKey); return;
      }

      this.debounceTime = settings.debounceTime || 1500;
      this.onlyWhenHidden = settings.onlyNotifyWhenHidden !== false;

      this.chatContainer = this.findChatContainer();
      if (!this.chatContainer) {
        if (this.retryCount < this.maxRetries) {
          this.retryCount++;
          log(`聊天容器未找到，第 ${this.retryCount}/${this.maxRetries} 次重试...`);
          setTimeout(() => this.reInit(), this.retryDelay);
        } else {
          log('使用 document.body 作为回退容器');
          this.chatContainer = document.body;
          this.startObserving();
        }
        return;
      }

      this.startObserving();
    }

    reInit() {
      this.initCalled = false;
      this.retryCount = 0;
      this.lastFingerprint = '';
      this.lastText = '';
      this.lastTextSnapshot = '';
      this.lastTextChangeTime = 0;
      this.snapshotInitialized = false; // ✨ 重置初始化标记
      this.init();
    }

    findChatContainer() {
      const selectors = this.siteConfig.selectors.chatArea;
      for (const sel of selectors) {
        try {
          const el = document.querySelector(sel);
          if (el) { log('找到聊天容器:', sel, el); return el; }
        } catch (e) { /* skip */ }
      }
      return null;
    }

    startObserving() {
      if (this.observer) this.observer.disconnect();

      this.observer = new MutationObserver((mutations) => {
        this.handleMutations(mutations);
      });

      this.observer.observe(this.chatContainer, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: false
      });

      // ✨ 内容聚焦模式下，启动文本轮询作为辅助检测
      // 每 500ms 采样最新 AI 消息的文本，独立于 DOM mutation 判断
      if (this.siteConfig.contentFocused) {
        this.startTextPolling();
      }

      this.active = true;
      log('监控已启动，容器:', this.chatContainer.tagName);
    }

    // ==================================================================
    //  ✨ 文本轮询 —— 内容聚焦模式的核心
    //  独立于 MutationObserver，直接采样 AI 文本内容的变化
    // ==================================================================

    startTextPolling() {
      if (this.textPollingTimer) clearInterval(this.textPollingTimer);

      this.textPollingTimer = setInterval(() => {
        this.pollLatestAIText();
      }, 500);
    }

    pollLatestAIText() {
      this.diagnosticInfo.textPolls++;
      this.diagnosticInfo.lastPollTime = Date.now();

      const aiMessages = queryAll(this.siteConfig.selectors.aiMsg);
      let latestMsg = null;
      let currentText = '';
      let usingFallback = false;

      if (aiMessages.length > 0) {
        // ✨ v1.1 修复：queryAll 现在按文档顺序返回，最后一个才是真正的"最新"消息
        latestMsg = aiMessages[aiMessages.length - 1];
        currentText = getCleanText(latestMsg);
        log('[轮询] 配置选择器匹配', aiMessages.length, '个 AI 消息，最新文本长度:', currentText.length);
      } else if (this.chatContainer) {
        // ✨ v1.1.1 回退策略：配置选择器未匹配，使用整个聊天区域的文本
        // 这样即使站点 DOM 结构变化导致选择器失效，也能继续工作
        latestMsg = this.chatContainer;
        currentText = getCleanText(this.chatContainer);
        usingFallback = true;
        log('[轮询] ⚠️ 配置选择器未匹配 AI 消息，回退到聊天区域文本，长度:', currentText.length);
      } else {
        return;
      }

      // ✨ v1.1 修复：首次轮询只初始化快照，不视为"文本变化"
      // 避免页面加载/SPA 导航后对已有的 AI 消息误触发通知
      if (!this.snapshotInitialized) {
        this.lastTextSnapshot = currentText;
        this.snapshotInitialized = true;
        this.lastTextChangeTime = 0; // 0 表示还未检测到任何变化
        log('[轮询] 初始化快照，文本长度:', currentText.length, usingFallback ? '(回退模式)' : '');
        return;
      }

      // 文本过短则跳过（降低阈值以支持短回复，如"好的"、"完成"）
      if (currentText.length < 2) return;

      // 检测文本是否有变化
      if (currentText !== this.lastTextSnapshot) {
        // 文本变了 → AI 还在输出 → 记录时间，重置防抖
        this.lastTextSnapshot = currentText;
        this.lastTextChangeTime = Date.now();
        log('[轮询] 检测到文本变化，长度:', currentText.length, usingFallback ? '(回退模式)' : '');
      } else {
        // 文本没变 → 检查是否已经稳定了足够久
        // 注意：lastTextChangeTime === 0 表示从未检测到变化（页面加载后文本就稳定）
        //       此时不应该触发通知
        if (this.lastTextChangeTime === 0) return;

        const elapsed = Date.now() - this.lastTextChangeTime;
        if (elapsed >= this.debounceTime) {
          // 文本已稳定！但还需要确认不是和上次通知同一条
          const latestFingerprint = getElementFingerprint(latestMsg);
          if (latestFingerprint === this.lastFingerprint && currentText === this.lastText) {
            this.diagnosticInfo.skippedDuplicate++;
            return; // 同一条消息，跳过
          }

          // 检查流式指示器
          // ✨ v1.1.1: 仅在使用具体 AI 消息元素时检查，
          // 回退模式下跳过以避免误匹配 cursor-pointer 等常见类名
          //
          // ✨ v1.1.2 防卡死保障：如果文本已经稳定超过 debounceTime * 3，
          // 即使流式指示器检查返回 true 也强制发通知。
          // 这是为了避免任何选择器误匹配导致永远卡在"等待流式"状态。
          const forceNotifyDueToTimeout = elapsed >= this.debounceTime * 3;
          if (!usingFallback && !forceNotifyDueToTimeout &&
              hasStreamingIndicator(latestMsg, this.siteConfig.selectors.streaming)) {
            log('[轮询] 仍有流式指示器，等待 (elapsed=' + (elapsed / 1000).toFixed(1) + 's)');
            this.diagnosticInfo.skippedStreaming++;
            return;
          }
          if (forceNotifyDueToTimeout) {
            log('[轮询] ⚠️ 防卡死保障触发：文本已稳定 ' + (elapsed / 1000).toFixed(1) +
                's（超过 ' + (this.debounceTime * 3 / 1000).toFixed(1) + 's），强制发通知');
          }

          log('[轮询] ✅ 文本已稳定 ' + (elapsed / 1000).toFixed(1) + 's，准备通知');

          // ✨ v1.1 修复：使用 document.hidden 替代 document.hasFocus()
          if (this.onlyWhenHidden && !isTabHidden()) {
            log('[轮询] 标签页可见，跳过通知（但更新指纹）');
            this.diagnosticInfo.skippedVisible++;
            this.lastTextChangeTime = 0;
            this.lastFingerprint = latestFingerprint;
            this.lastText = currentText;
            return;
          }

          this.lastTextChangeTime = 0; // 防止重复触发
          this.lastFingerprint = latestFingerprint;
          this.lastText = currentText;
          this.diagnosticInfo.notificationsSent++;
          this.sendNotification(currentText);
        }
      }
    }

    /**
     * ✨ v1.1.1: 诊断信息输出 —— 按 Ctrl+Shift+L 触发
     * 用于排查"收不到通知"的问题
     */
    dumpDiagnostics() {
      const aiMessages = queryAll(this.siteConfig.selectors.aiMsg);
      const chatText = this.chatContainer ? getCleanText(this.chatContainer) : '';

      console.group('%c🔔 AI Notify 诊断信息', 'color: #6366f1; font-weight: bold; font-size: 14px;');
      console.log('站点:', this.siteConfig.name);
      console.log('内容聚焦模式:', this.siteConfig.contentFocused);
      console.log('内容选择器:', this.siteConfig.contentSelectors);
      console.log('AI 消息选择器:', this.siteConfig.selectors.aiMsg);
      console.log('流式指示器选择器:', this.siteConfig.selectors.streaming);
      console.log('输入区域选择器:', this.siteConfig.selectors.inputArea);
      console.log('---');
      console.log('聊天容器:', this.chatContainer
        ? `${this.chatContainer.tagName}#${this.chatContainer.id}.${this.chatContainer.className}`
        : 'null');
      console.log('聊天容器文本长度:', chatText.length);
      console.log('AI 消息数量(配置选择器):', aiMessages.length);
      if (aiMessages.length > 0) {
        console.log('最新 AI 消息元素:', aiMessages[aiMessages.length - 1]);
        console.log('最新 AI 消息文本(前100字):', getCleanText(aiMessages[aiMessages.length - 1]).substring(0, 100));
      } else {
        console.warn('⚠️ 配置选择器未匹配到任何 AI 消息！正在使用回退模式（整个聊天区域文本）');
        console.log('提示：请检查 content.js 中 Z.AI 的 selectors.aiMsg 是否与当前页面 DOM 一致');
      }
      console.log('---');
      console.log('防抖时间:', this.debounceTime, 'ms');
      console.log('仅后台通知:', this.onlyWhenHidden);
      console.log('标签页可见性:', document.visibilityState, '(hidden 时才发通知)');
      console.log('当前 URL:', window.location.href);
      console.log('---');
      console.log('快照已初始化:', this.snapshotInitialized);
      console.log('最后快照长度:', this.lastTextSnapshot.length);
      console.log('最后快照(前100字):', this.lastTextSnapshot.substring(0, 100));
      console.log('最后通知文本(前100字):', this.lastText.substring(0, 100));
      console.log('最后变化时间:', this.lastTextChangeTime
        ? new Date(this.lastTextChangeTime).toISOString() + ' (' + ((Date.now() - this.lastTextChangeTime) / 1000).toFixed(1) + 's ago)'
        : 'never');
      console.log('---');
      console.log('诊断统计:', this.diagnosticInfo);
      console.log('---');
      console.log('排查建议:');
      if (!this.chatContainer) console.log('  ❌ 聊天容器未找到 → 检查 selectors.chatArea');
      if (aiMessages.length === 0) console.log('  ❌ AI 消息未找到 → 检查 selectors.aiMsg（当前使用回退模式）');
      if (this.diagnosticInfo.textPolls < 5) console.log('  ⚠️ 轮询次数很少 → content script 可能刚加载');
      if (this.lastTextChangeTime === 0 && this.snapshotInitialized) console.log('  ℹ️ 未检测到文本变化 → AI 可能还没开始回复，或选择器匹配到了错误的元素');
      if (this.diagnosticInfo.skippedStreaming > 0) console.log('  ⚠️ 多次因流式指示器跳过 → 检查 selectors.streaming 是否过于宽泛');
      if (this.diagnosticInfo.skippedVisible > 0) console.log('  ℹ️ 因标签页可见跳过 → 切换到其他标签页再试');
      console.groupEnd();
    }

    // ==================================================================
    //  DOM Mutation 处理（通用模式 + 内容聚焦模式）
    // ==================================================================

    handleMutations(mutations) {
      this.diagnosticInfo.mutationsReceived += mutations.length;
      this.diagnosticInfo.lastMutationTime = Date.now();
      const significant = mutations.filter((m) => this.isSignificantMutation(m));
      this.diagnosticInfo.significantMutations += significant.length;
      if (significant.length === 0) return;

      log(`检测到 ${significant.length} 个有意义的 DOM 变化`);

      if (this.debounceTimer) clearTimeout(this.debounceTimer);

      this.debounceTimer = setTimeout(() => {
        this.checkForCompletedResponse();
      }, this.debounceTime);
    }

    /**
     * 判断是否为有意义的 DOM 变化
     */
    isSignificantMutation(mutation) {
      // === 通用过滤（所有模式共用） ===

      // 排除 SCRIPT / STYLE / LINK
      if (mutation.target && mutation.target.nodeType === Node.ELEMENT_NODE) {
        const tag = mutation.target.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'LINK') return false;
        if (isInsideInput(mutation.target, this.siteConfig.selectors.inputArea)) return false;
      }

      // 排除输入区域内的变动
      if (mutation.target?.parentElement &&
          isInsideInput(mutation.target.parentElement, this.siteConfig.selectors.inputArea)) {
        return false;
      }

      // 排除属性变化
      if (mutation.type === 'attributes') return false;

      // === 内容聚焦过滤（仅 contentFocused 模式） ===
      if (this.siteConfig.contentFocused && this.siteConfig.contentSelectors.length > 0) {
        return this.isContentAreaMutation(mutation);
      }

      // === 通用模式 ===
      if (mutation.type === 'childList') {
        return mutation.addedNodes.length > 0;
      }

      if (mutation.type === 'characterData') {
        if (mutation.target.parentElement &&
            isInsideInput(mutation.target.parentElement, this.siteConfig.selectors.inputArea)) {
          return false;
        }
        return true;
      }

      return false;
    }

    /**
     * 内容聚焦模式下的 mutation 判定
     */
    isContentAreaMutation(mutation) {
      const contentSelectors = this.siteConfig.contentSelectors;

      const isInsideContent = (el) => {
        if (!el) return false;
        for (const sel of contentSelectors) {
          try {
            if (el.closest?.(sel)) return true;
          } catch { /* skip */ }
        }
        return false;
      };

      const isContentElement = (el) => {
        if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
        for (const sel of contentSelectors) {
          try {
            if (el.matches?.(sel)) return true;
          } catch { /* skip */ }
        }
        return false;
      };

      const containsContentElement = (el) => {
        if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
        for (const sel of contentSelectors) {
          try {
            if (el.querySelector?.(sel)) return true;
          } catch { /* skip */ }
        }
        return false;
      };

      // childList 变化：新增节点
      if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
        for (const node of mutation.addedNodes) {
          if (isContentElement(node)) return true;
          if (containsContentElement(node)) return true;
          if (isInsideContent(node)) return true;
        }
        log('[内容聚焦] 忽略非内容区域的 childList 变化');
        return false;
      }

      // characterData 变化：文本修改
      if (mutation.type === 'characterData') {
        if (isInsideContent(mutation.target.parentElement)) {
          return true;
        }
        log('[内容聚焦] 忽略非内容区域的 characterData 变化');
        return false;
      }

      return false;
    }

    /**
     * 通用模式下的完成检查（非内容聚焦模式使用）
     * 内容聚焦模式由 textPolling 处理，这里作为备份
     */
    checkForCompletedResponse() {
      log('检查 AI 回复是否完成...');

      const aiMessages = queryAll(this.siteConfig.selectors.aiMsg);
      let latestMsg = null;
      let latestText = '';
      let usingFallback = false;

      if (aiMessages.length > 0) {
        // ✨ v1.1 修复：queryAll 现在按文档顺序返回
        latestMsg = aiMessages[aiMessages.length - 1];
        latestText = getCleanText(latestMsg);
        log('配置选择器匹配', aiMessages.length, '个 AI 消息');
      } else if (this.chatContainer) {
        // ✨ v1.1.1 回退策略
        latestMsg = this.chatContainer;
        latestText = getCleanText(this.chatContainer);
        usingFallback = true;
        log('⚠️ 配置选择器未匹配 AI 消息，回退到聊天区域文本');
      } else {
        log('未找到 AI 消息且无聊天容器');
        return;
      }

      const latestFingerprint = getElementFingerprint(latestMsg);
      log('最新 AI 消息指纹:', latestFingerprint.substring(0, 50), '长度:', latestText.length);

      // 与上次通知的消息相同
      if (latestFingerprint === this.lastFingerprint && latestText === this.lastText) {
        log('与上次通知的消息相同，跳过');
        return;
      }

      // 仍在流式输出（回退模式下跳过此检查）
      // ✨ v1.1.2: 加上防卡死保障
      const checkForStreaming = !usingFallback;
      if (checkForStreaming && hasStreamingIndicator(latestMsg, this.siteConfig.selectors.streaming)) {
        log('检测到流式输出指示器，等待... (2s 后重试)');
        this.debounceTimer = setTimeout(() => this.checkForCompletedResponse(), 2000);
        return;
      }

      // 内容过短
      if (latestText.length < 2) { log('消息内容过短，跳过'); return; }

      // ✨ v1.1 修复：使用 document.hidden 替代 document.hasFocus()
      if (this.onlyWhenHidden && !isTabHidden()) {
        log('标签页可见，跳过通知（更新指纹）');
        this.lastFingerprint = latestFingerprint;
        this.lastText = latestText;
        return;
      }

      // ✅ 回复完成
      log('✅ AI 回复完成，发送通知！');
      this.lastFingerprint = latestFingerprint;
      this.lastText = latestText;
      this.diagnosticInfo.notificationsSent++;
      this.sendNotification(latestText);
    }

    sendNotification(text) {
      chrome.runtime.sendMessage(
        {
          type: 'AI_RESPONSE_COMPLETE',
          data: {
            preview: text.substring(0, 150) + (text.length > 150 ? '...' : ''),
            url: window.location.href,
            siteName: this.siteConfig.name,
            timestamp: Date.now()
          }
        },
        (response) => {
          if (chrome.runtime.lastError) {
            console.error('[AI Notify] 发送通知消息失败:', chrome.runtime.lastError.message);
          } else {
            log('通知请求已发送');
          }
        }
      );
    }

    getSettings() {
      return new Promise((resolve) => {
        chrome.storage.local.get(['settings'], (result) => {
          resolve(
            result.settings || {
              enabled: true,
              sound: true,
              debounceTime: 1500,
              onlyNotifyWhenHidden: true,
              sites: {}
            }
          );
        });
      });
    }

    findSiteKey(hostname) {
      const knownKeys = [
        'z.ai', 'chatglm.cn', 'chatgpt.com', 'chat.openai.com',
        'claude.ai', 'gemini.google.com', 'minimax.chat',
        'kimi.moonshot.cn', 'deepseek.com', 'chat.deepseek.com'
      ];
      return knownKeys.find((key) => hostname.includes(key)) || null;
    }

    destroy() {
      if (this.observer) { this.observer.disconnect(); this.observer = null; }
      if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = null; }
      if (this.textPollingTimer) { clearInterval(this.textPollingTimer); this.textPollingTimer = null; }
      this.active = false;
      log('监控器已销毁');
    }
  }

  // ====================================================================
  //  初始化 & SPA 导航处理
  // ====================================================================

  let monitor = new ChatMonitor();
  monitor.init();

  // ✨ v1.1 改进：使用 history API + popstate 监听 URL 变化，
  //    避免对整个 body 注册 MutationObserver 造成性能浪费
  let lastUrl = location.href;

  function onUrlChange() {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      log('URL 变化，重新初始化监控器:', lastUrl);
      monitor.destroy();
      monitor = new ChatMonitor();
      monitor.init();
    }
  }

  // 拦截 pushState / replaceState
  ['pushState', 'replaceState'].forEach((method) => {
    const original = history[method];
    history[method] = function (...args) {
      const result = original.apply(this, args);
      // 异步触发，确保浏览器先处理完 URL 变化
      setTimeout(onUrlChange, 0);
      return result;
    };
  });

  window.addEventListener('popstate', onUrlChange);
  window.addEventListener('hashchange', onUrlChange);

  // ====================================================================
  //  ✨ v1.1.1: 诊断快捷键 —— Ctrl+Shift+L 输出详细诊断信息
  //  排查"收不到通知"问题时，在 AI 对话页面按此快捷键查看状态
  // ====================================================================

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && (e.key === 'L' || e.key === 'l')) {
      e.preventDefault();
      console.log('%c=== 手动诊断 (Ctrl+Shift+L) ===', 'color: #6366f1; font-weight: bold;');
      if (monitor) {
        monitor.dumpDiagnostics();
      } else {
        console.log('monitor 不存在');
      }
    }
  });

  log('✅ Content script 已加载。按 Ctrl+Shift+L 查看诊断信息。');
})();
