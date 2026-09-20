// ガター内の通り芯ヒット判定（findGutterCL）の単体テスト。
// 2026-09-20: 相手選択を生の cl.labeled から種別ベース（core/centerLineKindPolicy.js gridCenterLines＝
// isGridCenterLine）へ移行。renderer/GutterLayer.jsx GutterCircleLabels が実際に○ラベルを描く条件
// （cl.labeled && cl.discipline===Discipline.STRUCT）と通常データでは同値のため、「描かれているラベルに
// 当たる」ヒット判定になる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findGutterCL } from './gutterHitTest.js';
import { Plane, PlanGraph, CenterLineType, Discipline } from '../core.js';

function makeGraph() {
  const plane = new Plane('p1', 0, '1階', 1, 1);
  return new PlanGraph(plane);
}

// scaleX/scaleY=1・offsetX/Y=0 とし、cl.value(mm) がそのままスクリーン座標になるようにする
// （テストの座標が読みやすいようにするためのテスト専用の単純化。findGutterCL自体は任意のscale/offsetで動く）。
const VIEWPORT = { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 };
const WIDTH = 800, HEIGHT = 600;
// INSET（layout.js）: top=88, bottom=56, left=48, right=48。
const TOP_GUTTER_SY    = 50;                    // < INSET.top(88)
const BOTTOM_GUTTER_SY = HEIGHT - 30;           // 570 > height-INSET.bottom(544)
const LEFT_GUTTER_SX   = 10;                    // < INSET.left(48)
const RIGHT_GUTTER_SX  = WIDTH - 20;            // 780 > width-INSET.right(752)
const INSIDE_SY        = 300;                   // INSET.top(88) <= 300 <= height-INSET.bottom(544)
const INSIDE_SX        = 300;                   // INSET.left(48) <= 300 <= width-INSET.right(752)

function hit(graph, sx, sy) {
  return findGutterCL(graph, VIEWPORT, WIDTH, HEIGHT, sx, sy);
}

// ================================================================
// 肯定側: 通り芯（縦・横）
// ================================================================

test('findGutterCL: 縦の通り芯（struct）は上・下ガター帯のどちらでも当たる', () => {
  const graph = makeGraph();
  const cl = graph.addCenterLine(CenterLineType.VERTICAL, 300, { labeled: true, discipline: Discipline.STRUCT });
  assert.equal(hit(graph, 310, TOP_GUTTER_SY), cl, '上ガター帯・diff=10<24でヒット');
  assert.equal(hit(graph, 290, BOTTOM_GUTTER_SY), cl, '下ガター帯・diff=10<24でヒット');
});

test('findGutterCL: 横の通り芯（struct）は左・右ガター帯のどちらでも当たる', () => {
  const graph = makeGraph();
  const cl = graph.addCenterLine(CenterLineType.HORIZONTAL, 200, { labeled: true, discipline: Discipline.STRUCT });
  assert.equal(hit(graph, LEFT_GUTTER_SX, 210), cl, '左ガター帯・diff=10<24でヒット');
  assert.equal(hit(graph, RIGHT_GUTTER_SX, 190), cl, '右ガター帯・diff=10<24でヒット');
});

test('findGutterCL: 描画エリア内（帯の外）では通り芯があっても当たらない', () => {
  const graph = makeGraph();
  graph.addCenterLine(CenterLineType.VERTICAL, 300, { labeled: true, discipline: Discipline.STRUCT });
  graph.addCenterLine(CenterLineType.HORIZONTAL, 300, { labeled: true, discipline: Discipline.STRUCT });
  assert.equal(hit(graph, INSIDE_SX, INSIDE_SY), null, 'sx/syとも描画エリア内なのでヒットしない');
});

test('findGutterCL: HIT=24pxの境界（<24はヒット・24はヒットしない）', () => {
  const graph = makeGraph();
  const cl = graph.addCenterLine(CenterLineType.VERTICAL, 500, { labeled: true, discipline: Discipline.STRUCT });
  assert.equal(hit(graph, 500 + 23.9, TOP_GUTTER_SY), cl, 'diff=23.9<24はヒット');
  assert.equal(hit(graph, 500 + 24, TOP_GUTTER_SY), null, 'diff=24ちょうどはヒットしない（`<`のまま）');
});

