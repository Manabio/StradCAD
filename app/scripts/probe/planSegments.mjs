// ShapesLayer.jsx の壁描画（詳細LOD）を、Konvaを使わず「世界座標の線分」へ写す。
// 描画結果の回帰比較・不良検出（貫通・分割・多重書き）の入力に使う。製品コードからは参照しない。
import { ShapeType } from '../../src/core.js';
import { LodLevel } from '../../src/viewport.js';
import { buildWallDrawPlan } from '../../src/renderer/wallDrawPlan.js';

/**
 * @returns {Array<{key:string, kind:string, wallId:string, vertical:boolean, at:number, lo:number, hi:number}>}
 *   vertical=true は「線が縦（y方向）に走る」。at=x、lo/hi=y範囲。
 */
export function planWallSegments(graph, lodLevel = LodLevel.DETAIL) {
  const { kneeDropOverlays, wallLines, wallStuds } = buildWallDrawPlan(graph, lodLevel);
  const out = [];
  const push = (key, kind, wallId, vertical, at, lo, hi, extra = {}) => {
    if (!(hi - lo > 1e-9)) return;
    out.push({ key, kind, wallId, vertical, at: r(at), lo: r(lo), hi: r(hi), ...extra });
  };
  const r = (v) => Math.round(v * 1000) / 1000;

  for (const shape of graph.generalShapes) {
    if (shape.type !== ShapeType.WALL) continue;
    const plan = wallLines.get(shape.id);
    if (!plan) continue;
    const vert = shape.isVertical;
    const { segments, lines } = plan;

    if (lodLevel === LodLevel.SCHEMATIC) {
      segments.forEach(([a, b], i) => push(`${shape.id}:${i}`, 'single', shape.id, vert, shape.axisValue, a, b));
      continue;
    }
    // 仕上げ材の線（面線・妻線・内側線・木口線）と天板の輪郭（kd/kdcap）: ShapesLayer.jsx と同じ写像。
    lines.forEach((l, i) => push(`${shape.id}:${l.kind}:${i}`, l.kind, shape.id, l.vertical, l.at, l.lo, l.hi,
      l.style ? { ids: l.ids, style: l.style } : { ids: l.ids }));
    if (kneeDropOverlays?.has(shape.id)) continue; // 天板の壁に下地スタッドは無い
    // 下地スタッドの位置・材厚は wallDrawPlan.js → wallStudLayout.js が解決済み（ShapesLayer.jsx と同じ写像）。
    const studs = wallStuds.get(shape.id);
    if (!studs) continue;
    const backingBand = shape.backingRange;
    const backingDepth = backingBand.hi - backingBand.lo;
    const halfWidth = studs.depth / 2;
    const centerV = (backingBand.lo + backingBand.hi) / 2;
    for (const p of studs.centers) {
      out.push({ key: `${shape.id}:stud:${p}`, kind: 'stud', wallId: shape.id, vertical: vert,
        at: r(centerV), lo: r(p - halfWidth), hi: r(p + halfWidth), depth: r(backingDepth) });
    }
  }
  out.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  return out;
}
