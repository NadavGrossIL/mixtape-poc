import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { consolePlugin } from './src/plugin'

// This is a second Vite root. The product build (client/) and the Railway
// deploy never reach this directory; it exists only for `npm run dev` here.
const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')

export default defineConfig({
  plugins: [react(), consolePlugin({ repoRoot, fixturesDir: path.join(here, 'fixtures') })],
  server: { host: '127.0.0.1', port: 5174, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true },
})
