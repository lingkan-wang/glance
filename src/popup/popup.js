/**
 * Glance popup — the toolbar button's panel.
 *
 * Its main job beyond the on/off switch: tell the user whether *this* page can
 * actually be translated. A tab opened before the extension was installed has
 * no content script, and silently doing nothing is the worst possible answer.
 */

const ICON = {
  folder:
    'M245,110.64A16,16,0,0,0,232,104H216V88a16,16,0,0,0-16-16H130.67L102.94,51.2a16.14,16.14,0,0,0-9.6-3.2H40A16,16,0,0,0,24,64V208h0a8,8,0,0,0,8,8H211.1a8,8,0,0,0,7.59-5.47l28.49-85.47A16.05,16.05,0,0,0,245,110.64ZM93.34,64,123.2,86.4A8,8,0,0,0,128,88h72v16H69.77a16,16,0,0,0-15.18,10.94L40,158.7V64Zm112,136H43.1l26.67-80H232Z',
  gear: 'M128,80a48,48,0,1,0,48,48A48.05,48.05,0,0,0,128,80Zm0,80a32,32,0,1,1,32-32A32,32,0,0,1,128,160Zm109.94-52.79a8,8,0,0,0-3.89-5.4l-29.83-17-.12-33.62a8,8,0,0,0-2.83-6.08,111.91,111.91,0,0,0-36.72-20.67,8,8,0,0,0-6.46.59L128,41.85,97.88,25a8,8,0,0,0-6.47-.6A112.1,112.1,0,0,0,54.73,45.15a8,8,0,0,0-2.83,6.07l-.15,33.65-29.83,17a8,8,0,0,0-3.89,5.4,106.47,106.47,0,0,0,0,41.56,8,8,0,0,0,3.89,5.4l29.83,17,.12,33.62a8,8,0,0,0,2.83,6.08,111.91,111.91,0,0,0,36.72,20.67,8,8,0,0,0,6.46-.59L128,214.15,158.12,231a7.91,7.91,0,0,0,3.9,1,8.09,8.09,0,0,0,2.57-.42,112.1,112.1,0,0,0,36.68-20.73,8,8,0,0,0,2.83-6.07l.15-33.65,29.83-17a8,8,0,0,0,3.89-5.4A106.47,106.47,0,0,0,237.94,107.21Zm-15,34.91-28.57,16.25a8,8,0,0,0-3,3c-.58,1-1.19,2.06-1.81,3.06a7.94,7.94,0,0,0-1.22,4.21l-.15,32.25a95.89,95.89,0,0,1-25.37,14.3L134,199.13a8,8,0,0,0-3.91-1h-.19c-1.21,0-2.43,0-3.64,0a8.08,8.08,0,0,0-4.1,1l-28.84,16.1A96,96,0,0,1,67.88,201l-.11-32.2a8,8,0,0,0-1.22-4.22c-.62-1-1.23-2-1.8-3.06a8.09,8.09,0,0,0-3-3.06l-28.6-16.29a90.49,90.49,0,0,1,0-28.26L61.67,97.63a8,8,0,0,0,3-3c.58-1,1.19-2.06,1.81-3.06a7.94,7.94,0,0,0,1.22-4.21l.15-32.25a95.89,95.89,0,0,1,25.37-14.3L122,56.87a8,8,0,0,0,4.1,1c1.21,0,2.43,0,3.64,0a8.08,8.08,0,0,0,4.1-1l28.84-16.1A96,96,0,0,1,188.12,55l.11,32.2a8,8,0,0,0,1.22,4.22c.62,1,1.23,2,1.8,3.06a8.09,8.09,0,0,0,3,3.06l28.6,16.29A90.49,90.49,0,0,1,222.9,142.12Z',
};

const ENGINE_LABEL = { google: 'Google', deepl: 'DeepL', openai: 'OpenAI', claude: 'Claude' };

const $ = (id) => document.getElementById(id);

$('iconFolder').innerHTML = `<svg viewBox="0 0 256 256"><path d="${ICON.folder}"/></svg>`;
$('iconGear').innerHTML = `<svg viewBox="0 0 256 256"><path d="${ICON.gear}"/></svg>`;

/* Settings */

chrome.storage.local.get({ enabled: true, engine: 'google' }).then(({ enabled, engine }) => {
  $('enabled').setAttribute('aria-checked', String(!!enabled));
  $('engine').textContent = ENGINE_LABEL[engine] || engine;
});

$('enabled').addEventListener('click', () => {
  const next = $('enabled').getAttribute('aria-checked') !== 'true';
  $('enabled').setAttribute('aria-checked', String(next));
  chrome.storage.local.set({ enabled: next });
});

/* Per-tab readiness */

function setStatus(state, text, { reload = false } = {}) {
  $('status').dataset.state = state;
  $('statusText').textContent = text;
  $('reload').hidden = !reload;
}

async function checkTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  const url = tab.url || '';
  if (url.startsWith('chrome://') || url.startsWith('chrome-extension://') || url.startsWith('https://chrome.google.com/webstore')) {
    setStatus('blocked', '这类页面 Chrome 不允许扩展介入，换个普通网页试试。');
    return;
  }

  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: 'glance:ping' });
    if (res?.alive) {
      setStatus('ready', '本页已生效，划一段英文试试。');
      return;
    }
    throw new Error('no response');
  } catch {
    setStatus('stale', '这个标签页是装扩展之前打开的，刷新一次才会生效。', { reload: true });
    $('reload').onclick = () => {
      chrome.tabs.reload(tab.id);
      window.close();
    };
  }
}

checkTab();

/* Navigation */

$('openViewer').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/viewer/viewer.html') });
  window.close();
});

$('openOptions').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});
