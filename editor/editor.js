/* 多語字幕編輯器
 * 純前端，不需要伺服器；直接用瀏覽器開啟 index.html 即可。
 * 影片解碼 / 編碼使用 Mediabunny（lib/ 內，MPL-2.0）。
 */
(() => {
'use strict';

const MB = window.Mediabunny;
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => Array.from(root.querySelectorAll(s));

// =====================================================================
// 常數
// =====================================================================
const LANG_PRESETS = [
  ['zh-TW', '繁體中文'], ['zh-CN', '简体中文'], ['en', 'English'], ['ja', '日本語'],
  ['ko', '한국어'], ['es', 'Español'], ['fr', 'Français'], ['de', 'Deutsch'],
  ['pt', 'Português'], ['it', 'Italiano'], ['ru', 'Русский'], ['vi', 'Tiếng Việt'],
  ['th', 'ไทย'], ['id', 'Bahasa Indonesia'], ['ms', 'Bahasa Melayu'], ['hi', 'हिन्दी'],
  ['ar', 'العربية'], ['tr', 'Türkçe'], ['nl', 'Nederlands'], ['pl', 'Polski'],
];
const RTL_RE = /^(ar|he|fa|ur)(-|$)/i;
const COMMENT_THEMES = {
  dark:   { label: '深色',   bg: 'rgba(17,24,39,0.92)', fg: '#ffffff', accent: '#4f8cff' },
  light:  { label: '白底',   bg: 'rgba(255,255,255,0.95)', fg: '#111827', accent: '#4f8cff' },
  note:   { label: '便利貼', bg: 'rgba(253,224,71,0.96)', fg: '#1c1917', accent: '#b45309' },
  alert:  { label: '醒目紅', bg: 'rgba(220,38,38,0.94)', fg: '#ffffff', accent: '#7f1d1d' },
  green:  { label: '綠色',   bg: 'rgba(22,163,74,0.94)', fg: '#ffffff', accent: '#14532d' },
  glass:  { label: '半透明', bg: 'rgba(0,0,0,0.5)', fg: '#ffffff', accent: 'rgba(255,255,255,0.85)' },
};
const FONT_STACK = '"Noto Sans TC","Noto Sans CJK TC","Microsoft JhengHei","PingFang TC","Hiragino Sans","Noto Sans","Segoe UI",system-ui,sans-serif';
const FRAME = 1 / 30;
const MIN_LEN = 0.1;
const DEFAULT_SUB_LEN = 2.5;
const DEFAULT_CMT_LEN = 5;
const LANE_H = 26;
const AUTOSAVE_PREFIX = 'mlsub.autosave.';

// =====================================================================
// 狀態
// =====================================================================
function newProject() {
  return {
    app: 'mlsub-editor',
    version: 1,
    nextId: 1,
    source: null,
    languages: [{ code: 'zh-TW', name: '繁體中文' }],
    display: { primary: 'zh-TW', secondary: '' },
    subtitles: [],
    comments: [],
    cuts: [],
    style: {
      sub: {
        size: 5.5, color: '#ffffff', outline: '#000000', outlineW: 14,
        box: false, boxColor: '#000000', boxOpacity: 55, bottom: 7,
        size2: 78, color2: '#ffe27a',
      },
      cmt: { size: 3.6, fade: true },
    },
  };
}

let P = newProject();               // 專案資料（會被存檔）
const S = {                         // 執行期狀態（不存檔）
  file: null,
  url: '',
  duration: 0,
  sel: null,                        // { kind: 'sub' | 'cmt' | 'cut', id }
  mark: { in: null, out: null },
  zoom: 60,                         // 每秒幾個像素
  peaks: null,                      // 音量波形
  waveState: '',                    // '' | 'loading' | 'ready' | 'none'
  peaksMax: 0,
  waveToken: 0,
  projectHandle: null,
  dirty: false,
};

const video = $('#video');
const overlay = $('#overlay');
const stage = $('#stage');

// =====================================================================
// 小工具
// =====================================================================
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const pad = (n, w = 2) => String(n).padStart(w, '0');

function fmtTime(t, withMs = true) {
  if (!Number.isFinite(t) || t < 0) t = 0;
  const ms = Math.round(t * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor(ms / 60000) % 60;
  const s = Math.floor(ms / 1000) % 60;
  const f = ms % 1000;
  const core = (h ? `${h}:${pad(m)}` : pad(m)) + ':' + pad(s);
  return withMs ? `${core}.${pad(f, 3)}` : core;
}

function parseTime(str) {
  str = String(str).trim().replace(',', '.');
  if (!str) return NaN;
  const parts = str.split(':');
  if (parts.length > 3 || parts.some(p => p === '' || isNaN(+p))) return NaN;
  return parts.reduce((acc, p) => acc * 60 + parseFloat(p), 0);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function langName(code) {
  const l = P.languages.find(l => l.code === code);
  return l ? l.name : code;
}

function newId(prefix) {
  return prefix + (P.nextId++);
}

let toastTimer = 0;
function toast(msg, isErr = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('err', isErr);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), isErr ? 5000 : 2400);
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

function baseName() {
  const n = (S.file && S.file.name) || (P.source && P.source.name) || 'project';
  return n.replace(/\.[^.]+$/, '');
}

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); return true; } catch { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

// =====================================================================
// 專案資料操作
// =====================================================================
function findItem(kind, id) {
  const arr = kind === 'sub' ? P.subtitles : kind === 'cmt' ? P.comments : P.cuts;
  return arr.find(x => x.id === id) || null;
}

function selectedItem() {
  return S.sel ? findItem(S.sel.kind, S.sel.id) : null;
}

function sortItems() {
  P.subtitles.sort((a, b) => a.start - b.start || a.end - b.end);
  P.comments.sort((a, b) => a.start - b.start || a.end - b.end);
  P.cuts.sort((a, b) => a.start - b.start);
}

function itemText(item, lang) {
  return (item && item.text && item.text[lang]) || '';
}

function missingLangs(item) {
  return P.languages.filter(l => !itemText(item, l.code).trim()).map(l => l.code);
}

/** 合併重疊的剪掉區段，回傳 [[start, end], ...] */
function mergedCuts() {
  const arr = P.cuts.map(c => [clamp(c.start, 0, S.duration || Infinity), clamp(c.end, 0, S.duration || Infinity)])
    .filter(([a, b]) => b - a > 1e-3)
    .sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const r of arr) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1] + 1e-6) last[1] = Math.max(last[1], r[1]);
    else out.push([...r]);
  }
  return out;
}

/** 保留下來的區段 */
function keptRanges() {
  const out = [];
  let t = 0;
  for (const [a, b] of mergedCuts()) {
    if (a > t) out.push([t, a]);
    t = Math.max(t, b);
  }
  if (S.duration > t) out.push([t, S.duration]);
  return out;
}

/** 原始時間 → 剪輯後時間 */
function mapTime(t, cuts) {
  let off = 0;
  for (const [a, b] of cuts) {
    if (t >= b) off += b - a;
    else if (t > a) { off += t - a; break; }
    else break;
  }
  return t - off;
}

// =====================================================================
// 復原 / 重做 / 自動暫存
// =====================================================================
let lastSnap = JSON.stringify(P);
const undoStack = [];
const redoStack = [];
let autosaveTimer = 0;
let typingTimer = 0;

function commit() {
  clearTimeout(typingTimer);
  const now = JSON.stringify(P);
  if (now === lastSnap) return;
  undoStack.push(lastSnap);
  if (undoStack.length > 300) undoStack.shift();
  redoStack.length = 0;
  lastSnap = now;
  markDirty();
}

function commitSoon() {
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => { commit(); renderLists(); renderLangTable(); }, 700);
}

function markDirty() {
  S.dirty = true;
  updateUndoButtons();
  $('#saveState').textContent = '尚未儲存';
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(autosave, 1000);
}

function autosaveKey() {
  const src = P.source || (S.file && { name: S.file.name, size: S.file.size });
  return src ? AUTOSAVE_PREFIX + src.name + '|' + src.size : null;
}

function autosave() {
  const key = autosaveKey();
  if (!key) return;
  const ok = store.set(key, JSON.stringify({ savedAt: Date.now(), project: P }));
  if (ok && S.dirty) $('#saveState').textContent = '已暫存於瀏覽器（尚未存檔）';
}

function undo() {
  commit();
  if (!undoStack.length) return;
  redoStack.push(lastSnap);
  lastSnap = undoStack.pop();
  P = JSON.parse(lastSnap);
  afterProjectReplaced(false);
  markDirty();
}

function redo() {
  if (!redoStack.length) return;
  undoStack.push(lastSnap);
  lastSnap = redoStack.pop();
  P = JSON.parse(lastSnap);
  afterProjectReplaced(false);
  markDirty();
}

function updateUndoButtons() {
  $('#undoBtn').disabled = !undoStack.length && JSON.stringify(P) === lastSnap;
  $('#redoBtn').disabled = !redoStack.length;
}

function afterProjectReplaced(resetSel = true) {
  normalizeProject();
  if (resetSel || (S.sel && !selectedItem())) S.sel = null;
  renderAll();
}

function normalizeProject() {
  const d = newProject();
  P.languages = Array.isArray(P.languages) && P.languages.length ? P.languages : d.languages;
  P.display = Object.assign({}, d.display, P.display);
  if (!P.languages.some(l => l.code === P.display.primary)) P.display.primary = P.languages[0].code;
  if (P.display.secondary && !P.languages.some(l => l.code === P.display.secondary)) P.display.secondary = '';
  P.subtitles = P.subtitles || [];
  P.comments = P.comments || [];
  P.cuts = P.cuts || [];
  P.style = { sub: Object.assign({}, d.style.sub, P.style && P.style.sub), cmt: Object.assign({}, d.style.cmt, P.style && P.style.cmt) };
  for (const c of P.comments) {
    c.x ??= 0.5; c.y ??= 0.2; c.w ??= 0.42; c.size ??= 1; c.theme ??= 'dark';
    c.text ??= {};
  }
  for (const s of P.subtitles) s.text ??= {};
  const maxId = [...P.subtitles, ...P.comments, ...P.cuts]
    .map(x => parseInt(String(x.id).replace(/\D/g, ''), 10) || 0)
    .reduce((a, b) => Math.max(a, b), 0);
  P.nextId = Math.max(P.nextId || 1, maxId + 1);
  sortItems();
}

// =====================================================================
// 文字排版（預覽與輸出共用，確保看到的就是輸出的）
// =====================================================================
const segmenters = new Map();
function getSegmenter(lang) {
  if (!('Segmenter' in Intl)) return null;
  const key = lang || '';
  if (!segmenters.has(key)) {
    try { segmenters.set(key, new Intl.Segmenter(lang || undefined, { granularity: 'word' })); }
    catch { segmenters.set(key, new Intl.Segmenter(undefined, { granularity: 'word' })); }
  }
  return segmenters.get(key);
}

const NO_LINE_START = /^[，。、！？；：」』）》〉】,.!?;:)\]}%…・ー〜]/;

