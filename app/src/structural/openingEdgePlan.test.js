// openingEdgePlan.js（開口辺の計画器。梁あり判定＋初回スパンで一度だけ順位を決める配置）の単体テスト。
// 純関数のためグラフは使わず、辺と支えの素の値で数値を固定する。
// 記法: isVertical=true は x=coord の縦線（lo/hi は y 範囲）、false は y=coord の横線（lo/hi は x 範囲）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planOpeningEdgeBeams } from './openingEdgePlan.js';

const INF = Infinity;

/** 矩形 [x1,x2]×[y1,y2] の4辺（逃げなし: target=coord）。 */
function rectEdges(x1, x2, y1, y2) {
  return [
    { isVertical: false, coord: y1, lo: x1, hi: x2, outwardSign: -1, target: y1, axisCL: 'top' },
    { isVertical: false, coord: y2, lo: x1, hi: x2, outwardSign: 1, target: y2, axisCL: 'bottom' },
    { isVertical: true, coord: x1, lo: y1, hi: y2, outwardSign: -1, target: x1, axisCL: 'left' },
    { isVertical: true, coord: x2, lo: y1, hi: y2, outwardSign: 1, target: x2, axisCL: 'right' },
  ];
}

/** 通り芯（全長）。xs は縦線の x、ys は横線の y。 */
function gridHosts(xs, ys) {
  return [
    ...xs.map(x => ({ isVertical: true, coord: x, lo: -INF, hi: INF, kind: 'grid', clId: `gx${x}` })),
    ...ys.map(y => ({ isVertical: false, coord: y, lo: -INF, hi: INF, kind: 'grid', clId: `gy${y}` })),
  ];
}

const OPTS = { coverTol: 50 };
const orderOf = plan => plan.placed.map(p => `${p.edge.isVertical ? 'V' : 'H'}${p.edge.coord}`);

test('4辺とも梁なし・横長矩形でも縦辺のスパンの方が短ければ縦辺の組が先に通る（同値タイブレークで風車にならない）', () => {
  // 矩形 x[2000,6000] y[1000,3000]（横長: 従来は横辺通し）。通り芯 X:0,8000 / Y:0,6000。
  // 初回スパン: 縦辺 6000（2本）／横辺 8000（2本）。順位は初回スパンで一度だけ決める。
  // 置き直しごとに再計算すると H1000(6000, 長辺優先) が V6000 より先になり風車状になるが、そうはならない。
  const plan = planOpeningEdgeBeams(rectEdges(2000, 6000, 1000, 3000), gridHosts([0, 8000], [0, 6000]), OPTS);
  assert.deepEqual(orderOf(plan), ['V2000', 'V6000', 'H1000', 'H3000']);
  const [v1, v2, h1, h2] = plan.placed;
  assert.equal(v1.span, 6000);
  assert.deepEqual(v1.loRef, { kind: 'grid', coord: 0, clId: 'gy0' });
  assert.deepEqual(v1.hiRef, { kind: 'grid', coord: 6000, clId: 'gy6000' });
  assert.equal(v1.through, true);
  assert.equal(v2.span, 6000);
  assert.equal(v2.through, true);
  // 横辺は先に置いた縦辺の間に掛かる: スパン 8000 でなく 4000。
  assert.equal(h1.span, 4000);
  assert.deepEqual(h1.loRef, { kind: 'opening', coord: 2000 });
  assert.deepEqual(h1.hiRef, { kind: 'opening', coord: 6000 });
  assert.equal(h1.through, false);
  assert.equal(h2.span, 4000);
  assert.deepEqual(h2.hiRef, { kind: 'opening', coord: 6000 });
  // 通しの組（縦2本）は通り芯に架かり、掛け梁（横2本）は縦2本に架かる。毎回再計算だと
  // V2000 → H1000(6000, 長辺優先) → V6000(5000) → H3000(4000) の風車になる。
  assert.deepEqual(plan.placed.map(p => p.through), [true, true, false, false]);
  assert.deepEqual(plan.placed.map(p => p.order), [0, 1, 2, 3]);
  assert.equal(plan.covered.length + plan.excluded.length + plan.unsupported.length, 0);
});

