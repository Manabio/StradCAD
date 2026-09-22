// ================================================================
// 解決層 registry（ステップ2）— overlay（doc/user）をモジュールスコープに保持し、
// 呼び出し側から渡された builtin 一覧と合成する。
//
// 純モジュール（葉）。本体マスタ（finish/materials/・structural/sectionCatalog・
// openings/openingCatalog）を静的にも動的にも読まない——builtin は必ず呼び出し側が
// （自分の動的 import で）読んで渡す。catalogKinds.js（登録表）・catalogBundle.js
// （resolveCatalog/resolveOrigins）・catalogMatch.js（assertNoDuplicate）にのみ依存する。
// ================================================================

import { kindDef } from './catalogKinds.js';
import { resolveCatalog, resolveOrigins } from './catalogBundle.js';
import { diffEntries, formatDuplicateError } from './catalogMatch.js';

/** kind → { doc, user }（未設定の種別は空）。 */
const overlays = new Map();

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * v が entry の配列であることを検査する（2026-09-22 QA指摘A）。非配列は日本語例外。
 * @param {unknown} v
 * @param {string} label 例外文言用（'doc'|'user'）
 */
function assertEntryArray(v, label) {
  if (!Array.isArray(v)) throw new Error(`overlayの${label}は配列である必要があります`);
}

/**
 * kind の overlay（doc/user）を設定する。doc/user 省略時は空配列
 * （= builtin のみ）。第2引数はプレーンオブジェクトである必要があり（配列・文字列は例外。
 * 2026-09-22 QA指摘A残存: 分割代入だけでは配列・文字列も素通りしてしまうため明示検査する）、
 * doc/user 以外の未知キーも例外にする（綴り間違い等の黙殺を防ぐ）。doc・user とも配列でなければ
 * 例外。各エントリは kindDef(kind).validate(entry) を通す（不正なエントリを overlay に
 * 混入させない）。検証に失敗した場合は既存の overlay を書き換えない（例外を投げて終わり）。
 * doc/user とも空なら overlay を消す（clearOverlays相当。overlays.delete(kind)で
 * 「未設定」に戻す——overlayFor の既定値と一致させる。ただし観測可能なAPIからは
 * 「空配列2本をsetした場合」との違いは無い——overlays.size/hasを外部に晒していないため。
 * 2026-09-22 QA指摘A T4）。
 */
export function setOverlay(kind, options = {}) {
  const def = kindDef(kind); // 未知の種別は例外
  if (!isPlainObject(options)) {
    throw new Error('overlayの第2引数はオブジェクトである必要があります（配列・文字列は不可）');
  }
  const unknownKeys = Object.keys(options).filter(k => k !== 'doc' && k !== 'user');
  if (unknownKeys.length > 0) {
    throw new Error(`overlayに未知のキーが含まれています: ${unknownKeys.join(', ')}`);
  }
  const { doc = [], user = [] } = options;
  assertEntryArray(doc, 'doc');
  assertEntryArray(user, 'user');
  for (const entry of doc) def.validate(entry);
  for (const entry of user) def.validate(entry);
  if (doc.length === 0 && user.length === 0) {
    overlays.delete(kind);
    return;
  }
  overlays.set(kind, { doc, user });
}

/**
 * 全種別の overlay を消去する（「新規（全消去）」= store.js の resetAll 相当が使う
 * 本番用の口。テスト専用のリセット口は足さない）。
 * ステップ4で store.js の resetAll がこの clearOverlays を呼ぶ想定（未配線。テストはまだ書かない）。
 */
export function clearOverlays() {
  overlays.clear();
}

/** kind の overlay（{doc, user}）。未設定なら空配列の組。 */
export function overlayFor(kind) {
  kindDef(kind);
  return overlays.get(kind) ?? { doc: [], user: [] };
}

/**
 * dedupeFields の1値を正規化文字列にする。トップレベル同値規則（catalogMatch.js valuesEqual:
 * 文字列はtrim・null≡undefined、null/0は区別）と一致させる。
 * 2026-09-22 QA指摘D: 文字列・数値・null(≡undefined)以外の値（配列・オブジェクト・boolean等）は
 * 4.5-3（文字列化比較の禁止）によりJSON.stringifyでの比較を許さない——現状の登録表では
 * dedupeFieldsに文字列・数値・nullableな数値以外を持つ種別が無いため（materialの
 * name/spec/x/y/thicknessのみ、全てスカラー）、来たら「未対応」の日本語例外にする
 * （2026-09-22 QA指摘・Minor: 文言を型名一般で言えるように一般化——配列・オブジェクトに限らず
 * booleanが来ても正しい文言になる）。
 * 2026-09-22 QA指摘・Minor: 数値はNumber.isFiniteでなければ例外（NaN/Infinityは比較不能）。
 */
