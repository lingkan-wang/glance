/**
 * Glance — background service worker.
 *
 * Owns: settings defaults, the translation engines, an LRU cache, and the
 * PDF -> built-in viewer redirect rules.
 *
 * The content script talks to this over a single long-lived port per page,
 * so a streaming engine can push deltas as they arrive and a superseded
 * request can be aborted the moment the user selects something else.
 */

export const DEFAULTS = {
  enabled: true,
  trigger: 'auto', // auto | alt  (alt = hold ⌥ while releasing the mouse)
  target: 'zh-CN',
  engine: 'google', // google | deepl | openai | claude
  theme: 'auto', // auto | light | dark
  showOriginal: false,
  pdfViewer: true,
  deeplKey: '',
  openaiKey: '',
  openaiBase: 'https://api.openai.com/v1',
  openaiModel: 'gpt-4o-mini',
  claudeKey: '',
  claudeModel: 'claude-opus-5',
};

const MAX_CHARS = 5000;

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

async function getSettings() {
  const stored = await chrome.storage.local.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
}

/* ------------------------------------------------------------------ */
/* LRU cache — the reason a re-selection feels instant                 */
/* ------------------------------------------------------------------ */

const CACHE_LIMIT = 400;
const cache = new Map();

const cacheKey = (s, text) => `${s.engine}|${s.target}|${s.claudeModel}|${s.openaiModel}|${text}`;

function cacheGet(key) {
  if (!cache.has(key)) return null;
  const value = cache.get(key);
  cache.delete(key);
  cache.set(key, value); // refresh recency
  return value;
}

function cacheSet(key, value) {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
}

/* ------------------------------------------------------------------ */
/* Engines                                                             */
/* ------------------------------------------------------------------ */

/** Split on sentence boundaries so each chunk stays under the URL limit. */
function chunk(text, size) {
  if (text.length <= size) return [text];
  const parts = [];
  let rest = text;
  while (rest.length > size) {
    const window = rest.slice(0, size);
    let cut = Math.max(window.lastIndexOf('. '), window.lastIndexOf('? '), window.lastIndexOf('! '));
    if (cut < size * 0.5) cut = window.lastIndexOf(' ');
    if (cut <= 0) cut = size;
    parts.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1);
  }
  if (rest.trim()) parts.push(rest.trim());
  return parts;
}

async function translateGoogle({ text, target, signal }) {
  const out = [];
  for (const part of chunk(text, 1200)) {
    const url =
      'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&dt=t' +
      `&tl=${encodeURIComponent(target)}&q=${encodeURIComponent(part)}`;
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`Google 翻译返回 ${res.status}`);
    const data = await res.json();
    out.push((data[0] || []).map((seg) => seg[0]).join(''));
  }
  return out.join('');
}

async function translateDeepL({ text, target, settings, signal }) {
  if (!settings.deeplKey) throw new Error('未填写 DeepL API Key');
  const free = settings.deeplKey.trim().endsWith(':fx');
  const endpoint = free ? 'https://api-free.deepl.com/v2/translate' : 'https://api.deepl.com/v2/translate';
  const res = await fetch(endpoint, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `DeepL-Auth-Key ${settings.deeplKey.trim()}`,
    },
    body: JSON.stringify({
      text: [text],
      target_lang: target.toUpperCase() === 'ZH-TW' ? 'ZH' : target.split('-')[0].toUpperCase(),
    }),
  });
  if (!res.ok) throw new Error(`DeepL 返回 ${res.status}`);
  const data = await res.json();
  return (data.translations || []).map((t) => t.text).join('');
}

const LANG_NAME = { 'zh-CN': '简体中文', 'zh-TW': '繁體中文', en: 'English', ja: '日本語' };

const systemPrompt = (target) =>
  `你是学术论文翻译引擎。把用户给出的片段翻译成${LANG_NAME[target] || target}。` +
  '要求：忠实、通顺、术语准确；保留公认的英文术语与缩写（如 Transformer、RLHF、p < .05）、' +
  '数字、公式和文献引用标记。只输出译文本身，不要解释、不要复述原文、不要加引号，' +
  '也不要包含任何内部或系统 XML 标签。';

/** Shared SSE reader: yields raw `data:` payload strings. */
async function* sseLines(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('data:')) yield trimmed.slice(5).trim();
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

