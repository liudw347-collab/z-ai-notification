/**
 * AI Chat Notification - Content Script
 * 
 * 核心检测引擎：通过 MutationObserver + 防抖策略检测 AI 回复完成。
 * 
 * v1.1 改进 —— 内容聚焦模式（contentFocused）：
 *   旧方案：监听整个消息容器的所有 DOM 变化 → UI 渲染（按钮、卡片、动画）
 *         会持续重置防抖计时器，导致通知过晚
 *   新方案：只追踪 AI 文本输出区域（如 .markdown-prose）的内容变化，
 *         外围 UI 渲染不再干扰，AI 文字写完即可通知
 */

(function () {
  'use strict';

  const DEBUG = false;
  const log = (...args) => DEBUG && console.log('[🔔 AI Notify]', ...args);

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
          '.regenerate-response-button',
          '[class*="assistant"]',
          '[data-role="assistant"]'
        ],
        streaming: [
          '#loading-message',
          '[class*="cursor"]',
          '[class*="typing"]',
          '[class*="streaming"]',
          '[class*="loading"]',
          '[class*="pulse"]'
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
          '[class*="cursor"]',
          '[class*="result-streaming"]'
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
          '[class*="cursor"]'
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
          '[class*="cursor"]',
          '[class*="typing"]'
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
          '[class*="cursor"]',
          '[class*="typing"]'
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
          '[class*="cursor"]',
          '[class*="typing"]',
          '[class*="streaming"]'
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
      '[class*="cursor"]',
      '[class*="typing"]',
      '[class*="loading"]',
      '[class*="streaming"]'
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

  function getSiteConfig() {
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
    return { name: document.title || 'AI Chat', contentFocused: false, contentSelectors: [], selectors: GENERIC_SELECTORS };
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

  function queryAll(selectors, root) {
    root = root || document;
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
      } catch (e) { /* skip */ }
    }
    return results;
  }

  function isInsideInput(el) {
    if (!el) return false;
    const config = getSiteConfig();
    const inputSelectors = config.selectors.inputArea.join(', ');
    try {
      return !!el.closest(inputSelectors);
    } catch {
      return false;
    }
  }

  function hasStreamingIndicator(el) {
    if (!el) return false;
    const config = getSiteConfig();
    for (const sel of config.selectors.streaming) {
      try {
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

  // ====================================================================
  //  聊天监控器 v1.1 —— 支持内容聚焦模式
  // ====================================================================

  class ChatMonitor {
    constructor() {
      this.siteConfig = getSiteConfig();
      this.observer = null;
      this.debounceTimer = null;
      this.textPollingTimer = null;
      this.lastFingerprint = '';
      this.lastText = '';
      this.lastTextSnapshot = '';
      this.lastTextChangeTime = 0;
      this.chatContainer = null;
      this.active = false;
      this.retryCount = 0;
      this.maxRetries = 15;
      this.retryDelay = 2000;
      this.initCalled = false;
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
      const aiMessages = queryAll(this.siteConfig.selectors.aiMsg);
      if (aiMessages.length === 0) return;

      const latestMsg = aiMessages[aiMessages.length - 1];
      const currentText = getCleanText(latestMsg);

      if (currentText.length < 10) return;

      // 检测文本是否有变化
      if (currentText !== this.lastTextSnapshot) {
        // 文本变了 → AI 还在输出 → 记录时间，重置防抖
        this.lastTextSnapshot = currentText;
        this.lastTextChangeTime = Date.now();
        log('[轮询] 检测到文本变化，长度:', currentText.length);
      } else {
        // 文本没变 → 检查是否已经稳定了足够久
        const elapsed = Date.now() - this.lastTextChangeTime;
        if (this.lastTextChangeTime > 0 && elapsed >= this.debounceTime) {
          // 文本已稳定！但还需要确认不是和上次通知同一条
          const latestFingerprint = getElementFingerprint(latestMsg);
          if (latestFingerprint === this.lastFingerprint && currentText === this.lastText) {
            return; // 同一条消息，跳过
          }

          // 检查流式指示器
          if (hasStreamingIndicator(latestMsg)) {
            log('[轮询] 仍有流式指示器，等待');
            return;
          }

          log('[轮询] ✅ 文本已稳定 ' + (elapsed / 1000).toFixed(1) + 's，准备通知');
          this.lastTextChangeTime = 0; // 防止重复触发
          this.lastFingerprint = latestFingerprint;
          this.lastText = currentText;

          if (this.onlyWhenHidden && document.hasFocus()) {
            log('[轮询] 标签页激活，跳过通知（但更新指纹）');
            return;
          }

          this.sendNotification(currentText);
        }
      }
    }

    // ==================================================================
    //  DOM Mutation 处理（通用模式 + 内容聚焦模式）
    // ==================================================================

    handleMutations(mutations) {
      const significant = mutations.filter((m) => this.isSignificantMutation(m));
      if (significant.length === 0) return;

      log(`检测到 ${significant.length} 个有意义的 DOM 变化`);

      if (this.debounceTimer) clearTimeout(this.debounceTimer);

      this.debounceTimer = setTimeout(() => {
        this.checkForCompletedResponse();
      }, this.debounceTime);
    }

    /**
     * 判断是否为有意义的 DOM 变化
     * 
     * ✨ 内容聚焦模式下：
     *   - 只有在 AI 文本输出区域（.markdown-prose 等）内的变化才算有意义
     *   - 按钮、卡片、动画等外围 UI 的变化被忽略
     *   - 这样 AI 文字写完后，即使 UI 还在渲染，也能及时通知
     */
    isSignificantMutation(mutation) {
      // === 通用过滤（所有模式共用） ===

      // 排除 SCRIPT / STYLE / LINK
      if (mutation.target && mutation.target.nodeType === Node.ELEMENT_NODE) {
        const tag = mutation.target.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'LINK') return false;
        if (isInsideInput(mutation.target)) return false;
      }

      // 排除输入区域内的变动
      if (mutation.target?.parentElement && isInsideInput(mutation.target.parentElement)) {
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
        if (mutation.target.parentElement && isInsideInput(mutation.target.parentElement)) {
          return false;
        }
        return true;
      }

      return false;
    }

    /**
     * ✨ 内容聚焦模式下的 mutation 判定
     * 
     * 只有以下情况才算"有意义"：
     * 1. 新增的节点本身是内容区域元素（.markdown-prose）
     * 2. 新增的节点内包含内容区域元素
     * 3. 文本变化（characterData）发生在内容区域内
     * 4. 内容区域内的子节点变化（新段落、代码块等）
     * 
     * 其他所有变化（按钮渲染、卡片出现、动画、hover 效果等）→ 忽略
     */
    isContentAreaMutation(mutation) {
      const contentSelectors = this.siteConfig.contentSelectors;

      // helper: 检查元素是否在内容区域内
      const isInsideContent = (el) => {
        if (!el) return false;
        for (const sel of contentSelectors) {
          try {
            if (el.closest?.(sel)) return true;
          } catch { /* skip */ }
        }
        return false;
      };

      // helper: 检查元素本身是否匹配内容选择器
      const isContentElement = (el) => {
        if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
        for (const sel of contentSelectors) {
          try {
            if (el.matches?.(sel)) return true;
          } catch { /* skip */ }
        }
        return false;
      };

      // helper: 检查元素内是否包含内容选择器的元素
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
          // 新增的节点本身就是内容元素（如新的 .markdown-prose）
          if (isContentElement(node)) return true;

          // 新增的节点内包含内容元素
          if (containsContentElement(node)) return true;

          // 新增的节点在内容区域内（如内容区域内的子元素）
          if (isInsideContent(node)) return true;
        }
        // 新增的节点都不在内容区域 → UI 渲染噪声 → 忽略
        log('[内容聚焦] 忽略非内容区域的 childList 变化');
        return false;
      }

      // characterData 变化：文本修改
      if (mutation.type === 'characterData') {
        // 只关心内容区域内的文本变化
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
      if (aiMessages.length === 0) { log('未找到 AI 消息'); return; }

      const latestMsg = aiMessages[aiMessages.length - 1];
      const latestText = getCleanText(latestMsg);
      const latestFingerprint = getElementFingerprint(latestMsg);

      log('最新 AI 消息指纹:', latestFingerprint.substring(0, 50), '长度:', latestText.length);

      // 与上次通知的消息相同
      if (latestFingerprint === this.lastFingerprint && latestText === this.lastText) {
        log('与上次通知的消息相同，跳过');
        return;
      }

      // 仍在流式输出
      if (hasStreamingIndicator(latestMsg)) {
        log('检测到流式输出指示器，等待... (2s 后重试)');
        this.debounceTimer = setTimeout(() => this.checkForCompletedResponse(), 2000);
        return;
      }

      // 内容过短
      if (latestText.length < 10) { log('消息内容过短，跳过'); return; }

      // 仅后台通知
      if (this.onlyWhenHidden && document.hasFocus()) {
        log('标签页激活，跳过通知（更新指纹）');
        this.lastFingerprint = latestFingerprint;
        this.lastText = latestText;
        return;
      }

      // ✅ 回复完成
      log('✅ AI 回复完成，发送通知！');
      this.lastFingerprint = latestFingerprint;
      this.lastText = latestText;
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

  let lastUrl = location.href;
  const urlObserver = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      log('URL 变化，重新初始化监控器:', lastUrl);
      monitor.destroy();
      monitor = new ChatMonitor();
      monitor.init();
    }
  });

  if (document.body) {
    urlObserver.observe(document.body, { childList: true, subtree: true });
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      urlObserver.observe(document.body, { childList: true, subtree: true });
    });
  }
})();