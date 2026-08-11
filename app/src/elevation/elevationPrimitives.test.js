// elevationPrimitives.js の appendRoomNameFrame のテスト（QA G5・項目9/10）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendRoomNameFrame } from './elevationPrimitives.js';
import { DEFAULT_NAME_GAP_MM } from './elevationStyle.js';

// appendRoomNameFrame が読む figureBounds は 'line' プリミティブの x1/y1/x2/y2 を見る
// （elevationFigure.jsの床線・天井線・両端縦線と同じ語彙。テスト用の最小構成）。
function makeBodyPrimitives(maxY = 0) {
  return [{ type: 'line', x1: 0, y1: -2400, x2: 4000, y2: maxY, weight: 'thick' }];
}

test('appendRoomNameFrame: nameGapModelMmを指定すると部屋名枠のy(labelTop)がその分だけ下がる', () => {
  const primsSmall = makeBodyPrimitives();
  appendRoomNameFrame(primsSmall, 'LDK', { nameGapModelMm: 100 });
  const primsLarge = makeBodyPrimitives();
  appendRoomNameFrame(primsLarge, 'LDK', { nameGapModelMm: 999 });

  const rectSmall = primsSmall.find(p => p.type === 'rect');
  const rectLarge = primsLarge.find(p => p.type === 'rect');
  assert.ok(rectSmall && rectLarge, '部屋名枠(rect)が両方に出るはず');
  assert.ok(Math.abs((rectLarge.y - rectSmall.y) - (999 - 100)) < 1e-6,
    `nameGapModelMmの差分(899)だけrect.yが変わるはず（実際差:${rectLarge.y - rectSmall.y}）`);
});

test('appendRoomNameFrame: nameGapModelMm未指定はDEFAULT_NAME_GAP_MM（既定の1パス目仮値）を使う', () => {
  const primsDefault = makeBodyPrimitives();
  appendRoomNameFrame(primsDefault, 'LDK');
  const primsExplicit = makeBodyPrimitives();
  appendRoomNameFrame(primsExplicit, 'LDK', { nameGapModelMm: DEFAULT_NAME_GAP_MM });

  const rectDefault  = primsDefault.find(p => p.type === 'rect');
  const rectExplicit = primsExplicit.find(p => p.type === 'rect');
  assert.equal(rectDefault.y, rectExplicit.y);
});

// ---- 失敗系: primitivesが空なら何もしない（optsを渡しても例外にならない） ----
test('【失敗系】appendRoomNameFrame: primitivesが空ならoptsを渡しても何も追加しない', () => {
  const prims = [];
  appendRoomNameFrame(prims, 'LDK', { nameGapModelMm: 123, leftX: -500, rightX: 5000 });
  assert.equal(prims.length, 0);
});

// ---- 項目9: leftX/rightXを指定すると留め三角(miterTriangle)がその位置に置かれる ----
test('appendRoomNameFrame: leftX/rightXを指定すると留め三角がその座標に置かれる（preBoundsではなく明示アンカー）', () => {
  const prims = makeBodyPrimitives();
  // 部屋名(LDK)の箱幅は最小1200mm程度のため、leftX/rightXをそれより十分外側に取る。
  appendRoomNameFrame(prims, 'LDK', { leftX: -3000, rightX: 8000 });

  const triangles = prims.filter(p => p.type === 'miterTriangle');
  assert.equal(triangles.length, 2);
  const left  = triangles.find(t => t.dir === 1);
  const right = triangles.find(t => t.dir === -1);
  assert.equal(left.x, -3000, '左三角はleftXの位置（preBounds.minXではなく）に置かれるはず');
  assert.equal(right.x, 8000, '右三角はrightXの位置（preBounds.maxXではなく）に置かれるはず');
});

// ---- 項目9: leftX/rightX未指定時はfigureBounds(primitives)のminX/maxXへフォールバックする ----
test('appendRoomNameFrame: leftX/rightX未指定はfigureBounds(primitives)のminX/maxXにフォールバックする', () => {
  const prims = makeBodyPrimitives(); // x1=0, x2=4000 のline1本 → minX=0, maxX=4000
  appendRoomNameFrame(prims, 'A'); // 短い名前で箱幅が最小1200付近になり、両側に三角が出る想定
  const triangles = prims.filter(p => p.type === 'miterTriangle');
  assert.ok(triangles.some(t => t.x === 0), 'leftX省略時はfigureBoundsのminX(0)を使うはず');
  assert.ok(triangles.some(t => t.x === 4000), 'rightX省略時はfigureBoundsのmaxX(4000)を使うはず');
});
