#!/usr/bin/env node
/**
 * 公開前の自動QA。`npm run qa` で実行する。
 *
 * ビルド後の dist/ とリポジトリのソースを検査し、
 * **ERROR が1件でもあれば exit code 1** で落とす(掟 4:通らないものはデプロイしない)。
 * WARN は落とさないが必ず出力する。
 *
 * 検査:
 *   1. secrets  秘匿情報(ASP ID・APIキー・トークン)の混入
 *   2. seo      title/description の重複、h1の数、canonical、lang
 *   3. legal    PR表記(ステマ規制)、投稿データの「自己申告」注記
 *   4. links    内部リンク切れ、孤立ページ、target=_blank の rel
 *   5. thin     本文が極端に薄いページ(scaled content abuse 対策)
 *   6. phrases  禁止表現(誇大表現・AI定型文)
 *
 * オプション:
 *   --strict-dist  dist/ が無い場合も ERROR にする(CIで使う)
 *   --quiet        PASS の行を出さない
 */

import { readFileSync, existsSync, statSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, relative, resolve, dirname, extname, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'node-html-parser';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DIST = join(ROOT, 'dist');

const argv = new Set(process.argv.slice(2));
const STRICT_DIST = argv.has('--strict-dist');
const QUIET = argv.has('--quiet');

// ---------------------------------------------------------------------------
// 設定
// ---------------------------------------------------------------------------

/** ソース走査の対象(秘匿情報スキャン) */
const SOURCE_DIRS = ['src', 'functions', 'scripts', 'migrations', 'data', 'public'];
const SOURCE_FILES = ['astro.config.mjs', 'package.json', 'wrangler.toml', 'tsconfig.json'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.astro', '.wrangler', '.git', '.mf']);
/** このファイル自身はパターン定義を含むので秘匿情報スキャンから除く */
const SELF = join(ROOT, 'scripts', 'qa.mjs');

/** アフィリエイトとして扱うドメイン(src/config.ts の AFFILIATE_DOMAINS と揃える) */
const AFFILIATE_HOSTS = [
  'px.a8.net',
  'a8.net',
  'af.moshimo.com',
  'ck.jp.ap.valuecommerce.com',
  'h.accesstrade.net',
  'amzn.to',
  'amazon.co.jp',
  'hb.afl.rakuten.co.jp',
  'link-a.net',
  't.afi-b.com',
];

/** PR表記として認める文字列 */
const PR_MARKERS = [/(^|[^A-Za-z])PR([^A-Za-z]|$)/, /広告/, /プロモーション/, /アフィリエイト/];

/** 投稿データを扱っているページの判定 */
const UGC_SIGNALS = [/合格報告/, /投稿データ/, /勉強時間の(分布|中央値)/, /教材(ランキング|の使用件数)/];

/**
 * ポリシー系ページ。投稿データを「表示」せず「扱い方を説明」するため、
 * 本文のUGC検出から除外する(構造マーカーによる判定は引き続き効く)。
 */
const POLICY_ROUTES = new Set(['/privacy/', '/contact/', '/about/']);

/**
 * 検査から除外するパス。
 * 所有権確認ファイル(Search Console等)は中身が1行と決まっており、
 * 薄いページ・SEO・孤立ページの検査対象にすると必ず落ちる。
 * これらは我々が書いたページではなく、外部サービスが指定した形式のファイル。
 */
const EXCLUDED_ROUTE_PATTERNS = [
  /^\/google[0-9a-f]{16}\.html$/, // Google Search Console の所有権確認
  /^\/BingSiteAuth\.xml$/,
];

function isExcludedRoute(route) {
  return EXCLUDED_ROUTE_PATTERNS.some((re) => re.test(route));
}

/** 本文の下限。これ未満は scaled content abuse として扱う */
const THIN_ERROR_CHARS = 250;
const THIN_WARN_CHARS = 600;

/**
 * 禁止表現。掟 3-6(AI定型文)/ 3-7(誇大表現)。
 * 「絶対」は「絶対評価」「絶対値」など試験用語では正当に使うので除外する。
 */
const BANNED_PHRASES = [
  { re: /必ず合格/, why: '誇大表現' },
  { re: /確実に合格/, why: '誇大表現' },
  { re: /100\s*%\s*合格/, why: '誇大表現' },
  { re: /誰でも(合格|受か|できま|取れ)/, why: '誇大表現' },
  { re: /簡単に(合格|受か|取れ)/, why: '誇大表現' },
  { re: /絶対(?!評価|値|音感)/, why: '誇大表現(掟 3-7)' },
  { re: /いかがでした/, why: 'AI定型文' },
  { re: /いかがでしょうか/, why: 'AI定型文' },
  { re: /ではないでしょうか/, why: 'AI定型文' },
  { re: /まとめると/, why: 'AI定型文' },
  { re: /最後まで(お)?読んで/, why: 'AI定型文' },
];

/**
 * 秘匿情報のパターン。
 * このリポジトリは公開される前提なので、疑わしいものは全て ERROR にする。
 * 誤検知した場合は該当行に `qa-allow-secret` と書けば除外できる。
 */
const SECRET_PATTERNS = [
  { name: 'AWSアクセスキー', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Google APIキー', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'GitHubトークン', re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  { name: 'Slackトークン', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'Stripeキー', re: /\b[sr]k_live_[A-Za-z0-9]{16,}\b/ },
  { name: 'OpenAI/Anthropicキー', re: /\bsk-(ant-)?[A-Za-z0-9_-]{24,}\b/ },
  { name: '秘密鍵', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'JWT', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\./ },
  { name: 'Cloudflare APIトークン', re: /\bCLOUDFLARE_API_TOKEN\s*[:=]\s*["'][^"']{16,}["']/ },
  // 汎用: キーらしき名前 = 長いリテラル
  {
    name: 'ハードコードされた鍵/トークン',
    re: /\b(api[_-]?key|secret|token|password|passwd|access[_-]?key|private[_-]?key|salt)\b\s*[:=]\s*["'][^"'\s]{16,}["']/i,
  },
  // 🔴 アフィリエイトの計測ID(a8mat / a_id / Amazonタグ 等)は**秘匿情報ではない**。
  //
  // 当初はこれらをERRORで止めていた。しかしアフィリエイトリンクは
  // **公開HTMLに出力されなければ機能しない**(誰でもソースを見れば読める)。
  // 秘匿扱いにすると、収益化した瞬間にデプロイが永久に止まる。
  // 2026-07-26、最初の提携が承認されてリンクを設定する直前に気づいた。
  //
  // 漏れて困るのはA8のログイン情報やAPIトークンであって、計測IDではない。
  // 計測IDを他人が使っても、成果はこちらに計上されるだけで損害にならない。
  //
  // 代わりに「アフィリエイトリンクにPR表記と rel が付いているか」を法務チェックで見る。
  // 守るべきはIDの秘匿ではなく、**広告であることの明示**(ステマ規制)である。
  //
  // D1 の database_id も意図的に検査対象から外している。
  // 認証情報ではなくリソース識別子であり、単体では何も操作できない(操作には
  // アカウント認証が必要)。Cloudflare公式もコミットを前提としており、
  // 隠すとリポジトリからデプロイを再現できなくなる。
];

/** 秘匿値を持ちうるのに .gitignore に無いと事故るファイル */
const SECRET_FILES = ['.env', '.dev.vars', '.env.local', '.env.production'];

// ---------------------------------------------------------------------------
// 出力
// ---------------------------------------------------------------------------

const useColor = process.env.NO_COLOR === undefined && process.stdout.isTTY !== false;
const c = (code, s) => (useColor ? `\u001b[${code}m${s}\u001b[0m` : s);
const red = (s) => c('31', s);
const yellow = (s) => c('33', s);
const green = (s) => c('32', s);
const gray = (s) => c('90', s);
const bold = (s) => c('1', s);

/** @type {{check:string, severity:'error'|'warn', where:string, message:string}[]} */
const findings = [];
const checkStats = new Map();

function note(check, severity, where, message) {
  findings.push({ check, severity, where, message });
}
const error = (check, where, message) => note(check, 'error', where, message);
const warn = (check, where, message) => note(check, 'warn', where, message);

function finishCheck(check, label, examined) {
  checkStats.set(check, { label, examined });
}

// ---------------------------------------------------------------------------
// ファイル収集
// ---------------------------------------------------------------------------

async function walk(dir, out = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else out.push(full);
  }
  return out;
}

const TEXT_EXT = new Set([
  '.ts', '.tsx', '.js', '.mjs', '.cjs', '.astro', '.json', '.jsonc', '.md', '.mdx',
  '.css', '.html', '.sql', '.toml', '.yml', '.yaml', '.txt', '.svg', '.xml',
]);

function isTextFile(file) {
  if (TEXT_EXT.has(extname(file))) return true;
  return false;
}

// ---------------------------------------------------------------------------
// 1. 秘匿情報
// ---------------------------------------------------------------------------

async function checkSecrets() {
  const targets = [];
  for (const dir of SOURCE_DIRS) targets.push(...(await walk(join(ROOT, dir))));
  for (const f of SOURCE_FILES) {
    const p = join(ROOT, f);
    if (existsSync(p)) targets.push(p);
  }
  if (existsSync(DIST)) targets.push(...(await walk(DIST)));

  let examined = 0;
  for (const file of targets) {
    if (file === SELF) continue;
    if (!isTextFile(file)) continue;
    let content;
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    examined++;
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.includes('qa-allow-secret')) continue;
      for (const pattern of SECRET_PATTERNS) {
        if (pattern.re.test(line)) {
          error(
            'secrets',
            `${relative(ROOT, file)}:${i + 1}`,
            `${pattern.name} らしき文字列を検出。環境変数に移すこと`,
          );
        }
      }
    }
  }

  // .env 等が存在するのに .gitignore に無い
  const gitignorePath = join(ROOT, '.gitignore');
  const gitignore = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : '';
  const ignoreRules = gitignore
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));

  /** name が .gitignore のいずれかの行(末尾 * のワイルドカードのみ対応)に一致するか */
  const isIgnored = (name) =>
    ignoreRules.some((rule) => {
      const r = rule.replace(/^\//, '');
      if (r.endsWith('*')) return name.startsWith(r.slice(0, -1));
      return r === name;
    });

  for (const name of SECRET_FILES) {
    if (!existsSync(join(ROOT, name))) continue;
    if (!isIgnored(name)) {
      error('secrets', name, '秘匿値を持つファイルが .gitignore に含まれていない');
    }
  }

  finishCheck('secrets', '秘匿情報の混入', examined);
}

