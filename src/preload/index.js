const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agentUI', {
  getAppPath: () => ipcRenderer.invoke('get-app-path'),
  getFrontmostWindowBounds: () => ipcRenderer.invoke('get-frontmost-window-bounds'),
  getFrontmostWindowInfo: () => ipcRenderer.invoke('get-frontmost-window-info'),
  readTextFile: (relPath) => ipcRenderer.invoke('read-text-file', relPath),
  getAssetFileUrl: (relPath) => ipcRenderer.invoke('get-asset-file-url', relPath),
  chooseFolder: () => ipcRenderer.invoke('choose-folder'),
  getRecentFolders: () => ipcRenderer.invoke('get-recent-folders'),
  addRecentFolder: (folder) => ipcRenderer.invoke('add-recent-folder', folder),
  startVoiceDictation: () => ipcRenderer.invoke('start-voice-dictation'),
  traceEvalEvent: (payload) => ipcRenderer.send('eval-trace-event', payload),
  submitNewCat: (payload) => ipcRenderer.send('new-cat-submit', payload),
  cancelNewCat: () => ipcRenderer.send('new-cat-cancel'),
  resizeModal: (height) => ipcRenderer.send('resize-modal', { height }),
  overlayReady: () => ipcRenderer.send('overlay-ready'),
  onSpawnCat: (callback) => {
    const listener = (_event, payload) => {
      try {
        callback(payload);
      } catch {
        // ignore
      }
    };
    ipcRenderer.on('spawn-cat', listener);
    return () => ipcRenderer.removeListener('spawn-cat', listener);
  },
  onAgentFinished: (callback) => {
    const listener = (_event, payload) => {
      try {
        callback(payload);
      } catch {
        // ignore
      }
    };
    ipcRenderer.on('agent-finished', listener);
    return () => ipcRenderer.removeListener('agent-finished', listener);
  },
  onAgentStreamBubble: (callback) => {
    const listener = (_event, payload) => {
      try {
        callback(payload);
      } catch {
        // ignore
      }
    };
    ipcRenderer.on('agent-stream-bubble', listener);
    return () => ipcRenderer.removeListener('agent-stream-bubble', listener);
  },
  postCatScreenRects: (rects) => {
    ipcRenderer.send('cat-screen-rects', rects);
  },
  openCatConversation: (catId) => {
    ipcRenderer.send('open-cat-conversation', { catId });
  },
  getAgentConversation: (catId) => ipcRenderer.invoke('get-agent-conversation', catId),
  revertCat: (catId) => ipcRenderer.invoke('revert-cat-changes', { catId }),
  openExternalUrl: (url) => ipcRenderer.invoke('open-external-url', url),
  onConversationUpdated: (callback) => {
    const listener = (_event, payload) => {
      try {
        callback(payload);
      } catch {
        // ignore
      }
    };
    ipcRenderer.on('conversation-updated', listener);
    return () => ipcRenderer.removeListener('conversation-updated', listener);
  },
  closeConversationWindow: () => {
    ipcRenderer.send('close-conversation-window');
  },
  dismissCat: (catId) => {
    ipcRenderer.send('dismiss-cat', { catId });
  },
  sendFollowup: (catId, text) => {
    ipcRenderer.send('agent-followup', { catId, text });
  },
  onAgentRestarted: (callback) => {
    const listener = (_event, payload) => {
      try {
        callback(payload);
      } catch {
        // ignore
      }
    };
    ipcRenderer.on('agent-restarted', listener);
    return () => ipcRenderer.removeListener('agent-restarted', listener);
  },
  onRemoveCat: (callback) => {
    const listener = (_event, payload) => {
      try {
        callback(payload);
      } catch {
        // ignore
      }
    };
    ipcRenderer.on('remove-cat', listener);
    return () => ipcRenderer.removeListener('remove-cat', listener);
  },
  reportCatCounts: (counts) => {
    ipcRenderer.send('cat-counts', counts);
  },
  onClearFinishedCats: (callback) => {
    const listener = () => {
      try {
        callback();
      } catch {
        // ignore
      }
    };
    ipcRenderer.on('clear-finished-cats', listener);
    return () => ipcRenderer.removeListener('clear-finished-cats', listener);
  },
});
