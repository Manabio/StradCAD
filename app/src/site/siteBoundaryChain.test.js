import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Site } from '../core.js';
import { SITE_BOUNDARY_CHAIN_BREAK_FRACTION, SITE_BOUNDARY_CHAIN_SINGLE_BREAK_MAX_RATIO } from '../core/constants.js';
import { SITE_BOUNDARY_DASH, SITE_BOUNDARY_CHAIN } from './siteLineStyle.js';
import {
  chainBreakPositions, chainSolidRuns, composeBoundaryChains, composeSiteBoundaryChains, isLinesLayerChain, isRectsLayerChain,
} from './siteBoundaryChain.js';
const close = (actual, expected, msg) => assert.ok(Math.abs(actual - expected) < 1e-6, `${msg ?? ''} actual=${actual} expected=${expected}`);
const closeAll = (actual, expected, msg) => {
  assert.equal(actual.length, expected.length, `${msg ?? ''} 長さ actual=${JSON.stringify(actual)}`);
  expected.forEach((e, i) => close(actual[i], e, `${msg ?? ''}[${i}]`));
};
const P = (key, ax, ay, bx, by) => ({ key, a: { x: ax, y: ay }, b: { x: bx, y: by } });

test('定数: 比は 0.25 と 0.5、間・点は SITE_BOUNDARY_DASH の「間」「点」', () => {
  assert.equal(SITE_BOUNDARY_CHAIN_BREAK_FRACTION, 0.25);
  assert.equal(SITE_BOUNDARY_CHAIN_SINGLE_BREAK_MAX_RATIO, 0.5);
  assert.deepEqual({ ...SITE_BOUNDARY_CHAIN }, { gapPx: SITE_BOUNDARY_DASH[1], dotPx: SITE_BOUNDARY_DASH[2] });
  assert.deepEqual({ ...SITE_BOUNDARY_CHAIN }, { gapPx: 4, dotPx: 2 });
});

// ---- chainBreakPositions ----

test('chainBreakPositions: 最長の区間は 1/4・3/4 の 2 か所', () => {
  closeAll(chainBreakPositions(15000, 15000), [3750, 11250]);
});

test('chainBreakPositions: 最長の 1/2 以下は中央 1 か所（ちょうど 1/2 も 1 か所）', () => {
  closeAll(chainBreakPositions(4000, 10000), [2000], '0.4');
  closeAll(chainBreakPositions(5000, 10000), [2500], 'ちょうど 0.5');
});

test('chainBreakPositions: 1/2 を少しでも超えれば 2 か所（中間の長さ）', () => {
  closeAll(chainBreakPositions(5001, 10000), [5001 * 0.25, 5001 * 0.75]);
  closeAll(chainBreakPositions(13000, 15000), [3250, 9750]);
});

// ---- chainSolidRuns ----
const DIMS = { gapMm: 4, dotMm: 2 }; // 破線部の半幅 = 4 + 1 = 5（全長 10）

test('chainSolidRuns: 破線部 1 つ（長さ 100 の水平線・中心 50）は 実線[0,45]・点[49,51]・実線[55,100]', () => {
  const runs = chainSolidRuns({ x: 0, y: 0 }, { x: 100, y: 0 }, [50], DIMS);
  assert.equal(runs.length, 3);
  closeAll(runs[0].points, [0, 0, 45, 0]);
  closeAll(runs[1].points, [49, 0, 51, 0]);
  closeAll(runs[2].points, [55, 0, 100, 0]);
});

test('chainSolidRuns: 破線部 2 つ（中心 25・75）は 5 本の実線。向き（斜め・始点が原点でない）も区間に沿う', () => {
  const runs = chainSolidRuns({ x: 10, y: 20 }, { x: 10, y: 120 }, [25, 75], DIMS);
  assert.equal(runs.length, 5);
  closeAll(runs[0].points, [10, 20, 10, 40]);
  closeAll(runs[1].points, [10, 44, 10, 46]);
  closeAll(runs[2].points, [10, 50, 10, 90]);
  closeAll(runs[3].points, [10, 94, 10, 96]);
  closeAll(runs[4].points, [10, 100, 10, 120]);
  // 3-4-5 の斜め（長さ 100: (60,80) へ）。中心 50 の点は (30,40) をはさむ
  const diag = chainSolidRuns({ x: 0, y: 0 }, { x: 60, y: 80 }, [50], DIMS);
  closeAll(diag[1].points, [49 * 0.6, 49 * 0.8, 51 * 0.6, 51 * 0.8]);
  closeAll(diag[2].points, [55 * 0.6, 55 * 0.8, 60, 80]);
});

