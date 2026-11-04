// 窓の方立（平面・詳細 LOD）の組込み図（df-builtin-window-jamb-25／-open-25／-notched-25）が暗黙の既定（S8f-1）:
// 割当て無しの出力 ≡ 従来の方立（フォールバック。参照切れの明示の割当てで再現する）。
// 平面の記号には source を付けないので、プリミティブ列全体を deepEqual で比べる（openingBuiltinDoorFrame.test.js と同じ流儀）。
// 同値が成り立たない前提（R4 相当: 見付が全幅 25 でない・半外付け・開く向きが無い・壁が薄すぎて fit できない）は黙って従来の描きになる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clearOverlays, setOverlay } from '../catalog/catalogRegistry.js';
import { CatalogKind, kindDef } from '../catalog/catalogKinds.js';
import {
  PenDir, DetailLenMode, DetailCategory, DetailView, DetailSubject, DetailDatumRole, DetailDatumKind, DetailAxis, DetailDash,
  DetailSlot, DetailFigureSource, DETAIL_FIGURE_VERSION, FRAME_OVERHANG_MM, SWING_LEAF_SUBTYPE,
  DETAIL_BUILTIN_WINDOW_JAMB_KEY, DETAIL_BUILTIN_WINDOW_JAMB_OPEN_KEY, DETAIL_BUILTIN_WINDOW_JAMB_NOTCHED_KEY,
  DETAIL_BUILTIN_WINDOW_HEAD_KEY, DETAIL_BUILTIN_DOOR_JAMB_KEY, DETAIL_BUILTIN_DOOR_HEAD_KEY,
} from '../core/constants.js';
import { detailBuiltinFigures, fitLocal } from '../detail/detailPlacement.js';
import { LodLevel } from '../viewport.js';
import { OpeningMechanism, openingSubTypeBuiltinList } from './openingCatalog.js';
import { buildOpeningPlanSymbol } from './openingPlanSymbol.js';
import { detailFrameKindOf } from './openingPlanSymbolGeometry.js';
import { resolveSwingDoorFrame, frameDefaultKey } from './openingDetailFit.js';
import { detailFrameTargets } from './openingDetailFrame.js';

test.afterEach(() => clearOverlays());

const JAMB = DetailSlot.JAMB;
const GONE = { [JAMB]: 'df-gone' };

const list = openingSubTypeBuiltinList();
// 窓のうち引き違い窓（SLIDE_DOUBLE。R2 で対象外）を除いたもの
const WINDOWS = list.filter(e => e.category === 'window' && e.mechanism !== OpeningMechanism.SLIDE_DOUBLE);
const entryOf = (category, key) => list.find(e => e.category === category && e.key === key);
const CASEMENT = entryOf('window', 'casement'); // SWING（notched）
const FIXED = entryOf('window', 'fixed'); // sashOpen
const PIVOT = entryOf('window', 'pivot'); // sash
const KIND_ENTRIES = { notched: CASEMENT, sashOpen: FIXED, sash: PIVOT };
const KIND_KEYS = {
  notched: DETAIL_BUILTIN_WINDOW_JAMB_NOTCHED_KEY, sashOpen: DETAIL_BUILTIN_WINDOW_JAMB_OPEN_KEY, sash: DETAIL_BUILTIN_WINDOW_JAMB_KEY,
};

function opening(entry, over = {}) {
  return {
    category: entry.category, subType: entry.key,
    coord1: 200.3, coord2: 1000.3, centerCoord: 600.3, isVertical: false, width: 800,
    frameDepth: 0, lineWeight: 0.35, hingeSide: -1, swingSide: 1, ...over,
  };
}
// faceA は叩いた面（axisValue）、壁厚 w ぶん離れた面が faceB。faceLo/faceHi の大小どちらの順でも渡せる。
function plan(op, entry, { faceA = 1000.3, w = 102.3, swapFaces = false, exteriorDir = 1 } = {}) {
  const faceB = faceA + w;
  return buildOpeningPlanSymbol(op, {
    entry, lodLevel: LodLevel.DETAIL, axisValue: faceA,
    faceLo: swapFaces ? faceB : faceA, faceHi: swapFaces ? faceA : faceB, exteriorDirOf: () => exteriorDir,
  });
}
const frames = prims => prims.filter(p => p.role === 'frame');
const legacyOf = (op, entry, o) => plan({ ...op, detailRefs: GONE }, entry, o);

