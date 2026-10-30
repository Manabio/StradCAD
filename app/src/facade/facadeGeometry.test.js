// facade/facadeGeometry.js・facadeFigure.js の単体テスト（graph を経由しない inputs リテラル）。
// 期待値は fixture の寸法から手で書く（関数の出力を写さない）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FacadeDirection, FACADE_TITLE_BY_DIRECTION, FACADE_GL_LABEL } from '../core/constants.js';
import {
  facadeViews, projectToView, isFacingSegment, depthProfile, buildFacadeLines, facadeFloorProfiles, isHidden,
} from './facadeGeometry.js';
import { buildFacadeModel, facadeExtentsMm } from './facadeFigure.js';

const GL_BELOW = 500;            // GL＝1FL−500
const GL_Z = -GL_BELOW;
const FL2 = 3000;                // 2FL
const EAVE_1 = 2900;             // 平屋の軒桁上端
const EAVE_2 = FL2 + 2900;       // 2階建ての軒桁上端
const ANNOT = { glExtendMm: 100, glMarkMm: 30, titleGapMm: 60 };

// 直交多角形（頂点列）の外周を外壁の線分へ。外向きは辺の中点を ±1 ずらした点が多角形の外か内かで決める。
function insidePoly(pts, x, y) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function polySegments(pts, loopType = 'outer', { reverse = false } = {}) {
  const segs = [];
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
    const isVertical = x1 === x2;
    const value = isVertical ? x1 : y1;
    const lo = isVertical ? Math.min(y1, y2) : Math.min(x1, x2);
    const hi = isVertical ? Math.max(y1, y2) : Math.max(x1, x2);
    const mid = (lo + hi) / 2;
    const plusInside = isVertical ? insidePoly(pts, value + 1, mid) : insidePoly(pts, mid, value + 1);
    let outwardSign = plusInside ? -1 : 1;
    if (reverse) outwardSign = -outwardSign; // 中庭: 外向き＝中庭（多角形の内側）
    segs.push({ isVertical, value, lo, hi, outwardSign, axisCLId: `cl${i}`, loopType });
  }
  return segs;
}
const rectPts = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

function oneStory(pts, extra = []) {
  return { glZMm: GL_Z, floors: [{ planeId: 'p1', zLoMm: GL_Z, zHiMm: EAVE_1, segments: [...polySegments(pts), ...extra] }] };
}
function twoStory(pts1, pts2) {
  return {
    glZMm: GL_Z,
    floors: [
      { planeId: 'p1', zLoMm: GL_Z, zHiMm: FL2, segments: polySegments(pts1) },
      { planeId: 'p2', zLoMm: FL2, zHiMm: EAVE_2, segments: polySegments(pts2) },
    ],
  };
}

const faceOf = (model, dir) => model.find(f => f.direction === dir);
const linesOf = face => face.primitives.filter(p => p.type === 'line' && p.weight === 'medium');
const round = v => Math.round(v * 1000) / 1000;
// 図の座標の線を [x1,y1,x2,y2]（小さい方が先）に正規化して並べる。
function norm(lines) {
  return lines.map(l => {
    const a = [round(l.x1), round(l.y1)], b = [round(l.x2), round(l.y2)];
    return a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]) ? [...a, ...b] : [...b, ...a];
  }).sort((p, q) => p[0] - q[0] || p[1] - q[1] || p[2] - q[2] || p[3] - q[3]);
}
// 図の座標で y=Y の水平線の X 区間。
const hSpansAt = (face, Y) => norm(linesOf(face).filter(l => round(l.y1) === Y && round(l.y2) === Y)).map(l => [l[0], l[2]]);
const vLinesAt = (face, X) => norm(linesOf(face).filter(l => round(l.x1) === X && round(l.x2) === X)).map(l => [l[1], l[3]]);

// ---- 向きと投影 ----
test('facadeViews: 方位未指定は 東=(1,0)・南=(0,1)・西=(−1,0)・北=(0,−1)（東南西北の順）', () => {
  assert.deepEqual(facadeViews(), [
    { direction: FacadeDirection.EAST,  normal: { x: 1,  y: 0 } },
    { direction: FacadeDirection.SOUTH, normal: { x: 0,  y: 1 } },
    { direction: FacadeDirection.WEST,  normal: { x: -1, y: 0 } },
    { direction: FacadeDirection.NORTH, normal: { x: 0,  y: -1 } },
  ]);
  assert.deepEqual(facadeViews(null), facadeViews());
});

