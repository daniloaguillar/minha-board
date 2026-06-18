// ===== Minha Board — processo principal (Electron) =====
// Cria a janela do app e cuida de ler/gravar as notas em arquivo local,
// com backups automáticos rotativos, export/import e cópia espelhada
// opcional para uma pasta de nuvem (Google Drive / OneDrive / Dropbox).

const { app, BrowserWindow, ipcMain, shell, dialog, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');

// Auto-atualização (só existe na versão instalada pelo instalador; em dev fica inativo)
let autoUpdater = null;
try { ({ autoUpdater } = require('electron-updater')); } catch {}

function notesDir() { return path.join(app.getPath('documents'), 'Minha Board'); }
function notesFile() { return path.join(notesDir(), 'notes.json'); }
function backupsDir() { return path.join(notesDir(), 'backups'); }
function configFile() { return path.join(notesDir(), 'config.json'); }

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function readConfig() {
  try { const r = fs.readFileSync(configFile(), 'utf-8'); return r ? JSON.parse(r) : {}; }
  catch { return {}; }
}
function writeConfig(c) {
  try { ensureDir(notesDir()); fs.writeFileSync(configFile(), JSON.stringify(c, null, 2), 'utf-8'); }
  catch (e) { console.error('Falha ao salvar config:', e); }
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// Backups automáticos: 1 por sessão e no máx. a cada 10 min; mantém os últimos 40.
let lastBackup = 0;
function maybeBackup(content) {
  try {
    const now = Date.now();
    if (lastBackup && now - lastBackup < 10 * 60 * 1000) return;
    lastBackup = now;
    ensureDir(backupsDir());
    fs.writeFileSync(path.join(backupsDir(), `notes-${stamp()}.json`), content, 'utf-8');
    const files = fs.readdirSync(backupsDir())
      .filter((f) => f.startsWith('notes-') && f.endsWith('.json')).sort();
    for (let i = 0; i < files.length - 40; i++) {
      try { fs.unlinkSync(path.join(backupsDir(), files[i])); } catch {}
    }
  } catch (e) { console.error('Falha no backup:', e); }
}

// Cópia espelhada para a pasta escolhida (ex.: dentro do Google Drive/OneDrive)
function mirrorCopy(content) {
  try {
    const c = readConfig();
    if (c.mirrorDir && fs.existsSync(c.mirrorDir)) {
      const dst = path.join(c.mirrorDir, 'minha-board-notes.json');
      const tmp = dst + '.tmp';
      fs.writeFileSync(tmp, content, 'utf-8');
      fs.renameSync(tmp, dst);
    }
  } catch (e) { console.error('Falha na cópia espelhada:', e); }
}

// ---- Comunicação com a interface (renderer) ----
ipcMain.handle('notes:load', () => {
  try {
    const file = notesFile();
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, 'utf-8');
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    console.error('Falha ao ler notas:', err);
    return null;
  }
});

ipcMain.handle('notes:save', (_event, data) => {
  try {
    ensureDir(notesDir());
    const content = JSON.stringify(data, null, 2);
    const file = notesFile();
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, content, 'utf-8'); // escrita atômica
    fs.renameSync(tmp, file);
    maybeBackup(content);
    mirrorCopy(content);
    return true;
  } catch (err) {
    console.error('Falha ao salvar notas:', err);
    return false;
  }
});

ipcMain.handle('notes:reveal', () => {
  try { ensureDir(notesDir()); shell.openPath(notesDir()); return true; } catch { return false; }
});
ipcMain.handle('notes:revealBackups', () => {
  try { ensureDir(backupsDir()); shell.openPath(backupsDir()); return true; } catch { return false; }
});
ipcMain.handle('notes:path', () => notesFile());