// ---- 同値（既定の組込み ≡ 従来の方立）----

test('組込み 3 図が供給されている。いずれも PAIRED/PLAN/JAMB で登録の検証を通り、プレビューの壁厚（100）で fit できる', () => {
  const def = kindDef(CatalogKind.DETAIL_FIGURE);
  const expectedPoints = {
    [DETAIL_BUILTIN_WINDOW_JAMB_NOTCHED_KEY]: 8, [DETAIL_BUILTIN_WINDOW_JAMB_KEY]: 6, [DETAIL_BUILTIN_WINDOW_JAMB_OPEN_KEY]: 6,
  };
  for (const [key, count] of Object.entries(expectedPoints)) {
    const fig = detailBuiltinFigures.find(e => e.key === key);
    assert.deepEqual([fig.category, fig.view, fig.subject], [DetailCategory.PAIRED, DetailView.PLAN, DetailSubject.JAMB]);
    assert.doesNotThrow(() => def.validate(fig), `${key} は登録の検証を通る`);
    const targets = detailFrameTargets(fig, { wallThickness: 100, faceWidth: 25, projection: FRAME_OVERHANG_MM });
    assert.equal(targets.error, undefined);
    const fitted = fitLocal(fig, targets.targets);
    assert.equal(fitted.error, undefined, `${key} は fit できる`);
    assert.equal(fitted.strokes[0].points.length, count);
  }
  // コの字だけ開いたストローク
  assert.equal(detailBuiltinFigures.find(e => e.key === DETAIL_BUILTIN_WINDOW_JAMB_OPEN_KEY).strokes[0].closed, false);
  // 既存の片開き戸 2 図は不変（キーが残っている）
  assert.ok(detailBuiltinFigures.some(e => e.key === DETAIL_BUILTIN_DOOR_JAMB_KEY));
  assert.ok(detailBuiltinFigures.some(e => e.key === DETAIL_BUILTIN_DOOR_HEAD_KEY));
});

test('暗黙の既定（割当て無し）≡ 従来の方立（引き違い窓を除く窓の全 subType × 開き勝手±1 × 吊元±1 × 縦横 × 壁厚 {60,115,102.3,137.7} × 面の座標 4 通り × 面の順）', () => {
  assert.ok(WINDOWS.length >= 20, `対象の窓が少なすぎる: ${WINDOWS.length}`);
  let cases = 0;
  for (const entry of WINDOWS) {
    for (const w of [60, 115, 102.3, 137.7]) {
      for (const faceA of [1000.3, 3.7, 5000.123, -2400.4]) {
        for (const isVertical of [false, true]) {
          for (const swingSide of [1, -1]) {
            for (const hingeSide of [1, -1]) {
              for (const swapFaces of [false, true]) {
                const op = opening(entry, { isVertical, swingSide, hingeSide });
                const dflt = plan(op, entry, { faceA, w, swapFaces });
                const legacy = legacyOf(op, entry, { faceA, w, swapFaces });
                assert.ok(frames(dflt).length >= 2, `${entry.key}: 方立 2 本以上`);
                assert.deepEqual(dflt, legacy, `${entry.key} w=${w} faceA=${faceA} vertical=${isVertical} swing=${swingSide} hinge=${hingeSide} swap=${swapFaces}`);
                cases += 1;
              }
            }
          }
        }
      }
    }
  }
  assert.equal(cases, WINDOWS.length * 4 * 4 * 2 * 2 * 2 * 2);
});

test('既定の経路は実際に図を通っている（3 種の方立それぞれ resolveSwingDoorFrame が source=default で 2 本返す。形は 6／4／6 点）', () => {
  const expectedPoints = { notched: 6, sashOpen: 4, sash: 4 };
  for (const [kind, entry] of Object.entries(KIND_ENTRIES)) {
    const key = frameDefaultKey(opening(entry), JAMB, entry.mechanism);
    assert.equal(key, KIND_KEYS[kind], kind);
    const r = resolveSwingDoorFrame({
      symbolKey: 'AD', slot: JAMB, coord1: 200.3, coord2: 1000.3, faceMin: 1000.3, faceMax: 1000.3 + 102.3, wallThickness: 102.3,
      tSign: 1, faceWidth: 25, projection: FRAME_OVERHANG_MM, defaultKey: key,
    });
    assert.equal(r.source, DetailFigureSource.DEFAULT, kind);
    assert.equal(r.profiles.length, 2, kind);
    assert.equal(r.profiles.every(p => p.points.length === expectedPoints[kind] && p.closed === (kind !== 'sashOpen')), true, `${kind}: 共線の頂点は除かれる`);
  }
});

