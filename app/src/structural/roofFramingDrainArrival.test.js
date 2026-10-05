// 下屋の屋根面「水下だけが内側へ進む。壁・けらばは動かない」の到達時刻 T（roofFramingGeometry.js drainArrivalTime・leanToDrainFraming の
// valid/invalidAt）のテスト。期待値は手計算（y は下向き正）。
// 定義: T(p)＝点から水下までの垂線（屋根範囲の中だけを通る）の長さの最小。垂線の足が水下の上か、谷（水下と水下の入隅）の端の延長の上
// （延長量は垂線の長さ以内＝45°）にある水下だけが対象。T が屋根範囲の全域で有限かつ連続でない形は規則で作れない形（valid:false）。
// 独立の検証: 参照実装（roofDrainReference.js。格子の上を前線が進む）との突き合わせと、出力の不変条件（母屋の段＝T・面の向き・端・壁へ下らない）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  drainArrivalTime, leanToDrainFraming, leanToDrainRoute, purlinLayoutFromRidge, orthogonalBoundaryLoops,
} from './roofFramingGeometry.js';
import { drainReference, framingChecks, wallDescentViolations } from './roofDrainReference.js';
import { RoofShape } from '../core/constants.js';

const TOL = 0.5;
const rc = (x1, y1, x2, y2) => ({ x1, y1, x2, y2 });
const D = (isVertical, coord, lo, hi, outward) => ({ isVertical, coord, lo, hi, outward });
const arrival = (rects, drains) => drainArrivalTime({ rects, drains, tolMm: TOL });

// ---- 到達時刻 T ----

test('切妻（矩形）: T＝2本の水下への距離の小さい方・面の持ち主（drainAt）は棟（x=4550）の左右で切り替わる。屋根範囲の外は -Infinity', () => {
  const a = arrival([rc(0, 0, 9100, 3640)], [D(true, 0, 0, 3640, -1), D(true, 9100, 0, 3640, 1)]);
  assert.equal(a.valid, true);
  assert.deepEqual(a.invalidAt, []);
  assert.equal(a.T(1000, 500), 1000);
  assert.equal(a.T(8000, 500), 1100);
  assert.equal(a.T(4550, 100), 4550, '棟の上は半スパン');
  assert.deepEqual([a.drainAt(1000, 500), a.drainAt(8000, 500)], [0, 1]);
  assert.equal(a.T(-1, 0), -Infinity, '屋根範囲の外');
  assert.equal(a.T(9101, 0), -Infinity);
  assert.equal(a.drainAt(-1, 0), -1);
});

test('L字の寄棟（谷あり）: 水下の端が入隅（谷）なら前線が45°で端の外へ広がる＝入隅の外側で T＝入隅の角までの L∞ 距離。谷の端の水下 y=1820・x=1820 が互いの延長を持つ', () => {
  const rects = [rc(0, 0, 9100, 1820), rc(0, 1820, 1820, 5460)];
  const drains = [D(false, 0, 0, 9100, -1), D(true, 9100, 0, 1820, 1), D(false, 1820, 1820, 9100, 1), D(true, 1820, 1820, 5460, 1), D(false, 5460, 0, 1820, 1), D(true, 0, 0, 5460, -1)];
  const a = arrival(rects, drains);
  assert.equal(a.valid, true);
  assert.deepEqual(a.drains.map(d => `${d.isVertical ? 'x' : 'y'}=${d.coord}`), ['y=0', 'y=1820', 'x=0', 'x=1820', 'y=5460', 'x=9100'], '前提: drains はまとめ済みの並び（長さの大きい順）');
  assert.equal(a.T(1000, 1200), 820, '入隅 (1820,1820) の外側: 水下 x=1820 の延長（垂線 820・端からの延長 620 ≦ 820）。延長が無ければ左辺までの 1000');
  assert.equal(a.drainAt(1000, 1200), 3);
  assert.equal(a.T(900, 1700), 900, '水下 y=1820 の延長側（x 方向に 920 の延長 ＞ 垂線 120 は対象外）は左辺 x=0 までの 900');
  assert.equal(a.drainAt(900, 1700), 2);
  assert.equal(a.T(1700, 1700), 120, '入隅の近く: 入隅の角までの L∞ 距離');
  assert.equal(a.T(5000, 900), 900);
  assert.equal(a.T(1000, 3000), 820, '縦の腕の中: 左辺 x=0 まで 1000・右の水下 x=1820 まで 820');
  assert.equal(a.T(5000, 3000), -Infinity, '入隅の外側（屋根範囲の外）');
});

