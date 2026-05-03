const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agentUI', {
  startVoiceDictation: () => ipcRenderer.invoke('start-voice-dictation'),
  traceEvalEvent: (payload) => ipcRenderer.send('eval-trace-event', payload),
  reportEvalUiState: (surface, payload) => ipcRenderer.send('eval-ui-state', { surface, payload }),
  submitNewCat: (payload) => ipcRenderer.send('new-cat-submit', payload),
  cancelNewCat: () => ipcRenderer.send('new-cat-cancel'),
  overlayReady: () => ipcRenderer.send('overlay-ready'),
  togglePetOverlay: () => ipcRenderer.send('pet-overlay-toggle'),
  getPetCharacters: () => ipcRenderer.invoke('get-pet-characters'),
  refreshPetCharacters: () => ipcRenderer.send('pet-characters-refresh'),
  showPetContextMenu: () => ipcRenderer.send('pet-context-menu'),
  startPetDrag: (payload) => ipcRenderer.send('pet-drag-start', payload),
  movePetDrag: () => ipcRenderer.send('pet-drag-move'),
  endPetDrag: () => ipcRenderer.send('pet-drag-end'),
  releasePetDrag: (payload) => ipcRenderer.send('pet-drag-release', payload),
  reportPetElementSize: (payload) => ipcRenderer.send('pet-element-size-changed', payload),
  setPetPointerInteraction: (active) => ipcRenderer.send('pet-pointer-interaction-changed', { active: !!active }),
  onPetLayoutChanged: (callback) => {
    const listener = (_event, payload) => {
      try {
        callback(payload);
      } catch {
        // ignore
      }
    };
    ipcRenderer.on('pet-layout-changed', listener);
    return () => ipcRenderer.removeListener('pet-layout-changed', listener);
  },
  onPetCharacterChanged: (callback) => {
    const listener = (_event, payload) => {
      try {
        callback(payload);
      } catch {
        // ignore
      }
    };
    ipcRenderer.on('pet-character-changed', listener);
    return () => ipcRenderer.removeListener('pet-character-changed', listener);
  },
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
  openCatConversation: (catId) => {
    ipcRenderer.send('open-cat-conversation', { catId });
  },
  getAgentConversation: (catId) => ipcRenderer.invoke('get-agent-conversation', catId),
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
    return ipcRenderer.invoke('agent-followup', { catId, text });
  },
  cancelAgent: (catId) => {
    return ipcRenderer.invoke('agent-cancel', { catId });
  },
  sendBackgroundWork: (catId, text) => {
    return ipcRenderer.invoke('agent-background', { catId, text });
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
});
