// finish/floorCLMap.js の単体テスト。
// findCounterpartCL は種別条件の無い素の graph.centerLines 走査を
// centerLineKindPolicy.sameCoordCounterparts（走査API）経由に移行済み（ステップ7、2026-09-20）——
// 挙動（type:value のみで照合し種別を見ない・tolMm=1e-6・最初の1件）は変えない。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, Project, CenterLineType, Discipline } from '../core.js';
import { findCounterpartCL, translateCLId } from './floorCLMap.js';

function makeGraph(planeId = 'p1') {
  const plane = new Plane(planeId, 0, `${planeId}階`, 1, 1);
  return new PlanGraph(plane);
}

function makeProjectWithTwoFloors() {
  const project = new Project('proj', 'test');
  const { graph: g1 } = project.addPlane(0, '1階', 'p1');
  const { graph: g2 } = project.addPlane(1, '2階', 'p2');
  return { project, g1, g2 };
}

test('findCounterpartCL: type・valueが一致するCLを返す（種別は問わない）', () => {
  const graph = makeGraph();
  const center = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  assert.equal(findCounterpartCL(graph, CenterLineType.VERTICAL, 1000)?.id, center.id);
});

test('findCounterpartCL: 種別が違っても同type:valueなら最初に見つかったものを返す（既知の限界。種別を見ない）', () => {
  const graph = makeGraph();
  // 通り芯・中心線が同座標に共存するのはCOEXISTENCE上ありえないが、findCounterpartCL自体は
  // graph.centerLinesの中身を種別で絞らない——中心線・補助線・梁芯が同座標にある構成（ありうる）で
  // 「最初に見つかったもの」をそのまま返す現行挙動を固定する。
  const aux = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, lineType: 'dashed' });
  const beam = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.FUSE });
  const result = findCounterpartCL(graph, CenterLineType.VERTICAL, 1000);
  assert.equal(result?.id, aux.id, '走査順で先に追加されたaux(先頭)が選ばれる（種別による優先はしない）');
  assert.notEqual(result?.id, beam.id);
});

test('findCounterpartCL: tolMmは1e-6（CL_OVERLAP_TOL_MMの既定0.5mmより厳しい）——境界の両側を確認する', () => {
  const graph = makeGraph();
  const cl = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  assert.equal(findCounterpartCL(graph, CenterLineType.VERTICAL, 1000.001)?.id, undefined, '差0.001mmは1e-6より粗いため不一致（sameCoordCounterpartsの既定tolMm=0.5を使っていたら誤ってマッチしてしまう）');
  assert.equal(findCounterpartCL(graph, CenterLineType.VERTICAL, 1000.0000001)?.id, cl.id, '差1e-7は1e-6未満なので一致する');
});

// QA指摘（Minor E）: tolMm境界が開区間（`<`であって`<=`ではない）であることを直接固定する。
// 浮動小数の丸め誤差で不安定にならないよう、CL位置は0・照合値はEPS自体（=1e-6）を使う——
// `Math.abs(0 - 1e-6)`は加減算の丸め誤差を経由せず厳密に`1e-6`になるため、`1e-6 < 1e-6`の判定が
// 決定的にfalseになる（1000を基準にすると加算の丸めで厳密な1e-6にならず不安定になる）。
test('【失敗系】findCounterpartCL: 差がちょうどtolMm(1e-6)のCLは一致しない（開区間。`<`であって`<=`ではない）', () => {
  const graph = makeGraph();
  const EPS = 1e-6;
  const cl = graph.addCenterLine(CenterLineType.VERTICAL, 0, { labeled: false, discipline: Discipline.ARCH });
  assert.equal(findCounterpartCL(graph, CenterLineType.VERTICAL, EPS), null, '差がちょうどEPS（開区間の境界そのもの）は不一致');
  assert.equal(findCounterpartCL(graph, CenterLineType.VERTICAL, EPS / 2)?.id, cl.id, '差がEPS未満なら一致');
});

test('findCounterpartCL: centerLineTypeが異なれば見つからない', () => {
  const graph = makeGraph();
  graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  assert.equal(findCounterpartCL(graph, CenterLineType.HORIZONTAL, 1000), null);
});

test('findCounterpartCL: 該当なしはnull', () => {
  const graph = makeGraph();
  assert.equal(findCounterpartCL(graph, CenterLineType.VERTICAL, 12345), null);
});

// ---- 【失敗系】QA指摘: sameCoordCounterparts（走査API）はcenterLineType未指定・valueが非数値でthrowする
// が、findCounterpartCL自体は移行前（素のgraph.centerLines.find）と同じ「該当なしはnull」の契約を
// 保つ（throwしない）——translateCLIdがCL以外のshapeMap要素からcenterLineType/valueを渡す退化ケース
// （下のtranslateCLId系テスト参照）を安全に処理するためのガード。 ----

test('【失敗系】findCounterpartCL: typeがnull/undefined・valueが非数値（undefined/NaN/文字列）でもthrowせずnullを返す', () => {
  const graph = makeGraph();
  graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  assert.equal(findCounterpartCL(graph, null, 1000), null);
  assert.equal(findCounterpartCL(graph, undefined, 1000), null);
  assert.equal(findCounterpartCL(graph, CenterLineType.VERTICAL, undefined), null);
  assert.equal(findCounterpartCL(graph, CenterLineType.VERTICAL, NaN), null);
  assert.equal(findCounterpartCL(graph, CenterLineType.VERTICAL, '1000'), null);
});

test('translateCLId: 通り芯（structGraph側）は全階共通idのためそのまま返る', () => {
  const { project, g1, g2 } = makeProjectWithTwoFloors();
  const structCl = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  assert.equal(translateCLId(structCl.id, g1, project.structGraph, g2), structCl.id);
});

test('translateCLId: per-floor CL（中心線）は対象階の同type:value CLのidへ変換される。無ければnull', () => {
  const { project, g1, g2 } = makeProjectWithTwoFloors();
  const srcCl = g1.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const dstCl = g2.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  assert.equal(translateCLId(srcCl.id, g1, project.structGraph, g2), dstCl.id);

  const srcOnly = g1.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  assert.equal(translateCLId(srcOnly.id, g1, project.structGraph, g2), null, '対象階に対応するCLが無ければnull');
});

// ---- 【失敗系】QA指摘: shapeMap.get(id) がCLでない形状（壁等）を返すケース。
// 「解決できなければnull」というtranslateCLIdの契約が、findCounterpartCLの引数ガード追加後も
// 保たれることを確認する（cl.centerLineType/cl.valueがundefinedのままfindCounterpartCLへ渡っても
// throwせずnullに収束する）。 ----

test('【失敗系】translateCLId: idがCLでない形状（壁）を指すとnullを返す（throwしない）', () => {
  const { project, g1, g2 } = makeProjectWithTwoFloors();
  const axisCL  = g1.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const clStart = g1.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: false, discipline: Discipline.ARCH });
  const clEnd   = g1.addCenterLine(CenterLineType.VERTICAL,   3000, { labeled: false, discipline: Discipline.ARCH });
  const wall = g1.addWall(axisCL, 75, false, clStart, 0, clEnd, 0, { isExteriorWall: false });
  assert.doesNotThrow(() => translateCLId(wall.id, g1, project.structGraph, g2));
  assert.equal(translateCLId(wall.id, g1, project.structGraph, g2), null);
});

test('【失敗系】translateCLId: 存在しないidはnullを返す', () => {
  const { project, g1, g2 } = makeProjectWithTwoFloors();
  assert.equal(translateCLId('no-such-id', g1, project.structGraph, g2), null);
});
