// 姿図の配置（snapshot.placedFigures[].figureKey）の詳細図参照 walker のテスト。
// detailFigureCatalog.test.js の kneeDrop の walker テストと同型。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SNAPSHOT_REF_WALKERS } from './codeNormalization.js';
import { CatalogKind } from './catalogKinds.js';
import { collectUsedKeys } from './usedEntries.js';

const walker = SNAPSHOT_REF_WALKERS[CatalogKind.DETAIL_FIGURE];
const pfd = (id, figureKey, over = {}) => ({ id, figureKey, x: 300, y: 100, rotationDeg: 90, mirror: false, zMm: 0, note: '', ...over });

test('enumerate: placedFigures[].figureKey を {location:placedFigure, placedFigureId, slot:null} で列挙し、使用キー収集に合流する', () => {
  const snapshot = {
    rooms: [{ id: 'r1', detailRefs: { floorWall: 'df-fw' } }],
    placedFigures: [pfd('p1', 'df-a'), pfd('p2', 'df-b')],
  };
  assert.deepEqual([...walker.enumerate(snapshot)], [
    { code: 'df-fw', location: 'room', roomId: 'r1', slot: 'floorWall' },
    { code: 'df-a', location: 'placedFigure', placedFigureId: 'p1', slot: null },
    { code: 'df-b', location: 'placedFigure', placedFigureId: 'p2', slot: null },
  ]);
  assert.deepEqual([...collectUsedKeys(snapshot).detailFigure].sort(), ['df-a', 'df-b', 'df-fw']);
});

test('【失敗系】enumerate: 配置なし・キー無し・空/非文字列の figureKey・null 要素は列挙に出ない', () => {
  assert.deepEqual([...walker.enumerate({ placedFigures: [] })], []);
  assert.deepEqual([...walker.enumerate({})], []);
  assert.deepEqual([...walker.enumerate({ placedFigures: [pfd('p1', ''), pfd('p2', 3), null] })], []);
});

test('rewrite: figureKey を alias 表で読み替える。他の項目を保ち、表に無い配置は同一参照・元は変えず、変化なしなら snapshot も同一参照', () => {
  const snapshot = {
    rooms: [{ id: 'r1', detailRefs: { floorWall: 'df-old' } }],
    placedFigures: [pfd('p1', 'df-old', { note: 'メモ' }), pfd('p2', 'df-keep')],
  };
  const before = JSON.stringify(snapshot);
  const { snapshot: next, unresolved } = walker.rewrite(snapshot, new Map([['df-old', 'df-new']]));
  assert.deepEqual(next.placedFigures[0], pfd('p1', 'df-new', { note: 'メモ' }), '他の項目を保つ');
  assert.equal(next.placedFigures[1], snapshot.placedFigures[1], '表に無い配置は同一参照');
  assert.deepEqual(next.rooms[0].detailRefs, { floorWall: 'df-new' }, 'rooms の書換えと両立する');
  assert.deepEqual(unresolved, []);
  assert.equal(JSON.stringify(snapshot), before, '元のスナップショットを書き換えない');
  assert.equal(walker.rewrite(snapshot, new Map([['df-x', 'df-y']])).snapshot, snapshot);
});

test('【失敗系】rewrite: キーの無い snapshot に足さない／to=null（廃止）は据え置きで unresolved へ', () => {
  const snapshot = { rooms: [{ id: 'r1', detailRefs: { floorWall: 'df-old' } }] };
  const noPf = walker.rewrite(snapshot, new Map([['df-old', 'df-new']]));
  assert.equal(Object.hasOwn(noPf.snapshot, 'placedFigures'), false);

  const withPf = { placedFigures: [pfd('p1', 'df-old')] };
  const dropped = walker.rewrite(withPf, new Map([['df-old', null]]));
  assert.equal(dropped.snapshot.placedFigures[0].figureKey, 'df-old');
  assert.deepEqual(dropped.unresolved, [{ code: 'df-old', location: 'placedFigure', placedFigureId: 'p1', slot: null }]);
});
