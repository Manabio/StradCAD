// siteLineJoinPrimitives.js（敷地モード境界線→figureLineJoin.js primitives写像・世界mm解決）の
// 回帰テスト。resolveSiteLinePointsMm は「実スクリーンpxへ持ち上げてjoinし、世界mmへ戻す」
// 往復をviewportLike（duck-type。store.js/appViewportは静的importしない）経由で行う——
// この往復自体がテストで守られていることを示すため、統合テストは常に非恒等（offset/scale≠1）の
// fakeViewportを使う（idT等の恒等変換だけで検証すると、往復判断が丸ごと欠落しても検出できない）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapSiteLinesToJoinPrimitives, resolveSiteLinePointsMm } from './siteLineJoinPrimitives.js';
import { resolveJoinedLinePoints, linePointsPx } from '../renderer/figureLineJoin.js';

const WEIGHTS = { thick: 3, ultraThick: 4 };

// site.lines を模した最小限のオブジェクト（SitePoint/SiteLineのmobx部分には依存しない）。
function line(id, x1, y1, x2, y2) {
  return { id, startPoint: { id: `${id}-s`, x: x1, y: y1 }, endPoint: { id: `${id}-e`, x: x2, y: y2 } };
}

// viewport.js の worldToScreen/screenToWorld と同じ式のduck-type実装（非恒等・非0オフセット）。
function fakeViewport(scaleX, scaleY = scaleX, offsetX = 37, offsetY = -52) {
  return {
    worldToScreen: (x, y) => ({ x: x * scaleX + offsetX, y: y * scaleY + offsetY }),
    screenToWorld: (x, y) => ({ x: (x - offsetX) / scaleX, y: (y - offsetY) / scaleY }),
  };
}

test('mapSiteLinesToJoinPrimitives: 非選択の境界線はthick幅で写像される', () => {
  const lines = [line('a', 0, 0, 100, 0), line('b', 100, 0, 100, 100)];
  const prims = mapSiteLinesToJoinPrimitives(lines, null, WEIGHTS);
  assert.equal(prims.length, 2);
  for (const p of prims) {
    assert.equal(p.type, 'line');
    assert.equal(p.width, 3);
    assert.equal(p.dash, undefined); // 実線のみ扱う（破線マーカーを付けない）
  }
});

test('mapSiteLinesToJoinPrimitives: 選択線は選択時のultraThick幅で写像される', () => {
  const lines = [line('a', 0, 0, 100, 0), line('b', 100, 0, 100, 100)];
  const prims = mapSiteLinesToJoinPrimitives(lines, 'b', WEIGHTS);
  assert.equal(prims[0].width, 3); // 非選択のまま
  assert.equal(prims[1].width, 4); // 選択線はultraThick
});

test('mapSiteLinesToJoinPrimitives: lines配列に無い要素（三斜バッジ・プレビュー線等）は入力チャネルが無く出力に混入しない', () => {
  // site.triangleMap や mode.siteDrawState はこの関数の引数に存在しないため、
  // 呼び出し側が誤って混ぜない限り出力はlinesと1:1の長さを超えない。
  const lines = [line('a', 0, 0, 100, 0)];
  const prims = mapSiteLinesToJoinPrimitives(lines, null, WEIGHTS);
  assert.equal(prims.length, 1);
});

test('mapSiteLinesToJoinPrimitives: 同じPointを共有する2線の端点は同値になる（mm厳密一致の前提）', () => {
  const shared = { id: 'p1', x: 100, y: 0 };
  const lines = [
    { id: 'a', startPoint: { id: 'p0', x: 0, y: 0 }, endPoint: shared },
    { id: 'b', startPoint: shared, endPoint: { id: 'p2', x: 100, y: 100 } },
  ];
  const prims = mapSiteLinesToJoinPrimitives(lines, null, WEIGHTS);
  assert.equal(prims[0].x2, prims[1].x1);
  assert.equal(prims[0].y2, prims[1].y1);
});

// ---- 純粋な角度式の検証（figureLineJoin.js単体。恒等変換で式そのものを確認する） ----

const idT = { tx: x => x, ty: y => y };

