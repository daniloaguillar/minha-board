// ===== Minha Board — preload =====
// Expõe uma API segura para a interface salvar/ler notas e fazer backup.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('boardAPI', {
  load: () => ipcRenderer.invoke('notes:load'),
  save: (data) => ipcRenderer.invoke('notes:save', data),
  reveal: () => ipcRenderer.invoke('notes:reveal'),
  revealBackups: () => ipcRenderer.invoke('notes:revealBackups'),
  path: () => ipcRenderer.invoke('notes:path'),
  exportData: (data) => ipcRenderer.invoke('notes:export', data),
  importData: () => ipcRenderer.invoke('notes:import'),
  listBackups: () => ipcRenderer.invoke('notes:listBackups'),
  readBackup: (name) => ipcRenderer.invoke('notes:readBackup', name),
  getMirror: () => ipcRenderer.invoke('notes:getMirror'),
  setMirror: () => ipcRenderer.invoke('notes:setMirror'),
  clearMirror: () => ipcRenderer.invoke('notes:clearMirror'),
  setTheme: (theme) => ipcRenderer.invoke('config:setTheme', theme),
  // Atualizações
  getVersion: () => ipcRenderer.invoke('app:version'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdate: (cb) => {
    ['update:available', 'update:none', 'update:error', 'update:progress', 'update:downloaded']
      .forEach((ch) => ipcRenderer.on(ch, (_e, data) => cb(ch, data)));
  },
});
