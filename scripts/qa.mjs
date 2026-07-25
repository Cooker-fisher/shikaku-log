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

import { readFileSync, existsSync, statSync } from 'node:fs';
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
  // ASP / アフィリエイトID
  { name: 'A8.net の媒体ID', re: /a8mat=[A-Za-z0-9._]{6,}/ },
  { name: 'もしもアフィリエイトの a_id', re: /\ba_id=\d{5,}/ },
  { name: 'Amazonアソシエイトタグ', re: /[?&]tag=[A-Za-z0-9_]+-2\d\b/ },
  { name: 'バリューコマースの sid/pid', re: /\bsid=\d{6,}&pid=\d{6,}/ },
  { name: 'アクセストレードの rk', re: /\brk=\d{10,}/ },
  // D1 の database_id は意図的に検査対象から外している。
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
  const files = (await walk(DIST)).filter((f) => f.endsWith('.html'));
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
        if (!rel.includes('sponsored') && !rel.includes('nofollow')) {
          warn('legal', where, `アフィリエイトリンクに rel="sponsored" が無い: ${a.getAttribute('href')}`);
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

function checkThin(pages) {
  for (const page of pages) {
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

// ---------------------------------------------------------------------------
// 実行
// ---------------------------------------------------------------------------

const CHECK_ORDER = ['secrets', 'seo', 'legal', 'links', 'thin', 'phrases', 'placeholder'];

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

  return errors.length > 0 ? 1 : 0;
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

  process.exit(report());
}

main().catch((err) => {
  console.error(red(`  QAスクリプトが異常終了した: ${err?.stack ?? err}`));
  process.exit(1);
});
