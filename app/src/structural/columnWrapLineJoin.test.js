// structural/columnWrapLineJoin.js（renderer/StructuralLayer.jsx の柱の仕上げ包み
// 旧`columnWrapLines`のL字の角の外角閉じ。第4弾）の回帰テスト。統合テストは常に非恒等
// （offset/scale≠1）のfakeViewportを使う（site/stair の既存方針と同じ。往復判断自体が
// テストで守られていることを示すため）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  columnWrapOuterKey, columnWrapFinKey,
  columnWrapEdgePrimitives, columnWrapRenderProps, columnWrapStrokeWidth,
} from './columnWrapLineJoin.js';
import { resolveStrokeWidth, resolveLineWeightsPx, DEFAULT_PX_PER_MM } from '../viewport.js';
import { LINE_WEIGHT_MM } from '../core.js';
import { wallFinishLineWeight } from '../finish/wallFinishJoin.js';

function fakeViewport(scaleX, scaleY = scaleX, offsetX = 37, offsetY = -52) {
  return {
    scaleX, scaleY, offsetX, offsetY,
    worldToScreen: (x, y) => ({ x: x * scaleX + offsetX, y: y * scaleY + offsetY }),
    screenToWorld: (x, y) => ({ x: (x - offsetX) / scaleX, y: (y - offsetY) / scaleY }),
  };
}

// ---- 写像（columnWrapEdgePrimitives） ----

test('写像: 全辺残る柱（trimmed無し・detail=false）は外形4辺のみ', () => {
  const wrap = { xLo: 0, xHi: 200, yLo: 0, yHi: 100 };
  const prims = columnWrapEdgePrimitives({ id: 'c1' }, wrap, false);
  assert.equal(prims.length, 4);
  const byKey = Object.fromEntries(prims.map(p => [p.key, p]));
  assert.deepEqual(byKey[columnWrapOuterKey('c1', 'xLo')], { key: 'wrap:c1:xLo', x1: 0, y1: 0, x2: 0, y2: 100 });
  assert.deepEqual(byKey[columnWrapOuterKey('c1', 'xHi')], { key: 'wrap:c1:xHi', x1: 200, y1: 0, x2: 200, y2: 100 });
  assert.deepEqual(byKey[columnWrapOuterKey('c1', 'yLo')], { key: 'wrap:c1:yLo', x1: 0, y1: 0, x2: 200, y2: 0 });
  assert.deepEqual(byKey[columnWrapOuterKey('c1', 'yHi')], { key: 'wrap:c1:yHi', x1: 0, y1: 100, x2: 200, y2: 100 });
});

test('写像: trimmed辺（壁と取り合う辺）は対象外——壁側の線に任せる', () => {
  const wrap = { xLo: 0, xHi: 200, yLo: 0, yHi: 100, trimmed: { xLo: true, yLo: true } };
  const prims = columnWrapEdgePrimitives({ id: 'c1' }, wrap, false);
  const keys = prims.map(p => p.key);
  assert.deepEqual(keys.sort(), [columnWrapOuterKey('c1', 'xHi'), columnWrapOuterKey('c1', 'yHi')].sort());
});

test('写像: 4辺全trimmed → 0件', () => {
  const wrap = { xLo: 0, xHi: 200, yLo: 0, yHi: 100, trimmed: { xLo: true, xHi: true, yLo: true, yHi: true } };
  assert.equal(columnWrapEdgePrimitives({ id: 'c1' }, wrap, false).length, 0);
  assert.equal(columnWrapEdgePrimitives({ id: 'c1' }, wrap, true).length, 0);
});

