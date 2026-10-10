// グリッド索引（gridIndexOf）の等価性テスト。
// 読み取りスコープ（graphReadScope.js）でキャッシュしても、スコープ外の素の計算と
// **同じ結果**になることを固定する——高速化は挙動を変えないという不変条件そのもの。
// あわせて「スコープを抜けたらCL変更が反映される」（キャッシュが持ち越されない）も見る。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline } from '@core';
import { withGraphReadScope } from '../graphReadScope.js';
import {
  CEILING_CELL_GRID, regionCellsAt,
  worldToCell, worldToCellInIndex, gridIndexOf, getCellsInRect, getAllCells, refreshCells, cellBoundsFromKey,
  gridDividerSegments, isDividerCL, isActiveAcrossRange,
  isRectangularCellSet, boundsShareEdge, connectedCellComponents,
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

// ---- ステップA: worldToCellInIndex（確定済み索引だけで解く。wallGate.js footprintProbeのcache経路が使う）----
test('worldToCellInIndex: gridIndexOfで確定した索引に対し、同じ格子でworldToCellと同じ結果を返す（L字結合を含む）', () => {
  const { graph } = makeGraph();
  const index = gridIndexOf(graph);
  for (const [x, y] of PROBES) {
    assert.deepEqual(worldToCellInIndex(x, y, index), worldToCell(x, y, graph), `(${x},${y})`);
  }
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

// ================================================================
// isRectangularCellSet / boundsShareEdge / connectedCellComponents
// （昇降機の仕様追加 ステップ3 S2）
// ================================================================

function makeFullGrid(xs, ys) {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const vs = xs.map((v, i) => graph.addCenterLine(CenterLineType.VERTICAL, v, {
    labeled: i === 0 || i === xs.length - 1,
    discipline: (i === 0 || i === xs.length - 1) ? Discipline.STRUCT : Discipline.ARCH,
  }));
  const hs = ys.map((v, i) => graph.addCenterLine(CenterLineType.HORIZONTAL, v, {
    labeled: i === 0 || i === ys.length - 1,
    discipline: (i === 0 || i === ys.length - 1) ? Discipline.STRUCT : Discipline.ARCH,
  }));
  return { graph, vs, hs };
}

function cellAt(graph, xMin, yMin, xMax, yMax) {
  return getCellsInRect(xMin, yMin, xMax, yMax, graph).find(c =>
    c.x1 === xMin && c.y1 === yMin && c.x2 === xMax && c.y2 === yMax);
}

test('isRectangularCellSet: 2x2の完全な矩形は true', () => {
  const { graph } = makeFullGrid([0, 1000, 2000], [0, 1000, 2000]);
  const cells = new Set(getAllCells(graph).map(c => c.key)); // 2x2=4セル全部
  assert.equal(isRectangularCellSet(cells, graph), true);
});

test('isRectangularCellSet: L字（4セルから1つ欠けている）は false', () => {
  const { graph } = makeFullGrid([0, 1000, 2000], [0, 1000, 2000]);
  const all = getAllCells(graph);
  const cells = new Set(all.slice(0, 3).map(c => c.key)); // 4隅のうち1つを欠く
  assert.equal(cells.size, 3);
  assert.equal(isRectangularCellSet(cells, graph), false);
});

test('isRectangularCellSet: 1セルのみは true', () => {
  const { graph } = makeFullGrid([0, 1000, 2000], [0, 1000, 2000]);
  const one = getAllCells(graph)[0];
  assert.equal(isRectangularCellSet(new Set([one.key]), graph), true);
});

test('isRectangularCellSet: 空集合・未解決キーを含む集合は false', () => {
  const { graph } = makeFullGrid([0, 1000, 2000], [0, 1000, 2000]);
  assert.equal(isRectangularCellSet(new Set(), graph), false, '空集合');
  const one = getAllCells(graph)[0];
  assert.equal(isRectangularCellSet(new Set([one.key, 'no-such-cl:x:y:z']), graph), false, '未解決キーを含む');
});

test('isRectangularCellSet: T字格子（短いCLで一部だけ区切られた領域が結合されたセル）の全域は true', () => {
  // makeGraph（このファイル冒頭）は中央の縦CL(x=1000)が上段(y:0-1000)だけを分割し、
  // 下段2行はx=0〜2000が1つの結合セルになる（L字/T字結合の代表例）。
  const { graph } = makeGraph();
  const cells = new Set(getAllCells(graph).map(c => c.key)); // 格子全域（結合セルを含む）
  assert.equal(isRectangularCellSet(cells, graph), true, '格子全域は結合セルを含んでいても矩形として扱う');
});

test('isRectangularCellSet: T字格子の一部だけを取り出す（結合セル+隣接セルの一部が欠ける）と false', () => {
  const { graph } = makeGraph();
  const all = getAllCells(graph);
  // 全域から1セルだけ除いた集合は非矩形になるはず。
  const cells = new Set(all.slice(1).map(c => c.key));
  assert.equal(isRectangularCellSet(cells, graph), false);
});

test('boundsShareEdge: 正の長さの辺を共有する2矩形は true（部分重なり含む）', () => {
  const a = { x1: 0, y1: 0, x2: 1000, y2: 1000 };
  const bFull = { x1: 1000, y1: 0, x2: 2000, y2: 1000 };
  assert.equal(boundsShareEdge(a, bFull), true, '辺全体が一致');
  const bPartial = { x1: 1000, y1: 500, x2: 2000, y2: 1500 };
  assert.equal(boundsShareEdge(a, bPartial), true, '辺の一部だけ重なる（長さ正）');
});

test('boundsShareEdge: 角だけで接する2矩形は false', () => {
  const a = { x1: 0, y1: 0, x2: 1000, y2: 1000 };
  const b = { x1: 1000, y1: 1000, x2: 2000, y2: 2000 };
  assert.equal(boundsShareEdge(a, b), false);
});

test('boundsShareEdge: 離れている2矩形は false', () => {
  const a = { x1: 0, y1: 0, x2: 1000, y2: 1000 };
  const b = { x1: 2000, y1: 0, x2: 3000, y2: 1000 };
  assert.equal(boundsShareEdge(a, b), false);
});

test('connectedCellComponents: 1列3セルの中央を抜くと2成分になり、並びは各成分の最小キー昇順で決定的', () => {
  const { graph } = makeFullGrid([0, 1000, 2000, 3000], [0, 1000]);
  const left  = cellAt(graph, 0, 0, 1000, 1000);
  const right = cellAt(graph, 2000, 0, 3000, 1000);
  assert.ok(left && right);
  const cells = new Set([left.key, right.key]); // 中央(1000-2000)は含めない

  const comps1 = connectedCellComponents(cells, graph);
  assert.equal(comps1.length, 2);
  const comps2 = connectedCellComponents(cells, graph);
  const toSortedArr = comps => comps.map(s => [...s].sort());
  assert.deepEqual(toSortedArr(comps1), toSortedArr(comps2), '同じ入力なら並びが決定的');
  // 各成分は単一セルのまま
  assert.ok(comps1.every(s => s.size === 1));
});

test('connectedCellComponents: 辺で隣接する2セルは1成分にまとまる', () => {
  const { graph } = makeFullGrid([0, 1000, 2000], [0, 1000]);
  const cells = new Set(getAllCells(graph).map(c => c.key)); // 1行2セル、辺で隣接
  assert.equal(cells.size, 2);
  const comps = connectedCellComponents(cells, graph);
  assert.equal(comps.length, 1);
  assert.equal(comps[0].size, 2);
});

// ================================================================
// 天井芯（S8a）: 分割の変種（grid）。天伏の天井セルだけを割り、仕上げの格子には一切現れない
// ================================================================

// 2x2の格子（0/1000/2000）に、x=500 の天井芯を足した組と、足さない組（比較用）。
// CL の id を固定する（2つのグラフで key を直接比べるため）。天井芯は全高(extent 未確定)に及ぶ。
function makeFixedGrid(withCeiling) {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  [0, 1000, 2000].forEach((v, i) => graph.addCenterLine(CenterLineType.VERTICAL, v, {
    labeled: i !== 1, discipline: i !== 1 ? Discipline.STRUCT : Discipline.ARCH,
  }, `v${i}`));
  [0, 1000, 2000].forEach((v, i) => graph.addCenterLine(CenterLineType.HORIZONTAL, v, {
    labeled: i !== 1, discipline: i !== 1 ? Discipline.STRUCT : Discipline.ARCH,
  }, `h${i}`));
  const ceilingCL = withCeiling
    ? graph.addCenterLine(CenterLineType.VERTICAL, 500, { labeled: false, discipline: Discipline.CEILING }, 'cc')
    : null;
  return { graph, ceilingCL };
}
function makeWithAndWithoutCeiling() {
  const plain = makeFixedGrid(false);
  const withC = makeFixedGrid(true);
  return { plain, withC, ceilingCL: withC.ceilingCL };
}
const cellRect = c => `${c.x1},${c.y1},${c.x2},${c.y2}`;

test('天井芯: 既定（仕上げ）の worldToCell・regionCellsAt・getAllCells・gridIndexOf は天井芯の有無で一切変わらない（allXValues も含む）', () => {
  const { plain, withC } = makeWithAndWithoutCeiling();
  for (const [x, y] of [[250, 500], [750, 500], [1500, 500], [500, 1500], [-10, 0]]) {
    assert.deepEqual(worldToCell(x, y, withC.graph), worldToCell(x, y, plain.graph), `worldToCell(${x},${y})`);
    assert.deepEqual(regionCellsAt(x, y, withC.graph), regionCellsAt(x, y, plain.graph), `regionCellsAt(${x},${y})`);
  }
  assert.deepEqual(getAllCells(withC.graph), getAllCells(plain.graph));
  const a = gridIndexOf(withC.graph), b = gridIndexOf(plain.graph);
  assert.deepEqual(a.xValues, b.xValues, '仕上げの分割格子 xValues');
  assert.deepEqual(a.allXValues, b.allXValues, '展開図の区間刻み allXValues に天井芯の座標(500)が入らない');
  assert.deepEqual(a.allYValues, b.allYValues);
  assert.ok(!a.allXValues.includes(500));
  assert.deepEqual(a.verticals.map(s => s.id), b.verticals.map(s => s.id), '仕上げの分割線（verticals）に天井芯が入らない');
});

test('天井芯: CEILING_CELL_GRID では天井芯で割れる。天井芯が無ければ仕上げと key も順序も一致する', () => {
  const { plain, withC, ceilingCL } = makeWithAndWithoutCeiling();
  // 天井芯なし: 天井の格子＝仕上げの格子
  assert.deepEqual(getAllCells(plain.graph, CEILING_CELL_GRID), getAllCells(plain.graph), '天井芯なしなら getAllCells が一致（key・順序とも）');
  assert.deepEqual(worldToCell(250, 500, plain.graph, CEILING_CELL_GRID), worldToCell(250, 500, plain.graph));
  // 天井芯あり（全高）: 左列の2セルが x=500 で2つずつに割れる（仕上げは4セルのまま、天井は6セル）
  assert.equal(getAllCells(withC.graph).length, 4);
  const ceilingCells = getAllCells(withC.graph, CEILING_CELL_GRID);
  assert.equal(ceilingCells.length, 6);
  const left  = worldToCell(250, 500, withC.graph, CEILING_CELL_GRID);
  const right = worldToCell(750, 500, withC.graph, CEILING_CELL_GRID);
  assert.deepEqual([left.x1, left.x2, right.x1, right.x2], [0, 500, 500, 1000]);
  assert.ok(left.key.split(':')[2] === ceilingCL.id && right.key.split(':')[0] === ceilingCL.id, '境界の識別子は天井芯のid');
  // region（連結領域）も天井芯で分かれる
  assert.deepEqual(regionCellsAt(250, 500, withC.graph, CEILING_CELL_GRID).map(cellRect), ['0,0,500,1000']);
  assert.equal(regionCellsAt(250, 500, withC.graph).length, 1, '仕上げの領域は1セル(0..1000)');
  // 天井芯の無い側（右列）のセルは仕上げと同じ key
  const rightCol = worldToCell(1500, 500, withC.graph, CEILING_CELL_GRID);
  assert.equal(rightCol.key, worldToCell(1500, 500, withC.graph).key);
});

test('天井芯: 仕上げの key と天井の key は衝突しない（割れたセルの key は天井芯idを含み、仕上げの key 集合に無い）。cellBoundsFromKey は天井 key を解ける', () => {
  const { withC, ceilingCL } = makeWithAndWithoutCeiling();
  const finishKeys = new Set(getAllCells(withC.graph).map(c => c.key));
  const split = getAllCells(withC.graph, CEILING_CELL_GRID).filter(c => c.key.includes(ceilingCL.id));
  assert.equal(split.length, 4, '天井芯を境界に持つ天井セルは左列2セル×左右の4つ');
  for (const c of split) {
    assert.ok(!finishKeys.has(c.key), `天井セルの key が仕上げの key と衝突: ${c.key}`);
    assert.deepEqual(cellBoundsFromKey(c.key, withC.graph), { x1: c.x1, x2: c.x2, y1: c.y1, y2: c.y2 }, 'cellBoundsFromKey が天井 key を解く');
  }
});

test('天井芯: 読み取りスコープ内でも仕上げと天井のキャッシュが混ざらない（同じ点の問い合わせが変種ごとに別の答え）', () => {
  const { withC } = makeWithAndWithoutCeiling();
  withGraphReadScope(withC.graph, () => {
    const f1 = worldToCell(250, 500, withC.graph);
    const c1 = worldToCell(250, 500, withC.graph, CEILING_CELL_GRID);
    const f2 = worldToCell(250, 500, withC.graph);
    const c2 = worldToCell(250, 500, withC.graph, CEILING_CELL_GRID);
    assert.equal(f1.x2, 1000);
    assert.equal(c1.x2, 500);
    assert.equal(f2, f1, '仕上げの結果はキャッシュされ同一');
    assert.equal(c2, c1, '天井の結果はキャッシュされ同一');
    assert.notEqual(gridIndexOf(withC.graph), gridIndexOf(withC.graph, CEILING_CELL_GRID), '索引も変種ごとに別');
  });
});

test('天井芯: 部分長の天井芯は extent の範囲だけ割る（L字併合は仕上げと同じ規則）', () => {
  const { withC, ceilingCL } = makeWithAndWithoutCeiling();
  // 天井芯を上段(y:0..1000)だけに短縮: 下段のセル(0..1000 x 1000..2000)は割れない
  ceilingCL.setProps({ _extentLo: 0, _extentHi: 1000 });
  assert.equal(worldToCell(250, 500, withC.graph, CEILING_CELL_GRID).x2, 500, '上段は割れる');
  assert.equal(worldToCell(250, 1500, withC.graph, CEILING_CELL_GRID).x2, 1000, '下段は割れない');
});