// Exportar para um arquivo escolhido pelo usuário
ipcMain.handle('notes:export', async (_event, data) => {
  try {
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Exportar notas',
      defaultPath: `minha-board-${stamp()}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (canceled || !filePath) return false;
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    return true;
  } catch (e) { console.error('Falha ao exportar:', e); return false; }
});

// Importar de um arquivo escolhido pelo usuário
ipcMain.handle('notes:import', async () => {
  try {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: 'Importar notas',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (canceled || !filePaths[0]) return null;
    const raw = fs.readFileSync(filePaths[0], 'utf-8');
    return JSON.parse(raw);
  } catch (e) { console.error('Falha ao importar:', e); return null; }
});

ipcMain.handle('notes:listBackups', () => {
  try {
    ensureDir(backupsDir());
    return fs.readdirSync(backupsDir())
      .filter((f) => f.endsWith('.json'))
      .map((f) => ({ name: f, time: fs.statSync(path.join(backupsDir(), f)).mtimeMs }))
      .sort((a, b) => b.time - a.time);
  } catch { return []; }
});
ipcMain.handle('notes:readBackup', (_event, name) => {
  try {
    const p = path.join(backupsDir(), path.basename(String(name)));
    const raw = fs.readFileSync(p, 'utf-8');
    return JSON.parse(raw);
  } catch { return null; }
});

ipcMain.handle('notes:getMirror', () => readConfig().mirrorDir || null);
ipcMain.handle('notes:setMirror', async () => {
  try {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: 'Escolher pasta de cópia automática (ex.: Google Drive, OneDrive, Dropbox)',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (canceled || !filePaths[0]) return readConfig().mirrorDir || null;
    const c = readConfig();
    c.mirrorDir = filePaths[0];
    writeConfig(c);
    // grava uma cópia imediatamente
    try {
      const file = notesFile();
      if (fs.existsSync(file)) mirrorCopy(fs.readFileSync(file, 'utf-8'));
    } catch {}
    return c.mirrorDir;
  } catch (e) { console.error(e); return readConfig().mirrorDir || null; }
});
ipcMain.handle('notes:clearMirror', () => {
  const c = readConfig(); delete c.mirrorDir; writeConfig(c); return true;
});

// Tema escolhido nas configurações ('light' | 'dark' | 'system') — usado
// para abrir a janela já com a cor de fundo certa na próxima vez.
ipcMain.handle('config:setTheme', (_event, theme) => {
  const t = String(theme);
  if (!['light', 'dark', 'system'].includes(t)) return false;
  const c = readConfig(); c.theme = t; writeConfig(c);
  return true;
});

function windowBackground() {
  const t = readConfig().theme || 'dark';
  const dark = t === 'system' ? nativeTheme.shouldUseDarkColors : t !== 'light';
  return dark ? '#1f2024' : '#f3f4f6';
}

// ---- Auto-atualização (electron-updater + GitHub Releases) ----
ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('update:check', async () => {
  if (!autoUpdater || !app.isPackaged) return { ok: false, reason: 'dev' };
  try { await autoUpdater.checkForUpdates(); return { ok: true }; }
  catch (e) { return { ok: false, reason: String((e && e.message) || e) }; }
});
ipcMain.handle('update:install', () => { if (autoUpdater) autoUpdater.quitAndInstall(); });

function setupAutoUpdate() {
  if (!autoUpdater || !app.isPackaged) return;
  autoUpdater.autoDownload = true;          // baixa a nova versão em segundo plano
  autoUpdater.autoInstallOnAppQuit = true;  // aplica ao fechar, se o usuário não reiniciar antes
  const send = (ch, data) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(ch, data); };
  autoUpdater.on('update-available', (i) => send('update:available', { version: i.version }));
  autoUpdater.on('update-not-available', () => send('update:none', {}));
  autoUpdater.on('error', (e) => send('update:error', { message: String((e && e.message) || e) }));
  autoUpdater.on('download-progress', (p) => send('update:progress', { percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (i) => send('update:downloaded', { version: i.version }));
  // só checa quando a janela terminou de carregar (garante que o renderer já
  // registrou os ouvintes de evento), com um pequeno respiro para a rede.
  const startCheck = () => setTimeout(() => { autoUpdater.checkForUpdates().catch(() => {}); }, 1500);
  if (mainWindow && mainWindow.webContents) {
    if (mainWindow.webContents.isLoading()) mainWindow.webContents.once('did-finish-load', startCheck);
    else startCheck();
  }
}

// ---- Janela ----
let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 520,
    show: false, // só mostra depois de maximizar (evita "pulo" visual)
    backgroundColor: windowBackground(),
    title: 'Minha Board',
    icon: path.join(__dirname, 'build', 'icon.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile('index.html');

  // Abre sempre maximizado
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.maximize();
  });

  mainWindow.webContents.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') {
      mainWindow.webContents.toggleDevTools();
    }
  });

  mainWindow.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.log('[app]', message);
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
  app.whenReady().then(() => {
    createWindow();
    setupAutoUpdate();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
