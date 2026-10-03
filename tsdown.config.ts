import type { UserConfig } from 'tsdown'

const PLUGIN_ID = "dsh-boot-animation"

/**
 * Modules the host page already provides.
 *
 * These are the platform seed words plus the packages the DSH client injector
 * hands to a client plugin; bundling a second copy of React or of the slot
 * registry would give the page two of each and break both. The list is exactly
 * what `src/client/**` imports at runtime - a narrower list silently inlines a
 * library, a wider one fails at require time.
 */
const CLIENT_EXTERNALS = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-runtime/client',
]

/**
 * One bundle: `lib/client.js`, in the `window.__ModuleLoader__` factory format.
 *
 * `src/shared/settings.js` is NOT external. The host half imports its own copy
 * (`lib/settings.shared.js`, copied from the same source by scripts/build.sh), and
 * the client half gets the validator inlined here. Two copies of one small file is
 * a deliberate trade: it keeps the bundle self-contained - no import that resolves
 * relative to a path the bundler guessed - while `scripts/build.sh` guarantees both
 * copies come from the same source file in the same run.
 */
const clientBundle: UserConfig = {
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: false,
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
  deps: {
    neverBundle: [...CLIENT_EXTERNALS],
    alwaysBundle: (id: string) => !CLIENT_EXTERNALS.includes(id),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    // The bundle is a package-local chunk the DSH module system evaluates: it calls
    // back into `window.__ModuleLoader__` and receives `require` for the externals.
    banner: 'window.__ModuleLoader__.load({ id: ' + JSON.stringify(PLUGIN_ID) + ', factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    codeSplitting: false,
  },
}

export default [clientBundle] satisfies UserConfig[]
