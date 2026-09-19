// 在来木造の梁の交点処理（B-3・2026-09-17裁定「通しが勝つ」。structural/beamJunction.js
// resolveBeamJunctionSpans）の実データ確認用probe。woodBeamDepthProbe.mjs を骨格に、sweepを
// 収束させたあと1パスだけ resolveBeamJunctionSpans を回す（構造再計算パイプラインには乗らない
// ——描画専用の追加トリムのため、壁の鮮度・sweep回数はentity側の値（coord1/coord2）に影響しない）。
//
// 出力: 階ごとの端のkindヒストグラム（through/winnerFace/cornerClose/base。primary梁の全端）、
// 交点分類（通し・T・L・十字・断面違い・孤立=柱なし。判定は本probe内の簡易再実装——実装本体は
// あくまでbeamJunction.jsのみ。ここでの重複は診断表示専用）、および座標差ヒストグラム
// （実体coord=spanForColumns由来のbase1/base2と、交点処理後のthrough/winnerFace/cornerCloseの
// 座標との差分。「描画だけがずれている」ことの実量を示す——QA指摘: resolveBeamJunctionSpansは
// このprobeが作るプレーンオブジェクト配列(input)しか読み書きせず実体(StructuralBeam)への参照を
// 持たないため、「呼び出し前後で実体が変わらない」ことは関数シグネチャから導かれる型レベルの
// 再確認に過ぎず、実際に描画だけがずれていることの証拠にはならない）。
//
// 使い方: node --import ./scripts/testSetup.mjs scripts/probe/woodBeamJunctionProbe.mjs [入力.stq]
import { loadDocument } from './loadDoc.mjs';
import { floorSwapManager } from '../../src/storage/FloorSwapManager.js';
import { rulesFor, effectiveStructure, isTraditionalWoodStructure } from '../../src/structural/structureRules.js';
import { resolveBeamJunctionSpans } from '../../src/structural/beamJunction.js';
import { CL_OVERLAP_TOL_MM } from '../../src/core/constants.js';
import { sweepUntilConverged, planeLabel } from './sweepOrder.mjs';

const src = process.argv[2] ?? 'D:/tatsuya/Download/moku4.stq';
const { project } = loadDocument(src);
// loadDoc.mjs は実IDBを使わないインメモリ復元のため、非アクティブ階のpeekはgraphMapから直接返す
// （structureToggleProbe.mjs・woodBeamDepthProbe.mjsと同じ差し替え）。
floorSwapManager.peek = async (plane) => project.graphMap.get(plane.id) ?? null;

console.log(`=== ${src} ===`);
console.log('主構造:', project.structuralInfo.mainStructure);

// 冪等収束チェック（woodBeamDepthProbe.mjsと同じ規律）: 最大4スイープまで全階再計算を回し、
// changed=[]になった回を報告する。在来は3b・3dの1スイープ遅れによりsweep4までに収束する想定
// （2026-09-18裁定で3から改定。woodTieBeamProbe.mjsと同じ根拠——3h-2の点源に床梁を加えたことで
// 3階またぎの連鎖が成立し、1スイープでは1段ずつしか伝播しない）、非在来はsweep1で収束する想定
// （.claude/structural-model.md 3b節「結果整合性」）。
// 【小屋伏図にも梁・柱ルールを適用する計画のステップ7・R-5是正】本番の反映パス
// （reflectStructuralToOtherFloors）と同じ並び（在来なら降順・屋根が先頭）で回す
// （sweepOrder.mjs。9本のwood probeが共有する単一実装）。
const MAX_SWEEPS = 8; // 【QA第2巡Minor-4】convergeLimit(5)に対して余裕を持たせる（below候補が階をまたぐ依存を1段追加するため。woodSupportSpanProbe.mjsと同じ8に統一）
const convergedAt = await sweepUntilConverged(project, 'desc', MAX_SWEEPS,
  (i, changedPlanes) => console.log(`sweep${i}: changed=[${changedPlanes.join(',')}]`));
