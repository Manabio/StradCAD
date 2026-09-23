// ================================================================
// カタログ保守（ReadonlyKindTab）の作図プレビュー登録表（純関数・葉）。
//
// kind → プレビュー生成関数の唯一の定義箇所。CatalogPreview.jsx（描画専用）は本ファイル経由でのみ
// primitives を得る——memberFigure/buildOpeningElevation の直書きはコンポーネント側でしない。
// ui/eccentricityFigure.js / ui/kneeDropWallFigure.js と同じ「純関数でプリミティブを返す」形式だが、
// こちらは既存の断面図/建具姿図ジェネレータへ委譲する薄い配線層。react は import しない。
// ================================================================

import { CatalogKind, kindDef, KIND_LABELS } from '../catalog/catalogKinds.js';
import { memberFigure } from '../structural/sectionFigure/memberFigures.js';
import { buildOpeningElevation } from '../openings/openingElevationFigure.js';

function isNonEmptyString(v) { return typeof v === 'string' && v.length > 0; }

// 断面（SECTION）: 柱の平断面（columnMap）として描く。entry.key を resolveSection の権威で
// 直接返す——保存済み(overlay登録済み)エントリでも未保存ドラフトでも同じ注入経路に一本化する
// （ctx.rigid は渡さない＝偏芯・柱芯線は出さない素の断面のみ）。
function sectionPreview(entry, { frame } = {}) {
  if (!entry || !isNonEmptyString(entry.key)) {
    return { ok: false, reason: '断面エントリのkeyが不正です（プレビューできません）' };
  }
  const ctx = { frame, resolveSection: key => (key === entry.key ? entry : null) };
  const { primitives, scale } = memberFigure({ sectionDefId: entry.key }, 'columnMap', ctx);
  return { ok: true, primitives, scale: scale ?? null };
}

// 建具種別（OPENING_SUB_TYPE）: ダミー opening（幅・高さのみエントリの既定値から補い、寸法線・
// 動作線は出さない）を建具モードの姿図ジェネレータへそのまま渡す。buildOpeningElevation は
// core.js の Opening インスタンスを要求しない（ダックタイピングで足りる。openingNumbering.test.js
// と同じ方針）。openingElevationFigure.js は frame/scale の仕組みを持たない（frameは無視される）ため
// scaleは常にnullを返し、AutoScaledFigure側の省略時計算（chooseScale。sectionGeometry.js）に委ねる
// ——ここで同じ計算を複製しない（QA指摘Minor-1・2026-09-23）。
function openingSubTypePreview(entry) {
  if (!entry || !isNonEmptyString(entry.key) || !isNonEmptyString(entry.category)) {
    return { ok: false, reason: '建具種別エントリのkey/categoryが不正です（プレビューできません）' };
  }
  const opening = {
    category: entry.category, subType: entry.key,
    width: entry.defaultWidth, height: entry.defaultHeight,
    hingeSide: -1, sillHeight: 0,
  };
  const primitives = buildOpeningElevation(opening, { tag: null, entry, includeDims: false });
  return { ok: true, primitives, scale: null };
}

// kind → 生成関数。material/interiorMaster/boundaryMasterはここに載らない
// （buildCatalogPreviewがKIND_LABELSから理由文を組み立てる。黙って空にしない）。
const PREVIEW_BUILDERS = Object.freeze({
  [CatalogKind.SECTION]:          sectionPreview,
  [CatalogKind.OPENING_SUB_TYPE]: openingSubTypePreview,
});

/** 作図プレビューを持つカタログ種別の一覧（PREVIEW_BUILDERSから導出）。 */
export function catalogPreviewKinds() {
  return Object.keys(PREVIEW_BUILDERS);
}

/**
 * kind・entry から作図プレビューのプリミティブ（AutoScaledFigure互換）を組み立てる。
 * 未知kindはkindDefの例外をそのまま伝播する（黙って空を返さない）。
 * @param {string} kind CatalogKindのいずれか
 * @param {object} entry カタログエントリ（保存済み・未保存ドラフトのどちらでもよい）
 * @param {{ frame?: { maxWidth: number, maxHeight: number } }} [opts]
 * @returns {{ ok: true, primitives: object[], scale: number|null } | { ok: false, reason: string }}
 */
export function buildCatalogPreview(kind, entry, { frame } = {}) {
  kindDef(kind); // 未知kindはここで例外を投げる（登録表の唯一の権威）
  const builder = PREVIEW_BUILDERS[kind];
  if (!builder) {
    // kindDef(kind)を通過済み＝登録済みkindのため、KIND_LABELS[kind]は必ず存在する
    // （QA指摘Nit-1・2026-09-23: `?? kind`フォールバックは到達不能だったため外す）。
    return { ok: false, reason: `${KIND_LABELS[kind]}は作図プレビューを持ちません` };
  }
  return builder(entry, { frame });
}
