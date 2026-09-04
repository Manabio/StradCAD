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
} from './stairLineJoinPrimitives.js';

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
// widthは世界mm相当値（実px化はresolvePlanLinePointsMmScaledStroke委譲後、2026-09移行）——
// heavy(px2)は実2px相当を世界mm相当で表すため2/SCALE_Xになる（scale依存）。
test('写像: 外周線の辺ごとの幅は描画幅（旧outlineWeight）と同じ供給源から出る', () => {
  const thinSeg = { x1: 0, y1: 0, x2: 100, y2: 0, thin: true };
  const mediumSeg = { x1: 0, y1: 0, x2: 100, y2: 0, medium: true };
  const heavySeg = { x1: 0, y1: 0, x2: 100, y2: 0 };
  const entries = [{ view: 'install', id: 's1', outlineSegs: [thinSeg, mediumSeg, heavySeg], isDownView: false }];
  const prims = buildStairJoinPrimitives(entries, SCALE_X, WEIGHTS);
  assert.ok(Math.abs(prims[0].width - WEIGHTS.thin) < 1e-9, 'thin');
  assert.ok(Math.abs(prims[1].width - WEIGHTS.medium) < 1e-9, 'medium');
  assert.ok(Math.abs(prims[2].width - 2 / SCALE_X) < 1e-9, 'heavy(px2)は常に実2px相当（世界mm相当では2/SCALE_X）');
});

test('写像: 踏面線の幅は描画幅（旧treads三項演算）と同じ供給源から出る', () => {
  const thinSeg = { x1: 0, y1: 0, x2: 100, y2: 0 };
  const heavySeg = { x1: 0, y1: 0, x2: 100, y2: 0, heavy: true };
  const entries = [{ view: 'install', id: 's1', treadSegs: [thinSeg, heavySeg], isDownView: false }];
  const prims = buildStairJoinPrimitives(entries, SCALE_X, WEIGHTS);
  assert.ok(Math.abs(prims[0].width - WEIGHTS.thin) < 1e-9, 'thin(既定)');
  assert.ok(Math.abs(prims[1].width - 2 / SCALE_X) < 1e-9, 'heavy(px2)は常に実2px相当（世界mm相当では2/SCALE_X）');
});

test('写像: 見下げ(isDownView)の踏面線・外周線はdash扱いになる（対象外の唯一の情報源）', () => {
  const seg = { x1: 0, y1: 0, x2: 100, y2: 0 };
  const entries = [{ view: 'upper', id: 's1', treadSegs: [seg], outlineSegs: [seg], isDownView: true }];
  const prims = buildStairJoinPrimitives(entries, SCALE_X, WEIGHTS);
  assert.ok(prims[0].dash, '踏面線はdash扱い');
  assert.ok(prims[1].dash, '外周線もdash扱い');
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
  // medium(=lineWeightsPx.medium=2)がTHIN_PX=1を実px換算で上回るよう、ズームしたscaleを使う
  // （非恒等の要件は満たしたまま。SCALE_Xの既定=0.0378だとmedium*scaleX<1で「両方thin」判定になる）。
  const zoomedScale = 2.6;
  const a = { x1: 0, y1: 0, x2: 100, y2: 0, medium: true };
  const b = { x1: 100, y1: 0, x2: 100, y2: 100, medium: true };
  const entries = [{ view: 'install', id: 's1', outlineSegs: [a, b], isDownView: false }];
  const resolved = resolveStairLinePointsMm(entries, fakeViewport(zoomedScale), WEIGHTS);
  const [, , ax2, ay2] = resolved.get(stairOutlineKey('install', 's1', 0)).points;
  assert.ok(Math.abs(ax2 - 100) > 1e-6, '外側へ延びるはず');
  assert.ok(Math.abs(ay2 - 0) < 1e-6);
  // widthはscaleXで割り戻され、元のstrokeWidth値（lineWeightsPx.medium）と一致する（strokeWidthは不変）。
  assert.equal(resolved.get(stairOutlineKey('install', 's1', 0)).width, WEIGHTS.medium);
});

test('統合: 踏面線(thin)×外周線(medium)の角は両方延長する', () => {
  // strokeWidthはKonvaの親Groupのscaleを継承する世界mm相当値のため、実pxしきい値(THIN_PX=1)を
  // 跨がせるにはズームした（scaleXが大きい）viewportで検証する必要がある（非恒等の要件は満たす）。
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

test('統合: 見下げ（破れ線から先）で切られた端は不変', () => {
  // heavy（medium:trueではなく無フラグ=px(2)/実2px）にする——medium(=lineWeightsPx.medium=2)は
  // 既定SCALE_X=0.0378だと実px換算0.0756でTHIN_PX=1以下になり、そもそも延長ゼロ同士の比較になって
  // 「不変」の検証として空虚になる（QA指摘）。heavyは常に実2px相当でscale非依存に非thin。
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

test('stairLineRenderProps: isDownViewの踏面線・外周線はdashに見下げパターンが入る', () => {
  const tread = { x1: 0, y1: 0, x2: 100, y2: 0 };
  const outlineSeg = { x1: 0, y1: 0, x2: 100, y2: 0 };
  const entry = { view: 'upper', id: 's1', treadSegs: [tread], outlineSegs: [outlineSeg], isDownView: true };
  const { treads, outline } = stairLineRenderProps(entry, fakeViewport(SCALE_X), WEIGHTS);
  assert.deepEqual(treads[0].dash, [3 / SCALE_X, 3 / SCALE_X]);
  assert.deepEqual(outline[0].dash, [3 / SCALE_X, 3 / SCALE_X]);
});

test('stairLineRenderProps: s.dashed（到達辺等）はisDownViewでなくても外周線dashに[40,30]相当が入る', () => {
  const outlineSeg = { x1: 0, y1: 0, x2: 100, y2: 0, dashed: true };
  const entry = { view: 'install', id: 's1', outlineSegs: [outlineSeg], isDownView: false };
  const { outline } = stairLineRenderProps(entry, fakeViewport(SCALE_X), WEIGHTS);
  assert.deepEqual(outline[0].dash, [40 / SCALE_X, 30 / SCALE_X]);
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
