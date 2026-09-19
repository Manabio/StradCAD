// centerLineOps.test.js と同じ方針: ダックタイピングでは structGraph 連携・Intersection 生成の
// 実挙動を再現できないため、実 core.js（Plane/PlanGraph/Project）を使う。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Project, CenterLineType, Discipline, centerLineKind } from '../core.js';
import { serializeGraph, restoreGraph, serializeStructCLs, restoreStructCLs } from '../graphSnapshot.js';
import {
  ERR_CL_CONVERT_NO_GRID, ERR_CL_CONVERT_LAST_GRID, ERR_CL_CONVERT_ATTACHED,
  ERR_CL_CONVERT_DUP, ERR_CL_CONVERT_DUP_DEMOTE,
} from '../error.js';
import {
  outermostGridExtentRefs, isLastGridOnAxis, attachedShapeExists, applyPromoteToGrid, applyDemoteToCenter,
  checkDemoteToCenterGuards,
} from './centerLineConvert.js';

// project.structGraph・graph._structGraph の連携が必要なテスト用。
function makeProjectWithGraph() {
  const project = new Project('proj', 'test');
  const { graph } = project.addPlane(0, '1階', 'p1');
  return { project, graph };
}

// ---- 昇格（中心線 → 通り芯） ----

test('applyPromoteToGrid: id不変・structGraphへ移籍・discipline/labeled反転・extentRefが全null化・直交通り芯との交点生成・壁は生き残る', () => {
  const { project, graph } = makeProjectWithGraph();
  const y1 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const y2 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const cl = graph.addCenterLine(CenterLineType.VERTICAL, 1000, {
    labeled: false, discipline: Discipline.ARCH, extentLo: -500, extentHi: 3500,
  });
  const clId = cl.id;
  const wall = graph.addWall(cl, 0, true, y1, 0, y2, 0);

  const result = applyPromoteToGrid(graph, project.structGraph, cl);

  assert.deepEqual(result, {});
  assert.equal(graph.shapeMap.has(clId), false, '階グラフから消滅');
  assert.equal(project.structGraph.shapeMap.get(clId), cl, 'structGraphへ同一idで移籍（同一オブジェクト）');
  assert.equal(cl.discipline, Discipline.STRUCT);
  assert.equal(cl.labeled, true);
  assert.equal(cl.trim, false);
  assert.equal(cl.extentLoRef, null);
  assert.equal(cl.extentHiRef, null);
  assert.equal(cl.extentLo, null);
  assert.equal(cl.extentHi, null);
  assert.ok(project.structGraph.intersectionMap.has(`${clId}:${y1.id}`), 'y1との交点生成');
  assert.ok(project.structGraph.intersectionMap.has(`${clId}:${y2.id}`), 'y2との交点生成');
  assert.equal(graph.walls.includes(wall), true, '壁は削除されず生き残る');
  assert.equal(wall.axisCL, cl, '壁のaxisCLは同一オブジェクト参照のまま無傷');
});

test('applyPromoteToGrid: refIdで階内の別CLを参照する中心線を昇格すると絶対値へベイクされ、参照先が動いても追従しない（F1）', () => {
  const { project, graph } = makeProjectWithGraph();
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const anchor = graph.addCenterLine(CenterLineType.VERTICAL, 500, { labeled: false, discipline: Discipline.ARCH });
  const cl = graph.addCenterLine(CenterLineType.VERTICAL, 0, {
    labeled: false, discipline: Discipline.ARCH, refId: anchor.id, refOffset: 500,
  });
  assert.equal(cl.value, 1000, '前提: refId経由でanchor.value(500)+refOffset(500)=1000を返す');

  const result = applyPromoteToGrid(graph, project.structGraph, cl);

  assert.deepEqual(result, {});
  assert.equal(cl.refId, null, 'refIdは外れる');
  assert.equal(cl.value, 1000, '絶対値1000へベイクされる');

  anchor.value = 2000; // 参照先を動かす
  assert.equal(cl.value, 1000, '通り芯化後は参照先の移動に追従しない（ベイク済み・全階共通の座標が固定される）');
});