const convergeLimit = isTraditionalWoodStructure(project.structuralInfo.mainStructure) ? 5 : 1; // 【QA第2巡Minor-4】below候補（3i）が階をまたぐ依存を1段追加するため4は余裕ゼロだった（moku4実測でも収束sweep4ちょうど）。5に緩和。5超はNGのまま
if (convergedAt != null && convergedAt <= convergeLimit) {
  console.log(`OK: 収束（sweep${convergedAt}で changed=[]）`);
} else if (convergedAt != null) {
  console.log(`NG: 収束はしたが遅すぎる（sweep${convergedAt}。期待はsweep${convergeLimit}以内）`);
  process.exitCode = 1;
} else {
  console.log(`NG: 収束しない（sweep${MAX_SWEEPS}までchangedの階がある）`);
  process.exitCode = 1;
}

// resolveBeamJunctionSpansへの入力形（primary梁のみ。StructuralLayer.jsxのbeamDrawSpans組み立てと
// 同じ形——ただし本probeは「表示中の柱集合」（伏図の1つ下の階）を解決しないため、columnsは自階の
// ものを使う（StructuralBeam.coord1/coord2の既定＝_planGraph.columns と同じ基準。実体スパンの検証が
// 目的であり、伏図の柱集合の図面合成までは再現しない）。
function junctionInputFor(graph, lod = 'STANDARD') {
  return graph.beams.map(b => ({
    id: b.id, role: b.role, isVertical: b.isVertical, axisValue: b.axisValue,
    end1: b.clStart.effectiveValue, end2: b.clEnd.effectiveValue,
    base1: b.coord1, base2: b.coord2, // 実体スパン（自階の柱基準。_planGraph.columns）
    halfWidth: 60, // 実描画幅（beamRenderWidth）は本probeでは対象外——柱寸相当の代表値で十分
    sectionKey: b.sectionDefId,
  }));
}

// 座標差ヒストグラム（kind別。実体coord=base1/base2 と 交点処理後のcoord1/coord2 の差分を0.1mm丸めで
// 集計する）。base（未変化）のendは差分0で自明なため対象外——through/winnerFace/cornerCloseだけが
// 「描画だけがずれている」実量を持つ。
function coordDeltaHistogram(junctions, input) {
  const byId = new Map(input.map(b => [b.id, b]));
  const h = { through: {}, winnerFace: {}, cornerClose: {} };
  for (const [id, { coord1, coord2, ends }] of junctions) {
    const b = byId.get(id);
    const newCoords = [coord1, coord2];
    const baseCoords = [b.base1, b.base2];
    ends.forEach((e, i) => {
      if (e.kind === 'base') return;
      const delta = Math.round((newCoords[i] - baseCoords[i]) * 10) / 10;
      h[e.kind][delta] = (h[e.kind][delta] ?? 0) + 1;
    });
  }
  return h;
}
function showDeltaHistogram(h) {
  return Object.entries(h).map(([kind, dist]) => {
    const parts = Object.entries(dist)
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([d, n]) => `Δ${d}mm×${n}`)
      .join(', ') || '(なし)';
    return `${kind}[${parts}]`;
  }).join(' / ');
}