test('出力の形は従来と同じ: sash＝rect・sashOpen＝closed を渡さない polyline（props に closed キーは undefined）・notched＝閉じた polyline。source は付けない', () => {
  const sash = frames(plan(opening(PIVOT), PIVOT));
  assert.deepEqual(sash.map(p => p.type), ['rect', 'rect']);
  const open = frames(plan(opening(FIXED), FIXED)).filter(p => p.type === 'polyline');
  assert.equal(open.length, 2);
  assert.equal(open.every(p => Object.hasOwn(p, 'closed') && p.closed === undefined), true);
  const notched = frames(plan(opening(CASEMENT), CASEMENT));
  assert.deepEqual(notched.map(p => [p.type, p.closed]), [['polyline', true], ['polyline', true]]);
  for (const entry of Object.values(KIND_ENTRIES)) {
    assert.equal(frames(plan(opening(entry), entry)).some(p => 'source' in p), false);
  }
});

// ---- 従来の描きへ戻る（R4 相当・fit 失敗・対象外）----

test('【失敗系】開口幅 40（見付が 20 に頭打ち）は 3 種とも従来の描き（既定の図は見付 25 固定なので使わない）', () => {
  for (const entry of Object.values(KIND_ENTRIES)) {
    const op = opening(entry, { coord2: 240.3, width: 40, centerCoord: 220.3 });
    assert.deepEqual(plan(op, entry), legacyOf(op, entry), entry.key);
  }
});

test('【失敗系】半外付け（frameDepth>0 で見込帯が壁の面±出幅でない）は 3 種とも従来の描き', () => {
  for (const entry of Object.values(KIND_ENTRIES)) {
    const op = opening(entry, { frameDepth: 50 });
    // 外部側が壁のどちら側かで、見込帯の寄る側（下側だけ・上側だけが面からずれる）が変わる
    for (const exteriorDir of [1, -1]) {
      assert.deepEqual(plan(op, entry, { exteriorDir }), legacyOf(op, entry, { exteriorDir }), `${entry.key} ext=${exteriorDir}`);
      assert.deepEqual(plan(op, entry, { swapFaces: true, exteriorDir }), legacyOf(op, entry, { swapFaces: true, exteriorDir }), `${entry.key} swap ext=${exteriorDir}`);
    }
  }
});

test('【失敗系】開く向きが無い（吊元 0 で swingOpenPerpDir が 0＝回転中心が叩いた面・欠き込みの向きは既定の +1）開き系は従来の描き。pivotPerp が開く側の面でないため既定を使わない', () => {
  for (const entry of [CASEMENT, entryOf('window', 'inswing')]) {
    for (const swapFaces of [false, true]) {
      const op = opening(entry, { hingeSide: 0 });
      assert.deepEqual(plan(op, entry, { swapFaces }), legacyOf(op, entry, { swapFaces }), `${entry.key} swap=${swapFaces}`);
    }
  }
});

test('【失敗系】壁が薄く fit できない（25mm）開き系は従来の描き。resolveSwingDoorFrame は error（source=default）', () => {
  const op = opening(CASEMENT);
  assert.deepEqual(plan(op, CASEMENT, { w: 25 }), legacyOf(op, CASEMENT, { w: 25 }));
  const r = resolveSwingDoorFrame({
    symbolKey: 'AD', slot: JAMB, coord1: 200.3, coord2: 1000.3, faceMin: 1000, faceMax: 1025, wallThickness: 25,
    tSign: 1, faceWidth: 25, projection: FRAME_OVERHANG_MM, defaultKey: DETAIL_BUILTIN_WINDOW_JAMB_NOTCHED_KEY,
  });
  assert.equal(r.error !== undefined && r.source === DetailFigureSource.DEFAULT, true);
});

