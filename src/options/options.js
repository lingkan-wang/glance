/** Glance settings — every control writes straight through to storage. */

const DEFAULTS = {
  enabled: true,
  trigger: 'auto',
  target: 'zh-CN',
  engine: 'google',
  theme: 'auto',
  showOriginal: false,
  pdfViewer: true,
  deeplKey: '',
  openaiKey: '',
  openaiBase: 'https://api.openai.com/v1',
  openaiModel: 'gpt-4o-mini',
  claudeKey: '',
  claudeModel: 'claude-opus-5',
};

const fields = Array.from(document.querySelectorAll('[data-key]'));

function syncEngineRows(engine) {
  for (const row of document.querySelectorAll('[data-when]')) {
    row.hidden = row.dataset.when !== engine;
  }
}

function save(key, value) {
  chrome.storage.local.set({ [key]: value });
}

chrome.storage.local.get(DEFAULTS).then((stored) => {
  const settings = { ...DEFAULTS, ...stored };

  for (const node of fields) {
    const key = node.dataset.key;
    const value = settings[key];

    if (node.classList.contains('switch')) {
      node.setAttribute('aria-checked', String(!!value));
      node.addEventListener('click', () => {
        const next = node.getAttribute('aria-checked') !== 'true';
        node.setAttribute('aria-checked', String(next));
        save(key, next);
      });
    } else if (node.tagName === 'SELECT') {
      node.value = value;
      node.addEventListener('change', () => {
        save(key, node.value);
        if (key === 'engine') syncEngineRows(node.value);
      });
    } else {
      node.value = value ?? '';
      node.addEventListener('change', () => save(key, node.value.trim()));
    }
  }

  syncEngineRows(settings.engine);
});