test('横長矩形で横辺のスパンの方が短ければ横辺が先に架かる', () => {
  // 矩形 x[2000,6000] y[1000,3000]。通り芯 X:1000,7000（横辺スパン 6000）/ Y:0,9000（縦辺スパン 9000）。
  const plan = planOpeningEdgeBeams(rectEdges(2000, 6000, 1000, 3000), gridHosts([1000, 7000], [0, 9000]), OPTS);
  assert.deepEqual(orderOf(plan), ['H1000', 'H3000', 'V2000', 'V6000']);
  assert.equal(plan.placed[0].span, 6000);
  assert.equal(plan.placed[0].through, true);
  assert.equal(plan.placed[2].span, 2000);
  assert.deepEqual(plan.placed[2].loRef, { kind: 'opening', coord: 1000 });
  assert.deepEqual(plan.placed[2].hiRef, { kind: 'opening', coord: 3000 });
});

test('縦長矩形で縦辺のスパンの方が短ければ縦辺が先に架かる', () => {
  // 矩形 x[2000,4000] y[1000,5000]（縦長）。通り芯 X:0,8000 / Y:0,6000。
  const plan = planOpeningEdgeBeams(rectEdges(2000, 4000, 1000, 5000), gridHosts([0, 8000], [0, 6000]), OPTS);
  assert.deepEqual(orderOf(plan), ['V2000', 'V4000', 'H1000', 'H5000']);
  assert.equal(plan.placed[0].span, 6000);
  assert.equal(plan.placed[2].span, 2000);
});

test('外接矩形は縦長でもスパンは横辺の方が短ければ横辺が先に架かる（従来の長辺通しと異なる）', () => {
  // 矩形 x[2000,4000] y[1000,5000]（縦長: 従来は縦辺通し）。通り芯 X:1000,5000（横辺スパン 4000）/ Y:0,9000（縦辺スパン 9000）。
  const plan = planOpeningEdgeBeams(rectEdges(2000, 4000, 1000, 5000), gridHosts([1000, 5000], [0, 9000]), OPTS);
  assert.deepEqual(orderOf(plan), ['H1000', 'H5000', 'V2000', 'V4000']);
  assert.equal(plan.placed[0].span, 4000);
  assert.equal(plan.placed[0].through, true);
  // 縦辺は先に架けた横辺に架かる: スパン 4000（9000 ではない）。
  assert.equal(plan.placed[2].span, 4000);
  assert.deepEqual(plan.placed[2].loRef, { kind: 'opening', coord: 1000 });
  assert.deepEqual(plan.placed[2].hiRef, { kind: 'opening', coord: 5000 });
});

test('同長矩形でスパンも同じなら X方向（横線）が先、同方向は coord 昇順', () => {
  const plan = planOpeningEdgeBeams(rectEdges(2000, 4000, 1000, 3000), gridHosts([0, 6000], [0, 6000]), OPTS);
  // 初回スパンは全辺 6000 → X方向の対辺の組が先（H1000, H3000）、残りの組がその間に掛かる（2000）。
  assert.deepEqual(orderOf(plan), ['H1000', 'H3000', 'V2000', 'V4000']);
  assert.deepEqual(plan.placed.map(p => p.span), [6000, 6000, 2000, 2000]);
});