// ---------------------------------------------------------------------------
// ページ読み込み
// ---------------------------------------------------------------------------

/**
 * @typedef {{file:string, route:string, html:string, doc:any, mainText:string, headText:string}} Page
 */

function routeOf(file) {
  const rel = relative(DIST, file).split('\\').join('/');
  if (rel === 'index.html') return '/';
  if (rel.endsWith('/index.html')) return '/' + rel.slice(0, -'index.html'.length);
  return '/' + rel;
}

function extractText(html) {
  const doc = parse(html, { blockTextElements: { script: false, style: false } });
  for (const sel of ['script', 'style', 'nav', 'header', 'footer', 'noscript']) {
    for (const el of doc.querySelectorAll(sel)) el.remove();
  }
  const main = doc.querySelector('main') ?? doc.querySelector('body') ?? doc;
  return main.text.replace(/\s+/g, ' ').trim();
}

async function loadPages() {
  if (!existsSync(DIST)) return null;
  const files = (await walk(DIST))
    .filter((f) => f.endsWith('.html'))
    // 所有権確認ファイルなど、我々が書いたページでないものは全検査から除く
    .filter((f) => !isExcludedRoute(routeOf(f)));
  return files.map((file) => {
    const html = readFileSync(file, 'utf8');
    const doc = parse(html);
    const head = doc.querySelector('head');
    return {
      file,
      route: routeOf(file),
      html,
      doc,
      mainText: extractText(html),
      headText: head ? head.toString() : '',
    };
  });
}

