/**
 * Glance — the selection lens.
 *
 * Runs as a content script on every page and is also loaded directly by the
 * bundled PDF viewer, so one code path serves both. Everything lives in a
 * shadow root so page CSS cannot reach it and it cannot reach the page.
 *
 * Cleanup contract: every listener, timer and rAF is owned by `controller`
 * (AbortController) or tracked below, and released in `destroy()`.
 */
(() => {
  if (window.__glanceLens) return;
  window.__glanceLens = true;

  const HAS_RUNTIME = typeof chrome !== 'undefined' && chrome.runtime?.id;

  const DEFAULTS = {
    enabled: true,
    trigger: 'auto',
    theme: 'auto',
    showOriginal: false,
    target: 'zh-CN',
  };

  let settings = { ...DEFAULTS };

  /* ---------------------------------------------------------------- */
  /* Icons — Phosphor (regular), 256 viewBox                           */
  /* ---------------------------------------------------------------- */

  const ICON = {
    copy: 'M216,32H88a8,8,0,0,0-8,8V80H40a8,8,0,0,0-8,8V216a8,8,0,0,0,8,8H168a8,8,0,0,0,8-8V176h40a8,8,0,0,0,8-8V40A8,8,0,0,0,216,32ZM160,208H48V96H160Zm48-48H176V88a8,8,0,0,0-8-8H96V48H208Z',
    check:
      'M229.66,77.66l-128,128a8,8,0,0,1-11.32,0l-56-56a8,8,0,0,1,11.32-11.32L96,188.69,218.34,66.34a8,8,0,0,1,11.32,11.32Z',
    original:
      'M87.24,52.59a8,8,0,0,0-14.48,0l-64,136a8,8,0,1,0,14.48,6.81L39.9,160h80.2l16.66,35.4a8,8,0,1,0,14.48-6.81ZM47.43,144,80,74.79,112.57,144ZM200,96c-12.76,0-22.73,3.47-29.63,10.32a8,8,0,0,0,11.26,11.36c3.8-3.77,10-5.68,18.37-5.68,13.23,0,24,9,24,20v3.22A42.76,42.76,0,0,0,200,128c-22.06,0-40,16.15-40,36s17.94,36,40,36a42.73,42.73,0,0,0,24-7.25,8,8,0,0,0,16-.75V132C240,112.15,222.06,96,200,96Zm0,88c-13.23,0-24-9-24-20s10.77-20,24-20,24,9,24,20S213.23,184,200,184Z',
    close:
      'M205.66,194.34a8,8,0,0,1-11.32,11.32L128,139.31,61.66,205.66a8,8,0,0,1-11.32-11.32L116.69,128,50.34,61.66A8,8,0,0,1,61.66,50.34L128,116.69l66.34-66.35a8,8,0,0,1,11.32,11.32L139.31,128Z',
    speak:
      'M155.51,24.81a8,8,0,0,0-8.42.88L77.25,80H32A16,16,0,0,0,16,96v64a16,16,0,0,0,16,16H77.25l69.84,54.31A8,8,0,0,0,160,224V32A8,8,0,0,0,155.51,24.81ZM32,96H72v64H32ZM144,207.64,88,164.09V91.91l56-43.55Zm54-106.08a40,40,0,0,1,0,52.88,8,8,0,0,1-12-10.58,24,24,0,0,0,0-31.72,8,8,0,0,1,12-10.58ZM248,128a79.9,79.9,0,0,1-20.37,53.34,8,8,0,0,1-11.92-10.67,64,64,0,0,0,0-85.33,8,8,0,1,1,11.92-10.67A79.83,79.83,0,0,1,248,128Z',
  };

  const icon = (name) =>
    `<svg viewBox="0 0 256 256" aria-hidden="true" focusable="false"><path d="${ICON[name]}"/></svg>`;

  /* ------------------------------------------------------------------ */
  /* Text normalisation                                                  */
  /* ------------------------------------------------------------------ */

  const LIGATURES = { 'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬀ': 'ff', 'ﬃ': 'ffi', 'ﬄ': 'ffl', 'ﬅ': 'ft', 'ﬆ': 'st' };

  /**
   * PDF text layers hand you hard line breaks and hyphenated words. Feeding
   * that to a translator straight produces garbage, so undo the typesetting
   * before anything else touches the string.
   */
  function normalize(raw) {
    let t = String(raw)
      .replace(/[­​‌‍﻿]/g, '')
      .replace(/[ﬁﬂﬀﬃﬄﬅﬆ]/g, (c) => LIGATURES[c])
      .replace(/[‘’]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/\r\n?/g, '\n');

    // "technology-\nsupported" -> "technologysupported" is wrong; the hyphen is
    // a line-break artefact only when the continuation is lowercase.
    t = t.replace(/([A-Za-z])[-‐‑]\n\s*([a-z])/g, '$1$2');
    t = t.replace(/\s*\n\s*/g, ' ');
    return t.replace(/[ \t ]{2,}/g, ' ').trim();
  }

  /* ---------------------------------------------------------------- */
  /* Styles                                                            */
  /* ---------------------------------------------------------------- */

  const CSS = `
:host { all: initial; }

.layer {
  position: fixed;
  inset: 0;
  z-index: 2147483646;
  pointer-events: none;
  --bg: rgba(252, 252, 253, 0.72);
  --bg-solid: #fcfcfd;
  --hairline: rgba(0, 0, 0, 0.09);
  --sheen: rgba(255, 255, 255, 0.75);
  --ink: #12131a;
  --ink-dim: rgba(18, 19, 26, 0.5);
  --ink-faint: rgba(18, 19, 26, 0.32);
  --hover: rgba(18, 19, 26, 0.06);
  --accent: #0071e3;
  --shadow: 0 12px 34px rgba(15, 17, 26, 0.14), 0 2px 8px rgba(15, 17, 26, 0.07);
  --ease-out: cubic-bezier(0.23, 1, 0.32, 1);
}

.layer[data-theme="dark"] {
  --bg: rgba(32, 32, 35, 0.74);
  --bg-solid: #202023;
  --hairline: rgba(255, 255, 255, 0.11);
  --sheen: rgba(255, 255, 255, 0.14);
  --ink: #f2f2f5;
  --ink-dim: rgba(242, 242, 245, 0.56);
  --ink-faint: rgba(242, 242, 245, 0.36);
  --hover: rgba(255, 255, 255, 0.08);
  --accent: #0a84ff;
  --shadow: 0 16px 40px rgba(0, 0, 0, 0.44), 0 2px 10px rgba(0, 0, 0, 0.28);
}

.pop {
  position: absolute;
  top: 0;
  left: 0;
  box-sizing: border-box;
  width: max-content;
  min-width: 216px;
  max-width: min(384px, calc(100vw - 24px));
  pointer-events: auto;
  border-radius: 14px;
  border: 0.5px solid var(--hairline);
  background: var(--bg);
  -webkit-backdrop-filter: blur(30px) saturate(180%);
  backdrop-filter: blur(30px) saturate(180%);
  box-shadow: var(--shadow), inset 0 0.5px 0 var(--sheen);
  color: var(--ink);
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC",
    "Helvetica Neue", "Segoe UI", sans-serif;
  opacity: 0;
  transform: translate3d(0, 0, 0) scale(0.96);
  transition: opacity 180ms var(--ease-out), transform 180ms var(--ease-out);
  will-change: transform, opacity;
  overflow: hidden;
}

.pop[data-open="true"] { opacity: 1; transform: translate3d(var(--x), var(--y), 0) scale(1); }
.pop[data-closing="true"] { opacity: 0; transform: translate3d(var(--x), var(--y), 0) scale(0.98); transition-duration: 120ms; }
.pop[data-tracking="true"] { transition-duration: 0ms; }

@media (prefers-reduced-transparency: reduce) {
  .pop { background: var(--bg-solid); -webkit-backdrop-filter: none; backdrop-filter: none; }
}

.body {
  padding: 13px 15px 11px;
  font-size: 14.5px;
  line-height: 1.58;
  letter-spacing: 0.005em;
  -webkit-user-select: text;
  user-select: text;
}

.zh { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.zh:empty { display: none; }

.source {
  display: flex;
  align-items: flex-start;
  gap: 4px;
  margin: 9px 0 0;
  padding-top: 9px;
  border-top: 0.5px solid var(--hairline);
}
.source[hidden] { display: none; }

.source-text {
  flex: 1;
  min-width: 0;
  margin: 0;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--ink-dim);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

/* Sits on the first line of the original, so pronunciation is one click from
   the word itself rather than parked in the toolbar. */
.btn-speak {
  width: 24px;
  height: 24px;
  margin: -3px -5px 0 0;
}
.btn-speak svg { width: 15px; height: 15px; }

/* While speaking, the icon stays a speaker and simply breathes. Swapping in a
   crossed-out speaker reads as "muted", which is the opposite of what happened. */
.btn-speak[data-on="true"] { color: var(--accent); }
.btn-speak[data-on="true"] svg { animation: breathe 1150ms ease-in-out infinite; }
@keyframes breathe { 50% { opacity: 0.4; } }

.error { margin: 0; font-size: 13px; color: var(--ink-dim); }

/* Loading: bars shaped like the answer, with a sheen sweeping across. */
.skeleton { display: grid; gap: 8px; padding: 3px 0 5px; }
.skeleton[hidden] { display: none; }
.bar {
  height: 9px;
  border-radius: 5px;
  background: var(--hover);
  position: relative;
  overflow: hidden;
}
.bar:nth-child(1) { width: 100%; }
.bar:nth-child(2) { width: 92%; }
.bar:nth-child(3) { width: 58%; }
.bar::after {
  content: "";
  position: absolute;
  inset: 0;
  transform: translate3d(-100%, 0, 0);
  background: linear-gradient(90deg, transparent, var(--sheen), transparent);
  animation: sweep 1150ms var(--ease-out) infinite;
}
.bar:nth-child(2)::after { animation-delay: 90ms; }
.bar:nth-child(3)::after { animation-delay: 180ms; }
@keyframes sweep { to { transform: translate3d(100%, 0, 0); } }

.bar-row {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 0 8px 8px 15px;
}

.engine {
  flex: 1;
  font-size: 11px;
  letter-spacing: 0.02em;
  color: var(--ink-faint);
  -webkit-user-select: none;
  user-select: none;
}

button {
  appearance: none;
  border: 0;
  margin: 0;
  padding: 0;
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  border-radius: 8px;
  background: transparent;
  color: var(--ink-dim);
  cursor: default;
  transition: transform 140ms var(--ease-out), background-color 140ms ease, color 140ms ease;
}
button svg { width: 16px; height: 16px; fill: currentColor; transition: filter 180ms ease, opacity 180ms ease; }
button[data-on="true"] { color: var(--accent); }
button:active { transform: scale(0.94); }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
button.swapping svg { filter: blur(2px); opacity: 0.4; }

@media (hover: hover) and (pointer: fine) {
  button:hover { background: var(--hover); color: var(--ink); }
  button[data-on="true"]:hover { color: var(--accent); }
}

@media (prefers-reduced-motion: reduce) {
  .pop { transition-property: opacity; transform: translate3d(var(--x), var(--y), 0); }
  .pop[data-open="true"], .pop[data-closing="true"] { transform: translate3d(var(--x), var(--y), 0); }
  .bar::after { animation: none; }
  /* Colour alone still says "speaking". */
  .btn-speak[data-on="true"] svg { animation: none; }
}
`;

  /* ---------------------------------------------------------------- */
  /* Element construction                                              */
  /* ---------------------------------------------------------------- */

  const controller = new AbortController();
  const { signal } = controller;

  let host = null;
  let shadow = null;
  let layer = null;
  let pop = null;
  let zhEl = null;
  let sourceEl = null;
  let skeletonEl = null;
  let errorEl = null;
  let engineEl = null;
  let sourceTextEl = null;
  let btnSource = null;
  let btnCopy = null;
  let btnSpeak = null;

  let open = false;
  let range = null; // live-ish clone of the selection, used to re-anchor on scroll
  let reqId = 0;
  let currentText = '';
  let currentSource = '';
  let closeTimer = null;
  let evalTimer = null;
  let copyTimer = null;
  let trackTimer = null;
  let rafId = 0;
  let port = null;

  function build() {
    host = document.createElement('glance-lens');
    host.style.cssText = 'all:initial;position:static;';
    shadow = host.attachShadow({ mode: 'closed' });

    const style = document.createElement('style');
    style.textContent = CSS;

    layer = document.createElement('div');
    layer.className = 'layer';
    layer.innerHTML = `
      <div class="pop" role="dialog" aria-live="polite" data-open="false">
        <div class="body">
          <div class="skeleton" aria-hidden="true"><i class="bar"></i><i class="bar"></i><i class="bar"></i></div>
          <p class="zh"></p>
          <p class="error" hidden></p>
          <div class="source" hidden>
            <p class="source-text"></p>
            <button class="btn-speak" type="button" title="朗读原文" aria-label="朗读原文">${icon('speak')}</button>
          </div>
        </div>
        <div class="bar-row">
          <span class="engine"></span>
          <button class="btn-source" type="button" title="显示原文" aria-label="显示原文">${icon('original')}</button>
          <button class="btn-copy" type="button" title="复制译文" aria-label="复制译文">${icon('copy')}</button>
          <button class="btn-close" type="button" title="关闭" aria-label="关闭">${icon('close')}</button>
        </div>
      </div>`;

    shadow.append(style, layer);
    pop = layer.querySelector('.pop');
    zhEl = layer.querySelector('.zh');
    sourceEl = layer.querySelector('.source');
    sourceTextEl = layer.querySelector('.source-text');
    skeletonEl = layer.querySelector('.skeleton');
    errorEl = layer.querySelector('.error');
    engineEl = layer.querySelector('.engine');
    btnSource = layer.querySelector('.btn-source');
    btnCopy = layer.querySelector('.btn-copy');
    btnSpeak = layer.querySelector('.btn-speak');

    btnSource.addEventListener('click', toggleSource, { signal });
    btnCopy.addEventListener('click', copy, { signal });
    btnSpeak.addEventListener('click', speak, { signal });
    layer.querySelector('.btn-close').addEventListener('click', () => close(), { signal });
    // Keep a click inside the popover from counting as "clicked away".
    pop.addEventListener('mousedown', (e) => e.stopPropagation(), { signal });

    applyTheme();
    (document.body || document.documentElement).appendChild(host);
  }

  function applyTheme() {
    if (!layer) return;
    // Inside the bundled reader, "auto" means "whatever the reader is set to" —
    // a white popover over a night-mode page would be the only bright thing on
    // screen.
    const inViewer = document.documentElement.dataset.glance === 'viewer';
    const dark =
      settings.theme === 'dark' ||
      (settings.theme === 'auto' &&
        (inViewer
          ? document.body.dataset.theme === 'dark'
          : matchMedia('(prefers-color-scheme: dark)').matches));
    layer.dataset.theme = dark ? 'dark' : 'light';
  }

  /* ---------------------------------------------------------------- */
  /* Positioning                                                       */
  /* ---------------------------------------------------------------- */

  const GAP = 10;
  const EDGE = 8;

  function anchorRect() {
    if (!range) return null;
    const rects = Array.from(range.getClientRects()).filter((r) => r.width || r.height);
    if (!rects.length) {
      const r = range.getBoundingClientRect();
      return r.width || r.height ? r : null;
    }
    const top = Math.min(...rects.map((r) => r.top));
    const bottom = Math.max(...rects.map((r) => r.bottom));
    const left = Math.min(...rects.map((r) => r.left));
    const right = Math.max(...rects.map((r) => r.right));
    return { top, bottom, left, right, width: right - left, height: bottom - top };
  }

  /**
   * Place the popover above the selection when there is room, below otherwise,
   * and point `transform-origin` at the selection so it scales out of the text
   * rather than out of nowhere.
   */
  function place({ animate = false } = {}) {
    const rect = anchorRect();
    if (!rect) return false;

    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    if (rect.bottom < -40 || rect.top > vh + 40) return false;

    // Layout size, not the transformed box: the popover is scaled while entering.
    const width = pop.offsetWidth;
    const height = pop.offsetHeight;
    const above = rect.top - GAP - height >= EDGE;
    const y = above ? rect.top - GAP - height : Math.min(rect.bottom + GAP, vh - EDGE - height);

    const anchorX = Math.min(Math.max(rect.left + rect.width / 2, EDGE), vw - EDGE);
    const x = Math.min(Math.max(anchorX - width / 2, EDGE), Math.max(EDGE, vw - EDGE - width));

    if (!animate) pop.dataset.tracking = 'true';
    pop.style.setProperty('--x', `${Math.round(x)}px`);
    pop.style.setProperty('--y', `${Math.round(y)}px`);
    pop.style.transformOrigin = `${Math.round(anchorX - x)}px ${above ? height : 0}px`;
    if (!animate) {
      clearTimeout(trackTimer);
      trackTimer = setTimeout(() => {
        if (pop) delete pop.dataset.tracking;
      }, 60);
    }
    return true;
  }

  function track() {
    if (!open || rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      if (!open) return;
      if (!place()) close();
    });
  }

  /* ---------------------------------------------------------------- */
  /* Open / close                                                      */
  /* ---------------------------------------------------------------- */

  function show(sourceRange) {
    if (!host) build();
    clearTimeout(closeTimer);
    range = sourceRange;

    const reopening = open;
    delete pop.dataset.closing;

    stopSpeech();
    zhEl.textContent = '';
    errorEl.hidden = true;
    errorEl.textContent = '';
    sourceEl.hidden = true;
    sourceTextEl.textContent = '';
    skeletonEl.hidden = false;
    engineEl.textContent = '';
    btnSource.dataset.on = String(!!settings.showOriginal);

    if (!reopening) {
      pop.dataset.open = 'false';
      pop.style.setProperty('--x', '-9999px');
      pop.style.setProperty('--y', '-9999px');
    }

    open = true;
    // Measure after the skeleton is in the DOM, then reveal.
    requestAnimationFrame(() => {
      if (!open) return;
      if (!place({ animate: reopening })) {
        close();
        return;
      }
      pop.dataset.open = 'true';
    });
  }

  function close() {
    if (!open) return;
    open = false;
    range = null;
    cancelRequest();
    stopSpeech();
    if (!pop) return;
    pop.dataset.closing = 'true';
    pop.dataset.open = 'false';
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      if (open || !pop) return;
      delete pop.dataset.closing;
      pop.style.setProperty('--x', '-9999px');
      pop.style.setProperty('--y', '-9999px');
    }, 200);
  }

  /* ---------------------------------------------------------------- */
  /* Translation transport                                             */
  /* ---------------------------------------------------------------- */

  function connect() {
    if (!HAS_RUNTIME || port) return port;
    try {
      port = chrome.runtime.connect({ name: 'glance' });
    } catch {
      return null;
    }
    port.onMessage.addListener(onPortMessage);
    port.onDisconnect.addListener(() => {
      port = null;
    });
    return port;
  }

  function onPortMessage(msg) {
    if (!open || msg.id !== reqId) return;
    if (msg.type === 'start') {
      currentSource = msg.source;
      engineEl.textContent = msg.engine;
    } else if (msg.type === 'delta') {
      skeletonEl.hidden = true;
      currentText += msg.text;
      zhEl.textContent = currentText;
      track();
    } else if (msg.type === 'done') {
      skeletonEl.hidden = true;
      currentText = msg.text;
      currentSource = msg.source;
      zhEl.textContent = msg.text;
      engineEl.textContent = msg.cached ? `${msg.engine} · 缓存` : msg.engine;
      if (settings.showOriginal) revealSource(true);
      track();
    } else if (msg.type === 'error') {
      skeletonEl.hidden = true;
      errorEl.hidden = false;
      errorEl.textContent = msg.message;
      track();
    }
  }

  function cancelRequest() {
    if (port && reqId) {
      try {
        port.postMessage({ type: 'cancel', id: reqId });
      } catch {
        /* port already gone */
      }
    }
  }

  /** Dev fallback: the harness page runs without an extension runtime. */
  async function translateDirect(text, id) {
    const url =
      'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&dt=t' +
      `&tl=${encodeURIComponent(settings.target)}&q=${encodeURIComponent(text)}`;
    try {
      const res = await fetch(url);
      const data = await res.json();
      onPortMessage({ type: 'start', id, source: text, engine: 'Google' });
      onPortMessage({
        type: 'done',
        id,
        source: text,
        engine: 'Google',
        cached: false,
        text: (data[0] || []).map((s) => s[0]).join(''),
      });
    } catch (err) {
      onPortMessage({ type: 'error', id, message: err?.message || '请求失败' });
    }
  }

  function request(raw) {
    cancelRequest();
    reqId += 1;
    currentText = '';
    // Undo the typesetting here, at the source, so both the extension path and
    // the standalone dev path send the same clean string.
    const text = normalize(raw);
    currentSource = text;
    const id = reqId;
    if (HAS_RUNTIME) {
      const p = connect();
      if (!p) return;
      p.postMessage({ type: 'translate', id, text });
    } else {
      translateDirect(text, id);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Controls                                                          */
  /* ---------------------------------------------------------------- */

  function revealSource(force) {
    const showing = force ?? sourceEl.hidden;
    sourceTextEl.textContent = currentSource;
    sourceEl.hidden = !showing;
    btnSource.dataset.on = String(showing);
    if (!showing) stopSpeech();
  }

  /* ---------------------------------------------------------------- */
  /* Pronunciation                                                     */
  /* ---------------------------------------------------------------- */

  const synth = window.speechSynthesis;
  let utterance = null;
  // `synth.speaking` lags the call by a tick, so a quick second click would
  // start a second reading instead of stopping the first. Track it ourselves.
  let speaking = false;
  let keepAlive = null;

  /** Good enough to pick a voice: the source is whatever the reader can't read. */
  function guessLang(text) {
    if (/[぀-ヿ]/.test(text)) return 'ja-JP';
    if (/[가-힯]/.test(text)) return 'ko-KR';
    if (/[一-鿿]/.test(text)) return 'zh-CN';
    if (/[Ѐ-ӿ]/.test(text)) return 'ru-RU';
    return 'en-US';
  }

  /**
   * Chrome's *default* voice on macOS is frequently one of the novelty voices
   * (Fred, Albert…) — robotic and grating. Never leave the choice to the
   * browser: rank what's installed and pick the most natural one ourselves.
   */
  const NOVELTY = /albert|bad news|bahh|bells|boing|bubbles|cellos|deranged|wobble|fred|good news|jester|organ|superstar|trinoids|whisper|zarvox|grandma|grandpa|rocko|shelley|eddy|flo|reed|sandy|junior|ralph|kathy|hysterical/i;
  const PREMIUM =
    /samantha|karen|daniel|moira|tessa|serena|allison|ava|susan|zoe|tingting|婷婷|meijia|美嘉|sinji|善姫|kyoko|yuna|milena|katya/i;

  let voicesReady = synth ? synth.getVoices() : [];
  synth?.addEventListener?.(
    'voiceschanged',
    () => {
      voicesReady = synth.getVoices();
    },
    { signal },
  );

  function pickVoice(lang) {
    const list = voicesReady.length ? voicesReady : synth.getVoices();
    const base = lang.split('-')[0].toLowerCase();
    let best = null;
    let bestScore = -1;
    for (const v of list) {
      const vLang = (v.lang || '').toLowerCase().replace('_', '-');
      if (!vLang.startsWith(base)) continue;
      let score = 0;
      if (vLang === lang.toLowerCase()) score += 4; // exact locale beats cousin locale
      if (/google/i.test(v.name)) score += 8; // Chrome's network voices, by far the most natural
      else if (PREMIUM.test(v.name)) score += 6; // known-good local voices (Samantha, Tingting…)
      else if (/siri|premium|enhanced|natural/i.test(v.name)) score += 5;
      if (NOVELTY.test(v.name)) score -= 20; // never the duck
      if (v.localService) score += 1; // tie-break: local wins over other remote voices
      if (score > bestScore) {
        bestScore = score;
        best = v;
      }
    }
    return best;
  }

  function setSpeakingUI(on) {
    if (!btnSpeak) return;
    btnSpeak.dataset.on = String(on);
    btnSpeak.title = on ? '停止朗读' : '朗读原文';
    btnSpeak.setAttribute('aria-label', btnSpeak.title);
  }

  function stopSpeech() {
    if (!synth) return;
    speaking = false;
    utterance = null;
    clearInterval(keepAlive);
    keepAlive = null;
    synth.cancel();
    setSpeakingUI(false);
  }

  function speak() {
    if (!synth) return;
    // Second click stops: the button is the same affordance both ways.
    if (speaking) {
      stopSpeech();
      return;
    }
    const text = currentSource.trim();
    if (!text) return;

    utterance = new SpeechSynthesisUtterance(text);
    const lang = guessLang(text);
    utterance.lang = lang;
    const voice = pickVoice(lang);
    if (voice) utterance.voice = voice;
    utterance.rate = 0.95; // a touch under default; this is for hearing a word clearly
    utterance.pitch = 1;
    utterance.volume = 1;
    const done = () => stopSpeech();
    utterance.onend = done;
    utterance.onerror = done;

    speaking = true;
    setSpeakingUI(true);
    synth.speak(utterance);

    // Chrome silently stops synthesis after ~15s. A whole paragraph is a normal
    // thing to want read aloud, so nudge it along.
    clearInterval(keepAlive);
    keepAlive = setInterval(() => {
      if (!speaking) {
        clearInterval(keepAlive);
        keepAlive = null;
        return;
      }
      synth.pause();
      synth.resume();
    }, 10000);
  }

  function toggleSource() {
    revealSource();
    // User-initiated growth: let the popover glide to its new spot rather than
    // snapping the way it does while the page scrolls under it.
    if (open) place({ animate: true });
  }

  async function copy() {
    if (!currentText) return;
    try {
      await navigator.clipboard.writeText(currentText);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = currentText;
      ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none;';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
      } catch {
        /* clipboard unavailable */
      }
      ta.remove();
    }
    btnCopy.classList.add('swapping');
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => {
      btnCopy.innerHTML = icon('check');
      btnCopy.classList.remove('swapping');
      copyTimer = setTimeout(() => {
        btnCopy.classList.add('swapping');
        copyTimer = setTimeout(() => {
          btnCopy.innerHTML = icon('copy');
          btnCopy.classList.remove('swapping');
        }, 120);
      }, 1200);
    }, 120);
  }

  /* ---------------------------------------------------------------- */
  /* Selection detection                                               */
  /* ---------------------------------------------------------------- */

  const MIN_CHARS = 1;
  const MAX_CHARS = 5000;
  let currentSourceRaw = '';

  function selectionFromEvent(event) {
    if (event && host && event.composedPath?.().includes(host)) return null;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const text = sel.toString().trim();
    if (text.length < MIN_CHARS || text.length > MAX_CHARS) return null;
    // Ignore selections that are just punctuation or whitespace artefacts.
    if (!/[\p{L}\p{N}]/u.test(text)) return null;
    return { text, range: sel.getRangeAt(0).cloneRange() };
  }

  function evaluate(event) {
    if (!settings.enabled) return;
    const hit = selectionFromEvent(event);
    if (!hit) {
      if (open) close();
      return;
    }
    if (open && hit.text === currentSourceRaw) {
      range = hit.range;
      place({ animate: true });
      return;
    }
    currentSourceRaw = hit.text;
    show(hit.range);
    request(hit.text);
  }

  function scheduleEvaluate(event, delay = 10) {
    clearTimeout(evalTimer);
    const captured = event;
    evalTimer = setTimeout(() => evaluate(captured), delay);
  }

  document.addEventListener(
    'mouseup',
    (e) => {
      if (e.button !== 0) return;
      if (host && e.composedPath?.().includes(host)) return;
      if (settings.trigger === 'alt' && !e.altKey) return;
      scheduleEvaluate(e);
    },
    { signal, capture: true },
  );

  document.addEventListener(
    'keyup',
    (e) => {
      if (e.key === 'Escape') {
        close();
        return;
      }
      // Keyboard selection (shift+arrows) should behave like a drag.
      if (e.shiftKey && e.key.startsWith('Arrow')) scheduleEvaluate(null, 120);
    },
    { signal },
  );

  document.addEventListener(
    'mousedown',
    (e) => {
      if (host && e.composedPath?.().includes(host)) return;
      if (open) close();
    },
    { signal, capture: true },
  );

  // Track the anchor while the page scrolls. Cheap: one rect read per frame,
  // and the popover only ever moves via `transform`.
  addEventListener('scroll', track, { signal, passive: true, capture: true });
  addEventListener('resize', track, { signal, passive: true });

  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme, { signal });

  if (HAS_RUNTIME) {
    chrome.storage.local.get(DEFAULTS).then((stored) => {
      settings = { ...DEFAULTS, ...stored };
      applyTheme();
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      for (const [key, { newValue }] of Object.entries(changes)) settings[key] = newValue;
      applyTheme();
      if (!settings.enabled) close();
    });
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg?.type === 'glance:translate-selection') evaluate(null);
      // The popup pings to find out whether this page got the content script;
      // a page opened before install did not, and needs a reload.
      if (msg?.type === 'glance:ping') sendResponse({ alive: true });
    });
  }

  function destroy() {
    controller.abort();
    stopSpeech();
    clearTimeout(closeTimer);
    clearTimeout(evalTimer);
    clearTimeout(copyTimer);
    clearTimeout(trackTimer);
    if (rafId) cancelAnimationFrame(rafId);
    cancelRequest();
    try {
      port?.disconnect();
    } catch {
      /* already disconnected */
    }
    port = null;
    host?.remove();
    host = null;
    pop = null;
    open = false;
  }

  addEventListener('pagehide', destroy, { once: true });

  // Exposed for the bundled viewer: deterministic teardown, and a nudge when
  // the reader's own light/dark toggle flips.
  window.__glanceLensDestroy = destroy;
  window.__glanceLensSyncTheme = applyTheme;
})();