test('スパンが同値（0.5以内）なら辺の長い方が先', () => {
  // 矩形 x[2000,5000] y[1000,3000]。横辺スパン 6000 / 縦辺スパン 5999.8（差 0.2 → 同値扱い）。
  // 縦辺の方がわずかに短いが、辺の長い横辺（長さ3000）が先。
  const hosts = [...gridHosts([0, 6000], []), ...gridHosts([], [0, 5999.8])];
  const plan = planOpeningEdgeBeams(rectEdges(2000, 5000, 1000, 3000), hosts, OPTS);
  assert.equal(orderOf(plan)[0], 'H1000');
  assert.equal(plan.placed[0].span, 6000);
  // 入力順（縦辺が先頭になる逆順）に依らない。
  const rev = planOpeningEdgeBeams(rectEdges(2000, 5000, 1000, 3000).reverse(), hosts, OPTS);
  assert.equal(orderOf(rev)[0], 'H1000');
  // 差が 0.5 を超えれば短い方（縦辺）が先。
  const hosts2 = [...gridHosts([0, 6000], []), ...gridHosts([], [0, 5990])];
  const plan2 = planOpeningEdgeBeams(rectEdges(2000, 5000, 1000, 3000), hosts2, OPTS);
  assert.equal(orderOf(plan2)[0], 'V2000');
  assert.equal(plan2.placed[0].span, 5990);
  // 同値で辺の長さも同じ（2000×2000）なら X方向が先。
  const plan3 = planOpeningEdgeBeams(rectEdges(2000, 4000, 1000, 3000), hosts, OPTS);
  assert.equal(orderOf(plan3)[0], 'H1000');
  const plan3rev = planOpeningEdgeBeams(rectEdges(2000, 4000, 1000, 3000).reverse(), hosts, OPTS);
  assert.deepEqual(orderOf(plan3rev), orderOf(plan3));
  // 同じ向きの同順位は coord 昇順（逆順入力でも H1000 が H3000 より先）。
  const flat = planOpeningEdgeBeams(rectEdges(2000, 4000, 1000, 3000).filter(e => !e.isVertical).reverse(), gridHosts([0, 6000], []), OPTS);
  assert.deepEqual(orderOf(flat), ['H1000', 'H3000']);
});

test('1辺が壁（covered）で残り3辺: 壁は直交辺の支えとして残る', () => {
  // 矩形 x[2000,5000] y[1000,3000]。上辺 y=1000 に壁（x 1000..6000）。通り芯 X:0,8000 / Y:0,6000。
  const wall = { isVertical: false, coord: 1000, lo: 1000, hi: 6000, kind: 'wall', clId: 'w1' };
  const plan = planOpeningEdgeBeams(rectEdges(2000, 5000, 1000, 3000), [...gridHosts([0, 8000], [0, 6000]), wall], OPTS);
  assert.equal(plan.covered.length, 1);
  assert.equal(plan.covered[0].edge.axisCL, 'top');
  assert.equal(plan.covered[0].host, wall);
  assert.deepEqual(orderOf(plan), ['V2000', 'V5000', 'H3000']);
  // 縦辺は壁（y=1000）から下の通り芯 y=6000 まで: スパン 5000。
  assert.equal(plan.placed[0].span, 5000);
  assert.deepEqual(plan.placed[0].loRef, { kind: 'wall', coord: 1000, clId: 'w1' });
  assert.deepEqual(plan.placed[0].hiRef, { kind: 'grid', coord: 6000, clId: 'gy6000' });
  assert.equal(plan.placed[0].through, true);
  // 下辺は先に架けた縦辺に架かる: スパン 3000。
  assert.equal(plan.placed[2].span, 3000);
  assert.deepEqual(plan.placed[2].loRef, { kind: 'opening', coord: 2000 });
});

test('手動梁が target 側にだけ一致する辺は covered になり host に残る', () => {
  // 上辺は coord=1000 だが逃げで target=1100。手動梁は y=1100（coord とは 100 離れ coverTol=50 を超える）。
  // 縦辺の上端は逃げ後の 1100（呼び出し側が与える）。
  const edges = [
    { isVertical: false, coord: 1000, lo: 2000, hi: 5000, target: 1100 },
    { isVertical: false, coord: 3000, lo: 2000, hi: 5000, target: 3000 },
    { isVertical: true, coord: 2000, lo: 1100, hi: 3000, target: 2000 },
    { isVertical: true, coord: 5000, lo: 1100, hi: 3000, target: 5000 },
  ];
  const manual = { isVertical: false, coord: 1100, lo: 0, hi: 7000, kind: 'beam', clId: 'mb', manual: true };
  const plan = planOpeningEdgeBeams(edges, [...gridHosts([0, 8000], [0, 6000]), manual], OPTS);
  assert.equal(plan.covered.length, 1);
  assert.equal(plan.covered[0].edge, edges[0]);
  assert.equal(plan.covered[0].host, manual);
  assert.deepEqual(orderOf(plan), ['V2000', 'V5000', 'H3000']);
  assert.deepEqual(plan.placed[0].loRef, { kind: 'beam', coord: 1100, clId: 'mb' });
  assert.equal(plan.placed[0].span, 4900);
  // target ではなく coord 側にだけ一致する場合も covered。
  const e2 = [{ isVertical: false, coord: 1000, lo: 2000, hi: 5000, target: 1200 }];
  const plan2 = planOpeningEdgeBeams(e2, [{ ...manual, coord: 1040 }], OPTS);
  assert.equal(plan2.covered.length, 1);
  // どちらからも coverTol を超えれば covered でない（支えが無く unsupported）。
  const plan3 = planOpeningEdgeBeams(e2, [{ ...manual, coord: 1080 }], OPTS);
  assert.equal(plan3.covered.length, 0);
  assert.equal(plan3.unsupported.length, 1);
});