test('水下の端が壁の線に続く形（辺の途中で壁になる水下）: 壁の前の点は水下に届かない（T=Infinity）。壁でない側の点は垂線の長さ', () => {
  const a = arrival([rc(0, 0, 9100, 3640)], [D(false, 3640, 4550, 9100, 1)]);
  assert.equal(a.valid, false);
  assert.equal(a.T(1000, 1000), Infinity, '垂線の足が壁（水下でない辺）の上＝届かない');
  assert.equal(a.T(8000, 1000), 2640);
  assert.ok(a.invalidAt.some(x => x.kind === 'unreached'), '届かない点が invalidAt に出る');
  assert.ok(a.invalidAt.some(x => x.kind === 'cliff' && x.isVertical === true && x.coord === 4550), '水下の端 x=4550 の線上の崖');
});

// ---- 規則で作れない形（valid:false）。崖の線分が invalidAt に入る ----

test('作れない形: 入隅の一部だけが屋内で残りが屋外の L字の切妻（T1）。水下の端 (1820,-3640) の先は壁と一直線＝壁の前（x<1820）は下辺へ・隙間の下は近い水下へ流れ、x=1820 の線上に崖', () => {
  const a = arrival([rc(0, -3640, 9100, 0), rc(3640, -6370, 9100, -3640)],
    [D(false, 0, 3640, 9100, 1), D(true, 9100, -6370, 0, 1), D(true, 3640, -6370, -3640, -1), D(false, -3640, 1820, 3640, -1)]);
  assert.equal(a.valid, false);
  assert.deepEqual(a.invalidAt.filter(x => x.kind === 'cliff' && x.isVertical === true && x.coord === 1820), [{ kind: 'cliff', isVertical: true, coord: 1820, lo: -3640, hi: -1820 }], '設計 B (i)');
});

test('作れない形: 入隅の外側の突き出し（910）が腕の幅（1820）より短い L字の寄棟（T2）。左の面は y≧2730 の側だけ・上の腕は右の水下へ流れ、y=2730 の線上に崖', () => {
  const a = arrival([rc(0, 2730, 910, 4550), rc(910, 2730, 2730, 4550), rc(910, 0, 2730, 2730)],
    [D(false, 0, 910, 2730, -1), D(true, 2730, 0, 4550, 1), D(false, 4550, 0, 2730, 1), D(true, 0, 2730, 4550, -1), D(true, 910, 0, 2730, -1)]);
  assert.equal(a.valid, false);
  assert.ok(a.invalidAt.some(x => x.kind === 'cliff' && x.isVertical === false && x.coord === 2730), '設計 B (ii)');
});

test('作れない形: 穴に面する水下（穴の上辺が水下で、その両端が動かない穴の左右の辺との270°の角）・水下が段違い（段の角は水下と動かない辺の270°の角）', () => {
  const holeRects = [rc(0, 0, 7280, 1820), rc(0, 1820, 1820, 5460), rc(3640, 1820, 7280, 3640), rc(1820, 3640, 7280, 5460)];
  const hole = arrival(holeRects, [D(false, 5460, 1820, 7280, 1), D(false, 1820, 1820, 3640, 1)]);
  assert.equal(hole.valid, false);
  assert.ok(hole.invalidAt.some(x => x.kind === 'cliff' && x.isVertical === true && x.coord === 1820 && x.lo === 0 && x.hi === 1820), '穴の左の辺 x=1820 の線上 y 0..1820');
  assert.ok(hole.invalidAt.some(x => x.kind === 'cliff' && x.isVertical === true && x.coord === 3640 && x.lo === 0 && x.hi === 1820), '穴の右の辺 x=3640');
  const step = arrival([rc(0, 0, 4550, 1820), rc(4550, 910, 9100, 2730)], [D(false, 1820, 0, 4550, 1), D(false, 2730, 4550, 9100, 1)]);
  assert.equal(step.valid, false);
  assert.deepEqual(step.invalidAt, [{ kind: 'cliff', isVertical: true, coord: 4550, lo: 910, hi: 1820 }], '段の角 x=4550 の線上（段の高さの分だけ）');
});

test('作れない形: コの字を下から見て開いた側（隙間）の向こうの腕へは前線が屋根の中だけを通れない（左の面しか無い U字）。垂線が屋根範囲の中にあるかの判定が効く', () => {
  // 下向きに開いたコの字（上の棒＋左右の腕）で、水下は左辺 x=0 だけ。右の腕へは隙間（屋根範囲の外）を通らないと届かない
  const u = [rc(0, 0, 9100, 1820), rc(0, 1820, 1820, 5460), rc(7280, 1820, 9100, 5460)];
  const a = arrival(u, [D(true, 0, 0, 5460, -1)]);
  assert.equal(a.valid, false);
  assert.equal(a.T(8000, 3000), Infinity, '右の腕は水下 x=0 へ屋根の中だけを通っては届かない（隙間を通る垂線は数えない）');
  assert.equal(a.T(800, 3000), 800, '左の腕は届く');
});

