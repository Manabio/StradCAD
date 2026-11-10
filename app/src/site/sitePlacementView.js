/**
 * 敷地モードの配置図（屋根伏せ図＋図芯合わせした敷地の外周）の描画プリミティブを組む純モジュール。
 * renderer/SitePlacementLayer.jsx がこの結果を写すだけで描く（判断はここに集める）。modes/SiteModeState.js が composeSitePlacementView を呼ぶ。
 * store.js・snap.js・.jsx・structural/roofFramingRegions.js（storage を推移的に引く）を静的に import しない（node:test から単体で import できる）。
 * 屋根の region の解決（leanToPlanRegions・topRoofPlanRegions）は呼び出し側（SiteModeState）が行い、ここへは region を渡す。
 *
 * 屋根伏せ図は全採用階の下屋＋最上階の主屋根・屋根区画の線（roofPlanRegionFigure の lines。role は捨てて全部同じ細線。傾斜ラベルは出さない）。
 * 敷地は外周（三斜＝computeOuterLineIds の線、長方形＝computeOutlinePieces）と外周の角の丸だけ。内側の線・番号バッジ・赤青端点は出さない。
 * 図芯合わせ: 建物側の図芯＝屋根の線の外接矩形の中心（屋根が無ければ通り芯の範囲の中心・それも無ければ合わせない）、敷地側＝敷地の外周の外接矩形の中心。
 * 配置の指定（site.placement）が無ければ、敷地を tx,ty だけ平行移動して2つの図芯を重ねる（回転 0）。あればその {rotationDeg, tx, ty} を使う（placed:true）。
 * 写像は p' = R(rotationDeg)·p + (tx, ty)（原点まわりの回転＋平行移動。pivot は持たない＝敷地の図芯は形で動くため）。
 * 写像の口（applySiteTransform・siteTransformGroupProps）は site/siteTransform.js だけが持つ（ここからは再 export しない）。
 */
import { SitePlacementCenterSource, SITE_LOG_TAG, LEAN_TO_REGION_KEY_PREFIX, CL_OVERLAP_TOL_MM } from '../core/constants.js';
import { samePlacementVertex } from './sitePlacementVertex.js';
import { roofPlanRegionFigure } from '../finish/roof/roofPlanFigure.js';
import { clipRoofLinesByCovers } from '../finish/roof/roofPlanClip.js';
import { computeOuterLineIds, computeOuterCornerPoints } from './lineClassification.js';
import { computeOutlinePieces, computeOutlineCorners } from './siteRectGeometry.js';
import { composeSitePlacementGrid } from './sitePlacementGrid.js';
import { boundaryPieces, mergeCollinearPieces, layoutBoundaryLabels } from './siteBoundaryLabels.js';
import { composeBoundaryChains } from './siteBoundaryChain.js';
import { applySiteTransform } from './siteTransform.js';

// Konva の key の組み立て部品。種別ごとの id 空間の衝突を避けるためだけに付け、比較には使わない。
const SITE_PLACEMENT_KEY_PREFIX = Object.freeze({ LEAN: 'l', RECT: 'r', POINT: 'p', CORNER: 'c' });

const isLeanRegion = region => typeof region?.key === 'string' && region.key.startsWith(LEAN_TO_REGION_KEY_PREFIX);
// 壊れた region（outline を読むと例外）は隠す側に使わない（その region 自身の線は region ごとの握りで failedCount に数える）
const outlineRingsOf = region => {
  try { return region?.outline ?? []; } catch { return []; }
};

/**
 * 全採用階の屋根の線。region ごとに握り、例外の region は failedCount に数えて残りは描く（facade/facadeRoof.js と同じ握り方）。
 * 下屋の線は上にある屋根の軒先線（region.outline）の内側を描かない（隠れる部分を止める）。上にある屋根＝(a) 主屋根・屋根区画（下屋でない region。
 * 最上階だけに出る）の全部、(b) 自分より order が大きい階の下屋。同じ階（order が同じ・無い）の下屋どうしは高さの上下が決まらないので切らない。
 * 主屋根・屋根区画の線は切らない。
 * @param {Array<{planeId:string, order?:number, regions:object[]}>} floors order＝階の下→上の順位（大きいほど上。SiteModeState が plane.elevation を付ける）
 * @returns {{lines: Array<{key:string, points:number[], closed:boolean}>, rawLines: Array<{key:string, points:number[], closed:boolean}>, failedCount:number}}
 *   lines＝切った後（描く線）・rawLines＝切る前（図芯・枠の基準。配置の基準は隠れる線も含める）
 */