test('excluded（canPlace が false）の辺は架けず、直交辺の host にもならない', () => {
  const edges = rectEdges(2000, 5000, 1000, 3000);
  const hosts = gridHosts([0, 8000], [0, 6000]);
  // 基準: 全部架かるとき V2000(6000) → V5000(6000) → H1000(3000) → H3000(3000)。
  const base = planOpeningEdgeBeams(edges, hosts, OPTS);
  assert.deepEqual(orderOf(base), ['V2000', 'V5000', 'H1000', 'H3000']);
  assert.deepEqual(base.placed.map(p => p.span), [6000, 6000, 3000, 3000]);
  // 左の縦辺 x=2000 を除外: 右の縦辺 x=5000 だけ架かり、横辺は左側が通り芯 x=0 になる（スパン 5000）。
  const plan = planOpeningEdgeBeams(edges, hosts, { ...OPTS, canPlace: e => !(e.isVertical && e.coord === 2000) });
  assert.equal(plan.excluded.length, 1);
  assert.equal(plan.excluded[0].edge.axisCL, 'left');
  assert.deepEqual(orderOf(plan), ['V5000', 'H1000', 'H3000']);
  assert.equal(plan.placed[1].span, 5000);
  assert.deepEqual(plan.placed[1].loRef, { kind: 'grid', coord: 0, clId: 'gx0' });
  assert.deepEqual(plan.placed[1].hiRef, { kind: 'opening', coord: 5000 });
});

test('支えなし: 片側しか支えが無い辺は unsupported、連鎖で架かる辺は架かる', () => {
  // 縦の通り芯 x=0,8000 だけ: 横辺は両側が取れて架かり、縦辺は先に架けた横辺（y=1000,3000）に架かる。
  const chain = planOpeningEdgeBeams(rectEdges(2000, 5000, 1000, 3000), gridHosts([0, 8000], []), OPTS);
  assert.deepEqual(orderOf(chain), ['H1000', 'H3000', 'V2000', 'V5000']);
  assert.equal(chain.placed[0].span, 8000);
  assert.equal(chain.placed[2].span, 2000);
  assert.equal(chain.unsupported.length, 0);
  // 縦の通り芯 x=0 だけ: 横辺は hi 側が無く、縦辺は支え無し。全辺 unsupported。
  const none = planOpeningEdgeBeams(rectEdges(2000, 5000, 1000, 3000), gridHosts([0], []), OPTS);
  assert.equal(none.placed.length, 0);
  assert.equal(none.unsupported.length, 4);
  // 支えが全く無い。
  assert.equal(planOpeningEdgeBeams(rectEdges(2000, 5000, 1000, 3000), [], OPTS).unsupported.length, 4);
});

test('target を区間に含まない直交 host は支えにならない', () => {
  // x=0 の縦線は y 0..500 までしか無く、横辺 y=1000 には届かない。
  const hosts = [
    { isVertical: true, coord: 0, lo: 0, hi: 500, kind: 'beam', clId: 'short' },
    { isVertical: true, coord: 8000, lo: -INF, hi: INF, kind: 'grid', clId: 'gx8000' },
  ];
  const plan = planOpeningEdgeBeams([{ isVertical: false, coord: 1000, lo: 2000, hi: 5000, target: 1000 }], hosts, OPTS);
  assert.equal(plan.placed.length, 0);
  assert.equal(plan.unsupported.length, 1);
});

