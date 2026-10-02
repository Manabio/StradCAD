// core/structuralEntities.js findHostBeam/openingHostRefCLs/openingHostRefIds の単体テスト
// （ステップ5・規則O層C）。beamAxisMove.test.js と同じ流儀（実core.js。Plane/PlanGraphで実グラフを組む）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, StructuralMaterialType } from '../core.js';
import { findHostBeam, findHostPrimaryBeam, openingHostRefCLs, openingHostRefIds, beamExclusionKey, spanKey } from './structuralEntities.js';
import { BeamAxisOrigin } from './centerLine.js';

function makeGraph() {
  return new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
}

const SEC = 'H-300x150'; // 断面IDはfindHostBeamの座標判定に無関係（ダミーで良い）

test('findHostBeam: allowSecondaryHost省略(false)はfindHostPrimaryBeamと同じ結果（primaryのみ）', () => {
  const graph = makeGraph();
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0, { labeled: true, discipline: Discipline.STRUCT });
  const x10 = graph.addCenterLine(CenterLineType.VERTICAL, 10000, { labeled: true, discipline: Discipline.STRUCT });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: true, discipline: Discipline.STRUCT });
  const primary = graph.addBeam(StructuralMaterialType.STEEL, SEC, y0, false, x0, x10, { role: 'primary' });

  const viaBeam = findHostBeam(graph.beams, y0.id, false, 5000);
  const viaPrimary = findHostPrimaryBeam(graph.beams, y0.id, false, 5000);
  assert.equal(viaBeam, primary);
  assert.equal(viaBeam, viaPrimary);

  // 範囲外・向き違い・secondaryは（allowSecondaryHost無しでは）どちらもnull
  assert.equal(findHostBeam(graph.beams, y0.id, false, 15000), null);
  assert.equal(findHostPrimaryBeam(graph.beams, y0.id, false, 15000), null);
});

test('findHostBeam: allowSecondaryHost:trueならrole:secondaryもhostとして返す', () => {
  const graph = makeGraph();
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0, { labeled: true, discipline: Discipline.STRUCT });
  const x10 = graph.addCenterLine(CenterLineType.VERTICAL, 10000, { labeled: true, discipline: Discipline.STRUCT });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: false, discipline: Discipline.FUSE });
  const secondary = graph.addBeam(StructuralMaterialType.STEEL, SEC, y0, false, x0, x10, { role: 'secondary' });

  assert.equal(findHostBeam(graph.beams, y0.id, false, 5000), null, '既定(false)ではsecondaryをhostにしない');
  assert.equal(findHostBeam(graph.beams, y0.id, false, 5000, { allowSecondaryHost: true }), secondary);
});

test('findHostBeam: 同一perpCL上にprimaryとsecondaryが両方あればprimaryを優先する', () => {
  const graph = makeGraph();
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0, { labeled: true, discipline: Discipline.STRUCT });
  const x10 = graph.addCenterLine(CenterLineType.VERTICAL, 10000, { labeled: true, discipline: Discipline.STRUCT });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: true, discipline: Discipline.STRUCT });
  const secondary = graph.addBeam(StructuralMaterialType.STEEL, SEC, y0, false, x0, x10, { role: 'secondary' });
  const primary = graph.addBeam(StructuralMaterialType.STEEL, SEC, y0, false, x0, x10, { role: 'primary' });

  assert.notEqual(secondary, primary);
  assert.equal(findHostBeam(graph.beams, y0.id, false, 5000, { allowSecondaryHost: true }), primary);
});

test('findHostBeam: allowRoofBeamHost 既定(false)では小屋梁はhostにならず、trueでhostになる（C2e-1a）', () => {
  const graph = makeGraph();
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0, { labeled: true, discipline: Discipline.STRUCT });
  const x10 = graph.addCenterLine(CenterLineType.VERTICAL, 10000, { labeled: true, discipline: Discipline.STRUCT });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: true, discipline: Discipline.STRUCT });
  const roof = graph.addBeam(StructuralMaterialType.WOOD, SEC, y0, false, x0, x10, { role: 'roofBeam' });

  assert.equal(findHostBeam(graph.beams, y0.id, false, 5000), null, '既定(false)では小屋梁をhostにしない');
  assert.equal(findHostBeam(graph.beams, y0.id, false, 5000, { allowSecondaryHost: true }), null, '小梁を許す指定でも小屋梁は対象外');
  assert.equal(findHostPrimaryBeam(graph.beams, y0.id, false, 5000), null);
  assert.equal(findHostBeam(graph.beams, y0.id, false, 5000, { allowRoofBeamHost: true }), roof);
});

