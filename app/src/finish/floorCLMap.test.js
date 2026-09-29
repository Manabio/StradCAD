// finish/floorCLMap.js の単体テスト。
// findCounterpartCL は種別条件の無い素の graph.centerLines 走査を
// centerLineKindPolicy.sameCoordCounterparts（走査API）経由に移行済み（ステップ7、2026-09-20）——
// 挙動（type:value のみで照合し種別を見ない・tolMm=1e-6・最初の1件）は変えない。
//
// collectNeededCLs・addMissingCLs・translateCellSet は finish/stair/stairFloorSync.js から
// 本体を変えずに移した（昇降機の仕様追加 ステップ4 S1・2026-09-29）。挙動（階段の上階自動同期）は
// 不変——既存の stairFloorSync.test.js 等が引き続き緑であることで確かめる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, Project, CenterLineType, Discipline } from '../core.js';
import { findCounterpartCL, translateCLId, collectNeededCLs, addMissingCLs, translateCellSet } from './floorCLMap.js';
import { isFinishCellDivider } from '../core/centerLineKindPolicy.js';

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

// ---- collectNeededCLs（finish/stair/stairFloorSync.js から本体を変えずに移した。S1） ----

test('collectNeededCLs: 通り芯（structGraph側のid）はsourceGraph.shapeMapに無いため自然にスキップされる', () => {
  const { project, g1 } = makeProjectWithTwoFloors();
  const grid = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 0, { labeled: true, discipline: Discipline.STRUCT });
  const center = g1.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const key = `${grid.id}:x:x:x`; // 通り芯id + 存在しないid3つ（split(':')で個別に解決を試みるだけなので問題ない）
  const needed = collectNeededCLs([key, `${center.id}:y:y:y`], g1);
  assert.equal(needed.has(`${CenterLineType.VERTICAL}:0`), false, '通り芯（structGraph側）はneededに含まれない');
  assert.equal(needed.get(`${CenterLineType.VERTICAL}:1000`)?.id, center.id);
});

test('collectNeededCLs: 同じ型・座標のCLが複数キーに現れても1件にまとまる（Mapキーはtype:value）', () => {
  const { g1 } = makeProjectWithTwoFloors();
  const a = g1.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const needed = collectNeededCLs([`${a.id}:p:q:r`, `s:${a.id}:t:u`], g1);
  assert.equal(needed.size, 1);
  assert.equal(needed.get(`${CenterLineType.VERTICAL}:1000`)?.id, a.id);
});

// ---- addMissingCLs（同上。S1） ----

test('addMissingCLs: 上階に既に対応CLがあるものは足さない（無いものだけ足し、追加件数を返す）', () => {
  const { project, g1, g2 } = makeProjectWithTwoFloors();
  const existing = g1.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const missing  = g1.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  g2.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH }); // 既に対応先あり

  const needed = collectNeededCLs([`${existing.id}:a:b:c`, `${missing.id}:a:b:c`], g1);
  const added = addMissingCLs(needed, g1, project.structGraph, g2);

  assert.equal(added, 1, '既に対応先のあるexisting(1000)は足さず、missing(2000)だけ足す');
  assert.ok(findCounterpartCL(g2, CenterLineType.VERTICAL, 2000), 'missing側は上階に追加されている');
});

test('addMissingCLs: extentの写し方（1）通り芯参照はそのまま維持する', () => {
  const { project, g1, g2 } = makeProjectWithTwoFloors();
  const gridLo = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: true, discipline: Discipline.STRUCT });
  const src = g1.addCenterLine(CenterLineType.VERTICAL, 1000, {
    labeled: false, discipline: Discipline.ARCH, extentLoRef: { clId: gridLo.id, offset: 0 },
  });
  const needed = collectNeededCLs([`${src.id}:a:b:c`], g1);
  addMissingCLs(needed, g1, project.structGraph, g2);

  const nc = findCounterpartCL(g2, CenterLineType.VERTICAL, 1000);
  assert.equal(nc.extentLoRef?.clId, gridLo.id, '通り芯参照はidそのままで上階へ写る');
});

