/**
 * 投稿者の識別子ハッシュ。
 *
 * 生IPは **絶対に保存しない**。ソルト付き SHA-256 の先頭16文字だけを持つ。
 * ソルトは Cloudflare の環境変数(IP_HASH_SALT)に置き、リポジトリには入れない。
 * ソルトが無いままハッシュすると総当たりでIPを復元できてしまうため、
 * 未設定時は呼び出し側で fail closed にする。
 */

const HASH_LENGTH = 16;

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * @param salt 環境変数から渡す。空文字なら例外。
 * @param scope 用途を分けるための固定文字列("ip" / "ua")。
 *              同じ値から複数用途の同一ハッシュが出ないようにする。
 */
export async function hashIdentifier(value: string, salt: string, scope: string): Promise<string> {
  if (!salt || salt.length < 16) {
    throw new Error('IP_HASH_SALT is not configured (or too short)');
  }
  const hex = await sha256Hex(`${scope}:${salt}:${value}`);
  return hex.slice(0, HASH_LENGTH);
}

/** Cloudflare が付与するクライアントIP。無ければ空文字。 */
export function clientIpOf(request: Request): string {
  return (
    request.headers.get('CF-Connecting-IP') ??
    request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ??
    ''
  );
}
