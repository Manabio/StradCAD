// グリッド索引（gridIndexOf）の等価性テスト。
// 読み取りスコープ（graphReadScope.js）でキャッシュしても、スコープ外の素の計算と
// **同じ結果**になることを固定する——高速化は挙動を変えないという不変条件そのもの。
// あわせて「スコープを抜けたらCL変更が反映される」（キャッシュが持ち越されない）も見る。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline } from '@core';
import { withGraphReadScope } from '../graphReadScope.js';
import {
  worldToCell, getCellsInRect, getAllCells, refreshCells, cellBoundsFromKey, gridDividerSegments,
  isDividerCL, isActiveAcrossRange,
} from './gridCells.js';

// 3x3セルの格子（値0/1000/2000/3000。中央の縦CLだけextent制限してL字結合も踏ませる）
function makeGraph() {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const vs = [0, 1000, 2000, 3000].map((v, i) => graph.addCenterLine(CenterLineType.VERTICAL, v, {
    labeled: i === 0 || i === 3, discipline: i === 0 || i === 3 ? Discipline.STRUCT : Discipline.ARCH,
  }));
  const hs = [0, 1000, 2000, 3000].map((v, i) => graph.addCenterLine(CenterLineType.HORIZONTAL, v, {
    labeled: i === 0 || i === 3, discipline: i === 0 || i === 3 ? Discipline.STRUCT : Discipline.ARCH,
  }));
  vs[1].setProps({ _extentLo: 0, _extentHi: 1000 }); // 上段だけを分割する短縮CL（L字領域を作る）
  return { graph, vs, hs };
}

const PROBES = [[500, 500], [1500, 500], [2500, 2500], [1500, 1500], [-100, 500], [500, 3500]];

test('gridCells: worldToCell はスコープの有無で同じ結果を返す', () => {
  const { graph } = makeGraph();
  const bare = PROBES.map(([x, y]) => worldToCell(x, y, graph));
  const scoped = withGraphReadScope(graph, () => PROBES.map(([x, y]) => worldToCell(x, y, graph)));
  assert.deepEqual(scoped, bare);
});

test('gridCells: getCellsInRect / getAllCells / gridDividerSegments はスコープの有無で同じ結果を返す', () => {
  const { graph } = makeGraph();
  const bare = {
    rect: getCellsInRect(0, 0, 3000, 3000, graph),
    all:  getAllCells(graph),
    segs: gridDividerSegments(graph),
  };
  const scoped = withGraphReadScope(graph, () => ({
    rect: getCellsInRect(0, 0, 3000, 3000, graph),
    all:  getAllCells(graph),
    segs: gridDividerSegments(graph),
  }));
  assert.deepEqual(scoped, bare);
});

test('gridCells: refreshCells / cellBoundsFromKey はスコープの有無で同じ結果を返す', () => {
  const { graph } = makeGraph();
  const cells = new Set(getAllCells(graph).map(c => c.key));
  const bare = [...refreshCells(cells, graph)].sort();
  const scoped = withGraphReadScope(graph, () => [...refreshCells(cells, graph)].sort());
  assert.deepEqual(scoped, bare);

  const key = [...cells][0];
  assert.deepEqual(withGraphReadScope(graph, () => cellBoundsFromKey(key, graph)), cellBoundsFromKey(key, graph));
});

test('gridCells: スコープを抜けた後のCL移動は次の呼び出しに反映される（キャッシュを持ち越さない）', () => {
  const { graph, vs } = makeGraph();
  const before = withGraphReadScope(graph, () => worldToCell(2500, 500, graph));
  assert.equal(before.x1, 2000);

  vs[2].value = 2400; // 2本目の分割CLを移動
  const after = withGraphReadScope(graph, () => worldToCell(2500, 500, graph));
  assert.equal(after.x1, 2400);
});

