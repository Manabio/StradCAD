// ================================================================
// カタログ保守（ReadonlyKindTab）の作図プレビュー登録表（純関数・葉）。
//
// kind → プレビュー生成関数の唯一の定義箇所。CatalogPreview.jsx（描画専用）は本ファイル経由でのみ
// primitives を得る——memberFigure/buildOpeningElevation/buildOpeningPlanSymbol の直書きはコンポーネント
// 側でしない。ui/eccentricityFigure.js / ui/kneeDropWallFigure.js と同じ「純関数でプリミティブを返す」
// 形式だが、こちらは既存の断面図/建具姿図/平面記号ジェネレータへ委譲する薄い配線層。react は import しない。
//
// 建具種別（OPENING_SUB_TYPE）は view: 'plan' を渡すと、姿図（elevation。既定）に加えて平面記号
// プレビューも返す（ステップ11f）。壁厚は本番の平面と同じ式（下地材の厚み＋面材の厚み×2。
// finish/edgeComposition.js wallDimsWithのwallBase+wallFinish*2と同じ）で導出する（QA指摘・
// 2026-09-23裁定A）。材料カタログ（finish/materials/materialData.js）は本体マスタのため、9b/10hと
// 同じDI型——本ファイルは静的importせず、呼び出し側（CatalogMaintenancePanel.jsx）が動的importで
// 読み込んだ一覧をmaterialListとして注入する（独立チャンクのコード分割を崩さないため）。境界マスター
// （layers合計）は使わない——QA指摘2026-09-23裁定Aで廃止（boundaryListは本ファイル・呼び出し側の
// どちらにも存在しない）。
// ================================================================

import { CatalogKind, kindDef, KIND_LABELS } from '../catalog/catalogKinds.js';
import { composeList } from '../catalog/catalogRegistry.js';
import { memberFigure } from '../structural/sectionFigure/memberFigures.js';
import { buildOpeningElevation } from '../openings/openingElevationFigure.js';
import { buildOpeningPlanSymbol } from '../openings/openingPlanSymbol.js';
import { LodLevel } from '../viewport.js';
import {
  LINE_WEIGHT_MM, DEFAULT_EXTERIOR_WALL_BACKING, DEFAULT_INTERIOR_WALL_BACKING, DEFAULT_WALL_MATERIAL,
} from '../core.js';
import { DEFAULT_WALL_BASE, DEFAULT_WALL_FINISH } from '../finish/wallGeneration.js';

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

// kind → 生成関数（view省略時＝姿図）。material/interiorMaster/boundaryMasterはここに載らない
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
 * kindが持つ作図ビューの一覧（'elevation'=姿図・断面図等の唯一のビュー、'plan'=平面記号）。
 * 未知kindはkindDefの例外をそのまま伝播する。
 * @param {string} kind
 * @returns {string[]} プレビューを持たないkindは空配列。
 */
export function catalogPreviewViews(kind) {
  kindDef(kind);
  if (kind === CatalogKind.OPENING_SUB_TYPE) return ['elevation', 'plan'];
  return PREVIEW_BUILDERS[kind] ? ['elevation'] : [];
}

// ================================================================
// 建具種別（OPENING_SUB_TYPE）平面記号プレビュー（ステップ11f）。
//
// openings/openingPlanSymbol.js buildOpeningPlanSymbol をダミーの水平開口・水平壁で1回呼び、
// 結果のプリミティブ（line/polyline/rect/arc。role・weightMm・dash（mm数値配列）付き。ワールドmm）を
// AutoScaledFigure.jsx の既知語彙（structural/sectionFigure/sectionGeometry.js）へ変換する。
// ================================================================

// ダミー開口の壁からの突き出し（mm）。プレビュー側だけの装飾——buildOpeningPlanSymbolの
// 出力ではない（設計裁定Q3。左右の壁の切れ端）。
const PREVIEW_WALL_STUB_MM = 300;

