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
import { validateBundle, bundleEntries, bundleAliases, migrateBundle, formatMigrationNotice } from './catalogBundle.js';
import { setOverlay, clearOverlays, markOverlayUntrusted } from './catalogRegistry.js';
import { setDocumentAliases, clearDocumentAliases, addDocumentAliases } from './codeNormalization.js';

/**
 * IndexedDB から読み込んだカタログ束（文書同梱・ユーザーライブラリ）を catalogRegistry.js の
 * overlay として設定する。文書固有のコード正規化表（束の aliases[kind]。全種別）も
 * setDocumentAliases(kind, …) へ設定する（aliases が空でも本体の振り直し表だけで正規化される
 * 既定は codeNormalization.js 側で保たれる）。
 *
 * - 未知の種別（このビルドの登録表 listKinds() に無い kind）のレコードは触らない
 *   （IDB には残したまま、overlay 適用の対象外にする。kindDef(未知kind) が例外を
 *   投げて全体が失敗するのを避けるため、decode/validate の前に既知種別だけへ絞り込む）。
 * - 壊れたレコード（decodeCatalogBundle/validateBundle が例外）・setOverlay が投げた場合
 *   （通常は起きないが、防御として）のどちらでも、外側の catch で clearOverlaysFn() ＋
 *   setDocumentCodeTableFn(null) してから onError へ渡す——「overlay は一切立てない」を
 *   実際に保証する（2026-09-22 再QA指摘Minor-A: 内側の catch（setOverlay自体が投げた場合の
 *   巻き戻し）だけでなく、外側の catch（decode/validate失敗時）でも同じ後始末をする。
 *   decode/validate失敗時はまだ何もsetOverlayしていないため実害は無いが、将来この関数の前段が
 *   増えたときに「まだ何もしていないから大丈夫」という前提が崩れても壊れないようにする防御）。
 *
 * `setOverlayFn`/`clearOverlaysFn`/`setDocumentAliasesFn`/`clearDocumentAliasesFn`/
 * `addDocumentAliasesFn` は省略時 catalogRegistry.js/codeNormalization.js の本物を使う——
 * テストが「setOverlay が例外を投げた場合に全 clear されること」を検証するための注入口
 * （本番では常に既定値のまま）。
 *
 * `onNotice`（省略可）: migrateBundle が移行を行った場合に、通知文（formatMigrationNotice
 * を「。」で連結した1本の文字列）を渡して1回だけ呼ぶ（QA指摘Minor-2・ステップ14-S再指摘:
 * console.warn だけでは利用者に見えないため、起動時照合の通知
 * （store.js reconcileIncomingCatalogs の formatReconcileNotice 経由）と同じ口へ流せるように
 * する）。読込みが最終的に失敗した場合（外側catchに落ちる）は呼ばない——overlayが結局
 * 立たない移行の話を利用者に見せても意味が無いため。
 *
 * @param {{ loadDocumentCatalogs: () => Promise<Array<{kind:string, bytes:Uint8Array}>>,
 *           loadUserCatalogs: () => Promise<Array<{kind:string, bytes:Uint8Array}>>,
 *           onError: (message: string) => void,
 *           onNotice?: (message: string) => void,
 *           setOverlayFn?: typeof setOverlay, clearOverlaysFn?: typeof clearOverlays,
 *           setDocumentAliasesFn?: typeof setDocumentAliases,
 *           clearDocumentAliasesFn?: typeof clearDocumentAliases,
 *           addDocumentAliasesFn?: typeof addDocumentAliases }} deps
 */