test('入力順を入れ替えても結果は同じ', () => {
  const edges = rectEdges(2000, 4000, 1000, 3000);
  const hosts = gridHosts([0, 6000], [0, 6000]);
  const summary = p => p.placed.map(x => `${x.order}:${x.edge.isVertical ? 'V' : 'H'}${x.edge.coord}:${x.span}:${x.loRef.kind}${x.loRef.coord}:${x.hiRef.kind}${x.hiRef.coord}`);
  const a = summary(planOpeningEdgeBeams(edges, hosts, OPTS));
  const b = summary(planOpeningEdgeBeams([...edges].reverse(), [...hosts].reverse(), OPTS));
  const c = summary(planOpeningEdgeBeams([edges[2], edges[0], edges[3], edges[1]], [hosts[2], hosts[0], hosts[3], hosts[1]], OPTS));
  assert.equal(a.length, 4);
  assert.deepEqual(b, a);
  assert.deepEqual(c, a);
});

test('部分被覆: 区間の一部だけ重なる host でも covered、重なりが CL_OVERLAP_TOL_MM 以下なら covered でない', () => {
  const edge = { isVertical: false, coord: 1000, lo: 2000, hi: 5000, target: 1000 };
  const mk = lo => ({ isVertical: false, coord: 1000, lo, hi: 9000, kind: 'wall', clId: 'w' });
  assert.equal(planOpeningEdgeBeams([edge], [mk(4000)], OPTS).covered.length, 1);
  assert.equal(planOpeningEdgeBeams([edge], [mk(4999)], OPTS).covered.length, 1);
  // 重なり 0.5（許容誤差ちょうど）は covered でない。重なり 0 も同様。
  assert.equal(planOpeningEdgeBeams([edge], [mk(4999.5)], OPTS).covered.length, 0);
  assert.equal(planOpeningEdgeBeams([edge], [mk(5000)], OPTS).covered.length, 0);
});

test('coverTol 境界: 丁度は covered、超過は covered でない', () => {
  const edge = { isVertical: true, coord: 2000, lo: 1000, hi: 3000, target: 2000 };
  const mk = coord => ({ isVertical: true, coord, lo: 0, hi: 6000, kind: 'beam', clId: 'b' });
  assert.equal(planOpeningEdgeBeams([edge], [mk(2050)], { coverTol: 50 }).covered.length, 1);
  assert.equal(planOpeningEdgeBeams([edge], [mk(1950)], { coverTol: 50 }).covered.length, 1);
  assert.equal(planOpeningEdgeBeams([edge], [mk(2050.5)], { coverTol: 50 }).covered.length, 0);
  // coverTol=0 なら完全一致のみ。
  assert.equal(planOpeningEdgeBeams([edge], [mk(2000)], { coverTol: 0 }).covered.length, 1);
  assert.equal(planOpeningEdgeBeams([edge], [mk(2001)], { coverTol: 0 }).covered.length, 0);
});

test('平行でない host は梁ありにしない／余分なフィールドは出力へそのまま渡る', () => {
  const edge = { isVertical: false, coord: 1000, lo: 2000, hi: 5000, target: 1000, axisCL: { id: 'cl1' }, componentId: 7 };
  const orth = { isVertical: true, coord: 1000, lo: 0, hi: 6000, kind: 'beam', clId: 'o' };
  const plan = planOpeningEdgeBeams([edge], [orth, ...gridHosts([0, 8000], [])], OPTS);
  assert.equal(plan.covered.length, 0);
  assert.equal(plan.placed.length, 1);
  assert.equal(plan.placed[0].edge, edge);
  assert.equal(plan.placed[0].edge.componentId, 7);
  assert.equal(plan.placed[0].target, 1000);
});

test('逃げ後の target が出力の target になる', () => {
  const edge = { isVertical: false, coord: 1000, lo: 2000, hi: 5000, target: 1060 };
  const plan = planOpeningEdgeBeams([edge], gridHosts([0, 8000], []), OPTS);
  assert.equal(plan.placed[0].target, 1060);
  assert.equal(plan.placed[0].edge.coord, 1000);
});

