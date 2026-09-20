// 階段下分割CLの同定（isSplitCLFor。非公開）を、公開API findUnderStairSplitCLs/ensureUnderStairSplit
// 経由で検証する。種別ベース（isUnderStairSplitKind。core/centerLineKindPolicy.js）への移行
// （ステップ6、2026-09-20）。
//
// 実データ（11・13・14・moku1・moku4）には直進階段（StairType.STRAIGHT）が0件のため、この経路は
// 実データでは一度も踏まれない——本ファイルの合成fixtureが唯一の保証。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, StairType, centerLineKind } from '@core';
import {
  findUnderStairSplitCLs, ensureUnderStairSplit, resetUnderStairSplit, removeUnderStairSplit,
} from './stairUnderSplit.js';

// 直進階段（幅0..2000・走行0..4000。upDirection:'up'）。stair.cells は階段footprintの
// 4-part キー1枚（このテストでは分割CLの同定だけを見るため、footprint自体の内部分割は問わない）。
function makeStraightStairGraph() {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL,   2000, { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 4000, { labeled: false, discipline: Discipline.ARCH });
  const footprintKey = `${x0.id}:${y0.id}:${x1.id}:${y1.id}`;
  const stair = graph.addStair({ type: StairType.STRAIGHT, cells: new Set([footprintKey]), upDirection: 'up' });
  return { graph, stair, bounds: { x1: 0, y1: 0, x2: 2000, y2: 4000 } };
}

// stair外形の内部を横切り、extentが外形の直交範囲と一致する（＝分割CLの幾何署名を満たす）CLを追加する。
// extentLo/extentHi・centerLineTypeはbounds由来（下の「ensureUnderStairSplitが実際に生成する分割CL」
// テストが、この幾何署名がensureUnderStairSplit自身の出力と一致することを裏取りする）。valueは
// 蹴上位置に依存しないため、外形内部の任意の点（bounds.y1〜y2の中間）を使う。
function addGeomMatchingCL(graph, bounds, props) {
  const value = (bounds.y1 + bounds.y2) / 2;
  return graph.addCenterLine(CenterLineType.HORIZONTAL, value, { extentLo: bounds.x1, extentHi: bounds.x2, ...props });
}

test('ensureUnderStairSplit: 直進階段の破れ線位置に無ラベルの中心線を1本だけ生成する（冪等）', () => {
  const { graph, stair, bounds } = makeStraightStairGraph();

  const changed1 = ensureUnderStairSplit(stair, graph, null);
  assert.equal(changed1, true, '初回は分割CLを新規生成するはず');
  const found1 = findUnderStairSplitCLs(stair, graph);
  assert.equal(found1.length, 1, '分割CLが1本生成されるはず');
  assert.equal(found1[0].labeled, false);
  assert.equal(centerLineKind(found1[0]), 'center', '階段下分割CLの種別は中心線（isUnderStairSplitKindが認める種別）のはず');
  assert.equal(found1[0].centerLineType, CenterLineType.HORIZONTAL, '上り方向upDirection:upは水平分割線になる');
  // ここで確認した extentLo/extentHi（bounds.x1/x2）が、以下の合成fixture（addGeomMatchingCL）が
  // 手組みする幾何署名の根拠——手組み値が実際の生成結果と一致していることの裏取り。
  assert.equal(found1[0].extentLo, bounds.x1);
  assert.equal(found1[0].extentHi, bounds.x2);
  assert.ok(found1[0].value > bounds.y1 && found1[0].value < bounds.y2, '破れ位置は外形の内部にあるはず');

  const changed2 = ensureUnderStairSplit(stair, graph, null);
  assert.equal(changed2, false, '2回目は既存の分割CLと一致するため変更なし（冪等）');
  assert.equal(findUnderStairSplitCLs(stair, graph).length, 1, '重複生成されない');
});

