// ===== Minha Board — To-Do em estilo Milanote =====
// Notas/folhas arrastáveis numa board responsiva. Recursos: grid magnético,
// cores, cards concluídos, desenho (caneta/borracha/formas, undo/redo, preview),
// folhas de desenho (cards brancos) e PASTAS na board (estilo Android):
// fechada = quadradinho com prévias; aberta = painel flutuante móvel/redimensionável.

const STORAGE_KEY = 'minha-board:notes:v1';

// ---------- Tema (claro / escuro / seguir o sistema) ----------
const THEME_KEY = 'minha-board:theme';
const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
let themePref = (() => {
  const t = localStorage.getItem(THEME_KEY);
  return (t === 'light' || t === 'dark' || t === 'system') ? t : 'dark';
})();
function resolvedTheme() {
  return themePref === 'system' ? (systemDark.matches ? 'dark' : 'light') : themePref;
}
// aplica o quanto antes para evitar flash do tema errado
document.documentElement.dataset.theme = resolvedTheme();

const canvas = document.getElementById('canvas');
const board = document.getElementById('board');
const noteTpl = document.getElementById('note-template');
const sheetTpl = document.getElementById('sheet-template');
const itemTpl = document.getElementById('item-template');
const folderClosedTpl = document.getElementById('folder-closed-template');
const folderOpenTpl = document.getElementById('folder-open-template');
const emptyState = document.getElementById('empty-state');

// ---------- Estado ----------
/** Notas renderizadas. @type {Map<string,{el,data}>} */
const notes = new Map();
/** Folhas renderizadas. @type {Map<string,{el,data,canvas,ctx}>} */
const sheets = new Map();
/** Pastas renderizadas. @type {Map<string,{el,data,bodyEl}>} */
const folderEntries = new Map();

/** Dados de todas as notas (folderId: null = solta na board). @type {object[]} */
let allNotes = [];
/** Dados de todas as folhas. @type {object[]} */
let allSheets = [];
/** Pastas. @type {{id,name,x,y,z,open,w,h}[]} */
let folders = [];
/** Notas concluídas. @type {object[]} */
let archived = [];
/** Desenho sobre a board (único). @type {object[]} */
let boardDrawing = [];
/** Lixeira: itens excluídos recuperáveis (global, compartilhada entre boards). @type {{kind,data,fromFolderId}[]} */
let trash = [];
/** Folha em foco (alvo do "Limpar"). */
let activeSheet = null;

/** Todas as boards. Cada uma: {id,name,folders,notes,sheets,boardDrawing,view}. @type {object[]} */
let boards = [];
/** Id da board ativa (cujo conteúdo está nas variáveis acima). */
let activeBoardId = null;

// ---------- Grid (imã) ----------
const GRID = 30;
const MIN_W = GRID * 8;  // 240
const MIN_H = GRID * 5;  // 150
const FOLDER_CLOSED = 144; // lado do quadradinho fechado
const snap = (v) => Math.round(v / GRID) * GRID;
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

// Paleta dos cards por tema (o índice salvo na nota é o mesmo nos dois temas)
const COLORS_DARK = [
  { name: 'Grafite', bg: '#2c2f34', bg2: '#303338' },
  { name: 'Ardósia', bg: '#2b3138', bg2: '#2f363e' },
  { name: 'Azul',    bg: '#22303f', bg2: '#27384b' },
  { name: 'Verde',   bg: '#223a30', bg2: '#27463a' },
  { name: 'Teal',    bg: '#1f3a3a', bg2: '#244747' },
  { name: 'Roxo',    bg: '#2f2a40', bg2: '#382f4d' },
  { name: 'Vinho',   bg: '#3a2730', bg2: '#472d39' },
  { name: 'Âmbar',   bg: '#3a3322', bg2: '#473f29' },
];
const COLORS_LIGHT = [
  { name: 'Grafite', bg: '#e3e5ea', bg2: '#edeff3' },
  { name: 'Ardósia', bg: '#dee4eb', bg2: '#e8eef5' },
  { name: 'Azul',    bg: '#d2e3f5', bg2: '#deebfa' },
  { name: 'Verde',   bg: '#d2eddc', bg2: '#def5e6' },
  { name: 'Teal',    bg: '#cfeaea', bg2: '#daf2f2' },
  { name: 'Roxo',    bg: '#e3dcf4', bg2: '#ebe5f9' },
  { name: 'Vinho',   bg: '#f3d8e0', bg2: '#f9e2e9' },
  { name: 'Âmbar',   bg: '#f1e7c8', bg2: '#f8f0d8' },
];
function palette() { return resolvedTheme() === 'light' ? COLORS_LIGHT : COLORS_DARK; }
const DRAW_COLORS = ['#0f1115', '#ef5350', '#f86244', '#60a5fa', '#f472b6', '#fbbf24', '#a78bfa', '#f3f4f6'];

const BULLET_MARK = '•';
let saveTimer = null;
let zCounter = 1;

// ---------- Cores: utilidades ----------
function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const v = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(v, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
function darken(hex, pct) {
  const { r, g, b } = hexToRgb(hex);
  const f = (1 - pct / 100);
  const c = (x) => Math.max(0, Math.min(255, Math.round(x * f)));
  return `rgb(${c(r)}, ${c(g)}, ${c(b)})`;
}
function isLight(hex) {
  const { r, g, b } = hexToRgb(hex);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.62;
}
function resolveColors(note) {
  if (note.customColor) {
    return { bg: darken(note.customColor, 14), bg2: note.customColor, light: isLight(note.customColor) };
  }
  const idx = (note.color != null) ? note.color : (note.tone != null ? note.tone : 0);
  const pal = palette();
  const c = pal[idx] || pal[0];
  return { bg: c.bg, bg2: c.bg2, light: isLight(c.bg2) };
}

// ---------- Persistência ----------
const isDesktop = typeof window !== 'undefined' && !!window.boardAPI;
function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(save, 250); }

function syncFromDom(entry) {
  const items = [...entry.el.querySelectorAll('.item')].map((it) => ({
    marker: it.dataset.marker === 'bullet' ? 'bullet' : 'check',
    text: it.querySelector('.item-content').textContent,
    done: it.dataset.marker !== 'bullet' && it.dataset.done === 'true',
  }));
  entry.data.items = items;
  const titleEl = entry.el.querySelector('.note-title');
  entry.data.title = titleEl ? titleEl.textContent : '';
}
function syncAll() { notes.forEach((entry) => syncFromDom(entry)); }

function buildPayload() {
  syncActiveBoard(); // grava o estado atual (variáveis) de volta na board ativa (faz syncAll)
  return {
    version: 6,
    boards,
    activeBoardId,
    archived,
    trash,
  };
}
function save() {
  const payload = buildPayload();
  if (isDesktop) window.boardAPI.save(payload);
  else localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
}
async function load() {
  if (isDesktop) {
    try { return (await window.boardAPI.load()) || null; } catch { return null; }
  }
  try { const raw = localStorage.getItem(STORAGE_KEY); return raw ? JSON.parse(raw) : null; } catch { return null; }
}

// ---------- Utilidades ----------
function uid(prefix = 'n') {
  return prefix + '_' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
}
function nextZ() { return ++zCounter; }
function boardSize() { return { w: board.clientWidth, h: board.clientHeight }; }

// Dimensões do container de um item (board ou corpo de uma pasta aberta)
function containerDims(folderId) {
  if (folderId) {
    const fe = folderEntries.get(folderId);
    if (fe && fe.bodyEl) return { w: fe.bodyEl.clientWidth, h: fe.bodyEl.clientHeight };
  }
  return boardSize();
}
function clampBox(o) {
  if (o.folderId) {
    // dentro de pasta: pode ficar além da área visível (a pasta ganha scroll);
    // só não pode "vazar" pela esquerda/cima
    o.w = Math.max(MIN_W, o.w);
    o.h = Math.max(MIN_H, o.h);
    o.x = Math.max(0, o.x);
    o.y = Math.max(0, o.y);
    return;
  }
  // solto na board: mundo "infinito" (1º quadrante). Sem teto — o zoom/pan
  // e o "ver board completo" cuidam de alcançar o que estiver longe.
  o.w = Math.max(MIN_W, o.w);
  o.h = Math.max(MIN_H, o.h);
  o.x = Math.max(0, o.x);
  o.y = Math.max(0, o.y);
}

// ---------- Zoom / Pan (board estilo Milanote) ----------
// O #canvas é transformado por translate(panX,panY) scale(zoom) com origem 0,0.
// Coordenadas dos itens são em "mundo" (px de layout); a tela é o mundo projetado.
let zoom = 1, panX = 0, panY = 0;
const MIN_ZOOM = 0.2, MAX_ZOOM = 2.5;
let viewSaveTimer = null;

function clientToWorld(clientX, clientY) {
  const r = board.getBoundingClientRect();
  return { x: (clientX - r.left - panX) / zoom, y: (clientY - r.top - panY) / zoom };
}
function viewportCenterWorld() {
  return clientToWorld(board.getBoundingClientRect().left + board.clientWidth / 2,
                       board.getBoundingClientRect().top + board.clientHeight / 2);
}
function applyView() {
  canvas.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
  // o grid pontilhado acompanha o pan/zoom
  const g = GRID * zoom;
  board.style.backgroundSize = `${g}px ${g}px`;
  board.style.backgroundPosition = `${panX}px ${panY}px`;
  updateZoomHud();
}
function setView(z, px, py, persist = true) {
  zoom = clamp(z, MIN_ZOOM, MAX_ZOOM);
  panX = px; panY = py;
  applyView();
  if (persist) { clearTimeout(viewSaveTimer); viewSaveTimer = setTimeout(save, 400); }
}
function zoomAt(newZoom, clientX, clientY) {
  newZoom = clamp(newZoom, MIN_ZOOM, MAX_ZOOM);
  const w = clientToWorld(clientX, clientY);
  const r = board.getBoundingClientRect();
  zoom = newZoom;
  panX = (clientX - r.left) - w.x * zoom;
  panY = (clientY - r.top) - w.y * zoom;
  applyView();
  clearTimeout(viewSaveTimer); viewSaveTimer = setTimeout(save, 400);
}
function zoomByStep(factor) {
  const r = board.getBoundingClientRect();
  zoomAt(zoom * factor, r.left + board.clientWidth / 2, r.top + board.clientHeight / 2);
}
function resetView() { setView(1, 0, 0); }
// "Ver board completo": enquadra todos os itens soltos da board na tela.
function fitToContent() {
  const items = itemsIn(null);
  if (!items.length) { resetView(); return; }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  items.forEach((it) => {
    const r = itemRect(it);
    minX = Math.min(minX, r.x); minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w); maxY = Math.max(maxY, r.y + r.h);
  });
  const pad = 60;
  const bw = board.clientWidth, bh = board.clientHeight;
  const cw = (maxX - minX) + pad * 2, ch = (maxY - minY) + pad * 2;
  const z = clamp(Math.min(bw / cw, bh / ch), MIN_ZOOM, MAX_ZOOM);
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  setView(z, bw / 2 - cx * z, bh / 2 - cy * z);
}

function topLevelCount() {
  return allNotes.filter((n) => !n.folderId).length
    + allSheets.filter((s) => !s.folderId).length
    + folders.length;
}
function updateEmptyState() {
  emptyState.classList.toggle('hidden', topLevelCount() > 0 || drawMode);
}

function focusEnd(el) {
  el.focus();
  const r = document.createRange(); r.selectNodeContents(el); r.collapse(false);
  const s = getSelection(); s.removeAllRanges(); s.addRange(r);
}
function focusStart(el) {
  el.focus();
  const r = document.createRange(); r.selectNodeContents(el); r.collapse(true);
  const s = getSelection(); s.removeAllRanges(); s.addRange(r);
}
function caretAtStart() {
  const s = getSelection();
  return s && s.isCollapsed && s.anchorOffset === 0;
}

function migrateText(text) {
  return String(text).split(/\r?\n/).map((line) => {
    const m = line.match(/^[-•*]\s*/);
    return m ? { marker: 'bullet', text: line.slice(m[0].length) } : { marker: 'check', text: line };
  });
}
function itemMarkerOf(d) {
  if (d.marker === 'bullet' || d.marker === 'check') return d.marker;
  if (d.type === 'empresa') return 'bullet';
  return 'check';
}