test('chainSolidRuns: 破線部が区間の端にかかる（半幅が端に届く・越える）ときは置かず、その端は実線のまま', () => {
  // 中心 5: 破線部 [0,10] が始点に接する → 置かない。中心 50 は置く
  const touch = chainSolidRuns({ x: 0, y: 0 }, { x: 100, y: 0 }, [5, 50], DIMS);
  assert.equal(touch.length, 3);
  closeAll(touch[0].points, [0, 0, 45, 0]);
  // 中心 3: 越える。中心 98: 終点側を越える → どちらも置かず実線 1 本
  const over = chainSolidRuns({ x: 0, y: 0 }, { x: 100, y: 0 }, [3, 98], DIMS);
  assert.equal(over.length, 1);
  closeAll(over[0].points, [0, 0, 100, 0]);
});

test('chainSolidRuns: 区間が短すぎる（破線部の全長 10 以上）と実線 1 本', () => {
  const runs = chainSolidRuns({ x: 0, y: 0 }, { x: 10, y: 0 }, [5], DIMS);
  assert.equal(runs.length, 1);
  closeAll(runs[0].points, [0, 0, 10, 0]);
  const slightlyLonger = chainSolidRuns({ x: 0, y: 0 }, { x: 10.5, y: 0 }, [5.25], DIMS);
  assert.equal(slightlyLonger.length, 3, '全長 10 < 10.5 なら置ける（端の実線は 0.25 ずつ）');
  closeAll(slightlyLonger[0].points, [0, 0, 0.25, 0]);
});

test('chainSolidRuns: 重なる破線部は後の方を置かない（中心 50 と 56: 半幅 5 で重なる）', () => {
  const runs = chainSolidRuns({ x: 0, y: 0 }, { x: 100, y: 0 }, [56, 50], DIMS); // 入力順は問わず昇順に処理
  assert.equal(runs.length, 3, '50 だけ置く');
  closeAll(runs[1].points, [49, 0, 51, 0]);
  // ちょうど接する（中心 50 と 60）は重ならない → 2 つとも置く
  assert.equal(chainSolidRuns({ x: 0, y: 0 }, { x: 100, y: 0 }, [50, 60], DIMS).length, 5 - 1, '接する間は長さ 0 で出さない: 実線・点・点・実線 ＋ 間の実線なし');
});

test('【失敗系】chainSolidRuns: 長さ 0 の区間は []、破線部なしは全体 1 本', () => {
  assert.deepEqual(chainSolidRuns({ x: 5, y: 5 }, { x: 5, y: 5 }, [0], DIMS), []);
  const whole = chainSolidRuns({ x: 0, y: 0 }, { x: 100, y: 0 }, [], DIMS);
  assert.equal(whole.length, 1);
  closeAll(whole[0].points, [0, 0, 100, 0]);
});

// ---- composeBoundaryChains ----
// 長方形 13000×15000（原点）。scale=1 のとき gap=4・dot=2（SITE_BOUNDARY_DASH の間・点がそのまま mm）
const rectPieces = () => [
  P('n', 0, 0, 13000, 0), P('e', 13000, 0, 13000, 15000), P('s', 13000, 15000, 0, 15000), P('w', 0, 15000, 0, 0),
];

test('composeBoundaryChains: 長方形 13000×15000 は長辺 15000 に 2 か所（3750・11250）、短辺 13000 も 15000 の 1/2 より長いので 2 か所（3250・9750）', () => {
  const chains = composeBoundaryChains(rectPieces(), 1);
  assert.deepEqual(chains.map(c => c.key), ['n', 'e', 's', 'w'], 'pieces と同じ順');
  const dotsOf = c => c.runs.filter(r => Math.hypot(r.points[2] - r.points[0], r.points[3] - r.points[1]) < 2.5);
  const east = chains[1];
  assert.equal(east.runs.length, 5);
  // 東辺は (13000,0)→(13000,15000)。点の中心＝y 方向 3750・11250
  const eastDots = dotsOf(east);
  assert.equal(eastDots.length, 2);
  close((eastDots[0].points[1] + eastDots[0].points[3]) / 2, 3750);
  close((eastDots[1].points[1] + eastDots[1].points[3]) / 2, 11250);
  const north = chains[0];
  assert.equal(north.runs.length, 5);
  const northDots = dotsOf(north);
  close((northDots[0].points[0] + northDots[0].points[2]) / 2, 3250);
  close((northDots[1].points[0] + northDots[1].points[2]) / 2, 9750);
});

test('composeBoundaryChains: 角の座標は runs の端点（交点は実線部）', () => {
  const chains = composeBoundaryChains(rectPieces(), 1);
  for (const c of chains) {
    const piece = rectPieces().find(p => p.key === c.key);
    assert.deepEqual(c.runs[0].points.slice(0, 2), [piece.a.x, piece.a.y], `${c.key} 始点`);
    assert.deepEqual(c.runs.at(-1).points.slice(2), [piece.b.x, piece.b.y], `${c.key} 終点`);
  }
});

