// 片開き戸の方立（平面・詳細 LOD）の組込み図（detail/detailBuiltins.js df-builtin-door-jamb-30）が暗黙の既定（S8e-1）:
// 割当て無しの出力 ≡ 従来の方立 swingFramePrimitives（フォールバック。参照切れの明示の割当てで再現する）。
// 平面の記号には source を付けないので、プリミティブ列全体を deepEqual で比べる（elevationBuiltinBaseboard.test.js と同じ流儀）。
// 同値が成り立たない前提（R4: 見付が全幅 30 でない・半外付け・壁が薄すぎて fit できない）は黙って従来の描きになる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpeningCategory } from '@core';
import { clearOverlays, setOverlay } from '../catalog/catalogRegistry.js';
import { CatalogKind, kindDef } from '../catalog/catalogKinds.js';
import {
  PenDir, DetailLenMode, DetailCategory, DetailView, DetailSubject, DetailDatumRole, DetailDatumKind, DetailAxis, DetailDash,
  DetailSlot, DetailFigureSource, DETAIL_FIGURE_VERSION, DETAIL_BUILTIN_DOOR_JAMB_KEY, DETAIL_BUILTIN_DOOR_HEAD_KEY,
  FRAME_OVERHANG_MM, SWING_LEAF_SUBTYPE,
} from '../core/constants.js';
import { detailBuiltinFigures, fitLocal } from '../detail/detailPlacement.js';
import { LodLevel } from '../viewport.js';
import { OpeningMechanism } from './openingCatalog.js';
import { buildOpeningPlanSymbol } from './openingPlanSymbol.js';
import { resolveSwingDoorFrame } from './openingDetailFit.js';
import { placeDetailSides, withoutCollinearPoints, detailFrameTargets } from './openingDetailFrame.js';

test.afterEach(() => clearOverlays());

const JAMB = DetailSlot.JAMB;
const GONE = { [JAMB]: 'df-gone' };

function opening(over = {}) {
  return {
    category: OpeningCategory.FITTING, subType: SWING_LEAF_SUBTYPE,
    coord1: 200.3, coord2: 1000.3, centerCoord: 600.3, isVertical: false, width: 800,
    frameDepth: 0, lineWeight: 0.35, hingeSide: -1, swingSide: 1, ...over,
  };
}
// faceA は叩いた面（axisValue）、壁厚 w ぶん離れた面が faceB。faceLo/faceHi の大小どちらの順でも渡せる。
function plan(op, { faceA = 1000.3, w = 102.3, swapFaces = false } = {}) {
  const faceB = faceA + w;
  return buildOpeningPlanSymbol(op, {
    entry: { mechanism: OpeningMechanism.SWING }, lodLevel: LodLevel.DETAIL, axisValue: faceA,
    faceLo: swapFaces ? faceB : faceA, faceHi: swapFaces ? faceA : faceB, exteriorDirOf: () => 1,
  });
}
const frames = prims => prims.filter(p => p.role === 'frame');

// ---- 同値（既定の組込み ≡ 従来の方立）----

test('既定の組込みが供給されている（方立・上枠）。方立は PAIRED/PLAN/JAMB・上枠は PAIRED/SECTION/HEAD', () => {
  const jamb = detailBuiltinFigures.find(e => e.key === DETAIL_BUILTIN_DOOR_JAMB_KEY);
  const head = detailBuiltinFigures.find(e => e.key === DETAIL_BUILTIN_DOOR_HEAD_KEY);
  assert.deepEqual([jamb.category, jamb.view, jamb.subject], [DetailCategory.PAIRED, DetailView.PLAN, DetailSubject.JAMB]);
  assert.deepEqual([head.category, head.view, head.subject], [DetailCategory.PAIRED, DetailView.SECTION, DetailSubject.HEAD]);
});