// ---- isSplitCLFor（非公開）を findUnderStairSplitCLs 経由で総当り ----
test('findUnderStairSplitCLs: 4種別×labeled2値の総当り（幾何署名を満たしても中心線（center）以外は分割CLと認めない）', () => {
  const cases = [
    { kind: 'struct', discipline: Discipline.STRUCT, lineType: 'center' },
    { kind: 'center', discipline: Discipline.ARCH,   lineType: 'center' },
    { kind: 'aux',    discipline: Discipline.ARCH,   lineType: 'dashed' },
    { kind: 'beam',   discipline: Discipline.FUSE,   lineType: 'center' },
  ];
  for (const { kind, discipline, lineType } of cases) {
    for (const labeled of [true, false]) {
      const { graph, stair, bounds } = makeStraightStairGraph();
      addGeomMatchingCL(graph, bounds, { labeled, discipline, lineType });
      const found = findUnderStairSplitCLs(stair, graph);
      const expected = kind === 'center' ? 1 : 0;
      assert.equal(found.length, expected, `kind=${kind} labeled=${labeled}`);
    }
  }
});

test('【旧データ限定・種別ベースへ統一】findUnderStairSplitCLs: {labeled:true, discipline:ARCH, lineType:center}（幾何署名を満たす旧データ）はHEADでは分割CLと認めなかったが、移行後は認める', () => {
  const { graph, stair, bounds } = makeStraightStairGraph();
  const legacy = addGeomMatchingCL(graph, bounds, { labeled: true, discipline: Discipline.ARCH, lineType: 'center' });

  const found = findUnderStairSplitCLs(stair, graph);
  assert.equal(found.length, 1, '旧実装（labeledなら即false）は0件だったが、種別ベース（centerLineKind==="center"。' +
    'labeledを問わない）では1件認識するはず');
  assert.equal(found[0].id, legacy.id);
});

test('resetUnderStairSplit: STRAIGHTのまま呼ぶと分割CLは現在の仕様に同期されたまま残る', () => {
  const { graph, stair } = makeStraightStairGraph();
  ensureUnderStairSplit(stair, graph, null);
  const before = findUnderStairSplitCLs(stair, graph)[0].id;

  resetUnderStairSplit(stair, graph, null);

  const after = findUnderStairSplitCLs(stair, graph);
  assert.equal(after.length, 1, 'STRAIGHTのままなら分割CLは維持されるはず');
  assert.equal(after[0].id, before, '仕様に一致するため同じCLがそのまま残るはず（作り直されない）');
});

test('removeUnderStairSplit: 生成した分割CLを除去できる', () => {
  const { graph, stair } = makeStraightStairGraph();
  ensureUnderStairSplit(stair, graph, null);
  assert.equal(findUnderStairSplitCLs(stair, graph).length, 1);

  removeUnderStairSplit(stair, graph);
  assert.equal(findUnderStairSplitCLs(stair, graph).length, 0, '分割CL自体が削除されるはず');
});

// ---- 【失敗系】STRAIGHT以外・bounds不定は分割CLを生成しない（地点側の安全な空振り） ----
test('【失敗系】ensureUnderStairSplit: STRAIGHT以外（SWITCHBACK）は分割CLを生成せず、既存の分割CLも除去する', () => {
  const { graph, stair } = makeStraightStairGraph();
  ensureUnderStairSplit(stair, graph, null);
  assert.equal(findUnderStairSplitCLs(stair, graph).length, 1, '前提: STRAIGHTのときは1本生成される');

  stair.type = StairType.SWITCHBACK;
  const changed = ensureUnderStairSplit(stair, graph, null);
  assert.equal(changed, true, 'STRAIGHT以外への変更で分割CLが除去されるはず');
  assert.equal(findUnderStairSplitCLs(stair, graph).length, 0);
});

test('【失敗系】findUnderStairSplitCLs: stair.cellsが解決不能（空のcells）ならbounds不定で空配列を返す', () => {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const stair = graph.addStair({ type: StairType.STRAIGHT, cells: new Set(), upDirection: 'up' });
  assert.deepEqual(findUnderStairSplitCLs(stair, graph), []);
});