export function roofPlanLines(floors) {
  const list = floors ?? [];
  // 隠す側は region ごとの閉路の組のまま持つ（clipRoofLinesByCovers が組の和集合で判定。重なる屋根が偶奇で打ち消し合わない）
  const mainRings = list.flatMap(f => (f.regions ?? []).filter(r => !isLeanRegion(r)).map(outlineRingsOf));
  const lines = [];
  const rawLines = [];
  let failedCount = 0;
  for (const { planeId, order, regions } of list) {
    const covers = [...mainRings];
    if (Number.isFinite(order)) {
      for (const f of list) {
        if (Number.isFinite(f.order) && f.order > order) covers.push(...(f.regions ?? []).filter(isLeanRegion).map(outlineRingsOf));
      }
    }
    for (const region of regions ?? []) {
      try {
        const figureLines = roofPlanRegionFigure(region).lines;
        const clipped = isLeanRegion(region) ? clipRoofLinesByCovers(figureLines, covers, CL_OVERLAP_TOL_MM) : figureLines;
        figureLines.forEach((l, i) => rawLines.push({ key: `${planeId}/${region.key}/${i}`, points: l.points, closed: l.closed }));
        clipped.forEach((l, i) => lines.push({ key: `${planeId}/${region.key}/${i}`, points: l.points, closed: l.closed }));
      } catch (err) {
        console.warn(`${SITE_LOG_TAG} 屋根の region「${region?.key}」の線を組めませんでした（その region は描かない）:`, err);
        failedCount++;
      }
    }
  }
  return { lines, rawLines, failedCount };
}

/**
 * 敷地の外周の線分（三斜の外周線＋長方形群の外周片）。
 * @returns {Array<{key:string, points:[number,number,number,number]}>}
 */
export function siteOutlineSegments(site) {
  const outerIds = computeOuterLineIds(site);
  const sansha = site.lines.filter(l => outerIds.has(l.id)).map(l => ({
    key: `${SITE_PLACEMENT_KEY_PREFIX.LEAN}/${l.id}`,
    points: [l.startPoint.x, l.startPoint.y, l.endPoint.x, l.endPoint.y],
  }));
  const rect = computeOutlinePieces(site.rects).map((p, i) => ({
    key: `${SITE_PLACEMENT_KEY_PREFIX.RECT}/${p.rectId}/${p.side}/${i}`,
    points: [p.a.x, p.a.y, p.b.x, p.b.y],
  }));
  return [...sansha, ...rect];
}

/**
 * 敷地の外周の角（境界線の角の丸を置く点。三斜＝外周が2本以上集まる点、長方形＝水平片と垂直片の端点が重なる点）。
 * @returns {Array<{key:string, x:number, y:number}>}
 */
export function siteOutlineCorners(site) {
  const outerIds = computeOuterLineIds(site);
  const sansha = computeOuterCornerPoints(site, outerIds).map(p => ({ key: `${SITE_PLACEMENT_KEY_PREFIX.POINT}/${p.id}`, x: p.x, y: p.y }));
  const rect = computeOutlineCorners(computeOutlinePieces(site.rects)).map((c, i) => ({ key: `${SITE_PLACEMENT_KEY_PREFIX.CORNER}/${i}`, x: c.x, y: c.y }));
  return [...sansha, ...rect];
}

/**
 * 折れ線の点列（[x,y,x,y,…]）の集まりの外接矩形。点が1つも無ければ null。
 * @param {Array<number[]>} pointLists
 * @returns {{minX:number, minY:number, maxX:number, maxY:number}|null}
 */
export function boundsOfPointLists(pointLists) {
  let b = null;
  for (const pts of pointLists) {
    for (let i = 0; i + 1 < pts.length; i += 2) {
      const x = pts[i], y = pts[i + 1];
      if (!b) b = { minX: x, minY: y, maxX: x, maxY: y };
      else {
        if (x < b.minX) b.minX = x;
        if (y < b.minY) b.minY = y;
        if (x > b.maxX) b.maxX = x;
        if (y > b.maxY) b.maxY = y;
      }
    }
  }
  return b;
}