test('facadeViews: θ=90/180/270 で軸の割り当てが時計回りにずれる（−90 は 270 と同じ・45 未満は丸めで 0）', () => {
  const east = th => facadeViews(th).find(v => v.direction === FacadeDirection.EAST).normal;
  // 真北が画面右（θ=90）なら東は画面下。
  assert.deepEqual(east(90), { x: 0, y: 1 });
  assert.deepEqual(east(180), { x: -1, y: 0 });
  assert.deepEqual(east(270), { x: 0, y: -1 });
  assert.deepEqual(east(-90), { x: 0, y: -1 });
  assert.deepEqual(east(44), { x: 1, y: 0 });
  assert.deepEqual(facadeViews(90).find(v => v.direction === FacadeDirection.NORTH).normal, { x: 1, y: 0 });
});

test('projectToView: 東立面は南（y 大）が u 最小＝左、東（x 大）が手前', () => {
  const e = { x: 1, y: 0 };
  assert.ok(projectToView(e, 0, 6000).u < projectToView(e, 0, 0).u);
  assert.ok(projectToView(e, 8000, 0).depth < projectToView(e, 0, 0).depth);
  // 南立面は西（x 小）が左。
  const s = { x: 0, y: 1 };
  assert.ok(projectToView(s, 0, 0).u < projectToView(s, 8000, 0).u);
});

test('isFacingSegment: 縦線は外向き＝nx、横線は外向き＝ny のときだけ手前を向く', () => {
  const v = { isVertical: true, outwardSign: 1 };
  const h = { isVertical: false, outwardSign: -1 };
  assert.equal(isFacingSegment(v, { x: 1, y: 0 }), true);
  assert.equal(isFacingSegment(v, { x: -1, y: 0 }), false);
  assert.equal(isFacingSegment(v, { x: 0, y: 1 }), false);
  assert.equal(isFacingSegment(h, { x: 0, y: -1 }), true);
  assert.equal(isFacingSegment(h, { x: 0, y: 1 }), false);
});

test('各面の左右（図の座標）: 2階が南西の隅だけ → 東は左、南は左、西は右、北は右に2階が出る', () => {
  const inputs = twoStory(rectPts(0, 0, 8000, 6000), rectPts(0, 3000, 4000, 6000));
  const model = buildFacadeModel(inputs, { annotationMm: ANNOT });
  const topY = -(EAVE_2 - GL_Z);
  assert.deepEqual(hSpansAt(faceOf(model, FacadeDirection.EAST), topY), [[0, 3000]]);   // 左が南
  assert.deepEqual(hSpansAt(faceOf(model, FacadeDirection.SOUTH), topY), [[0, 4000]]);  // 左が西
  assert.deepEqual(hSpansAt(faceOf(model, FacadeDirection.WEST), topY), [[3000, 6000]]); // 右が南
  assert.deepEqual(hSpansAt(faceOf(model, FacadeDirection.NORTH), topY), [[4000, 8000]]); // 右が西
});

// ---- 1階建て矩形 ----
test('1階建て矩形: 4面とも矩形（左右の縦線＋軒の線）。幅＝外面の寸法、高さ＝GL〜軒桁上端。GL に建物の下端線は無い', () => {
  const model = buildFacadeModel(oneStory(rectPts(0, 0, 8000, 6000)), { annotationMm: ANNOT });
  assert.deepEqual(model.map(f => f.direction), [FacadeDirection.EAST, FacadeDirection.SOUTH, FacadeDirection.WEST, FacadeDirection.NORTH]);
  const H = EAVE_1 - GL_Z; // 3400
  const expectWidth = { east: 6000, south: 8000, west: 6000, north: 8000 };
  for (const face of model) {
    const W = expectWidth[face.direction];
    assert.equal(face.widthMm, W, face.direction);
    assert.equal(face.heightMm, H, face.direction);
    assert.deepEqual(norm(linesOf(face)), [[0, -H, 0, 0], [0, -H, W, -H], [W, -H, W, 0]], face.direction);
  }
});