/** 配列の全順列。 */
function permutations(arr) {
  if (arr.length <= 1) return [arr];
  return arr.flatMap((x, i) => permutations([...arr.slice(0, i), ...arr.slice(i + 1)]).map(p => [x, ...p]));
}

test('初回スパンの同値判定が推移的でなくても、全6順列の入力で順序が同じ（グループ分け）', () => {
  // 横辺3本の初回スパン 6000／6000.4／6000.8、辺長 1000／2000／3000。
  // 先頭(6000)との差 0.5 以内＝{e1,e2}、0.8 は別グループ {e3}。グループ内は長辺優先。
  const e1 = { isVertical: false, coord: 1000, lo: 2000, hi: 3000, target: 1000 };
  const e2 = { isVertical: false, coord: 2000, lo: 2000, hi: 4000, target: 2000 };
  const e3 = { isVertical: false, coord: 3000, lo: 2000, hi: 5000, target: 3000 };
  const hosts = [
    { isVertical: true, coord: 0, lo: -INF, hi: INF, kind: 'grid', clId: 'gx0' },
    { isVertical: true, coord: 6000, lo: 900, hi: 1100, kind: 'beam', clId: 'b1' },
    { isVertical: true, coord: 6000.4, lo: 1900, hi: 2100, kind: 'beam', clId: 'b2' },
    { isVertical: true, coord: 6000.8, lo: 2900, hi: 3100, kind: 'beam', clId: 'b3' },
  ];
  const results = permutations([e1, e2, e3]).map(es => {
    const plan = planOpeningEdgeBeams(es, hosts, OPTS);
    return plan.placed.map(p => `${p.order}:H${p.edge.coord}:${p.span}`);
  });
  const expected = ['0:H2000:6000.4', '1:H1000:6000', '2:H3000:6000.8'];
  assert.equal(results.length, 6);
  for (const r of results) assert.deepEqual(r, expected);
});

test('入力検証: coverTol が不正・辺の座標が有限でなければ throw（黙って誤判定しない）', () => {
  const edge = { isVertical: false, coord: 1000, lo: 2000, hi: 5000, target: 1000 };
  const far = { isVertical: false, coord: 9000, lo: -INF, hi: INF, kind: 'beam', clId: 'far' };
  assert.throws(() => planOpeningEdgeBeams([edge], [far], {}), /coverTol/);
  assert.throws(() => planOpeningEdgeBeams([edge], [far], { coverTol: NaN }), /coverTol/);
  assert.throws(() => planOpeningEdgeBeams([edge], [far], { coverTol: -1 }), /coverTol/);
  assert.throws(() => planOpeningEdgeBeams([edge], [far], { coverTol: 50, bracketEps: NaN }), /bracketEps/);
  assert.throws(() => planOpeningEdgeBeams([{ ...edge, target: NaN }], [], OPTS), /target/);
  assert.throws(() => planOpeningEdgeBeams([{ ...edge, hi: INF }], [], OPTS), /hi/);
  // 正常値なら遠い平行支えは covered にならない。
  assert.equal(planOpeningEdgeBeams([edge], [far], OPTS).covered.length, 0);
});

test('支え不足（初回スパン Infinity）の辺は最後尾に回り、先に置いた梁に架かる', () => {
  // 縦長 x[2000,4000]×y[1000,5000]。支えは縦の通り芯 x=0,8000 だけ。
  // 縦辺は初回は支えが無い(Infinity)が、横辺（8000）を置いた後にその間へ架かる。
  const plan = planOpeningEdgeBeams(rectEdges(2000, 4000, 1000, 5000), gridHosts([0, 8000], []), OPTS);
  assert.deepEqual(orderOf(plan), ['H1000', 'H5000', 'V2000', 'V4000']);
  assert.deepEqual(plan.placed.map(p => p.span), [8000, 8000, 4000, 4000]);
  assert.equal(plan.unsupported.length, 0);
});

