// finish/stair/stairLineJoinPrimitives.js（階段レイヤの外周線・踏面線→L字結合primitives写像）の
// 回帰テスト。renderer/StairLayer.jsxのstrokeWidthはKonvaの親Groupのscaleを
// 継承する（strokeScaleEnabled既定true）ため、strokeWidth値は「世界mm相当」——resolveStair
// LinePointsMmは実pxへ換算してjoinを解決し、戻りのwidthを元のstrokeWidth値へ戻す（往復自体は
// renderer/planLineJoin.js の resolvePlanLinePointsMmScaledStroke へ委譲。2026-09移行）。統合テストは常に
// 非恒等（offset/scale≠1）のfakeViewportを使う（site/renderer側の既存方針と同じ）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  stairTreadKey, stairOutlineKey,
  buildStairJoinPrimitives, resolveStairLinePointsMm, stairLineRenderProps,
  stairDownviewDashPx,
} from './stairLineJoinPrimitives.js';
import { UPPER_VOID_DASH_PX } from '../../plan/planHoleMarks.js';
import { clipSegmentsBeyondBreak } from './beyondBreakClip.js';

const WEIGHTS = { thin: 1, medium: 2 };
const SCALE_X = 0.0378;

function fakeViewport(scaleX, scaleY = scaleX, offsetX = 37, offsetY = -52) {
  return {
    scaleX, scaleY, offsetX, offsetY,
    worldToScreen: (x, y) => ({ x: x * scaleX + offsetX, y: y * scaleY + offsetY }),
    screenToWorld: (x, y) => ({ x: (x - offsetX) / scaleX, y: (y - offsetY) / scaleY }),
  };
}

// ---- 写像（buildStairJoinPrimitives） ----

// 期待値はWEIGHTS/リテラルの2から直接計算する（SUTの関数を呼び直して比較すると、
// 太さ判定を壊す変異（例: 全部thin扱いにする）が素通りするトートロジーになる——team-lessons指摘）。
// widthは世界mm相当値。**線の太さの指定は実画面上の絶対太さ**（ユーザー確定2026-09）なので、
// どの段も「実px ÷ scaleX」になる——不具合2026-09: thin/mediumだけ実px値をそのまま返しており、
// 踏面線・外周線が1世界mm固定＝ズームで太さが変わっていた。
test('写像: 外周線の辺ごとの幅は描画幅（旧outlineWeight）と同じ供給源から出る', () => {
  const thinSeg = { x1: 0, y1: 0, x2: 100, y2: 0, thin: true };
  const mediumSeg = { x1: 0, y1: 0, x2: 100, y2: 0, medium: true };
  const heavySeg = { x1: 0, y1: 0, x2: 100, y2: 0 };
  const entries = [{ view: 'install', id: 's1', outlineSegs: [thinSeg, mediumSeg, heavySeg], isDownView: false }];
  const prims = buildStairJoinPrimitives(entries, SCALE_X, WEIGHTS);
  assert.ok(Math.abs(prims[0].width - WEIGHTS.thin / SCALE_X) < 1e-9, 'thin(実1px相当)');
  assert.ok(Math.abs(prims[1].width - WEIGHTS.medium / SCALE_X) < 1e-9, 'medium(実2px相当)');
  assert.ok(Math.abs(prims[2].width - 2 / SCALE_X) < 1e-9, 'heavy(実2px相当)');
});

test('写像: 踏面線の幅は描画幅（旧treads三項演算）と同じ供給源から出る', () => {
  const thinSeg = { x1: 0, y1: 0, x2: 100, y2: 0 };
  const heavySeg = { x1: 0, y1: 0, x2: 100, y2: 0, heavy: true };
  const entries = [{ view: 'install', id: 's1', treadSegs: [thinSeg, heavySeg], isDownView: false }];
  const prims = buildStairJoinPrimitives(entries, SCALE_X, WEIGHTS);
  assert.ok(Math.abs(prims[0].width - WEIGHTS.thin / SCALE_X) < 1e-9, 'thin(既定・実1px相当)');
  assert.ok(Math.abs(prims[1].width - 2 / SCALE_X) < 1e-9, 'heavy(実2px相当)');
});