test('1階建て矩形: ▽GL（GL の線は左右へ延長・▽は閉じた折れ線で先端が線上・「GL」）と見出しがあり、bounds は注記を含む', () => {
  const model = buildFacadeModel(oneStory(rectPts(0, 0, 8000, 6000)), { annotationMm: ANNOT, bgColor: '#fff' });
  const south = faceOf(model, FacadeDirection.SOUTH);
  const gl = south.primitives.filter(p => p.type === 'line' && p.weight === 'thick');
  assert.deepEqual(gl.map(l => [l.x1, l.y1, l.x2, l.y2]), [[-100, 0, 8100, 0]]);
  const mark = south.primitives.find(p => p.type === 'polyline');
  assert.equal(mark.closed, true);
  assert.equal(mark.fill, '#fff');
  assert.equal(mark.points.length, 3);
  const tip = mark.points.find(([, y]) => y === 0);
  assert.ok(tip && tip[0] < 0 && tip[0] > -100, `▽の先端は GL の左の延長の上（${JSON.stringify(mark.points)}）`);
  assert.ok(mark.points.filter(([, y]) => y === -30).length === 2, '底辺は▽の高さだけ上');
  const texts = south.primitives.filter(p => p.type === 'text').map(p => p.text);
  assert.deepEqual(texts.sort(), [FACADE_GL_LABEL, FACADE_TITLE_BY_DIRECTION.south].sort());
  const glText = south.primitives.find(p => p.type === 'text' && p.text === FACADE_GL_LABEL);
  assert.ok(glText.x < tip[0] && glText.y < 0, '「GL」は▽の左上');
  assert.deepEqual(south.bounds, { minX: -100, minY: -(EAVE_1 - GL_Z) - 60, maxX: 8100, maxY: 0 });
});

test('facadeExtentsMm: 4面の最大幅・最大高さ（注記を含まない）', () => {
  const ext = facadeExtentsMm(oneStory(rectPts(0, 0, 8000, 6000)));
  assert.equal(ext.maxWidthMm, 8000);
  assert.equal(ext.maxHeightMm, EAVE_1 - GL_Z);
  assert.deepEqual(ext.faces.map(f => [f.direction, f.widthMm]), [['east', 6000], ['south', 8000], ['west', 6000], ['north', 8000]]);
});

// ---- 2階建て L 字（後退） ----
test('2階建て（2階が南東を欠く L 字）: 後退がある区間だけ 2FL の線が出る。段差の縦線が出る。面一の外壁は1本の縦線', () => {
  // 1階 8000×6000。2階は (0..8000, 0..3000) ＋ (0..4000, 3000..6000) の L（南東の 4000×3000 が後退）。
  const pts2 = [[0, 0], [8000, 0], [8000, 3000], [4000, 3000], [4000, 6000], [0, 6000]];
  const model = buildFacadeModel(twoStory(rectPts(0, 0, 8000, 6000), pts2), { annotationMm: ANNOT });
  const y2 = -(FL2 - GL_Z), yTop = -(EAVE_2 - GL_Z);
  const south = faceOf(model, FacadeDirection.SOUTH);
  assert.deepEqual(hSpansAt(south, y2), [[4000, 8000]], '2FL の線は後退した東半分だけ');
  assert.deepEqual(vLinesAt(south, 4000), [[yTop, y2]], '段差の縦線は2階の範囲だけ');
  assert.deepEqual(vLinesAt(south, 0), [[yTop, 0]], '面一の西端は GL から軒まで1本');
  assert.deepEqual(vLinesAt(south, 8000), [[yTop, 0]], '東端は2階の北棟（奥）も同じ x で、GL から軒まで1本');
  assert.deepEqual(hSpansAt(south, yTop), [[0, 8000]], '軒の線は手前・奥の両方がつながって全幅');
  // 東立面（左が南）: 2階の南側 3000 が後退（奥の x=4000 の面）。
  const east = faceOf(model, FacadeDirection.EAST);
  assert.deepEqual(hSpansAt(east, y2), [[0, 3000]]);
  assert.deepEqual(vLinesAt(east, 3000), [[yTop, y2]]);
});

