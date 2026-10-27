import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

// One config builds all three Electron layers: main (Node), preload (bridge), renderer (React).
// React, wouter and fonts are devDependencies so Vite bundles them and node_modules stays out of the installer.
export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    plugins: [react()],
  }
})
