/**
 * Glance PDF reader.
 *
 * A deliberately small pdf.js front end: continuous scroll, lazy canvases,
 * and a real text layer — which is the whole point, because the text layer is
 * what makes `window.getSelection()` work, and that is what the lens reads.
 */
import { getDocument, GlobalWorkerOptions, TextLayer } from '../../vendor/pdf.mjs';

GlobalWorkerOptions.workerSrc = new URL('../../vendor/pdf.worker.mjs', import.meta.url).href;

const HAS_RUNTIME = typeof chrome !== 'undefined' && chrome.runtime?.id;

/* Phosphor (regular) glyphs, 256 viewBox. */
const ICON = {
  folder:
    'M245,110.64A16,16,0,0,0,232,104H216V88a16,16,0,0,0-16-16H130.67L102.94,51.2a16.14,16.14,0,0,0-9.6-3.2H40A16,16,0,0,0,24,64V208h0a8,8,0,0,0,8,8H211.1a8,8,0,0,0,7.59-5.47l28.49-85.47A16.05,16.05,0,0,0,245,110.64ZM93.34,64,123.2,86.4A8,8,0,0,0,128,88h72v16H69.77a16,16,0,0,0-15.18,10.94L40,158.7V64Zm112,136H43.1l26.67-80H232Z',
  left: 'M165.66,202.34a8,8,0,0,1-11.32,11.32l-80-80a8,8,0,0,1,0-11.32l80-80a8,8,0,0,1,11.32,11.32L91.31,128Z',
  right:
    'M181.66,133.66l-80,80a8,8,0,0,1-11.32-11.32L164.69,128,90.34,53.66a8,8,0,0,1,11.32-11.32l80,80A8,8,0,0,1,181.66,133.66Z',
  plus: 'M224,128a8,8,0,0,1-8,8H136v80a8,8,0,0,1-16,0V136H40a8,8,0,0,1,0-16h80V40a8,8,0,0,1,16,0v80h80A8,8,0,0,1,224,128Z',
  minus: 'M224,128a8,8,0,0,1-8,8H40a8,8,0,0,1,0-16H216A8,8,0,0,1,224,128Z',
  moon: 'M233.54,142.23a8,8,0,0,0-8-2,88.08,88.08,0,0,1-109.8-109.8,8,8,0,0,0-10-10,104.84,104.84,0,0,0-52.91,37A104,104,0,0,0,136,224a103.09,103.09,0,0,0,62.52-20.88,104.84,104.84,0,0,0,37-52.91A8,8,0,0,0,233.54,142.23ZM188.9,190.34A88,88,0,0,1,65.66,67.11a89,89,0,0,1,31.4-26A106,106,0,0,0,96,56,104.11,104.11,0,0,0,200,160a106,106,0,0,0,14.92-1.06A89,89,0,0,1,188.9,190.34Z',
  sun: 'M120,40V32a8,8,0,0,1,16,0v8a8,8,0,0,1-16,0Zm72,88a64,64,0,1,1-64-64A64.07,64.07,0,0,1,192,128Zm-16,0a48,48,0,1,0-48,48A48.05,48.05,0,0,0,176,128ZM58.34,69.66A8,8,0,0,0,69.66,58.34l-8-8A8,8,0,0,0,50.34,61.66Zm0,116.68-8,8a8,8,0,0,0,11.32,11.32l8-8a8,8,0,0,0-11.32-11.32ZM192,72a8,8,0,0,0,5.66-2.34l8-8a8,8,0,0,0-11.32-11.32l-8,8A8,8,0,0,0,192,72Zm5.66,114.34a8,8,0,0,0-11.32,11.32l8,8a8,8,0,0,0,11.32-11.32ZM40,120H32a8,8,0,0,0,0,16h8a8,8,0,0,0,0-16Zm88,88a8,8,0,0,0-8,8v8a8,8,0,0,0,16,0v-8A8,8,0,0,0,128,208Zm96-88h-8a8,8,0,0,0,0,16h8a8,8,0,0,0,0-16Z',
  gear: 'M128,80a48,48,0,1,0,48,48A48.05,48.05,0,0,0,128,80Zm0,80a32,32,0,1,1,32-32A32,32,0,0,1,128,160Zm109.94-52.79a8,8,0,0,0-3.89-5.4l-29.83-17-.12-33.62a8,8,0,0,0-2.83-6.08,111.91,111.91,0,0,0-36.72-20.67,8,8,0,0,0-6.46.59L128,41.85,97.88,25a8,8,0,0,0-6.47-.6A112.1,112.1,0,0,0,54.73,45.15a8,8,0,0,0-2.83,6.07l-.15,33.65-29.83,17a8,8,0,0,0-3.89,5.4,106.47,106.47,0,0,0,0,41.56,8,8,0,0,0,3.89,5.4l29.83,17,.12,33.62a8,8,0,0,0,2.83,6.08,111.91,111.91,0,0,0,36.72,20.67,8,8,0,0,0,6.46-.59L128,214.15,158.12,231a7.91,7.91,0,0,0,3.9,1,8.09,8.09,0,0,0,2.57-.42,112.1,112.1,0,0,0,36.68-20.73,8,8,0,0,0,2.83-6.07l.15-33.65,29.83-17a8,8,0,0,0,3.89-5.4A106.47,106.47,0,0,0,237.94,107.21Zm-15,34.91-28.57,16.25a8,8,0,0,0-3,3c-.58,1-1.19,2.06-1.81,3.06a7.94,7.94,0,0,0-1.22,4.21l-.15,32.25a95.89,95.89,0,0,1-25.37,14.3L134,199.13a8,8,0,0,0-3.91-1h-.19c-1.21,0-2.43,0-3.64,0a8.08,8.08,0,0,0-4.1,1l-28.84,16.1A96,96,0,0,1,67.88,201l-.11-32.2a8,8,0,0,0-1.22-4.22c-.62-1-1.23-2-1.8-3.06a8.09,8.09,0,0,0-3-3.06l-28.6-16.29a90.49,90.49,0,0,1,0-28.26L61.67,97.63a8,8,0,0,0,3-3c.58-1,1.19-2.06,1.81-3.06a7.94,7.94,0,0,0,1.22-4.21l.15-32.25a95.89,95.89,0,0,1,25.37-14.3L122,56.87a8,8,0,0,0,4.1,1c1.21,0,2.43,0,3.64,0a8.08,8.08,0,0,0,4.1-1l28.84-16.1A96,96,0,0,1,188.12,55l.11,32.2a8,8,0,0,0,1.22,4.22c.62,1,1.23,2,1.8,3.06a8.09,8.09,0,0,0,3,3.06l28.6,16.29A90.49,90.49,0,0,1,222.9,142.12Z',
};