test('写像: detail=trueは仕上げ厚が正の辺だけ内側境界(wrapfin)を追加する', () => {
  const wrap = {
    xLo: 0, xHi: 100, yLo: 0, yHi: 80,
    finishes: { xLo: 10, xHi: 0, yLo: 5, yHi: 5 }, // xHiは仕上げ材なし
  };
  const prims = columnWrapEdgePrimitives({ id: 'c1' }, wrap, true);
  const finKeys = prims.map(p => p.key).filter(k => k.startsWith('wrapfin:'));
  assert.deepEqual(finKeys.sort(), [
    columnWrapFinKey('c1', 'xLo'), columnWrapFinKey('c1', 'yLo'), columnWrapFinKey('c1', 'yHi'),
  ].sort(), 'xHiは仕上げ厚0のため内側境界を持たない');
  const byKey = Object.fromEntries(prims.map(p => [p.key, p]));
  // 内側境界＝外形から仕上げ厚ぶん内側（xLo: 0+10=10, yLo: 0+5=5, yHi: 80-5=75）
  assert.deepEqual(byKey[columnWrapFinKey('c1', 'xLo')], { key: 'wrapfin:c1:xLo', x1: 10, y1: 5, x2: 10, y2: 75 });
});

test('写像: detail=trueでも仕上げ厚で内側が潰れる柱は内側境界を1本も出さない', () => {
  const wrap = { xLo: 0, xHi: 100, yLo: 0, yHi: 80, finishes: { xLo: 60, xHi: 60, yLo: 0, yHi: 0 } };
  const prims = columnWrapEdgePrimitives({ id: 'c1' }, wrap, true);
  assert.equal(prims.filter(p => p.key.startsWith('wrapfin:')).length, 0);
  assert.equal(prims.filter(p => p.key.startsWith('wrap:')).length, 4, '外形4辺は影響を受けない');
});

// ---- 統合（columnWrapRenderProps。非恒等fakeViewport） ----

test('統合: 4辺残る柱は4角とも相手半幅ぶん外側へ延長する（各辺の両端）', () => {
  const wrap = { xLo: 0, xHi: 200, yLo: 0, yHi: 100 };
  const wraps = [{ column: { id: 'c1' }, wrap, color: '#123456', strokeWidth: 6, detail: false }];
  const vp = fakeViewport(2.6);
  const out = columnWrapRenderProps(wraps, vp);
  const byKey = Object.fromEntries(out.map(p => [p.key, p]));

  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `期待${b}, 実際${a}`);
  const [xLo1x, xLo1y, xLo2x, xLo2y] = byKey['wrap:c1:xLo'].points;
  near(xLo1x, 0); near(xLo1y, -3); near(xLo2x, 0); near(xLo2y, 103);
  const [xHi1x, xHi1y, xHi2x, xHi2y] = byKey['wrap:c1:xHi'].points;
  near(xHi1x, 200); near(xHi1y, -3); near(xHi2x, 200); near(xHi2y, 103);
  const [yLo1x, yLo1y, yLo2x, yLo2y] = byKey['wrap:c1:yLo'].points;
  near(yLo1x, -3); near(yLo1y, 0); near(yLo2x, 203); near(yLo2y, 0);
  const [yHi1x, yHi1y, yHi2x, yHi2y] = byKey['wrap:c1:yHi'].points;
  near(yHi1x, -3); near(yHi1y, 100); near(yHi2x, 203); near(yHi2y, 100);

  // strokeWidthは往復で不変・colorはそのまま転記される。
  for (const key of ['wrap:c1:xLo', 'wrap:c1:xHi', 'wrap:c1:yLo', 'wrap:c1:yHi']) {
    assert.equal(byKey[key].strokeWidth, 6);
    assert.equal(byKey[key].color, '#123456');
  }
});

