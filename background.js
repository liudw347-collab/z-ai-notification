/**
 * AI Chat Notification - Background Service Worker
 * 
 * 负责接收 content script 的消息并创建浏览器通知。
 * 点击通知时自动聚焦到对应的标签页。
 */

// ====== 通知与标签页映射（用于点击通知时聚焦） ======
const notificationTabMap = new Map();

// ====== 默认设置 ======
const DEFAULT_SETTINGS = {
  enabled: true,
  sound: true,
  debounceTime: 1500,
  onlyNotifyWhenHidden: true,
  sites: {
    'z.ai': true,
    'chatglm.cn': true,
    'chatgpt.com': true,
    'chat.openai.com': true,
    'claude.ai': true,
    'gemini.google.com': true,
    'minimax.chat': true,
    'kimi.moonshot.cn': true,
    'deepseek.com': true,
    'chat.deepseek.com': true
  }
};

// ====== 监听来自 content script 的消息 ======
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'AI_RESPONSE_COMPLETE') {
    handleResponseComplete(message.data, sender.tab?.id);
    sendResponse({ ok: true });
  } else if (message.type === 'GET_SETTINGS') {
    chrome.storage.local.get(['settings'], (result) => {
      sendResponse(result.settings || DEFAULT_SETTINGS);
    });
    return true; // 异步响应
  } else if (message.type === 'UPDATE_SETTINGS') {
    chrome.storage.local.set({ settings: message.data }, () => {
      sendResponse({ ok: true });
    });
    return true;
  }
});

// ====== 处理 AI 回复完成事件 ======
function handleResponseComplete(data, tabId) {
  chrome.storage.local.get(['settings'], (result) => {
    const settings = result.settings || DEFAULT_SETTINGS;

    if (!settings.enabled) {
      console.log('[AI Notify] 通知已全局禁用');
      return;
    }

    // 检查该站点是否启用
    const siteKey = getSiteKey(data.url);
    if (siteKey && settings.sites && settings.sites[siteKey] === false) {
      console.log('[AI Notify] 该站点通知已禁用:', siteKey);
      return;
    }

    // 创建通知
    createNotification(data, tabId, settings);
  });
}

// ====== 创建浏览器通知 ======
function createNotification(data, tabId, settings) {
  const notificationId = `ai-notify-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;

  // 保存标签页映射，用于点击通知时聚焦
  if (tabId) {
    notificationTabMap.set(notificationId, tabId);
  }

  const preview = data.preview || 'AI 已完成回复，点击查看详情';

  chrome.notifications.create(notificationId, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: `${data.siteName || 'AI Chat'} - 回复完成`,
    message: preview,
    priority: 2,
    isClickable: true,
    silent: !settings.sound
  }, (createdId) => {
    if (chrome.runtime.lastError) {
      console.error('[AI Notify] 通知创建失败:', chrome.runtime.lastError.message);
    } else {
      console.log('[AI Notify] 通知已发送:', createdId);
      updateBadge();
    }
  });
}

// ====== 处理通知点击 - 聚焦到对应标签页 ======
chrome.notifications.onClicked.addListener((notificationId) => {
  const tabId = notificationTabMap.get(notificationId);

  if (tabId) {
    chrome.tabs.update(tabId, { active: true }, (tab) => {
      if (tab && tab.windowId) {
        chrome.windows.update(tab.windowId, { focused: true });
      }
    });
    // 清理映射
    notificationTabMap.delete(notificationId);
  }

  // 关闭通知
  chrome.notifications.clear(notificationId);
});

// ====== 通知关闭时清理映射 ======
chrome.notifications.onClosed.addListener((notificationId) => {
  notificationTabMap.delete(notificationId);
});

// ====== 更新扩展图标上的徽标 ======
function updateBadge() {
  const count = notificationTabMap.size;
  if (count > 0) {
    chrome.action.setBadgeText({ text: String(count) });
    chrome.action.setBadgeBackgroundColor({ color: '#EF4444' });
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
}

// ====== 从 URL 中提取站点标识 ======
function getSiteKey(url) {
  if (!url) return null;
  try {
    const hostname = new URL(url).hostname;
    const knownKeys = [
      'z.ai', 'chatglm.cn', 'chatgpt.com', 'chat.openai.com',
      'claude.ai', 'gemini.google.com', 'minimax.chat',
      'kimi.moonshot.cn', 'deepseek.com', 'chat.deepseek.com'
    ];
    return knownKeys.find(key => hostname.includes(key.replace('www.', ''))) || null;
  } catch {
    return null;
  }
}

// ====== 首次安装时初始化默认设置 ======
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.storage.local.set({ settings: DEFAULT_SETTINGS }, () => {
      console.log('[AI Notify] 默认设置已初始化');
    });
  }
});