// lineIdRemap.js の単体テスト（線種変更の移籍一本化 指示書 §5.2・§6ステップ1）。
// store.js・snap.js・.jsx を静的に引かない純モジュールなので、node:test から単体でimportできる
// （本ファイル自体もそれらをimportしない）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { remapLineIdsInSnapshot, findLineIdOccurrences, makeFreshLineIdMap } from './lineIdRemap.js';

// ---- remapLineIdsInSnapshot: 基本の置換 ----

test('remapLineIdsInSnapshot: 文字列値の完全一致idを置換する', () => {
  const snapshot = { centerLines: [{ id: 'old-1', value: 0 }] };
  const idMap = new Map([['old-1', 'new-1']]);
  const result = remapLineIdsInSnapshot(snapshot, idMap);
  assert.equal(result.centerLines[0].id, 'new-1');
});

test('remapLineIdsInSnapshot: ":" で連結したセルキー（部分文字列）の中のidも置換する', () => {
  const snapshot = { rooms: [{ id: 'room-1', cells: ['old-x0:old-y0:old-x1:old-y1'] }] };
  const idMap = new Map([
    ['old-x0', 'new-x0'], ['old-y0', 'new-y0'], ['old-x1', 'new-x1'], ['old-y1', 'new-y1'],
  ]);
  const result = remapLineIdsInSnapshot(snapshot, idMap);
  assert.equal(result.rooms[0].cells[0], 'new-x0:new-y0:new-x1:new-y1');
});

test('remapLineIdsInSnapshot: "|" 等の別区切りで連結した交点キーの中のidも置換する', () => {
  const snapshot = { intersections: ['old-v|old-h'] };
  const idMap = new Map([['old-v', 'new-v'], ['old-h', 'new-h']]);
  const result = remapLineIdsInSnapshot(snapshot, idMap);
  assert.equal(result.intersections[0], 'new-v|new-h');
});

test('remapLineIdsInSnapshot: オブジェクトのキー自体がidの辞書（例: columnAxisOffsets的な形）も置換する', () => {
  const snapshot = { columnAxisOffsets: { 'old-1': 15 } };
  const idMap = new Map([['old-1', 'new-1']]);
  const result = remapLineIdsInSnapshot(snapshot, idMap);
  assert.deepEqual(result.columnAxisOffsets, { 'new-1': 15 });
});

test('remapLineIdsInSnapshot: 旧idを含まない文字列・数値・真偽値・nullは不変（JSON.stringify比較）', () => {
  const snapshot = {
    centerLines: [{ id: 'old-1', value: 1234, labeled: true, refId: null, note: '無関係な文字列' }],
    points: [{ id: 'p1', x: 0, y: 0 }],
  };
  const idMap = new Map([['old-1', 'new-1']]);
  const result = remapLineIdsInSnapshot(snapshot, idMap);
  assert.equal(JSON.stringify(result.centerLines[0].value), JSON.stringify(1234));
  assert.equal(JSON.stringify(result.centerLines[0].labeled), JSON.stringify(true));
  assert.equal(JSON.stringify(result.centerLines[0].refId), JSON.stringify(null));
  assert.equal(JSON.stringify(result.centerLines[0].note), JSON.stringify('無関係な文字列'));
  assert.deepEqual(result.points, snapshot.points);
});

test('remapLineIdsInSnapshot: Uint8Array・ArrayBuffer・null・数値・真偽値はそのまま通す', () => {
  const bin = new Uint8Array([1, 2, 3]);
  const buf = new ArrayBuffer(4);
  const snapshot = { bin, buf, n: 42, b: false, nul: null, arr: [1, 'old-1', null] };
  const idMap = new Map([['old-1', 'new-1']]);
  const result = remapLineIdsInSnapshot(snapshot, idMap);
  assert.equal(result.bin, bin, 'Uint8Arrayは同一参照のまま通る');
  assert.equal(result.buf, buf, 'ArrayBufferは同一参照のまま通る');
  assert.equal(result.n, 42);
  assert.equal(result.b, false);
  assert.equal(result.nul, null);
  assert.deepEqual(result.arr, [1, 'new-1', null]);
});

