/**
 * 天伏モードの天井セル選択（純モジュール。react・store.js・snap.js・.jsx を静的に引かない）。
 *
 * 選択の単位は「ドラッグでなぞったセルだけ」（矩形の補完はしない。連結も要求しない）。
 * 部屋を超えては選べない: ドラッグ開始セルの所属（owner）と同じ所属のセルだけを足し、他の所属のセルは捨てる
 * （ドラッグは続き、戻れば再び受け付ける）。所属の索引は ceilingOwners.js（選択専用。描画の天井面とは述語 roomHasCeiling だけを共有）。
 * セルは天井セル（仕上げのセルを天井芯でさらに割った格子。ceilingGrid.js）。
 */
import { ceilingRegionCellsAt } from './ceilingGrid.js';
import { withGraphReadScope } from '../graphReadScope.js';

const MAX_SAMPLES = 4096; // 1回の move で補間する点数の上限（極端に小さい stepMm での暴走防止）

const sameOwner = (a, b) => a.kind === b.kind && a.id === b.id;

/**
 * ドラッグ開始。押した点の領域の先頭セルの所属を owner にする。所属なし・格子外・非有限座標は null。
 * @returns {{owner, visited: Map<string, object>, lastWorld: {x:number,y:number}} | null}
 */
export function beginCeilingDrag(graph, owners, wx, wy) {
  if (!Number.isFinite(wx) || !Number.isFinite(wy)) return null;
  return withGraphReadScope(graph, () => {
    const region = ceilingRegionCellsAt(wx, wy, graph);
    if (region.length === 0) return null;
    const owner = owners.get(region[0].key);
    if (!owner) return null;
    const visited = new Map();
    for (const c of region) {
      const o = owners.get(c.key);
      if (o && sameOwner(o, owner)) visited.set(c.key, c);
    }
    return { owner, visited, lastWorld: { x: wx, y: wy } };
  });
}

const insideAny = (visited, x, y) => {
  for (const c of visited.values()) {
    if (x >= c.x1 && x <= c.x2 && y >= c.y1 && y <= c.y2) return true;
  }
  return false;
};

/**
 * ドラッグ継続。lastWorld → (wx, wy) の線分を stepMm 刻みでサンプルし（速い move でセルを飛ばさない）、
 * 同じ所属のセルだけ足す。何も足さなければ同じ drag を返す（lastWorld だけ in place で進める。
 * 進めないと、他所属のセルを通って戻る経路が次回の直線補間で別のセルを横切ってしまう）。
 * 非有限座標は変更なし。stepMm が有限の正数でなければ終点だけを見る。
 */
export function extendCeilingDrag(graph, owners, drag, wx, wy, stepMm) {
  if (!drag || !Number.isFinite(wx) || !Number.isFinite(wy)) return drag;
  const from = drag.lastWorld;
  const dist = Math.hypot(wx - from.x, wy - from.y);
  const n = Number.isFinite(stepMm) && stepMm > 0 ? Math.min(MAX_SAMPLES, Math.max(1, Math.ceil(dist / stepMm))) : 1;
  return withGraphReadScope(graph, () => {
    let visited = drag.visited;
    let added = false;
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const x = from.x + (wx - from.x) * t;
      const y = from.y + (wy - from.y) * t;
      if (insideAny(visited, x, y)) continue;
      for (const c of ceilingRegionCellsAt(x, y, graph)) {
        if (visited.has(c.key)) continue;
        const o = owners.get(c.key);
        if (!o || !sameOwner(o, drag.owner)) continue;
        if (!added) { visited = new Map(visited); added = true; }
        visited.set(c.key, c);
      }
    }
    if (!added) {
      drag.lastWorld = { x: wx, y: wy };
      return drag;
    }
    return { owner: drag.owner, visited, lastWorld: { x: wx, y: wy } };
  });
}