// ---------- Itens (linhas) ----------
function setItemMarker(itemEl, marker) {
  itemEl.dataset.marker = marker;
  const markerEl = itemEl.querySelector('.item-marker');
  const content = itemEl.querySelector('.item-content');
  content.dataset.placeholder = marker === 'bullet' ? 'Empresa / título' : 'tarefa…';
  markerEl.textContent = '';
  if (marker === 'bullet') {
    markerEl.textContent = BULLET_MARK;
    delete itemEl.dataset.done;
  } else {
    const box = document.createElement('span');
    box.className = 'check-box';
    markerEl.appendChild(box);
    if (!itemEl.dataset.done) itemEl.dataset.done = 'false';
  }
}
function buildItemEl(entry, itemData) {
  const itemEl = itemTpl.content.firstElementChild.cloneNode(true);
  const content = itemEl.querySelector('.item-content');
  const marker = itemEl.querySelector('.item-marker');
  setItemMarker(itemEl, itemMarkerOf(itemData));
  if (itemEl.dataset.marker === 'check' && itemData.done) itemEl.dataset.done = 'true';
  content.textContent = itemData.text || '';

  marker.addEventListener('click', (e) => {
    e.stopPropagation();
    if (itemEl.dataset.marker === 'bullet') setItemMarker(itemEl, 'check');
    else if (itemEl.dataset.done !== 'true') itemEl.dataset.done = 'true';
    else setItemMarker(itemEl, 'bullet');
    updateNoteChecked(entry); save();
  });
  content.addEventListener('input', () => {
    if (itemEl.dataset.marker === 'check') {
      const t = content.textContent;
      const m = t.match(/^[-•*]\s+/) || t.match(/^[-•*]$/);
      if (m) {
        setItemMarker(itemEl, 'bullet');
        content.textContent = t.slice(m[0].length);
        focusStart(content); updateNoteChecked(entry);
      }
    }
    scheduleSave();
  });
  content.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const novo = buildItemEl(entry, { marker: 'check', text: '' });
      itemEl.after(novo);
      focusStart(novo.querySelector('.item-content'));
      updateNoteChecked(entry); save();
      return;
    }
    if (e.key === 'Backspace' && caretAtStart() && content.textContent === '') {
      const prev = itemEl.previousElementSibling;
      const container = itemEl.parentElement;
      if (prev) {
        e.preventDefault(); itemEl.remove();
        focusEnd(prev.querySelector('.item-content'));
        updateNoteChecked(entry); save();
      } else if (container.children.length > 1) {
        const next = itemEl.nextElementSibling;
        e.preventDefault(); itemEl.remove();
        if (next) focusStart(next.querySelector('.item-content'));
        updateNoteChecked(entry); save();
      } else if (itemEl.dataset.marker === 'bullet') {
        e.preventDefault(); setItemMarker(itemEl, 'check'); save();
      }
    }
  });
  content.addEventListener('paste', (e) => {
    const text = (e.clipboardData || window.clipboardData).getData('text');
    if (!text || !/\r?\n/.test(text)) return;
    e.preventDefault();
    const lines = text.split(/\r?\n/);
    let anchor = itemEl;
    lines.forEach((line, i) => {
      const m = line.match(/^[-•*]\s*/);
      const marker = m ? 'bullet' : 'check';
      const txt = m ? line.slice(m[0].length) : line;
      if (i === 0 && content.textContent === '') { setItemMarker(itemEl, marker); content.textContent = txt; }
      else { const ne = buildItemEl(entry, { marker, text: txt }); anchor.after(ne); anchor = ne; }
    });
    focusEnd(anchor.querySelector('.item-content'));
    updateNoteChecked(entry); save();
  });
  makeItemReorderable(itemEl, entry);
  return itemEl;
}

// Reordenar linhas dentro de uma nota arrastando pela alça (⠿).
function makeItemReorderable(itemEl, entry) {
  const handle = itemEl.querySelector('.item-drag');
  if (!handle) return;
  handle.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation(); // não inicia o arraste da nota nem seleciona texto
    const container = itemEl.parentElement; // .note-items
    let moved = false;
    itemEl.classList.add('item-dragging');
    document.body.classList.add('reordering');
    const onMove = (ev) => {
      moved = true;
      const siblings = [...container.querySelectorAll('.item')].filter((s) => s !== itemEl);
      let target = null;
      for (const s of siblings) {
        const r = s.getBoundingClientRect();
        if (ev.clientY < r.top + r.height / 2) { target = s; break; }
      }
      if (target) container.insertBefore(itemEl, target);
      else container.appendChild(itemEl);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('mouseup', onUp, true);
      itemEl.classList.remove('item-dragging');
      document.body.classList.remove('reordering');
      if (moved) { updateNoteChecked(entry); save(); }
    };
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mouseup', onUp, true);
  });
}

// ---------- Notas ----------
function normalizeNote(data) {
  data.id = data.id || uid();
  data.color = (data.color != null) ? data.color
    : (data.tone != null ? data.tone : Math.floor(Math.random() * palette().length));
  data.customColor = data.customColor || null;
  data.x = snap(data.x ?? 60);
  data.y = snap(data.y ?? 60);
  data.w = snap(data.w ?? 300);
  data.h = snap(data.h ?? 240);
  data.title = data.title ?? '';
  data.z = data.z ?? nextZ();
  if (data.folderId === undefined) data.folderId = null;
  if (!Array.isArray(data.items)) {
    data.items = (typeof data.text === 'string' && data.text.trim())
      ? migrateText(data.text) : [{ marker: 'check', text: '' }];
  }
  clampBox(data);
  return data;
}
function createNote(data, container) {
  const note = normalizeNote(data);
  const el = noteTpl.content.firstElementChild.cloneNode(true);
  el.dataset.id = note.id;
  applyToneAndPos(el, note);
  const entry = { el, data: note };

  const titleEl = el.querySelector('.note-title');
  titleEl.textContent = note.title || '';
  titleEl.addEventListener('input', scheduleSave);
  titleEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const first = el.querySelector('.note-items .item-content');
      if (first) focusStart(first);
    }
  });

  const cont = el.querySelector('.note-items');
  note.items.forEach((it) => cont.appendChild(buildItemEl(entry, it)));

  wireNote(el, entry);
  updateNoteChecked(entry);
  (container || canvas).appendChild(el);
  notes.set(note.id, entry);
  return entry;
}
function updateNoteChecked(entry) {
  const checks = [...entry.el.querySelectorAll('.item[data-marker="check"]')];
  const allDone = checks.length > 0 && checks.every((it) => it.dataset.done === 'true');
  entry.el.classList.toggle('all-checked', allDone);
}
function toggleAllChecks(entry) {
  const checks = [...entry.el.querySelectorAll('.item[data-marker="check"]')];
  if (!checks.length) return;
  const anyUndone = checks.some((it) => it.dataset.done !== 'true');
  checks.forEach((it) => { it.dataset.done = anyUndone ? 'true' : 'false'; });
  updateNoteChecked(entry); save();
}
function applyToneAndPos(el, note) {
  const { bg, bg2, light } = resolveColors(note);
  el.style.left = note.x + 'px';
  el.style.top = note.y + 'px';
  el.style.width = note.w + 'px';
  el.style.height = note.h + 'px';
  el.style.zIndex = note.z;
  el.style.background = `linear-gradient(160deg, ${bg2}, ${bg})`;
  el.classList.toggle('light-note', !!light);
  const dot = el.querySelector('.color-dot');
  if (dot) dot.style.background = bg2;
}
function applyPos(el, o) {
  el.style.left = o.x + 'px';
  el.style.top = o.y + 'px';
  el.style.width = o.w + 'px';
  el.style.height = o.h + 'px';
  el.style.zIndex = o.z;
}
function bringToFront(o, el) { o.z = nextZ(); el.style.zIndex = o.z; }

function wireNote(el, entry) {
  const note = entry.data;
  el.querySelector('.note-check').addEventListener('click', (e) => { e.stopPropagation(); toggleAllChecks(entry); });
  el.querySelector('.note-color').addEventListener('click', (e) => { e.stopPropagation(); openColorPop(entry, e.currentTarget); });
  el.querySelector('.note-archive').addEventListener('click', (e) => { e.stopPropagation(); archiveNote(entry); });
  el.querySelector('.note-del').addEventListener('click', (e) => {
    e.stopPropagation();
    trashItem('note', entry);
  });
  el.addEventListener('mousedown', () => bringToFront(note, el));
  makeItemDraggable(el, entry, '.note-head, .note-lines',
    '.note-resize, .note-check, .note-color, .note-archive, .note-del, .item-drag, .item-marker, .item-content, .note-title',
    (fromBody) => { if (fromBody) addOrFocusTask(entry); });
  makeBoxResizable(el.querySelector('.note-resize'), el, note);
}
function addOrFocusTask(entry) {
  const container = entry.el.querySelector('.note-items');
  const last = container.lastElementChild;
  if (last && last.querySelector('.item-content').textContent === '') {
    focusEnd(last.querySelector('.item-content'));
  } else {
    const ne = buildItemEl(entry, { marker: 'check', text: '' });
    container.appendChild(ne);
    focusStart(ne.querySelector('.item-content')); save();
  }
}

// ---------- Redimensionamento genérico ----------
function makeBoxResizable(handle, el, o, onResize) {
  handle.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    bringToFront(o, el);
    const startX = e.clientX, startY = e.clientY;
    const origW = o.w, origH = o.h;
    const onMove = (ev) => {
      // o cursor anda em px de tela; converte o deslocamento para o mundo (÷ zoom).
      // mundo livre / pasta com scroll: cresce sem teto.
      o.w = clamp(snap(origW + (ev.clientX - startX) / zoom), MIN_W, Infinity);
      o.h = clamp(snap(origH + (ev.clientY - startY) / zoom), MIN_H, Infinity);
      el.style.width = o.w + 'px';
      el.style.height = o.h + 'px';
      pushItems(o); // empurra vizinhos em vez de cobrir
      if (onResize) onResize();
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('mouseup', onUp, true);
      pushItems(o);
      if (onResize) onResize();
      scheduleSave();
    };
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mouseup', onUp, true);
  });
}

// ---------- Anti-sobreposição: itens empurram os vizinhos ----------
// Quando um item cresce ou é solto sobre outro, os vizinhos são "empurrados"
// para fora (em cascata), em vez de ficarem cobertos.
function itemsIn(folderId) {
  const fid = folderId || null;
  const list = [];
  notes.forEach((e) => { if ((e.data.folderId || null) === fid) list.push({ o: e.data, el: e.el, kind: 'note', entry: e }); });
  sheets.forEach((e) => { if ((e.data.folderId || null) === fid) list.push({ o: e.data, el: e.el, kind: 'sheet', entry: e }); });
  if (!fid) folderEntries.forEach((fe) => list.push({ o: fe.data, el: fe.el, kind: 'folder', entry: fe }));
  return list;
}
function itemRect(it) {
  const o = it.o;
  if (it.kind === 'folder' && !o.open) return { x: o.x, y: o.y, w: FOLDER_CLOSED, h: FOLDER_CLOSED };
  return { x: o.x, y: o.y, w: o.w, h: o.h };
}
function applyItemPos(it) {
  if (it.kind === 'note') applyToneAndPos(it.el, it.o);
  else if (it.kind === 'sheet') applyPos(it.el, it.o);
  else applyFolderPos(it.entry);
}
function rectsOverlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}
function pushItems(srcO) {
  const folderId = srcO.folderId || null;
  // board (mundo livre) e pasta (scroll): empurrar p/ direita/baixo nunca "estoura"
  const bw = Infinity, bh = Infinity;
  const others = itemsIn(folderId).filter((it) => it.o !== srcO);
  if (!others.length) return;
  const snapUp = (v) => Math.ceil(v / GRID) * GRID;
  const snapDn = (v) => Math.floor(v / GRID) * GRID;
  const isClosedFolder = folders.includes(srcO) && !srcO.open;
  const srcRect = isClosedFolder
    ? { x: srcO.x, y: srcO.y, w: FOLDER_CLOSED, h: FOLDER_CLOSED }
    : { x: srcO.x, y: srcO.y, w: srcO.w, h: srcO.h };
  const blocked = [srcRect]; // áreas que não podem ser invadidas pelos empurrados
  let guard = 0;

  const process = (r, owner) => {
    if (guard++ > 150) return;
    for (const it of others) {
      if (it.o === owner) continue; // não se empurra a si mesmo
      const ir = itemRect(it);
      if (!rectsOverlap(r, ir)) continue;
      // candidatos de nova posição: sair pela direita, baixo, esquerda ou cima
      const cands = [
        { x: snapUp(r.x + r.w), y: ir.y },
        { x: ir.x, y: snapUp(r.y + r.h) },
        { x: snapDn(r.x - ir.w), y: ir.y },
        { x: ir.x, y: snapDn(r.y - ir.h) },
      ]
        .filter((c) => c.x >= 0 && c.y >= 0 && c.x + ir.w <= bw && c.y + ir.h <= bh)
        .filter((c) => !blocked.some((b) => rectsOverlap(b, { x: c.x, y: c.y, w: ir.w, h: ir.h })))
        .sort((p, q) => (Math.abs(p.x - ir.x) + Math.abs(p.y - ir.y)) - (Math.abs(q.x - ir.x) + Math.abs(q.y - ir.y)));
      const best = cands[0];
      if (!best) continue; // sem espaço livre: deixa onde está
      it.o.x = best.x; it.o.y = best.y;
      applyItemPos(it);
      const nr = { x: best.x, y: best.y, w: ir.w, h: ir.h };
      blocked.push(nr);
      process(nr, it.o); // o empurrado pode empurrar outros (cascata)
    }
  };
  process(srcRect, srcO);
}

// ---------- Arraste de itens com "lift" (entra/sai de pastas) ----------
function containerAt(x, y) {
  const el = document.elementFromPoint(x, y);
  if (!el) return { type: 'board' };
  const open = el.closest('.folder.open');
  if (open) return { type: 'folder', id: open.dataset.id };
  const closed = el.closest('.folder.closed');
  if (closed) return { type: 'folder', id: closed.dataset.id };
  return { type: 'board' };
}

