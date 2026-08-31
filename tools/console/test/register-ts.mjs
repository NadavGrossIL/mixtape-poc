// The app's imports are extensionless (`../types`, `./overlayRun`) because Vite
// resolves them; Node wants the file. This resolve hook tries `<specifier>.ts`
// for a relative import that has no extension, so `node --test` runs a `.ts`
// test straight off the source tree with Node's own type stripping — no
// bundler, no transpile step, no test dependency.
//
//   node --import ./test/register-ts.mjs --test "src/**/*.test.ts"   (npm test)
import { registerHooks } from 'node:module'

const HAS_EXT = /\.[cm]?[jt]sx?$|\.json$/

registerHooks({
  resolve(specifier, context, next) {
    if (/^\.{1,2}\//.test(specifier) && !HAS_EXT.test(specifier)) {
      try { return next(`${specifier}.ts`, context) } catch { /* not a .ts module: fall through to the real resolution */ }
    }
    return next(specifier, context)
  },
})
