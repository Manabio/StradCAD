// 構造リストの S造スラブ（SteelSlab）カードの「仕様」ブロックの純モジュール（S造スラブ指定 S6・2026-10-29）。
// .jsx は node:test から import できないため、判断（RC 欄を出すか・行・状態表示・編集の確定内容）をここに置いてテストで固定する。
// 行の構築は共通タブと同じ steelSlabCommonRows（commonInfoTabSlabModel.js）に委譲する（行表を二重に持たない）。
// import は steelSlabSpec.js / commonInfoTabSlabModel.js だけ（store.js / snap.js / .jsx を静的に引かない）。
import {
  STEEL_SLAB_KIND_LABELS, resolveSteelSlabSpec, projectToKind, normalizeSteelSlabSpec,
  foldIntoCommon, steelSlabSpecEquals, defaultSteelSlabSpec, isSteelSlabLike,
} from './steelSlabSpec.js';
import { steelSlabCommonRows, planSlabEdit } from './commonInfoTabSlabModel.js';

/** 仕様ブロックの見出し。 */
export const SLAB_CARD_SPEC_TITLE = '仕様';
/** 状態行の文言。 */
export const SLAB_CARD_STATUS_COMMON = '共通仕様に従う';
export const SLAB_CARD_STATUS_INDIVIDUAL = '個別指定';
/** 折りたたみ行で個別指定のときに種別名へ付ける接尾。 */
export const SLAB_CARD_INDIVIDUAL_SUFFIX = '（個別）';
/** カードの members の仕様が揃っていないときに状態行へ付ける接尾。 */
export const SLAB_CARD_MIXED_SUFFIX = '（仕様が混在）';
/** 個別指定を捨てて共通へ戻すボタンの文言。 */
export const SLAB_CARD_REVERT_LABEL = '共通に戻す';

/**
 * カードに RC 用のフィールド定義（厚・種別・デッキ方向・配筋）を出すか。ベイ指定の SteelSlab は出さず仕様ブロックを出す
 * （基底の thickness 等は SteelSlab では使わない。正は steelSpec と共通仕様）。
 */
export function slabCardFields(entity, fieldDefs) {
  return isSteelSlabLike(entity) ? [] : fieldDefs;
}

/** 折りたたみ行のサマリー。種別名（個別指定なら「（個別）」付き）。基底の厚みは出さない。 */
export function steelSlabSummary(slab, common) {
  const spec = resolveSteelSlabSpec(slab?.steelSpec, common);
  return `${STEEL_SLAB_KIND_LABELS[spec.kind] ?? spec.kind}${slab?.steelSpec ? SLAB_CARD_INDIVIDUAL_SUFFIX : ''}`;
}

/**
 * ブレース設置高さの注記（読取専用）。clamped（指定値が子梁成を超えた）は「上限 N に丸め」、
 * 自動（null）は「子梁成 N → 自動 M」、指定が収まっているときは「子梁成 N → M」。
 * @param {{childDepthMm:number, resolvedMm:number, clamped:boolean}} info steelSlabBays.js steelSlabBraceHeightInfo
 * @param {object} spec 実効仕様
 */
export function braceHeightNote(info, spec) {
  const height = info.clamped
    ? `上限 ${info.childDepthMm} に丸め`
    : `子梁成 ${info.childDepthMm} → ${spec?.braceHeightMm == null ? '自動 ' : ''}${info.resolvedMm}`;
  // 対角線長が上限を超えるベイ（短辺が上限以上・U1 の n 固定）があれば同じ行へ足す。
  return info.exceededBays > 0 ? `${height}／対角線長が上限を超えるベイ ${info.exceededBays}（短辺が上限以上、または記録で分割数が固定）` : height;
}

/**
 * 仕様ブロックの表示内容。行は実効仕様（個別があれば個別、無ければ共通を種別へ絞ったもの）から作る。
 * braceInfo（steelSlabBraceHeightInfo の結果。ブレースのスラブだけ渡す）があれば、設置高さの行に注記（note）を付ける。
 * @returns {{ individual: boolean, statusLabel: string, kindRow: object, rows: object[], showRevert: boolean }}
 */