function makeItemDraggable(el, entry, dragFromSel, ignoreSel, onClick) {
  const o = entry.data;
  const THRESHOLD = 4;
  el.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const t = e.target;
    if (ignoreSel && t.closest(ignoreSel)) return;
    if (dragFromSel && !t.closest(dragFromSel)) return;

    // clique na barra de rolagem da nota não inicia arraste
    const sc = t.closest('.note-lines');
    if (sc && sc.scrollHeight > sc.clientHeight &&
        e.clientX - sc.getBoundingClientRect().left >= sc.clientWidth) return;

    const fromBody = !!t.closest('.note-lines');
    const startX = e.clientX, startY = e.clientY;
    let dragging = false, lifted = false, grabDX = 0, grabDY = 0, hover = null, hoverTab = null;

    e.preventDefault();
    bringToFront(o, el);

    const lift = () => {
      const r = el.getBoundingClientRect();
      grabDX = startX - r.left; grabDY = startY - r.top;
      el.classList.add('lifting');
      el.style.position = 'fixed';
      el.style.margin = '0';
      el.style.left = r.left + 'px';
      el.style.top = r.top + 'px';
      el.style.width = r.width + 'px';
      el.style.height = r.height + 'px';
      el.style.zIndex = '999999'; // acima da barra de ferramentas e painéis
      document.body.appendChild(el);
      lifted = true;
    };
    const onMove = (ev) => {
      const dx = ev.clientX - startX, dy = ev.clientY - startY;
      if (!dragging && Math.hypot(dx, dy) > THRESHOLD) { dragging = true; lift(); }
      if (lifted) {
        el.style.left = (ev.clientX - grabDX) + 'px';
        el.style.top = (ev.clientY - grabDY) + 'px';
        // soltar sobre a aba de outra board = transferir o item
        const destTabId = tabAt(ev.clientX, ev.clientY);
        const tabEl = (destTabId && destTabId !== activeBoardId)
          ? document.querySelector(`.board-tab[data-id="${destTabId}"]`) : null;
        if (tabEl !== hoverTab) {
          if (hoverTab) hoverTab.classList.remove('drop-target');
          hoverTab = tabEl;
          if (hoverTab) hoverTab.classList.add('drop-target');
        }
        if (tabEl) { // sobre uma aba: não destaca pasta
          if (hover) { hover.classList.remove('drop-target'); hover = null; }
        } else {
          const c = containerAt(ev.clientX, ev.clientY);
          const fid = c.type === 'folder' ? c.id : null;
          const fEl = fid ? folderEntries.get(fid)?.el : null;
          if ((fEl || null) !== hover) {
            if (hover) hover.classList.remove('drop-target');
            hover = fEl || null;
            if (hover) hover.classList.add('drop-target');
          }
        }
      }
    };
    const onUp = (ev) => {
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('mouseup', onUp, true);
      if (hover) hover.classList.remove('drop-target');
      if (hoverTab) hoverTab.classList.remove('drop-target');
      if (lifted) {
        const destTabId = tabAt(ev.clientX, ev.clientY);
        if (destTabId && destTabId !== activeBoardId) {
          moveItemToBoard(entry.canvas ? 'sheet' : 'note', entry.data, destTabId);
        } else {
          dropItem(entry, ev.clientX, ev.clientY);
        }
      } else if (onClick) {
        onClick(fromBody);
      }
    };
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mouseup', onUp, true);
  });
}

function dropItem(entry, clientX, clientY) {
  const c = containerAt(clientX, clientY);
  const oldFolderId = entry.data.folderId ?? null;
  let folderId = null, containerEl = canvas, intoClosed = false;
  if (c.type === 'folder') {
    const fe = folderEntries.get(c.id);
    folderId = c.id;
    if (fe && fe.data.open && fe.bodyEl) containerEl = fe.bodyEl;
    else { containerEl = null; intoClosed = true; } // pasta fechada
  }
  entry.data.folderId = folderId;
  if (containerEl) {
    const r = containerEl.getBoundingClientRect();
    // o rect já reflete o zoom (o container está sob o transform); divide por zoom.
    // o scroll da pasta é em px de layout (não escalado).
    const sx = containerEl.scrollLeft || 0, sy = containerEl.scrollTop || 0;
    const nx = (clientX - r.left) / zoom + sx - entry.data.w / 2;
    const ny = (clientY - r.top) / zoom + sy - 14;
    // board e pasta agora têm mundo livre / scroll: sem teto
    entry.data.x = snap(Math.max(0, nx));
    entry.data.y = snap(Math.max(0, ny));
  } else {
    entry.data.x = 24; entry.data.y = 24;
  }
  entry.data.z = nextZ();

  const sameContainer = (folderId === oldFolderId) && !intoClosed;
  if (sameContainer) {
    // mesmo container: só reposiciona (sem re-render, mantém o desenho da folha)
    placeBack(entry, containerEl);
    pushItems(entry.data);
    save();
  } else {
    // trocou de container: re-renderiza tudo
    entry.el.remove();
    if (activeSheet && activeSheet.el === entry.el) activeSheet = null;
    renderAll();
    pushItems(entry.data);
    save();
    if (folderId) {
      const di = folderEntries.get(folderId);
      if (di) { di.el.classList.add('flash'); setTimeout(() => di.el.classList.remove('flash'), 450); }
    }
  }
}

// Recoloca um item "levantado" de volta no seu container (sem re-render)
function placeBack(entry, containerEl) {
  const el = entry.el;
  el.classList.remove('lifting');
  el.style.position = '';
  el.style.margin = '';
  (containerEl || canvas).appendChild(el);
  if (entry.canvas) applyPos(el, entry.data); // folha
  else applyToneAndPos(el, entry.data);       // nota
}

// ---------- Desenho: helpers de canvas ----------
const dpr = Math.max(1, window.devicePixelRatio || 1);
let tool = 'pen';
let penColor = '#0f1115';
let penSize = 3;

function applyStyleTo(ctx, st) {
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  ctx.lineWidth = st.size;
  if (st.mode === 'eraser') { ctx.globalCompositeOperation = 'destination-out'; ctx.strokeStyle = 'rgba(0,0,0,1)'; }
  else { ctx.globalCompositeOperation = 'source-over'; ctx.strokeStyle = st.color; }
}
function redrawCanvas(ctx, cw, ch, list) {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cw, ch);
  (list || []).forEach((st) => {
    if (st.mode === 'shape') { drawShape(ctx, cw, ch, st); return; }
    if (!st.points || !st.points.length) return;
    applyStyleTo(ctx, st);
    ctx.beginPath();
    st.points.forEach((p, i) => { const x = p.x * cw, y = p.y * ch; if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
    if (st.points.length === 1) { const x = st.points[0].x * cw, y = st.points[0].y * ch; ctx.lineTo(x + 0.01, y + 0.01); }
    ctx.stroke();
  });
  ctx.globalCompositeOperation = 'source-over';
}
const SHAPE_TOOLS = ['rect', 'ellipse', 'line', 'triangle'];
function isShapeTool(t) { return SHAPE_TOOLS.includes(t); }
function drawShape(ctx, cw, ch, st) {
  ctx.globalCompositeOperation = 'source-over';
  ctx.strokeStyle = st.color; ctx.lineWidth = st.size; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  const x0 = st.x0 * cw, y0 = st.y0 * ch, x1 = st.x1 * cw, y1 = st.y1 * ch;
  const x = Math.min(x0, x1), y = Math.min(y0, y1), w = Math.abs(x1 - x0), h = Math.abs(y1 - y0);
  ctx.beginPath();
  if (st.shape === 'rect') ctx.rect(x, y, w, h);
  else if (st.shape === 'ellipse') ctx.ellipse(x + w / 2, y + h / 2, Math.max(0.1, w / 2), Math.max(0.1, h / 2), 0, 0, Math.PI * 2);
  else if (st.shape === 'line') { ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); }
  else if (st.shape === 'triangle') { ctx.moveTo(x + w / 2, y); ctx.lineTo(x, y + h); ctx.lineTo(x + w, y + h); ctx.closePath(); }
  ctx.stroke();
}
function segTo(ctx, cw, ch, st, p0, p1) {
  applyStyleTo(ctx, st);
  ctx.beginPath(); ctx.moveTo(p0.x * cw, p0.y * ch); ctx.lineTo(p1.x * cw, p1.y * ch); ctx.stroke();
  ctx.globalCompositeOperation = 'source-over';
}
function dotAt(ctx, cw, ch, st, p) {
  applyStyleTo(ctx, st);
  ctx.beginPath(); ctx.arc(p.x * cw, p.y * ch, Math.max(0.5, st.size / 2), 0, Math.PI * 2);
  ctx.fillStyle = st.mode === 'eraser' ? 'rgba(0,0,0,1)' : st.color;
  ctx.fill(); ctx.globalCompositeOperation = 'source-over';
}
function pointIn(el, e) {
  const r = el.getBoundingClientRect();
  return { x: clamp((e.clientX - r.left) / r.width, 0, 1), y: clamp((e.clientY - r.top) / r.height, 0, 1) };
}

// ----- Histórico (desfazer/refazer) -----
const undoStack = [];
const redoStack = [];
function pushHistory(strokes, stroke, redraw) {
  undoStack.push({ strokes, stroke, redraw });
  if (undoStack.length > 300) undoStack.shift();
  redoStack.length = 0;
}
function purgeHistory(strokes) {
  for (let i = undoStack.length - 1; i >= 0; i--) if (undoStack[i].strokes === strokes) undoStack.splice(i, 1);
  for (let i = redoStack.length - 1; i >= 0; i--) if (redoStack[i].strokes === strokes) redoStack.splice(i, 1);
}
function undoDraw() {
  const a = undoStack.pop(); if (!a) return;
  const i = a.strokes.indexOf(a.stroke); if (i >= 0) a.strokes.splice(i, 1);
  redoStack.push(a); a.redraw(); scheduleSave();
}
function redoDraw() {
  const a = redoStack.pop(); if (!a) return;
  a.strokes.push(a.stroke); undoStack.push(a); a.redraw(); scheduleSave();
}

function attachDrawing(canvasEl, { canDraw, getStrokes, getCtx, getSize, redraw, onStart }) {
  let dr = false, cur = null;
  canvasEl.addEventListener('pointerdown', (e) => {
    if (!canDraw()) return;
    e.preventDefault(); e.stopPropagation();
    if (onStart) onStart();
    try { canvasEl.setPointerCapture(e.pointerId); } catch {}
    dr = true;
    const p = pointIn(canvasEl, e);
    const { cw, ch } = getSize(); const ctx = getCtx();
    if (isShapeTool(tool)) {
      cur = { mode: 'shape', shape: tool, color: penColor, size: penSize, x0: p.x, y0: p.y, x1: p.x, y1: p.y };
    } else {
      cur = { mode: tool, color: penColor, size: penSize, points: [p] };
      getStrokes().push(cur);
      dotAt(ctx, cw, ch, cur, p);
    }
  });
  canvasEl.addEventListener('pointermove', (e) => {
    if (!dr || !cur) return;
    const p = pointIn(canvasEl, e);
    const { cw, ch } = getSize(); const ctx = getCtx();
    if (cur.mode === 'shape') {
      cur.x1 = p.x; cur.y1 = p.y;
      if (e.shiftKey) {
        const dx = cur.x1 - cur.x0, dy = cur.y1 - cur.y0;
        const m = Math.max(Math.abs(dx), Math.abs(dy));
        cur.x1 = cur.x0 + (dx < 0 ? -m : m);
        cur.y1 = cur.y0 + (dy < 0 ? -m : m);
      }
      redraw(); drawShape(ctx, cw, ch, cur);
    } else {
      const prev = cur.points[cur.points.length - 1]; cur.points.push(p);
      segTo(ctx, cw, ch, cur, prev, p);
    }
  });
  const end = () => {
    if (!dr) return; dr = false;
    if (cur) {
      if (cur.mode === 'shape') {
        if (Math.abs(cur.x1 - cur.x0) > 0.003 || Math.abs(cur.y1 - cur.y0) > 0.003) {
          getStrokes().push(cur); redraw(); pushHistory(getStrokes(), cur, redraw);
        } else { redraw(); }
      } else {
        pushHistory(getStrokes(), cur, redraw);
      }
    }
    cur = null; scheduleSave();
  };
  canvasEl.addEventListener('pointerup', end);
  canvasEl.addEventListener('pointercancel', end);
}

// ---------- Desenho sobre a board ----------
const drawLayer = document.getElementById('draw-layer');
const dctx = drawLayer.getContext('2d');
const drawToolbar = document.getElementById('draw-toolbar');
let drawMode = false;

function sizeDrawLayer() {
  const w = drawLayer.clientWidth, h = drawLayer.clientHeight;
  drawLayer.width = Math.max(1, Math.round(w * dpr));
  drawLayer.height = Math.max(1, Math.round(h * dpr));
  redrawCanvas(dctx, w, h, boardDrawing);
}
function redrawBoard() { redrawCanvas(dctx, drawLayer.clientWidth, drawLayer.clientHeight, boardDrawing); }
attachDrawing(drawLayer, {
  canDraw: () => drawMode,
  getStrokes: () => boardDrawing,
  getCtx: () => dctx,
  getSize: () => ({ cw: drawLayer.clientWidth, ch: drawLayer.clientHeight }),
  redraw: redrawBoard,
});
function setDrawMode(on) {
  drawMode = on;
  document.body.classList.toggle('draw-mode', on);
  const btn = document.getElementById('btn-draw');
  if (btn) btn.classList.toggle('btn-primary', on);
  // O desenho sobre a board acontece em 100%/origem (a camada cobre a tela);
  // ao ativar, volta a vista para 100% para o traço cair onde o cursor está.
  if (on) { resetView(); hideColorPop(); sizeDrawLayer(); }
  updateDrawToolbar(); updateEmptyState();
}

