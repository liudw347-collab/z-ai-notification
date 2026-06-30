/**
 * AI Chat Notification - Content Script
 *
 * 核心检测引擎：通过 MutationObserver + 防抖策略检测 AI 回复完成。
 *
 * v1.1.5 修复重复通知：
 *  19. 之前用 (fingerprint && text) 双重判定"同一条消息"，
 *      但 Svelte/React 应用在流式结束后会重新渲染 UI（代码高亮、
 *      Markdown 解析、按钮出现等），导致 textContent 产生细微变化
 *      （空格/换行/字符规范化），触发重复通知。
 *  20. 新增 notifiedFingerprints Set，按指纹去重：
 *      一条 AI 消息只要指纹不变，无论文本是否细微变化，只通知一次。
 *      Set 大小限制为 50，避免内存泄漏。
 *  21. 指纹优先级调整：id > data-id > 文本前 200 字（之前 100 字太短，
 *      长回复前 100 字可能相同）。
 *
 * v1.1.4 content script 注入修复 + 失焦即通知。
 * v1.1.3 完全放弃流式指示器检测，纯文本驱动。
 * v1.1.2 删除 [class*="cursor"] 选择器。
 * v1.1.1 回退策略 + 诊断快捷键。
 * v1.1.0 queryAll 顺序、初始化快照、document.hidden、缓存配置。
 */

