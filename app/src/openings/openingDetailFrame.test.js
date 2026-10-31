// openings/openingDetailFrame.js（三方枠の寸法を詳細図の基準・param へ割り当てる純関数と、両端への写像）の単体テスト。
// 図は openingDetailTestFixtures.js のコの字の方立（見付 fw・出幅 p は param・壁厚 T は stretch 1 本が吸う）。
// 検査は fitLocal（detail/detailPlacement.js）を直接通す——カタログ・メモは通さない（それは openingDetailFit.test.js）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitLocal } from '../detail/detailPlacement.js';
import { DetailDatumRole, DetailAxis, DetailDatumKind } from '../core/constants.js';
import { detailFrameTargets, placeDetailSides, DetailFrameError } from './openingDetailFrame.js';
import { jambFigure, materialBoundFigure } from './openingDetailTestFixtures.js';

/** 図を fit して両端へ写す。失敗は {error} をそのまま返す。 */
function place(fig, { wallThickness = 120, faceWidth = 20, projection = 12, coord1 = 0, coord2 = 1000, faceMin = -60 } = {}) {
  const t = detailFrameTargets(fig, { wallThickness, faceWidth, projection });
  if (t.error) return t;
  const fitted = fitLocal(fig, t.targets);
  if (fitted.error) return fitted;
  return placeDetailSides(fitted, { coord1, coord2, faceMin });
}

const pts = stroke => stroke.points.map(p => [p.along, p.perp]);

test('detailFrameTargets: OPENING_OUTER の s origin→0・WALL_FINISH_FACE の t origin→0／end→壁厚、param は見付・出幅', () => {
  const { targets } = detailFrameTargets(jambFigure('df-1'), { wallThickness: 120, faceWidth: 20, projection: 12 });
  assert.deepEqual(targets, {
    datums: { ds0: 0, dt0: 0, dt1: 120 },
    params: { frameFaceWidth: 20, frameProjection: 12 },
  });
});

test('位置合わせ: 既定（壁厚120・見付20・出幅12）の coord1 側の点列は、壁の面を基準にした図の頂点そのもの', () => {
  const [side1] = place(jambFigure('df-1'));
  assert.equal(side1.length, 1);
  assert.equal(side1[0].closed, false);
  assert.deepEqual(pts(side1[0]), [
    [0, -60], [0, -72], [20, -72], [20, -60], [20, 60], [20, 72], [0, 72], [0, 60],
  ]);
});

test('壁厚 105→120: stretch の区間だけが 15 伸び、固定寸法（出幅12・見付20）は変わらない', () => {
  const [a] = place(jambFigure('df-1'), { wallThickness: 105, faceMin: -52.5 });
  const [b] = place(jambFigure('df-1'), { wallThickness: 120, faceMin: -60 });
  assert.deepEqual(pts(a[0]), [[0, -52.5], [0, -64.5], [20, -64.5], [20, -52.5], [20, 52.5], [20, 64.5], [0, 64.5], [0, 52.5]]);
  const stretchA = a[0].points[4].perp - a[0].points[3].perp;
  const stretchB = b[0].points[4].perp - b[0].points[3].perp;
  assert.equal(stretchA, 105);
  assert.equal(stretchB, 120);
  // 固定寸法: 張り出し（出幅）と見付は壁厚によらず同じ
  for (const side of [a[0], b[0]]) {
    assert.equal(side.points[2].along - side.points[1].along, 20, '見付');
    assert.equal(side.points[3].perp - side.points[2].perp, 12, '出幅（外側）');
    assert.equal(side.points[5].perp - side.points[4].perp, 12, '出幅（内側）');
  }
});

test('出幅 12→20: 張り出しが追従し、壁の面から出幅ぶん外へ出る', () => {
  const [a] = place(jambFigure('df-1'), { projection: 20 });
  assert.deepEqual(pts(a[0]), [[0, -60], [0, -80], [20, -80], [20, -60], [20, 60], [20, 80], [0, 80], [0, 60]]);
});

test('見付 20→35: 見付方向の幅だけが変わる', () => {
  const [a] = place(jambFigure('df-1'), { faceWidth: 35 });
  assert.deepEqual(pts(a[0]).map(p => p[0]), [0, 0, 35, 35, 35, 35, 0, 0]);
});