test('mapPrimitives→resolveJoinedLinePoints→linePointsPx: 直交に取り合う2本の境界線（同太さ）は式どおり角の外側へ延びる', () => {
  const lines = [line('a', 0, 0, 100, 0), line('b', 100, 0, 100, 100)];
  const prims = mapSiteLinesToJoinPrimitives(lines, null, WEIGHTS);
  const joined = resolveJoinedLinePoints(prims, idT, WEIGHTS);
  const [, , ax2, ay2] = linePointsPx(prims[0], 0, idT, joined);
  assert.ok(Math.abs(ax2 - 101.5) < 1e-9, `期待101.5, 実際${ax2}`); // 相手半幅thick/2=1.5px
  assert.equal(ay2, 0);
  const [bx1, by1] = linePointsPx(prims[1], 1, idT, joined);
  assert.equal(bx1, 100);
  assert.ok(Math.abs(by1 - -1.5) < 1e-9, `期待-1.5, 実際${by1}`);
});

test('mapPrimitives→resolveJoinedLinePoints: 3本が集まる頂点では何もしない', () => {
  const lines = [
    line('a', 0, 0, 100, 0),
    line('b', 100, 0, 100, 100),
    line('c', 100, 0, 200, 0),
  ];
  const prims = mapSiteLinesToJoinPrimitives(lines, null, WEIGHTS);
  const joined = resolveJoinedLinePoints(prims, idT, WEIGHTS);
  assert.equal(joined.size, 0);
});

// ---- resolveSiteLinePointsMm（最終出力レベル）の統合テスト ----
// すべて非恒等fakeViewport（offset≠0）を使う——SiteLinesLayer.jsxがscreenT/screenToWorldの
// 往復を実際に行っているかを検証するため（恒等変換の変異が赤化することをこのテストで示す）。

test('resolveSiteLinePointsMm: ズーム非依存——延長量(mm)×scaleは異なるscaleでも常に1.5px相当', () => {
  const lines = [line('a', 0, 0, 100, 0), line('b', 100, 0, 100, 100)];
  for (const scale of [0.0378, 0.001]) {
    const vp = fakeViewport(scale);
    const resolved = resolveSiteLinePointsMm(lines, null, WEIGHTS, vp);
    const [ax1, ay1, ax2, ay2] = resolved.get('a').points;
    assert.ok(Math.abs(ax1 - 0) < 1e-6); assert.ok(Math.abs(ay1 - 0) < 1e-6); // 他端は不変
    const extendMmA = ax2 - 100;
    assert.ok(Math.abs(extendMmA * scale - 1.5) < 1e-9,
      `scale=${scale}: 期待1.5px, 実際${extendMmA * scale}px`);
    assert.ok(Math.abs(ay2 - 0) < 1e-6);

    const [bx1, by1, bx2, by2] = resolved.get('b').points;
    const extendMmB = by1 - 0;
    assert.ok(Math.abs(extendMmB * scale - -1.5) < 1e-9,
      `scale=${scale}: 期待-1.5px, 実際${extendMmB * scale}px`);
    assert.ok(Math.abs(bx1 - 100) < 1e-6);
    assert.ok(Math.abs(bx2 - 100) < 1e-6); assert.ok(Math.abs(by2 - 100) < 1e-6); // 他端は不変

    assert.equal(resolved.get('a').width, 3);
    assert.equal(resolved.get('b').width, 3);
  }
});

test('resolveSiteLinePointsMm: 延長が入らない線（3本集合の頂点）は全座標がモデル値と一致する', () => {
  const lines = [
    line('a', 0, 0, 100, 0),
    line('b', 100, 0, 100, 100),
    line('c', 100, 0, 200, 0),
  ];
  const vp = fakeViewport(0.0378, 0.0378, 37, -52);
  const resolved = resolveSiteLinePointsMm(lines, null, WEIGHTS, vp);
  for (const l of lines) {
    const [x1, y1, x2, y2] = resolved.get(l.id).points;
    assert.ok(Math.abs(x1 - l.startPoint.x) < 1e-6, `${l.id}.x1: 期待${l.startPoint.x}, 実際${x1}`);
    assert.ok(Math.abs(y1 - l.startPoint.y) < 1e-6, `${l.id}.y1: 期待${l.startPoint.y}, 実際${y1}`);
    assert.ok(Math.abs(x2 - l.endPoint.x) < 1e-6, `${l.id}.x2: 期待${l.endPoint.x}, 実際${x2}`);
    assert.ok(Math.abs(y2 - l.endPoint.y) < 1e-6, `${l.id}.y2: 期待${l.endPoint.y}, 実際${y2}`);
  }
});