test('findHostBeam: allowRoofBeamHost でも同じ位置に primary と roofBeam があれば primary を優先する', () => {
  const graph = makeGraph();
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0, { labeled: true, discipline: Discipline.STRUCT });
  const x10 = graph.addCenterLine(CenterLineType.VERTICAL, 10000, { labeled: true, discipline: Discipline.STRUCT });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: true, discipline: Discipline.STRUCT });
  const roof = graph.addBeam(StructuralMaterialType.WOOD, SEC, y0, false, x0, x10, { role: 'roofBeam' });
  const primary = graph.addBeam(StructuralMaterialType.WOOD, SEC, y0, false, x0, x10, { role: 'primary' });

  assert.notEqual(roof, primary);
  assert.equal(findHostBeam(graph.beams, y0.id, false, 5000, { allowRoofBeamHost: true }), primary);
});

test('findHostBeam【失敗系】: allowRoofBeamHost でも向き違い・範囲外・存在しないCL id・空配列・不正な座標はnull', () => {
  const graph = makeGraph();
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0, { labeled: true, discipline: Discipline.STRUCT });
  const x10 = graph.addCenterLine(CenterLineType.VERTICAL, 10000, { labeled: true, discipline: Discipline.STRUCT });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: true, discipline: Discipline.STRUCT });
  graph.addBeam(StructuralMaterialType.WOOD, SEC, y0, false, x0, x10, { role: 'roofBeam' });
  const opt = { allowRoofBeamHost: true };

  // 子と平行な小屋梁は host にならない（hostIsVertical が子の向きの反対だけを見る）
  assert.equal(findHostBeam(graph.beams, y0.id, true, 5000, opt), null, 'hostIsVertical が違えば除かれる');
  assert.equal(findHostBeam(graph.beams, y0.id, false, 15000, opt), null, '範囲外');
  assert.equal(findHostBeam(graph.beams, 'no-such-cl', false, 5000, opt), null, '存在しないCL id');
  assert.equal(findHostBeam([], y0.id, false, 5000, opt), null, '空配列');
  assert.equal(findHostBeam(graph.beams, y0.id, false, NaN, opt), null, '不正な座標(NaN)');
  assert.equal(findHostBeam(graph.beams, y0.id, false, undefined, opt), null, '不正な座標(undefined)');
});

test('openingHostRefCLs: beamAxisOrigin!==OPENINGは常に空配列', () => {
  const graph = makeGraph();
  const through = graph.addCenterLine(CenterLineType.HORIZONTAL, 1000, { labeled: false, discipline: Discipline.FUSE });
  const wallOrigin = graph.addCenterLine(CenterLineType.VERTICAL, 2000, {
    labeled: false, discipline: Discipline.FUSE, beamAxisOrigin: BeamAxisOrigin.WALL,
    extentLoRef: { clId: through.id, offset: 0 },
  });
  assert.deepEqual(openingHostRefCLs(wallOrigin), []);
  assert.deepEqual(openingHostRefIds(wallOrigin), new Set(), 'openingHostRefIdsはopeningHostRefCLsのid集合ラッパ');
});

test('openingHostRefCLs: OPENING由来で梁芯CLを参照するextentLoRef/extentHiRefのCLオブジェクトを集める（通り芯参照は含めない）', () => {
  const graph = makeGraph();
  const grid = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: true, discipline: Discipline.STRUCT });
  const through = graph.addCenterLine(CenterLineType.HORIZONTAL, 1000, { labeled: false, discipline: Discipline.FUSE });
  const short = graph.addCenterLine(CenterLineType.VERTICAL, 2000, {
    labeled: false, discipline: Discipline.FUSE, beamAxisOrigin: BeamAxisOrigin.OPENING,
    extentLoRef: { clId: grid.id, offset: 0 }, extentHiRef: { clId: through.id, offset: 0 },
  });
  assert.deepEqual(openingHostRefCLs(short), [through], '通り芯参照(grid)は含めず、梁芯参照(through)のCLオブジェクトだけ含む');
  assert.deepEqual(openingHostRefIds(short), new Set([through.id]), 'openingHostRefIdsはそのid集合ラッパ');
});

