// ================================================================
// 起動時の同梱カタログ照合（ステップ6-1）— 文書同梱（doc）エントリをアプリ側（user+builtin）と
// 照合し、読み替え（alias）・ライブラリ追加（add）・通知（adopt-doc/proposals）へ振り分ける。
//
// 純モジュール（葉）。同ディレクトリの兄弟モジュール（catalogKinds.js・catalogMatch.js・
// codeNormalization.js・catalogRegistry.js）にのみ依存する（catalogImports.test.js の許可リストに
// 従う）。I/O（IDB永続化）は applyReconcilePlan の呼び出し側が commitUserFn/addAliasesFn として
// 注入する——catalogOverlayLoader.js/catalogMaintenance.js と同じDI型。removeDocEntryFn は
// I/Oではないoverlay操作だが同じ注入口を使う（既定は catalogRegistry.js の本物。テストが
// overlayに触れずに呼び出し確認できるようにする）。
// ================================================================

import { CatalogKind, kindDef, KIND_LABELS } from './catalogKinds.js';
import { classifyIncoming, assertNoDuplicate, displayNameOf } from './catalogMatch.js';
import { addDocumentAliases, SNAPSHOT_REF_WALKERS } from './codeNormalization.js';
import { overlayFor, removeDocEntry, setOverlay } from './catalogRegistry.js';
import { FIXTURE_SYMBOL_DETAIL_FIGURES_FIELD } from '../core/constants.js';

/**
 * 文書同梱（docEntries）を appEntries（user+builtin。docは含まない）と照合し、
 * classifyIncoming の結果を種類ごとに集約する。
 * - same: 内容一致（何もしない）→ key のみ集める
 * - adoptDoc: 同キーだが内容不一致（U1=参照は外さない。通知のみ）→ {key, diffFields, notify, label}
 * - aliases: キー不一致だが内容完全一致（自動読み替え）→ {from, to}
 * - proposals: キー不一致・部分一致（承認UI行き。6-3で使用）→ classifyIncomingの'propose'結果
 * - adds: 一致なし（ライブラリへ追加候補）→ docEntry本体
 * - unsupported: 登録表の isSupported(entry) フックが false を返したエントリ（現状 material は未定義
 *   のため常に空。将来種別向けの足場）
 * @param {{ kind: string, docEntries: object[], appEntries: object[], origins?: Map<string,string> }} args
 * @returns {{ same: string[], adoptDoc: Array<{key:string, diffFields:string[], notify:boolean, label:string}>,
 *             aliases: Array<{from:string, to:string}>, proposals: Array<object>, adds: object[],
 *             unsupported: object[] }}
 */
export function planIncomingReconcile({ kind, docEntries, appEntries, origins }) {
  const def = kindDef(kind);
  const same = [];
  const adoptDoc = [];
  const aliases = [];
  const proposals = [];
  const adds = [];
  const unsupported = [];
  // 参照の書換え先が無い種別（walker の rewrite が null）は読み替え（alias）を積めない
  // （積むと addDocumentAliases が例外）。alias／propose は作らず、同梱を別物として扱う（add）。
  // 現在は全種別が rewrite を持つので当たる種別は無い（部分詳細図は S6a で rewrite を得た）。将来の種別の安全弁。
  const cannotAlias = SNAPSHOT_REF_WALKERS[kind]?.rewrite === null;

  for (const docEntry of docEntries ?? []) {
    if (typeof def.isSupported === 'function' && !def.isSupported(docEntry)) {
      unsupported.push(docEntry);
      continue;
    }
    let result = classifyIncoming(kind, docEntry, appEntries, origins);
    if (cannotAlias && (result.action === 'alias' || result.action === 'propose')) {
      result = { action: 'add', entry: docEntry };
    }
    switch (result.action) {
      case 'same':
        same.push(result.key);
        break;
      case 'adopt-doc':
        adoptDoc.push({
          key: result.key, diffFields: result.diffFields, notify: result.notify,
          label: displayNameOf(docEntry),
        });
        break;
      case 'alias':
        aliases.push({ from: result.from, to: result.to });
        break;
      case 'propose':
        proposals.push({ from: result.from, candidates: result.candidates, entry: docEntry });
        break;
      case 'add':
        adds.push(result.entry);
        break;
      default:
        throw new Error(`未知のclassifyIncoming actionです: ${result.action}`);
    }
  }

  return { same, adoptDoc, aliases, proposals, adds, unsupported };
}

/** names（表示名の配列。空文字は除く）を「最大2件＋ほかN件」の1文へ整形する。空なら空文字。 */
function namesLine(names) {
  const filtered = names.filter(Boolean);
  if (filtered.length === 0) return '';
  const shown = filtered.slice(0, 2);
  const rest = filtered.length - shown.length;
  return rest > 0 ? `${shown.join('・')}ほか${rest}件` : shown.join('・');
}