// ---- isDividerCL / isActiveAcrossRange: 種別ベース（isFinishCellDivider / isGridCenterLine）への統一 ----
// 4種別×labeled2値の総当り。struct=labeled必須、center=labeledの値を問わず常に分割線、aux/beamは
// 常に非分割線（isFinishCellDivider = isGridCenterLine(cl) || FINISH_CELL_DIVIDER_KINDS.includes(kind)。
// 中心線側はlabeledを見ない——線上ヒットの範囲判定（snapGeometry.js findNearestCenterLine）は既に
// 種別ベース（spansEntireAxis）のため、セル分割線としての扱いだけ生labeledを残すと食い違いが残る）。
test('isDividerCL: 4種別×labeled2値の総当り（通り芯=labeled必須、中心線=labeledの値を問わず常にtrue、補助線・梁芯は常にfalse）', () => {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  let v = 0;
  const cases = [
    ['struct', Discipline.STRUCT, 'center'],
    ['center', Discipline.ARCH,   'center'],
    ['aux',    Discipline.ARCH,   'dashed'],
    ['beam',   Discipline.FUSE,   'center'],
  ];
  for (const [kind, discipline, lineType] of cases) {
    for (const labeled of [true, false]) {
      const cl = graph.addCenterLine(CenterLineType.VERTICAL, v, { labeled, discipline, lineType });
      v += 1000;
      const expected = kind === 'struct' ? labeled : kind === 'center';
      assert.equal(isDividerCL(cl), expected, `kind=${kind} labeled=${labeled}`);
    }
  }
});

test('【旧データ限定・種別ベースへ統一】isDividerCL: {labeled:true, discipline:ARCH, lineType:center}（通り芯でも補助線でもないのにlabeled:trueな旧データ）はHEADの不参加から、移行後は分割線に参加する', () => {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const legacy = graph.addCenterLine(CenterLineType.VERTICAL, 0,
    { labeled: true, discipline: Discipline.ARCH, lineType: 'center' });
  assert.equal(isDividerCL(legacy), true,
    '旧実装（!labeled && lineType!==dashed && discipline===ARCH）はlabeled:trueで即falseだったが、' +
    '種別ベース（centerLineKind(cl)==="center"。labeledを問わない）ではtrueになる');
});

test('【旧データ限定・種別ベースへ統一】isDividerCL・isActiveAcrossRange: {labeled:true, discipline:STRUCT, lineType:dashed}は移行後は分割線・全域扱いにならない', () => {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const legacy = graph.addCenterLine(CenterLineType.VERTICAL, 0,
    { labeled: true, discipline: Discipline.STRUCT, lineType: 'dashed' });
  assert.equal(isDividerCL(legacy), false,
    '旧実装（labeled&&discipline===STRUCT）はtrueだったが、種別ベースはlineType:dashedをauxと判定しfalseになる');
  assert.equal(isActiveAcrossRange(legacy, -Infinity, Infinity), true,
    'extentLo/Hiが未確定（null）のため、通り芯扱いでなくてもextent未確定側の早期returnでtrueになる（不変）');
  legacy.setProps({ _extentLo: -500, _extentHi: 500 });
  assert.equal(isActiveAcrossRange(legacy, 1000, 2000), false,
    '旧実装は常にtrue（通り芯扱い）だったが、種別ベースではextentLo/Hi([-500,500])とrange([1000,2000])が重ならずfalseになる');
});