test('findGutterCL: scale≠1・offset≠0 の viewport でも screen座標へ正しく射影する（縦=scaleX/offsetX・横=scaleY/offsetY）', () => {
  // 非対称なscale/offset（縦横で別の値）にすることで、縦がscaleY/offsetYを、横がscaleX/offsetXを
  // 誤って使う取り違えを検出できるようにする。
  const VP2 = { scaleX: 0.5, scaleY: 0.25, offsetX: 100, offsetY: 40 };
  const hit2 = (graph, sx, sy) => findGutterCL(graph, VP2, WIDTH, HEIGHT, sx, sy);

  const vGraph = makeGraph();
  const vCl = vGraph.addCenterLine(CenterLineType.VERTICAL, 400, { labeled: true, discipline: Discipline.STRUCT });
  // sx = value*scaleX+offsetX = 400*0.5+100 = 300
  assert.equal(hit2(vGraph, 310, TOP_GUTTER_SY), vCl, 'sx=310はscaleX/offsetX射影後の300からdiff=10<24でヒット');
  assert.equal(hit2(vGraph, 330, TOP_GUTTER_SY), null, 'sx=330はdiff=30で24を超えるためヒットしない');

  const hGraph = makeGraph();
  const hCl = hGraph.addCenterLine(CenterLineType.HORIZONTAL, 400, { labeled: true, discipline: Discipline.STRUCT });
  // sy = value*scaleY+offsetY = 400*0.25+40 = 140
  assert.equal(hit2(hGraph, LEFT_GUTTER_SX, 150), hCl, 'sy=150はscaleY/offsetY射影後の140からdiff=10<24でヒット');
  assert.equal(hit2(hGraph, LEFT_GUTTER_SX, 170), null, 'sy=170はdiff=30で24を超えるためヒットしない');
});

test('findGutterCL: 左上コーナー（上帯と左帯が同時成立）では縦の通り芯が横より先に返る', () => {
  // INSET.top=88・INSET.left=48（layout.js）——sx=10<48・sy=50<88でどちらの帯条件も成立する。
  const forward = makeGraph();
  const v1 = forward.addCenterLine(CenterLineType.VERTICAL, 10, { labeled: true, discipline: Discipline.STRUCT });
  forward.addCenterLine(CenterLineType.HORIZONTAL, 50, { labeled: true, discipline: Discipline.STRUCT });
  assert.equal(hit(forward, 10, 50), v1, '縦→横の順で追加しても縦が先に返る（縦ループが先に走るため）');

  const reversed = makeGraph();
  reversed.addCenterLine(CenterLineType.HORIZONTAL, 50, { labeled: true, discipline: Discipline.STRUCT });
  const v2 = reversed.addCenterLine(CenterLineType.VERTICAL, 10, { labeled: true, discipline: Discipline.STRUCT });
  assert.equal(hit(reversed, 10, 50), v2, '横→縦の順で追加しても結果は同じ（縦が先に返る）');
});

// ================================================================
// 相手にならない種別（中心線・補助線・梁芯）
// ================================================================

test('findGutterCL: 中心線・補助線・梁芯は単独でガター帯にあっても当たらない', () => {
  const graph = makeGraph();
  graph.addCenterLine(CenterLineType.VERTICAL, 400, { labeled: false, discipline: Discipline.ARCH });   // 中心線
  graph.addCenterLine(CenterLineType.VERTICAL, 450, { labeled: false, lineType: 'dashed' });             // 補助線
  graph.addCenterLine(CenterLineType.VERTICAL, 470, { labeled: false, discipline: Discipline.FUSE });    // 梁芯
  assert.equal(hit(graph, 410, TOP_GUTTER_SY), null, '中心線は相手にならない');
  assert.equal(hit(graph, 460, TOP_GUTTER_SY), null, '補助線は相手にならない');
  assert.equal(hit(graph, 480, TOP_GUTTER_SY), null, '梁芯は相手にならない');
});