/**
 * plan（planIncomingReconcileの戻り値）から利用者向けの通知文を1本に組み立てる。
 * 3セクション（不一致・追加・読み替え）＋追加のスキップ補足を1本にまとめる。0件のセクションは
 * 省略し、全セクションが0件ならnull。名称は最大2件＋「ほかN件」。
 * - 不一致: adoptDocのうちnotify:trueのものの件数。
 * - 追加: addedCount（呼び出し側が applyReconcilePlan の結果=result.addedKeys.length を渡す。
 *   plan.adds.length ではなく実際に追加された件数——重複禁止で弾かれたものを「追加されました」と
 *   誤って報告しないため）。skippedCount が非空なら追加のスキップ件数を1文足す
 *   （呼び出し側が result.skipped.length を渡す）。
 * - 読み替え: plan.aliases の件数（alias適用は保存until確定なので「保存すると確定します」を添える）。
 * kind は必須（ステップ7d QA指摘Minor-1・2026-09-23: 7aの「既定でmaterialに落とさない」規約と
 * 揃える。省略は日本語例外）。文言の名詞は KIND_LABELS[kind] へ出し分ける。読み替え文の対象語は
 * material＝「コード」／他種別＝「キー」（store.js saveCatalogDocument の同梱できないメッセージと
 * 同じ出し分け。ステップ7c踏襲）。
 * @param {ReturnType<typeof planIncomingReconcile>} plan
 * @param {{ kind: string, addedCount?: number, skippedCount?: number }} opts
 * @returns {string|null}
 */
export function formatReconcileNotice(plan, { kind, addedCount = 0, skippedCount = 0 } = {}) {
  if (!kind) {
    throw new Error('formatReconcileNoticeはkindの指定が必須です（省略できません）');
  }
  const mismatches = (plan?.adoptDoc ?? []).filter(d => d.notify);
  const aliasCount = plan?.aliases?.length ?? 0;
  const parts = [];
  const label = KIND_LABELS[kind] ?? kind;
  const noun = kind === CatalogKind.MATERIAL ? 'コード' : 'キー';

  if (mismatches.length > 0) {
    const names = namesLine(mismatches.map(d => d.label));
    parts.push(`同梱カタログと内容が異なる${label}が${mismatches.length}件あります${names ? `（${names}）` : ''}`);
  }
  if (addedCount > 0) {
    const names = namesLine((plan?.adds ?? []).map(displayNameOf));
    parts.push(`ライブラリに新しい${label}が${addedCount}件追加されました${names ? `（${names}）` : ''}`);
  }
  if (skippedCount > 0) {
    parts.push(`${skippedCount}件は同じ内容の${label}が既にあるため追加しませんでした`);
  }
  if (aliasCount > 0) {
    parts.push(`${label}${noun}の読み替えを${aliasCount}件適用しました（保存すると確定します）`);
  }
  if (parts.length === 0) return null;
  return parts.join('。');
}

/**
 * 部分詳細図の読み替え（from→to）を、同梱（overlay の doc 層）の建具記号・建具種別エントリの detailFigures の値へ反映する
 * （カタログ→カタログの参照。スナップショットの openings[].detailRefs は walker の rewrite が受け持つ）。
 * ライブラリ層（user）の記号は触らない。書き換えがあれば doc を差し替える（無ければ overlay に触れない）。
 * @param {Array<{from:string,to:string}>} pairs
 */
export function rewriteDocSymbolDetailFigures(pairs) {
  const table = new Map((pairs ?? []).map(({ from, to }) => [from, to]));
  if (table.size === 0) return;
  // 建具記号（方立・上枠）と建具種別（姿図。S6b）の両方が detailFigures を持つ
  for (const kind of [CatalogKind.FIXTURE_SYMBOL, CatalogKind.OPENING_SUB_TYPE]) {
    const { doc, user } = overlayFor(kind);
    let changedAny = false;
    const nextDoc = doc.map(entry => {
      const refs = entry?.[FIXTURE_SYMBOL_DETAIL_FIGURES_FIELD];
      if (refs === null || typeof refs !== 'object' || Array.isArray(refs)) return entry;
      let changed = false;
      const nextRefs = {};
      for (const [slot, key] of Object.entries(refs)) {
        const to = typeof key === 'string' ? table.get(key) : undefined;
        nextRefs[slot] = to ?? key;
        if (to !== undefined) changed = true;
      }
      if (!changed) return entry;
      changedAny = true;
      return { ...entry, [FIXTURE_SYMBOL_DETAIL_FIGURES_FIELD]: nextRefs };
    });
    if (changedAny) setOverlay(kind, { doc: nextDoc, user });
  }
}