test('写像: 見下げ(isDownView)の踏面線・外周線は実線（dash無し）の細線になる（裁定2026-10-06 Q6）', () => {
  const heavyTread = { x1: 0, y1: 0, x2: 100, y2: 0, heavy: true };
  const plainOutline = { x1: 0, y1: 0, x2: 100, y2: 0 }; // タグ無し＝通常は実2px
  const mediumOutline = { x1: 0, y1: 0, x2: 100, y2: 0, medium: true }; // floorEdge でなければ中線も細線へ
  const entries = [{ view: 'upper', id: 's1', treadSegs: [heavyTread], outlineSegs: [plainOutline, mediumOutline], isDownView: true }];
  const prims = buildStairJoinPrimitives(entries, SCALE_X, WEIGHTS);
  for (const p of prims) {
    assert.equal(p.dash, undefined, '見下げは実線');
    assert.ok(Math.abs(p.width - WEIGHTS.thin / SCALE_X) < 1e-9, '細線(実1px相当)');
  }
});

test('写像: 見下げでも s.dashed（到達辺等）はdash扱いのまま、isDownView無しの同じ線は従来の太さ', () => {
  const dashed = { x1: 0, y1: 0, x2: 100, y2: 0, dashed: true };
  const plain = { x1: 0, y1: 0, x2: 100, y2: 0 };
  const down = buildStairJoinPrimitives([{ view: 'upper', id: 's1', outlineSegs: [dashed], isDownView: true }], SCALE_X, WEIGHTS);
  assert.ok(down[0].dash);
  const up = buildStairJoinPrimitives([{ view: 'install', id: 's1', outlineSegs: [plain], isDownView: false }], SCALE_X, WEIGHTS);
  assert.ok(Math.abs(up[0].width - 2 / SCALE_X) < 1e-9, '非見下げのタグ無し外周線は実2px相当のまま');
});

test('写像: s.dashed（到達辺等）はisDownViewでなくてもdash扱いになる', () => {
  const seg = { x1: 0, y1: 0, x2: 100, y2: 0, dashed: true };
  const entries = [{ view: 'install', id: 's1', outlineSegs: [seg], isDownView: false }];
  const prims = buildStairJoinPrimitives(entries, SCALE_X, WEIGHTS);
  assert.ok(prims[0].dash);
});

test('写像: クリップ後の線分列をそのまま受ける（座標をそのまま転記するだけ・再計算しない）', () => {
  const clipped = { x1: 12.3, y1: 45.6, x2: 78.9, y2: 10.1 };
  const entries = [{ view: 'install', id: 's1', outlineSegs: [clipped], isDownView: false }];
  const prims = buildStairJoinPrimitives(entries, SCALE_X, WEIGHTS);
  assert.equal(prims[0].x1, 12.3); assert.equal(prims[0].y1, 45.6);
  assert.equal(prims[0].x2, 78.9); assert.equal(prims[0].y2, 10.1);
});

test('写像: キーはstairTreadKey/stairOutlineKeyと一致し、view/id/indexごとに一意', () => {
  const seg = { x1: 0, y1: 0, x2: 100, y2: 0 };
  const entries = [{ view: 'install', id: 's1', treadSegs: [seg, seg], outlineSegs: [seg], isDownView: false }];
  const prims = buildStairJoinPrimitives(entries, SCALE_X, WEIGHTS);
  assert.equal(prims[0].key, stairTreadKey('install', 's1', 0));
  assert.equal(prims[1].key, stairTreadKey('install', 's1', 1));
  assert.equal(prims[2].key, stairOutlineKey('install', 's1', 0));
});

