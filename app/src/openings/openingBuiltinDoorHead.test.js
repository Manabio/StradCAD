// 片開き戸の上枠（展開の断面。組込み detail/detailBuiltins.js df-builtin-door-head-30）が暗黙の既定（S8e-2）:
// 割当て無しの出力 ≡ 従来の上枠の矩形（detailRefs の head を参照切れにして再現する）。差は source='detail' の属性だけ（R3）。
// 方立（平面）の同値は openingBuiltinDoorFrame.test.js。断面の帯は常に壁の面±出幅で見付は常に 30 なので、R4 に当たる除外は無い。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpeningCategory } from '@core';
import { clearOverlays, setOverlay } from '../catalog/catalogRegistry.js';
import { CatalogKind } from '../catalog/catalogKinds.js';
import {
  PenDir, DetailLenMode, DetailCategory, DetailView, DetailSubject, DetailDatumRole, DetailDatumKind, DetailAxis, DetailDash,
  DetailSlot, DetailFigureSource, DETAIL_FIGURE_VERSION, DETAIL_PRIM_SOURCE, DETAIL_BUILTIN_DOOR_HEAD_KEY,
  FRAME_OVERHANG_MM, FRAME_JAMB_WIDTH_MM, SWING_LEAF_SUBTYPE,
} from '../core/constants.js';
import { openingSectionPrimitives } from './openingSection.js';
import { resolveSwingDoorFrame } from './openingDetailFit.js';

test.afterEach(() => clearOverlays());

const CUT = 'thick', SIL = 'medium';
const HEAD = DetailSlot.HEAD;
const JAMB = DetailSlot.JAMB;
const GONE = { [HEAD]: 'df-gone' };

const door = (over = {}) => ({
  id: 'o1', category: OpeningCategory.FITTING, subType: SWING_LEAF_SUBTYPE, width: 800, height: 2000, sillHeight: null, ...over,
});
const section = (o, opts = {}, x0 = 0, dir = 1) => openingSectionPrimitives(o, x0, dir, CUT, SIL, { detailWeight: 'thin', ...opts });
const headOf = prims => prims.filter(p => p.weight === CUT);
const withoutSource = prims => prims.map(p => Object.fromEntries(Object.entries(p).filter(([k]) => k !== 'source')));

// ---- 同値（既定の組込み ≡ 従来の上枠の矩形）----

test('暗黙の既定（割当て無し）≡ 従来の上枠（開き勝手±1 × 帯の向き±1 × 壁厚 {60,115,102.3,137.7,未指定} × 起点・向き）。差は上枠の source だけ', () => {
  let cases = 0;
  for (const wallThicknessMm of [60, 115, 102.3, 137.7, undefined]) {
    for (const openPerpDir of [1, -1]) {
      for (const worldPerDirSign of [1, -1]) {
        for (const [x0, dir] of [[0, 1], [3.7, 1], [5000.123, -1], [-2400.4, 1]]) {
          const opts = { wallThicknessMm, openPerpDir, worldPerDirSign };
          const dflt = section(door(), opts, x0, dir);
          const legacy = section(door({ detailRefs: GONE }), opts, x0, dir);
          assert.equal(dflt.length, 3);
          assert.deepEqual(withoutSource(dflt), legacy, `w=${wallThicknessMm} open=${openPerpDir} sign=${worldPerDirSign} x0=${x0} dir=${dir}`);
          assert.deepEqual(dflt.filter(p => 'source' in p).map(p => [p.type, p.weight, p.source]), [['rect', CUT, DETAIL_PRIM_SOURCE]], '上枠だけに source');
          assert.equal(legacy.some(p => 'source' in p), false, '従来には source が無い');
          cases += 1;
        }
      }
    }
  }
  assert.equal(cases, 5 * 2 * 2 * 4);
});

test('既定の経路は実際に図を通っている（resolveSwingDoorFrame が slot=head で source=default・共線除去後 4 点の矩形を返す）', () => {
  const r = resolveSwingDoorFrame({
    symbolKey: 'AD', slot: HEAD, coord1: -2000, coord2: 0, faceMin: FRAME_OVERHANG_MM, faceMax: FRAME_OVERHANG_MM + 115, wallThickness: 115,
    tSign: 1, faceWidth: FRAME_JAMB_WIDTH_MM, projection: FRAME_OVERHANG_MM,
  });
  assert.equal(r.source, DetailFigureSource.DEFAULT);
  assert.equal(r.sides[0].length, 1);
  assert.equal(r.sides[0][0].points.length, 4);
});

