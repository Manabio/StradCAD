// planSectionUp.js（見上げの断面解決＝鏡像ラッパー）の単体テスト。立体のリテラルで組み、具体の期待値で書く。
// 前提の寸法: 自階 FL=0・階高 H=2800・切断高 c=1500・自階の天井高 2400。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planSectionFigureUp } from './planSectionUp.js';
import { solid, rect, linesOf, mergedLines, sortedLines } from './planTestFixtures.js';
import { ceilingShapeSolidZ } from '../ceiling/ceilingShape.js';

const C = 1500;
const H = 2800;
const BOX = rect(0, 0, 4000, 4000);
const ceilingAt = (z, fp = { rects: [BOX] }, id = 'ceil') => solid('ceiling', fp, z, z, { id, layerFloorZ: 0 });
const upperFloor = (fp = { rects: [BOX] }) => solid('floor', fp, H, H, { id: 'floor-up', layerFloorZ: H });
/** 上階の梁（成 200・天端 H）: 下端 H-200=2600 */
const upperBeam = () => solid('beam', { rects: [rect(500, 1000, 3500, 1100)] }, H - 200, H, { id: 'beam-up', layerFloorZ: H });
const outline = (x1, y1, x2, y2) => [[x1, y1, x2, y1], [x1, y2, x2, y2], [x1, y1, x1, y2], [x2, y1, x2, y2]]
  .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3]);

test('天井が上階の梁を隠し、天井を外すと梁が細線（below・thin）で出る。梁の外形 4 辺', () => {
  const withCeiling = planSectionFigureUp([ceilingAt(2400), upperFloor(), upperBeam()], C);
  assert.equal(linesOf(withCeiling, null, 'beam').length, 0, '天井（下端 2400 ≦ 梁の下端 2600）が梁を隠す');
  const without = planSectionFigureUp([upperFloor(), upperBeam()], C);
  const beam = linesOf(without, null, 'beam');
  assert.deepEqual(sortedLines(beam), outline(500, 1000, 3500, 1100));
  assert.ok(beam.every(p => p.cls === 'below' && p.weight === 'thin'));
});

test('天井は面材: 梁の下端が天井高ちょうど（2400）でも同点で天井が勝って梁を隠す。天井の下がわずかでも低い梁（2399）は出る', () => {
  const beam = z0 => solid('beam', { rects: [rect(500, 1000, 3500, 1100)] }, z0, 2800, { id: 'tie', layerFloorZ: H });
  assert.equal(linesOf(planSectionFigureUp([ceilingAt(2400), upperFloor(), beam(2400)], C), null, 'beam').length, 0, '同点＝天井が勝つ');
  assert.equal(linesOf(planSectionFigureUp([ceilingAt(2400), upperFloor(), beam(2399)], C), null, 'beam').length, 4, '1mm 低ければ手前に出る');
});

test('下がり梁（下端 2600 ＜ 天井高 2800）は天井より手前に出る。下端が切断高より下の梁は切断（太線）', () => {
  const hung = solid('beam', { rects: [rect(500, 1000, 3500, 1100)] }, 2300, 2800, { id: 'hung', layerFloorZ: H }); // 下端 2300 ＜ 天井 2400
  const prims = planSectionFigureUp([ceilingAt(2400), upperFloor(), hung], C);
  assert.deepEqual(sortedLines(linesOf(prims, 'below', 'beam')), outline(500, 1000, 3500, 1100), '天井より低い下がり梁は細線');
  const deep = solid('beam', { rects: [rect(500, 1000, 3500, 1100)] }, 1400, 2800, { id: 'deep', layerFloorZ: H }); // 下端 1400 ＜ c
  const cut = planSectionFigureUp([ceilingAt(2400), upperFloor(), deep], C);
  const lines = linesOf(cut, 'cut', 'beam');
  assert.deepEqual(sortedLines(lines), outline(500, 1000, 3500, 1100));
  assert.ok(lines.every(p => p.weight === 'thick'));
});

test('壁 [0,2400]・c=1500 は切断（太線）。垂れ壁（下端 1800）は見えがかり（細線）、腰壁 [0,900] は出ない', () => {
  const wall = (id, z0, z1, x) => solid('wall', { rects: [rect(x, 0, x + 100, 1000)] }, z0, z1, { id });
  const prims = planSectionFigureUp([wall('full', 0, 2400, 0), wall('hung', 1800, 2400, 1000), wall('knee', 0, 900, 2000)], C);
  const of = id => prims.filter(p => p.source.id === id);
  assert.deepEqual(sortedLines(of('full')), outline(0, 0, 100, 1000));
  assert.ok(of('full').every(p => p.cls === 'cut' && p.weight === 'thick'));
  assert.deepEqual(sortedLines(of('hung')), outline(1000, 0, 1100, 1000));
  assert.ok(of('hung').every(p => p.cls === 'below' && p.weight === 'thin'));
  assert.equal(of('knee').length, 0, '腰壁（天端 900 ＜ c）は見上げでは非表示');
});

