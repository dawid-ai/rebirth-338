import type { DesktopBridge } from '@reborn/studio-core'

declare global {
  interface Window {
    reborn?: DesktopBridge
  }
}

/** The desktop bridge, or null in a browser. Desktop-only features check this. */
export const desktop: DesktopBridge | null = typeof window !== 'undefined' ? (window.reborn ?? null) : null