test('composeBoundaryChains: scale で間・点の長さが変わる（scale=0.5 なら gap=8・dot=4 mm）', () => {
  const chains = composeBoundaryChains([P('a', 0, 0, 1000, 0)], 0.5);
  // 唯一の区間＝最長なので 250・750 の 2 か所。破線部の半幅 = 8 + 2 = 10
  const runs = chains[0].runs;
  assert.equal(runs.length, 5);
  closeAll(runs[0].points, [0, 0, 240, 0]);
  closeAll(runs[1].points, [248, 0, 252, 0]);
  closeAll(runs[2].points, [260, 0, 740, 0]);
});

test('composeBoundaryChains: 最長の 1/2 以下の区間は中央 1 か所。owners は片から引き継ぐ（無ければ []）', () => {
  const chains = composeBoundaryChains([{ ...P('long', 0, 0, 1000, 0), owners: [{ lineId: 'x' }] }, P('short', 0, 0, 0, 400)], 1);
  assert.equal(chains[0].runs.length, 5);
  assert.equal(chains[1].runs.length, 3, '400 <= 500');
  assert.deepEqual(chains[0].owners, [{ lineId: 'x' }]);
  assert.deepEqual(chains[1].owners, []);
});

test('【失敗系】composeBoundaryChains: 片が無ければ []', () => {
  assert.deepEqual(composeBoundaryChains([], 1), []);
});

test('composeSiteBoundaryChains: 敷地全体の最長で判定する（長方形 2 個＋結合）。空の敷地は []', () => {
  const site = new Site();
  site.addRect(0, 0, 4000, 3000, 'r1');
  site.addRect(4000, 0, 3000, 3000, 'r2');
  const chains = composeSiteBoundaryChains(site, 1);
  // 北辺・南辺は結合して 7000（最長）。東西 3000 は 7000 の 1/2 以下 → 中央 1 か所＝3 本
  const lens = chains.map(c => c.runs.length).sort();
  assert.deepEqual(lens, [3, 3, 5, 5]);
  assert.ok(chains.every(c => c.owners.length >= 1 && c.owners.every(o => o.rectId !== undefined)), '長方形の owners は {rectId, side}');
  assert.deepEqual(composeSiteBoundaryChains(new Site(), 1), []);
});

// 長方形 (0,0)-(4000,3000) ＋ 三斜 (4000,0)-(9000,0)-(4000,3000)。L1＝(4000,0)→(9000,0) が長方形の北辺と一直線で結合する
function makeMixedSite() {
  const site = new Site();
  site.addRect(0, 0, 4000, 3000, 'r1');
  const A = site.addPoint(4000, 0), B = site.addPoint(9000, 0), C = site.addPoint(4000, 3000);
  const l1 = site.addLine(A, B);
  site.addLine(B, C);
  site.addLine(C, A);
  site.addTriangle(l1, C);
  return site;
}

test('composeSiteBoundaryChains: 三斜＋長方形の混在で結合した区間の owners が両方を含み、最長は敷地全体で判定', () => {
  const chains = composeSiteBoundaryChains(makeMixedSite(), 1);
  const mixed = chains.filter(c => c.owners.some(o => o.lineId !== undefined) && c.owners.some(o => o.rectId !== undefined));
  assert.equal(mixed.length, 1, '北辺（長方形 4000）＋L1（5000）＝9000 の 1 本だけが混在');
  assert.equal(mixed[0].runs.length, 5, '最長 9000 → 破線部 2 か所＝実線 5 本');
  // 向きは結合の順で決まる（0→9000 でも 9000→0 でも）。両端は 0 と 9000
  const ends = [mixed[0].runs[0].points[0], mixed[0].runs.at(-1).points[2]].sort((p, q) => p - q);
  close(ends[0], 0);
  close(ends[1], 9000);
  const west = chains.find(c => c.owners.length === 1 && c.owners[0].side === 'w');
  assert.equal(west.runs.length, 3, '3000 <= 9000 × 0.5 → 中央 1 か所');
});

test('分担の補完関係: 混在・三斜だけ・長方形だけの各区間が isLinesLayerChain／isRectsLayerChain のちょうど一方だけを通る', () => {
  const chains = composeSiteBoundaryChains(makeMixedSite(), 1);
  const kinds = new Set();
  for (const c of chains) {
    assert.notEqual(isLinesLayerChain(c), isRectsLayerChain(c), `${c.key} はちょうど一方`);
    const hasLine = c.owners.some(o => o.lineId !== undefined), hasRect = c.owners.some(o => o.rectId !== undefined);
    kinds.add(hasLine && hasRect ? 'mixed' : hasLine ? 'line' : 'rect');
    assert.equal(isLinesLayerChain(c), hasLine, '三斜を含む（混在を含む）区間は線レイヤー');
  }
  assert.deepEqual([...kinds].sort(), ['line', 'mixed', 'rect']);
  assert.equal(isRectsLayerChain({ owners: [] }), true, 'owners 空は長方形側（どちらにも描かれない区間を作らない）');
  assert.equal(isRectsLayerChain({}), true);
});