function wrapText(ctx, text, maxW, lang) {
  const lines = [];
  const seg = getSegmenter(lang);
  for (const para of String(text).split(/\r?\n/)) {
    const tokens = seg ? Array.from(seg.segment(para), s => s.segment) : para.split(/(\s+)/);
    let line = '';
    for (const tok of tokens) {
      if (!tok) continue;
      const test = line + tok;
      if (!line || ctx.measureText(test).width <= maxW || NO_LINE_START.test(tok)) {
        if (!line && ctx.measureText(tok).width > maxW) {
          // 單一個詞就超過寬度：逐字斷行
          for (const ch of Array.from(tok)) {
            if (line && ctx.measureText(line + ch).width > maxW) { lines.push(line); line = ch; }
            else line += ch;
          }
        } else {
          line = test;
        }
      } else {
        lines.push(line.trimEnd());
        line = tok.trimStart();
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

function hexToRgba(hex, alpha) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${alpha})`;
}

/**
 * 在畫布上畫出 t 秒時的字幕與註解。
 * opt: { primary, secondary, subs, cmts, editor, selId }
 * 回傳每個註解的位置框（供預覽畫面拖曳用）。
 */
function renderOverlay(ctx, W, H, t, opt) {
  const boxes = [];
  if (opt.cmts) drawComments(ctx, W, H, t, opt, boxes);
  if (opt.subs) drawSubtitles(ctx, W, H, t, opt);
  return boxes;
}

function drawSubtitles(ctx, W, H, t, opt) {
  const st = P.style.sub;
  const cues = P.subtitles.filter(c => t >= c.start && t < c.end);
  if (!cues.length) return;
  const fs1 = H * st.size / 100;
  const fs2 = fs1 * st.size2 / 100;
  const maxW = W * 0.9;
  const blocks = [];
  for (const cue of cues) {
    for (const [lang, fs, color] of [[opt.primary, fs1, st.color], [opt.secondary, fs2, st.color2]]) {
      if (!lang) continue;
      const txt = itemText(cue, lang).trim();
      ctx.font = `700 ${fs}px ${FONT_STACK}`;
      if (txt) blocks.push({ lines: wrapText(ctx, txt, maxW, lang), fs, color, lang });
      else if (opt.editor) blocks.push({ lines: [`（${langName(lang)}：未填）`], fs: fs * 0.8, color: 'rgba(255,255,255,0.5)', lang, ghost: true });
    }
  }
  if (!blocks.length) return;

  const lineH = fs => fs * 1.28;
  let total = 0;
  for (const b of blocks) total += b.lines.length * lineH(b.fs);
  let y = H - H * st.bottom / 100 - total;

  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  for (const b of blocks) {
    ctx.font = `700 ${b.fs}px ${FONT_STACK}`;
    ctx.direction = RTL_RE.test(b.lang) ? 'rtl' : 'ltr';
    for (const line of b.lines) {
      const cy = y + lineH(b.fs) / 2;
      if (st.box && !b.ghost && line) {
        const w = ctx.measureText(line).width + b.fs * 0.6;
        ctx.fillStyle = hexToRgba(st.boxColor, st.boxOpacity / 100);
        roundRect(ctx, W / 2 - w / 2, y + 1, w, lineH(b.fs) - 2, b.fs * 0.15);
        ctx.fill();
      }
      if (st.outlineW > 0 && !b.ghost) {
        ctx.lineWidth = b.fs * st.outlineW / 100;
        ctx.strokeStyle = st.outline;
        ctx.strokeText(line, W / 2, cy);
      }
      ctx.fillStyle = b.color;
      ctx.fillText(line, W / 2, cy);
      y += lineH(b.fs);
    }
  }
  ctx.restore();
}

function drawComments(ctx, W, H, t, opt, boxes) {
  const base = H * P.style.cmt.size / 100;
  for (const c of P.comments) {
    if (!(t >= c.start && t < c.end)) continue;
    const th = COMMENT_THEMES[c.theme] || COMMENT_THEMES.dark;
    const fs1 = base * c.size;
    const fs2 = fs1 * 0.82;
    const padX = fs1 * 0.7, padY = fs1 * 0.5;
    const bar = Math.max(2, fs1 * 0.18);
    const maxText = Math.max(fs1 * 2, c.w * W - padX * 2 - bar);
    const parts = [];
    for (const [lang, fs, weight, alpha] of [[opt.primary, fs1, 700, 1], [opt.secondary, fs2, 500, 0.85]]) {
      if (!lang) continue;
      const txt = itemText(c, lang).trim();
      ctx.font = `${weight} ${fs}px ${FONT_STACK}`;
      if (txt) parts.push({ lines: wrapText(ctx, txt, maxText, lang), fs, weight, alpha, lang });
      else if (opt.editor) parts.push({ lines: [`（${langName(lang)}：未填）`], fs: fs * 0.85, weight: 400, alpha: 0.55, lang });
    }
    if (!parts.length) continue;

    let textW = 0, textH = 0;
    for (const p of parts) {
      ctx.font = `${p.weight} ${p.fs}px ${FONT_STACK}`;
      for (const l of p.lines) textW = Math.max(textW, ctx.measureText(l).width);
      textH += p.lines.length * p.fs * 1.3;
    }
    const bw = textW + padX * 2 + bar;
    const bh = textH + padY * 2;
    const x = clamp(c.x * W - bw / 2, 0, Math.max(0, W - bw));
    const y = clamp(c.y * H - bh / 2, 0, Math.max(0, H - bh));

    let alpha = 1;
    if (P.style.cmt.fade && !opt.noFade) alpha = clamp(Math.min((t - c.start) / 0.3, (c.end - t) / 0.3), 0, 1);

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.shadowColor = 'rgba(0,0,0,0.35)';
    ctx.shadowBlur = fs1 * 0.5;
    ctx.shadowOffsetY = fs1 * 0.12;
    ctx.fillStyle = th.bg;
    roundRect(ctx, x, y, bw, bh, fs1 * 0.35);
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.save();
    roundRect(ctx, x, y, bw, bh, fs1 * 0.35);
    ctx.clip();
    ctx.fillStyle = th.accent;
    ctx.fillRect(x, y, bar, bh);
    ctx.restore();

    ctx.textBaseline = 'middle';
    let ty = y + padY;
    for (const p of parts) {
      const rtl = RTL_RE.test(p.lang);
      ctx.direction = rtl ? 'rtl' : 'ltr';
      ctx.textAlign = rtl ? 'right' : 'left';
      ctx.font = `${p.weight} ${p.fs}px ${FONT_STACK}`;
      ctx.fillStyle = th.fg;
      ctx.globalAlpha = alpha * p.alpha;
      for (const l of p.lines) {
        const lh = p.fs * 1.3;
        ctx.fillText(l, rtl ? x + bw - padX : x + bar + padX, ty + lh / 2);
        ty += lh;
      }
    }
    ctx.restore();

    if (opt.editor && opt.selId === c.id) {
      ctx.save();
      ctx.setLineDash([6, 4]);
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#ffffff';
      ctx.strokeRect(x - 3, y - 3, bw + 6, bh + 6);
      ctx.restore();
    }
    boxes.push({ id: c.id, x, y, w: bw, h: bh });
  }
}

// =====================================================================
// 預覽畫面
// =====================================================================
let stageRect = { x: 0, y: 0, w: 0, h: 0 };
let overlayBoxes = [];

function layoutStage() {
  const r = stage.getBoundingClientRect();
  const vw = video.videoWidth || 16, vh = video.videoHeight || 9;
  const s = Math.min(r.width / vw, r.height / vh) || 1;
  const w = Math.max(1, Math.floor(vw * s)), h = Math.max(1, Math.floor(vh * s));
  const x = Math.floor((r.width - w) / 2), y = Math.floor((r.height - h) / 2);
  stageRect = { x, y, w, h };
  for (const el of [video, overlay]) {
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    el.style.width = w + 'px';
    el.style.height = h + 'px';
  }
  const dpr = window.devicePixelRatio || 1;
  overlay.width = Math.round(w * dpr);
  overlay.height = Math.round(h * dpr);
  requestRender();
}

function renderPreview() {
  const ctx = overlay.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  if (!S.file) { overlayBoxes = []; return; }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  overlayBoxes = renderOverlay(ctx, stageRect.w, stageRect.h, video.currentTime, {
    primary: P.display.primary,
    secondary: P.display.secondary,
    subs: true,
    cmts: true,
    editor: true,
    noFade: video.paused,
    selId: S.sel && S.sel.kind === 'cmt' ? S.sel.id : null,
  });
}

let rafPending = false;
function requestRender() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(frameTick);
}

function frameTick() {
  rafPending = false;
  const t = video.currentTime;
  if (!video.paused && $('#skipCutsChk').checked) {
    for (const [a, b] of mergedCuts()) {
      if (t >= a && t < b - 0.03) {
        if (b >= S.duration - 0.05) { video.pause(); video.currentTime = Math.max(0, a - 0.001); }
        else video.currentTime = b;
        break;
      }
    }
  }
  renderPreview();
  updatePlayhead();
  updateNowMarkers();
  $('#timeLbl').textContent = `${fmtTime(t)} / ${fmtTime(S.duration)}`;
  if (!video.paused) requestRender();
}

// 在預覽畫面上拖曳註解
let cmtDrag = null;
overlay.addEventListener('pointerdown', e => {
  if (!S.file) return;
  const p = overlayPoint(e);
  const hit = [...overlayBoxes].reverse().find(b => p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h);
  if (hit) {
    const c = findItem('cmt', hit.id);
    select('cmt', c.id, { seek: false });
    cmtDrag = { id: c.id, px: p.x, py: p.y, ox: c.x, oy: c.y, moved: false };
    overlay.setPointerCapture(e.pointerId);
    overlay.classList.add('grabbing');
    e.preventDefault();
  } else {
    togglePlay();
  }
});
overlay.addEventListener('pointermove', e => {
  const p = overlayPoint(e);
  if (cmtDrag) {
    const c = findItem('cmt', cmtDrag.id);
    if (!c) return;
    c.x = clamp(cmtDrag.ox + (p.x - cmtDrag.px) / stageRect.w, 0, 1);
    c.y = clamp(cmtDrag.oy + (p.y - cmtDrag.py) / stageRect.h, 0, 1);
    cmtDrag.moved = true;
    requestRender();
  } else {
    const over = overlayBoxes.some(b => p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h);
    overlay.classList.toggle('grab', over);
  }
});
overlay.addEventListener('pointerup', () => {
  if (!cmtDrag) return;
  overlay.classList.remove('grabbing');
  if (cmtDrag.moved) { commit(); renderEditor(); }
  cmtDrag = null;
});
function overlayPoint(e) {
  const r = overlay.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

// =====================================================================
// 播放控制
// =====================================================================
function togglePlay() {
  if (!S.file) return;
  if (video.paused) {
    if (video.currentTime >= S.duration - 0.05) video.currentTime = 0;
    video.play().catch(() => {});
  } else video.pause();
}

function seek(t) {
  if (!S.file) return;
  video.currentTime = clamp(t, 0, S.duration || 0);
  requestRender();
}

video.addEventListener('play', () => { $('#playBtn').textContent = '⏸'; requestRender(); });
video.addEventListener('pause', () => { $('#playBtn').textContent = '▶'; requestRender(); });
video.addEventListener('seeked', requestRender);
video.addEventListener('timeupdate', requestRender);
video.addEventListener('loadedmetadata', onVideoLoaded);
video.addEventListener('error', () => {
  if (!S.file) return;
  toast('瀏覽器無法播放這個影片格式。建議轉成 MP4 (H.264/AAC) 後再開啟。', true);
});

// =====================================================================
// 開啟影片 / 專案
// =====================================================================
function openVideoFile(file) {
  if (!file) return;
  if (S.url) URL.revokeObjectURL(S.url);
  S.file = file;
  S.url = URL.createObjectURL(file);
  S.peaks = null;
  S.mark = { in: null, out: null };
  video.src = S.url;
  $('#stageEmpty').hidden = true;
  document.title = `${file.name} – 多語字幕編輯器`;
}

function onVideoLoaded() {
  S.duration = video.duration || 0;
  const file = S.file;
  const src = { name: file.name, size: file.size, duration: S.duration };
  const hasContent = P.subtitles.length || P.comments.length || P.cuts.length;

  if (P.source && hasContent && (P.source.name !== src.name || Math.abs((P.source.duration || 0) - src.duration) > 1)) {
    toast(`注意：專案原本對應的影片是「${P.source.name}」，與目前開啟的影片不同。`, true);
  }
  if (!hasContent) {
    // 有上次自動暫存的內容就詢問是否還原
    const saved = store.get(AUTOSAVE_PREFIX + src.name + '|' + src.size);
    if (saved) {
      try {
        const data = JSON.parse(saved);
        const p = data.project;
        const n = (p.subtitles || []).length + (p.comments || []).length;
        if (n && confirm(`找到這支影片上次的編輯內容（${new Date(data.savedAt).toLocaleString()}，${n} 個字幕 / 註解）。\n要還原嗎？`)) {
          P = p;
          normalizeProject();
          undoStack.length = 0; redoStack.length = 0;
          lastSnap = JSON.stringify(P);
        }
      } catch { /* ignore */ }
    }
  }
  P.source = src;
  lastSnap = JSON.stringify(P);
  updateUndoButtons();
  zoomFit();
  layoutStage();
  renderAll();
  computeWaveform(file);
}

async function openProjectFile(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!data || data.app !== 'mlsub-editor') throw new Error('這不是本程式的專案檔');
    commit();
    if (undoStack.length || JSON.stringify(P) !== JSON.stringify(newProject())) undoStack.push(lastSnap);
    const curSource = P.source;
    P = data;
    if (curSource && S.file && (!P.source || P.source.name !== curSource.name)) {
      toast(`專案對應的影片是「${P.source ? P.source.name : '未知'}」，請確認影片是否正確。`, true);
    }
    afterProjectReplaced();
    lastSnap = JSON.stringify(P);
    S.dirty = false;
    $('#saveState').textContent = '已開啟專案';
    updateUndoButtons();
    if (!S.file) {
      $('#stageEmpty').querySelector('.big').textContent = `請開啟影片：${P.source ? P.source.name : ''}`;
      toast('專案已載入，請再開啟對應的影片檔。');
    }
  } catch (err) {
    toast('無法開啟專案：' + err.message, true);
  }
}

async function saveProject() {
  commit();
  const json = JSON.stringify(P, null, 1);
  const name = baseName() + '.project.json';
  try {
    if (window.showSaveFilePicker) {
      if (!S.projectHandle) {
        S.projectHandle = await window.showSaveFilePicker({
          suggestedName: name,
          types: [{ description: '字幕專案', accept: { 'application/json': ['.json'] } }],
        });
      }
      const w = await S.projectHandle.createWritable();
      await w.write(json);
      await w.close();
    } else {
      download(new Blob([json], { type: 'application/json' }), name);
    }
    S.dirty = false;
    $('#saveState').textContent = '已儲存 ' + new Date().toLocaleTimeString();
    toast('專案已儲存');
  } catch (err) {
    if (err && err.name === 'AbortError') return;
    S.projectHandle = null;
    download(new Blob([json], { type: 'application/json' }), name);
    S.dirty = false;
  }
}

// =====================================================================
// 音量波形（背景計算）
// =====================================================================
async function computeWaveform(file) {
  const token = ++S.waveToken;
  S.waveState = 'none';
  if (!MB) return drawWave();
  S.waveState = 'loading';
  drawWave();
  try {
    const input = new MB.Input({ source: new MB.BlobSource(file), formats: MB.ALL_FORMATS });
    const track = await input.getPrimaryAudioTrack();
    if (!track || !(await track.canDecode())) { S.waveState = 'none'; return drawWave(); }
    const RATE = 100;
    const peaks = new Float32Array(Math.ceil((S.duration || 1) * RATE) + 1);
    S.peaks = peaks;
    S.peaksMax = 0.01;
    const sink = new MB.AudioSampleSink(track);
    let buf = new Float32Array(0);
    let lastDraw = performance.now();
    for await (const s of sink.samples()) {
      if (token !== S.waveToken) { s.close(); return; }
      const n = s.numberOfFrames;
      if (buf.length < n) buf = new Float32Array(n);
      s.copyTo(buf, { planeIndex: 0, format: 'f32-planar', frameCount: n });
      const k = RATE / s.sampleRate;
      const base = s.timestamp * RATE;
      for (let i = 0; i < n; i += 2) {
        const idx = Math.floor(base + i * k);
        const v = Math.abs(buf[i]);
        if (idx >= 0 && idx < peaks.length && v > peaks[idx]) peaks[idx] = v;
      }
      s.close();
      if (performance.now() - lastDraw > 400) {
        lastDraw = performance.now();
        updatePeakMax();
        drawWave();
      }
    }
    S.waveState = 'ready';
    updatePeakMax();
    drawWave();
  } catch (err) {
    console.warn('waveform failed', err);
    if (token === S.waveToken && !S.peaks) { S.waveState = 'none'; drawWave(); }
  }
}

function updatePeakMax() {
  const p = S.peaks;
  if (!p) return;
  // 用 99.5 百分位當作最大值，避免單一爆音把整體壓扁
  const sample = [];
  for (let i = 0; i < p.length; i += Math.max(1, Math.floor(p.length / 4000))) sample.push(p[i]);
  sample.sort((a, b) => a - b);
  S.peaksMax = Math.max(0.01, sample[Math.floor(sample.length * 0.995)] || 0.01);
}

// =====================================================================
// 時間軸
// =====================================================================
const tlScroll = $('#tlScroll');
const tlInner = $('#tlInner');
const rulerCanvas = $('#tlRuler');
const waveCanvas = $('#waveCanvas');

const timeToX = t => t * S.zoom;
const xToTime = x => x / S.zoom;

function assignLanes(items) {
  const ends = [];
  const lanes = new Map();
  for (const it of [...items].sort((a, b) => a.start - b.start)) {
    let lane = ends.findIndex(e => e <= it.start + 1e-6);
    if (lane < 0) { lane = ends.length; ends.push(0); }
    ends[lane] = it.end;
    lanes.set(it.id, lane);
  }
  return { lanes, count: Math.max(1, ends.length) };
}

function renderTimeline() {
  const width = Math.max(tlScroll.clientWidth, timeToX(S.duration) + 60);
  tlInner.style.width = width + 'px';

  const rows = [
    ['rowCut', 'cut', P.cuts],
    ['rowSub', 'sub', P.subtitles],
    ['rowCmt', 'cmt', P.comments],
  ];
  for (const [rowId, kind, items] of rows) {
    const row = $('#' + rowId);
    const { lanes, count } = assignLanes(items);
    const h = count * LANE_H + 4;
    row.style.height = h + 'px';
    $(`#tlLabels .lbl[data-row="${kind}"]`).style.height = h + 'px';
    let html = '';
    for (const it of items) {
      const left = timeToX(it.start);
      const w = Math.max(3, timeToX(it.end) - left);
      const isSel = S.sel && S.sel.kind === kind && S.sel.id === it.id;
      let label, cls = '';
      if (kind === 'cut') label = '✂ 剪掉 ' + (it.end - it.start).toFixed(1) + 's';
      else {
        label = itemText(it, P.display.primary) || P.languages.map(l => itemText(it, l.code)).find(Boolean) || '';
        if (!label) { label = '（空白）'; cls += ' empty'; }
        if (missingLangs(it).length && P.languages.length > 1) cls += ' incomplete';
      }
      html += `<div class="blk ${kind}${cls}${isSel ? ' sel' : ''}" data-kind="${kind}" data-id="${it.id}" ` +
        `style="left:${left}px;width:${w}px;top:${2 + lanes.get(it.id) * LANE_H}px" title="${escapeHtml(fmtTime(it.start) + ' → ' + fmtTime(it.end) + '\n' + label)}">${escapeHtml(label.replace(/\n/g, ' '))}</div>`;
    }
    row.innerHTML = html;
  }
  $('#tlLabels .lbl[data-row="wave"]').style.height = $('#rowWave').offsetHeight + 'px';

  // 剪掉區段的灰色遮罩
  $('#tlShades').innerHTML = mergedCuts()
    .map(([a, b]) => `<div class="shade" style="left:${timeToX(a)}px;width:${timeToX(b) - timeToX(a)}px"></div>`)
    .join('');

  renderMark();
  drawRuler();
  drawWave();
  updatePlayhead();
}

function renderMark() {
  const m = $('#tlMark');
  const { in: a, out: b } = S.mark;
  if (a == null && b == null) { m.style.display = 'none'; return; }
  const s = a ?? 0, e = b ?? S.duration;
  m.style.display = 'block';
  m.style.left = timeToX(Math.min(s, e)) + 'px';
  m.style.width = Math.max(2, Math.abs(timeToX(e) - timeToX(s))) + 'px';
}

function sizeStickyCanvas(cv, h) {
  const w = tlScroll.clientWidth;
  const dpr = window.devicePixelRatio || 1;
  cv.style.width = w + 'px';
  cv.style.height = h + 'px';
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
  }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

function drawRuler() {
  const { ctx, w, h } = sizeStickyCanvas(rulerCanvas, 24);
  const sl = tlScroll.scrollLeft;
  // 選擇合適的刻度間距
  const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
  const major = steps.find(s => s * S.zoom >= 70) || 3600;
  const minor = major / (major >= 60 ? 6 : major >= 1 ? 5 : 2);
  ctx.fillStyle = '#9aa1ad';
  ctx.strokeStyle = '#3a4150';
  ctx.font = '11px ui-monospace, Consolas, monospace';
  ctx.textBaseline = 'top';
  const t0 = Math.floor(xToTime(sl) / minor) * minor;
  const t1 = xToTime(sl + w);
  ctx.beginPath();
  for (let t = t0; t <= t1 + minor; t += minor) {
    const x = Math.round(timeToX(t) - sl) + 0.5;
    const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
    ctx.moveTo(x, isMajor ? 12 : 18);
    ctx.lineTo(x, h);
    if (isMajor && t <= S.duration + 1e-6) ctx.fillText(fmtTime(t, major < 1), x + 3, 2);
  }
  ctx.stroke();
  // 已剪掉的區段在刻度上標紅
  ctx.fillStyle = 'rgba(239,68,68,0.6)';
  for (const [a, b] of mergedCuts()) ctx.fillRect(timeToX(a) - sl, h - 3, timeToX(b - a), 3);
}

function drawWave() {
  const { ctx, w, h } = sizeStickyCanvas(waveCanvas, 40);
  const p = S.peaks;
  if (!p) {
    ctx.fillStyle = '#4a5163';
    ctx.font = '12px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    if (S.waveState === 'loading') ctx.fillText('（分析聲音中…）', 8, h / 2);
    else if (S.waveState === 'none' && S.file) ctx.fillText('（沒有聲音軌或無法分析）', 8, h / 2);
    return;
  }
  const sl = tlScroll.scrollLeft;
  const RATE = 100;
  ctx.fillStyle = '#5b8def';
  const mid = h / 2;
  for (let x = 0; x < w; x++) {
    const a = Math.floor(xToTime(sl + x) * RATE);
    const b = Math.max(a + 1, Math.floor(xToTime(sl + x + 1) * RATE));
    if (a >= p.length) break;
    let m = 0;
    for (let i = a; i < b && i < p.length; i++) if (p[i] > m) m = p[i];
    const v = Math.min(1, Math.sqrt(m / S.peaksMax)) * (mid - 2);
    if (v > 0.3) ctx.fillRect(x, mid - v, 1, v * 2);
  }
}

function updatePlayhead() {
  const x = timeToX(video.currentTime || 0);
  $('#tlPlayhead').style.left = x + 'px';
  // 播放時讓播放頭保持在畫面中
  if (!video.paused) {
    const sl = tlScroll.scrollLeft, w = tlScroll.clientWidth;
    if (x > sl + w - 40 || x < sl) tlScroll.scrollLeft = x - 60;
  }
}

function setZoom(z, anchorTime) {
  z = clamp(z, 1, 600);
  if (z === S.zoom) return;
  const at = anchorTime ?? video.currentTime;
  // 讓錨點時間在畫面上的位置保持不動
  const screenX = clamp(timeToX(at) - tlScroll.scrollLeft, 0, tlScroll.clientWidth);
  S.zoom = z;
  renderTimeline();
  tlScroll.scrollLeft = Math.max(0, timeToX(at) - screenX);
  drawRuler();
  drawWave();
}

function zoomFit() {
  if (!S.duration) return;
  S.zoom = clamp((tlScroll.clientWidth - 70) / S.duration, 1, 600);
  renderTimeline();
  tlScroll.scrollLeft = 0;
}

tlScroll.addEventListener('scroll', () => { drawRuler(); drawWave(); });
tlScroll.addEventListener('wheel', e => {
  if (!(e.ctrlKey || e.metaKey)) return;
  e.preventDefault();
  const r = tlScroll.getBoundingClientRect();
  const t = xToTime(e.clientX - r.left + tlScroll.scrollLeft);
  setZoom(S.zoom * (e.deltaY < 0 ? 1.2 : 1 / 1.2), t);
}, { passive: false });

// 時間軸上的拖曳：點空白處跳轉，拖曳方塊移動，拖曳方塊邊緣調整長度
let tlDrag = null;
tlInner.addEventListener('pointerdown', e => {
  if (!S.file || e.button !== 0) return;
  const r = tlInner.getBoundingClientRect();
  const x = e.clientX - r.left;
  const blk = e.target.closest('.blk');
  if (blk) {
    const kind = blk.dataset.kind, id = blk.dataset.id;
    const it = findItem(kind, id);
    if (!it) return;
    select(kind, id, { seek: false });
    const br = blk.getBoundingClientRect();
    const edge = Math.min(8, br.width / 4);
    const mode = e.clientX - br.left < edge ? 'l' : br.right - e.clientX < edge ? 'r' : 'm';
    tlDrag = { kind, id, mode, x0: x, s0: it.start, e0: it.end, moved: false };
  } else {
    tlDrag = { mode: 'seek' };
    seek(xToTime(x));
  }
  tlInner.setPointerCapture(e.pointerId);
  e.preventDefault();
});
tlInner.addEventListener('pointermove', e => {
  const r = tlInner.getBoundingClientRect();
  const x = e.clientX - r.left;
  if (!tlDrag) {
    const blk = e.target.closest('.blk');
    if (blk) {
      const br = blk.getBoundingClientRect();
      const edge = Math.min(8, br.width / 4);
      blk.style.cursor = (e.clientX - br.left < edge || br.right - e.clientX < edge) ? 'ew-resize' : 'grab';
    }
    return;
  }
  if (tlDrag.mode === 'seek') { seek(xToTime(x)); return; }
  const it = findItem(tlDrag.kind, tlDrag.id);
  if (!it) return;
  let dt = xToTime(x - tlDrag.x0);
  if (Math.abs(x - tlDrag.x0) < 2 && !tlDrag.moved) return;
  tlDrag.moved = true;
  const snap = t => (Math.abs(timeToX(t) - timeToX(video.currentTime)) < 6 ? video.currentTime : t);
  const len = tlDrag.e0 - tlDrag.s0;
  if (tlDrag.mode === 'm') {
    let s = clamp(tlDrag.s0 + dt, 0, Math.max(0, S.duration - len));
    const ss = snap(s), se = snap(s + len);
    if (ss !== s) s = ss; else if (se !== s + len) s = se - len;
    it.start = s; it.end = s + len;
  } else if (tlDrag.mode === 'l') {
    it.start = clamp(snap(tlDrag.s0 + dt), 0, it.end - MIN_LEN);
  } else {
    it.end = clamp(snap(tlDrag.e0 + dt), it.start + MIN_LEN, S.duration);
  }
  renderTimeline();
  updateEditorTimes();
  requestRender();
});
tlInner.addEventListener('pointerup', () => {
  if (tlDrag && tlDrag.moved) {
    sortItems();
    commit();
    renderAll();
  }
  tlDrag = null;
});
tlInner.addEventListener('dblclick', e => {
  if (!S.file || e.target.closest('.blk')) return;
  const r = tlInner.getBoundingClientRect();
  const t = xToTime(e.clientX - r.left);
  const row = e.target.closest('.row');
  if (row && row.id === 'rowSub') addSubtitle(t);
  else if (row && row.id === 'rowCmt') addComment(t);
});

// =====================================================================
// 選取
// =====================================================================
function select(kind, id, { seek: doSeek = true, focus = false } = {}) {
  commit();
  const changed = !S.sel || S.sel.kind !== kind || S.sel.id !== id;
  S.sel = kind ? { kind, id } : null;
  const it = selectedItem();
  if (it && doSeek && (video.currentTime < it.start || video.currentTime >= it.end)) seek(it.start + 0.001);
  if (kind === 'sub' || kind === 'cmt') showTab(kind);
  if (changed) renderEditor();
  renderLists();
  renderTimeline();
  requestRender();
  if (focus) focusEditorText();
  scrollListToSelection();
}

function focusEditorText(lang) {
  const card = S.sel && S.sel.kind === 'cmt' ? $('#cmtEditor') : $('#subEditor');
  const ta = lang ? card.querySelector(`textarea[data-lang="${lang}"]`) : card.querySelector('textarea');
  if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
}

function scrollListToSelection() {
  if (!S.sel) return;
  const li = document.querySelector(`.item-list li[data-id="${S.sel.id}"]`);
  if (li) li.scrollIntoView({ block: 'nearest' });
}

// =====================================================================
// 新增 / 刪除 / 調整
// =====================================================================
function addSubtitle(at = video.currentTime, { focus = true } = {}) {
  if (!S.file) return toast('請先開啟影片');
  commit();
  const next = P.subtitles.find(s => s.start > at + 0.05);
  let end = Math.min(at + DEFAULT_SUB_LEN, S.duration);
  if (next && next.start - at >= 0.5) end = Math.min(end, next.start);
  if (end - at < MIN_LEN) end = Math.min(S.duration, at + MIN_LEN);
  const sub = { id: newId('s'), start: at, end, text: {} };
  P.subtitles.push(sub);
  sortItems();
  commit();
  select('sub', sub.id, { seek: false, focus });
  return sub;
}

function addComment(at = video.currentTime) {
  if (!S.file) return toast('請先開啟影片');
  commit();
  const last = P.comments[P.comments.length - 1];
  const c = {
    id: newId('c'),
    start: at,
    end: Math.min(at + DEFAULT_CMT_LEN, S.duration),
    text: {},
    x: 0.5, y: 0.18, w: 0.42, size: 1,
    theme: last ? last.theme : 'dark',
  };
  P.comments.push(c);
  sortItems();
  commit();
  select('cmt', c.id, { seek: false, focus: true });
}

function deleteSelected() {
  const it = selectedItem();
  if (!it) return;
  const kind = S.sel.kind;
  const arr = kind === 'sub' ? P.subtitles : kind === 'cmt' ? P.comments : P.cuts;
  const i = arr.indexOf(it);
  arr.splice(i, 1);
  commit();
  const nxt = arr[Math.min(i, arr.length - 1)];
  S.sel = null;
  if (nxt && kind !== 'cut') select(kind, nxt.id, { seek: false });
  else renderAll();
}

function setSelectedEdge(which) {
  const it = selectedItem();
  if (!it) return toast('請先選取一個字幕或註解');
  const t = video.currentTime;
  if (which === 'start') {
    it.start = clamp(t, 0, S.duration);
    if (it.end - it.start < MIN_LEN) it.end = Math.min(S.duration, it.start + Math.max(MIN_LEN, DEFAULT_SUB_LEN));
  } else {
    it.end = clamp(t, 0, S.duration);
    if (it.end - it.start < MIN_LEN) it.start = Math.max(0, it.end - MIN_LEN);
  }
  sortItems();
  commit();
  renderTimeline();
  updateEditorTimes();
  renderLists();
  requestRender();
}

function gotoCue(dir) {
  const list = P.subtitles;
  if (!list.length) return;
  const t = video.currentTime;
  let target;
  if (dir > 0) target = list.find(s => s.start > t + 0.01);
  else target = [...list].reverse().find(s => s.start < t - 0.3) || list[0];
  if (target) { select('sub', target.id, { seek: false }); seek(target.start + 0.001); }
}

function setMark(which) {
  if (!S.file) return;
  S.mark[which] = video.currentTime;
  if (S.mark.in != null && S.mark.out != null && S.mark.in > S.mark.out) {
    [S.mark.in, S.mark.out] = [S.mark.out, S.mark.in];
  }
  renderMark();
  toast(`${which === 'in' ? '入點' : '出點'}：${fmtTime(video.currentTime)}`);
}

function markRange() {
  const a = S.mark.in ?? 0, b = S.mark.out ?? S.duration;
  if (S.mark.in == null && S.mark.out == null) return null;
  return [Math.min(a, b), Math.max(a, b)];
}

function cutRange() {
  const r = markRange();
  if (!r || r[1] - r[0] < 0.05) return toast('請先用「入點 I」「出點 O」標出要剪掉的範圍');
  P.cuts.push({ id: newId('x'), start: r[0], end: r[1] });
  normalizeCuts();
  S.mark = { in: null, out: null };
  commit();
  renderAll();
  toast(`已剪掉 ${fmtTime(r[0])} – ${fmtTime(r[1])}（可在時間軸「剪輯」列選取後按 Delete 還原）`);
}

function keepRange() {
  const r = markRange();
  if (!r || r[1] - r[0] < 0.05) return toast('請先用「入點 I」「出點 O」標出要保留的範圍');
  if (r[0] > 0.01) P.cuts.push({ id: newId('x'), start: 0, end: r[0] });
  if (r[1] < S.duration - 0.01) P.cuts.push({ id: newId('x'), start: r[1], end: S.duration });
  normalizeCuts();
  S.mark = { in: null, out: null };
  commit();
  renderAll();
  toast(`只保留 ${fmtTime(r[0])} – ${fmtTime(r[1])}`);
}

function normalizeCuts() {
  P.cuts = mergedCuts().map(([a, b]) => {
    const old = P.cuts.find(c => Math.abs(c.start - a) < 1e-6 && Math.abs(c.end - b) < 1e-6);
    return old || { id: newId('x'), start: a, end: b };
  });
}

// =====================================================================
// 右側面板：編輯卡片與清單
// =====================================================================
function showTab(name) {
  for (const b of $$('#tabs button')) b.classList.toggle('on', b.dataset.tab === name);
  for (const t of $$('.tab')) t.hidden = t.id !== 'tab-' + name;
}

function renderEditor() {
  const it = selectedItem();
  const kind = S.sel && S.sel.kind;
  const empty = what => `<p class="hint empty-hint">${S.file ? `點選下方清單或時間軸上的${what}來編輯，或按「＋」新增。` : '請先開啟影片。'}</p>`;
  $('#subEditor').innerHTML = kind === 'sub' && it ? editorHtml('sub', it) : empty('字幕');
  $('#cmtEditor').innerHTML = kind === 'cmt' && it ? editorHtml('cmt', it) : empty('註解');
  if (kind === 'cut' && it) {
    $('#subEditor').innerHTML = editorHtml('cut', it);
    showTab('sub');
  }
}

function editorHtml(kind, it) {
  const idx = (kind === 'sub' ? P.subtitles : kind === 'cmt' ? P.comments : P.cuts).indexOf(it) + 1;
  const title = kind === 'sub' ? `字幕 #${idx}` : kind === 'cmt' ? `註解 #${idx}` : `剪掉的片段 #${idx}`;
  let h = `<div class="ec-head"><span>${title}</span><span class="spacer"></span>
    <span class="muted mono" data-f="len">${(it.end - it.start).toFixed(2)}s</span></div>
    <div class="time-row">
      <span class="muted">開始</span><input data-f="start" value="${fmtTime(it.start)}"><button data-a="setStart" title="設為目前位置 ([)">⤓ 目前</button>
      <span class="muted">結束</span><input data-f="end" value="${fmtTime(it.end)}"><button data-a="setEnd" title="設為目前位置 (])">⤓ 目前</button>
    </div>`;
  if (kind !== 'cut') {
    for (const l of P.languages) {
      h += `<div class="lang-field"><label><span>${escapeHtml(l.name)}</span><span class="mono">${escapeHtml(l.code)}</span></label>
        <textarea data-lang="${escapeHtml(l.code)}" rows="2" dir="${RTL_RE.test(l.code) ? 'rtl' : 'auto'}">${escapeHtml(itemText(it, l.code))}</textarea></div>`;
    }
  }
  if (kind === 'cmt') {
    h += `<div class="form-grid" style="margin-bottom:10px">
      <label>配色</label><select data-f="theme">${Object.entries(COMMENT_THEMES).map(([k, v]) => `<option value="${k}"${it.theme === k ? ' selected' : ''}>${v.label}</option>`).join('')}</select>
      <label>大小</label><div class="range"><input type="range" data-f="size" min="0.5" max="2.5" step="0.05" value="${it.size}"><output>${Math.round(it.size * 100)}%</output></div>
      <label>最大寬度</label><div class="range"><input type="range" data-f="w" min="0.15" max="0.95" step="0.01" value="${it.w}"><output>${Math.round(it.w * 100)}%</output></div>
      <label>位置</label><div class="inline-row">
        <button type="button" data-a="pos" data-x="0.5" data-y="0.15">上方</button>
        <button type="button" data-a="pos" data-x="0.5" data-y="0.5">中央</button>
        <button type="button" data-a="pos" data-x="0.22" data-y="0.15">左上</button>
        <button type="button" data-a="pos" data-x="0.78" data-y="0.15">右上</button>
        <span class="muted">或直接在畫面上拖曳</span></div>
    </div>`;
  }
  h += `<div class="ec-actions">`;
  if (kind === 'sub') h += `<button data-a="prev">⟵ 上一句</button><button data-a="next">下一句 ⟶</button>`;
  h += `<button data-a="play">▶ 播放這段</button><span class="spacer"></span>
    <button data-a="delete" class="danger">${kind === 'cut' ? '還原這段（取消剪掉）' : '刪除'}</button></div>`;
  return h;
}

function updateEditorTimes() {
  const it = selectedItem();
  if (!it) return;
  for (const card of [$('#subEditor'), $('#cmtEditor')]) {
    const s = card.querySelector('[data-f="start"]');
    if (!s) continue;
    if (document.activeElement !== s) s.value = fmtTime(it.start);
    const e = card.querySelector('[data-f="end"]');
    if (document.activeElement !== e) e.value = fmtTime(it.end);
    card.querySelector('[data-f="len"]').textContent = (it.end - it.start).toFixed(2) + 's';
  }
}

function bindEditor(card) {
  card.addEventListener('input', e => {
    const it = selectedItem();
    if (!it) return;
    const el = e.target;
    if (el.dataset.lang) {
      it.text[el.dataset.lang] = el.value;
      requestRender();
      updateListItemText(it);
      commitSoon();
    } else if (el.dataset.f === 'size' || el.dataset.f === 'w') {
      it[el.dataset.f] = parseFloat(el.value);
      el.nextElementSibling.textContent = Math.round(it[el.dataset.f] * 100) + '%';
      requestRender();
      commitSoon();
    } else if (el.dataset.f === 'theme') {
      it.theme = el.value;
      commit();
      requestRender();
    }
  });
  card.addEventListener('change', e => {
    const it = selectedItem();
    const el = e.target;
    if (!it || (el.dataset.f !== 'start' && el.dataset.f !== 'end')) return;
    const t = parseTime(el.value);
    if (!Number.isFinite(t)) { el.value = fmtTime(it[el.dataset.f]); return toast('時間格式例如 01:23.500', true); }
    if (el.dataset.f === 'start') it.start = clamp(t, 0, it.end - MIN_LEN);
    else it.end = clamp(t, it.start + MIN_LEN, S.duration);
    sortItems();
    commit();
    updateEditorTimes();
    renderTimeline();
    renderLists();
    requestRender();
  });
  card.addEventListener('focusout', e => { if (e.target.matches('textarea, input')) { commit(); renderLists(); renderTimeline(); renderLangTable(); } });
  card.addEventListener('click', e => {
    const b = e.target.closest('button[data-a]');
    if (!b) return;
    const it = selectedItem();
    if (!it) return;
    switch (b.dataset.a) {
      case 'setStart': setSelectedEdge('start'); break;
      case 'setEnd': setSelectedEdge('end'); break;
      case 'prev': case 'next': stepSubtitle(b.dataset.a === 'next' ? 1 : -1, null); break;
      case 'play': playRange(it.start, it.end); break;
      case 'delete': deleteSelected(); break;
      case 'pos':
        it.x = parseFloat(b.dataset.x); it.y = parseFloat(b.dataset.y);
        commit(); requestRender(); break;
    }
  });
  card.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.target.matches('textarea') && S.sel && S.sel.kind === 'sub') {
      e.preventDefault();
      stepSubtitle(1, e.target.dataset.lang, true);
    } else if (e.key === 'Escape') {
      e.target.blur();
    }
  });
}