test('applyPromoteToGrid異常系: 階グラフの同座標・同軸に梁芯（fuse・平面では非表示）があればERR_CL_DUPLICATE(beam)でグラフ無変更（通り芯と梁芯は同位置に共存不可）', () => {
  const { project, graph } = makeProjectWithGraph();
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const cl   = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const beam = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.FUSE }); // 同座標の梁芯

  const result = applyPromoteToGrid(graph, project.structGraph, cl);

  assert.equal(result.error, ERR_CL_CONVERT_DUP('beam'));
  // ERR_CL_CONVERT_DUP自体を呼んで期待値を作ると、その関数がkind引数を無視する変異を検出できない
  // ——リテラル文字列で固定する。
  assert.equal(result.error, '同じ位置に梁芯があるため通り芯にできません。');
  assert.equal(graph.shapeMap.has(cl.id), true, '階グラフに残ったまま（変換されない）');
  assert.equal(project.structGraph.shapeMap.has(cl.id), false);
  assert.equal(graph.shapeMap.has(beam.id), true, '梁芯は無傷');
});

test('applyPromoteToGrid異常系: structGraphに同座標・同軸の通り芯が既にあればERR_CL_DUPLICATEでグラフ無変更（F2）', () => {
  const { project, graph } = makeProjectWithGraph();
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT }); // 同座標の既存通り芯
  const cl = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });

  const result = applyPromoteToGrid(graph, project.structGraph, cl);

  assert.equal(result.error, ERR_CL_CONVERT_DUP('struct'));
  assert.equal(result.error, '同じ位置に通り芯があるため通り芯にできません。');
  assert.equal(graph.shapeMap.has(cl.id), true, '階グラフに残ったまま（変換されない）');
  assert.equal(cl.discipline, Discipline.ARCH);
  assert.equal(cl.labeled, false);
});

// 直交通り芯の本数は昇格の技術的前提ではない（ユーザー判断で撤去。旧F4ガード）。
// 昇格はextentを無条件null化するだけで直交CLの値を参照せず、AddCLDialogで最初の通り芯を
// 1本だけ追加する通常運用と同じコードパス（adoptCenterLine→_createIntersectionsは
// 直交labeled CLが0本でも0個の交点を作るだけ）。降格側の直交2本必須ガードは維持する
// （extentLoRef/HiRefを最外郭通り芯2本へ張るのが降格の定義そのものという技術的必然のため）。
test('applyPromoteToGrid: 直交する通り芯が0本でも昇格できる（旧F4ガードは撤去済み）', () => {
  const { project, graph } = makeProjectWithGraph();
  // 直交(HORIZONTAL)通り芯を1本も用意しない。
  const cl = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });

  const result = applyPromoteToGrid(graph, project.structGraph, cl);

  assert.deepEqual(result, {}, '直交通り芯0本でも昇格は成功する');
  assert.equal(graph.shapeMap.has(cl.id), false, '階グラフから消滅');
  assert.equal(project.structGraph.shapeMap.get(cl.id), cl, 'structGraphへ同一idで移籍');
  assert.equal(cl.discipline, Discipline.STRUCT);
  assert.equal(cl.labeled, true);
});

test('昇格→降格の非対称性: 直交通り芯2本未満のまま昇格したCLは降格できないが、直交側に通り芯を2本足せば降格できるようになる', () => {
  const { project, graph } = makeProjectWithGraph();
  const cl = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });

  assert.deepEqual(applyPromoteToGrid(graph, project.structGraph, cl), {}, '直交通り芯0本でも昇格は成功する');

  // 直交通り芯が0本のままだと降格はNO_GRIDで拒否される（往復不能な期間。仕様として許容）。
  const demoteBefore = applyDemoteToCenter(graph, project.structGraph, cl);
  assert.equal(demoteBefore.error, ERR_CL_CONVERT_NO_GRID);
  assert.equal(project.structGraph.shapeMap.has(cl.id), true, '降格は失敗し通り芯のまま残る');

  // 直交(HORIZONTAL)通り芯を2本足せば降格できるようになる（同軸(VERTICAL)にはclの他にもう1本
  // 必要——isLastGridOnAxisガードに引っかからないように、cl以外のVERTICAL通り芯も用意する）。
  const y1 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const y2 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.VERTICAL, 5000, { labeled: true, discipline: Discipline.STRUCT });

  const demoteAfter = applyDemoteToCenter(graph, project.structGraph, cl);
  assert.equal(demoteAfter.error, undefined);
  assert.equal(demoteAfter.loCL, y1);
  assert.equal(demoteAfter.hiCL, y2);
  assert.equal(graph.shapeMap.has(cl.id), true, '中心線として階グラフへ戻る');
});