test('addMissingCLs: extentの写し方（2）設置階per-floor CLへの参照は上階の同type:value CLへ付け替える', () => {
  const { project, g1, g2 } = makeProjectWithTwoFloors();
  const srcRef = g1.addCenterLine(CenterLineType.HORIZONTAL, 500, { labeled: false, discipline: Discipline.ARCH });
  const dstRef = g2.addCenterLine(CenterLineType.HORIZONTAL, 500, { labeled: false, discipline: Discipline.ARCH }); // 上階に既に対応先あり
  const src = g1.addCenterLine(CenterLineType.VERTICAL, 1000, {
    labeled: false, discipline: Discipline.ARCH, extentLoRef: { clId: srcRef.id, offset: 10 },
  });
  const needed = collectNeededCLs([`${src.id}:a:b:c`], g1);
  addMissingCLs(needed, g1, project.structGraph, g2);

  const nc = findCounterpartCL(g2, CenterLineType.VERTICAL, 1000);
  assert.equal(nc.extentLoRef?.clId, dstRef.id, '設置階側の参照先(srcRef)ではなく上階の対応CL(dstRef)を指す');
  assert.equal(nc.extentLoRef?.offset, 10, 'offsetはそのまま維持');
});

test('addMissingCLs: extentの写し方（3）壁参照・付け替え先なしは解決済み座標を静的値として持たせる', () => {
  const { project, g1, g2 } = makeProjectWithTwoFloors();
  const axisCL  = g1.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const clStart = g1.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: false, discipline: Discipline.ARCH });
  const clEnd   = g1.addCenterLine(CenterLineType.VERTICAL,   3000, { labeled: false, discipline: Discipline.ARCH });
  const wall = g1.addWall(axisCL, 75, false, clStart, 0, clEnd, 0, { isExteriorWall: false });
  const src = g1.addCenterLine(CenterLineType.VERTICAL, 1000, {
    labeled: false, discipline: Discipline.ARCH, extentLoRef: { wallId: wall.id },
  });
  const resolvedLo = src.extentLo;
  assert.ok(typeof resolvedLo === 'number', '前提: 壁参照は解決済みの数値を返す');

  const needed = collectNeededCLs([`${src.id}:a:b:c`], g1);
  addMissingCLs(needed, g1, project.structGraph, g2);

  const nc = findCounterpartCL(g2, CenterLineType.VERTICAL, 1000);
  assert.equal(nc.extentLoRef, null, '壁参照は上階では参照化しない（壁は階固有）');
  assert.equal(nc.extentLo, resolvedLo, '解決済み座標を静的値として持つ');
});

// ---- translateCellSet（同上。S1） ----

test('translateCellSet: 全キーが解決できればtype:value照合で変換したキー集合を返す', () => {
  const { project, g1, g2 } = makeProjectWithTwoFloors();
  const a1 = g1.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: false, discipline: Discipline.ARCH });
  const b1 = g1.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const c1 = g1.addCenterLine(CenterLineType.VERTICAL,   1000, { labeled: false, discipline: Discipline.ARCH });
  const d1 = g1.addCenterLine(CenterLineType.HORIZONTAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const a2 = g2.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: false, discipline: Discipline.ARCH });
  const b2 = g2.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const c2 = g2.addCenterLine(CenterLineType.VERTICAL,   1000, { labeled: false, discipline: Discipline.ARCH });
  const d2 = g2.addCenterLine(CenterLineType.HORIZONTAL, 1000, { labeled: false, discipline: Discipline.ARCH });

  const key = `${a1.id}:${b1.id}:${c1.id}:${d1.id}`;
  const result = translateCellSet(new Set([key]), g1, project.structGraph, g2);
  assert.deepEqual(result, new Set([`${a2.id}:${b2.id}:${c2.id}:${d2.id}`]));
});

// ---- findCounterpartCL: predicate引数（省略可。ステップ4 S2で追加） ----

