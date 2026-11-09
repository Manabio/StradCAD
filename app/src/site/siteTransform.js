/**
 * 敷地の配置図の写像（敷地座標 → 配置図座標）の唯一の口。純モジュール。
 * 写像は p' = R(rotationDeg)·p + (tx, ty)（原点まわりの回転＋平行移動。pivot は持たない＝敷地の図芯は形で動くため）。
 */
import { DEG_TO_RAD } from '../core/constants.js';

/** 敷地の座標 pt を配置図の座標へ写す: p → R(rotationDeg)·p + (tx, ty)（y 下向き正の座標系での標準の回転行列）。 */
export function applySiteTransform(pt, t) {
  const rad = t.rotationDeg * DEG_TO_RAD;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  return {
    x: t.tx + pt.x * cos - pt.y * sin,
    y: t.ty + pt.x * sin + pt.y * cos,
  };
}

/** applySiteTransform と同じ写像を Konva の Group の props で表す（x,y＝平行移動、rotation＝原点まわりの回転）。 */
export function siteTransformGroupProps(t) {
  return { x: t.tx, y: t.ty, rotation: t.rotationDeg };
}