test('統合: ズーム非依存——延長mm×scaleが実px一定（scale∈{0.0378,0.001,2.6,20}）', () => {
  // strokeWidthは「常に実2px相当」になるよう2/scaleを渡す（viewport.jsのresolveStrokeWidthが
  // 実運用のズーム域で採る分岐＝解像度下限保証と同じ形。stair側の"heavy"固定2pxと同じ考え方。
  // 実1px相当だとfigureLineJoin.jsのTHIN_PX=1しきい値ちょうどに乗り「細線同士」扱いで延長ゼロに
  // なるため、しきい値を跨ぐ2pxを使う）。
  const wrap = { xLo: 0, xHi: 200, yLo: 0, yHi: 100 };
  for (const scale of [0.0378, 0.001, 2.6, 20]) {
    const strokeWidth = 2 / scale; // 実px換算で常に2px
    const wraps = [{ column: { id: 'c1' }, wrap, color: '#000', strokeWidth, detail: false }];
    const out = columnWrapRenderProps(wraps, fakeViewport(scale));
    const byKey = Object.fromEntries(out.map(p => [p.key, p]));
    const [, y1] = byKey['wrap:c1:xLo'].points; // (0,0)→(0,-ext)
    const extMm = 0 - y1;
    const extPx = extMm * scale;
    assert.ok(Math.abs(extPx - 1.0) < 1e-9, `scale=${scale}: 期待1.0px, 実際${extPx}px`);
  }
});

test('統合: trimmed辺がある柱は残り2辺のL字だけ閉じ、trimmed辺に接していた端は不変', () => {
  const wrap = { xLo: 0, xHi: 200, yLo: 0, yHi: 100, trimmed: { xLo: true, yLo: true } };
  const wraps = [{ column: { id: 'c1' }, wrap, color: '#000', strokeWidth: 6, detail: false }];
  const out = columnWrapRenderProps(wraps, fakeViewport(2.6));
  assert.equal(out.length, 2, 'xLo/yLoは描画対象外のまま出力にも現れない');
  const byKey = Object.fromEntries(out.map(p => [p.key, p]));

  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `期待${b}, 実際${a}`);
  // xHi: point1(200,0)はyLoが無いため不変、point2(200,100)はyHiとの角で延長される。
  const [xHi1x, xHi1y, xHi2x, xHi2y] = byKey['wrap:c1:xHi'].points;
  near(xHi1x, 200); near(xHi1y, 0); near(xHi2x, 200); near(xHi2y, 103);
  // yHi: point1(0,100)はxLoが無いため不変、point2(200,100)はxHiとの角で延長される。
  const [yHi1x, yHi1y, yHi2x, yHi2y] = byKey['wrap:c1:yHi'].points;
  near(yHi1x, 0); near(yHi1y, 100); near(yHi2x, 203); near(yHi2y, 100);
});

test('統合: 別の柱の辺と端点が一致しても互いに影響しない（柱単位で解決）', () => {
  // 柱Aの角(50,50)＝xHi/yHi と 柱Bの角(50,50)＝xLo/yLo が同じmm点で一致するが、
  // 柱単位で個別に解決するため、両方とも「自分の柱の2辺だけの角」として正常に延長される
  // （もし柱横断でまとめて解決すると、その点に4本の端点が集まり「ちょうど2本」条件を満たさず
  // 延長ゼロになる——このテストはその誤りを検出する）。
  const wrapA = { xLo: 0, xHi: 50, yLo: 0, yHi: 50 };
  const wrapB = { xLo: 50, xHi: 100, yLo: 50, yHi: 100 };
  const wraps = [
    { column: { id: 'cA' }, wrap: wrapA, color: '#a', strokeWidth: 6, detail: false },
    { column: { id: 'cB' }, wrap: wrapB, color: '#b', strokeWidth: 6, detail: false },
  ];
  const out = columnWrapRenderProps(wraps, fakeViewport(2.6));
  const byKey = Object.fromEntries(out.map(p => [p.key, p]));

  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `期待${b}, 実際${a}`);
  const [, , aXHi2x, aXHi2y] = byKey['wrap:cA:xHi'].points; // (50,0)→(50,50)の端が角
  near(aXHi2x, 50); near(aXHi2y, 53);
  const [, , aYHi2x, aYHi2y] = byKey['wrap:cA:yHi'].points; // (0,50)→(50,50)の端が角
  near(aYHi2x, 53); near(aYHi2y, 50);
  const [bXLo1x, bXLo1y] = byKey['wrap:cB:xLo'].points; // (50,50)→(50,100)の端が角
  near(bXLo1x, 50); near(bXLo1y, 47);
  const [bYLo1x, bYLo1y] = byKey['wrap:cB:yLo'].points; // (50,50)→(100,50)の端が角
  near(bYLo1x, 47); near(bYLo1y, 50);
});

