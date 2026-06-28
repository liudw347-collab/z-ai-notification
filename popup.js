/**
 * AI Chat Notification - Popup Logic
 * 处理 Popup 界面的交互逻辑
 */

// ====== 站点列表配置 ======
const SITES = [
  { key: 'z.ai', name: 'Z.AI', domain: 'z.ai' },
  { key: 'chatglm.cn', name: 'ChatGLM', domain: 'chatglm.cn' },
  { key: 'chatgpt.com', name: 'ChatGPT', domain: 'chatgpt.com' },
  { key: 'claude.ai', name: 'Claude', domain: 'claude.ai' },
  { key: 'gemini.google.com', name: 'Gemini', domain: 'gemini.google.com' },
  { key: 'minimax.chat', name: 'MiniMax', domain: 'minimax.chat' },
  { key: 'kimi.moonshot.cn', name: 'Kimi', domain: 'kimi.moonshot.cn' },
  { key: 'deepseek.com', name: 'DeepSeek', domain: 'deepseek.com' }
];

// ====== DOM 元素引用 ======
const masterToggle = document.getElementById('masterToggle');
const soundToggle = document.getElementById('soundToggle');
const hiddenOnlyToggle = document.getElementById('hiddenOnlyToggle');
const debounceSlider = document.getElementById('debounceSlider');
const debounceValue = document.getElementById('debounceValue');
const debounceDesc = document.getElementById('debounceDesc');
const siteList = document.getElementById('siteList');

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
          debounceTime: 3000,
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
  debounceSlider.value = currentSettings.debounceTime || 3000;
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
}

// ====== 更新防抖时间显示 ======
function updateDebounceDisplay() {
  const seconds = parseInt(debounceSlider.value, 10) / 1000;
  debounceValue.textContent = seconds + 's';
  debounceDesc.textContent = `DOM 稳定 ${seconds} 秒后判定回复完成`;
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