// ---- 統合（resolveStairLinePointsMm。非恒等fakeViewport） ----

test('統合: 外周の直交角（medium×medium）が閉じる', () => {
  // 太さは実px固定（medium=2px）になったので、どのズームでもTHIN_PX=1を上回り角が閉じる。
  // 非恒等（scale≠1）の要件を満たすscaleで検証する。
  const zoomedScale = 2.6;
  const a = { x1: 0, y1: 0, x2: 100, y2: 0, medium: true };
  const b = { x1: 100, y1: 0, x2: 100, y2: 100, medium: true };
  const entries = [{ view: 'install', id: 's1', outlineSegs: [a, b], isDownView: false }];
  const resolved = resolveStairLinePointsMm(entries, fakeViewport(zoomedScale), WEIGHTS);
  const [, , ax2, ay2] = resolved.get(stairOutlineKey('install', 's1', 0)).points;
  assert.ok(Math.abs(ax2 - 100) > 1e-6, '外側へ延びるはず');
  assert.ok(Math.abs(ay2 - 0) < 1e-6);
  // widthはscaleXで割り戻され、元のstrokeWidth値（lineWeightsPx.medium）と一致する（strokeWidthは不変）。
  assert.equal(resolved.get(stairOutlineKey('install', 's1', 0)).width, WEIGHTS.medium / zoomedScale);
});

test('統合: 踏面線(thin)×外周線(medium)の角は両方延長する', () => {
  // medium=2px（実px固定）がTHIN_PX=1を上回るため、ズームに関わらず両方が延長される。
  const zoomedScale = 2.6;
  const tread = { x1: 0, y1: 0, x2: 100, y2: 0 }; // thin(既定)
  const outline = { x1: 100, y1: 0, x2: 100, y2: 100, medium: true };
  const entries = [{ view: 'install', id: 's1', treadSegs: [tread], outlineSegs: [outline], isDownView: false }];
  const resolved = resolveStairLinePointsMm(entries, fakeViewport(zoomedScale), WEIGHTS);
  const [, , tx2] = resolved.get(stairTreadKey('install', 's1', 0)).points;
  const [, oy1] = resolved.get(stairOutlineKey('install', 's1', 0)).points;
  assert.ok(Math.abs(tx2 - 100) > 1e-6, '踏面線側も延長される');
  assert.ok(Math.abs(oy1 - 0) > 1e-6, '外周線側も延長される');
});

test('統合: thin(踏面)×thin(外周)は延長しない', () => {
  const tread = { x1: 0, y1: 0, x2: 100, y2: 0 };
  const outline = { x1: 100, y1: 0, x2: 100, y2: 100, thin: true };
  const entries = [{ view: 'install', id: 's1', treadSegs: [tread], outlineSegs: [outline], isDownView: false }];
  const resolved = resolveStairLinePointsMm(entries, fakeViewport(SCALE_X), WEIGHTS);
  const [, , tx2, ty2] = resolved.get(stairTreadKey('install', 's1', 0)).points;
  assert.ok(Math.abs(tx2 - 100) < 1e-6);
  assert.ok(Math.abs(ty2 - 0) < 1e-6);
});

test('統合: 見下げ（破れ線から先）の細線同士は延長せず、切られた端は不変', () => {
  // 見下げは実線の細線（thin 同士は延長ゼロ）。見下げの外周線は dash 扱いでなくL字結合の対象になったが、
  // 細線同士なら座標は動かない。
  const outline = { x1: 100, y1: 0, x2: 100, y2: 100 };
  const partnerAtOtherEnd = { x1: 100, y1: 100, x2: 200, y2: 100 };
  const entries = [{ view: 'upper', id: 's1', outlineSegs: [outline, partnerAtOtherEnd], isDownView: true }];
  const resolved = resolveStairLinePointsMm(entries, fakeViewport(SCALE_X), WEIGHTS);
  const [x1, y1, x2, y2] = resolved.get(stairOutlineKey('upper', 's1', 0)).points;
  assert.ok(Math.abs(x1 - 100) < 1e-6); assert.ok(Math.abs(y1 - 0) < 1e-6);
  assert.ok(Math.abs(x2 - 100) < 1e-6); assert.ok(Math.abs(y2 - 100) < 1e-6);
});