test('applyPromoteToGrid異常系: 斜線が取り付いた中心線はERR_CL_CONVERT_ATTACHEDでグラフ無変更', () => {
  const { project, graph } = makeProjectWithGraph();
  // 昇格は直交通り芯の本数を問わないため必須ではないが、実運用に近い状態（直交通り芯あり）でも
  // ATTACHEDガードが正しく効くことを確認するため用意する。
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, -1000, { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 4000,  { labeled: true, discipline: Discipline.STRUCT });
  const cl = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const hOther = graph.addCenterLine(CenterLineType.HORIZONTAL, 500, { labeled: false, discipline: Discipline.ARCH });
  const ix = graph.getOrCreateIntersection(cl, hOther);
  const pt = graph.addPoint(2000, 2000);
  graph.addDiagonalLine(ix, pt);

  assert.equal(attachedShapeExists(graph, graph, cl.id), true);

  const result = applyPromoteToGrid(graph, project.structGraph, cl);

  assert.equal(result.error, ERR_CL_CONVERT_ATTACHED);
  assert.equal(graph.shapeMap.has(cl.id), true, '階グラフに残ったまま（変換されない）');
  assert.equal(cl.discipline, Discipline.ARCH);
  assert.equal(cl.labeled, false);
  assert.equal(project.structGraph.shapeMap.has(cl.id), false);
});

// ---- 降格（通り芯 → 中心線） ----

test('applyDemoteToCenter: 階グラフへ移籍・extentLo/HiRefが最外郭通り芯を指す・label=""・structGraph側の交点消滅', () => {
  const { project, graph } = makeProjectWithGraph();
  const y1 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const y2 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: true, discipline: Discipline.STRUCT }); // 中間（最外郭ではない）
  const y3 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 4000, { labeled: true, discipline: Discipline.STRUCT });
  const cl = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  // isLastGridOnAxisガード対策: 同軸(VERTICAL)にclの他にもう1本必要（このテストの主眼＝extentRef決定とは無関係）。
  project.structGraph.addCenterLine(CenterLineType.VERTICAL, 5000, { labeled: true, discipline: Discipline.STRUCT });
  const clId = cl.id;
  assert.ok(project.structGraph.intersectionMap.has(`${clId}:${y2.id}`)); // 前提: 交点が既に存在する

  const refs = outermostGridExtentRefs(graph, cl);
  assert.equal(refs.loCL, y1);
  assert.equal(refs.hiCL, y3);

  const result = applyDemoteToCenter(graph, project.structGraph, cl);

  assert.equal(result.loCL, y1);
  assert.equal(result.hiCL, y3);
  assert.equal(project.structGraph.shapeMap.has(clId), false, 'structGraphから消滅');
  assert.equal(graph.shapeMap.get(clId), cl, '階グラフへ同一idで移籍（同一オブジェクト）');
  assert.equal(cl.discipline, Discipline.ARCH);
  assert.equal(cl.labeled, false);
  assert.equal(cl.label, '');
  assert.deepEqual(cl.extentLoRef, { clId: y1.id, offset: 0 });
  assert.deepEqual(cl.extentHiRef, { clId: y3.id, offset: 0 });
  assert.equal(cl.extentLo, y1.value);
  assert.equal(cl.extentHi, y3.value);
  assert.equal(project.structGraph.intersectionMap.has(`${clId}:${y1.id}`), false, 'structGraph側の交点消滅');
  assert.equal(project.structGraph.intersectionMap.has(`${clId}:${y2.id}`), false);
  assert.equal(project.structGraph.intersectionMap.has(`${clId}:${y3.id}`), false);
});

test('applyDemoteToCenter異常系: 直交する通り芯が1本しかなければERR_CL_CONVERT_NO_GRIDでグラフ無変更', () => {
  const { project, graph } = makeProjectWithGraph();
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: true, discipline: Discipline.STRUCT }); // 1本のみ
  const cl = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });

  assert.equal(outermostGridExtentRefs(graph, cl), null);

  const result = applyDemoteToCenter(graph, project.structGraph, cl);

  assert.equal(result.error, ERR_CL_CONVERT_NO_GRID);
  assert.equal(project.structGraph.shapeMap.has(cl.id), true, 'structGraphに残ったまま（変換されない）');
  assert.equal(graph.shapeMap.has(cl.id), false);
  assert.equal(cl.discipline, Discipline.STRUCT);
  assert.equal(cl.labeled, true);
});