/**
 * plan（planIncomingReconcileの戻り値）を実際に反映する。
 * - aliases: addAliasesFn(plan.aliases) を（非空なら）1回呼ぶ——文書固有の読み替え表へ追記する。
 *   続けて、alias確定した doc エントリ（from＝そのdocEntry自身のキー）を removeDocEntryFn(kind, from)
 *   で overlay の doc から外す（QA指摘Major-1・2026-09-23: 読み替えは「参照をどのキーへ向けるか」を
 *   決めるだけで、docエントリ自体を overlay に残すと、内容完全一致のまま別キーで builtin/user と
 *   併存することになり、合成後の重複禁止検査が「同内容が複数キーで存在する」として例外を
 *   投げる——仕上げモードinit・壁再生成・保存が軒並み止まり、利用者に直す手段が無くなる。
 *   次の保存では overlay 合成結果から束を作るため、doc を外した分は自然に消える）。
 *   from が（既に外れている等で）doc に無い場合は何もしない（無いキーの例外を投げさせない）。
 * - adds: 重複禁止（assertNoDuplicate。dedupeFields完全一致）に弾かれた追加は例外を投げず skipped へ積み、
 *   onSkipped(entry, error) を呼ぶ（複数のdocEntryが互いに同一内容を持つ場合の保険。planning時点の
 *   appEntriesには無かったため'add'判定されたが、adds同士が重複することはあり得るため）。
 *   弾かれなかった追加は currentUser へ積み上げ、1件以上あれば commitUserFn(nextUser) を1回呼ぶ
 *   （呼び出し側が既存の commitUserEntries 等へ委譲する）。
 * @param {ReturnType<typeof planIncomingReconcile>} plan
 * @param {{ kind: string, currentUser: object[],
 *           commitUserFn: (nextUser: object[]) => Promise<void>,
 *           addAliasesFn?: (kind: string, pairs: Array<{from:string,to:string}>) => void,
 *           removeDocEntryFn?: (kind: string, key: string) => void,
 *           rewriteDocRefsFn?: (pairs: Array<{from:string,to:string}>) => void,
 *           onSkipped?: (entry: object, error: Error) => void }} args
 * @returns {Promise<{ addedKeys: string[], aliasPairs: Array<{from:string,to:string}>, skipped: Array<{entry:object, reason:string}> }>}
 */
export async function applyReconcilePlan(plan, {
  kind, currentUser, commitUserFn, addAliasesFn = addDocumentAliases,
  removeDocEntryFn = removeDocEntry, rewriteDocRefsFn = rewriteDocSymbolDetailFigures, onSkipped,
}) {
  const def = kindDef(kind);

  if (plan.aliases.length > 0) {
    addAliasesFn(kind, plan.aliases);
    // QA指摘Major-1: alias確定したdocエントリはoverlayに残さない（doc起源のキーだけを対象に、
    // 現在のoverlay.docに実在するものだけremoveDocEntryFnへ渡す）。
    const docKeys = new Set(overlayFor(kind).doc.map(e => def.keyOf(e)));
    for (const { from } of plan.aliases) {
      if (docKeys.has(from)) removeDocEntryFn(kind, from);
    }
    // 部分詳細図: 外した同梱を指す同梱側の建具記号の割当て（カタログ→カタログの参照）も読み替える。
    // スナップショット側（openings[].detailRefs）は addAliasesFn の表を walker の rewrite が引く。
    if (kind === CatalogKind.DETAIL_FIGURE) rewriteDocRefsFn(plan.aliases);
  }

  let nextUser = currentUser;
  const addedKeys = [];
  const skipped = [];
  for (const entry of plan.adds) {
    try {
      // nextUser（ライブラリ）としか比べない。本体（builtin）とは比べない: detailFigure の本体は固定キー（df-builtin-…）の組込みだけで、
      // 取り込む図とキーが衝突しない前提。本体を持つ rewrite:null 種別を足すときは builtin とも比べること。
      assertNoDuplicate(kind, entry, nextUser);
    } catch (e) {
      skipped.push({ entry, reason: e.message });
      onSkipped?.(entry, e);
      continue;
    }
    nextUser = [...nextUser, entry];
    addedKeys.push(def.keyOf(entry));
  }

  // 読み替え（alias）を積めない種別では、重複で追加を弾いた同梱を overlay の doc に残すと、
  // 合成後の重複禁止が毎回例外になり以後の保存が止まる——alias 確定時と同じく doc から外す
  // （参照されていても、保存時の回収（store.js saveCatalogDocument の recoverUnresolvedEntries）で
  // 同梱に温存される）。現在は当たる種別が無い安全弁。
  if (SNAPSHOT_REF_WALKERS[kind]?.rewrite === null && skipped.length > 0) {
    const docKeys = new Set(overlayFor(kind).doc.map(e => def.keyOf(e)));
    for (const { entry } of skipped) {
      const key = def.keyOf(entry);
      if (docKeys.has(key)) removeDocEntryFn(kind, key);
    }
  }

  if (addedKeys.length > 0) await commitUserFn(nextUser);

  return { addedKeys, aliasPairs: plan.aliases, skipped };
}