/** 跳到上一句 / 下一句字幕；在第一個語言最後一句按 Enter 會自動新增下一句 */
function stepSubtitle(dir, lang, createIfLast = false) {
  commit();
  const cur = selectedItem();
  const i = P.subtitles.indexOf(cur);
  const target = P.subtitles[i + dir];
  if (target) {
    select('sub', target.id, { seek: video.paused });
  } else if (dir > 0 && createIfLast && cur && (!lang || lang === P.languages[0].code)) {
    const at = Math.max(cur.end, video.currentTime);
    if (at >= S.duration - MIN_LEN) return toast('已經到影片結尾');
    addSubtitle(at, { focus: false });
    if (video.paused) seek(at + 0.001);
  } else {
    return;
  }
  if (lang) focusEditorText(lang);
}

let rangeStopper = null;
function playRange(a, b) {
  seek(a + 0.001);
  video.play().catch(() => {});
  if (rangeStopper) video.removeEventListener('timeupdate', rangeStopper);
  rangeStopper = () => {
    if (video.currentTime >= b || video.paused) {
      if (video.currentTime >= b) video.pause();
      video.removeEventListener('timeupdate', rangeStopper);
      rangeStopper = null;
    }
  };
  video.addEventListener('timeupdate', rangeStopper);
}