export async function loadCatalogOverlaysFromIDB({
  loadDocumentCatalogs, loadUserCatalogs, onError, onNotice = () => {},
  setOverlayFn = setOverlay, clearOverlaysFn = clearOverlays,
  setDocumentAliasesFn = setDocumentAliases, clearDocumentAliasesFn = clearDocumentAliases,
  addDocumentAliasesFn = addDocumentAliases,
}) {
  const migratedNotices = [];
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
      const decoded = decodeCatalogBundle(bytes);
      // ステップ14-S（裁定1）: validateBundle の前に migrateBundle を通す——修正前の
      // parseSectionSpec のバグで作られた不正データ（例: 負の断面）を検証で弾く前に
      // 正しい内容へ書き換えて救済する。doc/userどちらの束もこの同じ decodeAndValidate を
      // 通る（呼び出し元でレコードごとに呼ばれるため両方に効く）。
      const { bundle, migrated } = migrateBundle(decoded);
      for (const m of migrated) {
        const notice = formatMigrationNotice(m);
        console.warn(`カタログ移行: ${notice}`);
        migratedNotices.push(notice);
      }
      validateBundle(bundle);
      return { kind, bundle };
    };
    // 先に全レコードを decode/validate してから setOverlay する（どれか1つが壊れていた場合に
    // 他の種別だけ overlay が立った中途半端な状態を作らないため）。
    const docBundles  = knownDocRecords.map(decodeAndValidate);
    const userBundles = knownUserRecords.map(decodeAndValidate);

    const userEntriesByKind = new Map(userBundles.map(({ kind, bundle }) => [kind, bundleEntries(bundle, kind)]));

    try {
      // 前回読込み分の全種別aliasesを一旦リセットしてから、今回のdoc束のaliasesだけ積み直す
      // （7a: material限定を廃止。全種別ぶん「読込みのたびに束の内容で上書きする」既定を保つ）。
      clearDocumentAliasesFn();
      const docKinds = new Set();
      for (const { kind, bundle } of docBundles) {
        setOverlayFn(kind, { doc: bundleEntries(bundle, kind), user: userEntriesByKind.get(kind) ?? [] });
        docKinds.add(kind);
        const aliases = bundleAliases(bundle, kind);
        if (Object.keys(aliases).length > 0) setDocumentAliasesFn(kind, aliases);
      }
      for (const [kind, entries] of userEntriesByKind) {
        if (docKinds.has(kind)) continue; // 文書同梱側で既にuser込みでsetOverlay済み
        setOverlayFn(kind, { doc: [], user: entries });
      }
      // QA指摘Major-1（ステップ14-S再指摘）: ユーザーライブラリ束は本来「文書固有の読み替え」の
      // 対象ではなく、上のdocBundlesループ（setDocumentAliasesFn）はuser束のaliasesを見ない。
      // だが旧parseSectionSpecバグの移行に限っては、user overlay側のキーが変わることで既存の
      // 部材参照（sectionDefId等）が読めなくなるため、migrateBundleがuser束へ積んだalias
      // （bundleAliases(bundle,kind)）も addDocumentAliasesFn で読み替え表へ積む——
      // setDocumentAliasesFn（上書き）ではなく addDocumentAliasesFn（既存表とマージ）を使うのは、
      // 同じkindにdoc束のaliasesが既に積まれている場合にそれを消さないため。
      for (const { kind, bundle } of userBundles) {
        const aliases = bundleAliases(bundle, kind);
        if (Object.keys(aliases).length === 0) continue;
        addDocumentAliasesFn(kind, Object.entries(aliases).map(([from, to]) => ({ from, to })));
      }
    } catch (applyErr) {
      // setOverlay 自体が例外を投げた場合（通常は起きない防御）: 部分適用を残さない。
      clearOverlaysFn();
      clearDocumentAliasesFn();
      throw applyErr;
    }
    // ここまで例外なく到達＝overlayは信頼できる状態（裁定2）。前回読込みが失敗していた場合に
    // 備えて明示的に false へ戻す（clearOverlaysFn経由の副作用に頼らない）。
    markOverlayUntrusted(false);
    // QA指摘Minor-2（ステップ14-S再指摘）: 移行があれば1回だけ利用者向け通知を出す
    // （console.warnは既にdecodeAndValidateの中で個別に出している。ここは集約した1本）。
    if (migratedNotices.length > 0) onNotice(migratedNotices.join('。'));
  } catch (e) {
    // decode/validate失敗（内側のtryへ到達する前）・setOverlay失敗（内側のcatchが再throwした後）
    // のどちらでもここへ来る。二重にclearOverlaysFn()を呼んでも副作用は無い（冪等）ため、
    // 内側catchの有無に関わらずここでも必ず後始末してからonErrorへ渡す。
    clearOverlaysFn();
    clearDocumentAliasesFn();
    // ステップ14-S（裁定2）: overlayを丸ごと諦めた＝信頼できない状態を立てる。
    // catalogMaintenance.js commitUserEntries がこれを見て書込みを拒否する
    // （「空のuser＋新規」で上書きし、見えていない正常な登録を消してしまう穴を塞ぐ）。
    markOverlayUntrusted(true);
    onError(e.message);
  }
}