test('作れる形: 水下が壁と一直線に続かない形（腕の先がけらば）は valid。腕の長さが違うコの字の短い腕は先端が切妻のまま終わる', () => {
  const short = [rc(0, 3640, 9100, 5460), rc(0, 0, 1820, 3640), rc(7280, 1820, 9100, 3640)];
  const drains = [D(true, 1820, 0, 3640, 1), D(false, 3640, 1820, 7280, -1), D(true, 7280, 1820, 3640, -1), D(true, 9100, 1820, 5460, 1), D(false, 5460, 0, 9100, 1), D(true, 0, 0, 5460, -1)];
  const a = arrival(short, drains);
  assert.equal(a.valid, true);
  assert.equal(a.T(910, 100), 910, '左の腕の中心線（けらば y=0 は動かない＝先端まで同じ T）');
  assert.equal(a.T(8190, 1900), 910, '右の短い腕の中心線');
});

test('前線が壁に当たる時刻で隅木が終わる: roof-test8・1 型（最小の3セルの L字。壁 y=-3640・x=7280）の切妻・片流れの隅木は (9100,0)→(5460,-3640)。水下と壁の座標差の全長（3640）が事象の候補', () => {
  const rects = [rc(3640, -3640, 7280, 0), rc(7280, -3640, 9100, 0), rc(7280, -9884, 9100, -3640)];
  const walls = [{ isVertical: false, coord: -3640, lo: 3640, hi: 7280, outward: -1 }, { isVertical: true, coord: 7280, lo: -9884, hi: -3640, outward: -1 }];
  let checked = 0;
  for (const shape of [RoofShape.GABLE, RoofShape.MONO]) {
    const route = leanToDrainRoute({ shape, rect: null, rects, zeroZones: walls, tolMm: TOL });
    assert.equal(route.kind, 'field', shape);
    assert.deepEqual(route.drains.map(d => `${d.isVertical ? 'x' : 'y'}=${d.coord}`).sort(), ['x=9100', 'y=0'], `${shape}: 水下は右辺・下辺（壁は水下でない）`);
    const { eaveGapMm } = purlinLayoutFromRidge({ halfSpanMm: route.purlinDepthMm, ...layout, pitchMm: 910 });
    const f = leanToDrainFraming({ rects, drains: route.drains, pitchMm: 910, firstLevelMm: eaveGapMm, tolMm: TOL });
    assert.deepEqual(f.diagonals, [{ kind: 'hip', x1: 9100, y1: 0, x2: 5460, y2: -3640 }], `${shape}: 隅木は壁 y=-3640 に当たって終わる`);
    checked++;
  }
  assert.equal(checked, 2);
});

// ---- 失敗系 ----

test('【失敗系】drainArrivalTime: 水下が空は valid:false・T=Infinity（屋根は有るが水下に届かない）。使える矩形が無いは valid:false・T=-Infinity。引数の不正は RangeError', () => {
  const rects = [rc(0, 0, 9100, 1820)];
  const none = arrival(rects, []);
  assert.deepEqual([none.valid, none.invalidAt, none.T(100, 100), none.drainAt(100, 100)], [false, [], Infinity, -1]);
  const empty = arrival([], [D(true, 0, 0, 100, -1)]);
  assert.deepEqual([empty.valid, empty.T(0, 0)], [false, -Infinity]);
  assert.equal(arrival([rc(0, 0, 0.2, 100)], [D(true, 0, 0, 100, -1)]).valid, false, '幅が許容差以下の矩形は無視');
  const ok = { rects, drains: [D(true, 0, 0, 1820, -1)], tolMm: TOL };
  for (const tolMm of [-1, NaN, undefined]) assert.throws(() => drainArrivalTime({ ...ok, tolMm }), RangeError, `tolMm=${tolMm}`);
  assert.throws(() => drainArrivalTime({ ...ok, cliffTolMm: -1 }), RangeError, 'cliffTolMm');
  assert.throws(() => drainArrivalTime({ ...ok, rects: null }), RangeError);
  assert.throws(() => drainArrivalTime({ ...ok, rects: [rc(0, 0, NaN, 10)] }), RangeError);
  assert.throws(() => drainArrivalTime({ ...ok, rects: [rc(10, 0, 0, 10)] }), RangeError);
  assert.throws(() => drainArrivalTime({ ...ok, drains: null }), RangeError);
  assert.throws(() => drainArrivalTime({ ...ok, drains: [D(true, 0, 100, 0, -1)] }), RangeError, 'lo>hi');
  assert.throws(() => drainArrivalTime({ ...ok, drains: [D(true, 0, 0, 100, 0)] }), RangeError, 'outward');
});