function listItemHtml(kind, it, i) {
  const txt = itemText(it, P.display.primary) || P.languages.map(l => itemText(it, l.code)).find(Boolean) || '';
  const miss = P.languages.length > 1 ? missingLangs(it) : [];
  const isSel = S.sel && S.sel.kind === kind && S.sel.id === it.id;
  return `<li data-kind="${kind}" data-id="${it.id}" class="${isSel ? 'sel' : ''}">
    <span class="t">${i + 1}<br>${fmtTime(it.start)}</span>
    <span class="x${txt ? '' : ' empty'}">${escapeHtml(txt.replace(/\n/g, ' ') || '（空白）')}</span>
    <span class="miss">${miss.length ? '缺：' + miss.map(c => escapeHtml(langName(c))).join('、') : ''}</span>
  </li>`;
}

function renderLists() {
  const q = $('#subSearch').value.trim().toLowerCase();
  const subs = P.subtitles
    .map((s, i) => [s, i])
    .filter(([s]) => !q || Object.values(s.text).some(v => String(v).toLowerCase().includes(q)));
  $('#subList').innerHTML = subs.map(([s, i]) => listItemHtml('sub', s, i)).join('');
  $('#subCount').textContent = `共 ${P.subtitles.length} 句` + (q ? `，符合 ${subs.length} 句` : '');
  $('#cmtList').innerHTML = P.comments.map((c, i) => listItemHtml('cmt', c, i)).join('');
  $('#cmtCount').textContent = `共 ${P.comments.length} 個註解`;
  updateNowMarkers(true);
}

