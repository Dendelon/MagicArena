/// <reference types="vite/client" />

import type { MagicArenaProfileApi } from './performance/FrameProfiler.ts';

declare global {
  interface ImportMetaEnv {
    readonly VITE_E2E?: string;
    readonly VITE_PROFILE?: string;
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }

  interface Window {
    magicArenaProfile?: MagicArenaProfileApi;
  }
}