// ---- 明示の割当て・R9 ----

const strokeMoves = mid => [
  { dir: PenDir.RIGHT, len: { mm: 20, mode: DetailLenMode.FIXED } },
  { dir: PenDir.DOWN, len: { mm: 5, mode: DetailLenMode.FIXED } },
  ...mid,
  { dir: PenDir.DOWN, len: { mm: 5, mode: DetailLenMode.FIXED } },
  { dir: PenDir.LEFT, len: { mm: 20, mode: DetailLenMode.FIXED } },
];
// 壁の面を 5 ずつ越えて包む見付 20 の矩形（方立の図。上枠にも流用される）。
const rectFigure = (key, mid, over = {}) => ({
  key, version: DETAIL_FIGURE_VERSION, label: key,
  category: DetailCategory.PAIRED, view: DetailView.PLAN, subject: DetailSubject.JAMB,
  strokes: [{ id: 'a', closed: true, line: { weightRole: 'medium', dashRole: DetailDash.SOLID }, moves: strokeMoves(mid) }],
  datums: [
    { id: 'ds0', role: DetailDatumRole.OPENING_OUTER, axis: DetailAxis.S, kind: DetailDatumKind.ORIGIN, offsetMm: 0 },
    { id: 'dt0', role: DetailDatumRole.WALL_FINISH_FACE, axis: DetailAxis.T, kind: DetailDatumKind.ORIGIN, offsetMm: 0 },
    { id: 'dt1', role: DetailDatumRole.WALL_FINISH_FACE, axis: DetailAxis.T, kind: DetailDatumKind.END, offsetMm: 0 },
  ],
  anchors: [
    { datumId: 'ds0', strokeId: 'a', vertexIndex: 0 },
    { datumId: 'dt0', strokeId: 'a', vertexIndex: 2 },
    { datumId: 'dt1', strokeId: 'a', vertexIndex: 3 },
  ],
  provenance: null, note: null, ...over,
});
const stretchMid = [{ dir: PenDir.DOWN, len: { mm: 50, mode: DetailLenMode.STRETCH } }];
const hugeMid = [{ dir: PenDir.DOWN, len: { mm: 500, mode: DetailLenMode.FIXED } }, ...stretchMid];

test('R9: 明示の方立だけの割当て（jamb）は上枠にも流用される。既定の上枠（従来の矩形）ではなく方立の図の形（見付 20・面を 5 越える）', () => {
  setOverlay(CatalogKind.DETAIL_FIGURE, { doc: [rectFigure('df-sec-jamb', stretchMid)] });
  const o = door({ detailRefs: { [JAMB]: 'df-sec-jamb' } });
  const opts = { wallThicknessMm: 100, openPerpDir: 1, worldPerDirSign: 1 };
  const [head] = headOf(section(o, opts));
  assert.equal(head.type, 'rect', '4 点の軸平行な矩形は rect（従来と同じ型）');
  assert.equal(head.source, DETAIL_PRIM_SOURCE);
  // 帯の壁の面は 12〜112。5 ずつ越えて 7〜117（w=110）・上端 −2000 から見付 20
  assert.deepEqual([head.x, head.w, head.y, head.h], [7, 110, -2000, 20]);
  assert.notDeepEqual(withoutSource([head]), headOf(section({ ...o, detailRefs: GONE }, opts)));
});

// 壁の面（t=0〜壁厚）の外（t>壁厚）で見付が 20→10 に細る切り欠き付きの図（矩形でも t について対称でもない）。
const notchMid = [
  { dir: PenDir.DOWN, len: { mm: 50, mode: DetailLenMode.STRETCH } },
  { dir: PenDir.LEFT, len: { mm: 10, mode: DetailLenMode.FIXED } },
  { dir: PenDir.DOWN, len: { mm: 30, mode: DetailLenMode.FIXED } },
  { dir: PenDir.RIGHT, len: { mm: 10, mode: DetailLenMode.FIXED } },
];