test('上階の壁は、上階スラブの穴の中の区間だけが出る（穴の外は上階の床と天井が隠す）', () => {
  const hole = rect(1000, 1000, 3000, 3000);
  // 天井は穴の部分を除く（吹抜けは天井を持たない）
  const ceilingRects = [rect(0, 0, 4000, 1000), rect(0, 1000, 1000, 3000), rect(3000, 1000, 4000, 3000), rect(0, 3000, 4000, 4000)];
  const wall = solid('wall', { rects: [rect(500, 1500, 3500, 1600)] }, H, H + 2400, { id: 'wall-up', layerFloorZ: H });
  const prims = planSectionFigureUp([ceilingAt(2400, { rects: ceilingRects }), upperFloor({ rects: [BOX], holes: [hole] }), wall], C);
  assert.deepEqual(mergedLines(linesOf(prims, null, 'wall')), [[1000, 1500, 3000, 1500], [1000, 1600, 3000, 1600]]);
  assert.ok(linesOf(prims, null, 'wall').every(p => p.cls === 'below' && p.source.layerFloorZ === H));
  assert.ok(linesOf(prims, null, 'floor').length > 0, '穴の縁（上階スラブの外形）が線で出る');
});

test('天井の共有辺: 同じ立体の矩形群（1件）の共有辺は出ない。別々の立体（部屋ごと）は同じ高さでも境目の線が出る（設計前提が崩れた箇所）。高さが違っても出る', () => {
  const left = { rects: [rect(0, 0, 2000, 4000)] }, right = { rects: [rect(2000, 0, 4000, 4000)] };
  const seamOf = prims => linesOf(prims, null, 'ceiling').filter(p => p.points[0] === 2000 && p.points[2] === 2000);
  // 1件の立体（矩形 2 つ）: 外周だけ
  const one = planSectionFigureUp([ceilingAt(2400, { rects: [left.rects[0], right.rects[0]] })], C);
  assert.deepEqual(mergedLines(linesOf(one, null, 'ceiling')), outline(0, 0, 4000, 4000));
  assert.equal(seamOf(one).length, 0);
  // 別々の立体: 解決器は「相手の厳密な内側」だけを隠すので、自分の辺が相手の境界の上にあるだけの共有辺は消えない
  // （設計 B の「同点規則で消える」は成り立たない。報告事項）。現状の挙動を固定する
  const same = planSectionFigureUp([ceilingAt(2400, left, 'a'), ceilingAt(2400, right, 'b')], C);
  assert.deepEqual(mergedLines(linesOf(same, null, 'ceiling')), [...outline(0, 0, 4000, 4000), [2000, 0, 2000, 4000]].sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3]));
  assert.ok(seamOf(same).length > 0);
  const stepped = planSectionFigureUp([ceilingAt(2400, left, 'a'), ceilingAt(2600, right, 'b')], C);
  assert.ok(seamOf(stepped).length > 0, `見切り線（x=2000）が出る: ${JSON.stringify(sortedLines(linesOf(stepped, null, 'ceiling')))}`);
});

test('天井高 ≦ 切断高の天井は出ない（1200）。切断高ちょうど（1500）は見えがかりとして出る（腰壁の天端が切断高ちょうどと同じ規則）', () => {
  assert.equal(planSectionFigureUp([ceilingAt(1200)], C).length, 0);
  assert.deepEqual(sortedLines(planSectionFigureUp([ceilingAt(1500)], C)), outline(0, 0, 4000, 4000));
  assert.deepEqual(sortedLines(planSectionFigureUp([ceilingAt(2400)], C)), outline(0, 0, 4000, 4000));
});

test('出力の source.layerFloorZ は入力の立体の値に戻り、viewLayerFloorZ は残らない。省略は省略のまま', () => {
  const noLayer = solid('generic', { rects: [rect(0, 0, 100, 100)] }, 2000, 2200, { id: 'g' });
  const prims = planSectionFigureUp([ceilingAt(2400), upperFloor(), upperBeam(), noLayer], C);
  assert.ok(prims.length > 0);
  for (const p of prims) assert.ok(!('viewLayerFloorZ' in p.source), `viewLayerFloorZ が残っている: ${p.key}`);
  assert.ok(linesOf(prims, null, 'floor').every(p => p.source.layerFloorZ === H));
  assert.ok(linesOf(prims, null, 'ceiling').every(p => p.source.layerFloorZ === 0), '自階の天井は layerFloorZ 0');
  const g = linesOf(prims, null, 'generic');
  assert.ok(g.length > 0 && g.every(p => !('layerFloorZ' in p.source)), '省略は省略のまま');
  assert.ok(!linesOf(planSectionFigureUp([upperFloor(), upperBeam()], C), null, 'beam').some(p => p.source.layerFloorZ !== H));
});