function updateListItemText(it) {
  const li = document.querySelector(`.item-list li[data-id="${it.id}"] .x`);
  if (!li) return;
  const txt = itemText(it, P.display.primary) || P.languages.map(l => itemText(it, l.code)).find(Boolean) || '';
  li.textContent = txt.replace(/\n/g, ' ') || '（空白）';
  li.classList.toggle('empty', !txt);
  const blk = document.querySelector(`.blk[data-id="${it.id}"]`);
  if (blk) blk.textContent = txt.replace(/\n/g, ' ') || '（空白）';
}

let lastNowKey = '';
function updateNowMarkers(force = false) {
  const t = video.currentTime;
  const now = [...P.subtitles, ...P.comments].filter(x => t >= x.start && t < x.end).map(x => x.id);
  const key = now.join(',');
  if (!force && key === lastNowKey) return;
  lastNowKey = key;
  for (const li of $$('.item-list li')) li.classList.toggle('now', now.includes(li.dataset.id));
}

for (const list of [$('#subList'), $('#cmtList')]) {
  list.addEventListener('click', e => {
    const li = e.target.closest('li');
    if (!li) return;
    const it = findItem(li.dataset.kind, li.dataset.id);
    select(li.dataset.kind, li.dataset.id, { seek: false });
    if (it) seek(it.start + 0.001);
  });
  list.addEventListener('dblclick', e => { if (e.target.closest('li')) focusEditorText(); });
}

