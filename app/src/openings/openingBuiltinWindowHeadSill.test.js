// 窓の上枠・下枠（展開の断面。組込み detail/detailBuiltins.js df-builtin-window-head-25／-sill-25）が暗黙の既定（S8f-3b）:
// 割当て無しの出力 ≡ 従来（3a）の上枠・下枠の矩形（detailRefs を参照切れにして再現する）。差は図から描いた矩形の source='detail' だけ。
// 片開き戸の上枠は openingBuiltinDoorHead.test.js（無修正で緑のまま＝片開き戸は不変の証拠）。
// 既定は見付が全幅 25 のときだけ（高さ 50 未満の窓は fw が頭打ちされ、従来の矩形になる）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpeningCategory } from '@core';
import { clearOverlays, setOverlay } from '../catalog/catalogRegistry.js';
import { CatalogKind } from '../catalog/catalogKinds.js';
import {
  PenDir, DetailLenMode, DetailCategory, DetailView, DetailSubject, DetailDatumRole, DetailDatumKind, DetailAxis, DetailDash,
  DetailSlot, DetailFigureSource, DETAIL_FIGURE_VERSION, DETAIL_PRIM_SOURCE,
  DETAIL_BUILTIN_WINDOW_HEAD_KEY, DETAIL_BUILTIN_WINDOW_SILL_KEY, WINDOW_FRAME_JAMB_WIDTH_MM, FRAME_OVERHANG_MM,
} from '../core/constants.js';
import { openingSectionPrimitives } from './openingSection.js';
import { OpeningMechanism, IMPLEMENTED_MECHANISMS, openingSubTypeBuiltinList } from './openingCatalog.js';
import { resolveSwingDoorFrame, frameDefaultKey } from './openingDetailFit.js';

test.afterEach(() => clearOverlays());

const CUT = 'thick', SIL = 'medium';
const HEAD = DetailSlot.HEAD, SILL = DetailSlot.SILL, JAMB = DetailSlot.JAMB;
const GONE = { [HEAD]: 'df-gone', [SILL]: 'df-gone' };

const WINDOWS = openingSubTypeBuiltinList().filter(e => e.category === 'window');
const drawsWindowSection = e => IMPLEMENTED_MECHANISMS.has(e.mechanism) && e.mechanism !== OpeningMechanism.FRAME_ONLY;

const win = (subType, over = {}) => ({
  id: 'w1', category: OpeningCategory.WINDOW, subType, isVertical: false, hingeSide: -1, swingSide: 1,
  width: 1690, height: 1170, sillHeight: 800, ...over,
});
const section = (o, opts = {}, x0 = 0, dir = 1) => openingSectionPrimitives(o, x0, dir, CUT, SIL, { detailWeight: 'thin', wallThicknessMm: 115, ...opts });
const cutsOf = prims => prims.filter(p => p.weight === CUT);
const withoutSource = prims => prims.map(p => Object.fromEntries(Object.entries(p).filter(([k]) => k !== 'source')));

// ---- 同値（既定の組込み ≡ 従来の上枠・下枠の矩形）----

