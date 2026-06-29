/**
 * AI Chat Notification - Popup Logic
 * 处理 Popup 界面的交互逻辑
 */

// ====== 站点列表配置 ======
// ✨ v1.2.0: 精简为只支持 Z.AI
const SITES = [
  { key: 'z.ai', name: 'Z.AI', domain: 'chat.z.ai' },
  { key: 'chatglm.cn', name: 'ChatGLM', domain: 'chatglm.cn' }
];

// ====== DOM 元素引用 ======
const masterToggle = document.getElementById('masterToggle');
const soundToggle = document.getElementById('soundToggle');
const hiddenOnlyToggle = document.getElementById('hiddenOnlyToggle');
const debounceSlider = document.getElementById('debounceSlider');
const debounceValue = document.getElementById('debounceValue');
const debounceDesc = document.getElementById('debounceDesc');
const siteList = document.getElementById('siteList');
const testBtn = document.getElementById('testBtn');
const testHint = document.getElementById('testHint');

let currentSettings = null;

// ====== 初始化 ======
async function init() {
  currentSettings = await loadSettings();
  renderSiteList();
  applySettingsToUI();
  bindEvents();
}

// ====== 加载设置 ======
function loadSettings() {
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

// ====== 保存设置 ======
function saveSettings(settings) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ settings }, () => {
      resolve();
    });
  });
}

// ====== 渲染站点列表 ======
function renderSiteList() {
  siteList.innerHTML = '';

  for (const site of SITES) {
    const item = document.createElement('div');
    item.className = 'site-item';

    const enabled = currentSettings.sites?.[site.key] !== false;

    item.innerHTML = `
      <div>
        <span class="site-name">${site.name}</span>
        <span class="site-domain">${site.domain}</span>
      </div>
      <label class="toggle site-toggle" data-site="${site.key}">
        <input type="checkbox" ${enabled ? 'checked' : ''}>
        <span class="toggle-slider"></span>
      </label>
    `;

    siteList.appendChild(item);
  }
}

// ====== 将设置应用到 UI ======
function applySettingsToUI() {
  masterToggle.checked = currentSettings.enabled !== false;
  soundToggle.checked = currentSettings.sound !== false;
  hiddenOnlyToggle.checked = currentSettings.onlyNotifyWhenHidden !== false;
  debounceSlider.value = currentSettings.debounceTime || 1500;
  updateDebounceDisplay();
  updateDisabledState();
}

// ====== 绑定事件 ======
function bindEvents() {
  // 主开关
  masterToggle.addEventListener('change', () => {
    currentSettings.enabled = masterToggle.checked;
    saveSettings(currentSettings);
    updateDisabledState();
  });

  // 提示音开关
  soundToggle.addEventListener('change', () => {
    currentSettings.sound = soundToggle.checked;
    saveSettings(currentSettings);
  });

  // 仅后台通知开关
  hiddenOnlyToggle.addEventListener('change', () => {
    currentSettings.onlyNotifyWhenHidden = hiddenOnlyToggle.checked;
    saveSettings(currentSettings);
  });

  // 防抖时间滑块
  debounceSlider.addEventListener('input', () => {
    updateDebounceDisplay();
  });

  debounceSlider.addEventListener('change', () => {
    const value = parseInt(debounceSlider.value, 10);
    currentSettings.debounceTime = value;
    saveSettings(currentSettings);
  });

  // 站点开关（事件委托）
  siteList.addEventListener('change', (e) => {
    const toggle = e.target.closest('.site-toggle');
    if (!toggle) return;

    const siteKey = toggle.dataset.site;
    const enabled = toggle.querySelector('input').checked;

    if (!currentSettings.sites) {
      currentSettings.sites = {};
    }
    currentSettings.sites[siteKey] = enabled;
    saveSettings(currentSettings);
  });

  // 测试通知按钮
  if (testBtn) {
    testBtn.addEventListener('click', sendTestNotification);
  }
}

// ====== 发送测试通知 ======
async function sendTestNotification() {
  // ✨ v1.1.8 修复：测试通知之前不检查全局开关，导致用户关闭主开关后
  // 测试通知仍能收到，让用户误以为通知功能正常，但实际 AI 回复时收不到。
  // 现在先检查设置，关闭时给出明确提示。
  if (currentSettings && currentSettings.enabled === false) {
    testHint.textContent = '⚠️ 通知已被全局禁用，请先打开上方主开关';
    testHint.style.color = '#f59e0b';
    setTimeout(() => {
      testHint.textContent = '用于验证通知权限是否正常工作';
      testHint.style.color = '';
    }, 3000);
    return;
  }

  testBtn.disabled = true;
  testHint.textContent = '正在发送测试通知...';

  try {
    await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'TEST_NOTIFICATION' }, () => {
        resolve();
      });
    });
    testHint.textContent = '✓ 测试通知已发送，如果没看到请检查系统通知权限';
  } catch (e) {
    testHint.textContent = '✗ 发送失败：' + (e.message || '未知错误');
  } finally {
    setTimeout(() => {
      testBtn.disabled = false;
      testHint.textContent = '用于验证通知权限是否正常工作';
    }, 3000);
  }
}

// ====== 更新防抖时间显示 ======
function updateDebounceDisplay() {
  const seconds = parseInt(debounceSlider.value, 10) / 1000;
  debounceValue.textContent = seconds + 's';
  debounceDesc.textContent = `文本稳定 ${seconds} 秒后判定回复完成`;
}

// ====== 更新禁用状态 ======
function updateDisabledState() {
  if (masterToggle.checked) {
    document.body.classList.remove('disabled');
  } else {
    document.body.classList.add('disabled');
  }
}

// ====== 启动 =====
init();
