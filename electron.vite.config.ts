import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

const buildDefines = {
  __TELEMETRYDECK_APP_ID__: JSON.stringify(process.env.TELEMETRYDECK_APP_ID?.trim() ?? '')
}

export default defineConfig({
  main: {
    define: buildDefines,
    build: {
      rollupOptions: {
        external: ['better-sqlite3']
      }
    }
  },
  preload: {},
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react()]
  }
})