test('奥の面の線は出ない: 南に開く U 字の東立面は、奥の西棟の東面（x=2000）の端の縦線を出さない', () => {
  // A(0..2000, 0..6000) + C(2000..6000, 0..2000) + B(6000..8000, 0..6000)。東立面の u=−y、左端 X=0 が y=6000。
  const pts = [[0, 0], [8000, 0], [8000, 6000], [6000, 6000], [6000, 2000], [2000, 2000], [2000, 6000], [0, 6000]];
  const east = faceOf(buildFacadeModel(oneStory(pts), { annotationMm: ANNOT }), FacadeDirection.EAST);
  const H = EAVE_1 - GL_Z;
  assert.deepEqual(norm(linesOf(east)), [[0, -H, 0, 0], [0, -H, 6000, -H], [6000, -H, 6000, 0]]);
  // 南立面には U の切欠きの段差が出る（手前の東西棟と奥の C の境 X=2000, 6000）。
  const south = faceOf(buildFacadeModel(oneStory(pts), { annotationMm: ANNOT }), FacadeDirection.SOUTH);
  assert.deepEqual(vLinesAt(south, 2000), [[-H, 0]]);
  assert.deepEqual(vLinesAt(south, 6000), [[-H, 0]]);
});

// ---- 2階が出っ張る ----
test('2階が南へ 1000 出っ張る: 南立面は 2FL の線が全幅（2階の下端）、東立面は出っ張り区間だけ・面一の区間は線なし', () => {
  const model = buildFacadeModel(twoStory(rectPts(0, 0, 8000, 6000), rectPts(0, 0, 8000, 7000)), { annotationMm: ANNOT });
  const y2 = -(FL2 - GL_Z), yTop = -(EAVE_2 - GL_Z);
  const south = faceOf(model, FacadeDirection.SOUTH);
  assert.deepEqual(hSpansAt(south, y2), [[0, 8000]]);
  const east = faceOf(model, FacadeDirection.EAST);
  assert.equal(east.widthMm, 7000);
  assert.deepEqual(hSpansAt(east, y2), [[0, 1000]], '出っ張り（南の 1000）の下端だけ');
  assert.deepEqual(vLinesAt(east, 1000), [[y2, 0]], '1階の南端の縦線');
  assert.deepEqual(vLinesAt(east, 0), [[yTop, y2]], '2階の南端の縦線');
  assert.deepEqual(vLinesAt(east, 7000), [[yTop, 0]], '北端は面一で1本');
});

// ---- 中庭 ----
test('中庭（courtyard）の外壁は手前の外周に隠れて線が出ない', () => {
  const court = polySegments(rectPts(3000, 3000, 6000, 6000), 'courtyard', { reverse: true });
  const withCourt = buildFacadeModel(oneStory(rectPts(0, 0, 9000, 9000), court), { annotationMm: ANNOT });
  const plain = buildFacadeModel(oneStory(rectPts(0, 0, 9000, 9000)), { annotationMm: ANNOT });
  for (const dir of Object.values(FacadeDirection)) {
    assert.deepEqual(norm(linesOf(faceOf(withCourt, dir))), norm(linesOf(faceOf(plain, dir))), dir);
    assert.equal(norm(linesOf(faceOf(withCourt, dir))).length, 3, dir);
  }
});

test('縁の屋外部屋（courtyard だが外周に隠れない）の壁は見える', () => {
  // 屋内 0..4000 の東に屋外部屋（テラス）。屋内側の境界 x=4000 は courtyard・外向き +x。外周は x=4000 を含まない。
  const outer = polySegments(rectPts(0, 0, 4000, 3000)).filter(s => !(s.isVertical && s.value === 4000));
  const court = [{ isVertical: true, value: 4000, lo: 0, hi: 3000, outwardSign: 1, axisCLId: 'x1', loopType: 'courtyard' }];
  const inputs = { glZMm: GL_Z, floors: [{ planeId: 'p1', zLoMm: GL_Z, zHiMm: EAVE_1, segments: [...outer, ...court] }] };
  const east = faceOf(buildFacadeModel(inputs, { annotationMm: ANNOT }), FacadeDirection.EAST);
  assert.equal(east.widthMm, 3000);
  assert.equal(norm(linesOf(east)).length, 3);
});