// ---- isLastGridOnAxis（軸最後の1本ガード。ユーザー要望で新設） ----
// 「最後の通り芯」は軸ごとの解釈（X軸・Y軸それぞれの最後の1本）で確定——全体で最後の1本は
// 直交0本になりNO_GRIDで既にブロックされるため、このガードが意味を持つのは「直交軸には
// 2本以上あるが、自分の軸だけは自分1本」のケース。

// 【注意点の固定】isLastGridOnAxisは「同軸のlabeled STRUCT CLが自分のみか」を数えるだけの純関数で、
// cl自身がstructかどうかは見ない——非structのCL（中心線・補助線・梁芯）に対して呼ぶと、同軸に
// 通り芯が0本（＝比較対象がcl自身でなくゼロ件）でも length<=1 が成立してtrueを返しうる。
// このため呼び出し側（interaction/usePointerInteraction.js）は必ずcenterLineKind(cl)==='struct'を
// 条件に含めてから呼ぶ設計になっている（menuItems.test.js の「中心線はdisabledにならない」テストと対）。
test('isLastGridOnAxis: 非structのCL（中心線）に対して呼ぶと同軸の通り芯が0本でもtrueを返しうる（呼び出し側でstruct限定が必須な理由）', () => {
  const { graph } = makeProjectWithGraph();
  // 同軸(VERTICAL)の通り芯を1本も追加しない。
  const centerCl = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });

  assert.equal(isLastGridOnAxis(graph, centerCl), true, '中心線に対して呼ぶと誤ってtrueになりうる（要struct限定ガード）');
});

test('applyDemoteToCenter異常系: 直交軸には2本以上あっても同軸(VERTICAL)がclだけ（軸最後の1本）ならERR_CL_CONVERT_LAST_GRIDでグラフ無変更', () => {
  const { project, graph } = makeProjectWithGraph();
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const cl = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT }); // VERTICAL軸唯一の通り芯

  assert.equal(isLastGridOnAxis(graph, cl), true);

  const result = applyDemoteToCenter(graph, project.structGraph, cl);

  assert.equal(result.error, ERR_CL_CONVERT_LAST_GRID);
  assert.equal(project.structGraph.shapeMap.has(cl.id), true, 'structGraphに残ったまま（変換されない）');
  assert.equal(graph.shapeMap.has(cl.id), false);
  assert.equal(cl.discipline, Discipline.STRUCT);
  assert.equal(cl.labeled, true);
});

test('applyDemoteToCenter: 同軸(VERTICAL)に他の通り芯があれば（軸最後の1本ではない）従来どおり降格できる', () => {
  const { project, graph } = makeProjectWithGraph();
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const cl = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.VERTICAL, 5000, { labeled: true, discipline: Discipline.STRUCT }); // 同軸に他の通り芯

  assert.equal(isLastGridOnAxis(graph, cl), false);

  const result = applyDemoteToCenter(graph, project.structGraph, cl);

  assert.equal(result.error, undefined);
  assert.equal(project.structGraph.shapeMap.has(cl.id), false, 'structGraphから消滅');
  assert.equal(graph.shapeMap.has(cl.id), true, '階グラフへ移籍される');
});

test('applyDemoteToCenter: 移籍先の階グラフの同座標に梁芯（fuse・平面では非表示）があっても降格でき、梁芯と中心線が共存する', () => {
  const { project, graph } = makeProjectWithGraph();
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const cl = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.VERTICAL, 5000, { labeled: true, discipline: Discipline.STRUCT }); // isLastGridOnAxis対策
  const beam = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.FUSE }); // 移籍先の同座標に梁芯

  const result = applyDemoteToCenter(graph, project.structGraph, cl);

  assert.equal(result.error, undefined, '梁芯は障害物にならない');
  assert.equal(project.structGraph.shapeMap.has(cl.id), false, 'structGraphから消滅');
  assert.equal(graph.shapeMap.has(cl.id), true, '階グラフへ移籍される');
  assert.equal(graph.shapeMap.has(beam.id), true, '梁芯は無傷で共存する');
});

