import test from 'node:test';
import assert from 'node:assert/strict';
import { q, unq, rectFromMm, unionBoundary, clipEdgeToInterior, mergeCollinear } from './orthoRegion.js';

// 辺を読みやすい形（mm）へ。
const dump = (edges) => edges
  .map(e => `${e.vertical ? 'V' : 'H'}@${unq(e.at)} ${unq(e.lo)}..${unq(e.hi)} ${e.side} ${e.id}`)
  .sort();

test('rectFromMm: lo/hi の向きに依存せず、潰れた矩形は null', () => {
  const a = rectFromMm(100, 0, 50, 10, 'a');
  assert.deepEqual([a.xLo, a.xHi, a.yLo, a.yHi], [q(0), q(100), q(10), q(50)]);
  assert.equal(rectFromMm(0, 0, 0, 10, 'z'), null);
});

test('unionBoundary: 単独の矩形は4辺そのまま', () => {
  const edges = unionBoundary([rectFromMm(0, 100, 0, 50, 'a')]);
  assert.deepEqual(dump(edges), [
    'H@0 0..100 yLo a',
    'H@50 0..100 yHi a',
    'V@0 0..50 xLo a',
    'V@100 0..50 xHi a',
  ]);
});

test('unionBoundary: 面で接する2矩形は接合面の辺が消え、共線の辺は1本へ畳まれる', () => {
  // 同じ厚みで一直線に並ぶ2本（T字ではなく通し壁が分割されただけの形）
  const edges = unionBoundary([
    rectFromMm(0, 100, 0, 50, 'a'),
    rectFromMm(100, 200, 0, 50, 'b'),
  ]);
  assert.deepEqual(dump(edges), [
    'H@0 0..200 yLo a',   // 長辺は1本（分割された線分が残らない）
    'H@50 0..200 yHi a',
    'V@0 0..50 xLo a',
    'V@200 0..50 xHi b',
  ]);
});

test('unionBoundary: L字（出隅）は角で折れ、内側の面は現れない', () => {
  const edges = unionBoundary([
    rectFromMm(0, 100, 0, 20, 'h'),   // 横材
    rectFromMm(0, 20, 0, 80, 'v'),    // 縦材（左端で重なる）
  ]);
  assert.deepEqual(dump(edges), [
    'H@0 0..100 yLo h',
    'H@20 20..100 yHi h',  // 縦材に呑まれた区間は出ない
    'H@80 0..20 yHi v',
    'V@0 0..80 xLo v',     // 2つの矩形の左辺が1本へ畳まれる
    'V@100 0..20 xHi h',
    'V@20 20..80 xHi v',
  ]);
});

test('unionBoundary: T字は通し壁の面が突き当たり側の幅だけ切れる', () => {
  const edges = unionBoundary([
    rectFromMm(0, 200, 0, 20, 'thru'),      // 通し壁（横）
    rectFromMm(80, 120, 20, 100, 'butt'),   // 突き当たる壁（縦。通し壁の上面に接する）
  ]);
  const hi = dump(edges).filter(s => s.startsWith('H@20'));
  assert.deepEqual(hi, ['H@20 0..80 yHi thru', 'H@20 120..200 yHi thru']);
});

test('unionBoundary: 完全に重なる矩形は辺が二重に出ない', () => {
  const edges = unionBoundary([
    rectFromMm(0, 100, 0, 50, 'a'),
    rectFromMm(0, 100, 0, 50, 'b'),
  ]);
  assert.equal(edges.length, 4);
});

test('unionBoundary: 内包される矩形は1辺も出さない', () => {
  const edges = unionBoundary([
    rectFromMm(0, 100, 0, 50, 'big'),
    rectFromMm(20, 40, 10, 30, 'small'),
  ]);
  assert.equal(edges.every(e => e.id === 'big'), true);
  assert.equal(edges.length, 4);
});

test('clipEdgeToInterior: 材の内部にある部分だけが内側線として残る', () => {
  const material = [rectFromMm(0, 200, 0, 100, 'm')];
  const edge = { vertical: false, at: q(30), lo: q(-50), hi: q(250), side: 'yHi', id: 'b' };
  const got = clipEdgeToInterior(edge, material).map(([a, b]) => [unq(a), unq(b)]);
  assert.deepEqual(got, [[0, 200]]);
});

test('clipEdgeToInterior: 材の面にちょうど乗る辺は内部ではない（残らない）', () => {
  const material = [rectFromMm(0, 200, 0, 100, 'm')];
  const edge = { vertical: false, at: q(100), lo: q(0), hi: q(200), side: 'yHi', id: 'b' };
  assert.deepEqual(clipEdgeToInterior(edge, material), []);
});

test('clipEdgeToInterior: 厚み方向に2枚へ分かれた材の境目に乗る辺も内部として残る', () => {
  // 背中合わせのオーナー壁＋仕上げ薄壁のように、材が y=50 で継がれている帯
  const material = [rectFromMm(0, 200, 0, 50, 'lo'), rectFromMm(0, 200, 50, 100, 'hi')];
  const edge = { vertical: false, at: q(50), lo: q(0), hi: q(200), side: 'yHi', id: 'b' };
  const got = clipEdgeToInterior(edge, material).map(([a, b]) => [unq(a), unq(b)]);
  assert.deepEqual(got, [[0, 200]]);
});

test('mergeCollinear: 接する断片は1本へ畳み、出所を ids に集める', () => {
  const merged = mergeCollinear([
    { vertical: false, at: 0, lo: 0, hi: 10, side: 'yLo', id: 'a' },
    { vertical: false, at: 0, lo: 10, hi: 100, side: 'yLo', id: 'b' },
    { vertical: false, at: 0, lo: 200, hi: 210, side: 'yLo', id: 'c' },
  ]);
  assert.equal(merged.length, 2);
  assert.deepEqual([merged[0].lo, merged[0].hi], [0, 100]);
  assert.equal(merged[0].id, 'b'); // 最も長く寄与した辺が代表元
  assert.deepEqual(merged[0].ids, ['a', 'b']);
});

test('mergeCollinear: side が違う辺（向かい合う面）は畳まない', () => {
  const merged = mergeCollinear([
    { vertical: true, at: 0, lo: 0, hi: 10, side: 'xLo', id: 'a' },
    { vertical: true, at: 0, lo: 10, hi: 20, side: 'xHi', id: 'b' },
  ]);
  assert.equal(merged.length, 2);
});