// 交点分類（診断表示専用の簡易再実装。判定ロジックの本体はstructural/beamJunction.jsのみで、
// ここでの重複は「クラスタごとに何が起きたか」を人間可読な分類ラベルへ要約するためだけに存在する）。
function classifyJunctions(beams, tol) {
  const primaries = beams.filter(b => b.role === 'primary');
  const points = [];
  for (const b of primaries) {
    const p1 = b.isVertical ? { x: b.axisValue, y: b.end1 } : { x: b.end1, y: b.axisValue };
    const p2 = b.isVertical ? { x: b.axisValue, y: b.end2 } : { x: b.end2, y: b.axisValue };
    points.push({ ...p1, beam: b, dir: Math.sign(b.end2 - b.end1) || 1 });
    points.push({ ...p2, beam: b, dir: Math.sign(b.end1 - b.end2) || 1 });
  }
  const clusters = [];
  for (const pt of points) {
    let c = clusters.find(c => Math.abs(c.x - pt.x) < tol && Math.abs(c.y - pt.y) < tol);
    if (!c) { c = { x: pt.x, y: pt.y, items: [] }; clusters.push(c); }
    c.items.push(pt);
  }
  const counts = { through: 0, t: 0, l: 0, cross: 0, sectionBreak: 0, isolated: 0 };
  for (const c of clusters) {
    const armsByDir = { X: [], Y: [] };
    for (const it of c.items) armsByDir[it.beam.isVertical ? 'Y' : 'X'].push(it);
    const passingByDir = { X: [], Y: [] };
    for (const b of primaries) {
      const lo = Math.min(b.base1, b.base2), hi = Math.max(b.base1, b.base2);
      if (b.isVertical) {
        if (Math.abs(b.axisValue - c.x) < tol && c.y > lo + tol && c.y < hi - tol) passingByDir.Y.push(b);
      } else if (Math.abs(b.axisValue - c.y) < tol && c.x > lo + tol && c.x < hi - tol) {
        passingByDir.X.push(b);
      }
    }
    const continuous = {}, sectionBreak = {};
    for (const d of ['X', 'Y']) {
      const plus = armsByDir[d].filter(a => a.dir === 1), minus = armsByDir[d].filter(a => a.dir === -1);
      const matched = plus.some(p => minus.some(m => p.beam.sectionKey === m.beam.sectionKey));
      continuous[d] = passingByDir[d].length > 0 || (plus.length > 0 && minus.length > 0 && matched);
      sectionBreak[d] = plus.length > 0 && minus.length > 0 && !matched;
    }
    const xArms = armsByDir.X.length, yArms = armsByDir.Y.length;
    if (continuous.X && continuous.Y) counts.cross++;
    else if (continuous.X || continuous.Y) {
      const otherArms = continuous.X ? yArms : xArms;
      if (otherArms > 0) counts.t++; else counts.through++;
    } else if (sectionBreak.X || sectionBreak.Y) counts.sectionBreak++;
    else if (xArms > 0 && yArms > 0) counts.l++;
    else counts.isolated++; // 相手がいない孤立端（＝交点にならない。柱なし）
  }
  return counts;
}

console.log('\n--- 交点処理（B-3）診断 ---');
// project.orderedTabs（タブ表示順）は屋根専用平面を含まない——R-5是正: 在来木造は屋根の梁も
// role:'primary'化済みのため、交点処理の診断対象に屋根も加える（末尾に追加。既存のタブ順は変えない）。
const junctionTargets = project.roofPlane && isTraditionalWoodStructure(project.structuralInfo.mainStructure)
  ? [...project.orderedTabs, project.roofPlane] : project.orderedTabs;
for (const p of junctionTargets) {
  const graph = project.graphMap.get(p.id);
  if (!graph) continue;
  const rules = rulesFor(effectiveStructure(graph, project));
  const input = junctionInputFor(graph);
  const junctions = resolveBeamJunctionSpans(rules.drawing, input, { tol: CL_OVERLAP_TOL_MM });

  // 端のkindヒストグラム（through/winnerFace/cornerClose）。baseは「primary梁の全端数 − 上記合計」。
  const kindCounts = { through: 0, winnerFace: 0, cornerClose: 0 };
  let totalEnds = 0;
  for (const b of graph.beams) {
    if (b.role !== 'primary') continue;
    totalEnds += 2;
  }
  for (const { ends } of junctions.values()) {
    for (const e of ends) if (e.kind !== 'base') kindCounts[e.kind] = (kindCounts[e.kind] ?? 0) + 1;
  }
  const baseCount = totalEnds - kindCounts.through - kindCounts.winnerFace - kindCounts.cornerClose;

  const cls = classifyJunctions(input, CL_OVERLAP_TOL_MM);
  const clsNote = rules.drawing.beamJunction === 'throughWins' ? '' : '（beamJunction!==throughWinsのため実際には不適用。幾何上の参考分類）';

  const deltaH = coordDeltaHistogram(junctions, input);

  console.log(`${planeLabel(p)}（${rules.key}. beamJunction=${rules.drawing.beamJunction}）:`);
  console.log(`  端kind: through=${kindCounts.through}, winnerFace=${kindCounts.winnerFace}, cornerClose=${kindCounts.cornerClose}, base=${baseCount}（全${totalEnds}端）`);
  console.log(`  交点分類${clsNote}: 通し=${cls.through}, T=${cls.t}, L=${cls.l}, 十字=${cls.cross}, 断面違い=${cls.sectionBreak}, 孤立(柱なし)=${cls.isolated}`);
  console.log(`  座標差(実体base1/2との差分。描画だけがずれている実量): ${showDeltaHistogram(deltaH)}`);
}