test('applyDemoteToCenter異常系: 移籍先の階グラフに同座標・同軸の中心線が既にあればERR_CL_DUPLICATEでグラフ無変更（F3）', () => {
  const { project, graph } = makeProjectWithGraph();
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const cl = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  // isLastGridOnAxisガード対策: 同軸(VERTICAL)にclの他にもう1本必要（このテストの主眼＝DUPLICATEとは無関係）。
  project.structGraph.addCenterLine(CenterLineType.VERTICAL, 5000, { labeled: true, discipline: Discipline.STRUCT });
  graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH }); // 移籍先に既存の中心線

  const result = applyDemoteToCenter(graph, project.structGraph, cl);

  assert.equal(result.error, ERR_CL_CONVERT_DUP_DEMOTE('center'));
  // ERR_CL_CONVERT_DUP_DEMOTE自体を呼んで期待値を作ると、その関数がkind引数を無視する変異を
  // 検出できない——リテラル文字列で固定する（QA指摘m-1）。
  assert.equal(result.error, '同じ位置に中心線があるため中心線にできません。');
  assert.equal(project.structGraph.shapeMap.has(cl.id), true, 'structGraphに残ったまま（変換されない）');
  assert.equal(cl.discipline, Discipline.STRUCT);
  assert.equal(cl.labeled, true);
});

test('applyDemoteToCenter異常系: 移籍先の階グラフに同座標・同軸の補助線が既にあればERR_CL_CONVERT_DUP_DEMOTE(\'aux\')でグラフ無変更（実際の種別を表示。共存表より厳しく補助線も拒否する現行維持の裁定）', () => {
  const { project, graph } = makeProjectWithGraph();
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const cl = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.VERTICAL, 5000, { labeled: true, discipline: Discipline.STRUCT }); // isLastGridOnAxis対策
  graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, lineType: 'dashed' }); // 移籍先に既存の補助線

  const result = applyDemoteToCenter(graph, project.structGraph, cl);

  assert.equal(result.error, ERR_CL_CONVERT_DUP_DEMOTE('aux'), '相手が補助線のとき実際の種別（aux）を表示する');
  // ERR_CL_CONVERT_DUP_DEMOTE自体を呼んで期待値を作ると、その関数がkind引数を無視する変異を
  // 検出できない（期待値・実測値の双方が同じ壊れた関数を経由するため）——リテラル文字列で固定する。
  assert.equal(result.error, '同じ位置に補助線があるため中心線にできません。');
  assert.equal(project.structGraph.shapeMap.has(cl.id), true, 'structGraphに残ったまま（変換されない）');
});

test('applyDemoteToCenter異常系: 移籍先に中心線・補助線が両方あれば中心線を優先して表示する（convertBlockingKindsの並び順）', () => {
  const { project, graph } = makeProjectWithGraph();
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const cl = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.VERTICAL, 5000, { labeled: true, discipline: Discipline.STRUCT }); // isLastGridOnAxis対策
  graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, lineType: 'dashed' }); // 補助線
  graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH }); // 中心線

  const result = applyDemoteToCenter(graph, project.structGraph, cl);

  assert.equal(result.error, ERR_CL_CONVERT_DUP_DEMOTE('center'));
  assert.equal(result.error, '同じ位置に中心線があるため中心線にできません。', 'リテラル文字列で固定（QA指摘m-1）');
});

// ---- 旧データ限定・種別ベースへ統一（ステップ5、2026-09-20）: checkDemoteToCenterGuards の
// dupCenter判定を種別ベース（centerLineKind）へ統一したことによる反転ピン留め。移行前は生の
// `!c.labeled` を見ていたため、labeled:true の旧データ（種別は中心線・補助線）は「labeled付き」
// として除外され障害物にならなかった。移行後は種別ベースのため、labeledの値によらず障害物になる。

test('【旧データ限定・種別ベースへ統一】checkDemoteToCenterGuards: labeled:trueでも種別が中心線の旧データ（{labeled:true, discipline:ARCH}）は障害物になる（移行前は見逃していた）', () => {
  const { project, graph } = makeProjectWithGraph();
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const cl = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.VERTICAL, 5000, { labeled: true, discipline: Discipline.STRUCT }); // isLastGridOnAxis対策
  const legacy = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.ARCH });
  assert.equal(centerLineKind(legacy), 'center', '前提: discipline=ARCHなのでcenter種別（labeled:trueだが種別は通り芯でない旧データ）');

  const error = checkDemoteToCenterGuards(graph, project.structGraph, cl);

  assert.equal(error, ERR_CL_CONVERT_DUP_DEMOTE('center'), '移行前は!labeledがfalseのため見逃していたが、移行後は種別ベースで検出する');
  assert.equal(error, '同じ位置に中心線があるため中心線にできません。', 'リテラル文字列で固定（QA指摘m-1）');
});