test('統合: 3本集合の頂点は不変', () => {
  // heavy（無フラグ）にする理由は上記と同じ（QA指摘）。
  const a = { x1: 0, y1: 0, x2: 100, y2: 0 };
  const b = { x1: 100, y1: 0, x2: 100, y2: 100 };
  const c = { x1: 100, y1: 0, x2: 200, y2: 0 };
  const entries = [{ view: 'install', id: 's1', outlineSegs: [a, b, c], isDownView: false }];
  const resolved = resolveStairLinePointsMm(entries, fakeViewport(SCALE_X), WEIGHTS);
  for (const [i, s] of [a, b, c].entries()) {
    const [x1, y1, x2, y2] = resolved.get(stairOutlineKey('install', 's1', i)).points;
    assert.ok(Math.abs(x1 - s.x1) < 1e-6); assert.ok(Math.abs(y1 - s.y1) < 1e-6);
    assert.ok(Math.abs(x2 - s.x2) < 1e-6); assert.ok(Math.abs(y2 - s.y2) < 1e-6);
  }
});

test('統合: ズーム非依存——heavy外周線同士の直交角は、延長が常に実1.0px（scale∈{0.0378,0.001,2.6}）', () => {
  // heavy（無フラグ）にする理由は上記と同じ（QA指摘）。90°・wA=wB=2pxの式どおり
  // dA = (wB/2)/sin(90°) + (wA/2)*cot(90°) = 1 + 0 = 1.0pxに固定できる。
  const a = { x1: 0, y1: 0, x2: 100, y2: 0 };
  const b = { x1: 100, y1: 0, x2: 100, y2: 100 };
  const entries = [{ view: 'install', id: 's1', outlineSegs: [a, b], isDownView: false }];
  const extAt = (scale) => {
    const resolved = resolveStairLinePointsMm(entries, fakeViewport(scale), WEIGHTS);
    const [, , ax2] = resolved.get(stairOutlineKey('install', 's1', 0)).points;
    return (ax2 - 100) * scale;
  };
  for (const scale of [0.0378, 0.001, 2.6]) {
    const ext = extAt(scale);
    assert.ok(Math.abs(ext - 1.0) < 1e-9, `scale=${scale}: 期待1.0px, 実際${ext}`);
  }
});

test('統合: 既定ズーム1/100でheavy外周線同士の直交角が実1px閉じ、width===2/0.0378', () => {
  const a = { x1: 0, y1: 0, x2: 100, y2: 0 };
  const b = { x1: 100, y1: 0, x2: 100, y2: 100 };
  const entries = [{ view: 'install', id: 's1', outlineSegs: [a, b], isDownView: false }];
  const resolved = resolveStairLinePointsMm(entries, fakeViewport(SCALE_X), WEIGHTS);
  const [, , ax2, ay2] = resolved.get(stairOutlineKey('install', 's1', 0)).points;
  assert.ok(Math.abs((ax2 - 100) * SCALE_X - 1.0) < 1e-9, `実1px相当のはず（実際:${(ax2 - 100) * SCALE_X}px）`);
  assert.ok(Math.abs(ay2 - 0) < 1e-6);
  assert.equal(resolved.get(stairOutlineKey('install', 's1', 0)).width, 2 / SCALE_X);
  assert.equal(resolved.get(stairOutlineKey('install', 's1', 1)).width, 2 / SCALE_X);
});