test('組込みの方立・上枠は登録の検証を通り、プレビューの壁厚（100）で detailFrameTargets と fit が成る（方立 8 点・上枠 6 点＝t の基準の頂点を含む）', () => {
  const def = kindDef(CatalogKind.DETAIL_FIGURE);
  const expectedPoints = { [DETAIL_BUILTIN_DOOR_JAMB_KEY]: 8, [DETAIL_BUILTIN_DOOR_HEAD_KEY]: 6 };
  for (const [key, count] of Object.entries(expectedPoints)) {
    const fig = detailBuiltinFigures.find(e => e.key === key);
    assert.doesNotThrow(() => def.validate(fig), `${key} は登録の検証を通る`);
    const targets = detailFrameTargets(fig, { wallThickness: 100, faceWidth: 30, projection: FRAME_OVERHANG_MM });
    assert.equal(targets.error, undefined);
    const fitted = fitLocal(fig, targets.targets);
    assert.equal(fitted.error, undefined, `${key} は fit できる`);
    assert.equal(fitted.strokes[0].points.length, count);
  }
});

test('暗黙の既定（割当て無し）≡ 従来の方立（開き勝手±1 × 吊元±1 × 縦横 × 面の順 × 壁厚 {60,115,102.3,137.7} × 面の座標）', () => {
  let cases = 0;
  for (const w of [60, 115, 102.3, 137.7]) { // 137.7×faceA 3.7 は fit・配置の丸めが従来の式と 1ULP ずれる（snapNear が吸収する）
    for (const faceA of [1000.3, 3.7, 5000.123, -2400.4]) {
      for (const isVertical of [false, true]) {
        for (const swingSide of [1, -1]) {
          for (const hingeSide of [1, -1]) {
            for (const swapFaces of [false, true]) {
              const op = opening({ isVertical, swingSide, hingeSide });
              const dflt = plan(op, { faceA, w, swapFaces });
              const legacy = plan({ ...op, detailRefs: GONE }, { faceA, w, swapFaces });
              assert.equal(frames(dflt).length, 2, '方立 2 本');
              assert.deepEqual(dflt, legacy, `w=${w} faceA=${faceA} vertical=${isVertical} swing=${swingSide} hinge=${hingeSide} swap=${swapFaces}`);
              cases += 1;
            }
          }
        }
      }
    }
  }
  assert.equal(cases, 4 * 4 * 2 * 2 * 2 * 2);
});

test('既定の経路は実際に図を通っている（resolveSwingDoorFrame が source=default で 6 点の方立を 2 本返す）', () => {
  const r = resolveSwingDoorFrame({
    symbolKey: 'AD', slot: JAMB, coord1: 200.3, coord2: 1000.3, faceMin: 1000.3, faceMax: 1000.3 + 102.3, wallThickness: 102.3,
    tSign: 1, faceWidth: 30, projection: FRAME_OVERHANG_MM,
  });
  assert.equal(r.source, DetailFigureSource.DEFAULT);
  assert.equal(r.sides.flat().length, 2);
  assert.equal(r.profiles.every(p => p.closed && p.points.length === 6), true, '共線の頂点は除かれて六角形');
});

test('平面の記号には source を付けない（S3 と同じ）', () => {
  assert.equal(frames(plan(opening())).some(p => 'source' in p), false);
});

// ---- 従来の描きへ戻る（R4・fit 失敗・対象外）----

test('【失敗系】壁が薄く fit できない（25mm）は従来の描き。resolveSwingDoorFrame は error（source=default）', () => {
  const op = opening();
  assert.deepEqual(plan(op, { w: 25 }), plan({ ...op, detailRefs: GONE }, { w: 25 }));
  const r = resolveSwingDoorFrame({
    symbolKey: 'AD', slot: JAMB, coord1: 200.3, coord2: 1000.3, faceMin: 1000, faceMax: 1025, wallThickness: 25,
    tSign: 1, faceWidth: 30, projection: FRAME_OVERHANG_MM,
  });
  assert.equal(r.error !== undefined && r.source === DetailFigureSource.DEFAULT, true);
});

test('R4: 開口幅 50（見付が 25 に頭打ち）は従来の描き（既定の図は見付 30 固定なので使わない）', () => {
  const op = opening({ coord2: 250.3, width: 50, centerCoord: 225.3 });
  assert.deepEqual(plan(op), plan({ ...op, detailRefs: GONE }));
  assert.equal(frames(plan(op))[0].points.length, 12, '従来の六角形（12 要素）');
});