// ---- 失敗系 ----

test('失敗系: 柱0件 → 空配列', () => {
  assert.deepEqual(columnWrapRenderProps([], fakeViewport(2.6)), []);
});

test('失敗系: columnWrapRenderPropsは2引数（wraps, viewportLike）で完結し、lineWeightsPxパラメータを持たない', () => {
  const wrap = { xLo: 0, xHi: 200, yLo: 0, yHi: 100 };
  const wraps = [{ column: { id: 'c1' }, wrap, color: '#000', strokeWidth: 6, detail: false }];
  assert.doesNotThrow(() => {
    const out = columnWrapRenderProps(wraps, fakeViewport(2.6));
    assert.equal(out.length, 4);
  });
});

test('T3: wrapがnull/undefinedのときcolumnWrapEdgePrimitivesは例外にならず空配列を返す', () => {
  assert.deepEqual(columnWrapEdgePrimitives({ id: 'c1' }, null, false), []);
  assert.deepEqual(columnWrapEdgePrimitives({ id: 'c1' }, undefined, true), []);
});

test('T3: finishes/trimmed欠落のwrapでも例外にならず、内側境界は仕上げ厚0扱いで出さない', () => {
  const wrap = { xLo: 0, xHi: 100, yLo: 0, yHi: 50 }; // finishes・trimmedとも未指定
  let prims;
  assert.doesNotThrow(() => { prims = columnWrapEdgePrimitives({ id: 'c1' }, wrap, true); });
  assert.equal(prims.filter(p => p.key.startsWith('wrap:')).length, 4, 'trimmed未指定は全辺残る');
  assert.equal(prims.filter(p => p.key.startsWith('wrapfin:')).length, 0, 'finishes未指定は仕上げ厚0扱いで内側境界なし');
});

test('T4: wrapsがnull/undefined → columnWrapRenderPropsは空配列', () => {
  assert.deepEqual(columnWrapRenderProps(null, fakeViewport(2.6)), []);
  assert.deepEqual(columnWrapRenderProps(undefined, fakeViewport(2.6)), []);
});

// ---- T1・T2: 太さの供給源（壁のLOD仕様＝resolveStrokeWidth(shape.lineWeight, scale)由来） ----

test('T2: columnWrapStrokeWidthは壁の仕上げ材の線と同じ供給源（resolveStrokeWidth(wallFinishLineWeight(detail), Math.min(scaleX,scaleY))）——唯一の供給源', () => {
  // scale=10相当を含める——scale<=4付近ではresolveStrokeWidthの1/scale下限が支配的になり
  // medium(0.25)とthick(0.35)等の取り違えを吸収してしまうため、定数そのものの取り違えを
  // 検出するには下限が効かない大きいscaleが必要。
  for (const detail of [false, true]) {
    for (const [sx, sy] of [[0.0378, 0.0378], [0.063, 0.063], [3.78, 3.78], [10, 12]]) {
      const expected = resolveStrokeWidth(wallFinishLineWeight(detail), Math.min(sx, sy));
      assert.equal(columnWrapStrokeWidth(sx, sy, detail), expected, `detail=${detail} scaleX=${sx},scaleY=${sy}`);
    }
  }
});

test('T2b: wallFinishLineWeightは詳細LODだけ太線・それ以外は中線（壁と柱包みが引く唯一の定義）', () => {
  assert.equal(wallFinishLineWeight(true), LINE_WEIGHT_MM.thick);
  assert.equal(wallFinishLineWeight(false), LINE_WEIGHT_MM.medium);
});