const $ = (id) => document.getElementById(id);
const svg = (name) => `<svg viewBox="0 0 256 256" aria-hidden="true"><path d="${ICON[name]}"/></svg>`;

const el = {
  scroll: $('scroll'),
  pages: $('pages'),
  empty: $('empty'),
  failed: $('failed'),
  title: $('title'),
  pager: $('pager'),
  pageInput: $('pageInput'),
  pageCount: $('pageCount'),
  zoom: $('zoom'),
  zoomLevel: $('zoomLevel'),
  drop: $('drop'),
  file: $('file'),
};

$('open').innerHTML = svg('folder');
$('prev').innerHTML = svg('left');
$('next').innerHTML = svg('right');
$('zoomIn').innerHTML = svg('plus');
$('zoomOut').innerHTML = svg('minus');
$('settings').innerHTML = svg('gear');

const MIN_SCALE = 0.4;
const MAX_SCALE = 4;
const KEEP_CANVAS_RADIUS = 3;

const state = {
  pdf: null,
  pages: [],
  scale: 1,
  fitWidth: true,
  current: 1,
  loadingTask: null,
};

const controller = new AbortController();
const { signal } = controller;
let observer = null;
let scrollRaf = 0;

/* ------------------------------------------------------------------ */
/* Theme                                                               */
/* ------------------------------------------------------------------ */

function setTheme(theme) {
  document.body.dataset.theme = theme;
  $('theme').innerHTML = svg(theme === 'dark' ? 'sun' : 'moon');
  $('theme').title = theme === 'dark' ? '日间模式' : '夜间模式';
  window.__glanceLensSyncTheme?.();
  if (HAS_RUNTIME) chrome.storage.local.set({ viewerTheme: theme });
}