test('面の座標が無い（faceLo/faceHi なし）は従来の描き', () => {
  for (const entry of Object.values(KIND_ENTRIES)) {
    const op = opening(entry);
    const ctx = { entry, lodLevel: LodLevel.DETAIL, axisValue: 1000.3, exteriorDirOf: () => 1 };
    assert.deepEqual(buildOpeningPlanSymbol(op, ctx), buildOpeningPlanSymbol({ ...op, detailRefs: GONE }, ctx), entry.key);
  }
});

// ---- 明示の割当て・上書き ----

// 壁の面を 5 ずつ越えて包む単純な矩形の方立（既定の図とは形が違う）。
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

test('明示の割当て（detailRefs）は別の形を描く（3 種とも）。R4 相当を見ず壁の面へ fit する（半外付けでも同じ）', () => {
  setOverlay(CatalogKind.DETAIL_FIGURE, { doc: [rectJamb('df-alt-rect')] });
  for (const entry of Object.values(KIND_ENTRIES)) {
    const op = opening(entry, { detailRefs: { [JAMB]: 'df-alt-rect' } });
    // 方立は枠のプリミティブの先頭 2 本（sashOpen は記号側の内法の枠矩形が続く）
    const prims = frames(plan(op, entry, { faceA: 1000, w: 100 })).slice(0, 2);
    assert.equal(prims.length, 2, entry.key);
    if (prims[0].type === 'rect') {
      assert.deepEqual([prims[0].x, prims[0].y, prims[0].w, prims[0].h], [200.3, 995, 20, 110], `${entry.key} rect`);
    } else {
      assert.deepEqual(prims[0].points, ALT_RECT, `${entry.key} polyline`);
    }
    assert.notDeepEqual(prims, frames(legacyOf(op, entry, { faceA: 1000, w: 100 })).slice(0, 2), entry.key);
    const semi = frames(plan({ ...op, frameDepth: 50 }, entry, { faceA: 1000, w: 100 })).slice(0, 2);
    assert.deepEqual(semi[0], prims[0], `${entry.key} 半外付けでも明示は壁の面へ fit`);
  }
});

test('【失敗系】参照切れの明示の割当ては既定へ戻らず従来の描き。fit できない明示の図も従来の描き（resolveSwingDoorFrame は error・source=explicit）', () => {
  setOverlay(CatalogKind.DETAIL_FIGURE, { doc: [hugeJamb('df-alt-huge')] });
  for (const entry of Object.values(KIND_ENTRIES)) {
    const op = opening(entry);
    const legacy = legacyOf(op, entry);
    assert.deepEqual(plan({ ...op, detailRefs: { [JAMB]: 'df-alt-huge' } }, entry), legacy, entry.key);
  }
  const common = { symbolKey: 'AD', slot: JAMB, coord1: 200.3, coord2: 1000.3, faceMin: 1000, faceMax: 1100, wallThickness: 100, tSign: 1, faceWidth: 25, projection: FRAME_OVERHANG_MM };
  const r = resolveSwingDoorFrame({ ...common, detailRefs: { [JAMB]: 'df-alt-huge' }, defaultKey: DETAIL_BUILTIN_WINDOW_JAMB_KEY });
  assert.equal(r.error !== undefined && r.source === DetailFigureSource.EXPLICIT, true);
  assert.equal(resolveSwingDoorFrame({ ...common, detailRefs: GONE, defaultKey: DETAIL_BUILTIN_WINDOW_JAMB_KEY }), null, '参照切れは null（従来の描き）');
});

test('組込みと同じキーのライブラリ・同梱の上書きが既定に効く（引き違い窓を除く窓の全 subType）。上書きが fit できなければ従来の描き', () => {
  const alt = { notched: 'df-alt-n', sashOpen: 'df-alt-o', sash: 'df-alt-s' };
  setOverlay(CatalogKind.DETAIL_FIGURE, {
    doc: Object.entries(KIND_KEYS).map(([kind, key]) => ({ ...rectJamb(key), label: alt[kind] })),
  });
  for (const entry of WINDOWS) {
    const op = opening(entry);
    const overridden = plan(op, entry, { faceA: 1000, w: 100 });
    assert.notDeepEqual(overridden, legacyOf(op, entry, { faceA: 1000, w: 100 }), `${entry.key}: 上書きの形で描く（既定の経路が全 subType で図を通る）`);
  }
  clearOverlays();
  setOverlay(CatalogKind.DETAIL_FIGURE, {
    doc: Object.values(KIND_KEYS).map(key => ({ ...hugeJamb(key), label: key })),
  });
  for (const entry of WINDOWS) {
    const op = opening(entry);
    assert.deepEqual(plan(op, entry), legacyOf(op, entry), `${entry.key}: fit できない上書きは従来の描き`);
  }
});