test('L字結合はエントリ単位——別々の階段の端点が偶然一致しても互いに影響しない', () => {
  // s1のoutline[0]終点(100,0)とs2のoutline[0]始点(100,0)が一致するが、別entryなので
  // 「ちょうど2本の角」としては結合されない（entries配列へ両方混ぜても、同一entry内でしか
  // 結合しない設計＝変更前の描画単位「エントリごとにJSX化」と同じ範囲）。
  const s1Outline = { x1: 0, y1: 0, x2: 100, y2: 0 }; // heavy
  const s2Outline = { x1: 100, y1: 0, x2: 100, y2: 100 }; // heavy。s1と直交・端点一致
  const entries = [
    { view: 'install', id: 's1', outlineSegs: [s1Outline], isDownView: false },
    { view: 'install', id: 's2', outlineSegs: [s2Outline], isDownView: false },
  ];
  const resolved = resolveStairLinePointsMm(entries, fakeViewport(SCALE_X), WEIGHTS);
  const [x1a, y1a, x2a, y2a] = resolved.get(stairOutlineKey('install', 's1', 0)).points;
  const [x1b, y1b, x2b, y2b] = resolved.get(stairOutlineKey('install', 's2', 0)).points;
  assert.ok(Math.abs(x1a - 0) < 1e-6); assert.ok(Math.abs(y1a - 0) < 1e-6);
  assert.ok(Math.abs(x2a - 100) < 1e-6, 's1は延長されない'); assert.ok(Math.abs(y2a - 0) < 1e-6);
  assert.ok(Math.abs(x1b - 100) < 1e-6, 's2は延長されない'); assert.ok(Math.abs(y1b - 0) < 1e-6);
  assert.ok(Math.abs(x2b - 100) < 1e-6); assert.ok(Math.abs(y2b - 100) < 1e-6);
});

// ---- 最終出力（stairLineRenderProps。StairLayer.jsxが<Line>へ直接渡すprops） ----

test('stairLineRenderProps: heavy外周線同士の直交角のpoints/strokeWidth/dashが最終出力レベルで固定される', () => {
  const a = { x1: 0, y1: 0, x2: 100, y2: 0 };
  const b = { x1: 100, y1: 0, x2: 100, y2: 100 };
  const entry = { view: 'install', id: 's1', outlineSegs: [a, b], isDownView: false };
  const { outline } = stairLineRenderProps(entry, fakeViewport(SCALE_X), WEIGHTS);
  assert.equal(outline.length, 2);
  assert.equal(outline[0].key, stairOutlineKey('install', 's1', 0));
  const [, , ax2, ay2] = outline[0].points;
  assert.ok(Math.abs((ax2 - 100) * SCALE_X - 1.0) < 1e-9, '実1px延長');
  assert.ok(Math.abs(ay2 - 0) < 1e-6);
  assert.equal(outline[0].strokeWidth, 2 / SCALE_X);
  assert.equal(outline[0].dash, undefined, '非isDownView・非s.dashedはdash無し');
});

// QA指摘: treads側の最終pointsを固定する（outline側だけだと、treads側でjoinの結果を捨てて
// 生座標を返す変異が素通りする）。
test('stairLineRenderProps: heavy踏面線×heavy外周線の角で treads側のpointsも実1px延長される', () => {
  const tread = { x1: 0, y1: 0, x2: 100, y2: 0, heavy: true };
  const outlineSeg = { x1: 100, y1: 0, x2: 100, y2: 100 };
  const entry = { view: 'install', id: 's1', treadSegs: [tread], outlineSegs: [outlineSeg], isDownView: false };
  const { treads, outline } = stairLineRenderProps(entry, fakeViewport(SCALE_X), WEIGHTS);
  assert.equal(treads.length, 1);
  assert.equal(treads[0].key, stairTreadKey('install', 's1', 0));
  const [, , tx2, ty2] = treads[0].points;
  assert.ok(Math.abs((tx2 - 100) * SCALE_X - 1.0) < 1e-9, `踏面線は相手半幅ぶん実1px延長（実際:${(tx2 - 100) * SCALE_X}px）`);
  assert.ok(Math.abs(ty2 - 0) < 1e-6);
  assert.equal(treads[0].strokeWidth, 2 / SCALE_X);
  const [, oy1] = outline[0].points;
  assert.ok(Math.abs(oy1 * SCALE_X - (-1.0)) < 1e-9, `外周線側も実1px延長（角の外側＝y負方向。実際:${oy1 * SCALE_X}px）`);
});