export function steelSlabCardView({ slab, common, materials, members, braceInfo = null }) {
  const individual = slab?.steelSpec != null;
  const spec = resolveSteelSlabSpec(slab?.steelSpec, common);
  const { kindRow, rows: baseRows } = steelSlabCommonRows({ spec, materials });
  const rows = braceInfo
    ? baseRows.map(r => (r.key === 'braceHeightMm' ? { ...r, note: braceHeightNote(braceInfo, spec) } : r))
    : baseRows;
  const mixed = slabMembersMixed(members ?? [slab]);
  return {
    individual,
    mixed,
    statusLabel: (individual ? SLAB_CARD_STATUS_INDIVIDUAL : SLAB_CARD_STATUS_COMMON) + (mixed ? SLAB_CARD_MIXED_SUFFIX : ''),
    kindRow, rows,
    showRevert: individual || mixed,
  };
}

/**
 * カードの1項目の編集を検証し、書き込む steelSpec を返す。
 * - 実効仕様から始め、検証・数値化・差分は共通タブと同じ planSlabEdit に任せる。
 * - 種別の変更は共通仕様のその種別の値から始める（個別の他種別の値を持ち越さない）。
 * - 個別形へ正規化（カタログ照合なし。編集していない項目の消えたコードを既定へ落とさない＝S5 の教訓）し、
 *   共通と同じ内容なら null（個別を捨てて共通へ戻る。問題.md「共通仕様と全く同じ仕様になったら個別扱いを削除」）。
 * @returns {{ error: string|null, nextSpec: object|null|undefined }}
 *   nextSpec: undefined＝書かない（検証エラー・変化なし）／null＝共通へ戻す／object＝個別仕様。
 */
export function planSteelSlabCardEdit({ slab, common, key, value, materials, members }) {
  const r = planEditFromRepresentative({ slab, common, key, value, materials });
  // 仕様が混在するカードで代表と同じ値を確定したときは、代表の値を返して全員を揃える。
  if (!r.error && r.nextSpec === undefined && members && slabMembersMixed(members)) {
    return { error: null, nextSpec: slab?.steelSpec ?? null };
  }
  return r;
}

function planEditFromRepresentative({ slab, common, key, value, materials }) {
  const current = slab?.steelSpec ?? null;
  const resolved = resolveSteelSlabSpec(current, common);
  const { error, patch } = planSlabEdit({ spec: resolved, key, value, materials });
  if (error) return { error, nextSpec: undefined };
  if (patch === null) return { error: null, nextSpec: undefined };
  const candidate = key === 'kind'
    ? projectToKind(common ?? defaultSteelSlabSpec(), patch.kind)
    : { ...resolved, ...patch };
  const normalized = normalizeSteelSlabSpec(candidate, { mode: 'individual' });
  const nextSpec = foldIntoCommon(normalized, common);
  // 共通に従っているスラブの編集が結局共通と同じ（折り返し）なら何も変わらない。
  if (nextSpec === null ? current === null : steelSlabSpecEquals(nextSpec, current)) return { error: null, nextSpec: undefined };
  return { error: null, nextSpec };
}

const sameSpec = (a, b) => steelSlabSpecEquals(a ?? null, b ?? null); // null 同士（共通に従う）も等しい

/** カードの members の steelSpec が揃っていないか（統合・手動番号で違うスラブが同じカードに入りうる）。 */
export function slabMembersMixed(members) {
  return members.some(m => !sameSpec(m.steelSpec, members[0].steelSpec));
}

/** nextSpec を全 members へ書いても何も変わらないか（混在していれば代表と同じ値でも書く＝全員を揃える）。 */
export function slabWriteIsNoop(members, nextSpec) {
  return members.every(m => sameSpec(m.steelSpec, nextSpec));
}

/** 「共通に戻す」。個別指定のときだけ null（共通へ）、既に共通なら undefined（書かない）。 */
export function planSteelSlabRevert(slab, members) {
  return slab?.steelSpec != null || (members && slabMembersMixed(members)) ? null : undefined;
}