// ---------- Folhas de desenho (cards brancos) ----------
function normalizeSheet(data) {
  data.id = data.id || uid('s');
  data.x = snap(data.x ?? 90);
  data.y = snap(data.y ?? 90);
  data.w = snap(data.w ?? 420);
  data.h = snap(data.h ?? 330);
  data.z = data.z ?? nextZ();
  if (data.folderId === undefined) data.folderId = null;
  if (!Array.isArray(data.strokes)) data.strokes = [];
  clampBox(data);
  return data;
}
function sizeSheetCanvas(entry) {
  const cvs = entry.canvas;
  const w = cvs.clientWidth, h = cvs.clientHeight;
  cvs.width = Math.max(1, Math.round(w * dpr));
  cvs.height = Math.max(1, Math.round(h * dpr));
  redrawCanvas(entry.ctx, w, h, entry.data.strokes);
}
function createSheet(data, container) {
  const s = normalizeSheet(data);
  const el = sheetTpl.content.firstElementChild.cloneNode(true);
  el.dataset.id = s.id;
  applyPos(el, s);
  const cvs = el.querySelector('.sheet-canvas');
  const ctx = cvs.getContext('2d');
  const entry = { el, data: s, canvas: cvs, ctx };

  el.addEventListener('mousedown', () => { bringToFront(s, el); activeSheet = entry; });
  el.querySelector('.sheet-del').addEventListener('click', (e) => { e.stopPropagation(); deleteSheet(entry); });

  makeItemDraggable(el, entry, '.sheet-head', '.sheet-del, .sheet-resize');
  makeBoxResizable(el.querySelector('.sheet-resize'), el, s, () => sizeSheetCanvas(entry));

  attachDrawing(cvs, {
    canDraw: () => !drawMode,
    getStrokes: () => entry.data.strokes,
    getCtx: () => entry.ctx,
    getSize: () => ({ cw: cvs.clientWidth, ch: cvs.clientHeight }),
    redraw: () => redrawCanvas(entry.ctx, cvs.clientWidth, cvs.clientHeight, entry.data.strokes),
    onStart: () => { activeSheet = entry; bringToFront(s, el); },
  });

  (container || canvas).appendChild(el);
  sheets.set(s.id, entry);
  sizeSheetCanvas(entry);
  return entry;
}
function deleteSheet(entry) {
  trashItem('sheet', entry);
}
function addSheet() {
  const c = viewportCenterWorld();
  const data = { x: snap(c.x - 210), y: snap(c.y - 165), w: 420, h: 330, folderId: null, strokes: [] };
  allSheets.push(data);
  const entry = createSheet(data, canvas);
  bringToFront(data, entry.el);
  pushItems(data);
  activeSheet = entry;
  updateDrawToolbar(); updateEmptyState(); save();
}

// ---------- Pastas ----------
function folderItems(id) {
  return [...allNotes.filter((n) => n.folderId === id), ...allSheets.filter((s) => s.folderId === id)];
}
function clampFolder(f) {
  // mundo livre (1º quadrante): só garante tamanho mínimo e coords não-negativas
  if (f.open) {
    f.w = Math.max(300, f.w);
    f.h = Math.max(220, f.h);
  }
  f.x = Math.max(0, f.x);
  f.y = Math.max(0, f.y);
}
function applyFolderPos(fe) {
  const f = fe.data;
  fe.el.style.left = f.x + 'px';
  fe.el.style.top = f.y + 'px';
  fe.el.style.zIndex = f.z;
  if (f.open) { fe.el.style.width = f.w + 'px'; fe.el.style.height = f.h + 'px'; }
}
// Pinta a pasta com a cor escolhida (mesma paleta das notas). Sem cor = visual padrão.
// O texto/ícones do cabeçalho ganham contraste automático (claro sobre cor escura,
// escuro sobre cor clara) via as variáveis --fink / --fink-soft.
function applyFolderColors(fe) {
  const f = fe.data;
  const el = fe.el;
  const head = el.querySelector('.folder-head');
  const body = fe.bodyEl;
  const dot = el.querySelector('.folder-color .color-dot');
  const hasColor = !!f.customColor || (f.color != null);
  if (!hasColor) {
    el.classList.remove('folder-colored');
    el.style.background = '';
    el.style.borderColor = '';
    el.style.removeProperty('--fink');
    el.style.removeProperty('--fink-soft');
    if (head) head.style.background = '';
    if (body) body.style.backgroundColor = '';
    if (dot) dot.style.background = '';
    return;
  }
  const { bg, bg2, light } = resolveColors(f);
  // contraste: cor clara → texto escuro; cor escura → texto cinza-claro
  el.classList.add('folder-colored');
  el.style.setProperty('--fink', light ? '#15171c' : 'rgba(255, 255, 255, 0.92)');
  el.style.setProperty('--fink-soft', light ? 'rgba(0, 0, 0, 0.6)' : 'rgba(255, 255, 255, 0.72)');
  if (dot) dot.style.background = bg2;
  if (f.open) {
    el.style.background = '';
    el.style.borderColor = bg2;
    if (head) head.style.background = `linear-gradient(160deg, ${bg2}, ${bg})`;
    // tinta sutil no corpo (onde ficam os itens), acompanhando o tema
    if (body) body.style.backgroundColor = `color-mix(in srgb, ${bg2} 16%, var(--panel-2))`;
  } else {
    el.style.background = `linear-gradient(160deg, ${bg2}, ${bg})`;
    el.style.borderColor = bg2;
  }
}
function buildMiniPreview(miniEl, id) {
  miniEl.innerHTML = '';
  const items = folderItems(id);
  const shown = items.slice(0, 4);
  shown.forEach((it) => {
    const tile = document.createElement('div');
    tile.className = 'mini-tile';
    if (it.strokes !== undefined) { tile.classList.add('sheet'); }
    else { tile.style.background = resolveColors(it).bg2; }
    miniEl.appendChild(tile);
  });
  for (let i = shown.length; i < 4; i++) {
    const tile = document.createElement('div');
    tile.className = 'mini-tile empty';
    miniEl.appendChild(tile);
  }
}
function createFolder(f) {
  if (f.open) {
    const el = folderOpenTpl.content.firstElementChild.cloneNode(true);
    el.dataset.id = f.id;
    const bodyEl = el.querySelector('.folder-body');
    bodyEl.dataset.id = f.id;
    el.querySelector('.folder-title').textContent = f.name;
    const fe = { el, data: f, bodyEl };

    el.addEventListener('mousedown', () => bringToFront(f, el));
    el.querySelector('.folder-collapse').addEventListener('click', (e) => { e.stopPropagation(); toggleFolder(f.id, false); });
    el.querySelector('.folder-color').addEventListener('click', (e) => { e.stopPropagation(); openColorPop(fe, e.currentTarget, () => applyFolderColors(fe)); });
    el.querySelector('.folder-rename').addEventListener('click', (e) => { e.stopPropagation(); renameFolder(f.id); });
    el.querySelector('.folder-del').addEventListener('click', (e) => { e.stopPropagation(); deleteFolder(f.id); });
    el.querySelector('.folder-title').addEventListener('dblclick', (e) => { e.stopPropagation(); renameFolder(f.id); });

    makeFolderDraggable(el, f, '.folder-head', '.folder-collapse, .folder-color, .folder-rename, .folder-del, .folder-resize, .folder-title');
    makeBoxResizable(el.querySelector('.folder-resize'), el, f, () => { /* clamp itens depois */ });

    applyFolderPos(fe);
    applyFolderColors(fe);
    canvas.appendChild(el);
    folderEntries.set(f.id, fe);
    return fe;
  }
  // fechada
  const el = folderClosedTpl.content.firstElementChild.cloneNode(true);
  el.dataset.id = f.id;
  el.querySelector('.folder-name').textContent = f.name;
  const fe = { el, data: f, bodyEl: null };
  buildMiniPreview(el.querySelector('.folder-mini'), f.id);
  el.querySelector('.folder-count').textContent = String(folderItems(f.id).length);

  el.addEventListener('mousedown', () => bringToFront(f, el));
  makeFolderDraggable(el, f, null, '.folder-resize', () => toggleFolder(f.id, true));

  applyFolderPos(fe);
  applyFolderColors(fe);
  canvas.appendChild(el);
  folderEntries.set(f.id, fe);
  return fe;
}
function refreshFolderPreviews() {
  folderEntries.forEach((fe) => {
    if (fe.data.open) return;
    buildMiniPreview(fe.el.querySelector('.folder-mini'), fe.data.id);
    fe.el.querySelector('.folder-count').textContent = String(folderItems(fe.data.id).length);
  });
}
function toggleFolder(id, open) {
  const f = folders.find((x) => x.id === id);
  if (!f) return;
  f.open = open;
  if (open && (!f.w || !f.h)) { f.w = 480; f.h = 360; }
  f.z = nextZ();
  renderAll();
  if (open) pushItems(f); // o painel aberto empurra o que estiver embaixo
  save();
}
// Renomeia a pasta editando o título no próprio lugar (prompt() não funciona no Electron).
function renameFolder(id) {
  const f = folders.find((x) => x.id === id);
  if (!f) return;
  const fe = folderEntries.get(id);
  if (!fe) return;
  const t = fe.el.querySelector('.folder-title');
  if (!t) return;

  const original = f.name;
  t.setAttribute('contenteditable', 'true');
  t.spellcheck = false;
  t.classList.add('editing');
  focusSelectAll(t);

  const finish = (commit) => {
    t.removeEventListener('keydown', onKey);
    t.removeEventListener('blur', onBlur);
    t.removeAttribute('contenteditable');
    t.classList.remove('editing');
    if (commit) {
      const name = t.textContent.trim();
      f.name = name || original;
      t.textContent = f.name;
      refreshFolderPreviews();
      save();
    } else {
      t.textContent = original;
    }
  };
  const onKey = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); t.blur(); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  };
  const onBlur = () => finish(true);
  t.addEventListener('keydown', onKey);
  t.addEventListener('blur', onBlur);
}
function focusSelectAll(el) {
  el.focus();
  const r = document.createRange();
  r.selectNodeContents(el);
  const s = getSelection();
  s.removeAllRanges();
  s.addRange(r);
}
function deleteFolder(id) {
  const f = folders.find((x) => x.id === id);
  if (!f) return;
  const items = folderItems(id);
  if (!confirm(`Excluir a pasta "${f.name}"?${items.length ? ' Os itens dentro voltam para a board.' : ''}`)) return;
  // itens voltam para a board (soltos)
  allNotes.forEach((n) => { if (n.folderId === id) { n.folderId = null; n.x = snap(40 + Math.random() * 80); n.y = snap(40 + Math.random() * 80); n.z = nextZ(); } });
  allSheets.forEach((s) => { if (s.folderId === id) { s.folderId = null; s.x = snap(40 + Math.random() * 80); s.y = snap(40 + Math.random() * 80); s.z = nextZ(); } });
  folders = folders.filter((x) => x.id !== id);
  renderAll(); save();
}
function addFolder() {
  const c = viewportCenterWorld();
  const f = {
    id: uid('f'),
    name: 'Nova pasta',
    x: snap(c.x - FOLDER_CLOSED / 2),
    y: snap(c.y - FOLDER_CLOSED / 2),
    z: nextZ(), open: false, w: 480, h: 360,
  };
  folders.push(f);
  renderAll();
  pushItems(f);
  save();
  guideNotify('folder');
}

// Auto-organizar: alinha os itens soltos da board (notas, folhas e pastas)
// num grid limpo, da esquerda para a direita, quebrando linha, sem sobreposição.
function autoArrange() {
  const items = itemsIn(null); // soltos na board + todas as pastas
  if (items.length < 2) return;
  const { w: bw } = boardSize();
  const GUT = GRID;
  // ordena pela posição atual (cima→baixo, depois esquerda→direita) p/ preservar a intenção
  items.sort((a, b) => {
    const ra = itemRect(a), rb = itemRect(b);
    const rowA = Math.round(ra.y / 80), rowB = Math.round(rb.y / 80);
    return rowA !== rowB ? rowA - rowB : ra.x - rb.x;
  });
  let x = GUT, y = GUT, rowH = 0;
  items.forEach((it) => {
    const r = itemRect(it);
    if (x > GUT && x + r.w > bw - GUT) { x = GUT; y += rowH + GUT; rowH = 0; }
    it.o.x = snap(x);
    it.o.y = snap(y);
    applyItemPos(it);
    x += r.w + GUT;
    rowH = Math.max(rowH, r.h);
  });
  refreshFolderPreviews();
  fitToContent(); // enquadra o resultado organizado na tela
  save();
}