// ---- 波及の確認: {labeled:true, ARCH, 実線}（分割線に新規参加する旧データ）がextent未確定でも
// 通常のworldToCell/getAllCellsで安全に扱われる（throw・NaN・無限ループにならない）こと、
// かつ「extent未確定の中心線」と同じ扱い（常に全域アクティブ＝全長を分割する）になることを、
// 公開APIレベル（isDividerCL単体ではなく実際にセルが割れること）で固定する。
test('【旧データ限定・種別ベースへ統一】worldToCell/getAllCells: {labeled:true, ARCH, 実線}はextent未確定でも安全に分割線として働き、同じ位置の非labeled中心線と同じ分割結果になる', () => {
  // ケースA: 通常の非labeled中心線をx=1500に追加した格子
  const ordinary = makeGraph();
  ordinary.graph.addCenterLine(CenterLineType.VERTICAL, 1500, { labeled: false, discipline: Discipline.ARCH });

  // ケースB: 同じ位置に{labeled:true, ARCH, 実線}の旧データ異常値を追加した格子
  const legacyG = makeGraph();
  const legacy = legacyG.graph.addCenterLine(CenterLineType.VERTICAL, 1500,
    { labeled: true, discipline: Discipline.ARCH, lineType: 'center' });
  assert.equal(legacy.extentLo, null, '前提: extentLo/Hiは未確定（旧データはこれが多い想定）');

  // throw・NaNにならず、x=1500の左右で異なるセルに分かれる（分割線として機能している）ことを確認
  const left  = worldToCell(1499, 500, legacyG.graph);
  const right = worldToCell(1501, 500, legacyG.graph);
  assert.ok(left && right, 'worldToCellがthrowせず結果を返すはず');
  assert.notEqual(left.key, right.key, 'x=1500の左右で異なるセルに分かれる（分割線として参加している）はず');
  assert.ok(Number.isFinite(left.x1) && Number.isFinite(left.x2), 'セル境界がNaN/Infinityにならないはず');

  // 「extent未確定の中心線」と同じ扱い＝通常の非labeled中心線を同じ位置に置いた場合と
  // 同じセル集合（キーの並びは実装詳細のため、境界値の集合で比較する）になる
  const keyOf = c => `${c.x1},${c.y1},${c.x2},${c.y2}`;
  const cellsOrdinary = getAllCells(ordinary.graph).map(keyOf).sort();
  const cellsLegacy   = getAllCells(legacyG.graph).map(keyOf).sort();
  assert.deepEqual(cellsLegacy, cellsOrdinary,
    '{labeled:true,ARCH,実線}は、同じ位置の通常の非labeled中心線と同じセル分割結果になるはず（extent未確定の中心線と同じ扱い）');
});

// 【不変条件】gridDividerSegments の full 判定（isGridCenterLine）は、その手前の gridIndexOf が
// isDividerCL（isFinishCellDivider）で既に verticals/horizontals を「通り芯（labeled必須+struct）」
// 「中心線（labeledの値を問わない）」の2種にしか絞っていないため、push に渡る cl は常にどちらか一方——
// full の結果は isDividerCL の判定と常に一致し、{labeled:true,STRUCT,dashed} のような
// full 側だけがHEADと食い違う旧データは存在しない（isDividerCL側で既に不参加になるため）。
// 変異テスト（このpushのfull行をHEAD式へ戻す）は本ファイルの単体テストでは検出できない——
// centerLineKindPolicy.guard.test.js のG2/G4（生labeled/discipline比較の再検出）がこの行の
// 巻き戻しを検出する唯一の保証線であることを、下記のテストと合わせてここに明記する。
test('gridDividerSegments: struct（labeled:true, STRUCT）はextentLo/Hiが確定していても常に全長になる', () => {
  const { graph } = makeGraph();
  const structV = graph.centerLines.find(cl => cl.centerLineType === CenterLineType.VERTICAL && cl.value === 0);
  structV.setProps({ _extentLo: 100, _extentHi: 200 }); // 全長無視されるべき値
  const seg = gridDividerSegments(graph).find(s => s.key === structV.id);
  assert.ok(seg, '前提: x=0の通り芯の区割り線が出力される');
  assert.equal(seg.lo, 0, 'extentLo(100)ではなく格子の外周(yMin=0)になる（常に全長）');
  assert.equal(seg.hi, 3000, 'extentHi(200)ではなく格子の外周(yMax=3000)になる（常に全長）');
});