async function translateOpenAI({ text, target, settings, signal, onDelta }) {
  if (!settings.openaiKey) throw new Error('未填写 OpenAI API Key');
  const res = await fetch(`${settings.openaiBase.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.openaiKey.trim()}`,
    },
    body: JSON.stringify({
      model: settings.openaiModel,
      stream: true,
      messages: [
        { role: 'system', content: systemPrompt(target) },
        { role: 'user', content: text },
      ],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI 返回 ${res.status}`);

  let full = '';
  for await (const payload of sseLines(res)) {
    if (payload === '[DONE]') break;
    let json;
    try {
      json = JSON.parse(payload);
    } catch {
      continue;
    }
    const delta = json.choices?.[0]?.delta?.content;
    if (delta) {
      full += delta;
      onDelta(delta);
    }
  }
  return full;
}

async function translateClaude({ text, target, settings, signal, onDelta }) {
  if (!settings.claudeKey) throw new Error('未填写 Anthropic API Key');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': settings.claudeKey.trim(),
      'anthropic-version': '2023-06-01',
      // Required for calls made from a browser context (extensions included).
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: settings.claudeModel || DEFAULTS.claudeModel,
      max_tokens: 4096,
      stream: true,
      // A translation needs no deliberation; thinking only adds latency here.
      // Disabled thinking is accepted at effort `high` or below.
      thinking: { type: 'disabled' },
      output_config: { effort: 'low' },
      system: systemPrompt(target),
      messages: [{ role: 'user', content: text }],
    }),
  });
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.json())?.error?.message || '';
    } catch {
      /* body already consumed or not JSON */
    }
    throw new Error(`Anthropic 返回 ${res.status}${detail ? `：${detail}` : ''}`);
  }

  let full = '';
  for await (const payload of sseLines(res)) {
    let json;
    try {
      json = JSON.parse(payload);
    } catch {
      continue;
    }
    if (json.type === 'content_block_delta' && json.delta?.type === 'text_delta') {
      full += json.delta.text;
      onDelta(json.delta.text);
    } else if (json.type === 'message_delta' && json.delta?.stop_reason === 'refusal') {
      throw new Error('模型拒绝了这段内容');
    } else if (json.type === 'error') {
      throw new Error(json.error?.message || 'Anthropic 流式错误');
    }
  }
  return full;
}

const ENGINES = {
  google: translateGoogle,
  deepl: translateDeepL,
  openai: translateOpenAI,
  claude: translateClaude,
};

const ENGINE_LABEL = { google: 'Google', deepl: 'DeepL', openai: 'OpenAI', claude: 'Claude' };

/* ------------------------------------------------------------------ */
/* Port protocol                                                       */
/* ------------------------------------------------------------------ */

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'glance') return;
  const inflight = new Map();

  port.onMessage.addListener(async (msg) => {
    if (msg?.type === 'cancel') {
      inflight.get(msg.id)?.abort();
      inflight.delete(msg.id);
      return;
    }
    if (msg?.type !== 'translate') return;

    const { id } = msg;
    const controller = new AbortController();
    inflight.set(id, controller);

    const post = (payload) => {
      try {
        port.postMessage(payload);
      } catch {
        /* page navigated away */
      }
    };

    try {
      const settings = await getSettings();
      // The lens already normalised the selection; this is just a hard ceiling.
      const text = String(msg.text || '')
        .trim()
        .slice(0, MAX_CHARS);
      if (!text) throw new Error('没有可翻译的文本');

      const label = ENGINE_LABEL[settings.engine] || settings.engine;
      const key = cacheKey(settings, text);
      const hit = cacheGet(key);
      if (hit) {
        post({ type: 'done', id, text: hit, source: text, engine: label, cached: true });
        return;
      }

      post({ type: 'start', id, source: text, engine: label });

      const engine = ENGINES[settings.engine] || translateGoogle;
      const result = await engine({
        text,
        target: settings.target,
        settings,
        signal: controller.signal,
        onDelta: (delta) => post({ type: 'delta', id, text: delta }),
      });

      const trimmed = (result || '').trim();
      if (trimmed) cacheSet(key, trimmed);
      post({ type: 'done', id, text: trimmed, source: text, engine: label, cached: false });
    } catch (err) {
      if (err?.name !== 'AbortError') {
        post({ type: 'error', id, message: err?.message || String(err) });
      }
    } finally {
      inflight.delete(id);
    }
  });

  port.onDisconnect.addListener(() => {
    for (const controller of inflight.values()) controller.abort();
    inflight.clear();
  });
});

/* ------------------------------------------------------------------ */
/* PDF redirect                                                        */
/* ------------------------------------------------------------------ */

const RULE_IDS = [1, 2];

async function syncPdfRules() {
  const { pdfViewer } = await getSettings();
  const viewer = chrome.runtime.getURL('src/viewer/viewer.html');

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: RULE_IDS,
    addRules: pdfViewer
      ? [
          {
            id: 1,
            priority: 1,
            action: { type: 'redirect', redirect: { regexSubstitution: `${viewer}?file=\\0` } },
            condition: {
              // DNR regexes are case-sensitive, and plenty of servers hand out `.PDF`.
              regexFilter: '^https?://[^?#]+\\.[pP][dD][fF]([?#].*)?$',
              resourceTypes: ['main_frame'],
            },
          },
          {
            // arXiv serves PDFs from extensionless paths.
            id: 2,
            priority: 1,
            action: { type: 'redirect', redirect: { regexSubstitution: `${viewer}?file=\\0` } },
            condition: {
              regexFilter: '^https?://([^/]*\\.)?arxiv\\.org/pdf/[^?#]+$',
              resourceTypes: ['main_frame'],
            },
          },
        ]
      : [],
  });
}

/**
 * Content scripts only reach pages loaded *after* the extension is installed,
 * so a fresh install silently does nothing on every tab already open. Inject
 * into them once so the first thing the user tries actually works.
 */
async function injectIntoOpenTabs() {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  } catch {
    return;
  }
  await Promise.all(
    tabs.map((tab) =>
      chrome.scripting
        .executeScript({
          target: { tabId: tab.id, allFrames: true },
          files: ['src/lens/lens.js'],
        })
        .catch(() => {}), // chrome:// pages, the web store, and PDFs will refuse
    ),
  );
}

chrome.runtime.onInstalled.addListener(() => {
  syncPdfRules();
  injectIntoOpenTabs();
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'glance-translate',
      title: '用 Glance 翻译“%s”',
      contexts: ['selection'],
    });
  });
});

chrome.runtime.onStartup?.addListener(syncPdfRules);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.pdfViewer) syncPdfRules();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'glance-translate' && tab?.id != null) {
    chrome.tabs.sendMessage(tab.id, { type: 'glance:translate-selection' }).catch(() => {});
  }
});

// The toolbar button opens the popup (see manifest `action.default_popup`);
// the popup is what routes to the reader and the settings page.
