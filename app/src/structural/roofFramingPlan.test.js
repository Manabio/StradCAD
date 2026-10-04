// 下屋の平面表示（ステップ1）の幾何: roofFramingGeometry.js の roofRidgeLines・roofOutlineExposedPaths と、
// extendDiagonalsToOutline の valleys 引数のテスト。期待値は手計算（y は下向き正。閉路は内側が進行方向の右＝画面で時計回り）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  roofRidgeLines, roofFramingLines, roofOutline, roofOutlineExposedPaths, extendDiagonalsToOutline,
  orthogonalHipDiagonals,
} from './roofFramingGeometry.js';
import { RoofShape } from '../core/constants.js';

const TOL = 0.5;
const rc = (x1, y1, x2, y2) => ({ x1, y1, x2, y2 });
const BOX = rc(0, 0, 4000, 3000);
const outArgs = (rects, extra = {}) => ({
  rects, shape: RoofShape.HIP, ridgeIsVertical: null, highSide: null, eaveOverhangMm: 455, gableOverhangMm: 455, tolMm: TOL, ...extra,
});
const exposed = (rects, extra) => roofOutlineExposedPaths(outArgs(rects, extra));
/** 屋内に接する区間（出幅 0 の区間。roofBoundaryInteriorContacts の1要素と同じ形）。 */
const Z = (isVertical, coord, lo, hi, outward) => ({ isVertical, coord, lo, hi, outward });

// ---- roofRidgeLines ----

test('roofRidgeLines: 切妻・寄棟（矩形）・寄棟（L字の rects）は roofFramingLines(...).ridges と一致する', () => {
  const layout = { purlinPitchMm: 910, purlinStartOffsetsMm: [455, 910], tolMm: TOL };
  const wide = rc(0, 0, 9000, 6000);
  assert.deepEqual(
    roofRidgeLines({ rect: wide, shape: RoofShape.GABLE, ridgeIsVertical: false, tolMm: TOL }),
    roofFramingLines({ rect: wide, shape: RoofShape.GABLE, ridgeIsVertical: false, ...layout }).ridges);
  assert.deepEqual(roofRidgeLines({ rect: wide, shape: RoofShape.GABLE, ridgeIsVertical: false, tolMm: TOL }), [{ isVertical: false, coord: 3000, lo: 0, hi: 9000 }]);
  assert.deepEqual(
    roofRidgeLines({ rect: wide, shape: RoofShape.HIP, ridgeIsVertical: null, tolMm: TOL }),
    roofFramingLines({ rect: wide, shape: RoofShape.HIP, ridgeIsVertical: null, ...layout }).ridges);
  assert.deepEqual(roofRidgeLines({ rect: wide, shape: RoofShape.HIP, tolMm: TOL }), [{ isVertical: false, coord: 3000, lo: 3000, hi: 6000 }]);
  const lShape = [rc(0, 0, 8000, 4000), rc(0, 4000, 4000, 8000)];
  const l = roofRidgeLines({ rect: null, rects: lShape, shape: RoofShape.HIP, tolMm: TOL });
  assert.deepEqual(l, roofFramingLines({ rect: null, rects: lShape, shape: RoofShape.HIP, ...layout }).ridges);
  assert.equal(l.length, 2, 'L字の寄棟は棟木2本（各翼）');
});

test('roofRidgeLines: 棟木は母屋のピッチ・割付の候補に依存しない（910 と 1820 で同じ）', () => {
  const wide = rc(0, 0, 9000, 6000);
  const lShape = [rc(0, 0, 8000, 4000), rc(0, 4000, 4000, 8000)];
  const at = (pitch, offsets, p) => roofFramingLines({ purlinPitchMm: pitch, purlinStartOffsetsMm: offsets, tolMm: TOL, ...p }).ridges;
  for (const p of [
    { rect: wide, shape: RoofShape.GABLE, ridgeIsVertical: false },
    { rect: wide, shape: RoofShape.HIP },
    { rect: null, rects: lShape, shape: RoofShape.HIP },
  ]) {
    assert.deepEqual(at(910, [455, 910], p), at(1820, [910, 1820], p), `${p.shape}: 前提＝ピッチを変えても棟木は同じ`);
    assert.deepEqual(roofRidgeLines({ ...p, tolMm: TOL }), at(1820, [910, 1820], p), `${p.shape}: 固定ピッチでも 1820 と同じ`);
  }
});

