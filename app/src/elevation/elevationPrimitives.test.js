// elevationPrimitives.js の appendRoomNameFrame ・ nameGapModelMm 引数のテスト（QA G5）。
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
  appendRoomNameFrame(primsSmall, 'LDK', 100);
  const primsLarge = makeBodyPrimitives();
  appendRoomNameFrame(primsLarge, 'LDK', 999);

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
  appendRoomNameFrame(primsExplicit, 'LDK', DEFAULT_NAME_GAP_MM);

  const rectDefault  = primsDefault.find(p => p.type === 'rect');
  const rectExplicit = primsExplicit.find(p => p.type === 'rect');
  assert.equal(rectDefault.y, rectExplicit.y);
});

// ---- 失敗系: primitivesが空なら何もしない（nameGapModelMmを渡しても例外にならない） ----
test('【失敗系】appendRoomNameFrame: primitivesが空ならnameGapModelMmを渡しても何も追加しない', () => {
  const prims = [];
  appendRoomNameFrame(prims, 'LDK', 123);
  assert.equal(prims.length, 0);
});