test('resolveSiteLinePointsMm: 不等倍(scaleX=0.05,scaleY=0.03)でも延長はpx基準——水平・垂直とも1.5px、mmでは非対称', () => {
  const lines = [line('a', 0, 0, 100, 0), line('b', 100, 0, 100, 100)];
  const vp = fakeViewport(0.05, 0.03);
  const resolved = resolveSiteLinePointsMm(lines, null, WEIGHTS, vp);
  const [, , ax2] = resolved.get('a').points; // 水平線は x方向にscaleX基準で延びる
  const extendMmA = ax2 - 100;
  assert.ok(Math.abs(extendMmA * 0.05 - 1.5) < 1e-9, `期待1.5px, 実際${extendMmA * 0.05}px`);
  const [, by1] = resolved.get('b').points; // 垂直線は y方向にscaleY基準で延びる
  const extendMmB = by1 - 0;
  assert.ok(Math.abs(extendMmB * 0.03 - -1.5) < 1e-9, `期待-1.5px, 実際${extendMmB * 0.03}px`);
  assert.notEqual(Math.abs(extendMmA), Math.abs(extendMmB), 'mm換算では不等倍のため非対称になるはず');
});

test('resolveSiteLinePointsMm【失敗系】: lineWeightsPx={}でも例外にならず延長なし（THIN_PX既定1にフォールバック）', () => {
  const lines = [line('a', 0, 0, 100, 0), line('b', 100, 0, 100, 100)];
  const vp = fakeViewport(0.0378);
  assert.doesNotThrow(() => {
    const resolved = resolveSiteLinePointsMm(lines, null, {}, vp);
    const [, , ax2, ay2] = resolved.get('a').points;
    assert.ok(Math.abs(ax2 - 100) < 1e-6); // 延長なし
    assert.ok(Math.abs(ay2 - 0) < 1e-6);
  });
});

// 幅の唯一の供給源は resolveSiteLinePointsMm の返り値 width（.jsx はそれを strokeWidth にするだけ）。
// 最終出力レベルで選択線の幅と、異太さの角の非対称な延長を固定する（写像レベルだけだと
// 返り値の width を thick 固定にする変異が素通りする——QA指摘）。
test('resolveSiteLinePointsMm: 選択線はultraThick幅で返り、角は異太さの式どおり非対称に延びる', () => {
  const lines = [line('a', 0, 0, 100, 0), line('b', 100, 0, 100, 100)];
  const scale = 0.0378;
  const resolved = resolveSiteLinePointsMm(lines, 'b', WEIGHTS, fakeViewport(scale));
  assert.equal(resolved.get('b').width, 4, '選択線はultraThick');
  assert.equal(resolved.get('a').width, 3, '非選択線はthick');
  const a = resolved.get('a').points, b = resolved.get('b').points;
  // a（3px）は相手＝選択線の半幅 4/2=2.0px ぶん、b（4px）は相手＝非選択線の半幅 3/2=1.5px ぶん延びる
  assert.ok(Math.abs((a[2] - 100) * scale - 2.0) < 1e-9, `aの延長は2.0pxのはず（実際:${(a[2] - 100) * scale}）`);
  assert.ok(Math.abs(b[1] * scale - (-1.5)) < 1e-9, `bの延長は1.5px（角の外側＝y負方向）のはず（実際:${b[1] * scale}）`);
});

test('resolveSiteLinePointsMm【失敗系】: site.lines空→空Map／存在しないselectedLineId→全線thick／長さ0→座標不変', () => {
  const vp = fakeViewport(0.0378);
  assert.equal(resolveSiteLinePointsMm([], null, WEIGHTS, vp).size, 0);

  const lines = [line('a', 0, 0, 100, 0), line('b', 100, 0, 100, 100)];
  const resolved = resolveSiteLinePointsMm(lines, 'no-such-id', WEIGHTS, vp);
  assert.equal(resolved.get('a').width, 3);
  assert.equal(resolved.get('b').width, 3);

  const zeroLen = [line('z', 50, 50, 50, 50)];
  const resolvedZero = resolveSiteLinePointsMm(zeroLen, null, WEIGHTS, vp);
  const [zx1, zy1, zx2, zy2] = resolvedZero.get('z').points;
  assert.ok(Math.abs(zx1 - 50) < 1e-6); assert.ok(Math.abs(zy1 - 50) < 1e-6);
  assert.ok(Math.abs(zx2 - 50) < 1e-6); assert.ok(Math.abs(zy2 - 50) < 1e-6);
});
