import { copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineConfig } from 'electron-vite'

// Dedicated dev port + strictPort so `ELECTRON_RENDERER_URL` matches the real listener.
// When the default port is busy, Vite increments until free, but electron-vite still reads
// `config.server.port` (the requested port) — then Electron loadURL hangs on the wrong URL.
const RENDERER_DEV_PORT = 56247

export default defineConfig({
  main: {
    // Main entry is a single Vite output; local `require('./...')` helpers
    // need these files on disk in `out/main/`.
    plugins: [
      {
        name: 'copy-main-agents',
        writeBundle() {
          const outMain = join('out', 'main')
          for (const f of ['agents.js', 'eval-server.js', 'eval-trace.js', 'pet-layout.js']) {
            copyFileSync(join('src', 'main', f), join(outMain, f))
          }
        },
      },
    ],
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
        },
      },
    },
  },
})