// 線の太さは**実スクリーンpx固定**（ユーザー確定2026-09）なので、延長が発火するかどうかも、
// 発火したときの画面上の延長量も、**ズーム倍率に依らない**。旧実装（mm×scaleで太さが変わる）
// では「scale>4で発火・以下は不発」というズーム依存の境界があり、T1/T6/T7はそれを固定していた。
const PROD_PX = resolveLineWeightsPx(DEFAULT_PX_PER_MM); // 本番の4段階px（既定校正: 1/2/3/4）

test('T1: 本番の太さ表（medium=2px）ではどのズームでも延長が発火し、画面px上の延長量は一定', () => {
  const wrap = { xLo: 0, xHi: 200, yLo: 0, yHi: 100 };
  const halfPx = PROD_PX.medium / 2; // 直交する相手の半幅（px）
  for (const denom of [100, 60, 1]) { // 1/100・1/60・1/1
    const scale = DEFAULT_PX_PER_MM / denom;
    const vp = fakeViewport(scale);
    const strokeWidth = columnWrapStrokeWidth(vp.scaleX, vp.scaleY, false, PROD_PX);
    const out = columnWrapRenderProps([{ column: { id: 'c1' }, wrap, color: '#000', strokeWidth, detail: false }], vp);
    const byKey = Object.fromEntries(out.map(p => [p.key, p]));
    // mmの延長量はscaleで割った値になるが、画面px換算では常に相手の半幅ちょうど。
    const extMm = -byKey['wrap:c1:xLo'].points[1];
    assert.ok(Math.abs(extMm * scale - halfPx) < 1e-9, `denom=1/${denom}: 画面px延長量 期待${halfPx}, 実際${extMm * scale}`);
  }
});

test('T6: 線幅指定そのものがズームに依らない——columnWrapStrokeWidth×scaleは常に指定px', () => {
  for (const detail of [false, true]) {
    const expectedPx = detail ? PROD_PX.thick : PROD_PX.medium;
    for (const scale of [0.0378, 0.063, 3.78, 20]) {
      const w = columnWrapStrokeWidth(scale, scale, detail, PROD_PX);
      assert.ok(Math.abs(w * scale - expectedPx) < 1e-9,
        `detail=${detail} scale=${scale}: 期待${expectedPx}px, 実際${w * scale}px`);
    }
  }
});

test('T7: 細線（1px）同士はズームに関わらず延長しない（THIN_PXガード）', () => {
  const wrap = { xLo: 0, xHi: 200, yLo: 0, yHi: 100 };
  for (const scale of [0.0378, 4, 20]) {
    const vp = fakeViewport(scale);
    const strokeWidth = resolveStrokeWidth(LINE_WEIGHT_MM.thin, scale, PROD_PX); // thin=1px
    const out = columnWrapRenderProps([{ column: { id: 'c1' }, wrap, color: '#000', strokeWidth, detail: false }], vp);
    const ext = -out.find(p => p.key === 'wrap:c1:xLo').points[1];
    assert.ok(Math.abs(ext) < 1e-6, `scale=${scale}: 細線同士は延長ゼロのはず、実際${ext}`);
  }
});

test('失敗系: 4辺全trimmedの柱は出力に寄与しない（他の柱には影響しない）', () => {
  const trimmedAway = { xLo: 0, xHi: 10, yLo: 0, yHi: 10, trimmed: { xLo: true, xHi: true, yLo: true, yHi: true } };
  const normal = { xLo: 100, xHi: 200, yLo: 100, yHi: 200 };
  const wraps = [
    { column: { id: 'gone' }, wrap: trimmedAway, color: '#000', strokeWidth: 6, detail: false },
    { column: { id: 'c1' }, wrap: normal, color: '#000', strokeWidth: 6, detail: false },
  ];
  const out = columnWrapRenderProps(wraps, fakeViewport(2.6));
  assert.equal(out.length, 4);
  assert.ok(out.every(p => p.key.includes(':c1:')));
});
