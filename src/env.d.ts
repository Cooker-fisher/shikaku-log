/// <reference types="astro/client" />

interface ImportMetaEnv {
  /** 本番URL。ビルド時に Cloudflare Pages の環境変数から渡す */
  readonly SITE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
