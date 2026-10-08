// structural/openingCrossDrawing.js（構造モードの床開口の×。角＝周囲の梁の内側の面）の単体テスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  openingCrossSegments, OPENING_CROSS_SEARCH_MM,
} from './openingCrossDrawing.js';

const HALF = 15;
const opts = { beamHalfWidthOf: () => HALF };

// 開口 x -3000..0 × y -3500..-2000 の4辺（outwardSign＝開口と反対向き）。
function rectEdges(x1 = -3000, x2 = 0, y1 = -3500, y2 = -2000) {
  return [
    { isVertical: true, coord: x1, lo: y1, hi: y2, outwardSign: -1, componentId: 'c0' },
    { isVertical: true, coord: x2, lo: y1, hi: y2, outwardSign: 1, componentId: 'c0' },
    { isVertical: false, coord: y1, lo: x1, hi: x2, outwardSign: -1, componentId: 'c0' },
    { isVertical: false, coord: y2, lo: x1, hi: x2, outwardSign: 1, componentId: 'c0' },
  ];
}
function beam(isVertical, axisValue, a, b, role = 'primary') {
  return { isVertical, axisValue, clStart: { effectiveValue: a }, clEnd: { effectiveValue: b }, role };
}
// 13.stq型: 縦辺は通り芯上の梁、横辺は外向き95の開口梁。
function fourBeams() {
  return [
    beam(true, -3000, -4000, 1000), beam(true, 0, -4000, 1000),
    beam(false, -3595, -3000, 0), beam(false, -1905, -3000, 0),
  ];
}

test('openingCrossSegments: 内側の面＝梁芯−outwardSign×半幅（辺上の梁・外向きに逃げた梁とも）。対角線2本', () => {
  const segs = openingCrossSegments([rectEdges()], fourBeams(), opts);
  assert.equal(segs.length, 2);
  assert.deepEqual(segs[0].inner, { x1: -3000 + HALF, y1: -3595 + HALF, x2: 0 - HALF, y2: -1905 - HALF });
  assert.deepEqual([segs[0].x1, segs[0].y1, segs[0].x2, segs[0].y2], [-2985, -3580, -15, -1920]);
  assert.deepEqual([segs[1].x1, segs[1].y1, segs[1].x2, segs[1].y2], [-2985, -1920, -15, -3580]);
  assert.equal(segs[0].componentId, 'c0');
});

test('openingCrossSegments: 梁の無い辺は辺のCL座標を角にする', () => {
  const beams = fourBeams().filter(b => !(b.isVertical && b.axisValue === 0));
  const [s] = openingCrossSegments([rectEdges()], beams, opts);
  assert.equal(s.inner.x2, 0);
  assert.equal(s.inner.x1, -2985);
});

test('openingCrossSegments: 梁が一本も無ければ辺のCL座標の矩形', () => {
  const [s] = openingCrossSegments([rectEdges()], [], opts);
  assert.deepEqual(s.inner, { x1: -3000, y1: -3500, x2: 0, y2: -2000 });
});

test('openingCrossSegments: 辺と平行でも区間が重ならない梁は無視（辺のCL座標へ）', () => {
  const beams = fourBeams().filter(b => !(b.isVertical && b.axisValue === 0));
  beams.push(beam(true, 0, 500, 3000)); // y -3500..-2000 と重ならない
  const [s] = openingCrossSegments([rectEdges()], beams, opts);
  assert.equal(s.inner.x2, 0);
});

test('openingCrossSegments: 区間の重なりが CL_OVERLAP_TOL_MM 以下の梁は無視（端で接するだけ）', () => {
  const beams = fourBeams().filter(b => !(b.isVertical && b.axisValue === 0));
  beams.push(beam(true, 0, -2000, 3000)); // 端点だけ接する（重なり0）
  const [s] = openingCrossSegments([rectEdges()], beams, opts);
  assert.equal(s.inner.x2, 0);
});

test('openingCrossSegments: 外向きに探索距離を超えて離れた梁は無視。ちょうど探索距離は採る', () => {
  const far = [beam(true, 0 + OPENING_CROSS_SEARCH_MM + 1, -4000, 1000)];
  assert.equal(openingCrossSegments([rectEdges()], far, opts)[0].inner.x2, 0);
  const edge = [beam(true, 0 + OPENING_CROSS_SEARCH_MM, -4000, 1000)];
  assert.equal(openingCrossSegments([rectEdges()], edge, opts)[0].inner.x2, OPENING_CROSS_SEARCH_MM - HALF);
});

test('openingCrossSegments: 柱外面合わせで通り芯より内側へ入った梁（13.stq型・内向き225）を採る', () => {
  const beams = [beam(false, -3500 + 225, -3000, 0)]; // h1（外向き=-y）の梁が225内側
  const [s] = openingCrossSegments([rectEdges()], beams, opts);
  assert.equal(s.inner.y1, -3500 + 225 + HALF);
});

test('openingCrossSegments: 内向きの探索幅は min(探索距離, 開口寸法/2)——対辺側の梁は採らない', () => {
  // 内向き探索距離（300）を超える梁
  const deep = [beam(true, 0 - OPENING_CROSS_SEARCH_MM - 1, -4000, 1000)];
  assert.equal(openingCrossSegments([rectEdges()], deep, opts)[0].inner.x2, 0);
  // 幅400の開口: 右辺(400)から内向き250は dim/2=200 を超えるので採らない（左辺側の梁として扱われる）
  const narrow = rectEdges(0, 400, 0, 400);
  const mid = [beam(true, 150, -1000, 1000)];
  assert.equal(openingCrossSegments([narrow], mid, opts)[0].inner.x2, 400);
  // 内向き150（<200）は採る
  const ok = [beam(true, 250, -1000, 1000)];
  assert.equal(openingCrossSegments([narrow], ok, opts)[0].inner.x2, 250 - HALF);
});

