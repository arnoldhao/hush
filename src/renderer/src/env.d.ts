/// <reference types="vite/client" />

import type * as React from 'react'

declare global {
  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<
        React.HTMLAttributes<Electron.WebviewTag>,
        Electron.WebviewTag
      > & {
        allowpopups?: string
        httpreferrer?: string
        partition?: string
        src?: string
        useragent?: string
        webpreferences?: string
      }
    }
  }
}
