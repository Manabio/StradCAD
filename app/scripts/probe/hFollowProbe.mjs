// 課題(h) h2（cl-conversion-limits.md 限界16 (h)）: 壁由来梁芯の追従（followWallBeamAxes）の結果の実測。
// 目的: 全階を収束まで再計算した後、各階で「壁の軸になっている中心線」を何通りか動かし（±30mm・±300mm・
//   同方向の既存の梁芯／通り芯の座標へ動かす）、commitCLMoveOp と同じ手順（bake 前後の wallBackingCenters →
//   mapBackingCenterMoves → followWallBeamAxes）の結果（moved／absorbed／skipped と行き先）を出す。
//   試行ごとに restoreGraph で元へ戻す（吸収は auto 柱・梁も道連れで撤去し undo では戻らないため）。
//   さらに、壁由来梁芯ごとの合成 moves（同方向の梁芯・通り芯の座標・±30・±300 へ）を followWallBeamAxes へ直接渡す
//   （壁の帯の移動で moves が出るのは偏芯壁などに限られるため、行き先判定そのものを見るにはこちらが本体。synthetic:true）。
//   作業ツリー（h2 の修正後）と HEAD の worktree で同じスクリプトを走らせて差分を取る。
// 簡略化（実アプリとの差）: 結合（mergeCenterLineChain）・開口由来の moves（openingMoves）・構造同期は通さない。
//   h2 が変えるのは followWallBeamAxes の行き先判定だけなので、その入力（moves）と出力を直接見る。
// 引数: <入力.stq> [出力.json]  （出力省略時は標準出力へJSON）
// 前処理: hAnchorCoverageProbe.mjs convergeProject（structAnchorProbe.mjs と同じ前処理）。他階 peek は
//   project.graphMap の生きたグラフ。IDB へは書かない。
// 使い方（ローダー必須。app/ で実行）:
//   node --import ./scripts/testSetup.mjs scripts/probe/hFollowProbe.mjs D:/tatsuya/Download/moku4.stq out.json
// 出力: { src, planes:[{plane,structure,trials:[{cl,dir,from,delta,moves,moved,absorbed,skipped,restored}]}], tally }
//   trials の比較キーは (plane,cl,delta)。cl は中心線 id の先頭8桁（同じ文書なら HEAD と一致する）。
import fs from 'node:fs';
import { runInAction } from 'mobx';
import { loadDocument } from './loadDoc.mjs';
import { wallBackingCenters, mapBackingCenterMoves, findWallBeamAxisCL } from '../../src/structural/wallBeamAxes.js';
import { followWallBeamAxes } from '../../src/structural/wallBeamAxisFollow.js';
import { effectiveStructure } from '../../src/structural/structureRules.js';
import { centerLineKind } from '../../src/core/centerLine.js';
import { CenterLineType } from '../../src/core/constants.js';
import { bakeCLValue } from '../../src/transform/centerLineOps.js';
import { serializeGraph, restoreGraph } from '../../src/graphSnapshot.js';
import { convergeProject, rnd } from './hAnchorCoverageProbe.mjs';

const isMain = !!process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('hFollowProbe.mjs');
const short = (id) => (id ? id.slice(0, 8) : null);