test('明示の head の割当ては jamb より優先。矩形でない形は閉じた polyline（始点を末尾に足す）で CUT・source 付き', () => {
  setOverlay(CatalogKind.DETAIL_FIGURE, {
    doc: [rectFigure('df-sec-head', notchMid, { view: DetailView.SECTION, subject: DetailSubject.HEAD }), rectFigure('df-sec-jamb2', stretchMid)],
  });
  const o = door({ detailRefs: { [HEAD]: 'df-sec-head', [JAMB]: 'df-sec-jamb2' } });
  const prims = section(o, { wallThicknessMm: 100, openPerpDir: 1, worldPerDirSign: 1 });
  const poly = prims.find(p => p.type === 'polyline');
  assert.ok(poly, 'polyline が出る');
  assert.equal(poly.weight, CUT);
  assert.equal(poly.source, DETAIL_PRIM_SOURCE);
  assert.deepEqual(poly.points[0], poly.points.at(-1), '閉じた輪郭');
  assert.equal(prims.filter(p => p.type === 'rect' && p.weight === CUT).length, 0, '従来の矩形も jamb の矩形も出ない');
  assert.equal(prims.length, 3);
});

test('向き: 明示の図の t は開く側が正。細る側（t>壁厚）は atFar なら帯の奥（壁の面の外・perp 大）、手前なら帯の手前に出る', () => {
  setOverlay(CatalogKind.DETAIL_FIGURE, { doc: [rectFigure('df-sec-notch', notchMid)] });
  const o = door({ detailRefs: { [JAMB]: 'df-sec-notch' } });
  // 細った部分の along は上端 −2000 から 10（見付 20 のうち内側へ 10 引っ込む）。帯の壁の面は 12〜112。
  const narrowPerps = openPerpDir => section(o, { wallThicknessMm: 100, openPerpDir, worldPerDirSign: 1 })
    .find(p => p.type === 'polyline').points.filter(([, y]) => y === -2000 + 10).map(([x]) => x);
  assert.ok(narrowPerps(1).length > 0 && narrowPerps(1).every(x => x >= 112), '奥');
  assert.ok(narrowPerps(-1).length > 0 && narrowPerps(-1).every(x => x <= 12), '手前');
});

// ---- 従来へ戻る（失敗系）----

test('【失敗系】fit できない明示の図は従来の矩形（source なし）。参照切れの明示も既定へ戻らず従来', () => {
  setOverlay(CatalogKind.DETAIL_FIGURE, { doc: [rectFigure('df-sec-huge', hugeMid)] });
  const opts = { wallThicknessMm: 100, openPerpDir: 1, worldPerDirSign: 1 };
  const legacy = section(door({ detailRefs: GONE }), opts);
  assert.equal(legacy.some(p => 'source' in p), false);
  assert.deepEqual(section(door({ detailRefs: { [HEAD]: 'df-sec-huge' } }), opts), legacy);
  const r = resolveSwingDoorFrame({
    symbolKey: 'AD', detailRefs: { [HEAD]: 'df-sec-huge' }, slot: HEAD, coord1: -2000, coord2: 0, faceMin: 12, faceMax: 112,
    wallThickness: 100, tSign: 1, faceWidth: FRAME_JAMB_WIDTH_MM, projection: FRAME_OVERHANG_MM,
  });
  assert.equal(r.error !== undefined && r.source === DetailFigureSource.EXPLICIT, true);
});

test('【失敗系】既定の組込みと同じキーの上書きが fit できなければ従来の矩形（source なし）。fit できる上書きは効く', () => {
  setOverlay(CatalogKind.DETAIL_FIGURE, { doc: [rectFigure(DETAIL_BUILTIN_DOOR_HEAD_KEY, hugeMid, { view: DetailView.SECTION, subject: DetailSubject.HEAD })] });
  const opts = { wallThicknessMm: 100, openPerpDir: 1, worldPerDirSign: 1 };
  assert.deepEqual(section(door(), opts), section(door({ detailRefs: GONE }), opts));
  clearOverlays();
  setOverlay(CatalogKind.DETAIL_FIGURE, { doc: [rectFigure(DETAIL_BUILTIN_DOOR_HEAD_KEY, stretchMid, { view: DetailView.SECTION, subject: DetailSubject.HEAD })] });
  const [head] = headOf(section(door(), opts));
  assert.deepEqual([head.x, head.w, head.h], [7, 110, 20], '上書きの形で描く');
});

test('片開き戸でない建具（subType が違う）の断面は従来の帯のまま（source なし）', () => {
  const sliding = section(door({ subType: 'sliding' }), { wallThicknessMm: 100 });
  assert.equal(sliding.length, 3);
  assert.equal(sliding.some(p => 'source' in p), false);
});
