// ceilingUpDerived.js（見上げの描画が共有する切断高の解決と描かない建具の集合。graphComputed でキャッシュ）の単体テスト。
// graphComputed の computed は観測者がいる間だけ生きるので、autorun の中で読む（OpeningsLayer／ShapesLayer の observer と同じ条件）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autorun, runInAction } from 'mobx';
import { OpeningCategory } from '@core';
import { ceilingUpDerived } from './ceilingUpDerived.js';
import { makeGrid } from '../plan/planTestFixtures.js';

function setup() {
  const g = makeGrid([0, 4000], [0, 3000]);
  const room = g.interior([[0, 0]], { walls: true });
  room.setOverride('ceilingHeight', '2400');
  const door = g.graph.addOpening(g.cx[0], 1, true, g.cy[0], 1500, 900, OpeningCategory.FITTING, 'singleSwing', { height: 2000 });
  return { g, room, door };
}

test('autorun の中で 2 回呼ぶと同じインスタンス（graph 単位にキャッシュ）。node:test から単体 import できる', () => {
  const { g } = setup();
  let a, b;
  const dispose = autorun(() => { a = ceilingUpDerived(g.graph); b = ceilingUpDerived(g.graph); });
  dispose();
  assert.ok(a && a === b);
  assert.equal(typeof a.wallCutAt, 'function');
  assert.ok(a.hiddenOpeningIds instanceof Set);
});

test('建具の高さを 2000→2399 に変えると hiddenOpeningIds から外れる（切断高 2399 が上端に届く）。戻すと再び入る', () => {
  const { g, door } = setup();
  let derived;
  const dispose = autorun(() => { derived = ceilingUpDerived(g.graph); });
  assert.equal(derived.hiddenOpeningIds.has(door.id), true, '前提: 高さ 2000 は隠れる');
  runInAction(() => { door.height = 2399; });
  assert.equal(derived.hiddenOpeningIds.has(door.id), false);
  runInAction(() => { door.height = 2000; });
  assert.equal(derived.hiddenOpeningIds.has(door.id), true);
  dispose();
});

test('天井高を変えると wallCutAt の値が変わる（2400→1800 で 2399→1799）', () => {
  const { g, room } = setup();
  let derived;
  const dispose = autorun(() => { derived = ceilingUpDerived(g.graph); });
  assert.equal(derived.wallCutAt(true, 0, 1500), 2399);
  runInAction(() => { room.setOverride('ceilingHeight', '1800'); });
  assert.equal(derived.wallCutAt(true, 0, 1500), 1799);
  dispose();
});