test('暗黙の既定（割当て無し）≡ 従来（全 subType × 吊元±1 × 開き勝手±1 × 帯の向き±1 × 壁厚 5 通り × 起点・向き × 窓台 {0,800,812.5} × 高さ {1170,40}）。差は source だけ', () => {
  let cases = 0;
  for (const entry of WINDOWS) {
    for (const hingeSide of [1, -1]) {
      for (const swingSide of [1, -1]) {
        for (const worldPerDirSign of [1, -1]) {
          for (const wallThicknessMm of [60, 115, 102.3, 137.7, undefined]) {
            for (const [x0, dir] of [[0, 1], [3.7, 1], [5000.123, -1], [-2400.4, 1]]) {
              for (const sillHeight of [0, 800, 812.5]) {
                for (const height of [1170, 40]) {
                  const o = win(entry.key, { hingeSide, swingSide, sillHeight, height });
                  const opts = { wallThicknessMm, worldPerDirSign };
                  const dflt = section(o, opts, x0, dir);
                  const legacy = section({ ...o, detailRefs: GONE }, opts, x0, dir);
                  const label = `${entry.key} h=${hingeSide} s=${swingSide} sign=${worldPerDirSign} w=${wallThicknessMm} x0=${x0} dir=${dir} sill=${sillHeight} H=${height}`;
                  assert.deepEqual(withoutSource(dflt), legacy, label);
                  assert.equal(legacy.some(p => 'source' in p), false, `従来には source が無い: ${label}`);
                  // 図から描くのは窓の断面で見付が全幅 25 のときだけ。上枠 1 ＋（窓台があれば）下枠 1
                  const expected = drawsWindowSection(entry) && height === 1170 ? 1 + (sillHeight === 0 ? 0 : 1) : 0;
                  const sourced = dflt.filter(p => 'source' in p);
                  assert.equal(sourced.length, expected, `source の本数: ${label}`);
                  assert.ok(sourced.every(p => p.type === 'rect' && p.weight === CUT && p.source === DETAIL_PRIM_SOURCE), `source は CUT の矩形だけ: ${label}`);
                  cases += 1;
                }
              }
            }
          }
        }
      }
    }
  }
  assert.equal(cases, WINDOWS.length * 2 * 2 * 2 * 5 * 4 * 3 * 2);
});

test('既定の経路は実際に図を通っている（resolveSwingDoorFrame が上枠・下枠の既定キーで source=default・4 点の矩形を返す）', () => {
  for (const [slot, key] of [[HEAD, DETAIL_BUILTIN_WINDOW_HEAD_KEY], [SILL, DETAIL_BUILTIN_WINDOW_SILL_KEY]]) {
    const r = resolveSwingDoorFrame({
      symbolKey: 'AW', slot, coord1: -1970, coord2: -800, faceMin: FRAME_OVERHANG_MM, faceMax: FRAME_OVERHANG_MM + 115, wallThickness: 115,
      tSign: 1, faceWidth: WINDOW_FRAME_JAMB_WIDTH_MM, projection: FRAME_OVERHANG_MM, defaultKey: key,
    });
    assert.equal(r.source, DetailFigureSource.DEFAULT, slot);
    assert.equal(r.sides[0].length, 1);
    assert.equal(r.sides[1].length, 1);
    assert.equal(r.sides[1][0].points.length, 4);
  }
});

test('窓の上枠・下枠は x が帯いっぱい（0〜壁厚+24）・見付 25。上枠は上端から下へ・下枠は窓台の上端から上へ', () => {
  const [head, sill] = cutsOf(section(win('casement')));
  assert.deepEqual([head.x, head.w, head.y, head.h], [0, 139, -1970, 25]);
  assert.deepEqual([sill.x, sill.w, sill.y, sill.h], [0, 139, -825, 25]);
  assert.equal(head.source, DETAIL_PRIM_SOURCE);
  assert.equal(sill.source, DETAIL_PRIM_SOURCE);
});

test('引き違い窓（SLIDE_DOUBLE。方立は対象外）も上枠・下枠の既定が効く', () => {
  const prims = section(win('doubleSliding'));
  const cuts = cutsOf(prims);
  assert.equal(cuts.length, 2);
  assert.ok(cuts.every(p => p.source === DETAIL_PRIM_SOURCE));
});

// ---- 掃き出し窓（窓台 0）・frameDefaultKey ----