test('同座標の支えが複数あれば kind 優先（grid が user に勝つ）で入力順に依らない', () => {
  const edge = { isVertical: false, coord: 1000, lo: 2000, hi: 4000, target: 1000 };
  const user = { isVertical: true, coord: 0, lo: -INF, hi: INF, kind: 'user', clId: 'u0' };
  const grid = { isVertical: true, coord: 0, lo: -INF, hi: INF, kind: 'grid', clId: 'gx0' };
  const right = { isVertical: true, coord: 8000, lo: -INF, hi: INF, kind: 'grid', clId: 'gx8000' };
  for (const hosts of [[user, grid, right], [grid, user, right], [right, user, grid]]) {
    const plan = planOpeningEdgeBeams([edge], hosts, OPTS);
    assert.deepEqual(plan.placed[0].loRef, { kind: 'grid', coord: 0, clId: 'gx0' });
  }
});

test('座標が浮動小数点誤差だけ違う支えにも kind 優先が効く（grid@0 が opening@1e-10 に勝つ）', () => {
  // 1e-10 のずれは FLOAT_EPS 以内＝同座標として扱い、kind の順（grid < opening）で選ぶ。
  // 厳密比較（===）に戻すと、わずかに大きい opening@1e-10 が「より内側の支え」として選ばれてしまう。
  const edge = { isVertical: false, coord: 1000, lo: 2000, hi: 5000, target: 1000 };
  const opening = { isVertical: true, coord: 1e-10, lo: -INF, hi: INF, kind: 'opening' };
  const grid = { isVertical: true, coord: 0, lo: -INF, hi: INF, kind: 'grid', clId: 'g' };
  const right = { isVertical: true, coord: 8000, lo: -INF, hi: INF, kind: 'grid', clId: 'gx8000' };
  for (const hosts of [[opening, grid, right], [grid, opening, right], [right, opening, grid]]) {
    const plan = planOpeningEdgeBeams([edge], hosts, OPTS);
    assert.equal(plan.placed[0].loRef.kind, 'grid');
    assert.equal(plan.placed[0].loRef.clId, 'g');
  }
});

test('bracketEps 境界: 既定の許容内にずれた直交支えは拾い、eps=0 では拾わない', () => {
  // 横辺 y=1000 x[2000,4000]。支えは縦線 x=2000.4 と x=3999.6（辺端から 0.4 内側）。
  const edge = { isVertical: false, coord: 1000, lo: 2000, hi: 4000, target: 1000 };
  const hosts = [
    { isVertical: true, coord: 2000.4, lo: -INF, hi: INF, kind: 'beam', clId: 'l' },
    { isVertical: true, coord: 3999.6, lo: -INF, hi: INF, kind: 'beam', clId: 'r' },
  ];
  // lo 側は coord ≤ 2000+eps なので 2000.4 は eps=0.5 で拾え、hi 側も同様。
  const def = planOpeningEdgeBeams([edge], hosts, OPTS);
  assert.equal(def.placed.length, 1);
  assert.equal(def.placed[0].loRef.coord, 2000.4);
  assert.equal(def.placed[0].hiRef.coord, 3999.6);
  assert.ok(Math.abs(def.placed[0].span - 1999.2) < 1e-9);
  const zero = planOpeningEdgeBeams([edge], hosts, { ...OPTS, bracketEps: 0 });
  assert.equal(zero.placed.length, 0);
  assert.equal(zero.unsupported.length, 1);
});

test('covered／excluded の出力順も入力順に依らない', () => {
  const edges = rectEdges(2000, 5000, 1000, 3000);
  const walls = [
    { isVertical: false, coord: 1000, lo: 0, hi: 9000, kind: 'wall', clId: 'w1' },
    { isVertical: false, coord: 3000, lo: 0, hi: 9000, kind: 'wall', clId: 'w3' },
  ];
  for (const es of [edges, [...edges].reverse()]) {
    const plan = planOpeningEdgeBeams(es, walls, OPTS);
    assert.deepEqual(plan.covered.map(c => `${c.edge.coord}:${c.host.clId}`), ['1000:w1', '3000:w3']);
    const ex = planOpeningEdgeBeams(es, [], { ...OPTS, canPlace: () => false });
    assert.deepEqual(ex.excluded.map(c => `${c.edge.isVertical ? 'V' : 'H'}${c.edge.coord}`), ['H1000', 'H3000', 'V2000', 'V5000']);
  }
});