// =====================================================================
// 語言管理與翻譯
// =====================================================================
function renderLangSelects() {
  const opts = P.languages.map(l => `<option value="${escapeHtml(l.code)}">${escapeHtml(l.name)}</option>`).join('');
  for (const id of ['#dispPrimary', '#exVPrimary']) {
    const sel = $(id);
    const keep = id === '#dispPrimary' ? P.display.primary : (sel.value || P.display.primary);
    sel.innerHTML = opts;
    sel.value = P.languages.some(l => l.code === keep) ? keep : P.languages[0].code;
  }
  for (const id of ['#dispSecondary', '#exVSecondary']) {
    const sel = $(id);
    const keep = id === '#dispSecondary' ? P.display.secondary : sel.value;
    sel.innerHTML = `<option value="">（不顯示第二語言）</option>` + opts;
    sel.value = P.languages.some(l => l.code === keep) ? keep : '';
  }
  const src = $('#trSource');
  const keepSrc = src.value || P.languages[0].code;
  src.innerHTML = opts;
  src.value = P.languages.some(l => l.code === keepSrc) ? keepSrc : P.languages[0].code;
  renderTrTargets();
}

function renderTrTargets() {
  const src = $('#trSource').value;
  const prev = new Set($$('#trTargets input:checked').map(i => i.value));
  const first = !$('#trTargets').dataset.init;
  $('#trTargets').innerHTML = P.languages.filter(l => l.code !== src).map(l =>
    `<label class="inline"><input type="checkbox" value="${escapeHtml(l.code)}"${first || prev.has(l.code) ? ' checked' : ''}> ${escapeHtml(l.name)}</label>`).join('')
    || '<span class="muted">請先在上方加入其他語言</span>';
  if (P.languages.length > 1) $('#trTargets').dataset.init = '1';
}

function renderLangTable() {
  const items = [...P.subtitles, ...P.comments];
  $('#langTable').innerHTML = P.languages.map((l, i) => {
    const done = items.filter(x => itemText(x, l.code).trim()).length;
    return `<tr data-code="${escapeHtml(l.code)}">
      <td><input data-a="name" value="${escapeHtml(l.name)}"></td>
      <td class="code">${escapeHtml(l.code)}</td>
      <td class="prog${items.length && done === items.length ? ' done' : ''}">${done} / ${items.length}</td>
      <td>${i > 0 ? `<button data-a="up" title="往上移">↑</button>` : ''}</td>
      <td>${P.languages.length > 1 ? `<button data-a="del" class="danger">移除</button>` : ''}</td>
    </tr>`;
  }).join('');
  const used = new Set(P.languages.map(l => l.code));
  $('#langPreset').innerHTML = LANG_PRESETS.filter(([c]) => !used.has(c))
    .map(([c, n]) => `<option value="${c}">${n}（${c}）</option>`).join('') + `<option value="__custom">其他語言…</option>`;
  toggleCustomLang();
}

function toggleCustomLang() {
  const custom = $('#langPreset').value === '__custom';
  $('#langCustomCode').hidden = !custom;
  $('#langCustomName').hidden = !custom;
}

function addLanguage(code, name) {
  code = String(code || '').trim();
  name = String(name || '').trim() || code;
  if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(code)) { toast('語言代碼格式例如 en、ja、pt-BR', true); return false; }
  if (P.languages.some(l => l.code.toLowerCase() === code.toLowerCase())) { toast('這個語言已經在專案中'); return false; }
  P.languages.push({ code, name });
  commit();
  renderAll();
  return true;
}

$('#langPreset').addEventListener('change', toggleCustomLang);
$('#addLangBtn').addEventListener('click', () => {
  const v = $('#langPreset').value;
  if (v === '__custom') {
    if (addLanguage($('#langCustomCode').value, $('#langCustomName').value)) {
      $('#langCustomCode').value = ''; $('#langCustomName').value = '';
    }
  } else {
    const p = LANG_PRESETS.find(([c]) => c === v);
    if (p) addLanguage(p[0], p[1]);
  }
});
$('#langTable').addEventListener('input', e => {
  const tr = e.target.closest('tr');
  const l = P.languages.find(x => x.code === tr.dataset.code);
  if (l && e.target.dataset.a === 'name') { l.name = e.target.value; commitSoon(); }
});
$('#langTable').addEventListener('change', () => { commit(); renderAll(); });
$('#langTable').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  const code = b.closest('tr').dataset.code;
  const i = P.languages.findIndex(l => l.code === code);
  if (b.dataset.a === 'del') {
    const n = [...P.subtitles, ...P.comments].filter(x => itemText(x, code).trim()).length;
    if (n && !confirm(`移除「${langName(code)}」會刪掉 ${n} 筆該語言的文字，確定嗎？（可以用復原找回）`)) return;
    P.languages.splice(i, 1);
    for (const x of [...P.subtitles, ...P.comments]) delete x.text[code];
  } else if (b.dataset.a === 'up' && i > 0) {
    [P.languages[i - 1], P.languages[i]] = [P.languages[i], P.languages[i - 1]];
  }
  normalizeProject();
  commit();
  renderAll();
});
$('#trSource').addEventListener('change', renderTrTargets);

function buildTranslationRequest() {
  const src = $('#trSource').value;
  const targets = $$('#trTargets input:checked').map(i => i.value);
  if (!targets.length) { toast('請勾選要翻譯成哪些語言', true); return null; }
  const onlyMissing = $('#trOnlyMissing').checked;
  const items = [];
  for (const x of [...P.subtitles, ...P.comments]) {
    const txt = itemText(x, src).trim();
    if (!txt) continue;
    if (onlyMissing && targets.every(t => itemText(x, t).trim())) continue;
    items.push({ id: x.id, text: txt });
  }
  if (!items.length) { toast(onlyMissing ? '沒有需要翻譯的項目（都已經翻好了）' : `「${langName(src)}」沒有任何文字可以翻譯`, true); return null; }
  const targetDesc = targets.map(c => `${c} (${langName(c)})`).join(', ');
  const prompt =
`You are a professional subtitle translator.
Translate the "text" of every item below from ${langName(src)} (${src}) into each of these languages: ${targetDesc}.

Rules:
- These are video subtitles and on-screen comments. Keep translations natural, concise and easy to read on screen.
- Keep line breaks (\\n) where reasonable. Do not merge, split, skip or reorder items.
- Keep names, brands and numbers accurate.
- Reply with JSON only (no explanations), in exactly this shape:
{"translations": {"<language code>": {"<item id>": "<translated text>"}}}

Items (${items.length}):
${JSON.stringify(items, null, 1)}`;
  return { prompt, count: items.length };
}

$('#trCopyBtn').addEventListener('click', async () => {
  commit();
  const req = buildTranslationRequest();
  if (!req) return;
  try {
    await navigator.clipboard.writeText(req.prompt);
    $('#trStatus').textContent = `已複製 ${req.count} 筆，請貼到 AI 聊天視窗。`;
    toast('已複製！請貼到 ChatGPT / Claude 等 AI，再把回覆貼回下方。');
  } catch {
    // 剪貼簿不可用時，把內容放進文字框讓使用者手動複製
    $('#trPaste').value = req.prompt;
    $('#trPaste').select();
    $('#trStatus').textContent = '無法自動複製，請手動複製上方文字框的內容（貼回 AI 的結果前請先清空）。';
  }
});

$('#trApplyBtn').addEventListener('click', () => {
  const raw = $('#trPaste').value;
  const a = raw.indexOf('{'), b = raw.lastIndexOf('}');
  let data;
  try {
    if (a < 0 || b < a) throw new Error();
    data = JSON.parse(raw.slice(a, b + 1));
  } catch {
    return toast('看不懂貼上的內容，請確認貼的是 AI 回覆的 JSON。', true);
  }
  const tr = data.translations || data;
  let n = 0;
  const unknown = [];
  for (const [code, map] of Object.entries(tr)) {
    if (!map || typeof map !== 'object') continue;
    let lang = P.languages.find(l => l.code.toLowerCase() === code.toLowerCase());
    if (!lang) {
      const preset = LANG_PRESETS.find(([c]) => c.toLowerCase() === code.toLowerCase());
      P.languages.push({ code: preset ? preset[0] : code, name: preset ? preset[1] : code });
      lang = P.languages[P.languages.length - 1];
    }
    for (const [id, text] of Object.entries(map)) {
      const it = findItem('sub', id) || findItem('cmt', id);
      if (!it) { unknown.push(id); continue; }
      it.text[lang.code] = String(text);
      n++;
    }
  }
  if (!n) return toast('沒有套用任何翻譯：找不到對應的項目編號。', true);
  commit();
  renderAll();
  $('#trPaste').value = '';
  $('#trStatus').textContent = `已套用 ${n} 筆翻譯` + (unknown.length ? `，${unknown.length} 筆找不到對應項目` : '');
  toast(`已套用 ${n} 筆翻譯`);
});

// =====================================================================
// 樣式設定
// =====================================================================
function getPath(obj, path) { return path.split('.').reduce((o, k) => o && o[k], obj); }
function setPath(obj, path, v) {
  const ks = path.split('.');
  const last = ks.pop();
  ks.reduce((o, k) => o[k], obj)[last] = v;
}
function styleOutput(path, v) {
  if (path === 'sub.size' || path === 'cmt.size') return v + '%';
  if (path === 'sub.bottom') return v + '%';
  if (path === 'sub.outlineW' || path === 'sub.boxOpacity' || path === 'sub.size2') return v + '%';
  return v;
}
function renderStyleForm() {
  for (const el of $$('[data-style]')) {
    const v = getPath(P.style, el.dataset.style);
    if (el.type === 'checkbox') el.checked = !!v;
    else el.value = v;
    const out = el.nextElementSibling;
    if (out && out.tagName === 'OUTPUT') out.textContent = styleOutput(el.dataset.style, v);
  }
}
$('#tab-style').addEventListener('input', e => {
  const el = e.target;
  if (!el.dataset.style) return;
  const v = el.type === 'checkbox' ? el.checked : el.type === 'range' ? parseFloat(el.value) : el.value;
  setPath(P.style, el.dataset.style, v);
  const out = el.nextElementSibling;
  if (out && out.tagName === 'OUTPUT') out.textContent = styleOutput(el.dataset.style, v);
  requestRender();
  commitSoon();
});

