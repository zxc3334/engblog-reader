/* ============ EngBlog Reader · 前端逻辑 ============ */
'use strict';

// 部分手机浏览器/WebView 没有 speechSynthesis 全局对象，直接访问会抛 ReferenceError，
// 这里统一绑定：不存在时值为 undefined，配合各处 if 判断即可安全兜底。
const speechSynthesis = window.speechSynthesis;

/* ---------------- 基础工具 ---------------- */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.classList.remove('show'); el.hidden = true; }, 2200);
}

async function api(path, opts = {}) {
  const resp = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (!resp.ok) {
    let msg = `请求失败 (${resp.status})`;
    try { msg = (await resp.json()).detail || msg; } catch (e) { /* ignore */ }
    throw new Error(msg);
  }
  const ct = resp.headers.get('content-type') || '';
  return ct.includes('application/json') ? resp.json() : resp.text();
}

/* ---------------- 状态 ---------------- */
const state = {
  articles: [],           // 历史列表
  current: null,          // 当前文章
  highlights: [],         // 当前文章的高亮
  config: { llm: {}, target_lang: '中文', style: 'fluent', tts_rate: 1, tts_voice: '' },
  sidebarOpen: false,
  sidebarTab: 'history',
  tts: { active: false, queue: [], idx: -1, voice: null },
  pendingNote: null,      // note 模态框待保存的 {start,end,text}
};

/* ---------------- Markdown ---------------- */
const md = window.markdownit({
  html: false,
  linkify: true,
  highlight(str, lang) {
    if (lang && window.hljs && hljs.getLanguage(lang)) {
      try {
        return '<pre><code class="hljs language-' + lang + '">' +
          hljs.highlight(str, { language: lang, ignoreIllegals: true }).value +
          '</code></pre>';
      } catch (e) { /* fallthrough */ }
    }
    return '<pre><code class="hljs">' + md.utils.escapeHtml(str) + '</code></pre>';
  },
});

/* ---------------- 文本偏移映射（高亮持久化核心） ---------------- */
const contentEl = () => $('#article-content');

function textNodes() {
  const out = [];
  const walker = document.createTreeWalker(contentEl(), NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.nodeValue.length ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
  });
  let n;
  while ((n = walker.nextNode())) out.push(n);
  return out;
}

/** 边界 (container, offset) → 文章文本中的全局字符位置 */
function charPos(container, offset) {
  const root = contentEl();
  try {
    if (container.nodeType === Node.TEXT_NODE) offset = Math.min(offset, container.nodeValue.length);
    else offset = Math.min(offset, container.childNodes.length);
    const range = document.createRange();
    range.selectNodeContents(root);
    range.setEnd(container, offset);
    return range.toString().length;
  } catch (e) {
    return 0;
  }
}

/** 文章文本全局区间 [start,end) → DOM Range */
function rangeFromChars(start, end) {
  const nodes = textNodes();
  const range = document.createRange();
  let acc = 0, sN = nodes[0], sO = 0, eN = nodes[nodes.length - 1], eO = nodes[nodes.length - 1].nodeValue.length;
  let sDone = false, eDone = false;
  for (const n of nodes) {
    const len = n.nodeValue.length;
    if (!sDone && start <= acc + len) { sN = n; sO = Math.max(0, Math.min(len, start - acc)); sDone = true; }
    if (!eDone && end <= acc + len) { eN = n; eO = Math.max(0, Math.min(len, end - acc)); eDone = true; break; }
    acc += len;
  }
  range.setStart(sN, sO);
  range.setEnd(eN, eO);
  return range;
}

/** 把全局区间 [start,end) 包上 <mark> 标签 */
function applyHighlight(start, end, hid, withNote) {
  let acc = 0;
  for (const n of textNodes()) {  // 每次基于最新 DOM 重建，保证分割后坐标仍然正确
    const len = n.nodeValue.length;
    if (acc + len > start && acc < end) {
      const os = Math.max(0, start - acc);
      const oe = Math.min(len, end - acc);
      const mark = document.createElement('mark');
      mark.className = 'hl' + (withNote ? ' note-dot' : '');
      mark.dataset.hid = hid;
      let target = n;
      if (os > 0) target = n.splitText(os);
      if (oe - os < target.nodeValue.length) target.splitText(oe - os);
      target.parentNode.replaceChild(mark, target);
      mark.appendChild(target);
    }
    acc += len;
  }
}

/* ---------------- 视图切换 ---------------- */
function showHome() {
  $('#view-home').hidden = false;
  $('#view-reader').hidden = true;
  $('#top-article-title').textContent = '';
  $('#btn-read-aloud').textContent = '🔊 朗读';
  stopTts();
  state.current = null;
  state.highlights = [];
  renderNotesSidebar();
  renderArticleList();
  renderSidebarArticles();
  const main = $('#main');
  if (main) main.scrollTop = 0;
  document.title = 'EngBlog Reader';
}

