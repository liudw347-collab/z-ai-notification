/**
 * AI Chat Notification - Content Script
 * 
 * 核心检测引擎：通过 MutationObserver + 防抖策略检测 AI 回复完成。
 * 工作原理：
 * 1. 监听聊天区域的 DOM 变化
 * 2. 每次检测到变化时重置防抖计时器
 * 3. 当 DOM 稳定（无新变化）超过设定时间后，判定回复完成
 * 4. 仅在标签页非激活状态时发送通知
 */

(function () {
  'use strict';

  const DEBUG = false;
  const log = (...args) => DEBUG && console.log('[🔔 AI Notify]', ...args);

  // ====================================================================
  //  站点配置：每个 AI 平台的 DOM 选择器
  //  选择器会按顺序尝试，使用第一个匹配到的
  // ====================================================================

  const SITE_PATTERNS = [
    {
      match: /z\.ai|chatglm\.cn/,
      name: 'Z.AI',
      selectors: {
        // 聊天消息容器 —— 我们观察这个区域的 DOM 变化
        chatArea: [
          '[class*="chat-messages"]',
          '[class*="chatMessages"]',
          '[class*="message-list"]',
          '[class*="ChatMessage"]',
          '[class*="messageList"]',
          '[role="log"]',
          '[class*="conversation"]',
          '[class*="Conversation"]',
          'main [class*="flex"] [class*="flex-col"]',
          'main'
        ],
        // AI 回复消息的选择器
        aiMsg: [
          '[data-role="assistant"]',
          '[class*="assistant-message"]',
          '[class*="assistant"]',
          '[class*="ai-message"]',
          '[class*="bot-message"]',
          '[class*="msg-bot"]',
          '[class*="msg-ai"]',
          '[class*="markdown"][class*="prose"]',
          '.markdown-body'
        ],
        // 流式输出/正在输入的指示器
        streaming: [
          '[class*="cursor-blink"]',
          '[class*="typing-indicator"]',
          '[class*="streaming-cursor"]',
          '[class*="loading-dots"]',
          '[class*="pulse-dot"]',
          'span[class*="animate"]'
        ],
        // 用户输入区域（观察时排除这些区域的变动）
        inputArea: [
          'textarea',
          '[contenteditable="true"]',
          '[class*="input-area"]',
          '[class*="editor"]',
          '[class*="compose"]',
          '[class*="prompt-input"]',
          '[class*="ChatInput"]',
          '[role="textbox"]'
        ]
      }
    },
    {
      match: /chatgpt\.com|chat\.openai\.com/,
      name: 'ChatGPT',
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

  // 通用回退配置 —— 当没有匹配到已知站点时使用
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

  /** 获取当前站点的配置 */
  function getSiteConfig() {
    const hostname = window.location.hostname;
    for (const pattern of SITE_PATTERNS) {
      if (pattern.match.test(hostname)) {
        return { name: pattern.name, selectors: pattern.selectors };
      }
    }
    return { name: document.title || 'AI Chat', selectors: GENERIC_SELECTORS };
  }

  /** 按优先级尝试多个选择器，返回第一个匹配的元素 */
  function queryFirst(selectors, root) {
    root = root || document;
    for (const sel of selectors) {
      try {
        const el = root.querySelector(sel);
        if (el) return el;
      } catch (e) {
        /* 无效选择器，跳过 */
      }
    }
    return null;
  }

  /** 按优先级尝试多个选择器，返回所有匹配的元素（去重） */
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
      } catch (e) {
        /* 无效选择器，跳过 */
      }
    }
    return results;
  }

  /** 判断元素是否在输入区域内 */
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

  /** 检查元素或其子元素中是否存在流式输出指示器 */
  function hasStreamingIndicator(el) {
    if (!el) return false;
    const config = getSiteConfig();
    for (const sel of config.selectors.streaming) {
      try {
        if (el.querySelector(sel)) return true;
      } catch {
        /* 忽略 */
      }
    }
    return false;
  }

  /** 获取元素的可读文本（去除多余空白） */
  function getCleanText(el) {
    if (!el) return '';
    return (el.textContent || '').replace(/\s+/g, ' ').trim();
  }

  /** 生成元素的稳定标识符（用于判断是否为同一条消息） */
  function getElementFingerprint(el) {
    if (!el) return '';
    // 优先使用 ID 或 data 属性
    if (el.id) return 'id:' + el.id;
    const dataId = el.getAttribute('data-id') || el.getAttribute('data-message-id');
    if (dataId) return 'data:' + dataId;
    // 回退到内容指纹
    const text = getCleanText(el);
    return 'text:' + text.substring(0, 100);
  }

  // ====================================================================
  //  聊天监控器 —— 核心检测引擎
  // ====================================================================

  class ChatMonitor {
    constructor() {
      this.siteConfig = getSiteConfig();
      this.observer = null;
      this.debounceTimer = null;
      this.lastFingerprint = '';
      this.lastText = '';
      this.chatContainer = null;
      this.active = false;
      this.retryCount = 0;
      this.maxRetries = 15;
      this.retryDelay = 2000;
      this.initCalled = false;
    }

    /** 初始化监控 */
    async init() {
      if (this.initCalled) return;
      this.initCalled = true;

      log('正在初始化，站点:', this.siteConfig.name);

      // 检查该站点是否启用了通知
      const settings = await this.getSettings();
      const hostname = window.location.hostname;
      const siteKey = this.findSiteKey(hostname);

      if (!settings.enabled) {
        log('通知已全局禁用');
        return;
      }
      if (siteKey && settings.sites && settings.sites[siteKey] === false) {
        log('该站点通知已禁用:', siteKey);
        return;
      }

      this.debounceTime = settings.debounceTime || 3000;
      this.onlyWhenHidden = settings.onlyNotifyWhenHidden !== false;

      this.chatContainer = this.findChatContainer();
      if (!this.chatContainer) {
        if (this.retryCount < this.maxRetries) {
          this.retryCount++;
          log(
            `聊天容器未找到，第 ${this.retryCount}/${this.maxRetries} 次重试 (${this.retryDelay}ms 后)...`
          );
          setTimeout(() => this.reInit(), this.retryDelay);
        } else {
          log('已达到最大重试次数，使用 document.body 作为回退容器');
          this.chatContainer = document.body;
          this.startObserving();
        }
        return;
      }

      this.startObserving();
    }

    /** 允许重新初始化（用于 SPA 导航后） */
    reInit() {
      this.initCalled = false;
      this.retryCount = 0;
      this.lastFingerprint = '';
      this.lastText = '';
      this.init();
    }

    /** 查找聊天消息容器 */
    findChatContainer() {
      const selectors = this.siteConfig.selectors.chatArea;
      for (const sel of selectors) {
        try {
          const el = document.querySelector(sel);
          if (el) {
            log('找到聊天容器:', sel, el);
            return el;
          }
        } catch (e) {
          /* 忽略无效选择器 */
        }
      }
      return null;
    }

    /** 启动 MutationObserver */
    startObserving() {
      if (this.observer) {
        this.observer.disconnect();
      }

      this.observer = new MutationObserver((mutations) => {
        this.handleMutations(mutations);
      });

      this.observer.observe(this.chatContainer, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: false
      });

      this.active = true;
      log('监控已启动，容器:', this.chatContainer.tagName, this.chatContainer.className?.substring(0, 60));
    }

    /** 处理 DOM 变化 */
    handleMutations(mutations) {
      // 过滤出有意义的变动
      const significant = mutations.filter((m) => this.isSignificantMutation(m));

      if (significant.length === 0) return;

      log(`检测到 ${significant.length} 个有意义的 DOM 变化`);

      // 重置防抖计时器
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
      }

      this.debounceTimer = setTimeout(() => {
        this.checkForCompletedResponse();
      }, this.debounceTime);
    }

    /**
     * 判断是否为有意义的 DOM 变化
     * 排除：输入区域的变化、纯样式变化、脚本/样式标签的变化
     */
    isSignificantMutation(mutation) {
      // 排除 SCRIPT 和 STYLE 标签
      if (
        mutation.target &&
        mutation.target.nodeType === Node.ELEMENT_NODE
      ) {
        const tag = mutation.target.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'LINK') return false;
        if (isInsideInput(mutation.target)) return false;
      }

      // 排除父节点在输入区域的变动
      if (
        mutation.target &&
        mutation.target.parentElement &&
        isInsideInput(mutation.target.parentElement)
      ) {
        return false;
      }

      // 排除属性变化
      if (mutation.type === 'attributes') return false;

      // childList 变化需要有新增节点
      if (mutation.type === 'childList') {
        return mutation.addedNodes.length > 0;
      }

      // characterData 变化需要排除输入区域
      if (mutation.type === 'characterData') {
        if (
          mutation.target.parentElement &&
          isInsideInput(mutation.target.parentElement)
        ) {
          return false;
        }
        return true;
      }

      return false;
    }

    /**
     * 检查 AI 是否完成了回复
     * 这是核心判断逻辑：
     * 1. 获取最新的 AI 消息
     * 2. 检查是否与上次通知的消息不同（避免重复通知）
     * 3. 检查是否还有流式输出指示器
     * 4. 检查内容长度是否足够
     */
    checkForCompletedResponse() {
      log('检查 AI 回复是否完成...');

      const aiMessages = queryAll(this.siteConfig.selectors.aiMsg);

      if (aiMessages.length === 0) {
        log('未找到 AI 消息');
        return;
      }

      // 获取最新的 AI 消息（列表中的最后一个）
      const latestMsg = aiMessages[aiMessages.length - 1];
      const latestText = getCleanText(latestMsg);
      const latestFingerprint = getElementFingerprint(latestMsg);

      log(
        '最新 AI 消息指纹:',
        latestFingerprint.substring(0, 50),
        '长度:',
        latestText.length
      );

      // 1. 检查是否与上次通知的完全相同
      if (
        latestFingerprint === this.lastFingerprint &&
        latestText === this.lastText
      ) {
        log('与上次通知的消息相同，跳过');
        return;
      }

      // 2. 检查是否仍在流式输出中
      if (hasStreamingIndicator(latestMsg)) {
        log('检测到流式输出指示器，等待完成... (2s 后重试)');
        this.debounceTimer = setTimeout(() => {
          this.checkForCompletedResponse();
        }, 2000);
        return;
      }

      // 3. 检查内容长度（过滤空消息或极短消息）
      if (latestText.length < 10) {
        log('消息内容过短，跳过');
        return;
      }

      // 4. 仅在标签页非激活状态时通知
      if (this.onlyWhenHidden && document.hasFocus()) {
        log('标签页处于激活状态，跳过通知（用户可以看到回复）');
        // 仍然更新指纹，避免下次重复处理
        this.lastFingerprint = latestFingerprint;
        this.lastText = latestText;
        return;
      }

      // ✅ 回复完成！发送通知
      log('✅ AI 回复完成，发送通知！');
      this.lastFingerprint = latestFingerprint;
      this.lastText = latestText;

      this.sendNotification(latestText);
    }

    /** 发送通知请求到 background service worker */
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

    /** 从 storage 获取设置 */
    getSettings() {
      return new Promise((resolve) => {
        chrome.storage.local.get(['settings'], (result) => {
          resolve(
            result.settings || {
              enabled: true,
              sound: true,
              debounceTime: 3000,
              onlyNotifyWhenHidden: true,
              sites: {}
            }
          );
        });
      });
    }

    /** 根据 hostname 找到站点配置 key */
    findSiteKey(hostname) {
      const knownKeys = [
        'z.ai',
        'chatglm.cn',
        'chatgpt.com',
        'chat.openai.com',
        'claude.ai',
        'gemini.google.com',
        'minimax.chat',
        'kimi.moonshot.cn',
        'deepseek.com',
        'chat.deepseek.com'
      ];
      return knownKeys.find((key) => hostname.includes(key)) || null;
    }

    /** 销毁监控器 */
    destroy() {
      if (this.observer) {
        this.observer.disconnect();
        this.observer = null;
      }
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
        this.debounceTimer = null;
      }
      this.active = false;
      log('监控器已销毁');
    }
  }

  // ====================================================================
  //  初始化 & SPA 导航处理
  // ====================================================================

  let monitor = new ChatMonitor();
  monitor.init();

  // 处理 SPA 页面内导航（如从首页进入对话）
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

  // 等 DOM ready 后开始监听 URL 变化
  if (document.body) {
    urlObserver.observe(document.body, { childList: true, subtree: true });
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      urlObserver.observe(document.body, { childList: true, subtree: true });
    });
  }
})();