// materialListが無い・下地材/面材が引けないときの既定壁厚。wallGeneration.js の既定壁生成
// （wallBase=90 の両側にwallFinish=12.5ずつ）と同じ値——内壁・外壁とも同じ既定材（後述の
// previewBackingCodeFor参照）に落ちるため単一の値になる（既存コードの唯一の「壁厚の既定値」）。
const PREVIEW_DEFAULT_WALL_THICKNESS_MM = DEFAULT_WALL_BASE + DEFAULT_WALL_FINISH * 2;

// 材1件の「壁を横断する方向」の厚(mm)。finish/edgeComposition.js materialThicknessと同じ規約
// （下地材は断面の大きい辺、面材・仕上げは厚そのもの）——相互参照: finish/edgeComposition.js
// materialThickness側のコメントにも本関数への参照あり（DI複製の理由）。materialData.jsを静的
// importしないDI方針（ファイル冒頭コメント）のため、ここでは規約だけを複製する（materialList側の
// category文字列'backing'はfinish/materials/materialData.js MATERIAL_CATEGORY.BACKINGと同じ値。
// 値そのものは固定済みで変わらない）。
function previewMaterialThicknessMm(mat) {
  if (!mat) return 0;
  if (mat.category === 'backing') return mat.thickness ?? Math.max(mat.x ?? 0, mat.y ?? 0);
  return mat.thickness ?? 0;
}

// 建具種別entryが外壁に置けるか（wallKinds. getFittingOptionsと同じ`!wallKinds || wallKinds.includes
// ('exterior')`の判定。窓はwallKinds未指定＝両方に出せる＝外壁扱い）で、ダミー壁の下地材コードを
// 選ぶ。鋼製/非鋼製は記号だけでは決まらない（defaultFixtureSymbolForはcategory='fitting'なら
// AD/WD、'window'なら常にAWしか返さず、S系記号は新規配置の既定にならない）ため、種別が外壁に
// 置けるか＝外壁の下地材、で読み替える（QA指摘・2026-09-23裁定B。維持）。
function previewBackingCodeFor(entry) {
  const wallKinds = Array.isArray(entry?.wallKinds) ? entry.wallKinds : null;
  const exteriorCapable = !wallKinds || wallKinds.includes('exterior');
  return exteriorCapable ? DEFAULT_EXTERIOR_WALL_BACKING : DEFAULT_INTERIOR_WALL_BACKING;
}

/**
 * 壁厚(mm) = 下地材の厚み + 面材の厚み×2（本番の平面と同じ式。finish/edgeComposition.js
 * wallDimsWithのwallBase(=下地材厚)+wallFinish(=面材厚+室側仕上げ厚。既定0)*2と同じ——
 * QA指摘・2026-09-23裁定A）。下地材コードはpreviewBackingCodeFor、面材は常にDEFAULT_WALL_MATERIAL。
 * materialListが無い・下地材/面材のどちらかが引けなければnull（呼び出し側が既定値へ落とす）。
 */
function resolveWallThicknessMm(backingCode, materialList) {
  if (!Array.isArray(materialList)) return null;
  const materialByCode = new Map(materialList.map(m => [m.code, m]));
  const backing = materialByCode.get(backingCode);
  const panel = materialByCode.get(DEFAULT_WALL_MATERIAL);
  if (!backing || !panel) return null;
  const total = previewMaterialThicknessMm(backing) + previewMaterialThicknessMm(panel) * 2;
  return Number.isFinite(total) && total > 0 ? total : null;
}

/**
 * 建具種別entryのダミー壁厚(mm)。materialListはoverlay込み（catalog/catalogRegistry.js
 * composeList。ユーザーがライブラリへ追加・編集した材料を壁厚導出にも反映する。Minor-1の
 * 非対称回帰防止——overlayが空ならbuiltinと同じ配列を返すため無変化）。
 * @returns {number}
 */
function previewWallThicknessFor(entry, materialList) {
  const backingCode = previewBackingCodeFor(entry);
  const composedMaterials = Array.isArray(materialList) ? composeList(CatalogKind.MATERIAL, materialList) : null;
  return resolveWallThicknessMm(backingCode, composedMaterials) ?? PREVIEW_DEFAULT_WALL_THICKNESS_MM;
}

