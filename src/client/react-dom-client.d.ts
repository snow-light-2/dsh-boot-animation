/**
 * Minimal types for `react-dom/client`.
 *
 * WHY THIS FILE EXISTS
 *
 * The client bundle externalises react and react-dom (`tsdown.config.ts`), so the
 * DSH shell's module loader supplies them at runtime - the bundle really does
 * `require('react-dom/client')`. But `@types/react-dom` is not a dependency of
 * this plugin, so `tsc --noEmit` cannot resolve the module and the build gate
 * fails. Only one API is used (createRoot/unmount), so it is declared here.
 *
 * If `@types/react-dom` is ever added to devDependencies, delete this file.
 */
declare module 'react-dom/client' {
  import type { ReactElement } from 'react'

  export interface Root {
    render: (children: ReactElement) => void
    unmount: () => void
  }

  export function createRoot(container: Element | DocumentFragment): Root
}