test('remapLineIdsInSnapshot: 入力を書き換えない（深いコピーを返す）', () => {
  const snapshot = { centerLines: [{ id: 'old-1', value: 0 }], rooms: [{ cells: ['old-1:x'] }] };
  const idMap = new Map([['old-1', 'new-1']]);
  remapLineIdsInSnapshot(snapshot, idMap);
  assert.equal(snapshot.centerLines[0].id, 'old-1', '入力のcenterLines[0].idは変わらない');
  assert.equal(snapshot.rooms[0].cells[0], 'old-1:x', '入力のセルキーも変わらない');
});

// ---- 同時置換（順序依存の不良の回帰防止）----

test('remapLineIdsInSnapshot: 連鎖する置換（a→b, b→c）でも "a" は "b" のまま（"c" まで連鎖しない）', () => {
  const snapshot = { centerLines: [{ id: 'a' }] };
  const idMap = new Map([['a', 'b'], ['b', 'c']]);
  const result = remapLineIdsInSnapshot(snapshot, idMap);
  assert.equal(result.centerLines[0].id, 'b');
});

test('remapLineIdsInSnapshot: 入替え（a↔b）で "a:b" は "b:a" になる（"a:a" のような潰れが起きない）', () => {
  const snapshot = { rooms: [{ cells: ['a:b'] }] };
  const idMap = new Map([['a', 'b'], ['b', 'a']]);
  const result = remapLineIdsInSnapshot(snapshot, idMap);
  assert.equal(result.rooms[0].cells[0], 'b:a');
});

test('remapLineIdsInSnapshot: 部分文字列関係のid（cl-1とcl-10）は互いを誤爆しない（cl-10→BBB, cl-1→AAA）', () => {
  const snapshot = { walls: [{ axisCLId: 'cl-10' }, { axisCLId: 'cl-1' }] };
  const idMap = new Map([['cl-1', 'AAA'], ['cl-10', 'BBB']]);
  const result = remapLineIdsInSnapshot(snapshot, idMap);
  assert.equal(result.walls[0].axisCLId, 'BBB', 'cl-10全体が一致するべきで、cl-1+"0"には分解されない');
  assert.equal(result.walls[1].axisCLId, 'AAA');
});

// ---- オブジェクトキーの置換衝突 ----

test('【失敗系】remapLineIdsInSnapshot: キー置換の衝突（f→gでf,g両方が存在）はthrowする（値を黙って消さない）', () => {
  const snapshot = { columnAxisOffsets: { f: 10, g: 20 } };
  const idMap = new Map([['f', 'g']]);
  assert.throws(() => remapLineIdsInSnapshot(snapshot, idMap));
});

test('【失敗系】remapLineIdsInSnapshot: 2つの異なるキーが同じ新キーへ置換されて衝突する場合もthrowする', () => {
  const snapshot = { columnAxisOffsets: { 'old-1': 10, 'old-2': 20 } };
  const idMap = new Map([['old-1', 'merged'], ['old-2', 'merged']]);
  assert.throws(() => remapLineIdsInSnapshot(snapshot, idMap));
});

// ---- 失敗経路 ----

test('【失敗系】remapLineIdsInSnapshot: idMapが空文字の旧idを含むとthrow', () => {
  assert.throws(() => remapLineIdsInSnapshot({ centerLines: [] }, new Map([['', 'new-1']])));
});

test('【失敗系】remapLineIdsInSnapshot: idMapが空文字の新idを含むとthrow', () => {
  assert.throws(() => remapLineIdsInSnapshot({ centerLines: [] }, new Map([['old-1', '']])));
});

test('【失敗系】remapLineIdsInSnapshot: idMapに重複する新id（2つの旧idが同じ新idへ）があるとthrow', () => {
  const idMap = new Map([['old-1', 'dup'], ['old-2', 'dup']]);
  assert.throws(() => remapLineIdsInSnapshot({ centerLines: [] }, idMap));
});

test('【失敗系】remapLineIdsInSnapshot: idMapがMapでないとthrow', () => {
  assert.throws(() => remapLineIdsInSnapshot({ centerLines: [] }, { 'old-1': 'new-1' }));
});