async function openArticle(id, opts = {}) {
  try {
    try { stopTts(); } catch (e) { /* TTS 异常不应阻止打开文章 */ }
    const art = await api(`/api/articles/${id}`);
    state.current = art;
    state.highlights = art.highlights || [];
    $('#view-home').hidden = true;
    $('#view-reader').hidden = false;
    $('#top-article-title').textContent = art.title;
    $('#reader-title').textContent = art.title;
    $('#reader-meta').innerHTML =
      (art.source_url ? `<a href="${esc(art.source_url)}" target="_blank" rel="noopener">原文链接</a> · ` : '') +
      `导入于 ${fmtDate(art.created_at)}`;
    $('#article-content').innerHTML = md.render(art.content);
    applyHighlightsToDom();
    // 恢复阅读进度
    const main = $('#main');
    const ratio = Math.min(1, Math.max(0, art.scroll || 0));
    main.scrollTop = ratio * (main.scrollHeight - main.clientHeight);
    if (opts.jumpTo) {
      setTimeout(() => jumpToHighlight(opts.jumpTo), 60);
    }
    renderNotesSidebar();
    document.title = art.title + ' · EngBlog Reader';
    toast('已打开：' + art.title);
  } catch (e) {
    toast('打开失败：' + e.message);
  }
}

function applyHighlightsToDom() {
  for (const h of state.highlights) {
    applyHighlight(h.start_offset, h.end_offset, h.id, !!h.note);
  }
}

/* ---------------- 阅读进度保存 ---------------- */
let progressTimer;
function scheduleProgressSave() {
  clearTimeout(progressTimer);
  progressTimer = setTimeout(saveProgress, 800);
}
async function saveProgress() {
  if (!state.current) return;
  const main = $('#main');
  const ratio = main.scrollHeight > main.clientHeight
    ? main.scrollTop / (main.scrollHeight - main.clientHeight)
    : 0;
  state.current.scroll = ratio;
  try { await api(`/api/articles/${state.current.id}/progress`, {
    method: 'PUT', body: JSON.stringify({ scroll: ratio }),
  }); } catch (e) { /* 静默 */ }
}

/* ---------------- 首页列表 ---------------- */
function renderArticleList() {
  const q = ($('#search-box').value || '').trim().toLowerCase();
  const list = state.articles.filter((a) =>
    !q || a.title.toLowerCase().includes(q) || (a.source_url || '').toLowerCase().includes(q)
  );
  $('#home-empty').hidden = list.length > 0;
  $('#article-list').innerHTML = list.map((a) => {
    const pct = Math.round((a.scroll || 0) * 100);
    return `
    <div class="article-card" data-id="${a.id}">
      <div class="info">
        <div class="t">${esc(a.title)}</div>
        <div class="m">
          <span>${fmtDate(a.updated_at)}</span>
          ${a.source_url ? `<span>${esc(a.source_url)}</span>` : ''}
          <span>${Math.round((a.size || 0) / 102.4) / 10} KB</span>
        </div>
        <div class="progress"><i style="width:${pct}%"></i></div>
      </div>
      <div class="actions">
        <button class="btn ghost exp" title="导出 Markdown">⇩</button>
        <button class="btn ghost del" title="删除">🗑</button>
      </div>
    </div>`;
  }).join('');
}

$('#article-list').addEventListener('click', (e) => {
  const card = e.target.closest('.article-card');
  if (!card) return;
  const id = Number(card.dataset.id);
  if (e.target.closest('.del')) {
    if (confirm('删除这篇文章及其所有划线笔记？')) deleteArticle(id);
  } else if (e.target.closest('.exp')) {
    exportArticle(id);
  } else {
    openArticle(id);
  }
});

async function deleteArticle(id) {
  try {
    await api(`/api/articles/${id}`, { method: 'DELETE' });
    await refreshArticles();
    renderSidebarArticles();
    if (state.current && state.current.id === id) showHome();
    toast('已删除');
  } catch (e) { toast(e.message); }
}

async function exportArticle(id) {
  const a = state.articles.find((x) => x.id === id);
  if (!a) return;
  const art = await api(`/api/articles/${id}`);
  const blob = new Blob([art.content], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = (a.title || 'article').replace(/[\\/:*?"<>|]/g, '_') + '.md';
  link.click();
  URL.revokeObjectURL(url);
}

/* ---------------- 导入 ---------------- */
function openImportModal() {
  $('#import-modal').hidden = false;
  $('#import-content').value = '';
  $('#import-title').value = '';
  $('#import-url').value = '';
  const st = $('#fetch-status');
  st.textContent = ''; st.className = 'fetch-status';
  setTimeout(() => $('#import-content').focus(), 50);
}
$('#btn-import').addEventListener('click', openImportModal);

// ---- 从 URL 抓取正文 ----
let fetching = false;
async function fetchFromUrl(url) {
  if (fetching) return;
  const st = $('#fetch-status');
  const btn = $('#fetch-btn');
  fetching = true;
  btn.disabled = true;
  st.textContent = '⏳ 正在抓取正文…'; st.className = 'fetch-status';
  try {
    const r = await api('/api/fetch', { method: 'POST', body: JSON.stringify({ url }) });
    if (!$('#import-title').value.trim()) $('#import-title').value = r.title || '';
    if (!$('#import-content').value.trim()) $('#import-content').value = r.content || '';
    st.textContent = `✅ 抓取成功（${(r.content.length / 1024).toFixed(1)} KB）`;
    st.className = 'fetch-status ok';
    if ($('#import-content').value) $('#import-content').scrollTop = 0;
  } catch (e) {
    st.textContent = '⚠ ' + e.message;
    st.className = 'fetch-status err';
  } finally {
    fetching = false;
    btn.disabled = false;
  }
}

$('#fetch-btn').addEventListener('click', () => {
  const url = $('#import-url').value.trim();
  if (!url) { toast('请先粘贴原文链接'); return; }
  fetchFromUrl(url);
});
// 粘贴 URL 且内容区为空时自动抓取
$('#import-url').addEventListener('paste', (e) => {
  setTimeout(() => {
    const url = $('#import-url').value.trim();
    if (url && !$('#import-content').value.trim()) fetchFromUrl(url);
  }, 0);
});
// 回车直接抓取
$('#import-url').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const url = $('#import-url').value.trim();
    if (url) fetchFromUrl(url);
  }
});