test('findCounterpartCL: predicate省略時は従来どおり種別を問わず最初の1件を返す（梁芯が先でも梁芯を返す）', () => {
  const graph = makeGraph();
  const beam = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.FUSE });
  graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH }); // center（後から追加）
  const result = findCounterpartCL(graph, CenterLineType.VERTICAL, 1000);
  assert.equal(result?.id, beam.id, '省略時は先頭（梁芯）が返る——旧経路のまま');
});

test('findCounterpartCL: predicate指定時は述語を満たす最初の1件だけを返す（isFinishCellDividerで梁芯を除外し中心線を返す）', () => {
  const graph = makeGraph();
  graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.FUSE }); // beam（分割線ではない）
  const center = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH }); // center
  const result = findCounterpartCL(graph, CenterLineType.VERTICAL, 1000, isFinishCellDivider);
  assert.equal(result?.id, center.id, 'predicate指定時は梁芯を除外し中心線が返る——明示時だけ新経路を通る');
});

test('findCounterpartCL: predicateを満たす候補が無ければnull', () => {
  const graph = makeGraph();
  graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.FUSE }); // beamのみ
  assert.equal(findCounterpartCL(graph, CenterLineType.VERTICAL, 1000, isFinishCellDivider), null);
});

// ---- addMissingCLs: opts.isCounterpart（省略可。ステップ4 S2で追加）。
// 「明示 vs 省略」で結果が変わる入力（上階の同座標に梁芯だけがある）を使う——
// 対照側は「引数なし（従来）」と「{isCounterpart: isFinishCellDivider}」で固定する
// （team-lessons「明示vs省略のA/B等価テストが既定生成で恒真化する」対応）。 ----

test('addMissingCLs: 省略時は上階の梁芯を「対応先あり」とみなし、中心線を足さない（階段の既存挙動を固定）', () => {
  const { project, g1, g2 } = makeProjectWithTwoFloors();
  g2.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.FUSE }); // 上階に梁芯のみ
  const src = g1.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const needed = collectNeededCLs([`${src.id}:a:b:c`], g1);

  const added = addMissingCLs(needed, g1, project.structGraph, g2);

  assert.equal(added, 0, '省略時は梁芯を対応先とみなすため足さない');
  assert.equal(g2.centerLines.filter(c => c.centerLineType === CenterLineType.VERTICAL && c.value === 1000).length, 1, '梁芯1本のまま増えない');
});

test('addMissingCLs: {isCounterpart: isFinishCellDivider}指定時は上階の梁芯だけでは対応先とみなさず、中心線を足す', () => {
  const { project, g1, g2 } = makeProjectWithTwoFloors();
  g2.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.FUSE }); // 上階に梁芯のみ
  const src = g1.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const needed = collectNeededCLs([`${src.id}:a:b:c`], g1);

  const added = addMissingCLs(needed, g1, project.structGraph, g2, { isCounterpart: isFinishCellDivider });

  assert.equal(added, 1, '明示時は梁芯を対応先とみなさず中心線を新規に足す');
  const dividerCounterpart = findCounterpartCL(g2, CenterLineType.VERTICAL, 1000, isFinishCellDivider);
  assert.ok(dividerCounterpart, '分割線として解決できる中心線が上階に追加されている');
});

test('translateCellSet: 1つでも解決できないキーがあればnullを返す（安全側）', () => {
  const { project, g1, g2 } = makeProjectWithTwoFloors();
  const a1 = g1.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: false, discipline: Discipline.ARCH });
  const b1 = g1.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const c1 = g1.addCenterLine(CenterLineType.VERTICAL,   1000, { labeled: false, discipline: Discipline.ARCH });
  const d1 = g1.addCenterLine(CenterLineType.HORIZONTAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  // g2側にはc1(1000)の対応先を作らない → このキーは解決不能
  g2.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: false, discipline: Discipline.ARCH });
  g2.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  g2.addCenterLine(CenterLineType.HORIZONTAL, 1000, { labeled: false, discipline: Discipline.ARCH });

  const key = `${a1.id}:${b1.id}:${c1.id}:${d1.id}`;
  assert.equal(translateCellSet(new Set([key]), g1, project.structGraph, g2), null);
});