// Arraste de pasta (sempre na board; não reparenta)
function makeFolderDraggable(el, f, dragFromSel, ignoreSel, onClick) {
  const THRESHOLD = 4;
  el.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const t = e.target;
    if (ignoreSel && t.closest(ignoreSel)) return;
    if (dragFromSel && !t.closest(dragFromSel)) return;
    const startX = e.clientX, startY = e.clientY;
    const origX = f.x, origY = f.y;
    let dragging = false, hoverTab = null;
    e.preventDefault();
    bringToFront(f, el);
    const onMove = (ev) => {
      const dx = ev.clientX - startX, dy = ev.clientY - startY;
      if (!dragging && Math.hypot(dx, dy) > THRESHOLD) { dragging = true; el.classList.add('dragging'); }
      if (dragging) {
        // deslocamento de tela → mundo (÷ zoom); mundo livre (sem teto)
        f.x = Math.max(0, snap(origX + dx / zoom));
        f.y = Math.max(0, snap(origY + dy / zoom));
        el.style.left = f.x + 'px';
        el.style.top = f.y + 'px';
        // sobre a aba de outra board? destaca para transferir
        const destTabId = tabAt(ev.clientX, ev.clientY);
        const tabEl = (destTabId && destTabId !== activeBoardId)
          ? document.querySelector(`.board-tab[data-id="${destTabId}"]`) : null;
        if (tabEl !== hoverTab) {
          if (hoverTab) hoverTab.classList.remove('drop-target');
          hoverTab = tabEl;
          if (hoverTab) hoverTab.classList.add('drop-target');
        }
      }
    };
    const onUp = (ev) => {
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('mouseup', onUp, true);
      el.classList.remove('dragging');
      if (hoverTab) hoverTab.classList.remove('drop-target');
      if (dragging) {
        const destTabId = tabAt(ev.clientX, ev.clientY);
        if (destTabId && destTabId !== activeBoardId) { moveItemToBoard('folder', f, destTabId); return; }
        pushItems(f); scheduleSave();
      } else if (onClick) onClick();
    };
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mouseup', onUp, true);
  });
}

// ---------- Render geral ----------
function renderAll() {
  notes.forEach((e) => e.el.remove()); notes.clear();
  sheets.forEach((e) => e.el.remove()); sheets.clear();
  folderEntries.forEach((e) => e.el.remove()); folderEntries.clear();
  activeSheet = null;

  folders.forEach((f) => createFolder(f));
  allNotes.filter((n) => !n.folderId).forEach((n) => createNote(n, canvas));
  allSheets.filter((s) => !s.folderId).forEach((s) => createSheet(s, canvas));
  folders.filter((f) => f.open).forEach((f) => {
    const fe = folderEntries.get(f.id);
    if (!fe || !fe.bodyEl) return;
    allNotes.filter((n) => n.folderId === f.id).forEach((n) => createNote(n, fe.bodyEl));
    allSheets.filter((s) => s.folderId === f.id).forEach((s) => createSheet(s, fe.bodyEl));
  });
  activeSheet = sheets.values().next().value || null;

  reflow();
  sizeDrawLayer();
  refreshFolderPreviews();
  updateEmptyState();
  updateDrawToolbar();
  applyView(); // reaplica o transform de zoom/pan após recriar os elementos
}

let reflowTimer = null;
function reflow() {
  folderEntries.forEach((fe) => { clampFolder(fe.data); applyFolderPos(fe); });
  notes.forEach((e) => { clampBox(e.data); applyToneAndPos(e.el, e.data); });
  sheets.forEach((e) => { clampBox(e.data); applyPos(e.el, e.data); sizeSheetCanvas(e); });
}

// ---------- Cards concluídos ----------
const archiveEl = document.getElementById('archive');
const archiveList = document.getElementById('archive-list');
const archiveEmpty = document.getElementById('archive-empty');
const archiveCount = document.getElementById('archive-count');

function noteSummary(data) {
  if (data.title && data.title.trim()) return data.title.trim();
  const firstText = (data.items || []).map((i) => (i.text || '').trim()).find(Boolean);
  return firstText || 'Sem título';
}
function updateArchiveCount() {
  archiveCount.textContent = String(archived.length);
  archiveCount.hidden = archived.length === 0;
}
function renderArchive() {
  archiveList.innerHTML = '';
  archiveEmpty.style.display = archived.length ? 'none' : 'block';
  archived.forEach((data) => {
    const card = document.createElement('div');
    card.className = 'archive-item';
    card.style.borderLeftColor = resolveColors(data).bg2;
    const h = document.createElement('h4'); h.textContent = noteSummary(data); card.appendChild(h);
    const items = (data.items || []).filter((i) => (i.text || '').trim());
    if (items.length) {
      const ul = document.createElement('div'); ul.className = 'tasks';
      items.slice(0, 5).forEach((i) => {
        const row = document.createElement('div');
        row.className = 'task-row' + (i.marker !== 'bullet' && i.done ? ' done' : '');
        row.textContent = (i.marker === 'bullet' ? '• ' : (i.done ? '✓ ' : '☐ ')) + i.text;
        ul.appendChild(row);
      });
      if (items.length > 5) { const m = document.createElement('div'); m.className = 'task-row muted'; m.textContent = `+${items.length - 5} item(ns)`; ul.appendChild(m); }
      card.appendChild(ul);
    }
    const actions = document.createElement('div'); actions.className = 'actions';
    const restore = document.createElement('button'); restore.className = 'mini-btn restore'; restore.textContent = 'Restaurar';
    restore.addEventListener('click', () => restoreNote(data.id));
    const del = document.createElement('button'); del.className = 'mini-btn delete'; del.textContent = 'Excluir';
    del.addEventListener('click', () => deleteArchived(data.id));
    actions.append(restore, del); card.appendChild(actions);
    archiveList.appendChild(card);
  });
}
function archiveNote(entry) {
  syncFromDom(entry);
  const data = entry.data;
  data.archivedAt = Date.now();
  archived.unshift(data);
  allNotes = allNotes.filter((n) => n.id !== data.id);
  entry.el.remove(); notes.delete(data.id);
  refreshFolderPreviews(); updateEmptyState(); renderArchive(); updateArchiveCount(); save();
}
function restoreNote(id) {
  const idx = archived.findIndex((d) => d.id === id);
  if (idx < 0) return;
  const [data] = archived.splice(idx, 1);
  delete data.archivedAt;
  data.z = nextZ();
  data.folderId = null; // volta solta na board
  allNotes.push(data);
  renderAll();
  pushItems(data);
  renderArchive(); updateArchiveCount(); save();
}
function deleteArchived(id) {
  const i = archived.findIndex((d) => d.id === id);
  if (i < 0) return;
  const [data] = archived.splice(i, 1);
  sendToTrash('note', data, null); // recuperável na Lixeira
  renderArchive(); updateArchiveCount(); save();
}

// ---------- Painéis laterais (exclusivos) ----------
const PANELS = ['archive', 'trash', 'settings'];
function showPanel(id) {
  PANELS.forEach((x) => { if (x !== id) document.getElementById(x).classList.add('hidden'); });
  document.getElementById(id).classList.toggle('hidden');
}
function hidePanel(id) { document.getElementById(id).classList.add('hidden'); }

// ---------- Lixeira ----------
const trashListEl = document.getElementById('trash-list');
const trashEmptyEl = document.getElementById('trash-empty');
const trashCountEl = document.getElementById('trash-count');

function sendToTrash(kind, data, fromFolderId) {
  data.deletedAt = Date.now();
  trash.unshift({ kind, data, fromFolderId: fromFolderId || null });
  renderTrash(); updateTrashCount();
}
function trashItem(kind, entry) {
  const data = entry.data;
  if (kind === 'sheet') {
    allSheets = allSheets.filter((s) => s.id !== data.id);
    sheets.delete(data.id);
    if (activeSheet === entry) activeSheet = sheets.values().next().value || null;
  } else {
    allNotes = allNotes.filter((n) => n.id !== data.id);
    notes.delete(data.id);
  }
  entry.el.remove();
  sendToTrash(kind, data, data.folderId || null);
  refreshFolderPreviews(); updateEmptyState(); updateDrawToolbar(); save();
}
function restoreTrash(idx) {
  const t = trash[idx];
  if (!t) return;
  trash.splice(idx, 1);
  const data = t.data;
  delete data.deletedAt;
  data.z = nextZ();
  data.folderId = (t.fromFolderId && folders.some((f) => f.id === t.fromFolderId)) ? t.fromFolderId : null;
  if (t.kind === 'sheet') allSheets.push(data); else allNotes.push(data);
  renderAll();
  pushItems(data);
  renderTrash(); updateTrashCount(); save();
}
function purgeTrash(idx) {
  const t = trash[idx];
  if (!t) return;
  if (!confirm('Excluir definitivamente este item? Não será possível recuperar.')) return;
  trash.splice(idx, 1);
  renderTrash(); updateTrashCount(); save();
}
function emptyTrashAll() {
  if (!trash.length) return;
  if (!confirm('Esvaziar a Lixeira? Todos os itens serão apagados para sempre.')) return;
  trash = [];
  renderTrash(); updateTrashCount(); save();
}
function updateTrashCount() {
  trashCountEl.textContent = String(trash.length);
  trashCountEl.hidden = trash.length === 0;
}
function trashSummary(t) {
  if (t.kind === 'sheet') return 'Folha de desenho';
  return noteSummary(t.data);
}
function renderTrash() {
  trashListEl.innerHTML = '';
  trashEmptyEl.style.display = trash.length ? 'none' : 'block';
  trash.forEach((t, idx) => {
    const card = document.createElement('div');
    card.className = 'archive-item';
    if (t.kind === 'sheet') card.style.borderLeftColor = '#cfd3da';
    else card.style.borderLeftColor = resolveColors(t.data).bg2;

    const h = document.createElement('h4');
    h.textContent = (t.kind === 'sheet' ? '🎨 ' : '') + trashSummary(t);
    card.appendChild(h);

    if (t.kind === 'note') {
      const items = (t.data.items || []).filter((i) => (i.text || '').trim());
      if (items.length) {
        const ul = document.createElement('div'); ul.className = 'tasks';
        items.slice(0, 4).forEach((i) => {
          const row = document.createElement('div');
          row.className = 'task-row' + (i.marker !== 'bullet' && i.done ? ' done' : '');
          row.textContent = (i.marker === 'bullet' ? '• ' : (i.done ? '✓ ' : '☐ ')) + i.text;
          ul.appendChild(row);
        });
        card.appendChild(ul);
      }
    } else {
      const info = document.createElement('div');
      info.className = 'task-row muted';
      info.textContent = `${(t.data.strokes || []).length} traço(s)`;
      card.appendChild(info);
    }

    const actions = document.createElement('div'); actions.className = 'actions';
    const restore = document.createElement('button'); restore.className = 'mini-btn restore'; restore.textContent = 'Restaurar';
    restore.addEventListener('click', () => restoreTrash(idx));
    const del = document.createElement('button'); del.className = 'mini-btn delete'; del.textContent = 'Excluir';
    del.addEventListener('click', () => purgeTrash(idx));
    actions.append(restore, del);
    card.appendChild(actions);
    trashListEl.appendChild(card);
  });
}

