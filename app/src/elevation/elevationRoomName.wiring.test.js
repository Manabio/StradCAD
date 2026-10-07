// 展開図の部屋の表示名は elevationRoomDisplayName を唯一の供給源にする（裁定2026-10-07: 無名の階段室は「階段」）。
// 帯の見出し枠・失敗通知・コンソールログが room.name を直接読むと無名の階段室で空欄になるため、
// ソーステキスト検査で配線を固定する（RoomNameInput.wiring.test.js と同じ型。コメントを除去してから検査する）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildBandsSafely } from './elevationRooms.js';

function codeOf(rel) {
  const text = fs.readFileSync(path.resolve(import.meta.dirname, rel), 'utf8');
  return text.replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/)
    .filter(line => !line.trim().startsWith('//')).join('\n');
}

const CONSUMERS = ['elevationBand.js', 'elevationRooms.js', '../modes/ElevationModeState.js'];

for (const rel of CONSUMERS) {
  test(`【不変条件】${rel}: elevationRoomDisplayName を使い、room.name を直接読まない`, () => {
    const code = codeOf(rel);
    assert.ok(/elevationRoomDisplayName\(/.test(code), 'elevationRoomDisplayName( の呼び出しが無い');
    assert.ok(!/\broom\.name\b/.test(code), 'room.name を直接読んでいる（表示名は elevationRoomDisplayName 経由）');
  });
}

test('buildBandsSafely: 無名の階段室が失敗しても失敗部屋名は「階段」', () => {
  const rooms = [{ id: 's1', name: '', feature: 'stair' }, { id: 'p1', name: '', feature: null }];
  const { failedRoomNames } = buildBandsSafely(rooms, () => { throw new Error('boom'); });
  assert.deepEqual(failedRoomNames, ['階段', 'p1']);
});
