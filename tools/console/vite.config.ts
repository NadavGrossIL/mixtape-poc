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
  // `host` is a security control, not a convenience — do not widen it. The API
  // this plugin serves reads ~/.claude: every agent transcript on this machine,
  // prompts and results verbatim, and absolute paths carrying the username. It
  // has no authentication of any kind, and the loopback bind is the ONLY thing
  // keeping it off the local network. `0.0.0.0` (or `--host`) publishes all of
  // it to anyone on the same wifi. See the warning in README.md. `strictPort`
  // matters too: the write's Origin check in src/writeGuard.ts names port 5174,
  // so a silent fallback port would break Save rather than fail loudly here.
  server: { host: '127.0.0.1', port: 5174, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true },
})