test('【旧データ限定・種別ベースへ統一】checkDemoteToCenterGuards: labeled:trueでも種別が補助線の旧データ（{labeled:true, lineType:dashed}）は障害物になる（移行前は見逃していた）', () => {
  const { project, graph } = makeProjectWithGraph();
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const cl = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.VERTICAL, 5000, { labeled: true, discipline: Discipline.STRUCT }); // isLastGridOnAxis対策
  const legacy = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, lineType: 'dashed' });
  assert.equal(centerLineKind(legacy), 'aux', '前提: lineType=dashedなのでaux種別（labeled:trueだが種別は通り芯でない旧データ）');

  const error = checkDemoteToCenterGuards(graph, project.structGraph, cl);

  assert.equal(error, ERR_CL_CONVERT_DUP_DEMOTE('aux'), '移行前は!labeledがfalseのため見逃していたが、移行後は種別ベースで検出する');
  assert.equal(error, '同じ位置に補助線があるため中心線にできません。', 'リテラル文字列で固定（QA指摘m-1）');
});

// QA指摘m-5: 逆方向の乖離——labeled:falseだが種別はstructの旧データ・異常値は、移行前は
// 障害物として拒否していたが移行後は見逃す（拒否しない）方向に割れる。通常経路では
// discipline:STRUCTかつlabeled:falseのCLは作れないため実害は無い（checkDemoteToCenterGuardsの
// コメント参照）。
test('【旧データ限定・種別ベースへ統一（逆方向）】checkDemoteToCenterGuards: labeled:falseで種別がstructの異常値（{labeled:false, discipline:STRUCT}）は障害物にならない（移行前は拒否していた）', () => {
  const { project, graph } = makeProjectWithGraph();
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const cl = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.VERTICAL, 5000, { labeled: true, discipline: Discipline.STRUCT }); // isLastGridOnAxis対策
  const legacy = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.STRUCT });
  assert.equal(centerLineKind(legacy), 'struct', '前提: discipline=STRUCTなのでstruct種別（labeled:falseだが種別は通り芯の異常値。通常経路では作れない）');

  const error = checkDemoteToCenterGuards(graph, project.structGraph, cl);

  assert.equal(error, null, '移行前は!labeledがtrueのため拒否していたが、移行後は種別ベース（structはconvertBlockingKinds(demote)に含まれない）のため見逃す');
});

test('applyDemoteToCenter異常系: アクティブ階グラフ側に斜線が取り付いていればERR_CL_CONVERT_ATTACHEDでグラフ無変更（F7・N2再修正）', () => {
  const { project, graph } = makeProjectWithGraph();
  // 斜線・円弧のShape本体・ngraphリンクは常に階グラフ側（graph._graph/shapeMap）に登録される
  // （structGraphへShapeを追加する経路は存在しない）ため、「structGraph.addDiagonalLine」という
  // 実運用に存在しない状態でこのガードを検証してはならない——正しい再現は「structGraph側の交点
  // （x1×y1）に、階グラフ（graph）から斜線を張る」形（graph.getOrCreateIntersectionはstructGraphの
  // 既存交点を再利用してgraph._graphにもノード登録する。core/planGraph.js _getOrCreateIntersection 参照）。
  const y1 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const x1 = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  // isLastGridOnAxisガード対策: 同軸(VERTICAL)にx1の他にもう1本必要（このテストの主眼＝ATTACHEDとは無関係）。
  project.structGraph.addCenterLine(CenterLineType.VERTICAL, 5000, { labeled: true, discipline: Discipline.STRUCT });
  const ix = graph.getOrCreateIntersection(x1, y1);
  graph.addDiagonalLine(ix, graph.addPoint(3000, 3000));

  assert.equal(attachedShapeExists(project.structGraph, graph, x1.id), true);

  const result = applyDemoteToCenter(graph, project.structGraph, x1);

  assert.equal(result.error, ERR_CL_CONVERT_ATTACHED);
  assert.equal(project.structGraph.shapeMap.has(x1.id), true, 'structGraphに残ったまま（変換されない）');
  assert.equal(graph.shapeMap.has(x1.id), false);
});

