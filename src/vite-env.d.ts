/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_FIGMA_CAPTURE_ID?: string;
  readonly VITE_FIGMA_CAPTURE_ENDPOINT?: string;
  readonly VITE_FIGMA_CAPTURE_SELECTOR?: string;
  readonly VITE_FIGMA_CAPTURE_SCRIPT_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