test('入力の配列・立体オブジェクトを変異させない', () => {
  const mk = () => [ceilingAt(2400), upperFloor(), upperBeam(), solid('wall', { rects: [rect(0, 0, 100, 1000)] }, 0, 2400, { id: 'w' })];
  const input = mk();
  const before = mk();
  planSectionFigureUp(input, C);
  assert.deepEqual(input, before);
  assert.equal(input.length, 4);
});

test('勾配のある立体（zAt）も鏡像で扱う: 切断面より上の部分の輪郭だけが細線で出る。元の zAt は変わらない', () => {
  const zAt = x => x / 2; // x=0..4000 で 0..2000
  const roof = solid('roof', { rects: [rect(0, 0, 4000, 1000)] }, 0, 2000, { id: 'r', zAt });
  const prims = planSectionFigureUp([roof], C);
  const lines = linesOf(prims, null, 'roof');
  assert.ok(lines.length > 0 && lines.every(p => p.cls === 'below'));
  assert.ok(lines.every(p => Math.min(p.points[0], p.points[2]) >= 3000 - 1), `zAt が切断高より上（x>3000）の部分だけ: ${JSON.stringify(sortedLines(lines))}`);
  assert.equal(roof.zAt, zAt);
  assert.equal(zAt(2000), 1000);
});

test('円弧・ドームの天井（S6b）: 切断高が途中にあるとき、切断高より上に残る輪郭だけが出て等高線は出ない。全体が切断高より上なら外形 4 辺', () => {
  const rects = [rect(0, 0, 4000, 2000)];
  const up = (shape, dims, base) => {
    const { zLo, zHi, zAt } = ceilingShapeSolidZ({ shape, dims, baseZ: base, rects });
    return planSectionFigureUp([solid('ceiling', { rects }, zLo, zHi, { id: 'c', layerFloorZ: 0, zAt })], C);
  };
  // 円弧（軸0: y 方向が幅）。基準 1200 < 切断高 1500 < 頂点 2200: 縁（y=0・2000 の線）は 1200 で切断高の下 → 妻の両端 x=0・4000 の線の切断高より上の部分だけ
  const arc = linesOf(up('arc', [1000, 0], 1200), null, 'ceiling');
  assert.equal(arc.length, 2, JSON.stringify(sortedLines(arc)));
  assert.ok(arc.every(p => p.points[0] === p.points[2] && (p.points[0] === 0 || p.points[0] === 4000)), '内部の等高線は出ない');
  assert.ok(arc.every(p => p.cls === 'below' && p.weight === 'thin'));
  assert.ok(arc.every(p => Math.min(p.points[1], p.points[3]) > 0 && Math.max(p.points[1], p.points[3]) < 2000), '縁（切断高の下）は含まない');
  // ドーム: 周縁がすべて基準 1200（切断高の下）。中央の盛り上がりだけが切断高より上だが、輪郭は周縁なので何も出ない（等高線なし）
  assert.equal(up('dome', [1000], 1200).length, 0);
  // 全体が切断高より上（基準 1600）なら円弧・ドームとも外形 4 辺
  assert.deepEqual(sortedLines(up('arc', [1000, 0], 1600)), outline(0, 0, 4000, 2000));
  assert.deepEqual(sortedLines(up('dome', [800], 1600)), outline(0, 0, 4000, 2000));
});

test('【失敗系】切断高が有限でなければ TypeError。非有限の z・null の立体は捨てる（例外にしない）。配列でない入力は空', () => {
  for (const bad of [NaN, Infinity, undefined, null, '1500']) {
    assert.throws(() => planSectionFigureUp([ceilingAt(2400)], bad), TypeError, String(bad));
  }
  const good = ceilingAt(2400);
  const badZ = { ...ceilingAt(2400, { rects: [rect(0, 0, 10, 10)] }, 'bad'), zHi: NaN };
  const badLo = { ...ceilingAt(2400, { rects: [rect(0, 0, 10, 10)] }, 'bad2'), zLo: Infinity };
  const prims = planSectionFigureUp([badZ, null, undefined, badLo, good], C);
  assert.deepEqual(prims, planSectionFigureUp([good], C));
  assert.ok(prims.length > 0);
  assert.deepEqual(planSectionFigureUp(null, C), []);
  assert.deepEqual(planSectionFigureUp([], C), []);
});
