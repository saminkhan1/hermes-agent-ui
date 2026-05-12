import { defineConfig } from 'electron-vite';

// Dedicated dev port + strictPort so `ELECTRON_RENDERER_URL` matches the real listener.
// When the default port is busy, Vite increments until free, but electron-vite still reads
// `config.server.port` (the requested port) — then Electron loadURL hangs on the wrong URL.
const RENDERER_DEV_PORT = 56247;
const MAIN_ENTRIES = {
  index: 'src/main/index.ts',
  agents: 'src/main/agents.ts',
  'eval-server': 'src/main/eval-server.ts',
  'eval-trace': 'src/main/eval-trace.ts',
  'hermes-attachments': 'src/main/hermes-attachments.ts',
  'hermes-auth': 'src/main/hermes-auth.ts',
  'hermes-gateway-client': 'src/main/hermes-gateway-client.ts',
  'hermes-release': 'src/main/hermes-release.ts',
  'hermes-runtime': 'src/main/hermes-runtime.ts',
  'pet-assets': 'src/main/pet-assets.ts',
  'pet-layout': 'src/main/pet-layout.ts',
  'reliability-schema': 'src/main/reliability-schema.js',
  'reliability-telemetry': 'src/main/reliability-telemetry.ts',
  'window-lifecycle': 'src/main/window-lifecycle.ts',
};

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: MAIN_ENTRIES,
      },
    },
  },
  preload: {},
  renderer: {
    server: {
      port: RENDERER_DEV_PORT,
      strictPort: true,
    },
    build: {
      rollupOptions: {
        input: {
          index: 'src/renderer/index.html',
          modal: 'src/renderer/modal.html',
          conversation: 'src/renderer/conversation.html',
          auth: 'src/renderer/auth.html',
        },
      },
    },
  },
});
