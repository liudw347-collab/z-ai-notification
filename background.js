/**
 * AI Chat Notification - Background Service Worker
 *
 * 负责接收 content script 的消息并创建浏览器通知。
 * 点击通知时自动聚焦到对应的标签页。
 *
 * v1.1 修复：
 *   - 将 tabId 直接编码进 notificationId，避免 MV3 Service Worker 被终止后
 *     内存中的映射表丢失，导致通知点击失效。
 */

// ====== 默认设置 ======
// ✨ v1.2.0: 精简为只支持 Z.AI
// ✨ v1.2.1: 移除 onlyNotifyWhenHidden（始终通知，不再检查失焦状态）
const DEFAULT_SETTINGS = {
  enabled: true,
  sound: true,
  debounceTime: 1500,
  sites: {
    'z.ai': true,
    'chatglm.cn': true
  }
};

// ====== 监听来自 content script 的消息 ======
// 注意：MV3 中所有事件监听器必须在顶层同步注册，否则 SW 重启后会丢失。
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'AI_RESPONSE_COMPLETE') {
    handleResponseComplete(message.data, sender.tab?.id);
    sendResponse({ ok: true });
    return false; // 同步响应
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
  } else if (message.type === 'TEST_NOTIFICATION') {
    // Popup 发起的测试通知，使用当前激活标签页（如果有的话）
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs[0]?.id;
      createNotification({
        preview: '这是一条测试通知 —— 如果你看到了它，说明通知权限正常工作。',
        url: tabs[0]?.url || '',
        siteName: '测试通知'
      }, tabId, { sound: true });
    });
    sendResponse({ ok: true });
    return false;
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
//
// ✨ v1.1 关键修复：
//    MV3 service worker 会被随时终止，内存中的 Map 会在 SW 重启后丢失。
//    将 tabId 直接编码进 notificationId，点击时从 ID 解析出 tabId，
//    这样即使 SW 被终止后重启，依然能正确激活目标标签页。
//
//    notificationId 格式: ai-notify-<tabId>-<timestamp>-<random>
function createNotification(data, tabId, settings) {
  const safeTabId = tabId || 0; // 0 表示没有来源 tab（如测试通知）
  const timestamp = Date.now();
  const random = Math.random().toString(36).slice(2, 7);
  const notificationId = `ai-notify-${safeTabId}-${timestamp}-${random}`;

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
      console.log('[AI Notify] 通知已发送:', createdId, '(tabId:', safeTabId + ')');
      updateBadge();
    }
  });
}

// ====== 从 notificationId 中解析 tabId ======
function parseTabIdFromNotificationId(notificationId) {
  // 格式: ai-notify-<tabId>-<timestamp>-<random>
  const parts = notificationId.split('-');
  // ['ai', 'notify', '<tabId>', '<timestamp>', '<random>']
  if (parts.length >= 5 && parts[0] === 'ai' && parts[1] === 'notify') {
    const tabId = parseInt(parts[2], 10);
    return isNaN(tabId) ? null : tabId;
  }
  return null;
}

// ====== 处理通知点击 - 聚焦到对应标签页 ======
chrome.notifications.onClicked.addListener((notificationId) => {
  const tabId = parseTabIdFromNotificationId(notificationId);

  console.log('[AI Notify] 通知被点击, notificationId:', notificationId, '解析 tabId:', tabId);

  if (tabId && tabId > 0) {
    // 先尝试激活 tab
    chrome.tabs.update(tabId, { active: true }, (tab) => {
      if (chrome.runtime.lastError) {
        // tab 可能已关闭
        console.warn('[AI Notify] 激活标签页失败:', chrome.runtime.lastError.message);
        return;
      }
      // 再聚焦到 tab 所在的窗口
      if (tab && tab.windowId) {
        chrome.windows.update(tab.windowId, { focused: true }, () => {
          if (chrome.runtime.lastError) {
            console.warn('[AI Notify] 聚焦窗口失败:', chrome.runtime.lastError.message);
          }
        });
      }
    });
  } else {
    console.log('[AI Notify] 通知没有关联的 tabId，跳过激活');
  }

  // 关闭通知
  chrome.notifications.clear(notificationId);
});

// ====== 通知关闭时更新徽标 ======
chrome.notifications.onClosed.addListener((notificationId) => {
  // 延迟一下再更新徽标，避免和其他 onClosed 事件竞争
  setTimeout(updateBadge, 100);
});

// ====== 更新扩展图标上的徽标 ======
// ✨ v1.1 修复：MV3 中无法依赖内存 Map 统计未读数量，
//    改为查询 Chrome 当前所有未关闭的通知。
function updateBadge() {
  chrome.notifications.getAll((notifications) => {
    const count = Object.keys(notifications).filter(
      (id) => id.startsWith('ai-notify-')
    ).length;
    if (count > 0) {
      chrome.action.setBadgeText({ text: String(count) });
      chrome.action.setBadgeBackgroundColor({ color: '#EF4444' });
    } else {
      chrome.action.setBadgeText({ text: '' });
    }
  });
}

// ====== 从 URL 中提取站点标识 ======
function getSiteKey(url) {
  if (!url) return null;
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    // ✨ v1.2.0: 精简为只支持 z.ai
    const knownKeys = ['chatglm.cn', 'z.ai'];
    if (knownKeys.includes(hostname)) return hostname;
    return knownKeys.find((key) => hostname.endsWith(key) || hostname.includes(key)) || null;
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
  } else if (details.reason === 'update') {
    // 升级时合并新字段，避免老用户设置丢失
    chrome.storage.local.get(['settings'], (result) => {
      const merged = { ...DEFAULT_SETTINGS, ...(result.settings || {}) };
      merged.sites = { ...DEFAULT_SETTINGS.sites, ...((result.settings || {}).sites || {}) };
      chrome.storage.local.set({ settings: merged }, () => {
        console.log('[AI Notify] 设置已升级合并');
      });
    });
  }
});