// ---------- Backup ----------
const backupListEl = document.getElementById('backup-list');
function fmtBackupName(name, time) {
  const d = new Date(time);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
async function openBackupPanel() {
  if (!isDesktop) return;
  // status da cópia na nuvem
  let mirror = null;
  try { mirror = await window.boardAPI.getMirror(); } catch {}
  const statusEl = document.getElementById('bk-mirror-status');
  const clearBtn = document.getElementById('bk-mirror-clear');
  statusEl.textContent = mirror || 'Não configurada';
  statusEl.classList.toggle('muted', !mirror);
  clearBtn.hidden = !mirror;

  // lista de backups
  backupListEl.innerHTML = '';
  let list = [];
  try { list = await window.boardAPI.listBackups(); } catch {}
  if (!list.length) {
    const e = document.createElement('div'); e.className = 'archive-empty';
    e.innerHTML = '<p class="muted">Ainda não há backups. Eles são criados automaticamente conforme você usa o app.</p>';
    backupListEl.appendChild(e);
    return;
  }
  list.forEach((b) => {
    const row = document.createElement('div'); row.className = 'archive-item';
    const h = document.createElement('h4'); h.textContent = fmtBackupName(b.name, b.time); row.appendChild(h);
    const meta = document.createElement('div'); meta.className = 'task-row muted'; meta.textContent = b.name; row.appendChild(meta);
    const actions = document.createElement('div'); actions.className = 'actions';
    const rest = document.createElement('button'); rest.className = 'mini-btn restore'; rest.textContent = 'Restaurar';
    rest.addEventListener('click', () => restoreFromBackup(b.name));
    actions.appendChild(rest);
    row.appendChild(actions);
    backupListEl.appendChild(row);
  });
}
async function restoreFromBackup(name) {
  if (!confirm('Restaurar este backup? O conteúdo atual será substituído (um novo backup é criado antes).')) return;
  const data = await window.boardAPI.readBackup(name);
  if (!data) { alert('Não foi possível ler este backup.'); return; }
  applyState(data);
  save();
  hidePanel('settings');
}

// ---------- Seletor de cor das notas ----------
const colorPop = document.createElement('div');
colorPop.className = 'color-pop hidden';
document.body.appendChild(colorPop);
let colorPopEntry = null;
let colorPopApply = null; // repinta o alvo (nota ou pasta) após mudar a cor
function buildColorPop() {
  colorPop.innerHTML = '';
  const grid = document.createElement('div'); grid.className = 'swatches';
  palette().forEach((c, i) => {
    const sw = document.createElement('button');
    sw.className = 'swatch';
    sw.style.background = `linear-gradient(160deg, ${c.bg2}, ${c.bg})`;
    sw.title = c.name;
    sw.addEventListener('click', (e) => {
      e.stopPropagation();
      if (colorPopEntry) {
        colorPopEntry.data.color = i; colorPopEntry.data.customColor = null;
        if (colorPopApply) colorPopApply();
        refreshFolderPreviews(); save();
      }
      hideColorPop();
    });
    grid.appendChild(sw);
  });
  colorPop.appendChild(grid);
  const custom = document.createElement('label'); custom.className = 'swatch-custom';
  const span = document.createElement('span'); span.textContent = 'Personalizar';
  const inp = document.createElement('input'); inp.type = 'color'; inp.value = '#2c2f34';
  inp.addEventListener('input', (e) => {
    if (colorPopEntry) {
      colorPopEntry.data.customColor = e.target.value;
      if (colorPopApply) colorPopApply();
      refreshFolderPreviews(); scheduleSave();
    }
  });
  custom.append(span, inp); colorPop.appendChild(custom);
}
buildColorPop();
// applyFn (opcional): como repintar o alvo. Padrão = nota.
function openColorPop(entry, btn, applyFn) {
  colorPopEntry = entry;
  colorPopApply = applyFn || (() => applyToneAndPos(entry.el, entry.data));
  const inp = colorPop.querySelector('input[type="color"]');
  if (inp && entry.data.customColor) inp.value = entry.data.customColor;
  colorPop.classList.remove('hidden');
  const r = btn.getBoundingClientRect();
  const pw = colorPop.offsetWidth || 200;
  let left = r.left; if (left + pw > window.innerWidth - 8) left = window.innerWidth - 8 - pw;
  colorPop.style.left = Math.max(8, left) + 'px';
  colorPop.style.top = (r.bottom + 6) + 'px';
}
function hideColorPop() { colorPop.classList.add('hidden'); colorPopEntry = null; colorPopApply = null; }
document.addEventListener('mousedown', (e) => {
  if (colorPop.classList.contains('hidden')) return;
  if (!e.target.closest('.color-pop') && !e.target.closest('.note-color') && !e.target.closest('.folder-color') && !e.target.closest('.board-color-btn')) hideColorPop();
});

// ---------- Barra de ferramentas de desenho ----------
function updateDrawToolbar() {
  const show = drawMode || sheets.size > 0;
  drawToolbar.classList.toggle('hidden', !show);
  document.getElementById('draw-done').style.display = drawMode ? '' : 'none';
}
function buildDrawColors() {
  const wrap = document.getElementById('draw-colors');
  wrap.innerHTML = '';
  DRAW_COLORS.forEach((c) => {
    const b = document.createElement('button');
    b.className = 'draw-swatch'; b.style.background = c; b.title = c; b.dataset.color = c;
    b.addEventListener('click', () => {
      penColor = c; if (tool === 'eraser') tool = 'pen';
      document.getElementById('draw-custom').value = c; updateToolUI();
    });
    wrap.appendChild(b);
  });
  updateToolUI();
}
function updateToolUI() {
  document.querySelectorAll('#draw-toolbar .tool[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
  document.querySelectorAll('.draw-swatch').forEach((b) => b.classList.toggle('active', tool === 'pen' && b.dataset.color === penColor));
}
document.querySelectorAll('#draw-toolbar .tool[data-tool]').forEach((b) => {
  b.addEventListener('click', () => { tool = b.dataset.tool; updateToolUI(); });
});
document.getElementById('draw-custom').addEventListener('input', (e) => {
  penColor = e.target.value; if (tool === 'eraser') tool = 'pen'; updateToolUI();
});
document.getElementById('draw-size').addEventListener('input', (e) => { penSize = parseInt(e.target.value, 10) || 3; });
document.getElementById('draw-clear').addEventListener('click', () => {
  if (drawMode) {
    if (!boardDrawing.length) return;
    if (!confirm('Apagar o desenho feito sobre a board?')) return;
    purgeHistory(boardDrawing); boardDrawing.length = 0; sizeDrawLayer(); save();
  } else if (activeSheet && sheets.has(activeSheet.data.id)) {
    const arr = activeSheet.data.strokes;
    if (!arr.length) return;
    if (!confirm('Apagar o desenho desta folha?')) return;
    purgeHistory(arr); activeSheet.data.strokes = []; sizeSheetCanvas(activeSheet); save();
  }
});
document.getElementById('draw-done').addEventListener('click', () => setDrawMode(false));
document.getElementById('btn-draw').addEventListener('click', () => setDrawMode(!drawMode));
document.getElementById('btn-sheet').addEventListener('click', addSheet);
document.getElementById('btn-new-folder').addEventListener('click', addFolder);
document.getElementById('btn-arrange').addEventListener('click', autoArrange);
buildDrawColors();

// ----- Preview da ponta do brush -----
const brushCursor = document.createElement('div');
brushCursor.className = 'brush-cursor hidden';
document.body.appendChild(brushCursor);
function isDrawableAt(x, y) {
  const el = document.elementFromPoint(x, y);
  if (!el) return false;
  if (drawMode) return el === drawLayer || !!el.closest('#canvas');
  return el.classList && el.classList.contains('sheet-canvas');
}
function updateBrushCursor(x, y) {
  if (!isDrawableAt(x, y)) { brushCursor.classList.add('hidden'); return; }
  const d = Math.max(2, penSize);
  brushCursor.style.width = d + 'px';
  brushCursor.style.height = d + 'px';
  brushCursor.style.left = x + 'px';
  brushCursor.style.top = y + 'px';
  brushCursor.classList.toggle('eraser', tool === 'eraser');
  brushCursor.classList.toggle('shape', isShapeTool(tool));
  brushCursor.style.borderColor = tool === 'eraser' ? 'rgba(255,255,255,0.9)' : penColor;
  brushCursor.classList.remove('hidden');
}
document.addEventListener('pointermove', (e) => updateBrushCursor(e.clientX, e.clientY));
document.addEventListener('pointerleave', () => brushCursor.classList.add('hidden'));

// ----- Atalhos desfazer/refazer -----
document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  if (e.key === 'z' || e.key === 'Z') {
    if (document.activeElement?.isContentEditable) return;
    e.preventDefault();
    if (e.shiftKey) redoDraw(); else undoDraw();
  } else if (e.key === 'y' || e.key === 'Y') {
    if (document.activeElement?.isContentEditable) return;
    e.preventDefault(); redoDraw();
  }
});

// ---------- Adicionar nota ----------
function addNoteInto(localX, localY, folderId, container) {
  const data = { x: localX, y: localY, folderId };
  allNotes.push(data);
  const entry = createNote(data, container || canvas);
  bringToFront(entry.data, entry.el);
  pushItems(entry.data);
  refreshFolderPreviews(); updateEmptyState();
  const first = entry.el.querySelector('.item-content');
  setTimeout(() => focusStart(first), 30);
  save();
  guideNotify('note');
  return entry;
}
function addNoteCentered() {
  const c = viewportCenterWorld();
  const x = c.x - 150 + (Math.random() * 40 - 20);
  const y = c.y - 120 + (Math.random() * 40 - 20);
  addNoteInto(Math.max(0, x), Math.max(0, y), null, canvas);
}

// ---------- Eventos globais ----------
document.getElementById('btn-add').addEventListener('click', addNoteCentered);
document.getElementById('btn-add-empty').addEventListener('click', addNoteCentered);

document.getElementById('btn-archive').addEventListener('click', () => { renderArchive(); showPanel('archive'); });
document.getElementById('archive-close').addEventListener('click', () => hidePanel('archive'));
document.getElementById('btn-trash').addEventListener('click', () => { renderTrash(); showPanel('trash'); });
document.getElementById('trash-close').addEventListener('click', () => hidePanel('trash'));
document.getElementById('trash-empty-btn').addEventListener('click', emptyTrashAll);

// Backup e segurança — agora dentro das Configurações (só no app desktop)
if (isDesktop) {
  document.getElementById('settings-backup').hidden = false;
  document.getElementById('settings-about').hidden = false;
  document.getElementById('bk-export').addEventListener('click', async () => {
    const ok = await window.boardAPI.exportData(buildPayload());
    if (ok) alert('Exportado com sucesso!');
  });
  document.getElementById('bk-import').addEventListener('click', async () => {
    const data = await window.boardAPI.importData();
    if (!data) return;
    if (!confirm('Importar vai substituir o conteúdo atual (um backup é criado antes). Continuar?')) return;
    applyState(data); save(); hidePanel('settings');
  });
  document.getElementById('bk-reveal').addEventListener('click', () => window.boardAPI.reveal());
  document.getElementById('bk-mirror-set').addEventListener('click', async () => {
    await window.boardAPI.setMirror();
    openBackupPanel();
  });
  document.getElementById('bk-mirror-clear').addEventListener('click', async () => {
    await window.boardAPI.clearMirror();
    openBackupPanel();
  });

  // ----- Atualizações automáticas -----
  const verEl = document.getElementById('app-version');
  const updStatus = document.getElementById('update-status');
  if (window.boardAPI.getVersion) {
    window.boardAPI.getVersion().then((v) => { if (verEl) verEl.textContent = 'v' + v; }).catch(() => {});
  }
  document.getElementById('bk-update').addEventListener('click', async () => {
    updStatus.textContent = 'Verificando…';
    const r = await window.boardAPI.checkUpdate();
    if (r && r.ok) updStatus.textContent = 'Procurando atualização…';
    else if (r && r.reason === 'dev') updStatus.textContent = 'A atualização automática funciona na versão instalada do app.';
    else updStatus.textContent = 'Não foi possível verificar agora. Tente mais tarde.';
  });
  if (window.boardAPI.onUpdate) {
    window.boardAPI.onUpdate((ch, data) => {
      if (ch === 'update:available') updStatus.textContent = `Baixando a versão ${data.version}…`;
      else if (ch === 'update:none') updStatus.textContent = 'Você já está na versão mais recente. ✅';
      else if (ch === 'update:error') updStatus.textContent = 'Falha ao verificar atualização.';
      else if (ch === 'update:progress') updStatus.textContent = `Baixando atualização… ${data.percent}%`;
      else if (ch === 'update:downloaded') {
        updStatus.textContent = `Versão ${data.version} pronta. Reinicie para aplicar.`;
        showUpdateToast(data.version);
      }
    });
  }
}

// Aviso flutuante quando uma atualização foi baixada e está pronta para instalar
function showUpdateToast(version) {
  if (document.getElementById('update-toast')) return;
  const t = document.createElement('div');
  t.id = 'update-toast';
  t.className = 'update-toast';
  const label = document.createElement('span');
  label.textContent = `🎉 Atualização ${version ? 'v' + version + ' ' : ''}pronta!`;
  const now = document.createElement('button');
  now.className = 'btn btn-primary'; now.textContent = 'Reiniciar e atualizar';
  now.addEventListener('click', () => window.boardAPI.installUpdate());
  const later = document.createElement('button');
  later.className = 'btn btn-ghost'; later.textContent = 'Depois';
  later.addEventListener('click', () => t.remove());
  t.append(label, now, later);
  document.body.appendChild(t);
}

// ---------- Configurações: tema ----------
function applyTheme() {
  document.documentElement.dataset.theme = resolvedTheme();
  document.querySelectorAll('.theme-opt').forEach((b) => {
    b.classList.toggle('active', b.dataset.themeOpt === themePref);
  });
  // repinta tudo que usa cores calculadas em JS (paleta dos cards por tema)
  buildColorPop();
  renderAll();
  renderTabs();              // re-tinge as abas com a paleta do tema
  applyActiveBoardColor();   // re-pinta o fundo da board ativa
  renderArchive();
  renderTrash();
}
function setThemePref(pref) {
  themePref = pref;
  localStorage.setItem(THEME_KEY, pref);
  // guarda também no config.json para a janela já abrir na cor certa
  if (isDesktop && window.boardAPI.setTheme) window.boardAPI.setTheme(pref);
  applyTheme();
}
systemDark.addEventListener('change', () => {
  if (themePref === 'system') applyTheme();
});
document.getElementById('btn-settings').addEventListener('click', () => {
  showPanel('settings');
  if (isDesktop) openBackupPanel(); // carrega status da nuvem + lista de backups
});
document.getElementById('settings-close').addEventListener('click', () => hidePanel('settings'));
document.querySelectorAll('.theme-opt').forEach((b) => {
  b.addEventListener('click', () => setThemePref(b.dataset.themeOpt));
  b.classList.toggle('active', b.dataset.themeOpt === themePref);
});
if (isDesktop && window.boardAPI.setTheme) window.boardAPI.setTheme(themePref);

document.getElementById('btn-clear').addEventListener('click', () => {
  const loose = allNotes.filter((n) => !n.folderId);
  if (!loose.length) return;
  if (!confirm('Mover as notas soltas da board para a Lixeira? (pastas, folhas e desenho não são afetados)')) return;
  loose.forEach((n) => sendToTrash('note', n, null));
  allNotes = allNotes.filter((n) => n.folderId);
  renderAll(); save();
});