$$('[data-close]').forEach((b) => b.addEventListener('click', () => {
  $(`#${b.dataset.close}`).hidden = true;
}));

// 拖入 .md 文件
const importContent = $('#import-content');
['dragover', 'drop'].forEach((ev) => importContent.addEventListener(ev, (e) => {
  e.preventDefault();
  if (ev === 'drop' && e.dataTransfer.files.length) {
    const f = e.dataTransfer.files[0];
    if (!/\.md$|\.markdown$|text\//i.test(f.name + f.type)) { toast('仅支持 Markdown 文件'); return; }
    const reader = new FileReader();
    reader.onload = () => { importContent.value = reader.result; };
    reader.readAsText(f, 'utf-8');
  }
}));

$('#import-confirm').addEventListener('click', async () => {
  const content = $('#import-content').value.trim();
  if (!content) { toast('内容为空'); return; }
  try {
    const art = await api('/api/articles', {
      method: 'POST',
      body: JSON.stringify({
        title: $('#import-title').value.trim(),
        source_url: $('#import-url').value.trim(),
        content,
      }),
    });
    $('#import-modal').hidden = true;
    await refreshArticles();
    openArticle(art.id);
  } catch (e) { toast(e.message); }
});

/* ---------------- 设置 ---------------- */
/** 渲染音色下拉框：Edge 引擎用内置高质量音色；浏览器引擎用系统音色（带性别猜测标注） */
function renderVoiceOptions() {
  const sel = $('#cfg-tts-voice');
  if (!sel) return;
  if (ttsEngine() === 'edge') {
    const cur = edgeVoice();
    sel.innerHTML = EDGE_VOICES.map((v) =>
      `<option value="${esc(v.id)}" ${v.id === cur ? 'selected' : ''}>${esc(v.name)}</option>`
    ).join('');
  } else {
    const vs = availableVoices().filter((v) => v.lang && v.lang.toLowerCase().startsWith('en'));
    const cur = state.config.tts_voice || '';
    sel.innerHTML = vs.length
      ? vs.map((v) =>
        `<option value="${esc(v.voiceURI)}" ${v.voiceURI === cur ? 'selected' : ''}>${esc(v.name)} (${v.lang}) · ${guessGender(v.name)}</option>`
      ).join('')
      : '<option value="">当前系统无英文语音</option>';
    if (vs.length && !cur) {
      const def = vs.find((v) => v.lang === 'en-US') || vs[0];
      sel.value = def.voiceURI;
    }
  }
}
async function refreshConfig() {
  state.config = await api('/api/config');
  $('#cfg-base-url').value = state.config.llm.base_url || '';
  $('#cfg-api-key').value = '';
  $('#cfg-api-key').placeholder = state.config.api_key_set ? '已设置（留空保持不变）' : '未设置';
  $('#cfg-model').value = state.config.llm.model || '';
  $('#cfg-target-lang').value = state.config.target_lang || '中文';
  $('#cfg-style').value = state.config.style || 'fluent';
  $('#cfg-tts-rate').value = state.config.tts_rate ?? 1;
  $('#cfg-tts-engine').value = state.config.tts_engine || 'edge';
  $('#cfg-data-path').textContent =
    `${state.config.data_path || '（未知）'} · ${((state.config.data_size || 0) / 1024).toFixed(1)} KB`;
  renderVoiceOptions();
}
$('#btn-settings').addEventListener('click', () => {
  refreshConfig();
  $('#settings-modal').hidden = false;
  const st = $('#cfg-status');
  st.textContent = ''; st.className = 'cfg-status';
});
$('#cfg-tts-engine').addEventListener('change', renderVoiceOptions);
$('#cfg-voice-test').addEventListener('click', () => {
  const sample = 'Hello! This is how your articles will be read aloud.';
  const rate = parseFloat($('#cfg-tts-rate').value) || 1;
  const voice = $('#cfg-tts-voice').value;
  if (!voice) { toast('没有可选音色'); return; }
  if (ttsEngine() === 'edge') {
    fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: sample, voice, rate }),
    })
      .then((r) => { if (!r.ok) throw new Error('TTS 失败'); return r.blob(); })
      .then((blob) => { new Audio(URL.createObjectURL(blob)).play(); })
      .catch((e) => toast('试听失败（需联网）：' + e.message));
  } else {
    if (!speechSynthesis) { toast('当前浏览器不支持朗读'); return; }
    const v = availableVoices().find((x) => x.voiceURI === voice) || null;
    const u = new SpeechSynthesisUtterance(sample);
    if (v) u.voice = v;
    u.lang = v ? v.lang : 'en-US';
    u.rate = rate;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  }
});
$('#cfg-save').addEventListener('click', async () => {
  const engine = $('#cfg-tts-engine').value;
  const body = {
    llm: {
      base_url: $('#cfg-base-url').value.trim(),
      api_key: $('#cfg-api-key').value.trim(),
      model: $('#cfg-model').value.trim(),
    },
    target_lang: $('#cfg-target-lang').value.trim() || '中文',
    style: $('#cfg-style').value,
    tts_rate: parseFloat($('#cfg-tts-rate').value),
    tts_engine: engine,
  };
  // 两种引擎各自的音色存到不同字段，互不干扰
  const voice = $('#cfg-tts-voice').value;
  if (engine === 'edge') body.tts_voice_edge = voice;
  else body.tts_voice = voice;
  try {
    await api('/api/config', { method: 'PUT', body: JSON.stringify(body) });
    $('#cfg-api-key').value = '';
    $('#cfg-api-key').placeholder = '已设置';
    await refreshConfig();
    toast('设置已保存');
  } catch (e) { toast(e.message); }
});
$('#cfg-export').addEventListener('click', async () => {
  try {
    const data = await api('/api/export');
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `engblog-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast(`已导出 ${data.articles.length} 篇文章（含划线笔记）`);
  } catch (e) { toast('导出失败：' + e.message); }
});
$('#cfg-import').addEventListener('click', () => $('#cfg-import-file').click());
$('#cfg-import-file').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (!data.articles || !Array.isArray(data.articles)) throw new Error('不是本应用的备份文件');
    const r = await api('/api/import', { method: 'POST', body: JSON.stringify(data) });
    e.target.value = '';
    await refreshArticles();
    renderSidebarArticles();
    toast(`✅ 已恢复 ${r.articles} 篇文章、${r.highlights} 条划线`);
  } catch (err) { toast('导入失败：' + err.message); e.target.value = ''; }
});
$('#cfg-test').addEventListener('click', async () => {
  const st = $('#cfg-status');
  st.textContent = '测试中…'; st.className = 'cfg-status';
  try {
    const r = await api('/api/llm/test', {
      method: 'POST',
      body: JSON.stringify({
        llm: {
          base_url: $('#cfg-base-url').value.trim(),
          api_key: $('#cfg-api-key').value.trim(),
          model: $('#cfg-model').value.trim(),
        },
      }),
    });
    st.textContent = r.message; st.className = 'cfg-status ' + (r.ok ? 'ok' : 'err');
  } catch (e) { st.textContent = e.message; st.className = 'cfg-status err'; }
});

/* ---------------- 划词浮层 ---------------- */
let selState = null; // {start, end, text, rect, isPara}
const isTouchDevice = () => ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);

function clearSelectionUi() {
  $('#sel-toolbar').hidden = true;
  selState = null;
}

document.addEventListener('mouseup', (e) => {
  // 点击高亮 mark 时跳过
  if (e.target.closest && e.target.closest('mark.hl')) return;
  setTimeout(() => handleSelection(e), 0);
});

// 移动端：长按划词结束后检测选区
if (isTouchDevice()) {
  document.addEventListener('touchend', (e) => {
    if (e.target.closest && e.target.closest('mark.hl')) return;
    setTimeout(() => handleSelection(e), 120); // 等系统提交选区
  }, { passive: true });
  // 拖动选词过程中实时跟随浮层
  document.addEventListener('selectionchange', () => {
    if (!selState) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) { clearSelectionUi(); return; }
    const range = sel.getRangeAt(0);
    if (!contentEl().contains(range.commonAncestorContainer)) { clearSelectionUi(); return; }
    selState.rect = range.getBoundingClientRect();
    const bar = $('#sel-toolbar');
    if (!bar.hidden) positionSelToolbar();
  });
}

function handleSelection(e) {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount || !state.current) { clearSelectionUi(); return; }
  const range = sel.getRangeAt(0);
  if (!contentEl().contains(range.commonAncestorContainer)) { clearSelectionUi(); return; }
  const text = range.toString().trim();
  if (!text || text.length < 2) { clearSelectionUi(); return; }
  const start = charPos(range.startContainer, range.startOffset);
  const end = charPos(range.endContainer, range.endOffset);
  if (end - start < 1) { clearSelectionUi(); return; }
  selState = { start, end, text, rect: range.getBoundingClientRect() };
  // 词义按钮：仅对"单个英文单词"启用（多选/中文/带空格时置灰）
  const wordBtn = $('#btn-word');
  if (wordBtn) wordBtn.disabled = !/^[A-Za-z][A-Za-z'-]*$/.test(text);
  positionSelToolbar();
}

function positionSelToolbar() {
  const bar = $('#sel-toolbar');
  bar.hidden = false; // 先显示才能测量尺寸
  const r = selState.rect;
  const bw = bar.offsetWidth, bh = bar.offsetHeight;
  let left = Math.min(r.left + r.width / 2 - bw / 2, window.innerWidth - bw - 8);
  left = Math.max(8, left);
  const below = r.bottom + bh + 10 < window.innerHeight;
  bar.style.left = left + 'px';
  bar.style.top = (below ? r.bottom + 8 : r.top - bh - 8) + 'px';
}

$('#sel-toolbar').addEventListener('mousedown', (e) => e.preventDefault()); // 防止丢失选区
$('#sel-toolbar').addEventListener('touchstart', (e) => e.preventDefault(), { passive: false }); // 移动端同上
$('#sel-toolbar').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn || !selState) return;
  const act = btn.dataset.act;
  const s = selState;
  if (act === 'translate') {
    showTransPanel(s.rect, s.text);
    startTranslation(s.text);
  } else if (act === 'word') {
    showWordPanel(s);
  } else if (act === 'read') {
    if (speechSynthesis) speechSynthesis.cancel();
    speakRaw(s.text);
  } else if (act === 'highlight') {
    createHighlight(s.start, s.end, s.text, '');
  } else if (act === 'note') {
    $('#note-preview').textContent = s.text;
    $('#note-text').value = '';
    state.pendingNote = { start: s.start, end: s.end, text: s.text };
    $('#note-modal').hidden = false;
  }
  window.getSelection()?.removeAllRanges();
  clearSelectionUi();
});

$('#note-confirm').addEventListener('click', async () => {
  const p = state.pendingNote;
  if (!p) return;
  const note = $('#note-text').value.trim();
  try {
    const hid = await createHighlight(p.start, p.end, p.text, note);
    $('#note-modal').hidden = true;
    toast(note ? '笔记已保存' : '已划线');
  } catch (e) { toast(e.message); }
});

async function createHighlight(start, end, text, note) {
  const r = await api(`/api/articles/${state.current.id}/highlights`, {
    method: 'POST',
    body: JSON.stringify({ text, note, start_offset: start, end_offset: end }),
  });
  applyHighlight(start, end, r.id, !!note);
  state.highlights.push({ id: r.id, text, note, start_offset: start, end_offset: end });
  renderNotesSidebar();
  return r.id;
}

/* ---------------- 翻译面板（SSE 流式） ---------------- */
let transBusy = false;

function showTransPanel(anchorRect, srcText) {
  const panel = $('#trans-panel');
  $('#trans-src').textContent = srcText;
  $('#trans-body').textContent = '';
  $('#trans-body').classList.remove('error');
  panel.hidden = false; // 先显示才能测量尺寸
  const pw = panel.offsetWidth;
  const ph = panel.offsetHeight;
  let left = Math.max(8, Math.min(anchorRect.left, window.innerWidth - pw - 8));
  let top = anchorRect.bottom + 10;
  if (top + ph > window.innerHeight - 8) top = Math.max(8, anchorRect.top - ph - 10);
  panel.style.left = left + 'px';
  panel.style.top = top + 'px';
}

function hideTransPanel() {
  if (transBusy) { /* 允许直接关闭 */ }
  $('#trans-panel').hidden = true;
}
$('#trans-close').addEventListener('click', hideTransPanel);
$('#trans-copy').addEventListener('click', async () => {
  const txt = $('#trans-body').textContent;
  if (!txt) return;
  try { await navigator.clipboard.writeText(txt); toast('已复制'); }
  catch (e) { toast('复制失败'); }
});
$('#trans-read').addEventListener('click', () => {
  // 朗读英文原文（trans-src），而不是中文译文
  const txt = $('#trans-src').textContent;
  if (txt) { stopTts(); speakRaw(txt); }
});

/** 通用 SSE 流式面板渲染：把 /api/translate / /api/word 的流式结果写入面板 body */
async function streamPanel(body, url, payload) {
  body.textContent = '';
  body.classList.remove('error');
  const cursor = document.createElement('span');
  cursor.className = 'cursor';
  body.appendChild(cursor);
  let out = '';
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) throw new Error((await resp.json().catch(() => ({}))).detail || '请求失败');
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done: d, value } = await reader.read();
      if (d) break;
      buf += dec.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const ev = buf.slice(0, idx); buf = buf.slice(idx + 2);
        const line = ev.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') return;
        let obj;
        try { obj = JSON.parse(data); } catch (e) { continue; }
        if (obj.error) {
          body.classList.add('error');
          body.textContent = '⚠ ' + obj.error;
          cursor.remove();
          return;
        }
        if (obj.delta) {
          out += obj.delta;
          cursor.remove();
          body.textContent = out;
          body.appendChild(cursor);
        }
      }
    }
  } catch (e) {
    body.classList.add('error');
    body.textContent = '⚠ 请求出错：' + e.message;
  } finally {
    cursor.remove();
  }
}

function startTranslation(text) {
  transBusy = true;
  const cfg = state.config;
  streamPanel($('#trans-body'), '/api/translate', {
    text, style: cfg.style, target_lang: cfg.target_lang,
  }).finally(() => { transBusy = false; });
}

/* ---------------- 词义面板（单词语义：上下文推断 + 常规含义） ---------------- */
/** 取选区前后各 pad 字符的上下文文本（跨多个文本节点） */
function getContextAround(start, end, pad = 70) {
  const nodes = textNodes();
  let acc = 0, out = '', started = false;
  for (const n of nodes) {
    const len = n.nodeValue.length;
    const nStart = acc, nEnd = acc + len;
    if (!started && nEnd > start - pad) started = true;
    if (started) {
      const from = Math.max(nStart, start - pad) - nStart;
      const to = Math.min(nEnd, end + pad) - nStart;
      if (from < to) out += n.nodeValue.slice(from, to);
      if (nEnd >= end + pad) break;
    }
    acc += len;
  }
  return out.trim();
}

function showWordPanel(s) {
  const word = s.text.trim().replace(/[^A-Za-z'-]+$/, '');
  const ctx = getContextAround(s.start, s.end);
  $('#word-label').textContent = word;
  // 上下文里高亮该词
  const snip = ctx || s.text;
  const i = ctx ? snip.indexOf(s.text.trim()) : -1;
  $('#word-context').innerHTML = (ctx && i >= 0)
    ? '…' + esc(snip.slice(0, i)) + '<b>' + esc(s.text.trim()) + '</b>' + esc(snip.slice(i + s.text.trim().length)) + '…'
    : esc(snip);
  const panel = $('#word-panel');
  const body = $('#word-body');
  body.textContent = '';
  body.classList.remove('error');
  panel.hidden = false; // 先显示才能测量尺寸
  const pw = panel.offsetWidth, ph = panel.offsetHeight;
  const r = s.rect;
  let left = Math.max(8, Math.min(r.left, window.innerWidth - pw - 8));
  let top = r.bottom + 10;
  if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 10);
  panel.style.left = left + 'px';
  panel.style.top = top + 'px';
  startWordMeaning(word, ctx);
}

function startWordMeaning(word, context) {
  transBusy = true;
  streamPanel($('#word-body'), '/api/word', { word, context })
    .finally(() => { transBusy = false; });
}

$('#word-close').addEventListener('click', () => { $('#word-panel').hidden = true; });
$('#word-copy').addEventListener('click', async () => {
  const txt = $('#word-body').textContent;
  if (!txt) return;
  try { await navigator.clipboard.writeText(txt); toast('已复制'); } catch (e) { toast('复制失败'); }
});
$('#word-read').addEventListener('click', () => {
  const word = $('#word-label').textContent;
  if (word) { stopTts(); speakRaw(word); }
});

/* ---------------- TTS 朗读 ---------------- */
/* Edge 神经语音：内置高质量美音男声/女声列表（需联网，跨平台一致） */
const EDGE_VOICES = [
  { id: 'en-US-ChristopherNeural', name: 'Christopher · 美音男声', g: '男' },
  { id: 'en-US-GuyNeural', name: 'Guy · 美音男声', g: '男' },
  { id: 'en-US-AndrewNeural', name: 'Andrew · 美音男声', g: '男' },
  { id: 'en-US-BrianNeural', name: 'Brian · 美音男声', g: '男' },
  { id: 'en-US-EricNeural', name: 'Eric · 美音男声', g: '男' },
  { id: 'en-US-RogerNeural', name: 'Roger · 美音男声', g: '男' },
  { id: 'en-US-SteffanNeural', name: 'Steffan · 美音男声', g: '男' },
  { id: 'en-US-AriaNeural', name: 'Aria · 美音女声', g: '女' },
  { id: 'en-US-JennyNeural', name: 'Jenny · 美音女声', g: '女' },
  { id: 'en-US-MichelleNeural', name: 'Michelle · 美音女声', g: '女' },
  { id: 'en-GB-RyanNeural', name: 'Ryan · 英音男声', g: '男' },
  { id: 'en-GB-ThomasNeural', name: 'Thomas · 英音男声', g: '男' },
  { id: 'en-GB-SoniaNeural', name: 'Sonia · 英音女声', g: '女' },
];
const MALE_HINT = ['david', 'mark', 'james', 'guy', 'john', 'daniel', 'george', 'fred',
  'christopher', 'edward', 'thomas', 'andrew', 'ryan', 'eric', 'steven', 'brian',
  'richard', 'paul', 'michael', 'ben', 'adam', 'oliver', 'alex', 'carlos', 'liam'];
const FEMALE_HINT = ['samantha', 'victoria', 'karen', 'zira', 'jenny', 'susan', 'sarah',
  'allison', 'ava', 'fiona', 'moira', 'tessa', 'linda', 'mary', 'jessica', 'emily',
  'grace', 'stella', 'ana', 'serena', 'aria', 'michelle', 'courtney', 'angela', 'sara'];
function guessGender(name) {
  const n = (name || '').toLowerCase();
  if (MALE_HINT.some((w) => n.includes(w))) return '男';
  if (FEMALE_HINT.some((w) => n.includes(w))) return '女';
  if (/google us english|siri/.test(n)) return '女';
  return '？';
}

function ttsEngine() { return state.config.tts_engine || 'edge'; }
function edgeVoice() { return state.config.tts_voice_edge || 'en-US-ChristopherNeural'; }

function availableVoices() {
  return window.speechSynthesis ? speechSynthesis.getVoices() : [];
}
function pickVoice() {
  const vs = availableVoices().filter((v) => v.lang && v.lang.toLowerCase().startsWith('en'));
  const saved = state.config.tts_voice;
  if (saved) {
    const m = vs.find((v) => v.voiceURI === saved) || availableVoices().find((v) => v.voiceURI === saved);
    if (m) return m;
  }
  return vs.find((v) => v.lang === 'en-US') || vs[0] || null;
}

/* ---- Edge 引擎：音频获取（带缓存） ---- */
const edgeAudioCache = new Map();
async function getEdgeAudio(text) {
  const voice = edgeVoice();
  const rate = state.config.tts_rate ?? 1;
  const key = voice + '|' + rate + '|' + text;
  if (edgeAudioCache.has(key)) return edgeAudioCache.get(key);
  const resp = await fetch('/api/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice, rate }),
  });
  if (!resp.ok) throw new Error((await resp.json().catch(() => ({}))).detail || 'TTS 请求失败');
  const url = URL.createObjectURL(await resp.blob());
  edgeAudioCache.set(key, url);
  if (edgeAudioCache.size > 15) {
    const k = edgeAudioCache.keys().next().value;
    URL.revokeObjectURL(edgeAudioCache.get(k));
    edgeAudioCache.delete(k);
  }
  return url;
}
let currentAudio = null;
async function speakEdge(text, onEnd) {
  try {
    const url = await getEdgeAudio(text);
    const audio = new Audio(url);
    currentAudio = audio;
    audio.onended = () => { if (currentAudio === audio) currentAudio = null; if (onEnd) onEnd(); };
    audio.onerror = () => { if (currentAudio === audio) currentAudio = null; if (onEnd) onEnd(); };
    await audio.play();
  } catch (e) {
    toast('Edge TTS 失败（需联网）' + (e.message ? '：' + e.message : ''));
    if (onEnd) onEnd();
  }
}

/* ---- 统一朗读入口 ---- */
function speakText(text, onEnd) {
  if (!text || !text.trim()) { if (onEnd) onEnd(); return; }
  if (ttsEngine() === 'edge') return speakEdge(text, onEnd);
  if (!speechSynthesis) { if (onEnd) onEnd(); return; }
  const u = new SpeechSynthesisUtterance(text);
  const v = pickVoice();
  if (v) u.voice = v;
  u.lang = v ? v.lang : 'en-US';
  u.rate = state.config.tts_rate ?? 1;
  if (onEnd) u.onend = onEnd;
  u.onerror = () => { if (onEnd) onEnd(); };
  if (speechSynthesis) speechSynthesis.speak(u);
}
function speakRaw(text) { speakText(text); }

function ttsBlocks() {
  return $$('#article-content p, #article-content li, #article-content h1, #article-content h2, '
    + '#article-content h3, #article-content h4, #article-content h5, #article-content h6')
    .filter((el) => el.textContent.trim() && !el.closest('pre'));
}

function fullRead() {
  const blocks = ttsBlocks();
  if (!blocks.length) return;
  state.tts.queue = blocks;
  state.tts.idx = -1;
  state.tts.active = true;
  $('#btn-read-aloud').textContent = '■ 停止';
  speakNextBlock();
}
function speakNextBlock() {
  state.tts.idx++;
  if (state.tts.idx >= state.tts.queue.length) { stopTts(); return; }
  const el = state.tts.queue[state.tts.idx];
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.classList.add('reading');
  // Edge 引擎：预取下一段，避免段落间卡顿
  if (ttsEngine() === 'edge') {
    const nxt = state.tts.queue[state.tts.idx + 1];
    if (nxt) getEdgeAudio(nxt.textContent).catch(() => {});
  }
  speakText(el.textContent, () => {
    el.classList.remove('reading');
    speakNextBlock();
  });
}
function stopTts() {
  if (currentAudio) { currentAudio.pause(); currentAudio = null; }
  if (speechSynthesis) speechSynthesis.cancel();
  state.tts.active = false;
  state.tts.queue = [];
  $$('#article-content .reading').forEach((el) => el.classList.remove('reading'));
  $('#btn-read-aloud').textContent = '🔊 朗读';
}
$('#btn-read-aloud').addEventListener('click', () => {
  if (!state.current) { toast('请先打开一篇文章'); return; }
  if (state.tts.active) stopTts();
  else fullRead();
});

/* ---------------- 高亮交互 ---------------- */
$('#article-content').addEventListener('click', (e) => {
  const mark = e.target.closest('mark.hl');
  if (!mark) { $('#hl-bubble').hidden = true; return; }
  e.preventDefault();
  const hid = Number(mark.dataset.hid);
  const h = state.highlights.find((x) => x.id === hid);
  if (!h) return;
  const bubble = $('#hl-bubble');
  $('#hl-bubble-text').textContent = h.text;
  $('#hl-bubble-note').value = h.note || '';
  bubble.hidden = false; // 先显示才能测量尺寸
  const bw = bubble.offsetWidth, bh = bubble.offsetHeight;
  const r = mark.getBoundingClientRect();
  let left = Math.max(8, Math.min(r.left, window.innerWidth - bw - 8));
  let top = r.bottom + 8;
  if (top + bh > window.innerHeight - 8) top = Math.max(8, r.top - bh - 8);
  bubble.style.left = left + 'px';
  bubble.style.top = top + 'px';
  bubble.dataset.hid = hid;
});
$('#hl-save-note').addEventListener('click', async () => {
  const bubble = $('#hl-bubble');
  const hid = Number(bubble.dataset.hid);
  const note = $('#hl-bubble-note').value.trim();
  try {
    await api(`/api/highlights/${hid}`, { method: 'PUT', body: JSON.stringify({ note }) });
    const h = state.highlights.find((x) => x.id === hid);
    if (h) { h.note = note; }
    renderNotesSidebar();
    bubble.hidden = true;
    // 刷新标记样式（有笔记 → 加点）
    $$(`mark.hl[data-hid="${hid}"]`).forEach((m) => m.classList.toggle('note-dot', !!note));
    toast('笔记已保存');
  } catch (e) { toast(e.message); }
});
$('#hl-delete').addEventListener('click', async () => {
  const bubble = $('#hl-bubble');
  const hid = Number(bubble.dataset.hid);
  try {
    await api(`/api/highlights/${hid}`, { method: 'DELETE' });
    $$(`mark.hl[data-hid="${hid}"]`).forEach((m) => m.replaceWith(...m.childNodes));
    state.highlights = state.highlights.filter((x) => x.id !== hid);
    renderNotesSidebar();
    bubble.hidden = true;
    toast('已删除划线');
  } catch (e) { toast(e.message); }
});

function jumpToHighlight(hid) {
  const mark = $(`mark.hl[data-hid="${hid}"]`);
  if (!mark) return;
  mark.scrollIntoView({ block: 'center' });
  mark.classList.add('hl-flash');
  setTimeout(() => mark.classList.remove('hl-flash'), 1600);
}

/* ---------------- 侧边栏 ---------------- */
$('#btn-sidebar').addEventListener('click', () => {
  state.sidebarOpen = !state.sidebarOpen;
  $('#sidebar').hidden = !state.sidebarOpen;
  if (state.sidebarOpen) { renderSidebarArticles(); renderNotesSidebar(); }
});
$$('.sidebar-tabs .tab').forEach((t) => t.addEventListener('click', () => {
  state.sidebarTab = t.dataset.tab;
  $$('.sidebar-tabs .tab').forEach((x) => x.classList.toggle('active', x === t));
  $('#panel-history').hidden = t.dataset.tab !== 'history';
  $('#panel-notes').hidden = t.dataset.tab !== 'notes';
}));

function renderSidebarArticles() {
  $('#sidebar-articles').innerHTML = state.articles.length
    ? state.articles.map((a) => {
      const active = state.current && state.current.id === a.id;
      return `<div class="sb-item ${active ? 'active' : ''}" data-id="${a.id}">
        <div class="t">${esc(a.title)}</div>
        <div class="m">${fmtDate(a.updated_at)} · ${Math.round((a.scroll || 0) * 100)}%</div>
      </div>`;
    }).join('')
    : '<div class="sb-empty">暂无历史记录</div>';
}
$('#sidebar-articles').addEventListener('click', (e) => {
  const item = e.target.closest('.sb-item');
  if (item) openArticle(Number(item.dataset.id));
});

function renderNotesSidebar() {
  const notes = state.highlights;
  $('#notes-badge').textContent = notes.length || '';
  $('#sidebar-notes').innerHTML = notes.length
    ? notes.map((h) => `<div class="sb-item" data-hid="${h.id}">
        <div class="sb-item-head">
          <div class="t">${esc(h.text.slice(0, 60))}${h.text.length > 60 ? '…' : ''}</div>
          <button class="mini danger del-note" title="删除划线及笔记">✕</button>
        </div>
        ${h.note ? `<div class="note">${esc(h.note)}</div>` : '<div class="m">（无笔记）</div>'}
      </div>`).join('')
    : '<div class="sb-empty">划线高亮后会显示在这里</div>';
}
$('#sidebar-notes').addEventListener('click', async (e) => {
  const del = e.target.closest('.del-note');
  const item = e.target.closest('.sb-item');
  if (!item) return;
  const hid = Number(item.dataset.hid);
  if (del) {
    if (!confirm('删除这条划线及其笔记？')) return;
    try {
      await api(`/api/highlights/${hid}`, { method: 'DELETE' });
      $$(`mark.hl[data-hid="${hid}"]`).forEach((m) => m.replaceWith(...m.childNodes));
      state.highlights = state.highlights.filter((x) => x.id !== hid);
      renderNotesSidebar();
      $('#hl-bubble').hidden = true;
      toast('已删除');
    } catch (err) { toast(err.message); }
    return;
  }
  const mark = $(`mark.hl[data-hid="${hid}"]`);
  if (mark) jumpToHighlight(hid);
});

/* ---------------- 全局事件 ---------------- */
$('#btn-home').addEventListener('click', () => {
  saveProgress();
  refreshArticles();
  showHome();
});

$('#search-box').addEventListener('input', renderArticleList);

document.addEventListener('scroll', () => { scheduleProgressSave(); }, true);
window.addEventListener('beforeunload', saveProgress);

document.addEventListener('click', (e) => {
  // 点击高亮 mark 本身：由文章内的处理器弹出气泡，这里不能拦截关闭
  if (e.target.closest && e.target.closest('mark.hl')) return;
  if (!e.target.closest('#sel-toolbar') && !e.target.closest('#trans-panel')
    && !e.target.closest('#word-panel') && !e.target.closest('#hl-bubble')) {
    $('#trans-panel').hidden = true;
    $('#word-panel').hidden = true;
    $('#hl-bubble').hidden = true;
    clearSelectionUi();
  }
});

// 主题（跟随系统）+ 代码高亮主题切换
function applyTheme() {
  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.body.dataset.theme = dark ? 'dark' : 'light';
  $('#hljs-theme').href = dark
    ? 'https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/styles/github-dark.min.css'
    : 'https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/styles/github.min.css';
}
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
applyTheme();

// PWA：注册 Service Worker（仅 HTTPS / localhost 生效，局域网 http 访问时静默跳过）
if ('serviceWorker' in navigator
  && (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/static/sw.js').catch(() => {});
  });
}

// 朗读音色列表（系统语音异步加载完成后刷新下拉框）
if (window.speechSynthesis) {
  speechSynthesis.onvoiceschanged = () => { if (ttsEngine() === 'browser') renderVoiceOptions(); };
  setTimeout(() => { if (ttsEngine() === 'browser') renderVoiceOptions(); }, 300);
}

/* ---------------- 启动 ---------------- */
async function refreshArticles() {
  state.articles = await api('/api/articles');
  renderArticleList();
}

(async function init() {
  try {
    await refreshConfig();
  } catch (e) { console.warn('config load failed', e); }
  await refreshArticles();
  // 如有历史文章，自动打开最近一篇
  if (state.articles.length) {
    openArticle(state.articles[0].id);
  } else {
    showHome();
  }
})();