test('【失敗系】roofRidgeLines: 片流れ（highSide 無しでも例外にしない）・陸屋根・棟違い・未知の形状・rect=null の切妻は空。許容差不正・矩形の逆順は RangeError', () => {
  for (const shape of [RoofShape.MONO, RoofShape.FLAT, RoofShape.STAGGERED, 'no-such-shape']) {
    assert.deepEqual(roofRidgeLines({ rect: BOX, shape, ridgeIsVertical: false, tolMm: TOL }), [], shape);
  }
  assert.deepEqual(roofRidgeLines({ rect: null, rects: [BOX], shape: RoofShape.GABLE, tolMm: TOL }), [], 'L字の切妻は棟木を持たない（暫定）');
  assert.deepEqual(roofRidgeLines({ rect: null, rects: null, shape: RoofShape.HIP, tolMm: TOL }), []);
  assert.throws(() => roofRidgeLines({ rect: BOX, shape: RoofShape.GABLE, ridgeIsVertical: false, tolMm: -1 }), RangeError);
  assert.throws(() => roofRidgeLines({ rect: rc(5, 0, 0, 3000), shape: RoofShape.GABLE, ridgeIsVertical: false, tolMm: TOL }), RangeError);
});

// ---- roofOutlineExposedPaths ----

test('roofOutlineExposedPaths: 屋内に接しない矩形は closed の1本で、roofOutline の outline と同じ点列', () => {
  const paths = exposed([BOX]);
  assert.equal(paths.length, 1);
  assert.equal(paths[0].closed, true);
  assert.deepEqual(paths[0].points, [4455, -455, 4455, 3455, -455, 3455, -455, -455]);
  assert.deepEqual(paths[0].points, roofOutline(outArgs([BOX])).outline[0].points);
});

test('roofOutlineExposedPaths: 1辺（下）が屋内に接する矩形は、その辺を描かない開いた1本・4点（接する辺の両端は出幅 0 の位置で止まる）', () => {
  const paths = exposed([BOX], { zeroZones: [Z(false, 3000, 0, 4000, 1)] });
  assert.equal(paths.length, 1);
  assert.equal(paths[0].closed, false);
  assert.deepEqual(paths[0].points, [-455, 3000, -455, -455, 4455, -455, 4455, 3000]);
});

test('roofOutlineExposedPaths: 辺の一部だけ接するとき、接する部分とその端の段差の小辺は描かない。接しない側の線は残る', () => {
  const rect = rc(2000, 1500, 6000, 3000);
  const zero = [Z(false, 1500, 2000, 4000, -1)]; // 上の辺の左半分（2000..4000）が屋内に接する
  const args = { eaveOverhangMm: 600, gableOverhangMm: 600, zeroZones: zero };
  const paths = exposed([rect], args);
  assert.deepEqual(paths, [{ points: [4000, 900, 6600, 900, 6600, 3600, 1400, 3600, 1400, 1500], closed: false }]);
  // 比較: roofOutline は段差の小辺（4000,1500→4000,900）と接する部分（2000..4000 の y=1500）を含む閉路
  assert.deepEqual(roofOutline(outArgs([rect], args)).outline, [{ points: [4000, 1500, 4000, 900, 6600, 900, 6600, 3600, 1400, 3600, 1400, 1500] }]);
});

test('roofOutlineExposedPaths: 軒→けらばの段差の小辺（両側とも描く部分）は出る。閉路全体を描くので closed の1本', () => {
  const kindZones = [
    { isVertical: false, coord: 0, lo: 0, hi: 2000, outward: -1, kind: 'eave' },
    { isVertical: false, coord: 0, lo: 2000, hi: 4000, outward: -1, kind: 'gable' },
    { isVertical: true, coord: 4000, lo: 0, hi: 3000, outward: 1, kind: 'gable' },
    { isVertical: false, coord: 3000, lo: 0, hi: 4000, outward: 1, kind: 'eave' },
    { isVertical: true, coord: 0, lo: 0, hi: 3000, outward: -1, kind: 'gable' },
  ];
  const paths = exposed([BOX], { eaveOverhangMm: 600, gableOverhangMm: 300, kindZones });
  assert.equal(paths.length, 1);
  assert.equal(paths[0].closed, true);
  const pts = paths[0].points;
  assert.deepEqual(paths[0].points, roofOutline(outArgs([BOX], { eaveOverhangMm: 600, gableOverhangMm: 300, kindZones })).outline[0].points);
  const pairs = []; // 連続する点の組
  for (let i = 0; i < pts.length; i += 2) pairs.push(`${pts[i]},${pts[i + 1]}`);
  const at = pairs.indexOf('2000,-600');
  assert.ok(at >= 0 && pairs[(at + 1) % pairs.length] === '2000,-300', `段差の小辺 (2000,-600)→(2000,-300) が点列にある: ${pairs.join(' ')}`);
});