// ---------------------------------------------------------------------------
// 2. SEO
// ---------------------------------------------------------------------------

function checkSeo(pages) {
  const titles = new Map();
  const descriptions = new Map();

  for (const page of pages) {
    const where = page.route;
    const titleEl = page.doc.querySelector('title');
    const title = titleEl ? titleEl.text.trim() : '';
    if (!title) {
      error('seo', where, '<title> が無い、または空');
    } else {
      if (title.length < 10) warn('seo', where, `title が短い(${title.length}文字)`);
      if (title.length > 70) warn('seo', where, `title が長い(${title.length}文字、検索結果で切れる)`);
      const list = titles.get(title) ?? [];
      list.push(where);
      titles.set(title, list);
    }

    const descEl = page.doc.querySelector('meta[name="description"]');
    const desc = descEl ? (descEl.getAttribute('content') ?? '').trim() : '';
    if (!desc) {
      error('seo', where, 'meta description が無い、または空');
    } else {
      if (desc.length < 50) warn('seo', where, `description が短い(${desc.length}文字)`);
      if (desc.length > 160) warn('seo', where, `description が長い(${desc.length}文字)`);
      const list = descriptions.get(desc) ?? [];
      list.push(where);
      descriptions.set(desc, list);
    }

    const h1s = page.doc.querySelectorAll('h1');
    if (h1s.length === 0) error('seo', where, 'h1 が無い');
    else if (h1s.length > 1) error('seo', where, `h1 が ${h1s.length} 個ある(1ページ1つ)`);

    if (!page.doc.querySelector('link[rel="canonical"]')) {
      error('seo', where, 'canonical が無い');
    }

    const htmlEl = page.doc.querySelector('html');
    if (!htmlEl || !htmlEl.getAttribute('lang')) {
      warn('seo', where, 'html に lang 属性が無い');
    }
  }

  for (const [title, routes] of titles) {
    if (routes.length > 1) {
      error('seo', routes.join(', '), `title が重複: "${title.slice(0, 40)}..."`);
    }
  }
  for (const [desc, routes] of descriptions) {
    if (routes.length > 1) {
      error('seo', routes.join(', '), `description が重複: "${desc.slice(0, 40)}..."`);
    }
  }

  finishCheck('seo', 'SEO(title/description/h1/canonical)', pages.length);
}

// ---------------------------------------------------------------------------
// 3. 法務(PR表記 / 自己申告)
// ---------------------------------------------------------------------------

function hostOf(href) {
  try {
    return new URL(href, 'https://example.invalid').host.toLowerCase();
  } catch {
    return '';
  }
}

