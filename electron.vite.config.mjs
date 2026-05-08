import { defineConfig } from 'electron-vite'

// Dedicated dev port + strictPort so `ELECTRON_RENDERER_URL` matches the real listener.
// When the default port is busy, Vite increments until free, but electron-vite still reads
// `config.server.port` (the requested port) — then Electron loadURL hangs on the wrong URL.
const RENDERER_DEV_PORT = 56247
const MAIN_ENTRIES = [
  'index',
  'agents',
  'eval-server',
  'eval-trace',
  'hermes-attachments',
  'hermes-auth',
  'hermes-gateway-client',
  'hermes-release',
  'hermes-runtime',
  'pet-assets',
  'pet-layout',
  'window-lifecycle',
]

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: Object.fromEntries(MAIN_ENTRIES.map((name) => [name, `src/main/${name}.ts`])),
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
})