test('findGutterCL: 通り芯・中心線・補助線・梁芯が同座標に重なっても通り芯だけが当たる（追加順: 中心線→補助線→梁芯→通り芯）', () => {
  const graph = makeGraph();
  // 追加順を意図的に「struct最後」にする——filter()が追加順を保つ実装（graph.centerLines.filter(isGridCenterLine)）
  // であって、struct優先の並べ替えをしているわけではないことを確認する（順序依存の事故がないことの確認）。
  graph.addCenterLine(CenterLineType.VERTICAL, 600, { labeled: false, discipline: Discipline.ARCH });
  graph.addCenterLine(CenterLineType.VERTICAL, 600, { labeled: false, lineType: 'dashed' });
  graph.addCenterLine(CenterLineType.VERTICAL, 600, { labeled: false, discipline: Discipline.FUSE });
  const struct = graph.addCenterLine(CenterLineType.VERTICAL, 600, { labeled: true, discipline: Discipline.STRUCT });
  assert.equal(hit(graph, 605, TOP_GUTTER_SY), struct, '同座標に4種別あっても返るのは通り芯のみ');
});

// ================================================================
// 【旧データ限定・種別ベースへ統一】——移行前は cl.labeled のみで判定していたため当たっていたが、
// 移行後は種別（centerLineKind）ベースのため当たらなくなる旧データのピン留め。
// 現行の生成経路ではこの組合せ（labeled:true かつ種別が通り芯でない）は作られない——CL を作る
// 全経路が labeled を明示するか STRUCT を伴う（transform/centerLineOps.js addCenterLineFromDialog:
// struct=labeled:true+STRUCT／center・aux・beamはlabeled:false明示、transform/centerLineConvert.js
// の降格はARCHとlabeled:falseを両方倒す、structural/wallBeamAxes.js・woodAutoFill.jsの梁芯生成は
// labeled:false+FUSE）。
// ================================================================

test('【旧データ限定・種別ベースへ統一】findGutterCL: labeled:trueでも種別が中心線（{labeled:true, discipline:ARCH}）は当たらない（移行前は当たっていた）', () => {
  const graph = makeGraph();
  graph.addCenterLine(CenterLineType.VERTICAL, 700, { labeled: true, discipline: Discipline.ARCH });
  assert.equal(hit(graph, 705, TOP_GUTTER_SY), null, '移行後は種別ベースのため中心線は当たらない');
});

test('【旧データ限定・種別ベースへ統一】findGutterCL: labeled:trueでも種別が補助線（{labeled:true, lineType:dashed}）は当たらない（移行前は当たっていた）', () => {
  const graph = makeGraph();
  graph.addCenterLine(CenterLineType.VERTICAL, 750, { labeled: true, lineType: 'dashed' });
  assert.equal(hit(graph, 755, TOP_GUTTER_SY), null, '移行後は種別ベースのため補助線は当たらない');
});

// ================================================================
// 失敗系
// ================================================================

test('【失敗系】findGutterCL: 通り芯が1本も無いグラフではガター帯のどこを押してもnull', () => {
  const emptyGraph = makeGraph();
  assert.equal(hit(emptyGraph, 100, TOP_GUTTER_SY), null, '空グラフ・上帯');
  assert.equal(hit(emptyGraph, LEFT_GUTTER_SX, 100), null, '空グラフ・左帯');

  const centerOnlyGraph = makeGraph();
  centerOnlyGraph.addCenterLine(CenterLineType.VERTICAL, 100, { labeled: false, discipline: Discipline.ARCH });
  assert.equal(hit(centerOnlyGraph, 100, TOP_GUTTER_SY), null, '中心線だけ1本・上帯');
  assert.equal(hit(centerOnlyGraph, LEFT_GUTTER_SX, 100), null, '中心線だけ1本・左帯');
});

test('【失敗系】findGutterCL: RADIAL の通り芯（labeled:true・STRUCT）はガター帯に当たらない', () => {
  const graph = makeGraph();
  // RADIAL（放射CL。value=角度deg）はcenterLineTypeがVERTICAL/HORIZONTALのいずれでもないため、
  // findGutterCLの縦・横どちらのループでも(cl.centerLineType!==VERTICAL/HORIZONTAL)で素通りする
  // ——gridCenterLines自体はisGridCenterLine（centerLineType不問）で拾うが、findGutterCL側の
  // centerLineType判定で除外される。
  graph.addCenterLine(CenterLineType.RADIAL, 45, { labeled: true, discipline: Discipline.STRUCT });
  assert.equal(hit(graph, 45, TOP_GUTTER_SY), null, '上帯：RADIALは縦の相手にならない');
  assert.equal(hit(graph, LEFT_GUTTER_SX, 45), null, '左帯：RADIALは横の相手にもならない');
});