test('崖の許容差: 水下の段が cliffTolMm 以内なら連続とみなす（2×tolMm＝1mm の段は valid・既定）。許容差を 0 にすると 1mm の段は崖', () => {
  // 下辺 y=1820 の水下と、右の部分だけ 0.8mm 低い（y=1820.8）段違い
  const rects = [rc(0, 0, 4550, 1820), rc(4550, 0, 9100, 1820.8)];
  const drains = [D(false, 1820, 0, 4550, 1), D(false, 1820.8, 4550, 9100, 1)];
  assert.equal(drainArrivalTime({ rects, drains, tolMm: 0.5 }).valid, true, '既定 cliffTolMm＝1mm');
  assert.equal(drainArrivalTime({ rects, drains, tolMm: 0.5, cliffTolMm: 0.1 }).valid, false);
});

// ---- 独立の参照実装・不変条件との突き合わせ（寸法を振る） ----

const layout = { pitchMm: 910, startOffsetsMm: [455, 910], tolMm: TOL };
const DIMS = [910, 1820, 3003];

/** L字（横棒の下に縦の腕がぶら下がる）。壁: 'none'・'inner2'（両入隅の辺）・'inner1a'（横棒の下面だけ）。 */
function lForm(wA, wB, pA, pB, walls) {
  const LA = pA + wB;
  const rects = [rc(0, 0, LA, wA), rc(LA - wB, wA, LA, wA + pB)];
  const inner0 = { isVertical: false, coord: wA, lo: 0, hi: LA - wB, outward: 1 };
  const inner1 = { isVertical: true, coord: LA - wB, lo: wA, hi: wA + pB, outward: -1 };
  return { rects, zones: { none: [], inner2: [inner0, inner1], inner1a: [inner0] }[walls] };
}

test('参照実装との突き合わせ: L字（寸法 3^4）×切妻・寄棟×壁（なし・両入隅）で、製品の valid が参照実装の崖・届かない判定と一致し、作れる形は参照実装・不変条件の違反が0', () => {
  let formsChecked = 0;
  let validForms = 0;
  let invalidForms = 0;
  const counts = { levelPoints: 0, faceLines: 0, endpoints: 0, ridgeSides: 0, diagSides: 0, ownerBoundaries: 0, contourCrossings: 0 };
  let wallChains = 0;
  for (const shape of [RoofShape.GABLE, RoofShape.HIP]) {
    for (const walls of ['none', 'inner2', 'inner1a']) {
      for (const wA of DIMS) for (const wB of DIMS) for (const pA of DIMS) for (const pB of DIMS) {
        const { rects, zones } = lForm(wA, wB, pA, pB, walls);
        const route = leanToDrainRoute({ shape, rect: null, rects, zeroZones: zones, tolMm: TOL });
        formsChecked++;
        // 作れない形でも水下は同じ入力から求めて、参照実装の valid と突き合わせる（壁を除いた水下は route.drains が無いので、壁を除く前の外周から）
        const edges = orthogonalBoundaryLoops({ rects, tolMm: TOL }).flat().map(e => D(e.isVertical, e.coord, e.lo, e.hi, e.outward));
        if (route.kind === 'none') {
          assert.equal(route.reason, 'invalidField', `${shape} ${walls} ${[wA, wB, pA, pB]}: none の理由は作れない形`);
          invalidForms++;
          continue;
        }
        assert.equal(route.kind, 'field');
        validForms++;
        const a = arrival(rects, route.drains);
        const ref = drainReference({ rects, drains: a.drains, gMm: 45.5, tolMm: TOL });
        assert.equal(a.valid, true);
        assert.equal(ref.valid, true, `参照実装も作れる形 ${shape} ${walls} ${[wA, wB, pA, pB]}`);
        const { eaveGapMm } = purlinLayoutFromRidge({ halfSpanMm: route.purlinDepthMm, ...layout, pitchMm: 910 });
        const framing = leanToDrainFraming({ rects, drains: route.drains, pitchMm: 910, firstLevelMm: eaveGapMm, tolMm: TOL });
        const wallEdges = edges.flatMap(e => {
          const covered = route.drains.filter(d => d.isVertical === e.isVertical && d.outward === e.outward && d.coord === e.coord);
          let cur = e.lo;
          const out = [];
          for (const d of [...covered].sort((p, q) => p.lo - q.lo)) { if (d.lo > cur) out.push({ ...e, lo: cur, hi: d.lo }); cur = Math.max(cur, d.hi); }
          if (cur < e.hi) out.push({ ...e, lo: cur, hi: e.hi });
          return out;
        });
        const chk = framingChecks({ rects, framing, ref, walls: wallEdges, pitchMm: 910, firstLevelMm: eaveGapMm, tolMm: TOL });
        assert.deepEqual(chk.violations, [], `${shape} ${walls} ${[wA, wB, pA, pB]}`);
        for (const k of Object.keys(counts)) counts[k] += chk.counts[k];
        // (a) 壁へ下らない（製品の T の列）
        const inR = (x, y) => rects.some(r => r.x1 < x && x < r.x2 && r.y1 < y && y < r.y2);
        const wd = wallDescentViolations({ walls: zones, tAt: (x, y) => (inR(x, y) ? a.T(x, y) : NaN), stepMm: 150, depthsMm: [20, 100, 300, 600, 1000, 1500, 2200, 3000], tolMm: 1 });
        assert.deepEqual(wd.violations, [], `壁へ下らない ${shape} ${walls} ${[wA, wB, pA, pB]}`);
        wallChains += wd.chains;
      }
    }
  }
  // 検査が空振りしない（「すべての X」の X が空でない）
  assert.equal(formsChecked, 2 * 3 * 81);
  assert.ok(validForms > 150 && invalidForms > 100, `作れる形 ${validForms}・作れない形 ${invalidForms}`);
  for (const [k, v] of Object.entries(counts)) assert.ok(v > 100, `${k} の検査件数 ${v}`);
  assert.ok(wallChains > 1000, `壁の列の検査件数 ${wallChains}`);
});