// [x1,y1,x2,y2, ...]（openings/openingPlanSymbol.js polylinePrimの座標配列）→[[x,y], ...]。
function pairPoints(flat) {
  const pts = [];
  for (let i = 0; i < flat.length; i += 2) pts.push([flat[i], flat[i + 1]]);
  return pts;
}

// dash（mm数値配列|undefined）→AutoScaledFigureのdash語彙（'dashed'|undefined）。模様（mm間隔）は
// 再現しない——sectionGeometry.js語彙はon/offの2値しか持たない。
function previewDashOf(dash) {
  return Array.isArray(dash) && dash.length > 0 ? 'dashed' : undefined;
}

// weightMm（LINE_WEIGHT_MM。0.13〜0.5）→AutoScaledFigureのwidth（medium=1pxを基準にした比。
// QA指摘・2026-09-23裁定C）: thin/medium≈0.52・medium/medium=1・thick/medium=1.4・
// ultraThick/medium=2。生のmm値をそのままpxへ渡すと構造断面図の既存primitive（幅1〜5px）に対して
// 一様に細すぎるため、medium(=中線)を1pxに正規化した比で渡す。
function previewLineWidth(weightMm) {
  return Number.isFinite(weightMm) ? weightMm / LINE_WEIGHT_MM.medium : undefined;
}

// arc(cx,cy,r,startDeg,sweepDeg)→5°刻みの折れ線点列（AutoScaledFigureはarc型を持たないため）。
// 角度規約はopenings/openingPlanSymbolGeometry.js angleVectorsと同じ（x=cos,y=sin、度、
// sweepDegの符号どおりの向き）。
function arcToPoints(cx, cy, r, startDeg, sweepDeg) {
  const steps = Math.max(1, Math.ceil(Math.abs(sweepDeg) / 5));
  const points = [];
  for (let i = 0; i <= steps; i += 1) {
    const deg = startDeg + (sweepDeg * i) / steps;
    const rad = (deg * Math.PI) / 180;
    points.push([cx + r * Math.cos(rad), cy + r * Math.sin(rad)]);
  }
  return points;
}

/**
 * openings/openingPlanSymbol.js のプリミティブ語彙（line/polyline/rect/arc。ワールドmm、
 * role・weightMm・dash付き）を AutoScaledFigure.jsx の既知typeへ変換する。
 * - line → 2点polyline（AutoScaledFigureのline型はL字の外角閉じ（figureLineJoin.js）が掛かるため、
 *   建具記号の独立した線分にはそのまま使わない）。
 * - polyline → 座標をペア化するだけ。
 * - rect → 閉じたpolylineへ変換（dash有無に関わらず。AutoScaledFigureの'rect'型は太さ1px固定
 *   ——QA指摘・2026-09-23裁定Cにより、rectもpolylineへ揃えてwidth制御を効かせる）。
 * - arc → 5°刻みのpolyline。
 * weightMmはpolyline化した全primitiveへ`previewLineWidth`で正規化した`width`として渡す。
 * @param {object[]} primitives buildOpeningPlanSymbolの戻り値
 * @returns {object[]} AutoScaledFigure互換のprimitives
 */
export function planSymbolToFigurePrimitives(primitives) {
  return primitives.map(p => {
    const width = previewLineWidth(p.weightMm);
    const dash = previewDashOf(p.dash);
    switch (p.type) {
      case 'line':
        return { type: 'polyline', points: [[p.x1, p.y1], [p.x2, p.y2]], closed: false, width, dash };
      case 'polyline':
        return { type: 'polyline', points: pairPoints(p.points), closed: !!p.closed, width, dash };
      case 'rect': {
        const pts = [[p.x, p.y], [p.x + p.w, p.y], [p.x + p.w, p.y + p.h], [p.x, p.y + p.h]];
        return { type: 'polyline', points: pts, closed: true, width, dash };
      }
      case 'arc':
        return { type: 'polyline', points: arcToPoints(p.cx, p.cy, p.r, p.startDeg, p.sweepDeg), closed: false, width, dash };
      default:
        throw new TypeError(`planSymbolToFigurePrimitives: 未知のprimitive type「${p.type}」`);
    }
  });
}