test('掃き出し窓（窓台0）は下枠を描かない。上枠だけ既定。下枠の既定キーも undefined', () => {
  const o = win('doubleSliding', { sillHeight: 0, height: 2000 });
  const cuts = cutsOf(section(o));
  assert.equal(cuts.length, 1);
  assert.equal(cuts[0].source, DETAIL_PRIM_SOURCE);
  assert.equal(frameDefaultKey(o, SILL, OpeningMechanism.SLIDE_DOUBLE), undefined);
  assert.equal(frameDefaultKey(o, HEAD, OpeningMechanism.SLIDE_DOUBLE), DETAIL_BUILTIN_WINDOW_HEAD_KEY);
  // 窓台0でも明示の下枠は描かない（下枠そのものが無い）
  setOverlay(CatalogKind.DETAIL_FIGURE, { doc: [rectFigure('df-sill', stretchMid, { view: DetailView.SECTION, subject: DetailSubject.SILL })] });
  assert.equal(cutsOf(section({ ...o, detailRefs: { [SILL]: 'df-sill' } })).length, 1);
});

test('frameDefaultKey の窓の上枠・下枠: 全機構で上枠、下枠は窓台あり。機構未指定・実装外・三方枠・建具・欠落は undefined', () => {
  const w = { category: 'window', subType: 'x', sillHeight: 800 };
  assert.equal(frameDefaultKey(w, HEAD, OpeningMechanism.FIXED), DETAIL_BUILTIN_WINDOW_HEAD_KEY);
  assert.equal(frameDefaultKey(w, SILL, OpeningMechanism.FIXED), DETAIL_BUILTIN_WINDOW_SILL_KEY);
  assert.equal(frameDefaultKey(w, HEAD, OpeningMechanism.SLIDE_DOUBLE), DETAIL_BUILTIN_WINDOW_HEAD_KEY);
  assert.equal(frameDefaultKey(w, SILL, OpeningMechanism.SLIDE_DOUBLE), DETAIL_BUILTIN_WINDOW_SILL_KEY);
  assert.equal(frameDefaultKey({ ...w, sillHeight: 0 }, SILL, OpeningMechanism.FIXED), undefined, '窓台0');
  assert.equal(frameDefaultKey({ ...w, sillHeight: null }, SILL, OpeningMechanism.FIXED), undefined, '窓台未設定');
  assert.equal(frameDefaultKey(w, HEAD, undefined), undefined, '機構未指定');
  assert.equal(frameDefaultKey(w, SILL, 'noSuchMechanism'), undefined, '実装外の機構');
  assert.equal(frameDefaultKey(w, HEAD, OpeningMechanism.FRAME_ONLY), undefined, '三方枠');
  assert.equal(frameDefaultKey({ category: 'fitting', subType: 'swingIn' }, HEAD, OpeningMechanism.SWING_IN), undefined, '建具');
  assert.equal(frameDefaultKey({ subType: 'fixed' }, SILL, OpeningMechanism.FIXED), undefined, 'category 欠落');
  assert.equal(frameDefaultKey(null, HEAD, OpeningMechanism.FIXED), undefined, 'opening なし');
});

// ---- 明示の割当て・R5 ----

const strokeMoves = mid => [
  { dir: PenDir.RIGHT, len: { mm: 20, mode: DetailLenMode.FIXED } },
  { dir: PenDir.DOWN, len: { mm: 5, mode: DetailLenMode.FIXED } },
  ...mid,
  { dir: PenDir.DOWN, len: { mm: 5, mode: DetailLenMode.FIXED } },
  { dir: PenDir.LEFT, len: { mm: 20, mode: DetailLenMode.FIXED } },
];
// 壁の面を 5 ずつ越えて包む見付 20 の矩形の図。
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
// 壁の面の外（t>壁厚）で見付が 20→10 に細る切り欠き付きの図（上下非対称）。
const notchMid = [
  { dir: PenDir.DOWN, len: { mm: 50, mode: DetailLenMode.STRETCH } },
  { dir: PenDir.LEFT, len: { mm: 10, mode: DetailLenMode.FIXED } },
  { dir: PenDir.DOWN, len: { mm: 30, mode: DetailLenMode.FIXED } },
  { dir: PenDir.RIGHT, len: { mm: 10, mode: DetailLenMode.FIXED } },
];
const OPTS = { wallThicknessMm: 100, openPerpDir: 1, worldPerDirSign: 1 };

