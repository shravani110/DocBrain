/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_APP_MODE?: string;
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_FIREBASE_API_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
