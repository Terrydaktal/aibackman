const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  debugEnabled: process.argv.includes('--chatgpt-debug=1'),
  // We will add IPC handlers here
  sendMessage: (channel, data) => ipcRenderer.send(channel, data),
  onMessage: (channel, func) => ipcRenderer.on(channel, (event, ...args) => func(...args)),
  onCacheProgress: (func) => {
    const handler = (_event, ...args) => func(...args);
    ipcRenderer.on('api:cacheProgress', handler);
    return () => ipcRenderer.removeListener('api:cacheProgress', handler);
  },
  onBridgeComposerStatus: (func) => {
    const handler = (_event, ...args) => func(...args);
    ipcRenderer.on('api:bridgeComposerStatus', handler);
    return () => ipcRenderer.removeListener('api:bridgeComposerStatus', handler);
  },
  onArchiveChanged: (func) => {
    const handler = (_event, ...args) => func(...args);
    ipcRenderer.on('archive:accountsChanged', handler);
    return () => ipcRenderer.removeListener('archive:accountsChanged', handler);
  },
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
});