test('対象外: 引き違い窓（SLIDE_DOUBLE）は明示の割当てがあっても従来の描き。建具（category fitting）は同じ機構でも図を引かない', () => {
  setOverlay(CatalogKind.DETAIL_FIGURE, { doc: [rectJamb('df-alt-rect')] });
  const slide = entryOf('window', 'doubleSliding');
  const slideOp = opening(slide, { detailRefs: { [JAMB]: 'df-alt-rect' } });
  assert.deepEqual(plan(slideOp, slide), legacyOf(slideOp, slide));
  // 建具: 片開き戸（別経路）と三方枠を除く全 subType。明示の割当てを持っても不変
  const fittings = list.filter(e => e.category === 'fitting' && e.key !== SWING_LEAF_SUBTYPE && e.mechanism !== OpeningMechanism.FRAME_ONLY);
  assert.ok(fittings.length >= 10);
  const kinds = new Set();
  for (const entry of fittings) {
    const op = opening(entry, { detailRefs: { [JAMB]: 'df-alt-rect' } });
    assert.deepEqual(plan(op, entry), legacyOf(op, entry), entry.key);
    kinds.add(detailFrameKindOf(entry.mechanism));
  }
  assert.deepEqual([...kinds].sort(), ['notched', 'sash', 'sashOpen'], '建具でも 3 種の方立を確かめた');
});

test('frameDefaultKey: 片開き戸＝slot 別・窓の方立＝方立の種別別・それ以外は undefined', () => {
  const door = { category: 'fitting', subType: SWING_LEAF_SUBTYPE };
  assert.equal(frameDefaultKey(door, JAMB, OpeningMechanism.SWING), DETAIL_BUILTIN_DOOR_JAMB_KEY);
  assert.equal(frameDefaultKey(door, DetailSlot.HEAD, OpeningMechanism.SWING), DETAIL_BUILTIN_DOOR_HEAD_KEY);
  for (const [kind, entry] of Object.entries(KIND_ENTRIES)) {
    assert.equal(frameDefaultKey(opening(entry), JAMB, entry.mechanism), KIND_KEYS[kind], kind);
  }
  assert.equal(frameDefaultKey(opening(WINDOWS[0]), DetailSlot.HEAD, OpeningMechanism.FIXED), DETAIL_BUILTIN_WINDOW_HEAD_KEY, '窓の上枠（S8f-3b）');
  assert.equal(frameDefaultKey(opening(entryOf('window', 'doubleSliding')), JAMB, OpeningMechanism.SLIDE_DOUBLE), undefined, '引き違い窓');
  assert.equal(frameDefaultKey({ category: 'window', subType: 'x' }, JAMB, OpeningMechanism.FRAME_ONLY), undefined, '三方枠');
  assert.equal(frameDefaultKey({ category: 'window', subType: 'x' }, JAMB, undefined), undefined, '機構未指定の窓（種別の参照切れ）');
  assert.equal(frameDefaultKey({ category: 'window', subType: 'x' }, JAMB, 'noSuchMechanism'), undefined, '実装外の機構の窓');
  assert.equal(frameDefaultKey({ category: 'fitting', subType: 'swingIn' }, JAMB, OpeningMechanism.SWING_IN), undefined, '建具');
  assert.equal(frameDefaultKey({ subType: 'fixed' }, JAMB, OpeningMechanism.FIXED), undefined, 'category 欠落');
  assert.equal(frameDefaultKey(null, JAMB, OpeningMechanism.FIXED), undefined, 'opening なし');
});

test('detailFrameKindOf: 蝶番系＝notched・記号が枠矩形を描く非蝶番系＝sashOpen・それ以外＝sash', () => {
  assert.equal(detailFrameKindOf(OpeningMechanism.SWING), 'notched');
  assert.equal(detailFrameKindOf(OpeningMechanism.SWING_DOUBLE), 'notched');
  assert.equal(detailFrameKindOf(OpeningMechanism.FIXED), 'sashOpen');
  assert.equal(detailFrameKindOf(OpeningMechanism.FOLD), 'sash');
});