board.addEventListener('dblclick', (e) => {
  if (drawMode) return;
  if (e.target.closest('.note') || e.target.closest('.sheet') || e.target.closest('.folder.closed')) return;
  const bodyEl = e.target.closest('.folder-body');
  if (e.target.closest('.folder.open') && !bodyEl) return; // duplo clique no cabeçalho não cria nota
  const container = bodyEl || canvas;
  const folderId = bodyEl ? bodyEl.dataset.id : null;
  const r = container.getBoundingClientRect();
  // duplo clique na barra de rolagem da pasta não cria nota
  if (bodyEl) {
    if ((e.clientX - r.left) / zoom >= bodyEl.clientWidth || (e.clientY - r.top) / zoom >= bodyEl.clientHeight) return;
  }
  // o rect reflete o zoom (container sob o transform): divide por zoom
  const x = (e.clientX - r.left) / zoom + (container.scrollLeft || 0) - 150;
  const y = (e.clientY - r.top) / zoom + (container.scrollTop || 0) - 30;
  addNoteInto(Math.max(0, x), Math.max(0, y), folderId, container);
});

document.addEventListener('keydown', (e) => {
  const editing = document.activeElement?.isContentEditable;
  if (!editing && !drawMode && !guideOn() && (e.key === 'n' || e.key === 'N')) { e.preventDefault(); addNoteCentered(); }
});

// ---------- Pan (arrastar o fundo) e zoom (roda do mouse) ----------
const PANNABLE_IGNORE = '.note, .sheet, .folder, .zoom-hud, .draw-toolbar, .color-pop, .archive, .tutorial-overlay, .board-tabs';
function updateZoomHud() {
  const el = document.getElementById('zoom-level');
  if (el) el.textContent = Math.round(zoom * 100) + '%';
}
board.addEventListener('mousedown', (e) => {
  if (e.button !== 0 && e.button !== 1) return; // esquerdo ou do meio
  if (drawMode) return;
  if (e.target.closest(PANNABLE_IGNORE)) return; // só pana a partir do fundo
  const startX = e.clientX, startY = e.clientY;
  const ox = panX, oy = panY;
  let panning = false;
  const onMove = (ev) => {
    const dx = ev.clientX - startX, dy = ev.clientY - startY;
    if (!panning && Math.hypot(dx, dy) > 4) { panning = true; document.body.classList.add('panning'); }
    if (panning) { panX = ox + dx; panY = oy + dy; applyView(); }
  };
  const onUp = () => {
    window.removeEventListener('mousemove', onMove, true);
    window.removeEventListener('mouseup', onUp, true);
    document.body.classList.remove('panning');
    if (panning) { clearTimeout(viewSaveTimer); viewSaveTimer = setTimeout(save, 400); }
  };
  window.addEventListener('mousemove', onMove, true);
  window.addEventListener('mouseup', onUp, true);
});
board.addEventListener('wheel', (e) => {
  if (drawMode) return;
  // rolar dentro de uma nota/pasta/painel mantém o comportamento nativo (salvo com Ctrl)
  if (!e.ctrlKey && e.target.closest('.note-lines, .folder-body, .archive')) return;
  e.preventDefault();
  zoomAt(zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1), e.clientX, e.clientY);
}, { passive: false });

// Controles do HUD de zoom
document.getElementById('zoom-in').addEventListener('click', () => zoomByStep(1.2));
document.getElementById('zoom-out').addEventListener('click', () => zoomByStep(1 / 1.2));
document.getElementById('zoom-reset').addEventListener('click', resetView);
document.getElementById('zoom-fit').addEventListener('click', fitToContent);
document.getElementById('btn-fit').addEventListener('click', fitToContent);

// Atalhos de zoom (Ctrl/⌘): 0 = 100%, 9 = ver tudo, +/− = aproximar/afastar
document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  if (e.key === '0') { e.preventDefault(); resetView(); }
  else if (e.key === '9') { e.preventDefault(); fitToContent(); }
  else if (e.key === '=' || e.key === '+') { e.preventDefault(); zoomByStep(1.2); }
  else if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomByStep(1 / 1.2); }
});

// ---------- Tutorial guiado (passo a passo interativo) ----------
// Destaca um botão, pede a ação e avança quando o usuário a realiza.
// A versão da chave muda a cada grande atualização para reaparecer a todos.
const TUTORIAL_KEY = 'minha-board:tutorial-guiado:v1';
const GUIDE_STEPS = [
  {
    text: '<b>Bem-vindo à Minha Board! 👋</b><br><br>Vou te mostrar o básico em alguns passos. Você mesmo vai fazendo cada ação. É rápido!',
    target: null, await: 'next', label: 'Começar',
  },
  {
    text: 'Clique no botão <b>+</b> para criar a sua <b>primeira nota</b>.',
    target: '#btn-add', await: 'note',
  },
  {
    text: 'Pronto! 🎉 Essa é a sua nota.<br><br>Escreva uma tarefa e tecle <kbd>Enter</kbd> para adicionar outra. Quando quiser, é só seguir.',
    target: null, await: 'next',
  },
  {
    text: 'Agora crie uma <b>pasta</b> para organizar suas notas: clique no ícone de <b>pasta</b>.',
    target: '#btn-new-folder', await: 'folder',
  },
  {
    text: 'Você pode ter <b>várias boards</b> (espaços separados).<br><br>Clique no <b>+</b> ao lado das abas, no topo, para criar outra.',
    target: '.board-tab-add', await: 'board',
  },
  {
    text: 'Dê uma <b>cor</b> a cada board! 🎨 Clique aqui para escolher uma cor sugerida ou personalizada — o fundo da board e a aba mudam juntos.',
    target: '.board-color-btn', await: 'next',
  },
  {
    text: 'Para navegar: gire a <b>roda do mouse</b> para dar zoom e <b>arraste o fundo</b> para se mover.<br><br>Este botão mostra a <b>board inteira</b> de uma vez.',
    target: '#btn-fit', await: 'next',
  },
  {
    text: 'Na <b>engrenagem</b> ficam o <b>tema</b>, o <b>backup</b> e as <b>atualizações</b> do app.',
    target: '#btn-settings', await: 'next',
  },
  {
    text: '<b>Tudo pronto! ✅</b><br><br>Você já sabe o essencial. Para rever este tour quando quiser, clique no <b>❓</b> na barra à esquerda. Bom uso!',
    target: null, await: 'done', label: 'Concluir',
  },
];

// "Novidades": mini-tour mostrado só a quem já fez o tutorial completo, quando
// uma atualização traz uma feature nova. Cada novidade tem sua própria chave.
const NEWS_KEY = 'minha-board:novidade:cor-da-board';
const NEWS_STEPS = [
  {
    text: '<b>Novidade! 🎨</b><br><br>Agora dá para mudar a <b>cor de cada board</b>. Clique aqui para escolher uma cor sugerida ou personalizada — o fundo e a aba mudam juntos.',
    target: '.board-color-btn', await: 'next', label: 'Entendi!',
  },
];

let guideStep = 0, guideActive = false, guideEls = null;
let guideSteps = GUIDE_STEPS, guideKey = TUTORIAL_KEY;
function guideOn() { return guideActive; }

function buildGuideEls() {
  const spot = document.createElement('div'); spot.className = 'guide-spot';
  const bubble = document.createElement('div'); bubble.className = 'guide-bubble';
  const txt = document.createElement('div'); txt.className = 'guide-text';
  const foot = document.createElement('div'); foot.className = 'guide-foot';
  const count = document.createElement('span'); count.className = 'guide-count';
  const nextBtn = document.createElement('button'); nextBtn.className = 'btn btn-primary guide-next';
  foot.append(count, nextBtn);
  bubble.append(txt, foot);
  const skip = document.createElement('button'); skip.className = 'guide-skip';
  skip.textContent = 'Pular tutorial ✕';
  skip.addEventListener('click', () => endGuide(true));
  nextBtn.addEventListener('click', guideNext);
  document.body.append(spot, bubble, skip);
  return { spot, bubble, txt, foot, count, nextBtn, skip };
}
function positionGuide() {
  const s = guideSteps[guideStep];
  const { spot, bubble } = guideEls;
  const vw = window.innerWidth, vh = window.innerHeight;
  const target = s.target ? document.querySelector(s.target) : null;
  if (target) {
    const r = target.getBoundingClientRect();
    const pad = 6;
    spot.classList.remove('no-target');
    spot.style.left = (r.left - pad) + 'px';
    spot.style.top = (r.top - pad) + 'px';
    spot.style.width = (r.width + pad * 2) + 'px';
    spot.style.height = (r.height + pad * 2) + 'px';
    bubble.style.visibility = 'hidden'; bubble.style.left = '0px'; bubble.style.top = '0px';
    const bw = bubble.offsetWidth, bh = bubble.offsetHeight;
    let left = r.right + 16, top = r.top - 4;     // preferência: à direita do alvo
    if (left + bw > vw - 12) { left = Math.min(r.left, vw - bw - 12); top = r.bottom + 16; } // senão, abaixo
    left = Math.max(12, Math.min(left, vw - bw - 12));
    top = Math.max(12, Math.min(top, vh - bh - 12));
    bubble.style.left = left + 'px'; bubble.style.top = top + 'px';
    bubble.style.visibility = 'visible';
  } else {
    // sem alvo: tela escurecida e bolha ao centro
    spot.classList.add('no-target');
    spot.style.left = (vw / 2) + 'px'; spot.style.top = (vh / 2) + 'px';
    spot.style.width = '0px'; spot.style.height = '0px';
    bubble.style.visibility = 'hidden';
    const bw = bubble.offsetWidth, bh = bubble.offsetHeight;
    bubble.style.left = Math.round((vw - bw) / 2) + 'px';
    bubble.style.top = Math.round((vh - bh) / 2) + 'px';
    bubble.style.visibility = 'visible';
  }
}
function renderGuide() {
  const s = guideSteps[guideStep];
  guideEls.txt.innerHTML = s.text;
  // conta os passos só no tour completo (no mini-tour de novidade fica limpo)
  guideEls.count.textContent = guideSteps.length > 1 ? `${guideStep + 1} / ${guideSteps.length}` : '';
  const manual = s.await === 'next' || s.await === 'done';
  guideEls.nextBtn.style.display = manual ? '' : 'none';
  guideEls.nextBtn.textContent = s.label || (s.await === 'done' ? 'Concluir' : 'Próximo →');
  // "Pular tutorial" só faz sentido no tour completo
  guideEls.skip.style.display = guideSteps.length > 1 ? 'flex' : 'none';
  positionGuide();
}
function startGuide(steps, key) {
  guideSteps = steps || GUIDE_STEPS;
  guideKey = key || TUTORIAL_KEY;
  guideActive = true; guideStep = 0;
  if (!guideEls) guideEls = buildGuideEls();
  guideEls.spot.style.display = 'block';
  guideEls.bubble.style.display = 'flex';
  renderGuide();
}
function guideNext() {
  if (!guideActive) return;
  if (guideStep >= guideSteps.length - 1) { endGuide(true); return; }
  guideStep++; renderGuide();
}
// Chamada pelos pontos de criação (nota/pasta/board) para avançar o passo certo.
function guideNotify(action) {
  if (!guideActive) return;
  if (guideSteps[guideStep] && guideSteps[guideStep].await === action) {
    setTimeout(guideNext, 400); // deixa a ação renderizar antes de avançar
  }
}
function endGuide(commit) {
  guideActive = false;
  if (guideEls) {
    guideEls.spot.style.display = 'none';
    guideEls.bubble.style.display = 'none';
    guideEls.skip.style.display = 'none';
  }
  if (commit) {
    try {
      localStorage.setItem(guideKey, '1');
      // quem completa o tour inteiro já viu a cor da board: não repetir a novidade
      if (guideKey === TUTORIAL_KEY) localStorage.setItem(NEWS_KEY, '1');
    } catch {}
  }
}
document.getElementById('btn-help').addEventListener('click', () => { endGuide(false); startGuide(GUIDE_STEPS, TUTORIAL_KEY); });
window.addEventListener('resize', () => { if (guideActive) positionGuide(); });
document.addEventListener('keydown', (e) => {
  if (guideActive && e.key === 'Escape') { e.preventDefault(); endGuide(true); }
});

window.addEventListener('resize', () => {
  reflow(); sizeDrawLayer(); applyView(); hideColorPop();
  clearTimeout(reflowTimer); reflowTimer = setTimeout(save, 400);
});

