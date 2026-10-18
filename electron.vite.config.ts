import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          // Isolated child-process entry for exportLibrary.db access - see
          // sqlCipherRecovery.ts and the plan's note on the native crash
          // this works around. Must stay a genuinely separate process
          // entry point, not bundled into index.js.
          'workers/extractOneLibrary': resolve(__dirname, 'src/main/workers/extractOneLibrary.ts'),
          // worker_threads entry for export.pdb parsing - see checkHealth.ts.
          // No native module involved here, so a thread (not a whole
          // process) is enough to keep this off the main process's event
          // loop, which the Rekordbox-running poll also runs on.
          'workers/checkPdbHealth': resolve(__dirname, 'src/main/workers/checkPdbHealth.ts'),
          // Isolated child-process entry for writing exportLibrary.db - see
          // buildOneLibrary.ts. Same native-crash rationale as
          // extractOneLibrary.ts, for the write direction.
          'workers/buildOneLibrary': resolve(__dirname, 'src/main/workers/buildOneLibrary.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts')
        }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/renderer/index.html')
      }
    },
    plugins: [react()]
  }
})