// ダミー壁の切れ端（左右300mm）を表す上下2本の面線（2点polyline。設計裁定Q3）。
function previewWallStubPrimitives(width, thicknessMm) {
  const x1 = -PREVIEW_WALL_STUB_MM, x2 = width + PREVIEW_WALL_STUB_MM;
  const half = thicknessMm / 2;
  return [
    { type: 'polyline', points: [[x1, -half], [x2, -half]], closed: false },
    { type: 'polyline', points: [[x1, half], [x2, half]], closed: false },
  ];
}

// 建具種別（OPENING_SUB_TYPE）の平面記号プレビュー。水平壁（isVertical:false）・軸0・開き戸は
// 室内（下＝y>0）側へ開く（hingeSide:-1, swingSide:+1）・exteriorDirOf:上が屋外（-1）固定
// （設計裁定Q3）。scaleは常にnull——姿図（openingSubTypePreview）と同じくAutoScaledFigure側の
// 省略時計算（chooseScale）に委ねる。
function openingSubTypePlanPreview(entry, { materialList } = {}) {
  if (!entry || !isNonEmptyString(entry.key) || !isNonEmptyString(entry.category)) {
    return { ok: false, reason: '建具種別エントリのkey/categoryが不正です（プレビューできません）' };
  }
  const width = entry.defaultWidth > 0 ? entry.defaultWidth : 800;
  const thicknessMm = previewWallThicknessFor(entry, materialList);
  const opening = {
    coord1: 0, coord2: width, centerCoord: width / 2, width, isVertical: false,
    hingeSide: -1, swingSide: 1, category: entry.category, subType: entry.key,
    lineWeight: LINE_WEIGHT_MM.medium, frameDepth: 0,
  };
  const ctx = {
    entry, lodLevel: LodLevel.STANDARD, axisValue: 0,
    faceLo: -thicknessMm / 2, faceHi: thicknessMm / 2,
    exteriorDirOf: () => -1,
  };
  const planPrimitives = buildOpeningPlanSymbol(opening, ctx);
  const primitives = [
    ...previewWallStubPrimitives(width, thicknessMm),
    ...planSymbolToFigurePrimitives(planPrimitives),
  ];
  return { ok: true, primitives, scale: null };
}

/**
 * kind・entry から作図プレビューのプリミティブ（AutoScaledFigure互換）を組み立てる。
 * 未知kindはkindDefの例外をそのまま伝播する（黙って空を返さない）。
 * @param {string} kind CatalogKindのいずれか
 * @param {object} entry カタログエントリ（保存済み・未保存ドラフトのどちらでもよい）
 * @param {{ frame?: { maxWidth: number, maxHeight: number }, view?: 'elevation'|'plan',
 *   materialList?: object[] }} [opts]
 *   view省略（既定）は従来の姿図・断面図。'plan'は建具種別のみ（平面記号）。materialListは'plan'の
 *   ダミー壁厚導出に使う（未指定なら既定壁厚に落ちる。CatalogMaintenancePanel.jsxが動的importで
 *   読み込んだbuiltin一覧を渡す想定のDI引数）。
 * @returns {{ ok: true, primitives: object[], scale: number|null } | { ok: false, reason: string }}
 */
export function buildCatalogPreview(kind, entry, { frame, view, materialList } = {}) {
  kindDef(kind); // 未知kindはここで例外を投げる（登録表の唯一の権威）
  if (view != null && view !== 'elevation' && view !== 'plan') {
    return { ok: false, reason: `未知の作図ビューです: ${view}` };
  }
  if (view === 'plan') {
    if (kind !== CatalogKind.OPENING_SUB_TYPE) {
      return { ok: false, reason: `${KIND_LABELS[kind]}は平面記号プレビューを持ちません` };
    }
    return openingSubTypePlanPreview(entry, { materialList });
  }
  const builder = PREVIEW_BUILDERS[kind];
  if (!builder) {
    // kindDef(kind)を通過済み＝登録済みkindのため、KIND_LABELS[kind]は必ず存在する
    // （QA指摘Nit-1・2026-09-23: `?? kind`フォールバックは到達不能だったため外す）。
    return { ok: false, reason: `${KIND_LABELS[kind]}は作図プレビューを持ちません` };
  }
  return builder(entry, { frame });
}