function isAffiliateLink(anchor) {
  const rel = (anchor.getAttribute('rel') ?? '').toLowerCase();
  if (rel.split(/\s+/).includes('sponsored')) return true;
  const href = anchor.getAttribute('href') ?? '';
  if (!/^https?:/i.test(href)) return false;
  const host = hostOf(href);
  return AFFILIATE_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

function checkLegal(pages) {
  for (const page of pages) {
    const where = page.route;
    const anchors = page.doc.querySelectorAll('a');
    const affiliates = anchors.filter(isAffiliateLink);

    if (affiliates.length > 0) {
      const hasMarker =
        page.doc.querySelector('[data-pr-disclosure]') !== null ||
        PR_MARKERS.some((re) => re.test(page.mainText));
      if (!hasMarker) {
        error(
          'legal',
          where,
          `アフィリエイトリンク ${affiliates.length} 件があるのに PR表記が無い(ステマ規制)`,
        );
      } else {
        // 冒頭で分かる位置にあるか
        const idx = page.mainText.search(/PR|広告|プロモーション|アフィリエイト/);
        if (idx > 800) {
          warn('legal', where, `PR表記が本文の ${idx} 文字目。冒頭に置くこと`);
        }
      }
      // sponsored 属性の付け漏れ
      for (const a of affiliates) {
        const rel = (a.getAttribute('rel') ?? '').toLowerCase().split(/\s+/);
        // WARNではなくERRORにする。付け忘れると広告リンクが自然リンクとして扱われ、
        // 検索エンジンから手動対策を受けうる。付けるのは一瞬なので通す理由がない。
        if (!rel.includes('sponsored') && !rel.includes('nofollow')) {
          error('legal', where, `アフィリエイトリンクに rel="sponsored" が無い: ${a.getAttribute('href')}`);
        }
      }
    }

    const bodyEl = page.doc.querySelector('body');
    const declaredUgc = bodyEl?.getAttribute('data-has-user-data') === 'true';

    // テキスト検出はフラグ付け忘れを拾う安全網。ただし2種類の誤検知がある:
    //  (1) 「投稿データは含みません」のような否定文
    //  (2) ポリシー系ページ(投稿データを"表示"せず"扱い方を説明"しているだけ)
    // どちらも本文検出から除く。構造マーカー(data-has-user-data)による判定は残す。
    const sentences = page.mainText.split(/[。\n]/);
    const textSignalsUgc =
      !POLICY_ROUTES.has(page.route) &&
      sentences.some(
        (sentence) =>
          UGC_SIGNALS.some((re) => re.test(sentence)) &&
          !/(含みま?せん|ありません|ではありません|掲載していません|使用していません)/.test(sentence),
      );

    const looksUgc =
      declaredUgc || page.doc.querySelector('[data-user-data-note]') !== null || textSignalsUgc;

    if (looksUgc) {
      if (!/自己申告/.test(page.mainText)) {
        error('legal', where, '投稿データを扱っているのに「自己申告」の注記が無い(掟 3-2)');
      }
      if (!/n\s*=\s*\d+|\d+\s*件/.test(page.mainText)) {
        warn('legal', where, '投稿データのページにサンプル数の併記が見当たらない(掟 3-3)');
      }
    }
  }

  finishCheck('legal', '法務(PR表記・自己申告の注記)', pages.length);
}

// ---------------------------------------------------------------------------
// 4. リンク
// ---------------------------------------------------------------------------

function resolveInternal(route, href) {
  const clean = href.split('#')[0].split('?')[0];
  if (clean === '') return null;
  const base = route.endsWith('/') ? route : posix.dirname(route) + '/';
  return posix.normalize(clean.startsWith('/') ? clean : posix.join(base, clean));
}

function targetExists(target) {
  const rel = target.replace(/^\//, '');
  const candidates = [];
  if (target.endsWith('/')) {
    candidates.push(join(DIST, rel, 'index.html'));
  } else if (extname(target)) {
    candidates.push(join(DIST, rel));
  } else {
    candidates.push(join(DIST, `${rel}.html`), join(DIST, rel, 'index.html'));
  }
  return candidates.some((p) => existsSync(p) && statSync(p).isFile());
}

function checkLinks(pages) {
  /** リンクされた内部ルート */
  const linked = new Set();
  let internalCount = 0;

  for (const page of pages) {
    for (const a of page.doc.querySelectorAll('a')) {
      const href = a.getAttribute('href');
      if (!href) {
        warn('links', page.route, 'href の無い <a> がある');
        continue;
      }
      if (/^(mailto:|tel:|javascript:|data:)/i.test(href) || href.startsWith('#')) continue;

      if (/^https?:\/\//i.test(href)) {
        const rel = (a.getAttribute('rel') ?? '').toLowerCase().split(/\s+/);
        if (a.getAttribute('target') === '_blank' && !rel.includes('noopener') && !rel.includes('noreferrer')) {
          warn('links', page.route, `target="_blank" に rel="noopener" が無い: ${href}`);
        }
        continue; // 外部リンクの到達性は検査しない(ネットワークに依存させない)
      }

      const target = resolveInternal(page.route, href);
      if (!target) continue;
      internalCount++;
      // /api/ は Pages Functions が担当するので静的ファイルは存在しない
      if (target.startsWith('/api/')) continue;
      if (!targetExists(target)) {
        error('links', page.route, `内部リンク切れ: ${href} -> ${target}`);
      }
      linked.add(target.endsWith('/') || extname(target) ? target : `${target}/`);
    }
  }

  // 孤立ページ
  for (const page of pages) {
    if (page.route === '/' || page.route === '/404.html' || page.route === '/404/') continue;
    const bodyEl = page.doc.querySelector('body');
    if (bodyEl?.getAttribute('data-allow-orphan') === 'true') continue;
    if (page.doc.querySelector('meta[name="robots"][content*="noindex"]')) continue;
    if (!linked.has(page.route)) {
      error('links', page.route, 'どのページからもリンクされていない(孤立ページ)');
    }
  }

  finishCheck('links', `リンク(内部 ${internalCount} 本)`, pages.length);
}

// ---------------------------------------------------------------------------
// 5. 薄いページ
// ---------------------------------------------------------------------------

/** noindex 指定のページか(検索結果に出ないページは薄さを問わない) */
function isNoindex(page) {
  const meta = page.doc.querySelector('meta[name="robots"]');
  return /noindex/i.test(meta?.getAttribute('content') ?? '');
}

function checkThin(pages) {
  for (const page of pages) {
    // noindex のページ(404など)は検索結果に出ないため、薄さは問題にならない。
    // 薄いページ検査は「量産ページとしてインデックスされること」を防ぐためのもの。
    if (isNoindex(page)) continue;
    const len = page.mainText.replace(/\s/g, '').length;
    if (len < THIN_ERROR_CHARS) {
      error('thin', page.route, `本文が ${len} 文字しかない(最低 ${THIN_ERROR_CHARS} 文字)`);
    } else if (len < THIN_WARN_CHARS) {
      warn('thin', page.route, `本文が ${len} 文字。量産ページとみなされる恐れがある`);
    }
  }
  finishCheck('thin', `薄いページ(<${THIN_ERROR_CHARS}字でERROR)`, pages.length);
}

// ---------------------------------------------------------------------------
// 6. 禁止表現
// ---------------------------------------------------------------------------

function checkPhrases(pages) {
  for (const page of pages) {
    const titleEl = page.doc.querySelector('title');
    const descEl = page.doc.querySelector('meta[name="description"]');
    const haystack = [
      page.mainText,
      titleEl ? titleEl.text : '',
      descEl ? (descEl.getAttribute('content') ?? '') : '',
    ].join(' \n ');

    for (const { re, why } of BANNED_PHRASES) {
      const m = haystack.match(re);
      if (m) {
        const at = haystack.indexOf(m[0]);
        const excerpt = haystack.slice(Math.max(0, at - 20), at + m[0].length + 20).trim();
        error('phrases', page.route, `禁止表現「${m[0]}」(${why}) … ${excerpt}`);
      }
    }
  }
  finishCheck('phrases', '禁止表現(誇大表現・AI定型文)', pages.length);
}

// ---------------------------------------------------------------------------
// 7. 差し替え忘れ(プレースホルダ)
// ---------------------------------------------------------------------------

/**
 * 公開前に実在の値へ差し替える必要がある箇所を検出する。
 * 問い合わせ先が example.com のまま公開されると、ASP審査に落ちるだけでなく
 * 「連絡できないサイト」として信頼を失う。人の注意力に頼らず機械で止める。
 */
const PLACEHOLDER_PATTERNS = [
  { re: /REPLACE_ME/i, why: '差し替え用のマーカーが残っている' },
  { re: /@example\.(com|org|net)/i, why: 'ダミーのメールアドレスが残っている' },
  { re: /03-XXXX-XXXX|000-0000-0000/, why: 'ダミーの電話番号が残っている' },
  { re: /(?:ここに|TODO:|FIXME:)\s*(?:入力|記入|差し替え)/, why: '未記入のマーカーが残っている' },
  { re: /forms\.gle\/(REPLACE_ME|xxx+|TODO)/i, why: 'ダミーのフォームURLが残っている' },
  { re: /https?:\/\/example\.(com|org|net)/i, why: 'ダミーのURLが残っている' },
];

function checkPlaceholders(pages) {
  for (const page of pages) {
    // **本文テキストだけでなく生HTMLを見る。**
    // 問い合わせ先がリンクになっている場合、プレースホルダは href 属性の中にあり
    // 本文テキストには現れない。本文だけ見ていると「通るはずのないものが通る」。
    // (2026-07-25: メール表記からGoogleフォームのリンクに変えた際に実際に起きた)
    for (const { re, why } of PLACEHOLDER_PATTERNS) {
      const m = page.html.match(re);
      if (m) {
        error('placeholder', page.route, `「${m[0]}」が残っている(${why})`);
      }
    }
  }
  finishCheck('placeholder', '差し替え忘れ(プレースホルダ)', pages.length);
}

/**
 * SNS共有カードの整合(2026-07-26 新設)
 *
 * **なぜ必要か**: `twitter:card=summary_large_image` を指定しながら
 * `og:image` が1つも無い状態で2日間公開していた。
 * 画像必須のカード形式で画像が無いと共有時に空白カードになり、**何も指定しないより悪い**。
 * タスク上は「OG画像を追加」が完了扱いだったが、実装されていなかった。
 *
 * **「完了と記録したこと」と「実際に出力されていること」がずれる。**
 * 自己申告を信じず、成果物を見る。
 *
 * あわせて公開前の言い回しが残っていないかも見る
 * (「連絡先は公開時までに用意する」がAboutに公開後も残っていた)。
 */
function checkSocialCard(pages) {
  const PRELAUNCH = [
    /公開時までに/, /公開までに(用意|準備)/, /準備中(です|。)/, /近日公開/, /(仮|ダミー)のURL/,
  ];
  for (const page of pages) {
    const where = page.route;
    if (isNoindex(page)) continue;

    const card = page.doc.querySelector('meta[name="twitter:card"]')?.getAttribute('content') ?? '';
    const image = page.doc.querySelector('meta[property="og:image"]')?.getAttribute('content') ?? '';
    if (card === 'summary_large_image' && !image) {
      error('social', where, 'twitter:card=summary_large_image なのに og:image が無い。共有すると空白のカードになる');
    }
    if (image && !/^https?:\/\//.test(image)) {
      error('social', where, `og:image が絶対URLでない: ${image}。SNSは相対URLを解決しない`);
    }
    if (!page.doc.querySelector('meta[property="og:title"]')) {
      error('social', where, 'og:title が無い');
    }

    for (const re of PRELAUNCH) {
      const m = page.mainText.match(re);
      if (m) error('social', where, `公開前の言い回しが残っている「${m[0]}」。サイトは既に公開されている`);
    }
  }
  finishCheck('social', 'SNS共有カード・公開前の言い回し', pages.length);
}

/**
 * マイグレーションSQLが投入する entities.type が、投稿APIの照合値と一致しているか。
 *
 * **なぜ必要か**: 2026-07-25、シードは 'qualification' なのにAPIは 'certification' を
 * 照合していた。ページは表示されるのに投稿だけ404を返す不具合で、本番で実際に投稿するまで
 * 気づけなかった。そのとき本番DBは手で直したが、**マイグレーションは壊れたまま残っていた**
 * (2026-07-26に発覚)。DBを作り直せば同じ不具合が復活する状態だった。
 *
 * ビルド成果物には現れないのでHTML検査では捕まらない。ここで機械的に落とす。
 */
function checkMigrations() {
  const dir = join(ROOT, 'migrations');
  if (!existsSync(dir)) {
    finishCheck('migration', 'マイグレーション(entity type の整合)', 0);
    return;
  }
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql'));
  const seededSlugs = new Set();
  for (const file of files) {
    const sql = readFileSync(join(dir, file), 'utf8');
    // INSERT INTO entities (...) VALUES ('<type>', ... の第1値を見る
    for (const m of sql.matchAll(/INSERT\s+INTO\s+entities[\s\S]{0,200}?VALUES\s*\(\s*'([^']+)'\s*,\s*'([^']+)'/gi)) {
      if (!KNOWN_ENTITY_TYPES.includes(m[1])) {
        error(
          'migration',
          `migrations/${file}`,
          `entities.type に "${m[1]}" を投入している。投稿APIが照合できるのは ${KNOWN_ENTITY_TYPES.join(' / ')} のみ。` +
            'このままDBを作り直すと、ページは表示されるのに投稿だけ404になる',
        );
      }
      seededSlugs.add(m[2]);
    }
  }

  // 公開中の資格が全てマイグレーションに載っているか。
  //
  // **なぜ必要か**: 2026-07-26、衛生管理者2件を追加したとき、本番D1には
  // wrangler で直接INSERTしたが**マイグレーションに書き忘れた**。ページは本番で
  // 正常に見えるので誰も気づかない。だがDBを作り直した瞬間に、
  // そのページの投稿だけが404を返すようになる。
  // 0003 に「本番を手で直したときは必ずマイグレーションにも入れる」と書いた1時間後に、
  // 同じことをやっていた。**手順書は守られない。機械で落とす。**
  const entityDir = join(ROOT, 'data', 'entities');
  let published = 0;
  if (existsSync(entityDir)) {
    for (const file of readdirSync(entityDir).filter((f) => f.endsWith('.json'))) {
      let json;
      try {
        // BOM付きで保存されることがあるので剥がす
        json = JSON.parse(readFileSync(join(entityDir, file), 'utf8').replace(/^﻿/, ''));
      } catch (e) {
        error('migration', `data/entities/${file}`, `JSONとして読めない: ${e.message}`);
        continue;
      }
      if (json.draft) continue; // 下書きはページも作られないのでシード不要
      published += 1;
      if (!seededSlugs.has(json.slug)) {
        error(
          'migration',
          `data/entities/${file}`,
          `slug "${json.slug}" を投入する INSERT が migrations/ に無い。` +
            '本番DBに手で入れただけの状態だと、DBを作り直したときにこの資格の投稿だけ404になる',
        );
      }
    }
  }

  finishCheck('migration', 'マイグレーション(entity type とシードの網羅)', files.length + published);
}

/**
 * 出典の張り方を検査する(掟 3-1b の機械化)。
 *
 * **なぜ必要か**: 「出典と記述が対応していない」は 2026-07-25 / 07-26 に**3回**起きた。
 *   1回目: 危険物乙4の合格発表の説明が、引用元ページに存在しなかった
 *   2回目: 衛生管理者で「確認できなかった」と書いた内容が、自分が引用済みのページにあった
 *   3回目: 危険物5件で出題形式の出典が subject.html を指していたが、そのページに記載が無かった
 * プロジェクトの規則は「同じ分類が3回出たら対策そのものを作り直す」である。
 *
 * **限界を正直に書く**: 「そのページにその記述があるか」は機械では判定できない
 * (ページを取得して読解する必要があり、それはfact-checkerの仕事である)。
 * ここで落とせるのは**構造的な誤りだけ**:
 *   - 出典はあるのに本文がどこにも出ない項目(読者は根拠だけ見せられて中身を見られない)
 *   - 1つのURLで多くの項目をまとめて根拠づけている(掟 3-1b が名指しで禁じている形)
 *   - 出典一覧に日本語名が無く、英語のキー名がそのまま読者に出る項目
 */
function checkSources() {
  const dir = join(ROOT, 'data', 'entities');
  if (!existsSync(dir)) {
    finishCheck('sources', '出典の張り方(項目ごとの分離)', 0);
    return;
  }
  // src/pages/shikaku/[slug].astro の FIELD_LABELS と対応させること。
  // ここに無いキーを source_urls に足すと、出典一覧に英語のキー名が表示される
  const LABELLED = new Set([
    'eligibility', 'fee_yen', 'fee_yen_cbt', 'format', 'questions', 'subjects',
    'duration_minutes', 'passing_criteria', 'exemption', 'frequency',
    'result_announcement', 'license_requirement',
  ]);
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  let checked = 0;
  for (const file of files) {
    let e;
    try {
      e = JSON.parse(readFileSync(join(dir, file), 'utf8').replace(/^﻿/, ''));
    } catch {
      continue; // JSONの不正は checkMigrations が報告する
    }
    if (e.draft) continue;
    const su = e.exam?.source_urls;
    if (!su) continue;
    checked += 1;
    const where = `data/entities/${file}`;

    const byUrl = new Map();
    for (const [field, url] of Object.entries(su)) {
      if (!LABELLED.has(field)) {
        error('sources', where, `source_urls の "${field}" に対応する日本語名が無い。出典一覧に "${field}" と英語のまま表示される`);
      }
      if (e.exam[field] === undefined && field !== 'fee_yen_cbt') {
        error('sources', where, `source_urls に "${field}" の出典があるが、exam に "${field}" 本体が無い。読者は根拠だけ見せられて中身を読めない`);
      }
      byUrl.set(url, [...(byUrl.get(url) ?? []), field]);
    }
    for (const [url, fields] of byUrl) {
      if (fields.length >= 4) {
        warn(
          'sources',
          where,
          `1つのURLで${fields.length}項目(${fields.join('/')})をまとめて根拠づけている。` +
            '掟3-1b は項目ごとに出典を分けることを求めている。本当に全部そのページに載っているか確認すること',
        );
      }
    }
  }
  finishCheck('sources', '出典の張り方(項目ごとの分離)', checked);
}

/**
 * 週次スナップショットを取っているか。
 *
 * **なぜQAで見るか**: 計画では週次でKPIを記録することになっていたが、
 * 公開2日目の時点で `metrics/` は0件だった。記録を拒んだのではなく、
 * 手作業だったので毎回後回しになっただけである。
 * **急いでいるとき、手で実行する工程は必ず飛ばされる。**
 * qa と smoke だけが守られてきたのは、`npm run` の中にあって飛ばせないからだった。
 * だから記録の有無もここで見る。
 *
 * 数字が悪いことは止めない。**測っていないことを止める。**
 */
function checkMetrics() {
  const dir = join(ROOT, '..', 'metrics');
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort() : [];

  if (files.length === 0) {
    warn('metrics', 'metrics/', '週次スナップショットが1件も無い。`npm run metrics` を実行すること');
    finishCheck('metrics', '週次スナップショット', 0);
    return;
  }

  const newest = files[files.length - 1];
  const days = Math.floor((Date.now() - Date.parse(`${newest.slice(0, 10)}T00:00:00+09:00`)) / 86_400_000);
  if (days > 14) {
    error('metrics', `metrics/${newest}`, `最後の記録から${days}日経過している。\`npm run metrics\` を実行すること`);
  } else if (days > 7) {
    warn('metrics', `metrics/${newest}`, `最後の記録から${days}日経過している。週次で記録すること`);
  }

  // 手で入れる数字(Search Console・ASP)が空のまま放置されていないか。
  // 自動で取れる数字だけ記録して「測っている」ことにするのを防ぐ。
  let snap;
  try {
    snap = JSON.parse(readFileSync(join(dir, newest), 'utf8'));
  } catch (e) {
    error('metrics', `metrics/${newest}`, `JSONとして読めない: ${e.message}`);
    finishCheck('metrics', '週次スナップショット', files.length);
    return;
  }
  const manual = snap.manual ?? {};
  const filled = Object.values(manual).filter((v) => v !== null && v !== undefined).length;
  if (filled === 0) {
    const msg =
      'Search Console と ASP の数字が未記入。機械で取れる数字だけでは「測っている」ことにならない';
    if (days > 14) error('metrics', `metrics/${newest}`, msg);
    else warn('metrics', `metrics/${newest}`, msg);
  }

  finishCheck('metrics', '週次スナップショット', files.length);
}

/**
 * 予測台帳の検査。**「出した物が効いたか」を測っているかを見る唯一の検査である。**
 *
 * ここまでの検査(seo/legal/sources/...)は全て「出す物が正しいか」しか見ていない。
 * その結果、13投稿を機械検査と初見レビュー2回に通して出し、**表示回数1** で
 * 気づくまで誰も止められなかった。正しさの検査をいくら足しても、届いたかは分からない。
 *
 * 3つを強制する:
 *   1. 判定日を過ぎたのに実測が空 → ERROR。予測を書きっぱなしにできない
 *   2. 「届いた量」の予測項目が無いセット → ERROR。P-004 の学びの機械化。
 *      表示回数を予測項目に入れていなかったため、配信ゼロに気づく仕組みが無かった
 *   3. 最後の予測から14日以上 → ERROR。予測を書く習慣そのものを飛ばせなくする
 */
function checkPredictions() {
  const path = join(ROOT, '..', 'retro', 'predictions.json');
  if (!existsSync(path)) {
    error('predictions', 'retro/predictions.json', '予測台帳が無い。掟7「予測を先に書く」の正データである');
    finishCheck('predictions', '予測と実測の照合', 0);
    return;
  }

  let ledger;
  try {
    ledger = JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, ''));
  } catch (e) {
    error('predictions', 'retro/predictions.json', `JSONとして読めない: ${e.message}`);
    finishCheck('predictions', '予測と実測の照合', 0);
    return;
  }

  const list = ledger.predictions ?? [];
  const reachWords = ledger.reachKeywords ?? [];
  const today = Date.now();
  const daysSince = (iso) => Math.floor((today - Date.parse(`${iso}T00:00:00+09:00`)) / 86_400_000);

  let newest = -Infinity;

  for (const p of list) {
    const where = `retro/predictions.json (${p.id})`;

    if (!p.dueDate) {
      error('predictions', where, '判定日(dueDate)が無い。いつ答え合わせするか決めていない予測は検証されない');
      continue;
    }
    if (p.recorded) newest = Math.max(newest, Date.parse(p.recorded));

    // 1. 判定日を過ぎたのに実測が空
    const overdue = daysSince(p.dueDate);
    const unmeasured = (p.items ?? []).filter((it) => it.actual === null || it.actual === undefined);
    if (!p.closed && overdue >= 0 && unmeasured.length > 0) {
      error(
        'predictions',
        where,
        `判定日 ${p.dueDate} を${overdue}日過ぎたが、${unmeasured.length}/${p.items.length}項目が未実測。` +
          `実測を入れて verdict を付けること(取れないなら理由を actual に書く)`,
      );
    } else if (!p.closed && overdue >= -7 && unmeasured.length > 0) {
      warn('predictions', where, `判定日 ${p.dueDate} まであと${-overdue}日。${unmeasured.length}項目が未実測`);
    }

    // 2. 「届いた量」の項目があるか
    const hasReach = (p.items ?? []).some((it) => reachWords.some((w) => String(it.label).includes(w)));
    if (!hasReach) {
      error(
        'predictions',
        where,
        `「届いた量」(${reachWords.slice(0, 4).join('・')}など)の予測項目が無い。` +
          `P-004 の学び: 表示回数を予測項目に入れていなかったため配信ゼロに気づけなかった`,
      );
    }
  }

  // 3. 予測を書く習慣そのもの
  const limit = ledger.maxDaysWithoutNewPrediction ?? 14;
  if (Number.isFinite(newest)) {
    const gap = Math.floor((today - newest) / 86_400_000);
    if (gap > limit) {
      error(
        'predictions',
        'retro/predictions.json',
        `最後に予測を書いてから${gap}日経過している(上限${limit}日)。` +
          `施策を打つ前に予測を書くこと。後から書いたものは予測ではない`,
      );
    }
  }

  finishCheck('predictions', '予測と実測の照合', list.length);
}

// ---------------------------------------------------------------------------
// 実行
// ---------------------------------------------------------------------------

/** src/lib/entities.ts の KNOWN_ENTITY_TYPES と functions/api/report.ts の SCHEMAS に対応 */
const KNOWN_ENTITY_TYPES = ['certification'];

const CHECK_ORDER = ['secrets', 'seo', 'legal', 'links', 'thin', 'phrases', 'placeholder', 'social', 'sources', 'migration', 'metrics', 'predictions'];

function report() {
  const errors = findings.filter((f) => f.severity === 'error');
  const warns = findings.filter((f) => f.severity === 'warn');

  console.log('');
  console.log(bold('  QA レポート'));
  console.log(gray('  ' + '-'.repeat(62)));

  // CHECK_ORDER に無いキーも末尾に出す。登録漏れでエラーが黙殺されると
  // 「デプロイ不可」とだけ出て理由が分からなくなる。
  const orderedKeys = [...CHECK_ORDER, ...[...checkStats.keys()].filter((k) => !CHECK_ORDER.includes(k))];

  for (const key of orderedKeys) {
    const stat = checkStats.get(key);
    if (!stat) continue;
    const own = findings.filter((f) => f.check === key);
    const ownErrors = own.filter((f) => f.severity === 'error');
    const ownWarns = own.filter((f) => f.severity === 'warn');

    let badge;
    if (ownErrors.length > 0) badge = red('FAIL');
    else if (ownWarns.length > 0) badge = yellow('WARN');
    else badge = green('PASS');

    if (QUIET && ownErrors.length === 0 && ownWarns.length === 0) continue;

    console.log(
      `  ${badge}  ${bold(stat.label)} ${gray(`(${stat.examined} 件を検査)`)}`,
    );
    for (const f of own) {
      const mark = f.severity === 'error' ? red('  x ') : yellow('  ! ');
      console.log(`${mark}${gray(f.where)}  ${f.message}`);
    }
    if (own.length > 0) console.log('');
  }

  console.log(gray('  ' + '-'.repeat(62)));
  const summary =
    errors.length > 0
      ? red(`  ERROR ${errors.length} 件 / WARN ${warns.length} 件 — デプロイ不可`)
      : warns.length > 0
        ? yellow(`  ERROR 0 件 / WARN ${warns.length} 件 — デプロイ可(警告は確認すること)`)
        : green('  ERROR 0 件 / WARN 0 件 — すべて通過');
  console.log(summary);
  console.log('');

  if (errors.length === 0) stampPassed();
  return errors.length > 0 ? 1 : 0;
}

/**
 * 通過の刻印を残す。`.claude/hooks/stop-gate.mjs` がこの時刻と
 * site/ の最終更新時刻を比べ、**古ければターンを終わらせない**。
 *
 * 刻印を残すのが qa 側なのは、「検査を通した」という事実を知っているのが
 * qa だけだからである。フック側で判定すると、フックが qa を起動することになり
 * 毎ターン数秒かかって必ず外される。
 */
function stampPassed() {
  try {
    const cache = join(ROOT, '..', '.cache');
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, 'qa-stamp'), new Date().toISOString(), 'utf8');
  } catch {
    /* 刻印に失敗してもQAの結果は変えない */
  }
}

async function main() {
  await checkSecrets();

  const pages = await loadPages();
  if (pages === null) {
    const message = 'dist/ が無い。`npm run build` を先に実行すること';
    if (STRICT_DIST) error('seo', 'dist/', message);
    else warn('seo', 'dist/', `${message}(HTML検査をスキップした)`);
    finishCheck('seo', 'SEO', 0);
    process.exit(report());
  }

  if (pages.length === 0) {
    warn('seo', 'dist/', 'HTMLページが1つも無い');
    finishCheck('seo', 'SEO', 0);
    process.exit(report());
  }

  checkSeo(pages);
  checkLegal(pages);
  checkLinks(pages);
  checkThin(pages);
  checkPhrases(pages);
  checkPlaceholders(pages);
  checkSocialCard(pages);
  checkSources();
  checkMigrations();
  checkMetrics();
  checkPredictions();

  process.exit(report());
}

main().catch((err) => {
  console.error(red(`  QAスクリプトが異常終了した: ${err?.stack ?? err}`));
  process.exit(1);
});