function normalizeDedupeValue(v) {
  if (v === null || v === undefined) return 'z:nullish';
  if (typeof v === 'string') return `s:${v.trim()}`;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) {
      throw new Error(`dedupeFieldsの値がNaN/Infinityです（比較できません）: ${v}`);
    }
    return `n:${v}`;
  }
  throw new Error(`dedupeFieldsに文字列・数値・null以外の値は未対応です（実際の型: ${typeof v}）`);
}

/**
 * dedupeFields のタプルをキーにした正規化文字列を作る。各値を長さ接頭辞（`${長さ}:${値}`）で
 * エンコードして連結する（2026-09-22 QA指摘・Minor: 区切り文字\u0001をやめる——値そのものに
 * 区切り文字が含まれていた場合の衝突を、長さ接頭辞で構造的に防ぐ）。
 */
function dedupeTupleKey(dedupeFields, entry) {
  return dedupeFields.map(f => {
    const s = normalizeDedupeValue(entry[f]);
    return `${s.length}:${s}`;
  }).join('');
}

/**
 * assertNoDuplicatesInMergedの本体。登録表の行（またはそれと同じ形のダミー行）を直接受け取る
 * （2026-09-22 QA指摘D・T6: rankCandidatesWithと同じ方式——凍結された本番登録表を書き換えずに
 * 正規化ロジック（配列・オブジェクトが来たときの例外等）をテストするため）。kind は
 * formatDuplicateError のメッセージに使うラベル文字列（本番経路では種別文字列そのもの）。
 * dedupeFields を持たない def は no-op。origins（Map<key,origin>）を渡すとエラー文言に
 * 出所（doc/user/builtin）を併記する。
 */
export function assertNoDuplicatesInMergedWith(kind, def, mergedEntries, origins) {
  const dedupeFields = def.dedupeFields;
  if (!dedupeFields || dedupeFields.length === 0) return;
  const seen = new Map(); // タプルキー → 既出のentry
  for (const entry of mergedEntries) {
    const tupleKey = dedupeTupleKey(dedupeFields, entry);
    const prior = seen.get(tupleKey);
    if (prior) throw formatDuplicateError(kind, def, prior, entry, origins);
    seen.set(tupleKey, entry);
  }
}

/**
 * R17 を合成後にも強制する（裁定A）: setOverlay 時点では builtin を知らないため、
 * 合成結果（builtin+user+doc）に対して dedupeFields 完全一致を検出したら例外を投げる。
 * O(n)（2026-09-22 QA指摘・Minor: dedupeFieldsの正規化タプルをキーにしたMapで検出し、
 * 全件×全件のO(n^2)にしない）。本番経路（kindは種別文字列専用。kindDef(kind)で登録表を引く）。
 */
function assertNoDuplicatesInMerged(kind, mergedEntries, origins) {
  return assertNoDuplicatesInMergedWith(kind, kindDef(kind), mergedEntries, origins);
}

/** builtinList と overlay(doc/user) を解決し、合成Map・出所Mapを作ってR17を検査する。 */
function resolveMergedAndOrigins(kind, builtinList) {
  const { doc, user } = overlayFor(kind);
  const map = resolveCatalog(kind, { doc, user, builtin: builtinList });
  const origins = resolveOrigins(kind, { doc, user, builtin: builtinList });
  assertNoDuplicatesInMerged(kind, [...map.values()], origins);
  return { map, origins, doc, user };
}

/**
 * builtinList と overlay(doc/user) を解決順（doc>user>builtin）で合成した Map を返す。
 * overlay が空のときは `new Map(builtin.map(e => [keyOf(e), e]))` と同じもの
 * （エントリをコピー・凍結・ラップしない＝===同一性を保つ）。
 */
export function composeCatalog(kind, builtinList) {
  const { map } = resolveMergedAndOrigins(kind, builtinList);
  return map;
}

/**
 * 一覧UI用: builtin の並びを保ち、user/doc の追加分（builtin に無いキー）を末尾に置く。
 * 同キーの上書きは builtin の位置に doc/user のエントリを置く（doc>user>builtin）。
 * overlay が空なら builtin と同じ要素・同じ順序を返す。
 */