test('roofOutlineExposedPaths: 軒→けらばの段差のうち片側が屋内に接する（覆われる）ものは描かない', () => {
  const kindZones = [
    { isVertical: false, coord: 0, lo: 0, hi: 2000, outward: -1, kind: 'eave' },
    { isVertical: false, coord: 0, lo: 2000, hi: 4000, outward: -1, kind: 'gable' },
    { isVertical: true, coord: 4000, lo: 0, hi: 3000, outward: 1, kind: 'gable' },
    { isVertical: false, coord: 3000, lo: 0, hi: 4000, outward: 1, kind: 'eave' },
    { isVertical: true, coord: 0, lo: 0, hi: 3000, outward: -1, kind: 'gable' },
  ];
  // 上の辺の右半分（けらば 2000..4000）が屋内に接する → 軒（0..2000）との段差の小辺は描かない
  const paths = exposed([BOX], { eaveOverhangMm: 600, gableOverhangMm: 300, kindZones, zeroZones: [Z(false, 0, 2000, 4000, -1)] });
  assert.equal(paths.length, 1);
  assert.equal(paths[0].closed, false);
  assert.ok(!paths[0].points.join(',').includes('2000,-300'), `段差の小辺の点 (2000,-300) が無い: ${paths[0].points.join(',')}`);
});

test('roofOutlineExposedPaths: 出幅 0 の屋根でも、屋内に接しない辺は描く（closed）。屋内に接する辺だけが消える', () => {
  const noContact = exposed([BOX], { eaveOverhangMm: 0, gableOverhangMm: 0 });
  assert.deepEqual(noContact, [{ points: [4000, 0, 4000, 3000, 0, 3000, 0, 0], closed: true }]);
  const bottomCovered = exposed([BOX], { eaveOverhangMm: 0, gableOverhangMm: 0, zeroZones: [Z(false, 3000, 0, 4000, 1)] });
  assert.deepEqual(bottomCovered, [{ points: [0, 3000, 0, 0, 4000, 0, 4000, 3000], closed: false }], '下の辺だけ消える');
  // 同じ辺の一部だけ覆う（出幅 0 の辺で covered と未覆の部分は同じ出幅だが別の部分として扱う）: 未覆の 2000..4000 は残る
  const halfCovered = exposed([BOX], { eaveOverhangMm: 0, gableOverhangMm: 0, zeroZones: [Z(false, 3000, 0, 2000, 1)] });
  assert.deepEqual(halfCovered, [{ points: [0, 3000, 0, 0, 4000, 0, 4000, 3000, 2000, 3000], closed: false }]);
});

test('roofOutlineExposedPaths: ループ始点をまたぐ描く部分は1本につながる（全辺が覆われれば線なし）', () => {
  // 上の辺だけ覆う（閉路の先頭は左上の辺）→ 右・下・左が1本
  const topCovered = exposed([BOX], { zeroZones: [Z(false, 0, 0, 4000, -1)] });
  assert.equal(topCovered.length, 1);
  assert.deepEqual(topCovered[0].points, [4455, 0, 4455, 3455, -455, 3455, -455, 0]);
  // 全辺が覆われる
  const all = [Z(false, 0, 0, 4000, -1), Z(true, 4000, 0, 3000, 1), Z(false, 3000, 0, 4000, 1), Z(true, 0, 0, 3000, -1)];
  assert.deepEqual(exposed([BOX], { zeroZones: all }), []);
});