/**
 * 敷地の外周の線分を配置図の座標へ写す（枠 siteBounds と、はなれ寸法の測り先に使う同じ点列）。
 * @param {Array<{points:number[]}>} segments 敷地座標の線分（[x1,y1,x2,y2]）
 * @param {{rotationDeg:number, tx:number, ty:number}} transform
 * @returns {Array<{points:[number,number,number,number]}>}
 */
export function placeSiteSegments(segments, transform) {
  return segments.map(s => {
    const a = applySiteTransform({ x: s.points[0], y: s.points[1] }, transform);
    const b = applySiteTransform({ x: s.points[2], y: s.points[3] }, transform);
    return { points: [a.x, a.y, b.x, b.y] };
  });
}

const centerOf = b => (b ? { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 } : null);

/**
 * 配置図の描画プリミティブ一式。
 * @param {object} p
 * @param {object} p.site 敷地（lines・points・rects）
 * @param {{floors: Array<{planeId:string, order?:number, regions:object[]}>, gridBounds: {minX,minY,maxX,maxY}|null, gridLines?: object[], readFailed:boolean}|null} p.roof
 * @returns {{
 *   roofLines: Array<{key:string, points:number[], closed:boolean}>, roofFailedCount: number, roofEmpty: boolean,
 *   siteSegments: Array<{key:string, points:number[]}>, siteCorners: Array<{key:string, x:number, y:number}>,
 *   buildingCenter: {x:number,y:number}|null, centerSource: string, siteCenter: {x:number,y:number}|null,
 *   grid: ReturnType<typeof composeSitePlacementGrid>,
 *   boundaryPieces: ReturnType<typeof mergeCollinearPieces>,
 *   siteTransform: {rotationDeg:number, tx:number, ty:number},
 *   placed: boolean,
 * }}
 */
export function composeSitePlacementView({ site, roof }) {
  const { lines: roofLines, rawLines: roofRawLines, failedCount: roofFailedCount } = roofPlanLines(roof?.floors ?? []);
  const siteSegments = siteOutlineSegments(site);
  const siteCorners = siteOutlineCorners(site);

  // 図芯・枠は切る前の線から（隠れる部分も含めた建物の範囲。配置の基準は S12 の前と変えない）
  const roofBounds = boundsOfPointLists(roofRawLines.map(l => l.points));
  const gridBounds = roof?.gridBounds ?? null;
  const buildingBounds = roofBounds ?? gridBounds;
  const centerSource = roofBounds ? SitePlacementCenterSource.ROOF
    : gridBounds ? SitePlacementCenterSource.GRID : SitePlacementCenterSource.NONE;
  const buildingCenter = centerOf(buildingBounds);
  const siteCenter = centerOf(boundsOfPointLists(siteSegments.map(s => s.points)));

  const aligned = buildingCenter && siteCenter;
  const placement = site.placement ?? null;
  const siteTransform = placement
    ? { rotationDeg: placement.rotationDeg, tx: placement.tx, ty: placement.ty }
    : { rotationDeg: 0, tx: aligned ? buildingCenter.x - siteCenter.x : 0, ty: aligned ? buildingCenter.y - siteCenter.y : 0 };
  // 配置図座標での敷地の外周の外接矩形（通り芯の線と丸ラベルを敷地の外へ出すための枠）。敷地が無ければ null
  const siteSegmentsPlaced = placeSiteSegments(siteSegments, siteTransform);
  const siteBounds = boundsOfPointLists(siteSegmentsPlaced.map(s => s.points));
  return {
    roofLines, roofFailedCount, roofEmpty: roofLines.length === 0,
    siteSegments, siteCorners,
    buildingCenter, centerSource, siteCenter,
    // 通り芯の線・丸ラベル・寸法（図芯の基準 gridBounds とは別の入力。ここから図芯は求めない）
    grid: composeSitePlacementGrid({ gridLines: roof?.gridLines ?? [], roofBounds, siteBounds, siteSegmentsPlaced }),
    // 境界線ラベルの片（敷地座標・結合済み。字の位置は scale に依るのでレイヤーが layoutBoundaryLabels で出す）
    boundaryPieces: mergeCollinearPieces(boundaryPieces(site)),
    siteTransform,
    placed: placement !== null,
  };
}