test('stairLineRenderProps: isDownViewの踏面線・外周線は実線の細線（dash無し・strokeWidth=thin）', () => {
  const tread = { x1: 0, y1: 0, x2: 100, y2: 0, heavy: true };
  const outlineSeg = { x1: 0, y1: 0, x2: 100, y2: 0 };
  const entry = { view: 'upper', id: 's1', treadSegs: [tread], outlineSegs: [outlineSeg], isDownView: true };
  const { treads, outline } = stairLineRenderProps(entry, fakeViewport(SCALE_X), WEIGHTS);
  assert.equal(treads[0].dash, undefined);
  assert.equal(outline[0].dash, undefined);
  assert.equal(treads[0].strokeWidth, WEIGHTS.thin / SCALE_X);
  assert.equal(outline[0].strokeWidth, WEIGHTS.thin / SCALE_X);
});

// 自階に階段が無い階（STAIR_VOID だけの階）の upper エントリは installOverlap が付かず isDownView:false。
// それでも「下階の階段を自階で見るエントリ」なので細線の実線（床の端だけ中線）。
test('見下げ（view=upper・isDownView:false）も踏面線・外周線は細線の実線、floorEdge は中線の実線、install は従来どおり', () => {
  const tread = { x1: 0, y1: 0, x2: 100, y2: 0, heavy: true };
  const plain = { x1: 0, y1: 0, x2: 100, y2: 0 };
  const edge = { x1: 0, y1: 50, x2: 100, y2: 50, medium: true, floorEdge: true };
  const up = buildStairJoinPrimitives([{ view: 'upper', id: 's1', treadSegs: [tread], outlineSegs: [plain, edge], isDownView: false }], SCALE_X, WEIGHTS);
  assert.ok(Math.abs(up[0].width - WEIGHTS.thin / SCALE_X) < 1e-9, '踏面線は細線');
  assert.ok(Math.abs(up[1].width - WEIGHTS.thin / SCALE_X) < 1e-9, 'タグ無し外周線は細線');
  assert.ok(Math.abs(up[2].width - WEIGHTS.medium / SCALE_X) < 1e-9, '床の端は中線');
  assert.ok(up.every(p => p.dash === undefined), '全部実線');
  const inst = buildStairJoinPrimitives([{ view: 'install', id: 's1', treadSegs: [tread], outlineSegs: [plain], isDownView: false }], SCALE_X, WEIGHTS);
  assert.ok(Math.abs(inst[0].width - 2 / SCALE_X) < 1e-9, 'install の heavy 踏面線は不変');
  assert.ok(Math.abs(inst[1].width - 2 / SCALE_X) < 1e-9, 'install のタグ無し外周線は不変');
});