test('coord2 側の鏡像: along が coord2 から内側（−along）へ向かい、perp は coord1 側と同じ', () => {
  const [side1, side2] = place(jambFigure('df-1'));
  assert.deepEqual(pts(side2[0]), [[1000, -60], [1000, -72], [980, -72], [980, -60], [980, 60], [980, 72], [1000, 72], [1000, 60]]);
  assert.deepEqual(side2[0].points.map(p => p.perp), side1[0].points.map(p => p.perp));
});

test('【失敗系】未対応の基準（role・軸・種別の組）は UNSUPPORTED_DATUM を返し、例外にしない', () => {
  const fig = jambFigure('df-1');
  const bad = [
    { ...fig.datums[0], role: DetailDatumRole.FL },                                    // 供給できない role
    { ...fig.datums[0], axis: DetailAxis.T },                                          // OPENING_OUTER は s 軸だけ
    { ...fig.datums[0], kind: DetailDatumKind.END },                                   // OPENING_OUTER の end は無い
    { ...fig.datums[1], axis: DetailAxis.S },                                          // WALL_FINISH_FACE は t 軸だけ
  ];
  for (const d of bad) {
    const r = detailFrameTargets({ ...fig, datums: [d, fig.datums[1], fig.datums[2]] }, { wallThickness: 120, faceWidth: 20, projection: 12 });
    assert.equal(r.error?.code, DetailFrameError.UNSUPPORTED_DATUM, JSON.stringify(d));
  }
});

test('【失敗系】材の寸法への束縛（material）は三方枠では未解決＝fit の error。datums の形不正も例外にならない', () => {
  const r = place(materialBoundFigure('df-m'));
  assert.equal(r.error?.code, 'unresolvedMaterial');
  const broken = { ...jambFigure('df-1'), datums: [null, 3, jambFigure('df-1').datums[0]] };
  const t = detailFrameTargets(broken, { wallThickness: 120, faceWidth: 20, projection: 12 });
  assert.ok(t.targets, '形の不正な datum は読み飛ばし、検証は fit に任せる');
  assert.ok(fitLocal(broken, t.targets).error, 'fit が理由つきで失敗する');
});

test('【失敗系】見付が 0 以下（開口幅 0 の頭打ち）・壁厚が固定寸法に足りない場合は fit の error', () => {
  assert.equal(place(jambFigure('df-1'), { faceWidth: 0 }).error?.code, 'badResolvedLength');
  // stretch 区間（壁厚 − 固定）が 0 以下: 壁厚0 は stretch が負になる
  assert.equal(place(jambFigure('df-1'), { wallThickness: 0 }).error?.code, 'fixedExceedsTarget');
});

// ---- 狭い開口（見付の頭打ち）: 開口幅 W に対し見付を W/4・W/2・3W/4・極小で試す ----
const clamp = (fw, w) => Math.min(fw, w / 2); // openingPlanSymbolGeometry.js clampFrameFaceWidth(fw, 0, w) と同じ

function segmentsOf(points) {
  return points.slice(1).map((p, i) => [points[i], p]);
}
function properlyCross([a, b], [c, d]) {
  const o = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
}
function selfIntersects(points) {
  const segs = segmentsOf(points);
  for (let i = 0; i < segs.length; i += 1) {
    for (let j = i + 2; j < segs.length; j += 1) if (properlyCross(segs[i], segs[j])) return true;
  }
  return false;
}

test('狭い開口の鏡像: 見付を開口幅の 1/4・1/2・3/4・極小で試しても、各方立は自己交差せず、両側が中央を越えない', () => {
  for (const W of [1000, 100, 1]) {
    for (const requested of [W / 4, W / 2, (W * 3) / 4, W * 10, 0.5]) {
      const faceWidth = clamp(requested, W);
      const [side1, side2] = place(jambFigure('df-1'), { coord1: 0, coord2: W, faceWidth });
      const label = `W=${W} 見付要求=${requested}`;
      assert.ok(!selfIntersects(pts(side1[0])), `${label}: coord1 側が自己交差`);
      assert.ok(!selfIntersects(pts(side2[0])), `${label}: coord2 側が自己交差`);
      assert.ok(Math.max(...side1[0].points.map(p => p.along)) <= W / 2 + 1e-9, `${label}: coord1 側が中央を越える`);
      assert.ok(Math.min(...side2[0].points.map(p => p.along)) >= W / 2 - 1e-9, `${label}: coord2 側が中央を越える`);
    }
  }
});