test('参照実装との突き合わせ: 作れない形の判定が参照実装（崖＝隣り合うセルの T の跳び・届かないセル）と一致する（T1・T2・穴・段違い・辺の途中で壁・L字の1辺だけ壁）', () => {
  const forms = [
    { rects: [rc(0, -3640, 9100, 0), rc(3640, -6370, 9100, -3640)], drains: [D(false, 0, 3640, 9100, 1), D(true, 9100, -6370, 0, 1), D(true, 3640, -6370, -3640, -1), D(false, -3640, 1820, 3640, -1)], valid: false },
    { rects: [rc(0, 2730, 910, 4550), rc(910, 2730, 2730, 4550), rc(910, 0, 2730, 2730)], drains: [D(false, 0, 910, 2730, -1), D(true, 2730, 0, 4550, 1), D(false, 4550, 0, 2730, 1), D(true, 0, 2730, 4550, -1), D(true, 910, 0, 2730, -1)], valid: false },
    { rects: [rc(0, 0, 4550, 1820), rc(4550, 910, 9100, 2730)], drains: [D(false, 1820, 0, 4550, 1), D(false, 2730, 4550, 9100, 1)], valid: false },
    { rects: [rc(0, 0, 9100, 3640)], drains: [D(false, 3640, 4550, 9100, 1)], valid: false },
    { rects: [rc(0, 0, 9100, 1820), rc(0, 1820, 1820, 5460), rc(7280, 1820, 9100, 5460)], drains: [D(true, 0, 0, 5460, -1)], valid: false },
    { rects: [rc(0, 3640, 9100, 5460), rc(0, 0, 1820, 3640), rc(7280, 1820, 9100, 3640)], drains: [D(true, 1820, 0, 3640, 1), D(false, 3640, 1820, 7280, -1), D(true, 7280, 1820, 3640, -1), D(true, 9100, 1820, 5460, 1), D(false, 5460, 0, 9100, 1), D(true, 0, 0, 5460, -1)], valid: true },
    { rects: [rc(0, 0, 9100, 3640)], drains: [D(true, 0, 0, 3640, -1), D(true, 9100, 0, 3640, 1)], valid: true },
  ];
  forms.forEach((f, i) => {
    const a = arrival(f.rects, f.drains);
    assert.equal(a.valid, f.valid, `形 ${i}: 製品`);
    assert.equal(drainReference({ rects: f.rects, drains: a.drains, gMm: 20, tolMm: TOL }).valid, f.valid, `形 ${i}: 参照実装`);
  });
});