(function () {
  'use strict';

  // ✨ v1.2.0: 默认关闭 DEBUG 日志，减少 F12 噪音。
  //   排查问题时改为 true 即可重新启用详细日志。
  const DEBUG = false;
  // ✨ v1.1.3: 轮询日志限流，避免 F12 被频满。
  let pollLogCounter = 0;
  const log = (...args) => DEBUG && console.log('[🔔 AI Notify]', ...args);
  const warn = (...args) => console.warn('[🔔 AI Notify]', ...args);
  const logThrottled = (...args) => {
    if (!DEBUG) return;
    pollLogCounter++;
    if (pollLogCounter % 10 === 0) {
      console.log('[🔔 AI Notify]', ...args, `(1/10 采样)`);
    }
  };

  // ✨ v1.1.4: 启动时立即输出一条醒目的日志（不受 DEBUG 控制）
  // 这样在 F12 Console 中能看到 content script 是否注入
  console.log('%c[🔔 AI Notify] Content script 已加载于 ' + location.href,
    'background: #6366f1; color: white; padding: 2px 6px; border-radius: 3px;');

  // ====================================================================
  //  站点配置
  // ====================================================================

  // ✨ v1.2.0: 精简为只支持 Z.AI
  //   移除 ChatGPT/Claude/Gemini/MiniMax/Kimi/DeepSeek 等其他站点配置
  //   移除 GENERIC_SELECTORS（未知站点回退用，现在 manifest 已限制只注入 z.ai）
  //   这样代码更精简，加载更快，维护更清晰
  const SITE_PATTERNS = [
    {
      match: /z\.ai|chatglm\.cn/,
      name: 'Z.AI',
      // ✨ 内容聚焦模式：只关注 AI 文本区域的变化，忽略外围 UI
      contentFocused: true,
      // 文本内容区域的 CSS 选择器 —— 只有这些元素内的变化才重置计时器
      contentSelectors: ['.markdown-prose'],
      // ✨ v1.1.10 实测发现 z.ai 真实机制：
      //   - 灰色箭头（disabled=true，class 含 bg-[#E0E0E0]）：空闲，无输入或 AI 已完成
      //   - 黑色箭头（disabled=false，class 含 bg-black/80）：用户输入了消息但未发送
      //   - 按钮消失（#send-message-button 从 DOM 卸载）：AI 正在运行（思考或流式输出）
      //   AI 完成后按钮重新出现，回到 disabled 状态。
      // 关键转换：按钮消失 → 重新出现 = AI 回复完成
      buttonDetection: {
        // 发送按钮的选择器
        buttonSelector: '#send-message-button, button[type="submit"][aria-label*="send" i], button[aria-label*="发送"], button[data-testid*="send" i]',
        // 判断按钮状态，返回三态值
        getState: (btn) => {
          // 按钮不存在 = z.ai 已卸载按钮 = AI 正在运行
          if (!btn) return 'running';
          // 显式禁用属性 → 空闲
          if (btn.disabled) return 'idle';
          if (btn.getAttribute('aria-disabled') === 'true') return 'idle';

          // aria-label/title 信号
          const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
          const title = (btn.getAttribute('title') || '').toLowerCase();
          const dataTestId = (btn.getAttribute('data-testid') || '').toLowerCase();
          const signals = ariaLabel + ' ' + title + ' ' + dataTestId;

          if (/stop|pause|abort|cancel|停止|中断|取消/.test(signals)) return 'running';
          if (/send|submit|发送|提交/.test(signals)) return 'idle';

          // data-state / data-loading 等显式状态属性
          const dataState = (btn.getAttribute('data-state') || '').toLowerCase();
          if (dataState === 'loading' || dataState === 'running') return 'running';
          if (dataState === 'thinking' || dataState === 'reasoning') return 'thinking';
          if (dataState === 'idle' || dataState === 'ready') return 'idle';
          if (btn.getAttribute('data-loading') === 'true') return 'running';
          if (btn.getAttribute('data-streaming') === 'true') return 'running';
          if (btn.getAttribute('data-thinking') === 'true') return 'thinking';

          // SVG 图标特征
          const svg = btn.querySelector('svg');
          if (svg) {
            const svgClass = (svg.className && svg.className.baseVal !== undefined
              ? svg.className.baseVal
              : (svg.className || '')).toString().toLowerCase();
            if (/stop|pause|abort|square/.test(svgClass)) return 'running';
            if (/send|arrow|submit/.test(svgClass)) return 'idle';

            const hasRect = !!svg.querySelector('rect');
            const hasPath = !!svg.querySelector('path');
            if (hasRect && !hasPath) return 'running';
            if (hasPath && !hasRect) return 'idle';
          }

          // 兜底：默认空闲（z.ai 运行中按钮会消失，前面已处理）
          return 'idle';
        }
      },
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
    }
  ];

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
          buttonDetection: pattern.buttonDetection || null,
          selectors: pattern.selectors
        };
      }
    }
    return null;
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
    // ✨ v1.1.3: 这个函数不再用于阻断通知，仅用于诊断信息输出。
    // 真正的流式状态判断改为完全依赖文本变化频率。
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

  /**
   * 获取元素指纹 —— 用于消息去重
   *
   * ✨ v1.1.8 修复：之前只用"文本前 200 字"作为兜底指纹，导致 AI 多次回复
   * 以相同前缀（如"好的，我来帮你..."、"Sure, I can help..."）开头时，
   * 第二条消息被误判为已通知，直接跳过。
   *
   * 新策略（兜底场景）：
   *   - 文本前 100 字 + 文本总长度 + 文本后 50 字
   *   - 长度和后缀都参与指纹，前缀相同但内容不同的消息不再被误判
   *   - 仍保留 id / data-* 等稳定指纹作为最高优先级
   */
  function getElementFingerprint(el) {
    if (!el) return '';
    // ✨ v1.1.5: 优先使用稳定的 id/data-id，避免 UI 重渲染导致指纹变化
    if (el.id) return 'id:' + el.id;
    const dataId = el.getAttribute('data-id') || el.getAttribute('data-message-id')
      || el.getAttribute('data-turn-id') || el.getAttribute('data-response-id');
    if (dataId) return 'data:' + dataId;

    const text = getCleanText(el);
    if (!text) return '';
    // ✨ v1.1.8: 兜底指纹 = 前 100 字 + 长度 + 后 50 字
    //   只用前缀的话，AI 多次"好的，我来..."开头的回复会全部被误判为同一消息
    const len = text.length;
    const prefix = text.substring(0, 100);
    const suffix = len > 150 ? text.substring(len - 50) : '';
    return 'text:' + prefix + '|len=' + len + '|tail=' + suffix;
  }

  /**
   * 判断标签页是否"未聚焦"（应该发通知）
   *
   * ✨ v1.1.4: 语义改为"只要标签页失去焦点就通知"
   * - 之前用 document.visibilityState === 'hidden'，需要用户切到其他标签页
   * - 现在用 !document.hasFocus()，只要窗口失焦就发，更符合用户预期
   * - 包括：切到其他标签页、切到其他应用、点击桌面等
   *
   * 注意：document.hasFocus() 在某些情况下可能不稳定，
   * 这里同时检查 document.visibilityState 作为兑底。
   */
  function isTabUnfocused() {
    // 标签页隐藏（切到其他标签页）→ 未聚焦
    if (document.visibilityState === 'hidden') return true;
    // 窗口失去焦点（切到其他应用、点桌面等）→ 未聚焦
    if (!document.hasFocus()) return true;
    return false;
  }

  /**
   * ✨ v1.1.6: 检查扩展上下文是否仍然有效
   *
   * 扩展被重载/更新/禁用后，旧 content script 中的 chrome.runtime
   * 会变为失效状态，此时调用 chrome.runtime.sendMessage 等会抛出
   * 'Extension context invalidated' 错误。
   *
   * 检测方法：chrome.runtime.id 在上下文失效后会变为 undefined。
   */
  function isExtensionContextValid() {
    try {
      return typeof chrome !== 'undefined' && chrome.runtime && !!chrome.runtime.id;
    } catch (e) {
      return false;
    }
  }

  // ====================================================================
  //  聊天监控器 v1.1 —— 支持内容聚焦模式 + 修复多项 bug
  // ====================================================================

  class ChatMonitor {
    constructor() {
      // ✨ v1.1.4: siteConfig 可能为 null（未知站点），上层处理
      this.siteConfig = buildSiteConfig();
      this.observer = null;
      this.debounceTimer = null;
      this.textPollingTimer = null;
      this.lastFingerprint = '';
      this.lastText = '';
      this.lastTextSnapshot = '';
      this.lastTextChangeTime = 0;
      this.snapshotInitialized = false;
      this.chatContainer = null;
      this.active = false;
      this.retryCount = 0;
      this.maxRetries = 15;
      this.retryDelay = 2000;
      this.initCalled = false;
      this.debounceTime = 1500;
      // ✨ v1.2.2: 上次发送通知的时间戳，用于最小通知间隔保护（1 秒）
      this.lastNotificationTime = 0;
      // ✨ v1.1.5: 已通知过的消息指纹集合，用于去重
      // 防止 Svelte/React UI 重渲染导致 textContent 细微变化触发重复通知
      this.notifiedFingerprints = new Set();
      this.maxNotifiedFingerprints = 50; // 限制大小避免内存泄漏
      // ✨ v1.1.7: 按钮状态监控
      this.buttonObserver = null;
      this.buttonWasRunning = false;
      // ✨ v1.1.10: 按钮状态轮询兜底（防止 observer 漏检按钮重新挂载）
      this.buttonPollingTimer = null;
      // ✨ v1.1.9: 按钮三态值（'running' | 'thinking' | 'idle'），替代旧的 boolean
      this.buttonLastState = 'idle';
      // ✨ v1.1.9: 最小运行时长保护 —— 按钮进入运行/思考状态的时间戳
      // 从运行到空闲必须超过 minRunTimeMs 才视为有效回复，避免瞬态抖动误触发
      this.buttonRunningStartTime = 0;
      this.minRunTimeMs = 800; // 0.8 秒，过滤极短的瞬态状态变化
      // ✨ v1.1.9: 完成检测后延迟二次确认 —— 按钮变 idle 后等待 200ms 再检查一次
      // 避免按钮在思考结束、开始流式输出之间的瞬间闪动误触发通知
      this.buttonConfirmTimer = null;
      this.buttonConfirmDelay = 200;
      this.diagnosticInfo = {
        initTime: Date.now(),
        mutationsReceived: 0,
        significantMutations: 0,
        textPolls: 0,
        notificationsSent: 0,
        skippedVisible: 0,
        skippedDuplicate: 0,
        skippedStreaming: 0,
        // ✨ v1.1.9：新增统计
        skippedThinking: 0,
        skippedTooShort: 0,
        skippedConfirmFail: 0,
        lastPollTime: null,
        lastMutationTime: null,
      };
    }

    /**
     * ✨ v1.1.5: 记录已通知的指纹，自动控制 Set 大小
     */
    markNotified(fingerprint) {
      if (!fingerprint) return;
      // 超过上限时清空集合（保留最近的通知记录）
      // 这种简单策略足以避免内存泄漏，且不影响去重效果
      if (this.notifiedFingerprints.size >= this.maxNotifiedFingerprints) {
        this.notifiedFingerprints.clear();
      }
      this.notifiedFingerprints.add(fingerprint);
    }

    /**
     * ✨ v1.1.5: 检查指纹是否已通知过
     */
    isAlreadyNotified(fingerprint) {
      return fingerprint && this.notifiedFingerprints.has(fingerprint);
    }

    async init() {
      if (this.initCalled) return;
      this.initCalled = true;

      // ✨ v1.1.4: 未知站点提前退出
      if (!this.siteConfig) {
        // 静默退出，不打扰非 AI 网站的用户
        // 但输出一条调试日志便于诊断
        log('未识别的站点，不启动监控:', location.hostname);
        return;
      }

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
          // ✨ v1.1.4: 重试耗尽时输出警告（不受 DEBUG 控制）
          warn('聊天容器未找到（重试已耗尽），使用 document.body 作为回退。' +
            '选择器:', this.siteConfig.selectors.chatArea);
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
      // ✨ v1.1.7: 重置按钮状态
      this.buttonWasRunning = false;
      // ✨ v1.1.9: 重置新的按钮状态字段
      this.buttonLastState = 'idle';
      this.buttonRunningStartTime = 0;
      if (this.buttonConfirmTimer) {
        clearTimeout(this.buttonConfirmTimer);
        this.buttonConfirmTimer = null;
      }
      if (this.buttonPollingTimer) {
        clearInterval(this.buttonPollingTimer);
        this.buttonPollingTimer = null;
      }
      if (this.buttonObserver) { this.buttonObserver.disconnect(); this.buttonObserver = null; }
      // ✨ v1.1.5: SPA 导航时不清空 notifiedFingerprints
      // 因为同一会话内不同 URL 可能仍然引用同一消息
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

      // ✨ v1.1.7: 按钮状态检测 —— 精确判断 AI 运行/完成
      // 比文本轮询更快、更准（文本轮询要等 1.5s 防抖，按钮状态变化是即时的）
      if (this.siteConfig.buttonDetection) {
        this.startButtonMonitoring();
      }

      // ✨ v1.1.12: 按钮检测已是主路径且更可靠，文本轮询在多步思考场景下
      // 会误触发多次通知（每段思考/输出文本稳定 1.5s 都会发一次）。
      // 现在按钮检测可用时直接关闭文本轮询，避免重复通知。
      // 文本轮询只在没有 buttonDetection 的站点才启用。
      const useTextPolling = !this.siteConfig.buttonDetection && this.siteConfig.contentFocused;
      if (useTextPolling) {
        log('未配置按钮检测，启用文本轮询作为兜底');
        this.startTextPolling();
      } else {
        log('按钮检测已启用，关闭文本轮询（避免多步思考时重复通知）');
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

    // ==================================================================
    //  ✨ v1.1.7: 按钮状态监控 —— 精确判断 AI 运行/完成
    //  通过 MutationObserver 监听发送按钮的 disabled 属性和 class 变化
    //  当按钮从"运行中"（黑色方块/停止图标）变回"空闲"（灰色/disabled）时，
    //  立即触发通知，无需等待文本防抖
    // ==================================================================

    startButtonMonitoring() {
      const config = this.siteConfig.buttonDetection;
      if (!config || !config.buttonSelector) return;

      // 查找按钮
      const findButton = () => {
        try {
          return document.querySelector(config.buttonSelector);
        } catch (e) {
          return null;
        }
      };

      // 初始状态
      let button = findButton();
      this.buttonWasRunning = false;

      // ✨ v1.1.8 修复：observer 配置开启了 childList，但回调只处理 attributes。
      // 如果 z.ai 把停止图标整个 SVG 替换成箭头图标（而不是改 disabled/class），
      // 关键状态转换会被漏掉，通知永远发不出。现在 childList 变化也触发检查。
      this.buttonObserver = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          if (mutation.type === 'attributes' &&
              (mutation.attributeName === 'disabled' ||
               mutation.attributeName === 'class' ||
               mutation.attributeName === 'aria-disabled')) {
            this.checkButtonStateChange();
            break;
          }
          // SVG 图标整体替换（childList 变化）—— 也是状态转换的关键信号
          // ✨ v1.1.10：z.ai 在 AI 运行时会整个卸载 #send-message-button，
          // 监听按钮父容器的 childList 才能捕获按钮的"出现/消失"
          if (mutation.type === 'childList' &&
              (mutation.addedNodes.length > 0 || mutation.removedNodes.length > 0)) {
            this.checkButtonStateChange();
            break;
          }
        }
      });

      // ✨ v1.1.10 关键修正：不能直接监听按钮本身！
      //   z.ai 在 AI 运行时会把 #send-message-button 整个从 DOM 卸载，
      //   一旦按钮消失，observer 就失去了观察目标，再也无法检测到按钮重新出现。
      //   正确做法：监听按钮的父容器（或更上层的稳定容器），观察 childList 变化
      //   当父容器的子节点变化时（按钮被卸载或重新挂载），触发状态检查
      const findButtonParent = (btn) => {
        if (!btn) return null;
        // 选择一个相对稳定的父容器（避免选择太靠近的父节点，可能也跟着卸载）
        // 优先选择 button 的直接父级，再退到 grandparent
        let parent = btn.parentElement;
        if (!parent) return null;
        // 检查父级是否有合理的稳定性（有 id 或 class）
        if (parent.id || parent.className) return parent;
        const grandparent = parent.parentElement;
        return grandparent || parent;
      };

      // 尝试观察按钮的父容器，如果按钮还不存在则重试
      const tryObserve = (retryCount = 0) => {
        button = findButton();
        if (button) {
          const target = findButtonParent(button) || button;
          this.buttonObserver.observe(target, {
            attributes: true,
            attributeFilter: ['disabled', 'class', 'aria-disabled'],
            childList: true,  // ✨ v1.1.10: 监听按钮的添加/移除
            subtree: true     // ✨ v1.1.10: 按钮内的 SVG 也可能变化
          });
          log('[按钮监控] 已开始监听（目标:', target.tagName + (target.id ? '#' + target.id : ''),
              '，按钮:', button.tagName + (button.id ? '#' + button.id : ''), '）');
          // 初始检查一次状态
          this.checkButtonStateChange();
        } else if (retryCount < 30) {
          // 按钮可能还没渲染，1 秒后重试
          setTimeout(() => tryObserve(retryCount + 1), 1000);
        } else {
          warn('[按钮监控] 发送按钮未找到，回退到文本轮询模式');
        }
      };

      tryObserve();

      // ✨ v1.1.10: 增加按钮状态轮询作为兜底
      // MutationObserver 监听父容器，但有些站点的按钮可能在另一个独立子树中
      // 被替换，导致 childList 变化没被父容器捕获。每 500ms 轮询一次按钮状态
      // 作为兜底，确保不会错过"运行→空闲"的关键转换。
      if (this.buttonPollingTimer) clearInterval(this.buttonPollingTimer);
      this.buttonPollingTimer = setInterval(() => {
        this.checkButtonStateChange();
      }, 500);
    }

    /**
     * 检查按钮状态变化，如果从"运行中"变为"空闲"，触发通知
     *
     * ✨ v1.1.10 重大修正：
     *   - 移除 `if (!button) return;` 提前退出 —— 按钮消失正是 z.ai 的运行信号！
     *   - 按钮为 null 时调用 getState(null)，getState 会返回 'running'
     *
     * ✨ v1.1.9 重写：
     *   - 用三态值（'running' | 'thinking' | 'idle'）替代 boolean
     *   - thinking 视为"未完成"，思考阶段不会触发通知
     *   - 增加最小运行时长保护（minRunTimeMs=800ms），过滤瞬态抖动
     *   - 增加延迟二次确认（buttonConfirmDelay=200ms），避免按钮短暂闪动误触发
     */
    checkButtonStateChange() {
      // ✨ v1.1.8 修复：扩展重载后旧 content script 的按钮 observer 仍在运行，
      // 调用 sendMessage 会抛 'Extension context invalidated' 错误刷屏。
      // 这里加上下文检查，失效时直接停掉 observer。
      if (!isExtensionContextValid()) {
        if (this.buttonObserver) {
          this.buttonObserver.disconnect();
          this.buttonObserver = null;
        }
        warn('[按钮监控] 扩展上下文已失效，停止按钮监听。请刷新页面以加载新版本。');
        return;
      }

      const config = this.siteConfig.buttonDetection;
      if (!config || !config.getState) return;

      // ✨ v1.1.10 关键修复：不要在按钮消失时直接 return！
      // z.ai 在 AI 运行时整个按钮会从 DOM 卸载，按钮消失正是开始运行的信号。
      // 之前的 `if (!button) return;` 完全错过了这个关键转换。
      // 现在把 null 传给 getState，让它自己决定如何处理（z.ai 的 getState 会返回 'running'）
      const button = document.querySelector(config.buttonSelector);
      const stateNow = config.getState(button);
      const stateBefore = this.buttonLastState;

      // 状态从运行/思考切换到另一个运行/思考状态（如 thinking→running）
      // 不触发完成通知，但记录新的运行开始时间（如果是新进入运行）
      const isRunningOrThinking = (s) => s === 'running' || s === 'thinking';
      const wasRunningOrThinking = isRunningOrThinking(stateBefore);
      const isRunningOrThinkingNow = isRunningOrThinking(stateNow);

      log('[按钮监控] 状态: ' + stateBefore + ' → ' + stateNow +
          ', 运行时长=' + (this.buttonRunningStartTime
            ? ((Date.now() - this.buttonRunningStartTime) / 1000).toFixed(1) + 's'
            : '-'));

      // 进入运行/思考状态 → 记录开始时间
      if (!wasRunningOrThinking && isRunningOrThinkingNow) {
        this.buttonRunningStartTime = Date.now();
        // 取消任何待处理的完成确认
        if (this.buttonConfirmTimer) {
          clearTimeout(this.buttonConfirmTimer);
          this.buttonConfirmTimer = null;
        }
        this.buttonLastState = stateNow;
        return;
      }

      // 思考 → 运行（同属"未完成"状态）→ 仅更新状态
      if (wasRunningOrThinking && isRunningOrThinkingNow) {
        this.buttonLastState = stateNow;
        return;
      }

      // 运行/思考 → 空闲 = AI 回复完成候选信号
      if (wasRunningOrThinking && !isRunningOrThinkingNow) {
        // ✨ 检查 1：最小运行时长保护
        // 如果从运行到空闲的间隔小于 minRunTimeMs，视为瞬态抖动，忽略
        const runDuration = this.buttonRunningStartTime
          ? Date.now() - this.buttonRunningStartTime
          : 0;
        if (runDuration < this.minRunTimeMs) {
          log('[按钮监控] ⏭️ 运行时长仅 ' + runDuration + 'ms (< ' + this.minRunTimeMs +
              'ms)，视为瞬态抖动，忽略');
          this.diagnosticInfo.skippedTooShort++;
          this.buttonLastState = stateNow;
          this.buttonRunningStartTime = 0;
          return;
        }

        // ✨ v1.1.11 修正：移除 isThinkingNow() 检查
        // 之前在这里检查思考指示器，但 z.ai 的 thinking-chain-container 在 AI 回复
        // 完成后仍然保留在 DOM 中（作为可折叠的"Thought Process"面板），
        // 导致 isThinkingNow() 永远返回 true，通知永远发不出。
        // v1.1.10 已确认按钮"消失→重新出现且 disabled"是 z.ai 的可靠完成信号，
        // 不需要额外的思考指示器检查。

        // ✨ v1.2.3 修正：移除 setTimeout 二次确认
        // 之前用 setTimeout(200ms) 做二次确认，但后台标签页的 setTimeout 会被
        // Chrome 节流到几秒甚至更久才执行，导致"需要点回标签页才收到通知"。
        // 现在直接调用 confirmCompletion，由它内部检查按钮状态是否仍为 idle。
        // 如果 confirmCompletion 发现按钮又变回 running（瞬态闪动），会自动跳过。
        log('[按钮监控] ✅ 检测到按钮变 idle，立即确认完成');
        this.buttonLastState = stateNow;
        this.buttonRunningStartTime = 0;
        this.confirmCompletion();
        return;
      }

      // idle → idle，无变化
      this.buttonLastState = stateNow;
    }

    /**
     * ✨ v1.1.9: 二次确认完成 —— 按钮空闲 200ms 后再次检查
     * ✨ v1.1.11: 移除 isThinkingNow() 检查（z.ai 的 thinking-chain-container
     *   在 AI 完成后仍保留在 DOM 中，会导致二次确认永远失败）
     */
    confirmCompletion() {
      const config = this.siteConfig.buttonDetection;
      if (!config || !config.getState) return;

      const button = document.querySelector(config.buttonSelector);
      // ✨ v1.1.11: 按钮不存在时也要检查状态（getState(null) 返回 'running'）
      // 之前 if (!button) return 会导致按钮在二次确认时恰好消失的边界场景漏检
      const stateAfter = config.getState(button);

      // 二次确认失败：按钮又变回运行/思考状态（说明只是瞬态闪动）
      if (stateAfter === 'running' || stateAfter === 'thinking') {
        log('[按钮监控] ⏭️ 二次确认失败：按钮状态为 ' + stateAfter + '，刚才的 idle 是瞬态闪动');
        this.diagnosticInfo.skippedConfirmFail++;
        // 重新记录运行开始时间
        this.buttonRunningStartTime = Date.now();
        this.buttonLastState = stateAfter;
        return;
      }

      log('[按钮监控] ✅✅ 二次确认通过，AI 回复完成！');

      // 获取最新 AI 消息内容用于通知预览
      const aiMessages = queryAll(this.siteConfig.selectors.aiMsg);
      let latestText = '';
      let latestMsg = null;
      if (aiMessages.length > 0) {
        latestMsg = aiMessages[aiMessages.length - 1];
        latestText = getCleanText(latestMsg);
      }

      // 去重检查（与文本轮询共用 notifiedFingerprints）
      const fingerprint = getElementFingerprint(latestMsg);
      if (this.isAlreadyNotified(fingerprint)) {
        log('[按钮监控] 该消息已通知过，跳过');
        return;
      }

      // ✨ v1.2.1: 移除失焦检查 —— 无论标签页是否聚焦都发送通知

      // 发送通知
      this.markNotified(fingerprint);
      this.diagnosticInfo.notificationsSent++;
      if (latestText.length > 0) {
        this.sendNotification(latestText);
      } else {
        this.sendNotification('AI 已完成回复');
      }
    }

    pollLatestAIText() {
      // ✨ v1.1.6: 扩展上下文失效时停止轮询，避免反复报错
      // 这通常发生在扩展被重载/更新后，旧 content script 还在运行
      if (!isExtensionContextValid()) {
        if (this.textPollingTimer) {
          clearInterval(this.textPollingTimer);
          this.textPollingTimer = null;
        }
        warn('扩展上下文已失效（可能被重载），停止轮询。请刷新页面以加载新版本。');
        return;
      }

      this.diagnosticInfo.textPolls++;
      this.diagnosticInfo.lastPollTime = Date.now();

      // ✨ v1.1.11: 移除 isThinkingNow() 检查
      // z.ai 的 thinking-chain-container 在 AI 回复完成后仍保留在 DOM 中，
      // 导致 isThinkingNow() 永远返回 true，文本轮询永远不发通知。
      // 按钮检测（v1.1.10）已经是主检测路径，文本轮询只是兜底。
      // 文本轮询自身的防抖机制（1.5s 文本稳定）+ 指纹去重足以避免误触发。

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
          // 文本已稳定！计算指纹用于去重
          const latestFingerprint = getElementFingerprint(latestMsg);

          // ✨ v1.1.5: 按指纹去重，一条消息只通知一次
          // 之前用 (fingerprint && text) 双重判定，但 Svelte/React UI 重渲染
          // 会导致 textContent 细微变化（空格/换行/字符规范化），
          // 从而使 currentText !== this.lastText 成立，触发重复通知。
          // 现在改为只要指纹已通知过就跳过，无论文本是否细微变化。
          if (this.isAlreadyNotified(latestFingerprint)) {
            logThrottled('[轮询] 该消息已通知过，跳过 (指纹:', latestFingerprint.substring(0, 30) + ')');
            this.diagnosticInfo.skippedDuplicate++;
            this.lastTextChangeTime = 0; // 重置，避免反复进入这个分支
            return;
          }

          // ✨ v1.1.3: 完全放弃流式指示器检查。
          const hasStreaming = !usingFallback &&
              hasStreamingIndicator(latestMsg, this.siteConfig.selectors.streaming);
          if (hasStreaming) {
            logThrottled('[轮询] 检测到流式指示器元素，但文本已稳定，仍准备发通知');
          }

          log('[轮询] ✅ 文本已稳定 ' + (elapsed / 1000).toFixed(1) + 's，准备通知');

          // ✨ v1.2.1: 移除失焦检查 —— 无论标签页是否聚焦都发送通知

          this.lastTextChangeTime = 0; // 防止重复触发
          this.lastFingerprint = latestFingerprint;
          this.lastText = currentText;
          // ✨ v1.1.5: 标记为已通知
          this.markNotified(latestFingerprint);
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
      const aiMessages = this.siteConfig ? queryAll(this.siteConfig.selectors.aiMsg) : [];
      const chatText = this.chatContainer ? getCleanText(this.chatContainer) : '';

      console.group('%c🔔 AI Notify 诊断信息', 'color: #6366f1; font-weight: bold; font-size: 14px;');
      console.log('当前 URL:', window.location.href);
      console.log('当前 hostname:', window.location.hostname);
      console.log('站点配置:', this.siteConfig ? this.siteConfig.name : 'null（未识别站点）');
      if (!this.siteConfig) {
        console.warn('⚠️ 当前站点未识别！content.js 不会启动监控。');
        console.log('提示：检查 content.js 中 SITE_PATTERNS 是否包含当前 hostname');
        console.groupEnd();
        return;
      }
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
      console.log('已通知指纹数量:', this.notifiedFingerprints.size, '/', this.maxNotifiedFingerprints);
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

      logThrottled(`检测到 ${significant.length} 个有意义的 DOM 变化`);

      // ✨ v1.1.3: 内容聚焦模式下完全跳过 MutationObserver 触发的检测，
      // 避免与轮询冲突、产生重复日志。
      // 轮询已经是主检测路径，MutationObserver 在这里只用于诊断统计。
      if (this.siteConfig.contentFocused) {
        return;
      }

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

      // ✨ v1.1.5: 按指纹去重
      if (this.isAlreadyNotified(latestFingerprint)) {
        log('该消息已通知过，跳过');
        return;
      }

      // ✨ v1.1.3: 同样放弃流式指示器检查，仅依赖文本稳定性
      const hasStreaming = !usingFallback &&
          hasStreamingIndicator(latestMsg, this.siteConfig.selectors.streaming);
      if (hasStreaming) {
        log('检测到流式指示器元素，但文本已稳定，仍准备发通知');
      }

      // 内容过短
      if (latestText.length < 2) { log('消息内容过短，跳过'); return; }

      // ✨ v1.2.1: 移除失焦检查 —— 无论标签页是否聚焦都发送通知

      // ✅ 回复完成
      log('✅ AI 回复完成，发送通知！');
      this.lastFingerprint = latestFingerprint;
      this.lastText = latestText;
      // ✨ v1.1.5: 标记为已通知
      this.markNotified(latestFingerprint);
      this.diagnosticInfo.notificationsSent++;
      this.sendNotification(latestText);
    }

    sendNotification(text) {
      // ✨ v1.2.4: 最小通知间隔保护（2 秒）
      // 避免按钮瞬态抖动或多个检测路径同时触发导致短时间内重复通知
      // 距上次通知不足 2 秒时直接跳过
      const now = Date.now();
      if (this.lastNotificationTime && (now - this.lastNotificationTime) < 2000) {
        log('[通知] 距上次通知不足 2 秒，跳过本次通知');
        return;
      }
      this.lastNotificationTime = now;

      // ✨ v1.1.6: 检查扩展上下文是否有效，避免 'Extension context invalidated' 错误
      if (!isExtensionContextValid()) {
        warn('扩展上下文已失效，无法发送通知。请刷新页面。');
        return;
      }
      try {
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
      } catch (e) {
        // 捕获 'Extension context invalidated' 等同步抛出的错误
        warn('发送通知时出错（扩展可能已被重载）:', e.message);
        // 停止轮询，避免反复报错
        if (this.textPollingTimer) {
          clearInterval(this.textPollingTimer);
          this.textPollingTimer = null;
        }
      }
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
      // ✨ v1.2.0: 精简为只支持 z.ai
      const knownKeys = ['z.ai', 'chatglm.cn'];
      return knownKeys.find((key) => hostname.includes(key)) || null;
    }

    destroy() {
      if (this.observer) { this.observer.disconnect(); this.observer = null; }
      if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = null; }
      if (this.textPollingTimer) { clearInterval(this.textPollingTimer); this.textPollingTimer = null; }
      // ✨ v1.1.7: 清理按钮 observer
      if (this.buttonObserver) { this.buttonObserver.disconnect(); this.buttonObserver = null; }
      // ✨ v1.1.9: 清理二次确认计时器
      if (this.buttonConfirmTimer) { clearTimeout(this.buttonConfirmTimer); this.buttonConfirmTimer = null; }
      // ✨ v1.1.10: 清理按钮状态轮询计时器
      if (this.buttonPollingTimer) { clearInterval(this.buttonPollingTimer); this.buttonPollingTimer = null; }
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