test('R4: 半外付け（frameDepth>0 で見込帯が壁の面±出幅でない）は従来の描き', () => {
  const op = opening({ frameDepth: 50 });
  assert.deepEqual(plan(op), plan({ ...op, detailRefs: GONE }));
  assert.deepEqual(plan(op, { swapFaces: true }), plan({ ...op, detailRefs: GONE }, { swapFaces: true }));
});

test('片開き戸でない建具（subType が違う）は図を引かない（明示の割当てがあっても従来の描き）', () => {
  setOverlay(CatalogKind.DETAIL_FIGURE, { doc: [rectJamb('df-other-sub')] });
  const op = opening({ subType: 'swingIn', detailRefs: { [JAMB]: 'df-other-sub' } });
  assert.deepEqual(plan(op), plan({ ...op, detailRefs: GONE }));
});

test('面の座標が無い（faceLo/faceHi なし）は従来の描き', () => {
  const op = opening();
  const ctx = { entry: { mechanism: OpeningMechanism.SWING }, lodLevel: LodLevel.DETAIL, axisValue: 1000.3, exteriorDirOf: () => 1 };
  assert.deepEqual(buildOpeningPlanSymbol(op, ctx), buildOpeningPlanSymbol({ ...op, detailRefs: GONE }, ctx));
});

// ---- 明示の割当て・上書き ----

// 壁の面を 5 ずつ越えて包む単純な矩形の方立（既定の六角形とは形が違う）。
const strokeMoves = mid => [
  { dir: PenDir.RIGHT, len: { mm: 20, mode: DetailLenMode.FIXED } },
  { dir: PenDir.DOWN, len: { mm: 5, mode: DetailLenMode.FIXED } },
  ...mid,
  { dir: PenDir.DOWN, len: { mm: 5, mode: DetailLenMode.FIXED } },
  { dir: PenDir.LEFT, len: { mm: 20, mode: DetailLenMode.FIXED } },
];
const figureOf = (key, mid) => ({
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
  provenance: null, note: null,
});
const stretchMid = [{ dir: PenDir.DOWN, len: { mm: 50, mode: DetailLenMode.STRETCH } }];
const rectJamb = key => figureOf(key, stretchMid);
// 固定寸法が壁厚を超える（伸縮が負になる）ので fit できない図
const hugeJamb = key => figureOf(key, [{ dir: PenDir.DOWN, len: { mm: 500, mode: DetailLenMode.FIXED } }, ...stretchMid]);
// 明示の矩形（壁の面 1000〜1100 を 5 ずつ越える）の期待点列。along は開口端 200.3 から 20 の見付
const ALT_RECT = [200.3, 995, 200.3 + 20, 995, 200.3 + 20, 1105, 200.3, 1105];

test('明示の割当て（detailRefs）は別の形を描く（経路が生きている）。R4 を見ず壁の面へ fit する', () => {
  setOverlay(CatalogKind.DETAIL_FIGURE, { doc: [rectJamb('df-alt-rect')] });
  const op = opening({ detailRefs: { [JAMB]: 'df-alt-rect' } });
  const prims = frames(plan(op, { faceA: 1000, w: 100 }));
  assert.equal(prims.length, 2);
  assert.deepEqual(prims[0].points, ALT_RECT, '壁の面 1000〜1100 を 5 ずつ越える矩形');
  assert.notDeepEqual(prims, frames(plan({ ...op, detailRefs: GONE }, { faceA: 1000, w: 100 })));
  // 半外付けでも明示は壁の面へ fit する
  const semi = frames(plan({ ...op, frameDepth: 50 }, { faceA: 1000, w: 100 }));
  assert.deepEqual(semi[0].points, prims[0].points);
});