async function initTheme() {
  let stored = null;
  if (HAS_RUNTIME) stored = (await chrome.storage.local.get('viewerTheme')).viewerTheme;
  setTheme(stored || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
}

$('theme').addEventListener(
  'click',
  () => setTheme(document.body.dataset.theme === 'dark' ? 'light' : 'dark'),
  { signal },
);

$('settings').addEventListener(
  'click',
  () => {
    if (HAS_RUNTIME) chrome.runtime.openOptionsPage();
  },
  { signal },
);

/* ------------------------------------------------------------------ */
/* Document loading                                                    */
/* ------------------------------------------------------------------ */

function paramFile() {
  const search = location.search;
  const at = search.indexOf('file=');
  if (at < 0) return null;
  const raw = search.slice(at + 5);
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function fail(message) {
  el.failed.hidden = false;
  el.failed.textContent = message;
  el.empty.hidden = true;
}

async function load(source, name) {
  teardownPages();
  el.failed.hidden = true;
  el.empty.hidden = true;
  el.title.textContent = name || 'Glance';
  document.title = name ? `${name} · Glance` : 'Glance';

  try {
    state.loadingTask = getDocument(
      typeof source === 'string'
        ? { url: source, withCredentials: true, isEvalSupported: false }
        : { data: source, isEvalSupported: false },
    );
    state.pdf = await state.loadingTask.promise;
  } catch (err) {
    fail(`打不开这份 PDF：${err?.message || err}`);
    return;
  }

  el.pageCount.textContent = String(state.pdf.numPages);
  el.pager.hidden = false;
  el.zoom.hidden = false;

  await buildPages();
  await fitWidth();
  observePages();
  setCurrent(1);
}

function teardownPages() {
  observer?.disconnect();
  observer = null;
  for (const page of state.pages) {
    page.task?.cancel();
    page.textLayer?.cancel?.();
  }
  state.pages = [];
  el.pages.replaceChildren();
  state.pdf?.destroy?.();
  state.pdf = null;
}

/** Lay out every page at its true aspect ratio first, so the scrollbar is honest. */
async function buildPages() {
  const frag = document.createDocumentFragment();
  for (let num = 1; num <= state.pdf.numPages; num += 1) {
    const page = await state.pdf.getPage(num);
    const viewport = page.getViewport({ scale: 1 });
    const node = document.createElement('div');
    node.className = 'page';
    node.dataset.page = String(num);
    node.style.setProperty('--w', viewport.width.toFixed(2));
    node.style.setProperty('--h', viewport.height.toFixed(2));
    frag.append(node);
    state.pages.push({ num, node, proxy: page, width: viewport.width, canvas: null, task: null });
  }
  el.pages.append(frag);
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

async function renderPage(page) {
  if (page.renderedAt === state.scale || page.pending) return;
  page.pending = true;
  try {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const viewport = page.proxy.getViewport({ scale: state.scale * dpr });

    if (!page.canvas) {
      page.canvas = document.createElement('canvas');
      page.node.prepend(page.canvas);
    }
    page.canvas.width = Math.floor(viewport.width);
    page.canvas.height = Math.floor(viewport.height);

    page.task?.cancel();
    page.task = page.proxy.render({
      canvasContext: page.canvas.getContext('2d', { alpha: false }),
      viewport,
    });
    await page.task.promise;
    page.renderedAt = state.scale;

    if (!page.textLayer) {
      const layer = document.createElement('div');
      layer.className = 'textLayer';
      page.node.append(layer);
      // Text positions are percentages driven by --total-scale-factor, so this
      // layer is built once and rescales with CSS alone.
      page.textLayer = new TextLayer({
        textContentSource: page.proxy.streamTextContent(),
        container: layer,
        viewport: page.proxy.getViewport({ scale: state.scale }),
      });
      await page.textLayer.render();
    }
  } catch (err) {
    if (err?.name !== 'RenderingCancelledException') console.warn('render failed', page.num, err);
  } finally {
    page.pending = false;
  }
}

/** Bound memory: a 40-page paper at 200% would otherwise hold 40 large canvases. */
function pruneCanvases() {
  for (const page of state.pages) {
    if (Math.abs(page.num - state.current) <= KEEP_CANVAS_RADIUS) continue;
    page.task?.cancel();
    page.task = null;
    if (page.canvas) {
      page.canvas.remove();
      page.canvas = null;
      page.renderedAt = null;
    }
  }
}

function observePages() {
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const page = state.pages[Number(entry.target.dataset.page) - 1];
        if (page) renderPage(page);
      }
    },
    { root: el.scroll, rootMargin: '150% 0px' },
  );
  for (const page of state.pages) observer.observe(page.node);
}

/* ------------------------------------------------------------------ */
/* Zoom                                                                */
/* ------------------------------------------------------------------ */

function applyScale(next, { fit = false } = {}) {
  const clamped = Math.min(MAX_SCALE, Math.max(MIN_SCALE, next));
  if (Math.abs(clamped - state.scale) < 0.001 && state.fitWidth === fit) return;

  // Keep the page the reader is looking at anchored across the zoom change.
  const anchor = state.pages[state.current - 1]?.node;
  const before = anchor ? anchor.getBoundingClientRect().top : 0;

  state.scale = clamped;
  state.fitWidth = fit;
  el.pages.style.setProperty('--scale', String(clamped));
  el.zoomLevel.textContent = `${Math.round(clamped * 100)}%`;

  if (anchor) {
    const after = anchor.getBoundingClientRect().top;
    el.scroll.scrollTop += after - before;
  }

  for (const page of state.pages) page.renderedAt = null;
  for (const page of state.pages) {
    if (Math.abs(page.num - state.current) <= KEEP_CANVAS_RADIUS) renderPage(page);
  }
}