test('見下げの floorEdge（中線）×細線の外周線の直交角は両方延長し、細線同士は延長しない', () => {
  const edge = { x1: 100, y1: 0, x2: 100, y2: 100, medium: true, floorEdge: true };
  const thin = { x1: 100, y1: 100, x2: 200, y2: 100 };
  const { outline } = stairLineRenderProps(
    { view: 'upper', id: 's1', outlineSegs: [edge, thin], isDownView: true }, fakeViewport(SCALE_X), { thin: 1, medium: 2 });
  const [, , , ey2] = outline[0].points; // floorEdge の終点（角）
  const [tx1] = outline[1].points;       // 細線の始点（角）
  assert.ok(Math.abs((ey2 - 100) * SCALE_X - 0.5) < 1e-9, `floorEdge 側は相手(細1px)の半幅0.5px延びる（実際:${(ey2 - 100) * SCALE_X}px）`);
  assert.ok(Math.abs((100 - tx1) * SCALE_X - 1.0) < 1e-9, `細線側は相手(中2px)の半幅1px延びる（実際:${(100 - tx1) * SCALE_X}px）`);
  const t1 = { x1: 100, y1: 0, x2: 100, y2: 100 };
  const both = stairLineRenderProps({ view: 'upper', id: 's2', outlineSegs: [t1, thin], isDownView: true }, fakeViewport(SCALE_X), { thin: 1, medium: 2 });
  assert.ok(Math.abs(both.outline[0].points[3] - 100) < 1e-9, '細線同士は延長しない');
  assert.ok(Math.abs(both.outline[1].points[0] - 100) < 1e-9, '細線同士は延長しない');
});

test('stairLineRenderProps: s.dashed（到達辺等）はisDownViewでなくても外周線dashに[40,30]相当が入る', () => {
  const outlineSeg = { x1: 0, y1: 0, x2: 100, y2: 0, dashed: true };
  const entry = { view: 'install', id: 's1', outlineSegs: [outlineSeg], isDownView: false };
  const { outline } = stairLineRenderProps(entry, fakeViewport(SCALE_X), WEIGHTS);
  assert.deepEqual(outline[0].dash, [40 / SCALE_X, 30 / SCALE_X]);
});

// ---- 床の端（floorEdge）: 見下げでも実線・中線のまま ----

test('写像: isDownViewの floorEdge の外周線は実線・中線、タグ無しの外周線と踏面線は実線・細線', () => {
  const seg = { x1: 0, y1: 0, x2: 100, y2: 0 };
  const edge = { x1: 0, y1: 50, x2: 100, y2: 50, medium: true, floorEdge: true };
  const entries = [{ view: 'upper', id: 's1', treadSegs: [seg], outlineSegs: [edge, seg], isDownView: true }];
  const prims = buildStairJoinPrimitives(entries, SCALE_X, WEIGHTS);
  assert.equal(prims[0].dash, undefined);
  assert.ok(Math.abs(prims[0].width - WEIGHTS.thin / SCALE_X) < 1e-9, '踏面線は細線');
  assert.equal(prims[1].dash, undefined, '床の端は実線');
  assert.ok(Math.abs(prims[1].width - WEIGHTS.medium / SCALE_X) < 1e-9, '床の端は中線');
  assert.equal(prims[2].dash, undefined);
  assert.ok(Math.abs(prims[2].width - WEIGHTS.thin / SCALE_X) < 1e-9, 'タグ無し外周線は細線');
});

test('stairLineRenderProps: isDownViewの floorEdge は実線・中線、タグ無し外周線・踏面線は実線・細線（dashはどれも無し）', () => {
  const seg = { x1: 0, y1: 0, x2: 100, y2: 0 };
  const edge = { x1: 0, y1: 50, x2: 100, y2: 50, medium: true, floorEdge: true };
  const entry = { view: 'upper', id: 's1', treadSegs: [seg], outlineSegs: [edge, seg], isDownView: true };
  const { treads, outline } = stairLineRenderProps(entry, fakeViewport(SCALE_X), WEIGHTS);
  assert.equal(outline[0].dash, undefined, '床の端は実線');
  assert.equal(outline[0].strokeWidth, WEIGHTS.medium / SCALE_X);
  assert.equal(outline[1].dash, undefined);
  assert.equal(outline[1].strokeWidth, WEIGHTS.thin / SCALE_X);
  assert.equal(treads[0].dash, undefined);
});

