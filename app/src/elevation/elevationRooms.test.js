// buildBandsSafely の回帰テスト（QA F4: 1部屋の帯構築失敗で他の部屋・モード全体が
// 巻き込まれてはいけない）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBandsSafely } from './elevationRooms.js';

test('buildBandsSafely: 全部屋が成功すればbandsに全件・failedRoomNamesは空', () => {
  const rooms = [{ id: 'r1', name: 'A' }, { id: 'r2', name: 'B' }];
  const { bands, failedRoomNames } = buildBandsSafely(rooms, room => ({ roomId: room.id }));
  assert.deepEqual(bands.map(b => b.roomId), ['r1', 'r2']);
  assert.deepEqual(failedRoomNames, []);
});

// ---- 失敗系: 1部屋のbuildOneが例外を投げても他の部屋のbandは保持される ----
test('【失敗系】buildBandsSafely: 1部屋の構築失敗があっても他の部屋のbandは保持され、失敗部屋名が返る', () => {
  const rooms = [{ id: 'r1', name: 'A' }, { id: 'r2', name: 'B' }, { id: 'r3', name: 'C' }];
  const errors = [];
  const { bands, failedRoomNames } = buildBandsSafely(
    rooms,
    room => {
      if (room.id === 'r2') throw new Error('boom');
      return { roomId: room.id };
    },
    (err, room) => errors.push({ err, room }),
  );

  assert.deepEqual(bands.map(b => b.roomId), ['r1', 'r3'], '失敗した部屋だけ除外され他は残る');
  assert.deepEqual(failedRoomNames, ['B']);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].room.id, 'r2');
  assert.equal(errors[0].err.message, 'boom');
});

// ---- 失敗系: 全部屋が失敗しても例外を投げず空配列を返す ----
test('【失敗系】buildBandsSafely: 全部屋が失敗しても例外を投げずbands=[]・failedRoomNamesに全件', () => {
  const rooms = [{ id: 'r1', name: 'A' }, { id: 'r2', name: 'B' }];
  const { bands, failedRoomNames } = buildBandsSafely(rooms, () => { throw new Error('boom'); });
  assert.deepEqual(bands, []);
  assert.deepEqual(failedRoomNames, ['A', 'B']);
});

// ---- name未設定時はidを失敗名として使う ----
test('buildBandsSafely: room.nameが空ならroom.idをfailedRoomNamesに使う', () => {
  const rooms = [{ id: 'r1', name: '' }];
  const { failedRoomNames } = buildBandsSafely(rooms, () => { throw new Error('boom'); });
  assert.deepEqual(failedRoomNames, ['r1']);
});