test('【失敗系】remapLineIdsInSnapshot: 入力にMapが含まれるとthrow（中間オブジェクトに現れない想定）', () => {
  const snapshot = { weird: new Map([['a', 1]]) };
  assert.throws(() => remapLineIdsInSnapshot(snapshot, new Map([['old-1', 'new-1']])));
});

test('【失敗系】remapLineIdsInSnapshot: 入力にSetが含まれるとthrow（中間オブジェクトに現れない想定）', () => {
  const snapshot = { weird: new Set(['a']) };
  assert.throws(() => remapLineIdsInSnapshot(snapshot, new Map([['old-1', 'new-1']])));
});

// ---- findLineIdOccurrences ----

test('findLineIdOccurrences: 文字列値・オブジェクトキーの両方から残存idをパス付きで検出する', () => {
  const snapshot = {
    walls: [{ axisCLId: 'cl-1' }],
    rooms: [{ cells: ['cl-1:cl-2'] }],
    columnAxisOffsets: { 'cl-1': 15 },
  };
  const results = findLineIdOccurrences(snapshot, ['cl-1', 'cl-2']);
  const paths = results.map(r => `${r.id}@${r.path}`).sort();
  assert.deepEqual(paths, [
    'cl-1@columnAxisOffsets.cl-1',
    'cl-1@rooms[0].cells[0]',
    'cl-1@walls[0].axisCLId',
    'cl-2@rooms[0].cells[0]',
  ]);
});

test('findLineIdOccurrences: 例のパス形式（walls[0].axisCLId・rooms[1].cells[0]）どおりに報告する', () => {
  const snapshot = {
    walls: [{ axisCLId: 'ignore' }, { axisCLId: 'target-id' }],
    rooms: [{ cells: ['x'] }, { cells: ['target-id'] }],
  };
  const results = findLineIdOccurrences(snapshot, ['target-id']);
  const paths = results.map(r => r.path).sort();
  assert.deepEqual(paths, ['rooms[1].cells[0]', 'walls[1].axisCLId']);
});

test('findLineIdOccurrences: 置換後（remapLineIdsInSnapshotの出力）には旧idが1つも残らない', () => {
  const snapshot = {
    centerLines: [{ id: 'old-1' }, { id: 'old-2' }],
    walls: [{ axisCLId: 'old-1', clStartId: 'old-2' }],
    rooms: [{ cells: ['old-1:old-2:old-1:old-2'] }],
    columnAxisOffsets: { 'old-1': 10 },
  };
  const idMap = new Map([['old-1', 'new-1'], ['old-2', 'new-2']]);
  const remapped = remapLineIdsInSnapshot(snapshot, idMap);
  assert.deepEqual(findLineIdOccurrences(remapped, [...idMap.keys()]), []);
});

test('findLineIdOccurrences: 該当なしなら空配列', () => {
  const snapshot = { walls: [{ axisCLId: 'cl-1' }] };
  assert.deepEqual(findLineIdOccurrences(snapshot, ['cl-999']), []);
});

// ---- makeFreshLineIdMap ----

test('makeFreshLineIdMap: snapshot.centerLinesの全idに新idを割り当てる', () => {
  const snapshot = { centerLines: [{ id: 'cl-1' }, { id: 'cl-2' }] };
  let seq = 0;
  const idMap = makeFreshLineIdMap(snapshot, { newId: () => `fresh-${seq++}` });
  assert.equal(idMap.size, 2);
  assert.equal(idMap.get('cl-1'), 'fresh-0');
  assert.equal(idMap.get('cl-2'), 'fresh-1');
});

test('makeFreshLineIdMap: centerLinesが空でも空のMapを返す（throwしない）', () => {
  const idMap = makeFreshLineIdMap({ centerLines: [] });
  assert.equal(idMap.size, 0);
});

test('makeFreshLineIdMap: newIdを注入しない既定は本物のUUID形式を返す', () => {
  const idMap = makeFreshLineIdMap({ centerLines: [{ id: 'cl-1' }] });
  const newId = idMap.get('cl-1');
  assert.match(newId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
});