test('applyDemoteToCenter: ネガティブコントロール（同構成で斜線なし）は降格が成功しloCL/hiCLが返る', () => {
  const { project, graph } = makeProjectWithGraph();
  const y1 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const y2 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const x1 = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  // isLastGridOnAxisガード対策: 同軸(VERTICAL)にx1の他にもう1本必要。
  project.structGraph.addCenterLine(CenterLineType.VERTICAL, 5000, { labeled: true, discipline: Discipline.STRUCT });

  const result = applyDemoteToCenter(graph, project.structGraph, x1);

  assert.equal(result.error, undefined);
  assert.equal(result.loCL, y1);
  assert.equal(result.hiCL, y2);
  assert.equal(graph.shapeMap.has(x1.id), true, '階グラフへ移籍される');
});

// ---- 往復 ----

test('往復: 昇格→降格でarch/中心線の状態に戻り、シリアライズ結果も整合する', () => {
  const { project, graph } = makeProjectWithGraph();
  const y1 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const y2 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const cl = graph.addCenterLine(CenterLineType.VERTICAL, 1000, {
    labeled: false, discipline: Discipline.ARCH, extentLo: -500, extentHi: 3500,
  });
  const clId = cl.id;

  assert.deepEqual(applyPromoteToGrid(graph, project.structGraph, cl), {});
  // isLastGridOnAxisガード対策: 昇格直後はclが同軸(VERTICAL)唯一の通り芯になるため、
  // 降格できるよう他に1本用意する（このテストの主眼＝往復整合性とは無関係）。
  project.structGraph.addCenterLine(CenterLineType.VERTICAL, 5000, { labeled: true, discipline: Discipline.STRUCT });
  const demoted = applyDemoteToCenter(graph, project.structGraph, cl);
  assert.equal(demoted.loCL, y1);
  assert.equal(demoted.hiCL, y2);

  assert.equal(graph.shapeMap.has(clId), true);
  assert.equal(project.structGraph.shapeMap.has(clId), false);
  assert.equal(cl.discipline, Discipline.ARCH);
  assert.equal(cl.labeled, false);

  // シリアライズ→別グラフへ復元しても整合する（id・extentRef・discipline/labeledが保たれる）
  const bytesFloor  = serializeGraph(graph);
  const bytesStruct = serializeStructCLs(project.structGraph, project.structuralInfo, project.memberGroupLedger);
  const { project: project2, graph: graph2 } = makeProjectWithGraph();
  restoreStructCLs(project2.structGraph, project2.structuralInfo, bytesStruct, project2.memberGroupLedger);
  restoreGraph(graph2, bytesFloor);

  assert.equal(graph2.shapeMap.has(clId), true, '復元後も階グラフ側に存在する');
  assert.equal(project2.structGraph.shapeMap.has(clId), false, 'structGraph側には存在しない');
  const restored = graph2.shapeMap.get(clId);
  assert.equal(restored.discipline, Discipline.ARCH);
  assert.equal(restored.labeled, false);
  assert.equal(restored.extentLoRef.clId, y1.id);
  assert.equal(restored.extentHiRef.clId, y2.id);
});

// ---- 【失敗系】QA指摘m-3: 変換用文言（ERR_CL_CONVERT_DUP/_DEMOTE）は未知種別でthrowする ----
// （追加用のERR_CL_DUPLICATEは挙動を変えていない。undefined埋め込みのまま）

test('【失敗系】ERR_CL_CONVERT_DUP: 未知種別・未指定はthrowする', () => {
  assert.throws(() => ERR_CL_CONVERT_DUP('wood'), /未知のCL種別: wood/);
  assert.throws(() => ERR_CL_CONVERT_DUP(undefined), /未知のCL種別: undefined/);
  assert.throws(() => ERR_CL_CONVERT_DUP(null), /未知のCL種別: null/);
});

test('【失敗系】ERR_CL_CONVERT_DUP_DEMOTE: 未知種別・未指定はthrowする', () => {
  assert.throws(() => ERR_CL_CONVERT_DUP_DEMOTE('wood'), /未知のCL種別: wood/);
  assert.throws(() => ERR_CL_CONVERT_DUP_DEMOTE(undefined), /未知のCL種別: undefined/);
});

test('ERR_CL_CONVERT_DUP/_DEMOTEは既知の4種別すべてでthrowしない', () => {
  for (const kind of ['struct', 'center', 'aux', 'beam']) {
    assert.doesNotThrow(() => ERR_CL_CONVERT_DUP(kind));
    assert.doesNotThrow(() => ERR_CL_CONVERT_DUP_DEMOTE(kind));
  }
});