test('openingCrossSegments: 内向きの探索幅は辺に直交する成分寸法/2（辺の長さではない）', () => {
  // 開口 x0..2000 × y0..400。右辺(x=2000, 辺長400)から内向き250の縦梁 axis=1750。
  // 直交寸法=幅2000→内向き上限min(300,1000)=300で採る。辺長400を使う誤実装(上限200)なら採れず x2=2000。
  const wide = rectEdges(0, 2000, 0, 400);
  const [s] = openingCrossSegments([wide], [beam(true, 1750, -1000, 1000)], opts);
  assert.equal(s.inner.x2, 1750 - HALF);
  // 左辺(x=0)から内向き250（axis=250）→ x1
  const [l] = openingCrossSegments([wide], [beam(true, 250, -1000, 1000)], opts);
  assert.equal(l.inner.x1, 250 + HALF);
  // 縦長開口 x0..400 × y0..2000: 上辺(y=0)・下辺(y=2000)から内向き250の横梁
  const tall = rectEdges(0, 400, 0, 2000);
  const [t] = openingCrossSegments([tall], [beam(false, 250, -1000, 1000)], opts);
  assert.equal(t.inner.y1, 250 + HALF);
  const [b] = openingCrossSegments([tall], [beam(false, 1750, -1000, 1000)], opts);
  assert.equal(b.inner.y2, 1750 - HALF);
});

test('openingCrossSegments: 最寄りが同距離なら外向きを採る（入力順に依存しない）。近い方が常に勝つ', () => {
  for (const xs of [[20, 80], [80, 20]]) {
    const beams = xs.map(x => beam(true, x, -4000, 1000));
    assert.equal(openingCrossSegments([rectEdges()], beams, opts)[0].inner.x2, 20 - HALF, xs.join());
  }
  // 右辺(x=0, 外向き+)に対し外向き+50 と 内向き−50
  for (const xs of [[50, -50], [-50, 50]]) {
    const beams = xs.map(x => beam(true, x, -4000, 1000));
    assert.equal(openingCrossSegments([rectEdges()], beams, opts)[0].inner.x2, 50 - HALF, xs.join());
  }
});

test('openingCrossSegments: beamHalfWidthOf が null/undefined を返したら半幅0とみなす', () => {
  for (const v of [null, undefined]) {
    const [s] = openingCrossSegments([rectEdges()], fourBeams(), { beamHalfWidthOf: () => v });
    assert.deepEqual(s.inner, { x1: -3000, y1: -3595, x2: 0, y2: -1905 });
  }
});

test('openingCrossSegments: 踊り場受け梁 LG・隔て梁は縁梁に含める。小屋梁・基礎梁・土台は含めない', () => {
  const lg = [beam(true, 100, -4000, 1000, 'landing')];
  assert.equal(openingCrossSegments([rectEdges()], lg, opts)[0].inner.x2, 100 - HALF);
  for (const role of ['roofBeam', 'foundation', 'sill']) {
    const beams = [beam(true, 100, -4000, 1000, role)];
    assert.equal(openingCrossSegments([rectEdges()], beams, opts)[0].inner.x2, 0, role);
  }
  const part = [beam(true, 100, -4000, 1000, 'partitionBeam')];
  assert.equal(openingCrossSegments([rectEdges()], part, opts)[0].inner.x2, 100 - HALF);
});

test('openingCrossSegments: 半幅0（略図の単線）は梁芯まで', () => {
  const [s] = openingCrossSegments([rectEdges()], fourBeams(), { beamHalfWidthOf: () => 0 });
  assert.deepEqual(s.inner, { x1: -3000, y1: -3595, x2: 0, y2: -1905 });
});

test('openingCrossSegments: 範囲内に2本あれば辺に近い方（中間でない）を採る', () => {
  const beams = [beam(true, 80, -4000, 1000), beam(true, 20, -4000, 1000)];
  assert.equal(openingCrossSegments([rectEdges()], beams, opts)[0].inner.x2, 20 - HALF);
});

test('openingCrossSegments: 梁の半幅で内側矩形が潰れる成分は出さない', () => {
  const small = rectEdges(0, 20, 0, 20);
  const beams = [beam(true, 0, -100, 100), beam(true, 20, -100, 100)];
  assert.deepEqual(openingCrossSegments([small], beams, opts), []);
});

test('openingCrossSegments: 4辺そろわない成分は出さない', () => {
  assert.deepEqual(openingCrossSegments([rectEdges().slice(0, 3)], [], opts), []);
});

test('openingCrossSegments: 成分の並び順どおり（componentId 無しは添字）', () => {
  const strip = edges => edges.map(e => ({ ...e, componentId: undefined }));
  const a = strip(rectEdges());
  const b = strip(rectEdges(1000, 2000, 1000, 2000));
  const segs = openingCrossSegments([a, b], [], opts);
  assert.deepEqual(segs.map(s => s.componentId), ['0', '0', '1', '1']);
  assert.deepEqual(openingCrossSegments([a, b], [], opts), segs);
});