// =====================================================================
// 字幕檔匯入 / 匯出
// =====================================================================
function parseSubtitleFile(text) {
  text = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const re = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})\s*-->\s*(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/;
  const toSec = (h, m, s, ms) => (+h || 0) * 3600 + (+m) * 60 + (+s) + parseFloat('0.' + ms.padEnd(3, '0'));
  const cues = [];
  for (const block of text.split(/\n{2,}/)) {
    const lines = block.split('\n');
    const i = lines.findIndex(l => re.test(l));
    if (i < 0) continue;
    const m = re.exec(lines[i]);
    const start = toSec(m[1], m[2], m[3], m[4]);
    const end = toSec(m[5], m[6], m[7], m[8]);
    const body = lines.slice(i + 1).join('\n')
      .replace(/\{\\[^}]*\}/g, '')        // ASS 標籤，如 {\an8}
      .replace(/<[^>]+>/g, '')            // HTML / VTT 標籤
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .trim();
    if (body && end > start) cues.push({ start, end, text: body });
  }
  return cues;
}

function importCues(cues, lang) {
  let merged = 0, added = 0;
  for (const c of cues) {
    const match = P.subtitles.find(s => Math.abs(s.start - c.start) < 0.35 && Math.abs(s.end - c.end) < 0.35 && !itemText(s, lang).trim());
    if (match) { match.text[lang] = c.text; merged++; }
    else {
      P.subtitles.push({ id: newId('s'), start: c.start, end: c.end, text: { [lang]: c.text } });
      added++;
    }
  }
  sortItems();
  commit();
  renderAll();
  toast(`匯入完成：新增 ${added} 句` + (merged ? `，合併到現有字幕 ${merged} 句` : ''));
}

function askLanguage(title) {
  return new Promise(resolve => {
    const dlg = $('#langDlg');
    $('#langDlgTitle').textContent = title;
    const used = new Set(P.languages.map(l => l.code));
    $('#langDlgSel').innerHTML =
      `<optgroup label="專案中的語言">${P.languages.map(l => `<option value="${escapeHtml(l.code)}">${escapeHtml(l.name)}</option>`).join('')}</optgroup>` +
      `<optgroup label="新增語言">${LANG_PRESETS.filter(([c]) => !used.has(c)).map(([c, n]) => `<option value="${c}">${n}</option>`).join('')}</optgroup>`;
    dlg.returnValue = '';
    dlg.addEventListener('close', function onClose() {
      dlg.removeEventListener('close', onClose);
      resolve(dlg.returnValue === 'ok' ? $('#langDlgSel').value : null);
    });
    dlg.showModal();
  });
}

async function importSubtitleFile(file) {
  if (!S.file) return toast('請先開啟影片');
  const cues = parseSubtitleFile(await file.text());
  if (!cues.length) return toast('這個檔案裡找不到字幕（支援 SRT、VTT）', true);
  const lang = await askLanguage(`「${file.name}」（${cues.length} 句）是什麼語言？`);
  if (!lang) return;
  if (!P.languages.some(l => l.code === lang)) {
    const p = LANG_PRESETS.find(([c]) => c === lang);
    P.languages.push({ code: lang, name: p ? p[1] : lang });
  }
  importCues(cues, lang);
}