// 【変異(4)検出用】allowSecondaryHostを「常に true」にする変異は、structuralAutoFill.test.js・
// woodAutoFill.test.js 等の既存スイートでは検出できない（実測・検出力の穴として報告）。
// 開口由来でない小梁（role:'secondary'、axisCL.beamAxisOrigin!==OPENING）の自由端（host不在＝CL位置で
// 止まるはず）が、たまたま同じperpCL上に別の無関係な小梁があるだけで誤ってそちらをhostにしてしまう
// 具体的な壊れ方を固定する。
test('【失敗系・変異(4)検出用】開口由来でない小梁の自由端は、同じperpCL上に無関係なsecondary梁があってもhostにしない（CL位置で止まる）', () => {
  const graph = makeGraph();
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const xA = graph.addCenterLine(CenterLineType.VERTICAL, 3000, { labeled: false, discipline: Discipline.ARCH }); // 自由端側（hostになる大梁なし）
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,     { labeled: true, discipline: Discipline.STRUCT });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 10000, { labeled: true, discipline: Discipline.STRUCT });
  // B自身の軸CL（開口由来ではない=beamAxisOrigin未設定）
  const axisOfB = graph.addCenterLine(CenterLineType.HORIZONTAL, 1000, { labeled: false, discipline: Discipline.FUSE });
  const beamB = graph.addBeam(StructuralMaterialType.STEEL, SEC, axisOfB, false, x0, xA, { role: 'secondary' });
  // xA上にたまたま存在する、Bとは無関係な別のsecondary梁C（axisCL=xA、y=1000をまたぐ）
  graph.addBeam(StructuralMaterialType.STEEL, SEC, xA, true, y0, y1, { role: 'secondary' });

  // 修正後の実装: hostは見つからない（xAに大梁(primary)が無いため）ので自由端＝CL位置(3000)で止まる。
  assert.equal(beamB.coord2, 3000, 'xA上のsecondary梁Cをhostにせず、CL位置で自由端になる');
});

// ---- beamExclusionKey: 小屋梁（roofBeam）は sill と同じく role の名前空間つき。既存の role の鍵は不変（C2b） ----
test('beamExclusionKey: roofBeam は "roofBeam:" 前置、sill は "sill:" 前置、それ以外の role は素の spanKey（既存文書の除外集合と互換）', () => {
  const graph = makeGraph();
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0, { labeled: true, discipline: Discipline.STRUCT });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: true, discipline: Discipline.STRUCT });
  const key = spanKey(y0, x0, x1);
  assert.equal(beamExclusionKey('roofBeam', y0, x0, x1), `roofBeam:${key}`);
  assert.equal(beamExclusionKey('sill', y0, x0, x1), `sill:${key}`, '既存の sill の鍵は不変');
  for (const role of ['primary', 'secondary', 'floor', 'foundation', 'eaves', 'roof', 'landing', undefined]) {
    assert.equal(beamExclusionKey(role, y0, x0, x1), key, `role=${role} は素の spanKey（不変）`);
  }
  assert.equal(beamExclusionKey('roofBeam', y0, x1, x0), `roofBeam:${key}`, '端の順序に依存しない');
});

test('PlanGraph.removeBeam/addBeam: 小屋梁の除外キーは名前空間つきで積まれ、addBeam で同じ名前空間のキーだけ解除される', () => {
  const graph = makeGraph();
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0, { labeled: true, discipline: Discipline.STRUCT });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: true, discipline: Discipline.STRUCT });
  const key = spanKey(y0, x0, x1);
  const koya = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', y0, false, x0, x1, { role: 'roofBeam', beamType: '小屋梁' });
  graph.removeBeam(koya.id);
  assert.deepEqual([...graph.excludedBeamSlots], [`roofBeam:${key}`]);
  // 同じ spanKey の大梁を追加しても、小屋梁の除外は解除されない（別の名前空間）。
  graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', y0, false, x0, x1, { role: 'primary' });
  assert.deepEqual([...graph.excludedBeamSlots], [`roofBeam:${key}`]);
  // 小屋梁を再び追加（手動で置き直した等）すると解除される。
  graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', y0, false, x0, x1, { role: 'roofBeam', beamType: '小屋梁' });
  assert.equal(graph.excludedBeamSlots.size, 0);
});
