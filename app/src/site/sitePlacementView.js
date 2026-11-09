/**
 * 敷地モードの配置図（屋根伏せ図＋図芯合わせした敷地の外周）の描画プリミティブを組む純モジュール。
 * renderer/SitePlacementLayer.jsx がこの結果を写すだけで描く（判断はここに集める）。modes/SiteModeState.js が composeSitePlacementView を呼ぶ。
 * store.js・snap.js・.jsx・structural/roofFramingRegions.js（storage を推移的に引く）を静的に import しない（node:test から単体で import できる）。
 * 屋根の region の解決（leanToPlanRegions・topRoofPlanRegions）は呼び出し側（SiteModeState）が行い、ここへは region を渡す。
 *
 * 屋根伏せ図は全採用階の下屋＋最上階の主屋根・屋根区画の線（roofPlanRegionFigure の lines。role は捨てて全部同じ細線。傾斜ラベルは出さない）。
 * 敷地は外周（三斜＝computeOuterLineIds の線、長方形＝computeOutlinePieces）と外周の角の丸だけ。内側の線・番号バッジ・赤青端点は出さない。
 * 図芯合わせ: 建物側の図芯＝屋根の線の外接矩形の中心（屋根が無ければ通り芯の範囲の中心・それも無ければ合わせない）、敷地側＝敷地の外周の外接矩形の中心。
 * 敷地を dx,dy だけ平行移動して2つの図芯を重ねる。回転（rotationDeg）は今回 0 固定だが、写像の口（applySiteTransform・siteTransformGroupProps）は
 * 回転を含む形で1つだけ持つ（回転の指定は今後。pivot＝敷地の図芯まわりに回す）。
 */
import { SitePlacementCenterSource, SITE_LOG_TAG, DEG_TO_RAD } from '../core/constants.js';
import { roofPlanRegionFigure } from '../finish/roof/roofPlanFigure.js';
import { computeOuterLineIds, computeOuterCornerPoints } from './lineClassification.js';
import { computeOutlinePieces, computeOutlineCorners } from './siteRectGeometry.js';
import { composeSitePlacementGrid } from './sitePlacementGrid.js';

// Konva の key の組み立て部品。種別ごとの id 空間の衝突を避けるためだけに付け、比較には使わない。
const SITE_PLACEMENT_KEY_PREFIX = Object.freeze({ LEAN: 'l', RECT: 'r', POINT: 'p', CORNER: 'c' });

/**
 * 全採用階の屋根の線。region ごとに握り、例外の region は failedCount に数えて残りは描く（facade/facadeRoof.js と同じ握り方）。
 * @param {Array<{planeId:string, regions:object[]}>} floors
 * @returns {{lines: Array<{key:string, points:number[], closed:boolean}>, failedCount:number}}
 */
export function roofPlanLines(floors) {
  const lines = [];
  let failedCount = 0;
  for (const { planeId, regions } of floors ?? []) {
    for (const region of regions ?? []) {
      try {
        roofPlanRegionFigure(region).lines.forEach((l, i) => {
          lines.push({ key: `${planeId}/${region.key}/${i}`, points: l.points, closed: l.closed });
        });
      } catch (err) {
        console.warn(`${SITE_LOG_TAG} 屋根の region「${region?.key}」の線を組めませんでした（その region は描かない）:`, err);
        failedCount++;
      }
    }
  }
  return { lines, failedCount };
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

const centerOf = b => (b ? { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 } : null);

/**
 * 配置図の描画プリミティブ一式。
 * @param {object} p
 * @param {object} p.site 敷地（lines・points・rects）
 * @param {{floors: Array<{planeId:string, regions:object[]}>, gridBounds: {minX,minY,maxX,maxY}|null, gridLines?: object[], readFailed:boolean}|null} p.roof
 * @returns {{
 *   roofLines: Array<{key:string, points:number[], closed:boolean}>, roofFailedCount: number, roofEmpty: boolean,
 *   siteSegments: Array<{key:string, points:number[]}>, siteCorners: Array<{key:string, x:number, y:number}>,
 *   buildingCenter: {x:number,y:number}|null, centerSource: string, siteCenter: {x:number,y:number}|null,
 *   grid: ReturnType<typeof composeSitePlacementGrid>,
 *   siteTransform: {dx:number, dy:number, rotationDeg:number, pivotX:number, pivotY:number},
 * }}
 */
export function composeSitePlacementView({ site, roof }) {
  const { lines: roofLines, failedCount: roofFailedCount } = roofPlanLines(roof?.floors ?? []);
  const siteSegments = siteOutlineSegments(site);
  const siteCorners = siteOutlineCorners(site);

  const roofBounds = boundsOfPointLists(roofLines.map(l => l.points));
  const gridBounds = roof?.gridBounds ?? null;
  const buildingBounds = roofBounds ?? gridBounds;
  const centerSource = roofBounds ? SitePlacementCenterSource.ROOF
    : gridBounds ? SitePlacementCenterSource.GRID : SitePlacementCenterSource.NONE;
  const buildingCenter = centerOf(buildingBounds);
  const siteCenter = centerOf(boundsOfPointLists(siteSegments.map(s => s.points)));

  const aligned = buildingCenter && siteCenter;
  return {
    roofLines, roofFailedCount, roofEmpty: roofLines.length === 0,
    siteSegments, siteCorners,
    buildingCenter, centerSource, siteCenter,
    // 通り芯の線・丸ラベル・寸法（図芯の基準 gridBounds とは別の入力。ここから図芯は求めない）
    grid: composeSitePlacementGrid({ gridLines: roof?.gridLines ?? [], roofBounds }),
    siteTransform: {
      dx: aligned ? buildingCenter.x - siteCenter.x : 0,
      dy: aligned ? buildingCenter.y - siteCenter.y : 0,
      rotationDeg: 0,
      pivotX: siteCenter?.x ?? 0,
      pivotY: siteCenter?.y ?? 0,
    },
  };
}

/** 敷地の座標 pt を配置図の座標へ写す: p → R(p−pivot)+pivot+d（R は rotationDeg の回転。y 下向き正の座標系での標準の回転行列）。 */
export function applySiteTransform(pt, t) {
  const rad = t.rotationDeg * DEG_TO_RAD;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const rx = pt.x - t.pivotX, ry = pt.y - t.pivotY;
  return {
    x: t.pivotX + t.dx + rx * cos - ry * sin,
    y: t.pivotY + t.dy + rx * sin + ry * cos,
  };
}

/** applySiteTransform と同じ写像を Konva の Group の props で表す（x,y＝pivot＋d、offset＝pivot で pivot まわりに回す）。 */
export function siteTransformGroupProps(t) {
  return { x: t.pivotX + t.dx, y: t.pivotY + t.dy, offsetX: t.pivotX, offsetY: t.pivotY, rotation: t.rotationDeg };
}