// ---------- Boards (múltiplas) ----------
function normalizeBoard(b) {
  b = b || {};
  const v = b.view;
  return {
    id: b.id || uid('b'),
    name: b.name || 'Board',
    color: (b.color != null) ? b.color : null,       // índice da paleta
    customColor: b.customColor || null,               // cor personalizada (hex)
    folders: Array.isArray(b.folders) ? b.folders : [],
    notes: Array.isArray(b.notes) ? b.notes : [],
    sheets: Array.isArray(b.sheets) ? b.sheets : [],
    boardDrawing: Array.isArray(b.boardDrawing) ? b.boardDrawing : [],
    view: (v && typeof v.zoom === 'number') ? { zoom: v.zoom, panX: v.panX || 0, panY: v.panY || 0 } : { zoom: 1, panX: 0, panY: 0 },
  };
}
// Pinta o fundo da board ativa conforme a cor escolhida (ou volta ao padrão).
function applyActiveBoardColor() {
  const b = boards.find((x) => x.id === activeBoardId);
  const boardEl = document.getElementById('board');
  if (!boardEl) return;
  if (b && (b.customColor || b.color != null)) {
    boardEl.style.backgroundColor = resolveColors(b).bg;
  } else {
    boardEl.style.backgroundColor = '';
  }
}
// Aplica a cor da board a uma aba (fundo + contraste do texto).
function tabColorStyle(tab, b) {
  if (b.customColor || b.color != null) {
    const { bg, bg2, light } = resolveColors(b);
    tab.style.background = `linear-gradient(160deg, ${bg2}, ${bg})`;
    tab.style.borderColor = bg2;
    tab.style.setProperty('--tab-ink', light ? '#15171c' : 'rgba(255, 255, 255, 0.95)');
    tab.classList.add('colored');
  } else {
    tab.style.background = '';
    tab.style.borderColor = '';
    tab.style.removeProperty('--tab-ink');
    tab.classList.remove('colored');
  }
}
// Grava o estado atual (variáveis vivas) de volta no objeto da board ativa.
function syncActiveBoard() {
  syncAll();
  const b = boards.find((x) => x.id === activeBoardId);
  if (!b) return;
  b.folders = folders;
  b.notes = allNotes;
  b.sheets = allSheets;
  b.boardDrawing = boardDrawing;
  b.view = { zoom, panX, panY };
}
// Carrega uma board para as variáveis vivas e renderiza.
function loadBoard(b) {
  folders = b.folders;
  allNotes = b.notes;
  allSheets = b.sheets;
  boardDrawing = b.boardDrawing;
  // compacta z-index preservando a ordem de empilhamento
  const stack = [...allNotes, ...allSheets, ...folders].sort((a, c) => (a.z || 0) - (c.z || 0));
  zCounter = 1;
  stack.forEach((o) => { o.z = ++zCounter; });
  undoStack.length = 0;
  redoStack.length = 0;
  drawMode = false;
  document.body.classList.remove('draw-mode');
  renderAll();
  const v = b.view || { zoom: 1, panX: 0, panY: 0 };
  setView(v.zoom, v.panX, v.panY, false);
  applyActiveBoardColor();
}
function switchBoard(id) {
  if (id === activeBoardId) return;
  syncActiveBoard();
  activeBoardId = id;
  const b = boards.find((x) => x.id === id);
  if (!b) return;
  loadBoard(b);
  renderTabs();
  save();
}
function addBoard() {
  syncActiveBoard();
  const b = normalizeBoard({ name: `Board ${boards.length + 1}` });
  boards.push(b);
  activeBoardId = b.id;
  loadBoard(b);
  renderTabs();
  save();
  guideNotify('board');
}
function deleteBoard(id) {
  if (boards.length <= 1) return; // sempre ao menos uma board
  syncActiveBoard(); // garante que os dados da board ativa estão atualizados
  const b = boards.find((x) => x.id === id);
  if (!b) return;
  const nNotes = b.notes.length, nSheets = b.sheets.length;
  const aviso = (nNotes || nSheets)
    ? ` As ${nNotes} nota(s) e ${nSheets} folha(s) vão para a Lixeira (recuperáveis); pastas e desenho desta board serão descartados.`
    : '';
  if (!confirm(`Excluir a board "${b.name}"?${aviso}`)) return;
  // notas e folhas vão para a Lixeira (recuperáveis)
  b.notes.forEach((d) => { d.folderId = null; sendToTrash('note', d, null); });
  b.sheets.forEach((d) => { d.folderId = null; sendToTrash('sheet', d, null); });
  const idx = boards.findIndex((x) => x.id === id);
  boards = boards.filter((x) => x.id !== id);
  if (activeBoardId === id) {
    const next = boards[Math.max(0, idx - 1)];
    activeBoardId = next.id;
    loadBoard(next);
  }
  renderTabs();
  renderTrash(); updateTrashCount();
  save();
}
// Renomeia a board ativa via edição inline na aba.
function renameBoard(id) {
  const b = boards.find((x) => x.id === id);
  if (!b) return;
  const tabEl = document.querySelector(`.board-tab[data-id="${id}"] .board-tab-name`);
  if (!tabEl) return;
  const original = b.name;
  tabEl.setAttribute('contenteditable', 'true');
  tabEl.spellcheck = false;
  tabEl.classList.add('editing');
  focusSelectAll(tabEl);
  const finish = (commit) => {
    tabEl.removeEventListener('keydown', onKey);
    tabEl.removeEventListener('blur', onBlur);
    tabEl.removeAttribute('contenteditable');
    tabEl.classList.remove('editing');
    if (commit) { b.name = tabEl.textContent.trim() || original; tabEl.textContent = b.name; save(); }
    else tabEl.textContent = original;
  };
  const onKey = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); tabEl.blur(); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  };
  const onBlur = () => finish(true);
  tabEl.addEventListener('keydown', onKey);
  tabEl.addEventListener('blur', onBlur);
}
function renderTabs() {
  const wrap = document.getElementById('board-tabs');
  if (!wrap) return;
  wrap.innerHTML = '';
  boards.forEach((b) => {
    const tab = document.createElement('div');
    tab.className = 'board-tab' + (b.id === activeBoardId ? ' active' : '');
    tab.dataset.id = b.id;
    const name = document.createElement('span');
    name.className = 'board-tab-name';
    name.textContent = b.name;
    tab.appendChild(name);
    tabColorStyle(tab, b); // tinge a aba conforme a cor da board
    tab.addEventListener('click', () => switchBoard(b.id));
    tab.addEventListener('dblclick', (e) => { e.stopPropagation(); renameBoard(b.id); });
    if (boards.length > 1) {
      const x = document.createElement('button');
      x.className = 'board-tab-close';
      x.title = 'Excluir board';
      x.textContent = '✕';
      x.addEventListener('click', (e) => { e.stopPropagation(); deleteBoard(b.id); });
      tab.appendChild(x);
    }
    wrap.appendChild(tab);
  });
  const add = document.createElement('button');
  add.className = 'board-tab-add';
  add.title = 'Nova board';
  add.textContent = '+';
  add.addEventListener('click', addBoard);
  wrap.appendChild(add);
  // botão de cor da board ativa
  const colorBtn = document.createElement('button');
  colorBtn.className = 'board-color-btn';
  colorBtn.title = 'Cor desta board';
  colorBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16" aria-hidden="true"><circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.563-2.512 5.563-5.563C22 6.012 17.5 2 12 2z"/></svg>';
  colorBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const b = boards.find((x) => x.id === activeBoardId);
    if (!b) return;
    openColorPop({ data: b }, colorBtn, () => {
      applyActiveBoardColor();
      const activeTab = document.querySelector('.board-tab.active');
      if (activeTab) tabColorStyle(activeTab, b);
    });
  });
  wrap.appendChild(colorBtn);
}

// Id da board cuja aba está sob o ponto (x,y) na tela, ou null.
function tabAt(x, y) {
  const el = document.elementFromPoint(x, y);
  const tab = el && el.closest ? el.closest('.board-tab') : null;
  return tab ? tab.dataset.id : null;
}
// Transfere um item (nota/folha/pasta) da board ativa para outra board.
// Pasta leva junto as notas e folhas que estão dentro dela.
function moveItemToBoard(kind, dataObj, destId) {
  const dest = boards.find((b) => b.id === destId);
  if (!dest || destId === activeBoardId) return false;
  syncAll(); // garante que o texto das notas está capturado antes de mover
  if (kind === 'folder') {
    const fid = dataObj.id;
    const mvNotes = allNotes.filter((n) => n.folderId === fid);
    const mvSheets = allSheets.filter((s) => s.folderId === fid);
    allNotes = allNotes.filter((n) => n.folderId !== fid);
    allSheets = allSheets.filter((s) => s.folderId !== fid);
    folders = folders.filter((x) => x.id !== fid);
    dest.folders.push(dataObj);
    mvNotes.forEach((n) => dest.notes.push(n));
    mvSheets.forEach((s) => dest.sheets.push(s));
  } else if (kind === 'sheet') {
    allSheets = allSheets.filter((s) => s !== dataObj);
    dataObj.folderId = null;
    dest.sheets.push(dataObj);
  } else {
    allNotes = allNotes.filter((n) => n !== dataObj);
    dataObj.folderId = null;
    dest.notes.push(dataObj);
  }
  if (activeSheet && activeSheet.data === dataObj) activeSheet = null;
  renderAll();
  refreshFolderPreviews();
  updateEmptyState();
  const tab = document.querySelector(`.board-tab[data-id="${destId}"]`);
  if (tab) { tab.classList.add('flash'); setTimeout(() => tab.classList.remove('flash'), 500); }
  save();
  return true;
}

// ---------- Migração / init ----------
// Converte qualquer estado salvo (v1..v6) para { boards, activeBoardId, archived, trash }.
function migrate(saved) {
  if (Array.isArray(saved)) saved = { notes: saved };
  saved = saved || {};

  // v6 nativo: já tem boards
  if (Array.isArray(saved.boards)) {
    const bs = saved.boards.map(normalizeBoard);
    if (!bs.length) bs.push(normalizeBoard({ name: 'Board 1' }));
    const active = bs.some((b) => b.id === saved.activeBoardId) ? saved.activeBoardId : bs[0].id;
    return {
      boards: bs,
      activeBoardId: active,
      archived: Array.isArray(saved.archived) ? saved.archived : [],
      trash: Array.isArray(saved.trash) ? saved.trash : [],
    };
  }

  // v1..v5: produz uma única board
  let single;
  if (saved.version >= 4 || (Array.isArray(saved.folders) && saved.boardDrawing !== undefined)) {
    single = {
      folders: Array.isArray(saved.folders) ? saved.folders : [],
      notes: Array.isArray(saved.notes) ? saved.notes : [],
      sheets: Array.isArray(saved.sheets) ? saved.sheets : [],
      boardDrawing: Array.isArray(saved.boardDrawing) ? saved.boardDrawing : [],
      view: saved.view,
    };
  } else {
    // v1/v2/v3: a gaveta base vira a board; gavetas extras viram pastas.
    const drawers = Array.isArray(saved.drawers) ? saved.drawers : [];
    const nts = Array.isArray(saved.notes) ? saved.notes : [];
    const shs = Array.isArray(saved.sheets) ? saved.sheets : [];
    const dws = (saved.drawings && typeof saved.drawings === 'object') ? saved.drawings : {};
    let baseId = saved.activeDrawerId || (drawers[0] && drawers[0].id) || null;
    const newFolders = [];
    let px = 60, py = 60;
    drawers.forEach((d) => {
      if (d.id === baseId) return;
      newFolders.push({ id: d.id, name: d.name || 'Pasta', x: snap(px), y: snap(py), z: nextZ(), open: false, w: 480, h: 360 });
      px += FOLDER_CLOSED + 24; if (px > 600) { px = 60; py += FOLDER_CLOSED + 40; }
    });
    const folderIds = new Set(newFolders.map((f) => f.id));
    const fixId = (it) => {
      if (!it.drawerId || it.drawerId === baseId) it.folderId = null;
      else if (folderIds.has(it.drawerId)) it.folderId = it.drawerId;
      else it.folderId = null;
      delete it.drawerId;
    };
    nts.forEach(fixId);
    shs.forEach(fixId);
    single = { folders: newFolders, notes: nts, sheets: shs, boardDrawing: (baseId && Array.isArray(dws[baseId])) ? dws[baseId] : [], view: null };
  }
  const b = normalizeBoard({ name: 'Board 1', folders: single.folders, notes: single.notes, sheets: single.sheets, boardDrawing: single.boardDrawing, view: single.view });
  return {
    boards: [b],
    activeBoardId: b.id,
    archived: Array.isArray(saved.archived) ? saved.archived : [],
    trash: Array.isArray(saved.trash) ? saved.trash : [],
  };
}

// Aplica um estado carregado (load / importar / restaurar backup)
function applyState(saved) {
  const m = migrate(saved);
  boards = m.boards;
  activeBoardId = m.activeBoardId;
  archived = m.archived;
  trash = m.trash || [];

  const b = boards.find((x) => x.id === activeBoardId) || boards[0];
  activeBoardId = b.id;
  loadBoard(b); // seta folders/allNotes/allSheets/boardDrawing + z-compact + renderAll + view

  renderTabs();
  renderArchive();
  updateArchiveCount();
  renderTrash();
  updateTrashCount();
  updateEmptyState();
}

async function init() {
  applyState(await load());
  try {
    if (!localStorage.getItem(TUTORIAL_KEY)) {
      // nunca fez o tour: mostra o tutorial completo (já inclui a cor da board)
      setTimeout(() => startGuide(GUIDE_STEPS, TUTORIAL_KEY), 600);
    } else if (!localStorage.getItem(NEWS_KEY)) {
      // já fez o tour, mas ainda não viu esta novidade: mostra só ela
      setTimeout(() => startGuide(NEWS_STEPS, NEWS_KEY), 600);
    }
  } catch {}
}

init();