export function composeList(kind, builtinList) {
  const def = kindDef(kind);
  const { map, doc, user } = resolveMergedAndOrigins(kind, builtinList);

  const builtinKeys = new Set(builtinList.map(e => def.keyOf(e)));
  const result = builtinList.map(e => map.get(def.keyOf(e)));

  const seenExtra = new Set();
  for (const entry of [...user, ...doc]) {
    const key = def.keyOf(entry);
    if (builtinKeys.has(key) || seenExtra.has(key)) continue;
    seenExtra.add(key);
    result.push(map.get(key)); // doc がuserを上書きしていれば doc 側の内容になる
  }
  return result;
}

/**
 * resolveCatalog/composeCatalog と同じ解決順で、キー → 出所('doc'|'user'|'builtin'|null)。
 * composeCatalog/composeList と同じR17検査を掛ける（2026-09-22 QA指摘・Minor: 挙動を揃える。
 * 重複があるカタログについて出所だけ黙って返さない）。
 */
export function originOf(kind, key, builtinList) {
  const { origins } = resolveMergedAndOrigins(kind, builtinList);
  return origins.get(key) ?? null;
}

/**
 * R13: doc（文書同梱）起源のキーのうち、本体（user優先・無ければbuiltin）と内容が異なる
 * ものだけを集めた Map（doc>user>builtinの解決順ではdocが常に勝つため、docが存在する
 * キーの合成結果は必ずdoc——ここでいう「本体」はdocを除いた場合に採用されていたはずの
 * エントリを指す）。判定は diffEntries のみ（唯一の判定箇所）。
 * user起源（doc無し）のキーはここに現れない（user⇔builtin衝突はdetectLibraryConflicts側の
 * 指示UIが担当）。docと同キーのuser/builtinが無い（新規追加材）場合は比較相手が無いため
 * 差分なし＝このMapに含めない。
 * baseEntry は表示側（diffTooltip/diffPairs）が本体値を併記するために必要なため、設計の
 * {baseOrigin, diffFields} に加えて同梱する（2026-09-22 ステップ6-2）。
 * @returns {Map<string, {baseOrigin:'user'|'builtin', diffFields:string[], baseEntry:object}>}
 */
export function docDiffMap(kind, builtinList) {
  const def = kindDef(kind);
  const { doc, user } = overlayFor(kind);
  const result = new Map();
  if (doc.length === 0) return result;
  const userMap = new Map(user.map(e => [def.keyOf(e), e]));
  const builtinMap = new Map(builtinList.map(e => [def.keyOf(e), e]));
  for (const docEntry of doc) {
    const key = def.keyOf(docEntry);
    let baseEntry, baseOrigin;
    if (userMap.has(key)) { baseEntry = userMap.get(key); baseOrigin = 'user'; }
    else if (builtinMap.has(key)) { baseEntry = builtinMap.get(key); baseOrigin = 'builtin'; }
    else continue; // 比較相手が無い新規材は差分なし
    const diffFields = diffEntries(kind, baseEntry, docEntry);
    if (diffFields.length === 0) continue;
    result.set(key, { baseOrigin, diffFields, baseEntry });
  }
  return result;
}

/** docDiffMap(kind, builtinList) のうち key のエントリの diffFields。無ければ null。 */
export function docDiffFields(kind, key, builtinList) {
  return docDiffMap(kind, builtinList).get(key)?.diffFields ?? null;
}

/**
 * ステップ6b（4.7 合わせ直し）: 文書同梱（doc）から key のエントリを1件外す。
 * setOverlay(kind, { doc: doc.filter(...), user }) の薄いラッパ——user は触らない。
 * 次の保存で（doc が外れた分）builtin/user の内容が同梱し直される（saveMaterialCatalogDocument
 * は overlay 合成結果から束を作るため自然にそうなる）。
 * doc に key のエントリが無ければ日本語例外（削除UIの「無いものを消そうとした」誤操作を防ぐ）。
 */
export function removeDocEntry(kind, key) {
  const def = kindDef(kind);
  const { doc, user } = overlayFor(kind);
  if (!doc.some(e => def.keyOf(e) === key)) {
    throw new Error(`文書同梱に無いキーです: ${key}`);
  }
  setOverlay(kind, { doc: doc.filter(e => def.keyOf(e) !== key), user });
}
