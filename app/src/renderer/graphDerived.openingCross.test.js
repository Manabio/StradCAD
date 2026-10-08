// StructuralLayer.jsx の床開口×のキャッシュ設計（置き場＝下階graph・鍵＝主題階×LOD）の契約テスト。
// graphComputed は (graph,key) ごとに最初の compute を使い回す——置き場が下階 peek に依存しないと
// 構造モードへ入り直して下階の peek が替わっても古い peek 基準の結果を返し続ける（QA再現）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { graphComputed } from './graphDerived.js';

test('graphComputed: 置き場を下階graphにすると、下階 A→B に替えた2回目は B に基づく', () => {
  const subject = { plane: { id: 'p2' } };
  const peekA = { name: 'A' }, peekB = { name: 'B' };
  const draw = below => graphComputed(below ?? subject, `openingCross:${subject.plane.id}:1`, () => `below=${below?.name}`);
  assert.equal(draw(peekA), 'below=A');
  assert.equal(draw(peekB), 'below=B');
  assert.equal(draw(peekA), 'below=A'); // 同じ置き場は再利用
});

test('graphComputed: 置き場を主題階に固定すると古い下階を握り続ける（旧実装の不具合の再現）', () => {
  const subject = { plane: { id: 'p3' } };
  const draw = below => graphComputed(subject, 'openingCross:p3:1', () => `below=${below.name}`);
  assert.equal(draw({ name: 'A' }), 'below=A');
  assert.equal(draw({ name: 'B' }), 'below=A');
});
