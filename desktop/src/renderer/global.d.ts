import type { TacoApi } from '../shared/ipc'

declare global {
  interface Window {
    taco: TacoApi
  }
}

export {}