/**
 * 他モードの 1 階（相当）へ重ねる敷地の境界線（境界線の runs・角の丸・境界線ラベル）。屋根・通り芯・寸法・頂点番号は含めない。
 * 配置の指定（site.placement）が無ければ null（重ねない）。変換は指定どおり（図芯合わせはしない）。
 * @param {{site: object, scale: number}} p scale＝viewport.scaleX
 * @returns {{
 *   transform: {rotationDeg:number, tx:number, ty:number},
 *   chains: ReturnType<typeof composeBoundaryChains>,
 *   corners: Array<{key:string, x:number, y:number}>,
 *   labels: ReturnType<typeof layoutBoundaryLabels>,
 * }|null} chains・corners は敷地座標（transform の Group の中）、labels は配置図座標
 */
export function composeSiteBoundaryOverlay({ site, scale }) {
  const placement = site.placement ?? null;
  if (!placement) return null;
  const transform = { rotationDeg: placement.rotationDeg, tx: placement.tx, ty: placement.ty };
  const pieces = mergeCollinearPieces(boundaryPieces(site));
  const siteCenter = centerOf(boundsOfPointLists(siteOutlineSegments(site).map(s => s.points)));
  const fallbackCenter = siteCenter ? applySiteTransform(siteCenter, transform) : null;
  return {
    transform,
    chains: composeBoundaryChains(pieces, scale),
    corners: siteOutlineCorners(site),
    labels: layoutBoundaryLabels(pieces, transform, scale, fallbackCenter),
  };
}

// 頂点の一致判定の口は site/sitePlacementVertex.js（保存側 schema からも使うため軽い別モジュール）。ここからも従来どおり引ける
export { samePlacementVertex };

/** pt が配置指定の 1 対目の頂点1なら 1、頂点2なら 2、どちらでもなければ null（input.v1 が優先）。 */
export function placementVertexIndex(input, pt) {
  if (!input) return null;
  if (samePlacementVertex(input.v1, pt)) return 1;
  if (samePlacementVertex(input.v2, pt)) return 2;
  return null;
}

/** pt が 2 対目の頂点1なら 1、頂点2なら 2、どちらでもなければ null（along.v1 が優先）。 */
export function placementAlongVertexIndex(input, pt) {
  const a = input?.along;
  if (!a) return null;
  if (samePlacementVertex(a.v1, pt)) return 1;
  if (samePlacementVertex(a.v2, pt)) return 2;
  return null;
}

// 番号の書式部品（共有の角は「1·1'」のように併記する）
const PLACEMENT_VERTEX_LABEL_SECOND_PAIR_MARK = "'";
const PLACEMENT_VERTEX_LABEL_JOINER = '·';

/**
 * pt の角に付ける番号ラベルの配列（1 対目「1」「2」→ 2 対目「1'」「2'」の順。どの枠でもなければ []）。
 * 共有の角は複数入る。表示は '·' で連結（placementVertexLabelText）。番号の組み立ては 1 か所（ここ）。
 */
export function placementVertexLabels(input, pt) {
  if (!input) return [];
  const labels = [];
  const first = placementVertexIndex(input, pt);
  if (first !== null) labels.push(String(first));
  // 1 対目の頂点1・頂点2 が同じ点でも「1」だけ（placementVertexIndex は v1 優先）。2 対目も同様
  const second = placementAlongVertexIndex(input, pt);
  if (second !== null) labels.push(`${second}${PLACEMENT_VERTEX_LABEL_SECOND_PAIR_MARK}`);
  return labels;
}

/**
 * pt の角の色の種別。1 対目だけ 'first'・2 対目だけ 'second'・両方 'shared'・どれでもなければ null。
 * 描画（SitePlacementLayer）が種別ごとの色へ写す。
 */
export function placementVertexColorKind(input, pt) {
  const inFirst = placementVertexIndex(input, pt) !== null;
  const inSecond = placementAlongVertexIndex(input, pt) !== null;
  if (inFirst && inSecond) return PlacementVertexColorKind.SHARED;
  if (inFirst) return PlacementVertexColorKind.FIRST;
  if (inSecond) return PlacementVertexColorKind.SECOND;
  return null;
}

/** placementVertexColorKind の値。 */
export const PlacementVertexColorKind = Object.freeze({ FIRST: 'first', SECOND: 'second', SHARED: 'shared' });

/** placementVertexLabels を '·' で連結した表示文字列（空配列なら ''）。 */
export function placementVertexLabelText(input, pt) {
  return placementVertexLabels(input, pt).join(PLACEMENT_VERTEX_LABEL_JOINER);
}
