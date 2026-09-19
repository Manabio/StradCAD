// centerLineExtend.js（延長・短縮の境界探索・端点判定）を実データで確認するprobe
// （調査・回帰用。製品コードからは参照しない）。
// 全階×全 center/aux/beam CL×lo/hi について、findExtendBoundary・findShortenBoundary・
// isEndpointAt の結果（相手の種別・座標・端点か否か）を JSON で標準出力へ書き出す。
// 移行前後の出力を保存して差分を取る使い方を想定（相手が非表示の梁芯だったものが可視の通り芯・
// 中心線・補助線へ移る／梁芯主体の相手が通り芯のみになる、以外の差分が無いことを確認する）。
//
// 壁境界（補助線の延長がallowsWallAnchor経由で見る crossingPerpWalls）は、.stq読込み直後の
// 保存状態の壁をそのまま見ている——boot時の壁再生成（finish/wallRegeneration.js等）は通さないため、
// アプリ上で実際に表示される壁と座標が食い違う可能性がある。
//
// 使い方: node --import ./scripts/testSetup.mjs scripts/probe/clExtendBoundaryProbe.mjs [入力.stq]
import { loadDocument } from './loadDoc.mjs';
import { centerLineKind } from '../../src/core/centerLine.js';
import { findExtendBoundary, findShortenBoundary, isEndpointAt } from '../../src/transform/centerLineExtend.js';

const src = process.argv[2] ?? 'D:/tatsuya/Download/moku2-5.stq';
const { project } = loadDocument(src);

// findExtendBoundary/findShortenBoundary の戻り値（{type:'cl'|'wall'|'point', item}|null）を
// JSON化しやすい形へ落とす。item は CenterLine または Wall のどちらかで、比較に要る情報だけ残す。
function describeBoundary(b) {
  if (!b) return null;
  if (b.type === 'point') return { type: 'point' };
  if (b.type === 'wall') return { type: 'wall', value: Math.round(b.item.axisValue) };
  return { type: 'cl', kind: centerLineKind(b.item), value: Math.round(b.item.value), id: b.item.id };
}

const results = [];
for (const plane of project.planes) {
  const graph = project.graphMap.get(plane.id);
  if (!graph) continue;
  for (const cl of graph.centerLines) {
    const kind = centerLineKind(cl);
    if (kind !== 'center' && kind !== 'aux' && kind !== 'beam') continue;
    for (const side of ['lo', 'hi']) {
      results.push({
        plane: plane.name,
        id: cl.id,
        kind,
        centerLineType: cl.centerLineType,
        value: Math.round(cl.value),
        side,
        extentLo: cl.extentLo == null ? null : Math.round(cl.extentLo),
        extentHi: cl.extentHi == null ? null : Math.round(cl.extentHi),
        isEndpoint: isEndpointAt(graph, cl, side),
        extendBoundary: describeBoundary(findExtendBoundary(graph, cl, side)),
        shortenBoundary: describeBoundary(findShortenBoundary(graph, cl, side)),
      });
    }
  }
}

console.log(JSON.stringify(results, null, 2));
