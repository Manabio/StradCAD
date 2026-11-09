/**
 * 敷地の配置を解く純関数（配置図の「頂点1＋通り芯からの距離」指定 → 変換 {rotationDeg, tx, ty}）。
 * 変換の意味は applySiteTransform（p' = R(rotationDeg)·p + (tx, ty)）。
 * store.js・snap.js・.jsx・structural/ を静的に import しない（node:test から単体で import できる）。
 */
import { CenterLineType, DEG_TO_RAD, FULL_TURN_DEG, HALF_TURN_DEG } from '../core/constants.js';
import { applySiteTransform } from './sitePlacementView.js';

// 通り芯の向き（度。x 軸正から y 下向き正の座標系で測る）。VERTICAL＝x=value の縦線、HORIZONTAL＝y=value の横線。
const AXIS_ANGLE_DEG = Object.freeze({
  [CenterLineType.VERTICAL]: 90,
  [CenterLineType.HORIZONTAL]: 0,
});

/** 角度（度）を (−180, 180] へ正規化する。 */
export function normalizeAngle180(deg) {
  return deg - FULL_TURN_DEG * Math.ceil((deg - HALF_TURN_DEG) / FULL_TURN_DEG);
}

/** 向きを持たない直線の角度（度）を (−90, 90] へ正規化する（180 度違いは同じ直線）。 */
export function normalizeLineAngle90(deg) {
  return deg - HALF_TURN_DEG * Math.ceil((deg - HALF_TURN_DEG / 2) / HALF_TURN_DEG);
}

/**
 * 頂点1の像の位置・線分の向き・通り芯からの距離から、敷地の変換を解く。
 *  1. 線分 v1→v2 を通り芯と平行にする回転（平行な2解のうち絶対値の小さい方。rotationFlipped で半周足す）
 *  2. 頂点1の像の直交座標＝通り芯の値 ± distance（建物図芯の反対側。図芯が無ければ前回の像と同じ側。sideFlipped で反転）
 *  3. 頂点1の像の通り芯沿いの座標＝前回の変換で写した頂点1の当該座標
 *  4. 平行移動＝頂点1の像 − R·v1
 * @param {object} p
 * @param {{x:number,y:number}} p.v1 敷地座標の頂点1（距離を測る端）
 * @param {{x:number,y:number}} p.v2 敷地座標の頂点2（線分の向きを決める端）
 * @param {{centerLineType:string, value:number}} p.centerLine 基準の通り芯
 * @param {number} p.distance 頂点1の像から通り芯までの距離（mm。正）
 * @param {boolean} p.rotationFlipped 回転を半周反転
 * @param {boolean} p.sideFlipped 通り芯のどちら側かを反転
 * @param {{x:number,y:number}|null} p.buildingCenter 建物の図芯（配置図座標）。無ければ null
 * @param {{rotationDeg:number, tx:number, ty:number}} p.prevTransform 直前の変換（沿い座標・図芯なしの側の既定に使う）
 * @returns {{rotationDeg:number, tx:number, ty:number}|null} 解けない入力（線分の長さ 0・距離が不正・通り芯の種別が不明・座標や値が非有限）は null
 */
export function computeSitePlacement({ v1, v2, centerLine, distance, rotationFlipped, sideFlipped, buildingCenter, prevTransform }) {
  const axisDeg = AXIS_ANGLE_DEG[centerLine?.centerLineType];
  if (axisDeg === undefined) return null;
  if (!Number.isFinite(distance) || distance <= 0) return null;
  // 頂点の座標・通り芯の値が非有限なら解かない（NaN の変換を site.placement に保存すると敷地が黙って消えるため）
  if (![v1?.x, v1?.y, v2?.x, v2?.y, centerLine.value].every(Number.isFinite)) return null;
  if (v1.x === v2.x && v1.y === v2.y) return null;

  const segDeg = Math.atan2(v2.y - v1.y, v2.x - v1.x) / DEG_TO_RAD;
  let rotationDeg = normalizeLineAngle90(axisDeg - segDeg);
  if (rotationFlipped) rotationDeg = normalizeAngle180(rotationDeg + HALF_TURN_DEG);

  const isVertical = centerLine.centerLineType === CenterLineType.VERTICAL;
  const { value } = centerLine;
  const prevImage = applySiteTransform(v1, prevTransform ?? { rotationDeg: 0, tx: 0, ty: 0 });
  const prevOrtho = isVertical ? prevImage.x : prevImage.y;
  const prevAlong = isVertical ? prevImage.y : prevImage.x;

  let sign;
  if (buildingCenter) {
    const centerOrtho = isVertical ? buildingCenter.x : buildingCenter.y;
    sign = centerOrtho > value ? -1 : 1;
  } else {
    sign = prevOrtho < value ? -1 : 1;
  }
  if (sideFlipped) sign = -sign;

  const orthoImage = value + sign * distance;
  const image = isVertical ? { x: orthoImage, y: prevAlong } : { x: prevAlong, y: orthoImage };

  const rad = rotationDeg * DEG_TO_RAD;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  return {
    rotationDeg,
    tx: image.x - (v1.x * cos - v1.y * sin),
    ty: image.y - (v1.x * sin + v1.y * cos),
  };
}
