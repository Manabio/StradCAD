// node:test 用のモジュール解決フック本体（testSetup.mjs から register() で登録される）。
// アプリのソースは '@core' で src/core.js を参照する（vite.config.js の resolve.alias）。
// Vite の外（plain Node の `node --test`）ではこのエイリアスが無いため、同じ解決をここで肩代わりする。
// 対象ファイルの import 文は一切変更しない（ビルド・実行時の挙動には無関係。テスト実行時のみ有効）。
const CORE_URL = new URL('../src/core.js', import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@core') {
    return nextResolve(CORE_URL, context);
  }
  return nextResolve(specifier, context);
}