async function fitWidth() {
  const first = state.pages[0];
  if (!first) return;
  const available = el.scroll.clientWidth - 32; // matches .pages horizontal padding
  applyScale(available / first.width, { fit: true });
}

$('zoomIn').addEventListener('click', () => applyScale(state.scale * 1.2), { signal });
$('zoomOut').addEventListener('click', () => applyScale(state.scale / 1.2), { signal });
el.zoomLevel.addEventListener('click', fitWidth, { signal });

addEventListener(
  'resize',
  () => {
    if (state.fitWidth) fitWidth();
  },
  { signal, passive: true },
);

/* ------------------------------------------------------------------ */
/* Paging                                                              */
/* ------------------------------------------------------------------ */

function setCurrent(num) {
  const clamped = Math.min(Math.max(num, 1), state.pages.length || 1);
  if (clamped === state.current) return;
  state.current = clamped;
  if (document.activeElement !== el.pageInput) el.pageInput.value = String(clamped);
  pruneCanvases();
}

function goto(num) {
  const page = state.pages[Math.min(Math.max(num, 1), state.pages.length) - 1];
  if (!page) return;
  el.scroll.scrollTo({ top: page.node.offsetTop - 20, behavior: 'smooth' });
}

el.scroll.addEventListener(
  'scroll',
  () => {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = 0;
      const mark = el.scroll.scrollTop + el.scroll.clientHeight * 0.35;
      let found = 1;
      for (const page of state.pages) {
        if (page.node.offsetTop <= mark) found = page.num;
        else break;
      }
      setCurrent(found);
    });
  },
  { signal, passive: true },
);

$('prev').addEventListener('click', () => goto(state.current - 1), { signal });
$('next').addEventListener('click', () => goto(state.current + 1), { signal });

el.pageInput.addEventListener(
  'keydown',
  (e) => {
    if (e.key !== 'Enter') return;
    const num = parseInt(el.pageInput.value, 10);
    if (Number.isFinite(num)) goto(num);
    el.pageInput.blur();
  },
  { signal },
);

addEventListener(
  'keydown',
  (e) => {
    if (e.target instanceof HTMLInputElement) return;
    if (e.metaKey || e.ctrlKey) {
      if (e.key === '=' || e.key === '+') {
        e.preventDefault();
        applyScale(state.scale * 1.2);
      } else if (e.key === '-') {
        e.preventDefault();
        applyScale(state.scale / 1.2);
      } else if (e.key === '0') {
        e.preventDefault();
        fitWidth();
      }
      return;
    }
    if (e.key === 'ArrowRight' || e.key === 'j') goto(state.current + 1);
    else if (e.key === 'ArrowLeft' || e.key === 'k') goto(state.current - 1);
  },
  { signal },
);

/* ------------------------------------------------------------------ */
/* File input & drop                                                   */
/* ------------------------------------------------------------------ */

async function loadFile(file) {
  if (!file) return;
  const bytes = new Uint8Array(await file.arrayBuffer());
  await load(bytes, file.name);
}

$('open').addEventListener('click', () => el.file.click(), { signal });
$('pick').addEventListener('click', () => el.file.click(), { signal });
el.file.addEventListener('change', () => loadFile(el.file.files?.[0]), { signal });

let dragDepth = 0;
addEventListener(
  'dragenter',
  (e) => {
    e.preventDefault();
    dragDepth += 1;
    el.drop.dataset.active = 'true';
  },
  { signal },
);
addEventListener('dragover', (e) => e.preventDefault(), { signal });
addEventListener(
  'dragleave',
  () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) delete el.drop.dataset.active;
  },
  { signal },
);
addEventListener(
  'drop',
  (e) => {
    e.preventDefault();
    dragDepth = 0;
    delete el.drop.dataset.active;
    loadFile(e.dataTransfer?.files?.[0]);
  },
  { signal },
);

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

addEventListener(
  'pagehide',
  () => {
    controller.abort();
    if (scrollRaf) cancelAnimationFrame(scrollRaf);
    teardownPages();
    state.loadingTask?.destroy?.();
    window.__glanceLensDestroy?.();
  },
  { once: true },
);

initTheme();

const url = paramFile();
if (url) {
  const name = decodeURIComponent(url.split('/').pop()?.split('?')[0] || 'PDF');
  load(url, name);
} else {
  el.empty.hidden = false;
}