/** 中心線群の安定ダンプ（復元の確認用）。 */
function digest(graph) {
  return JSON.stringify(graph.centerLines.map(cl => [cl.id, cl.centerLineType, rnd(cl.effectiveValue), rnd(cl.extentLo), rnd(cl.extentHi)])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
}

/** 行き先 to（同方向）にある通り芯・梁芯の要約（行き先判定の相手の確認用。種別・由来・extent）。 */
function candidatesAt(graph, centerLineType, to) {
  return graph.centerLines
    .filter(o => o.centerLineType === centerLineType && Math.abs(o.effectiveValue - to) < 0.5 && ['beam', 'struct'].includes(centerLineKind(o)))
    .map(o => `${short(o.id)}:${centerLineKind(o)}:${o.beamAxisOrigin ?? '-'}:[${rnd(o.extentLo)},${rnd(o.extentHi)}]`).sort();
}

/** 1階の試行。 */
export function measureFollow(plane, project) {
  const graph = project.graphMap.get(plane.id);
  const trials = [];
  const axisCLs = [...new Map(graph.walls.map(w => [w.axisCL?.id, w.axisCL]).filter(([id]) => id)).values()]
    .filter(cl => graph.shapeMap.has(cl.id));
  const bytes = serializeGraph(graph);
  const baseDigest = digest(graph);
  for (const cl of axisCLs) {
    const isVertical = cl.centerLineType === CenterLineType.VERTICAL;
    const from = cl.value;
    // 同方向の梁芯・通り芯の座標（異なる値だけ）を行き先候補に加える
    const targets = new Set();
    for (const o of graph.centerLines) {
      if (o.centerLineType !== cl.centerLineType || o.id === cl.id) continue;
      const k = centerLineKind(o);
      if (k !== 'beam' && k !== 'struct') continue;
      if (Math.abs(o.effectiveValue - from) > 0.5) targets.add(Math.round(o.effectiveValue * 10) / 10);
    }
    const deltas = [...new Set([30, -30, 300, -300, ...[...targets].map(t => Math.round((t - from) * 10) / 10)])].sort((a, b) => a - b);
    for (const delta of deltas) {
      let result = null;
      const at = candidatesAt(graph, cl.centerLineType, from + delta);
      try {
        runInAction(() => {
          const before = wallBackingCenters(graph);
          bakeCLValue(cl, from + delta);
          const moves = mapBackingCenterMoves(before, wallBackingCenters(graph));
          const r = followWallBeamAxes(graph, moves);
          const dirOf = (m) => (m.isVertical ? 'V' : 'H');
          result = {
            moves: moves.map(m => `${dirOf(m)}:${rnd(m.from)}->${rnd(m.to)}`).sort(),
            moved: r.moved.map(m => `${short(m.clId)} ${dirOf(m)}:${rnd(m.from)}->${rnd(m.to)}`).sort(),
            absorbed: r.absorbed.map(m => `${short(m.clId)} ${dirOf(m)}:${rnd(m.from)}->${rnd(m.to)}`).sort(),
            skipped: r.skipped.map(m => `${dirOf(m)}:${rnd(m.from)}->${rnd(m.to)} ${m.reason}`).sort(),
          };
        });
      } finally {
        restoreGraph(graph, bytes);
      }
      trials.push({ cl: short(cl.id), dir: isVertical ? 'V' : 'H', from: rnd(from), delta, toCandidates: at, ...result, restored: digest(graph) === baseDigest });
    }
  }
  // 合成 moves（壁の帯の移動を経由せず followWallBeamAxes へ直接渡す）。実アプリでは偏芯壁・refId 子中心線の壁でしか
  // moves は出ない（上の試行は大半が moves 空）ため、述語（行き先判定）が決める量そのものを見るにはこちらが本体。
  // 壁由来梁芯の各座標 from から、同方向の梁芯・通り芯の座標 ＋ ±30 ＋ ±300 へ動かす。
  const seen = new Set();
  for (const cl of graph.centerLines) {
    if (centerLineKind(cl) !== 'beam' || (cl.beamAxisOrigin != null && cl.beamAxisOrigin !== 'wall')) continue; // 壁由来（旧データの由来なしを含む）
    const isVertical = cl.centerLineType === CenterLineType.VERTICAL;
    const from = cl.effectiveValue;
    const key = `${isVertical}:${rnd(from)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const tos = new Set([from + 30, from - 30, from + 300, from - 300]);
    for (const o of graph.centerLines) {
      if (o.centerLineType !== cl.centerLineType || o.id === cl.id) continue;
      const k = centerLineKind(o);
      if (k !== 'beam' && k !== 'struct') continue;
      if (Math.abs(o.effectiveValue - from) > 0.5) tos.add(o.effectiveValue);
    }
    for (const to of [...tos].sort((a, b) => a - b)) {
      let result = null;
      const at = candidatesAt(graph, cl.centerLineType, to);
      const actual = findWallBeamAxisCL(graph, isVertical, from); // followWallBeamAxes が実際に動かす梁芯（同座標に複数あるとき cl とは限らない）
      try {
        runInAction(() => {
          const r = followWallBeamAxes(graph, [{ axisCLId: 'synthetic', isVertical, from, to }]);
          const dirOf = (m) => (m.isVertical ? 'V' : 'H');
          result = {
            moves: [`${dirOf({ isVertical })}:${rnd(from)}->${rnd(to)}`],
            moved: r.moved.map(m => `${short(m.clId)} ${dirOf(m)}:${rnd(m.from)}->${rnd(m.to)}`).sort(),
            absorbed: r.absorbed.map(m => `${short(m.clId)} ${dirOf(m)}:${rnd(m.from)}->${rnd(m.to)}`).sort(),
            skipped: r.skipped.map(m => `${dirOf(m)}:${rnd(m.from)}->${rnd(m.to)} ${m.reason}`).sort(),
          };
        });
      } finally {
        restoreGraph(graph, bytes);
      }
      trials.push({ cl: short(cl.id), dir: isVertical ? 'V' : 'H', from: rnd(from), delta: rnd(to - from), synthetic: true, extentLo: rnd(actual?.extentLo), extentHi: rnd(actual?.extentHi), toCandidates: at, ...result, restored: digest(graph) === baseDigest });
    }
  }
  return { plane: plane.name, structure: effectiveStructure(graph, project), trials };
}

if (isMain) {
  const src = process.argv[2];
  const outPath = process.argv[3] ?? null;
  if (!src) { console.error('usage: hFollowProbe.mjs <in.stq> [out.json]'); process.exit(1); }
  const { project } = loadDocument(src);
  const conv = await convergeProject(project);
  const planes = project.planes.map(p => measureFollow(p, project));
  const tally = { trials: 0, withMoves: 0, moved: 0, absorbed: 0, skipped: 0, notRestored: 0 };
  for (const pl of planes) {
    for (const t of pl.trials) {
      tally.trials++;
      if (t.moves.length) tally.withMoves++;
      tally.moved += t.moved.length; tally.absorbed += t.absorbed.length; tally.skipped += t.skipped.length;
      if (!t.restored) tally.notRestored++;
    }
  }
  const out = { src, convergedSweeps: conv, planes, tally };
  if (outPath) fs.writeFileSync(outPath, JSON.stringify(out, null, 1));
  console.log(JSON.stringify({ src, convergedSweeps: conv, structures: planes.map(p => `${p.plane}:${p.structure}:${p.trials.length}`), tally }));
}