test('stairLineRenderProps: floorEdge でも s.dashed（到達辺等）は破線のまま', () => {
  const s = { x1: 0, y1: 0, x2: 100, y2: 0, floorEdge: true, dashed: true };
  const { outline } = stairLineRenderProps({ view: 'upper', id: 's1', outlineSegs: [s], isDownView: true }, fakeViewport(SCALE_X), WEIGHTS);
  assert.deepEqual(outline[0].dash, [40 / SCALE_X, 30 / SCALE_X]);
});

// StairLayer の実経路: 見下げの外周線は clipSegmentsBeyondBreak を通ってから stairLineRenderProps へ渡る。
test('stairLineRenderProps: 破れ線で切られた後も floorEdge の外周線は実線（クリップがタグを落とさない）', () => {
  const edge = { x1: 50, y1: 0, x2: 50, y2: 200, medium: true, side: true, floorEdge: true };
  const breakLine = [{ x1: 0, y1: 100, x2: 100, y2: 100 }];
  const beyond = [{ x1: 0, y1: 100, x2: 100, y2: 200 }];
  const clipped = clipSegmentsBeyondBreak([edge], breakLine, beyond);
  assert.equal(clipped.length, 1);
  assert.deepEqual([clipped[0].y1, clipped[0].y2], [100, 200], '破れ先だけが残る');
  const { outline } = stairLineRenderProps({ view: 'upper', id: 's1', outlineSegs: clipped, isDownView: true }, fakeViewport(SCALE_X), WEIGHTS);
  assert.equal(outline[0].dash, undefined);
});

// ---- 失敗系 ----

test('失敗系: entriesが空 → 空Map', () => {
  assert.equal(resolveStairLinePointsMm([], fakeViewport(SCALE_X), WEIGHTS).size, 0);
});

test('失敗系: treadSegs/outlineSegs未指定のentry → 例外にならず空Map', () => {
  const resolved = resolveStairLinePointsMm([{ view: 'install', id: 's1', isDownView: false }], fakeViewport(SCALE_X), WEIGHTS);
  assert.equal(resolved.size, 0);
});

test('失敗系: lineWeightsPxに該当キーなし → 例外にならず座標不変（既定1px相当・thin同士扱いで延長しない）', () => {
  const a = { x1: 0, y1: 0, x2: 100, y2: 0, thin: true };
  const b = { x1: 100, y1: 0, x2: 100, y2: 100, thin: true };
  const entries = [{ view: 'install', id: 's1', outlineSegs: [a, b], isDownView: false }];
  assert.doesNotThrow(() => {
    const resolved = resolveStairLinePointsMm(entries, fakeViewport(SCALE_X), {});
    const [, , ax2] = resolved.get(stairOutlineKey('install', 's1', 0)).points;
    assert.ok(Math.abs(ax2 - 100) < 1e-6);
  });
});

test('失敗系: 長さ0の線分 → 座標不変', () => {
  const zero = { x1: 50, y1: 50, x2: 50, y2: 50, medium: true };
  const entries = [{ view: 'install', id: 's1', outlineSegs: [zero], isDownView: false }];
  const resolved = resolveStairLinePointsMm(entries, fakeViewport(SCALE_X), WEIGHTS);
  const [x1, y1, x2, y2] = resolved.get(stairOutlineKey('install', 's1', 0)).points;
  assert.ok(Math.abs(x1 - 50) < 1e-6); assert.ok(Math.abs(y1 - 50) < 1e-6);
  assert.ok(Math.abs(x2 - 50) < 1e-6); assert.ok(Math.abs(y2 - 50) < 1e-6);
});

test('階段の破れ先（上り部分）の破線は「上部吹抜け」（UPPER_VOID_DASH_PX）と同じ書式を参照する', () => {
  const scaleX = 0.25;
  const expected = UPPER_VOID_DASH_PX.map(w => w / scaleX);
  assert.deepEqual(stairDownviewDashPx(scaleX), expected); // 破れ先＝上り部分の外周線（beyondLines）
});