test('R5: 明示の方立だけの割当て（jamb）は上枠に流用されるが下枠には流用されない（下枠は既定のまま）', () => {
  setOverlay(CatalogKind.DETAIL_FIGURE, { doc: [rectFigure('df-sec-jamb', stretchMid)] });
  const [head, sill] = cutsOf(section(win('casement', { detailRefs: { [JAMB]: 'df-sec-jamb' } }), OPTS));
  // 帯の壁の面は 12〜112。5 ずつ越えて 7〜117（w=110）・上端 −1970 から見付 20
  assert.deepEqual([head.x, head.w, head.y, head.h], [7, 110, -1970, 20], '上枠は方立の図の形');
  assert.deepEqual([sill.x, sill.w, sill.y, sill.h], [0, 124, -825, 25], '下枠は既定の形（帯いっぱい・見付 25）');
});

test('明示の上枠（別形）は閉じた polyline（CUT・source 付き）。明示の head は jamb より優先', () => {
  setOverlay(CatalogKind.DETAIL_FIGURE, {
    doc: [rectFigure('df-head', notchMid, { view: DetailView.SECTION, subject: DetailSubject.HEAD }), rectFigure('df-jamb', stretchMid)],
  });
  const prims = section(win('casement', { detailRefs: { [HEAD]: 'df-head', [JAMB]: 'df-jamb' } }), OPTS);
  const poly = prims.find(p => p.type === 'polyline');
  assert.ok(poly, 'polyline が出る');
  assert.equal(poly.weight, CUT);
  assert.equal(poly.source, DETAIL_PRIM_SOURCE);
  assert.deepEqual(poly.points[0], poly.points.at(-1), '閉じた輪郭');
  assert.equal(cutsOf(prims).filter(p => p.type === 'rect').length, 1, '残る CUT の矩形は下枠だけ');
});

test('上下非対称な明示の下枠は窓台から上向きに置かれる（細った側は窓台の上端から 10 上）', () => {
  setOverlay(CatalogKind.DETAIL_FIGURE, {
    doc: [rectFigure('df-sill', notchMid, { view: DetailView.SECTION, subject: DetailSubject.SILL })],
  });
  const prims = section(win('casement', { detailRefs: { [SILL]: 'df-sill' } }), OPTS);
  const poly = prims.find(p => p.type === 'polyline');
  assert.ok(poly, '下枠が polyline');
  const ys = poly.points.map(([, y]) => y);
  assert.ok(ys.every(y => y <= -800 && y >= -820), `窓台(−800)から上へ見付 20 の範囲: ${ys}`);
  assert.ok(ys.includes(-810), '細った側は窓台から 10 上');
  assert.equal(poly.source, DETAIL_PRIM_SOURCE);
  // 上枠は既定のまま
  assert.equal(cutsOf(prims).find(p => p.type === 'rect').y, -1970);
});

test('明示の上枠・下枠の t は開く側の面が正: 細る側（切り欠き側）は openPerpDir +1 で帯の奥、−1 で手前（上枠・下枠とも）', () => {
  setOverlay(CatalogKind.DETAIL_FIGURE, {
    doc: [
      rectFigure('df-head', notchMid, { view: DetailView.SECTION, subject: DetailSubject.HEAD }),
      rectFigure('df-sill', notchMid, { view: DetailView.SECTION, subject: DetailSubject.SILL }),
    ],
  });
  const o = win('casement', { detailRefs: { [HEAD]: 'df-head', [SILL]: 'df-sill' } });
  // 帯は 124 幅・壁の面は 12〜112。細った部分は上枠が y=−1960（上端 −1970 から 10 下）・下枠が y=−810（窓台 −800 から 10 上）
  const narrowXs = (openPerpDir, worldPerDirSign, y) => section(o, { ...OPTS, openPerpDir, worldPerDirSign })
    .filter(p => p.type === 'polyline').flatMap(p => p.points.filter(([, py]) => py === y).map(([x]) => x));
  for (const y of [-1960, -810]) {
    const far = narrowXs(1, 1, y), near = narrowXs(-1, 1, y);
    assert.ok(far.length > 0 && far.every(x => x >= 112), `奥 y=${y}: ${far}`);
    assert.ok(near.length > 0 && near.every(x => x <= 12), `手前 y=${y}: ${near}`);
    assert.deepEqual(narrowXs(-1, -1, y), far, `worldPerDirSign を反転すると鏡像が戻る y=${y}`);
  }
});