test('roofOutlineExposedPaths: 同じ入力の roofOutline の戻り値（edges・outline）は今までと同じで、covered を漏らさない', () => {
  const rect = rc(2000, 1500, 6000, 3000);
  const r = roofOutline(outArgs([rect], { eaveOverhangMm: 600, gableOverhangMm: 600, zeroZones: [Z(false, 1500, 2000, 4000, -1)] }));
  const E = (isVertical, coord, lo, hi, outward, overhangMm) => ({ isVertical, coord, lo, hi, outward, overhangMm });
  assert.deepEqual(r.edges, [
    E(false, 1500, 2000, 4000, -1, 0), E(false, 1500, 4000, 6000, -1, 600),
    E(true, 6000, 1500, 3000, 1, 600), E(false, 3000, 2000, 6000, 1, 600), E(true, 2000, 1500, 3000, -1, 600),
  ]);
  assert.deepEqual(r.outline, [{ points: [4000, 1500, 4000, 900, 6600, 900, 6600, 3600, 1400, 3600, 1400, 1500] }]);
  // 出幅 0 の辺に接する部分が接しない部分と同じ出幅でも、roofOutline は今までどおり1つの辺にまとめる（exposed のために分けない）
  const merged = roofOutline(outArgs([BOX], { eaveOverhangMm: 0, gableOverhangMm: 0, zeroZones: [Z(false, 3000, 0, 2000, 1)] }));
  assert.equal(merged.edges.length, 4, '出幅 0 なら covered の有無に関わらず4辺のまま');
});

test('【失敗系】roofOutlineExposedPaths: 出幅が負・非有限、kindZones が配列でない、屋根の形状が不正（kindZones 無しの陸屋根）は roofOutline と同じ RangeError', () => {
  assert.throws(() => exposed([BOX], { eaveOverhangMm: -1 }), RangeError);
  assert.throws(() => exposed([BOX], { gableOverhangMm: NaN }), RangeError);
  assert.throws(() => exposed([BOX], { kindZones: {} }), RangeError);
  assert.throws(() => exposed([BOX], { shape: RoofShape.FLAT }), RangeError, '陸屋根は kindZones 無しでは辺の種別を決められない');
  assert.deepEqual(exposed([], {}), [], '屋根範囲が空なら線なし');
});

// ---- extendDiagonalsToOutline の valleys ----

test('extendDiagonalsToOutline: 谷木は既定（valleys 無し）では延びない。valleys:true で外形線の入隅の角まで延びる。隅木は両方で同じ', () => {
  const rects = [rc(0, 0, 6000, 3000), rc(0, 3000, 3000, 6000)]; // L字。入隅は (3000,3000)
  const { edges } = roofOutline(outArgs(rects));
  const diagonals = orthogonalHipDiagonals({ rects, tolMm: TOL });
  const valley = diagonals.find(d => d.kind === 'valley');
  assert.deepEqual([valley.x1, valley.y1], [3000, 3000], '前提: 谷木の軒側の端は入隅');
  const dflt = extendDiagonalsToOutline({ diagonals, edges, tolMm: TOL });
  const withValleys = extendDiagonalsToOutline({ diagonals, edges, valleys: true, tolMm: TOL });
  assert.deepEqual(dflt.find(d => d.kind === 'valley'), valley, '既定は谷木を延ばさない');
  const v2 = withValleys.find(d => d.kind === 'valley');
  assert.deepEqual([v2.x1, v2.y1, v2.x2, v2.y2], [3455, 3455, valley.x2, valley.y2], '入隅の外形線の角 (3455,3455) まで。上端は不変');
  assert.deepEqual(withValleys.filter(d => d.kind === 'hip'), dflt.filter(d => d.kind === 'hip'), '隅木は valleys に関わらず同じ');
  assert.deepEqual(diagonals.find(d => d.kind === 'valley'), valley, '入力は変えない');
});

test('extendDiagonalsToOutline: valleys:true でも、入隅の2辺の出幅が違う（片方が屋内に接して 0）谷木は延ばさない', () => {
  const rects = [rc(0, 0, 6000, 3000), rc(0, 3000, 3000, 6000)];
  const { edges } = roofOutline(outArgs(rects, { zeroZones: [Z(true, 3000, 3000, 6000, 1)] })); // 入隅の縦の辺が屋内に接する
  const diagonals = orthogonalHipDiagonals({ rects, tolMm: TOL });
  const valley = diagonals.find(d => d.kind === 'valley');
  const out = extendDiagonalsToOutline({ diagonals, edges, valleys: true, tolMm: TOL });
  assert.deepEqual(out.find(d => d.kind === 'valley'), valley);
});
