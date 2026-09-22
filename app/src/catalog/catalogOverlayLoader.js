// ================================================================
// カタログ束（文書同梱・ユーザーライブラリ）を overlay として適用する（ステップ4）。
//
// 葉モジュール。catalogKinds.js・catalogCodec.js・catalogBundle.js・catalogRegistry.js・
// codeNormalization.js（いずれも葉）にのみ依存する。store.js を静的 import しない——
// IndexedDB アクセス（loadDocumentCatalogs/loadUserCatalogs 相当）とエラー通知（onError）は
// 呼び出し側が注入する。これにより store.js を import せずに単体テストできる
// （store.js は起動時副作用が大きく、他のstore.js検証は既存どおりソーステキスト検査に留める）。
// ================================================================

import { listKinds } from './catalogKinds.js';
import { decodeCatalogBundle } from './catalogCodec.js';
import { validateBundle, bundleEntries, bundleAliases } from './catalogBundle.js';
import { setOverlay, clearOverlays } from './catalogRegistry.js';
import { buildCodeTable, setDocumentCodeTable } from './codeNormalization.js';
import { CatalogKind } from './catalogKinds.js';

/**
 * IndexedDB から読み込んだカタログ束（文書同梱・ユーザーライブラリ）を catalogRegistry.js の
 * overlay として設定する。文書固有のコード正規化表（束の aliases.material）も
 * setDocumentCodeTable へ設定する（aliases が空でも本体の振り直し表だけで正規化される既定は
 * codeNormalization.js 側で保たれる）。
 *
 * - 未知の種別（このビルドの登録表 listKinds() に無い kind）のレコードは触らない
 *   （4.5-5: IDB には残したまま、overlay 適用の対象外にする。kindDef(未知kind) が例外を
 *   投げて全体が失敗するのを避けるため、decode/validate の前に既知種別だけへ絞り込む）。
 * - 壊れたレコード（decodeCatalogBundle/validateBundle が例外）・setOverlay が投げた場合
 *   （通常は起きないが、防御として）のどちらでも、外側の catch で clearOverlaysFn() ＋
 *   setDocumentCodeTableFn(null) してから onError へ渡す——「overlay は一切立てない」を
 *   実際に保証する（2026-09-22 再QA指摘Minor-A: 内側の catch（setOverlay自体が投げた場合の
 *   巻き戻し）だけでなく、外側の catch（decode/validate失敗時）でも同じ後始末をする。
 *   decode/validate失敗時はまだ何もsetOverlayしていないため実害は無いが、将来この関数の前段が
 *   増えたときに「まだ何もしていないから大丈夫」という前提が崩れても壊れないようにする防御）。
 *
 * `setOverlayFn`/`clearOverlaysFn`/`setDocumentCodeTableFn`/`buildCodeTableFn` は省略時
 * catalogRegistry.js/codeNormalization.js の本物を使う——テストが「setOverlay が例外を
 * 投げた場合に全 clear されること」を検証するための注入口（本番では常に既定値のまま）。
 *
 * @param {{ loadDocumentCatalogs: () => Promise<Array<{kind:string, bytes:Uint8Array}>>,
 *           loadUserCatalogs: () => Promise<Array<{kind:string, bytes:Uint8Array}>>,
 *           onError: (message: string) => void,
 *           setOverlayFn?: typeof setOverlay, clearOverlaysFn?: typeof clearOverlays,
 *           setDocumentCodeTableFn?: typeof setDocumentCodeTable, buildCodeTableFn?: typeof buildCodeTable }} deps
 */
export async function loadCatalogOverlaysFromIDB({
  loadDocumentCatalogs, loadUserCatalogs, onError,
  setOverlayFn = setOverlay, clearOverlaysFn = clearOverlays,
  setDocumentCodeTableFn = setDocumentCodeTable, buildCodeTableFn = buildCodeTable,
}) {
  try {
    const [docRecords, userRecords] = await Promise.all([
      loadDocumentCatalogs(),
      loadUserCatalogs(),
    ]);
    const knownKinds = new Set(listKinds());
    // 未知種別は decode/validate すら試みず素通し（IDBのレコードには触れない）。
    const knownDocRecords  = docRecords.filter(r => knownKinds.has(r.kind));
    const knownUserRecords = userRecords.filter(r => knownKinds.has(r.kind));

    const decodeAndValidate = ({ kind, bytes }) => {
      const bundle = decodeCatalogBundle(bytes);
      validateBundle(bundle);
      return { kind, bundle };
    };
    // 先に全レコードを decode/validate してから setOverlay する（どれか1つが壊れていた場合に
    // 他の種別だけ overlay が立った中途半端な状態を作らないため）。
    const docBundles  = knownDocRecords.map(decodeAndValidate);
    const userBundles = knownUserRecords.map(decodeAndValidate);

    const userEntriesByKind = new Map(userBundles.map(({ kind, bundle }) => [kind, bundleEntries(bundle, kind)]));

    try {
      let materialAliases = {};
      const docKinds = new Set();
      for (const { kind, bundle } of docBundles) {
        setOverlayFn(kind, { doc: bundleEntries(bundle, kind), user: userEntriesByKind.get(kind) ?? [] });
        docKinds.add(kind);
        if (kind === CatalogKind.MATERIAL) materialAliases = bundleAliases(bundle, kind);
      }
      for (const [kind, entries] of userEntriesByKind) {
        if (docKinds.has(kind)) continue; // 文書同梱側で既にuser込みでsetOverlay済み
        setOverlayFn(kind, { doc: [], user: entries });
      }
      setDocumentCodeTableFn(buildCodeTableFn({ aliases: materialAliases }));
    } catch (applyErr) {
      // setOverlay 自体が例外を投げた場合（通常は起きない防御）: 部分適用を残さない。
      clearOverlaysFn();
      setDocumentCodeTableFn(null);
      throw applyErr;
    }
  } catch (e) {
    // decode/validate失敗（内側のtryへ到達する前）・setOverlay失敗（内側のcatchが再throwした後）
    // のどちらでもここへ来る。二重にclearOverlaysFn()を呼んでも副作用は無い（冪等）ため、
    // 内側catchの有無に関わらずここでも必ず後始末してからonErrorへ渡す。
    clearOverlaysFn();
    setDocumentCodeTableFn(null);
    onError(e.message);
  }
}