// ---- 隠れ ----
test('isHidden: 高さの範囲に入る手前の面に隠れる。同じ深さ・範囲外の高さ・建物の外は隠れない', () => {
  const inputs = { glZMm: 0, floors: [{ planeId: 'p', zLoMm: 0, zHiMm: 3000, segments: polySegments(rectPts(0, 0, 4000, 3000)) }] };
  const profiles = facadeFloorProfiles(inputs, { x: 0, y: 1 }); // 南立面: d=−3000（u=0..4000）
  assert.equal(isHidden(profiles, 2000, 1500, -1000), true, '奥（d=−1000）の点は隠れる');
  assert.equal(isHidden(profiles, 2000, 1500, -3000), false, '同じ深さは隠れない');
  assert.equal(isHidden(profiles, 2000, 3500, -1000), false, '階の高さの外は隠れない');
  assert.equal(isHidden(profiles, 5000, 1500, -1000), false, '建物の外（u の範囲外）は隠れない');
});

test('隠れ: 高さが重なる手前の塔（0〜6000）の前では、奥の低い棟（0〜3000）の上端の線が切れる', () => {
  // 階の z 範囲は普段は接するだけ（同じ高さに手前の線が重なり見た目は変わらない）。z が重なる入力でだけ効く判定を直接確かめる。
  const inputs = {
    glZMm: 0,
    floors: [
      { planeId: 'low', zLoMm: 0, zHiMm: 3000, segments: polySegments(rectPts(0, 0, 8000, 5000)) },   // 南面 d=−5000
      { planeId: 'tower', zLoMm: 0, zHiMm: 6000, segments: polySegments(rectPts(0, 0, 2000, 9000)) }, // 南面 d=−9000
    ],
  };
  const south = faceOf(buildFacadeModel(inputs, { annotationMm: ANNOT }), FacadeDirection.SOUTH);
  assert.deepEqual(hSpansAt(south, -3000), [[2000, 8000]], '塔の前（0..2000）では低い棟の上端は隠れる');
});

// ---- GL より下 ----
test('GL より下は描かない: 階の zLo が GL より下でも線は GL で切れる', () => {
  const inputs = { glZMm: 0, floors: [{ planeId: 'p1', zLoMm: -800, zHiMm: 2500, segments: polySegments(rectPts(0, 0, 4000, 3000)) }] };
  const lines = buildFacadeLines(inputs, facadeViews()[1]);
  assert.ok(lines.every(l => l.z1 >= 0 && l.z2 >= 0), JSON.stringify(lines));
  assert.ok(lines.length === 3);
});

// ---- 失敗系 ----
test('【失敗系】外壁の線分が1本も無ければ []（facadeExtentsMm は 0）', () => {
  assert.deepEqual(buildFacadeModel({ glZMm: 0, floors: [] }), []);
  assert.deepEqual(buildFacadeModel({ glZMm: 0, floors: [{ planeId: 'p', zLoMm: 0, zHiMm: 3000, segments: [] }] }), []);
  assert.deepEqual(facadeExtentsMm({ glZMm: 0, floors: [] }).maxWidthMm, 0);
});

test('depthProfile: 手前を向く線分の下側包絡（奥の重なりは手前に負ける・同じ深さの隣接は1区間）', () => {
  const segs = [
    { isVertical: false, value: 6000, lo: 0, hi: 4000, outwardSign: 1 },
    { isVertical: false, value: 6000, lo: 4000, hi: 8000, outwardSign: 1 },
    { isVertical: false, value: 3000, lo: 2000, hi: 6000, outwardSign: 1 },  // 奥（隠れる）
    { isVertical: false, value: 9000, lo: 6000, hi: 7000, outwardSign: -1 }, // 向こう向き（対象外）
  ];
  assert.deepEqual(depthProfile(segs, { x: 0, y: 1 }), [{ lo: 0, hi: 8000, d: -6000 }]);
});