test('【失敗系】参照切れの明示の割当ては既定へ戻らず従来の描き。fit できない明示の図も従来の描き（resolveSwingDoorFrame は error・source=explicit）', () => {
  setOverlay(CatalogKind.DETAIL_FIGURE, { doc: [hugeJamb('df-alt-huge')] });
  const op = opening();
  const legacy = plan({ ...op, detailRefs: GONE });
  assert.deepEqual(plan({ ...op, detailRefs: { [JAMB]: 'df-alt-huge' } }), legacy);
  const r = resolveSwingDoorFrame({
    symbolKey: 'AD', detailRefs: { [JAMB]: 'df-alt-huge' }, slot: JAMB, coord1: 200.3, coord2: 1000.3,
    faceMin: 1000, faceMax: 1100, wallThickness: 100, tSign: 1, faceWidth: 30, projection: FRAME_OVERHANG_MM,
  });
  assert.equal(r.error !== undefined && r.source === DetailFigureSource.EXPLICIT, true);
  assert.equal(resolveSwingDoorFrame({
    symbolKey: 'AD', detailRefs: GONE, slot: JAMB, coord1: 0, coord2: 800, faceMin: 0, faceMax: 100, wallThickness: 100,
    tSign: 1, faceWidth: 30, projection: FRAME_OVERHANG_MM,
  }), null, '参照切れは null（従来の描き）');
});

test('組込みと同じキーのライブラリ・同梱の上書きが既定に効く。上書きが fit できなければ従来の描き', () => {
  setOverlay(CatalogKind.DETAIL_FIGURE, { doc: [rectJamb(DETAIL_BUILTIN_DOOR_JAMB_KEY)] });
  const op = opening();
  const overridden = frames(plan(op, { faceA: 1000, w: 100 }));
  assert.deepEqual(overridden[0].points, ALT_RECT, '上書きの形で描く');
  clearOverlays();
  setOverlay(CatalogKind.DETAIL_FIGURE, { doc: [hugeJamb(DETAIL_BUILTIN_DOOR_JAMB_KEY)] });
  assert.deepEqual(plan(op), plan({ ...op, detailRefs: GONE }), 'fit できない上書きは従来の描き');
});

// ---- 部品 ----

test('placeDetailSides: tSign=-1 は t が perp の減る向き（faceMax が t=0）。既定（+1）は従来どおり', () => {
  const fitted = { strokes: [{ id: 'a', closed: false, line: {}, points: [{ s: 0, t: -2 }, { s: 3, t: 0 }, { s: 3, t: 10 }] }] };
  const pos = placeDetailSides(fitted, { coord1: 100, coord2: 200, faceMin: 50, faceMax: 60 });
  assert.deepEqual(pos[0][0].points, [{ along: 100, perp: 48 }, { along: 103, perp: 50 }, { along: 103, perp: 60 }]);
  assert.deepEqual(pos[1][0].points.map(p => p.along), [200, 197, 197]);
  const neg = placeDetailSides(fitted, { coord1: 100, coord2: 200, faceMin: 50, faceMax: 60, tSign: -1 });
  assert.deepEqual(neg[0][0].points.map(p => p.perp), [62, 60, 50]);
});

test('withoutCollinearPoints: 一直線上の中間の頂点を除く。折り返し（スパイク）・開いたストロークの両端・閉じた輪郭の始点側は扱いを守る', () => {
  const pt = (along, perp) => ({ along, perp });
  const sq = [pt(0, 0), pt(10, 0), pt(10, 5), pt(10, 10), pt(0, 10)];
  assert.deepEqual(withoutCollinearPoints(sq, true), [pt(0, 0), pt(10, 0), pt(10, 10), pt(0, 10)]);
  assert.deepEqual(withoutCollinearPoints([pt(0, 0), pt(5, 0), pt(10, 0)], false), [pt(0, 0), pt(10, 0)]);
  assert.deepEqual(withoutCollinearPoints([pt(0, 0), pt(10, 0), pt(5, 0)], false), [pt(0, 0), pt(10, 0), pt(5, 0)], '折り返しは残す');
  // 閉じた輪郭は始点も判定する（始点が辺の途中にあれば除く）
  assert.deepEqual(withoutCollinearPoints([pt(5, 0), pt(10, 0), pt(10, 10), pt(0, 10), pt(0, 0)], true),
    [pt(10, 0), pt(10, 10), pt(0, 10), pt(0, 0)]);
  assert.deepEqual(withoutCollinearPoints([pt(0, 0), pt(10, 0)], true), [pt(0, 0), pt(10, 0)], '2 点以下はそのまま');
});