// ---- 従来へ戻る（失敗系）----

test('【失敗系】fit できない明示の下枠・上枠は従来の矩形（source なし）。参照切れの明示も既定へ戻らず従来', () => {
  setOverlay(CatalogKind.DETAIL_FIGURE, {
    doc: [
      rectFigure('df-huge-sill', hugeMid, { view: DetailView.SECTION, subject: DetailSubject.SILL }),
      rectFigure('df-huge-head', hugeMid, { view: DetailView.SECTION, subject: DetailSubject.HEAD }),
    ],
  });
  const legacy = section(win('casement', { detailRefs: GONE }), OPTS);
  assert.equal(legacy.some(p => 'source' in p), false);
  assert.deepEqual(section(win('casement', { detailRefs: { [SILL]: 'df-huge-sill', [HEAD]: 'df-huge-head' } }), OPTS), legacy);
  const r = resolveSwingDoorFrame({
    symbolKey: 'AW', detailRefs: { [SILL]: 'df-huge-sill' }, slot: SILL, coord1: -1970, coord2: -800, faceMin: 12, faceMax: 112,
    wallThickness: 100, tSign: 1, faceWidth: WINDOW_FRAME_JAMB_WIDTH_MM, projection: FRAME_OVERHANG_MM,
    defaultKey: DETAIL_BUILTIN_WINDOW_SILL_KEY,
  });
  assert.equal(r.error !== undefined && r.source === DetailFigureSource.EXPLICIT, true);
});

test('【失敗系】既定の組込みと同じキーの上書きが fit できなければ従来の矩形（source なし）。fit できる上書きは効く', () => {
  setOverlay(CatalogKind.DETAIL_FIGURE, {
    doc: [rectFigure(DETAIL_BUILTIN_WINDOW_SILL_KEY, hugeMid, { view: DetailView.SECTION, subject: DetailSubject.SILL })],
  });
  assert.deepEqual(section(win('casement'), OPTS)[1], withoutSource(section(win('casement', { detailRefs: GONE }), OPTS))[1]);
  clearOverlays();
  setOverlay(CatalogKind.DETAIL_FIGURE, {
    doc: [rectFigure(DETAIL_BUILTIN_WINDOW_SILL_KEY, stretchMid, { view: DetailView.SECTION, subject: DetailSubject.SILL })],
  });
  const sill = cutsOf(section(win('casement'), OPTS))[1];
  assert.deepEqual([sill.x, sill.w, sill.h], [7, 110, 20], '上書きの形で描く');
});

test('【失敗系】defaultKey=null は既定なし（片開き戸の既定へ落ちない）。参照切れの種別の窓・高さ 40 の窓は従来のまま source なし', () => {
  const r = resolveSwingDoorFrame({
    symbolKey: 'AW', slot: HEAD, coord1: -1970, coord2: -800, faceMin: 12, faceMax: 112, wallThickness: 100,
    tSign: 1, faceWidth: 20, projection: FRAME_OVERHANG_MM, defaultKey: null,
  });
  assert.equal(r, null);
  assert.equal(section(win('noSuchWindow'), OPTS).some(p => 'source' in p), false);
  assert.equal(section(win('casement', { height: 40 }), OPTS).some(p => 'source' in p), false);
});