function srtTime(t, sep) {
  const ms = Math.max(0, Math.round(t * 1000));
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}${sep}${pad(ms % 1000, 3)}`;
}

function buildSubtitleFile(lang, fmt, applyCuts) {
  const cuts = applyCuts ? mergedCuts() : [];
  const out = [];
  for (const s of P.subtitles) {
    const txt = itemText(s, lang).trim();
    if (!txt) continue;
    const a = mapTime(s.start, cuts), b = mapTime(s.end, cuts);
    if (b - a < 0.05) continue;
    out.push({ a, b, txt });
  }
  if (fmt === 'vtt') {
    return 'WEBVTT\n\n' + out.map(c => `${srtTime(c.a, '.')} --> ${srtTime(c.b, '.')}\n${c.txt}`).join('\n\n') + '\n';
  }
  return out.map((c, i) => `${i + 1}\n${srtTime(c.a, ',')} --> ${srtTime(c.b, ',')}\n${c.txt}`).join('\n\n') + '\n';
}

// =====================================================================
// 輸出對話框
// =====================================================================
function openExport() {
  commit();
  if (!S.file) return toast('請先開啟影片');
  const hasCuts = P.cuts.length > 0;
  $('#exApplyCuts').checked = hasCuts;
  $('#exApplyCuts').disabled = !hasCuts;
  $('#exLangs').innerHTML = P.languages.map(l => {
    const n = P.subtitles.filter(s => itemText(s, l.code).trim()).length;
    return `<label class="inline"><input type="checkbox" value="${escapeHtml(l.code)}"${n ? ' checked' : ''}> ${escapeHtml(l.name)} <span class="muted">(${n})</span></label>`;
  }).join('');
  renderLangSelects();
  $('#exVPrimary').value = P.display.primary;
  $('#exVSecondary').value = P.display.secondary;

  const vw = video.videoWidth, vh = video.videoHeight;
  const short = Math.min(vw, vh);
  const opts = [[0, `原始（${vw}×${vh}）`]];
  for (const p of [1080, 720, 480]) if (p < short) opts.push([p, `${p}p`]);
  $('#exVRes').innerHTML = opts.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
  const vol = $('#exVVolume');
  vol.nextElementSibling.textContent = vol.value + '%';

  const ok = MB && 'VideoEncoder' in window;
  $('#exVideoBtn').disabled = !ok || !!exportJob;
  $('#exVSupport').textContent = ok ? '' : '這個瀏覽器不支援影片輸出，請改用最新版 Chrome 或 Edge。';
  $('#exportDlg').showModal();
}

$('#exVVolume').addEventListener('input', e => { e.target.nextElementSibling.textContent = e.target.value + '%'; });

$('#exSubsBtn').addEventListener('click', () => {
  const langs = $$('#exLangs input:checked').map(i => i.value);
  if (!langs.length) return toast('請勾選至少一個語言', true);
  const fmt = $('input[name="exFmt"]:checked').value;
  const apply = $('#exApplyCuts').checked;
  let n = 0;
  langs.forEach((lang, i) => {
    const content = buildSubtitleFile(lang, fmt, apply);
    if (!content.trim() || content.trim() === 'WEBVTT') return;
    // 多個檔案依序下載，間隔一下避免瀏覽器擋下
    setTimeout(() => download(new Blob([content], { type: 'text/plain;charset=utf-8' }), `${baseName()}.${lang}.${fmt}`), i * 350);
    n++;
  });
  toast(n ? `下載 ${n} 個字幕檔` : '勾選的語言都沒有字幕內容', !n);
});

// ---------- 輸出影片 ----------
let exportJob = null;

$('#exVideoBtn').addEventListener('click', async () => {
  if (exportJob) return;
  const opt = {
    primary: $('#exVSubs').checked ? $('#exVPrimary').value : '',
    secondary: $('#exVSubs').checked ? $('#exVSecondary').value : '',
    subs: $('#exVSubs').checked,
    cmts: $('#exVCmts').checked,
    editor: false,
    res: parseInt($('#exVRes').value, 10) || 0,
    quality: $('#exVQuality').value,
    volume: parseInt($('#exVVolume').value, 10) / 100,
  };
  const suffix = opt.subs && opt.primary ? '.' + opt.primary + (opt.secondary ? '+' + opt.secondary : '') : '';
  const name = `${baseName()}${suffix}.mp4`;

  // 支援的瀏覽器直接寫入硬碟（大檔案不會吃光記憶體）；需在點擊當下詢問存檔位置
  let fileHandle = null;
  if (window.showSaveFilePicker) {
    try {
      fileHandle = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: 'MP4 影片', accept: { 'video/mp4': ['.mp4'] } }] });
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      fileHandle = null;
    }
  }

  exportJob = { cancelled: false, output: null };
  $('#exVProgress').hidden = false;
  $('#exVideoBtn').disabled = true;
  $('#exCancelBtn').hidden = false;
  const bar = $('#exVProgress progress');
  const status = $('#exVStatus');
  bar.value = 0;
  const started = performance.now();
  try {
    const result = await exportVideo(opt, fileHandle, (p, msg) => {
      bar.value = p;
      const el = (performance.now() - started) / 1000;
      const eta = p > 0.02 ? el / p - el : NaN;
      status.textContent = msg || `處理中 ${(p * 100).toFixed(1)}%` + (Number.isFinite(eta) ? `，大約還要 ${fmtTime(eta, false)}` : '');
    });
    if (result === 'cancelled') {
      status.textContent = '已取消輸出';
    } else {
      bar.value = 1;
      status.textContent = `完成！花費 ${fmtTime((performance.now() - started) / 1000, false)}` + (fileHandle ? `，已儲存為 ${fileHandle.name}` : '，已開始下載');
      if (result instanceof Blob) download(result, name);
      toast('影片輸出完成');
    }
  } catch (err) {
    console.error(err);
    status.textContent = '輸出失敗：' + (err && err.message ? err.message : err);
    toast('輸出失敗：' + (err && err.message ? err.message : err), true);
  } finally {
    exportJob = null;
    $('#exVideoBtn').disabled = false;
    $('#exCancelBtn').hidden = true;
  }
});

$('#exCancelBtn').addEventListener('click', async () => {
  if (!exportJob) return;
  exportJob.cancelled = true;
  $('#exVStatus').textContent = '取消中…';
  try { if (exportJob.output) await exportJob.output.cancel(); } catch { /* ignore */ }
});

async function exportVideo(opt, fileHandle, onProgress) {
  const job = exportJob;
  onProgress(0, '讀取影片…');
  const input = new MB.Input({ source: new MB.BlobSource(S.file), formats: MB.ALL_FORMATS });
  const vTrack = await input.getPrimaryVideoTrack();
  if (!vTrack) throw new Error('找不到影像軌');
  if (!(await vTrack.canDecode())) throw new Error('這個瀏覽器無法解碼此影片的編碼格式');
  const aTrack = await input.getPrimaryAudioTrack();
  const useAudio = aTrack && opt.volume > 0 && (await aTrack.canDecode());

  // 輸出尺寸
  const srcW = vTrack.displayWidth, srcH = vTrack.displayHeight;
  let scale = 1;
  if (opt.res && Math.min(srcW, srcH) > opt.res) scale = opt.res / Math.min(srcW, srcH);
  const W = Math.max(2, Math.round(srcW * scale / 2) * 2);
  const H = Math.max(2, Math.round(srcH * scale / 2) * 2);

  const stats = await vTrack.computePacketStats(120);
  let fps = stats.averagePacketRate || 30;
  if (Math.abs(fps - Math.round(fps)) < 0.02) fps = Math.round(fps);

  const vCodec = await MB.getFirstEncodableVideoCodec(['avc', 'hevc', 'vp9', 'av1'], { width: W, height: H });
  if (!vCodec) throw new Error('這個瀏覽器無法編碼影片（不支援 H.264 / VP9 / AV1）');
  let aCodec = null;
  if (useAudio) {
    aCodec = await MB.getFirstEncodableAudioCodec(['aac', 'opus'], { numberOfChannels: Math.min(2, aTrack.numberOfChannels), sampleRate: aTrack.sampleRate });
  }

  const quality = { high: MB.QUALITY_HIGH, medium: MB.QUALITY_MEDIUM, low: MB.QUALITY_LOW }[opt.quality] || MB.QUALITY_HIGH;
  let target, writable = null;
  if (fileHandle) {
    writable = await fileHandle.createWritable();
    target = new MB.StreamTarget(writable, { chunked: true });
  } else {
    target = new MB.BufferTarget();
  }
  const output = new MB.Output({
    format: new MB.Mp4OutputFormat(fileHandle ? {} : { fastStart: 'in-memory' }),
    target,
  });
  job.output = output;

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { alpha: false });
  const videoSource = new MB.CanvasSource(canvas, { codec: vCodec, bitrate: quality, keyFrameInterval: 2 });
  output.addVideoTrack(videoSource, { frameRate: fps });

  let audioSource = null;
  if (aCodec) {
    audioSource = new MB.AudioSampleSource({ codec: aCodec, bitrate: quality });
    output.addAudioTrack(audioSource);
  }
  await output.start();

  const ranges = keptRanges();
  const cuts = mergedCuts();
  const total = ranges.reduce((a, [s, e]) => a + (e - s), 0) || 1;
  const renderOpt = { primary: opt.primary, secondary: opt.secondary, subs: opt.subs, cmts: opt.cmts, editor: false };

  let vDone = 0, aDone = 0;
  const report = () => onProgress(Math.min(vDone, aCodec ? aDone : vDone) / total);

  const videoTask = async () => {
    const sink = new MB.CanvasSink(vTrack, { width: W, height: H, fit: 'contain', poolSize: 2 });
    let lastOut = -1;
    for (const [rs, re] of ranges) {
      for await (const wc of sink.canvases(rs, re)) {
        if (job.cancelled) return;
        const s = Math.max(wc.timestamp, rs);
        const e = Math.min(wc.timestamp + (wc.duration || 1 / fps), re);
        if (e - s <= 1e-4) continue;
        const outT = mapTime(s, cuts);
        if (outT <= lastOut) continue;
        lastOut = outT;
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, W, H);
        ctx.drawImage(wc.canvas, 0, 0, W, H);
        renderOverlay(ctx, W, H, s, renderOpt);
        await videoSource.add(outT, e - s);
        vDone = mapTime(e, cuts);
        report();
      }
    }
    videoSource.close();
  };

  const audioTask = async () => {
    if (!audioSource) return;
    const sink = new MB.AudioSampleSink(aTrack);
    let cursor = null;
    for (const [rs, re] of ranges) {
      for await (const smp of sink.samples(rs, re)) {
        if (job.cancelled) { smp.close(); return; }
        const sr = smp.sampleRate;
        const f0 = clamp(Math.round((rs - smp.timestamp) * sr), 0, smp.numberOfFrames);
        const f1 = clamp(Math.round((re - smp.timestamp) * sr), 0, smp.numberOfFrames);
        const n = f1 - f0;
        if (n <= 0) { smp.close(); continue; }
        const ch = Math.min(2, smp.numberOfChannels);
        const data = new Float32Array(n * ch);
        for (let c = 0; c < ch; c++) {
          smp.copyTo(data.subarray(c * n, (c + 1) * n), { planeIndex: c, format: 'f32-planar', frameOffset: f0, frameCount: n });
        }
        if (opt.volume !== 1) for (let i = 0; i < data.length; i++) data[i] = clamp(data[i] * opt.volume, -1, 1);
        if (cursor == null) cursor = Math.max(0, mapTime(smp.timestamp + f0 / sr, cuts));
        const out = new MB.AudioSample({ data, format: 'f32-planar', numberOfChannels: ch, sampleRate: sr, timestamp: cursor });
        cursor += n / sr;
        smp.close();
        await audioSource.add(out);
        out.close();
        aDone = cursor;
        report();
      }
    }
    audioSource.close();
  };

  try {
    await Promise.all([videoTask(), audioTask()]);
    if (job.cancelled) {
      try { await output.cancel(); } catch { /* ignore */ }
      return 'cancelled';
    }
    onProgress(1, '寫入檔案…');
    await output.finalize();
  } catch (err) {
    if (job.cancelled) return 'cancelled';
    try { await output.cancel(); } catch { /* ignore */ }
    if (writable) { try { await writable.abort(); } catch { /* ignore */ } }
    throw err;
  }
  if (fileHandle) return 'saved';
  return new Blob([target.buffer], { type: 'video/mp4' });
}

// =====================================================================
// 全部重繪
// =====================================================================
function renderAll() {
  renderLangSelects();
  renderLangTable();
  renderStyleForm();
  renderEditor();
  renderLists();
  renderTimeline();
  updateUndoButtons();
  requestRender();
}

// =====================================================================
// 事件綁定
// =====================================================================
bindEditor($('#subEditor'));
bindEditor($('#cmtEditor'));

$('#openVideoBtn').addEventListener('click', () => $('#videoInput').click());
$('#openProjBtn').addEventListener('click', () => $('#projInput').click());
$('#saveProjBtn').addEventListener('click', saveProject);
$('#videoInput').addEventListener('change', e => { openVideoFile(e.target.files[0]); e.target.value = ''; });
$('#projInput').addEventListener('change', e => { if (e.target.files[0]) openProjectFile(e.target.files[0]); e.target.value = ''; });
$('#subInput').addEventListener('change', e => { if (e.target.files[0]) importSubtitleFile(e.target.files[0]); e.target.value = ''; });
$('#importSubBtn').addEventListener('click', () => { if (!S.file) return toast('請先開啟影片'); $('#subInput').click(); });
$('#undoBtn').addEventListener('click', undo);
$('#redoBtn').addEventListener('click', redo);
$('#exportBtn').addEventListener('click', openExport);
$('#helpBtn').addEventListener('click', () => $('#helpDlg').showModal());
$('#playBtn').addEventListener('click', togglePlay);
$('#prevCueBtn').addEventListener('click', () => gotoCue(-1));
$('#nextCueBtn').addEventListener('click', () => gotoCue(1));
$('#addSubBtn').addEventListener('click', () => addSubtitle());
$('#addSubBtn2').addEventListener('click', () => addSubtitle());
$('#addCmtBtn').addEventListener('click', () => addComment());
$('#addCmtBtn2').addEventListener('click', () => addComment());
$('#markInBtn').addEventListener('click', () => setMark('in'));
$('#markOutBtn').addEventListener('click', () => setMark('out'));
$('#cutBtn').addEventListener('click', cutRange);
$('#keepBtn').addEventListener('click', keepRange);
$('#zoomInBtn').addEventListener('click', () => setZoom(S.zoom * 1.5));
$('#zoomOutBtn').addEventListener('click', () => setZoom(S.zoom / 1.5));
$('#zoomFitBtn').addEventListener('click', zoomFit);
$('#subSearch').addEventListener('input', renderLists);
$('#dispPrimary').addEventListener('change', e => { P.display.primary = e.target.value; commit(); renderAll(); });
$('#dispSecondary').addEventListener('change', e => { P.display.secondary = e.target.value; commit(); renderAll(); });
for (const b of $$('#tabs button')) b.addEventListener('click', () => showTab(b.dataset.tab));

// 點按鈕後移除焦點，避免空白鍵再次觸發按鈕
document.addEventListener('click', e => {
  const b = e.target.closest && e.target.closest('button');
  if (b && !b.closest('dialog')) b.blur();
});

// 拖曳檔案進視窗：影片 → 開啟；.json → 專案；.srt/.vtt → 匯入字幕
let dragDepth = 0;
const hasFiles = e => Array.from(e.dataTransfer?.types || []).includes('Files');
window.addEventListener('dragenter', e => { if (hasFiles(e)) { dragDepth++; document.body.classList.add('dragging'); } });
window.addEventListener('dragleave', e => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
window.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('drop', e => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  for (const f of e.dataTransfer.files) {
    if (/\.json$/i.test(f.name)) openProjectFile(f);
    else if (/\.(srt|vtt)$/i.test(f.name)) importSubtitleFile(f);
    else if (f.type.startsWith('video/') || /\.(mp4|m4v|mov|webm|mkv|ogv)$/i.test(f.name)) openVideoFile(f);
  }
});

// 快捷鍵
document.addEventListener('keydown', e => {
  const typing = e.target.closest && e.target.closest('input, textarea, select, [contenteditable]');
  const mod = e.ctrlKey || e.metaKey;
  if ($('dialog[open]')) return;

  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); saveProject(); return; }
  if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); $('#videoInput').click(); return; }
  if (mod && e.key.toLowerCase() === 'e') { e.preventDefault(); openExport(); return; }
  if (typing) return;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
  if (mod || e.altKey) return;

  const t = video.currentTime;
  switch (e.key) {
    case ' ': e.preventDefault(); togglePlay(); break;
    case 'ArrowLeft': e.preventDefault(); seek(t - (e.shiftKey ? 5 : 1)); break;
    case 'ArrowRight': e.preventDefault(); seek(t + (e.shiftKey ? 5 : 1)); break;
    case ',': video.pause(); seek(t - FRAME); break;
    case '.': video.pause(); seek(t + FRAME); break;
    case 'ArrowUp': e.preventDefault(); gotoCue(-1); break;
    case 'ArrowDown': e.preventDefault(); gotoCue(1); break;
    case 'Home': seek(0); break;
    case 'End': seek(S.duration); break;
    case 'n': case 'N': e.preventDefault(); addSubtitle(); break;
    case 'c': case 'C': e.preventDefault(); addComment(); break;
    case 'i': case 'I': setMark('in'); break;
    case 'o': case 'O': setMark('out'); break;
    case 'x': case 'X': cutRange(); break;
    case '[': setSelectedEdge('start'); break;
    case ']': setSelectedEdge('end'); break;
    case 'Enter': if (S.sel) { e.preventDefault(); focusEditorText(); } break;
    case 'Delete': case 'Backspace': if (S.sel) { e.preventDefault(); deleteSelected(); } break;
    case 'Escape':
      if (S.mark.in != null || S.mark.out != null) { S.mark = { in: null, out: null }; renderMark(); }
      else if (S.sel) { S.sel = null; renderAll(); }
      break;
    case '+': case '=': setZoom(S.zoom * 1.5); break;
    case '-': setZoom(S.zoom / 1.5); break;
    case '?': $('#helpDlg').showModal(); break;
  }
});

window.addEventListener('beforeunload', e => {
  commit();
  autosave();
  if (S.dirty && (P.subtitles.length || P.comments.length)) { e.preventDefault(); e.returnValue = ''; }
});

new ResizeObserver(layoutStage).observe(stage);
new ResizeObserver(() => { renderTimeline(); }).observe(tlScroll);

if (!MB) toast('找不到 lib/mediabunny 檔案：波形與影片輸出功能無法使用', true);
renderAll();
layoutStage();

// 測試用
window.__editor = { get P() { return P; }, S, renderAll, commit, mapTime, mergedCuts, keptRanges, buildSubtitleFile, parseSubtitleFile, wrapText };
})();
