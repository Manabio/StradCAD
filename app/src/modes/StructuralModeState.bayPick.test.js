// StructuralModeState の S造スラブ指定ベイ選択（bayPick。startBayPick / toggleBay / cancelBayPick）の単体テスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StructuralModeState } from './StructuralModeState.js';

const BAYS = [{ key: 'a:b:c:d', cell: {} }, { key: 'c:b:e:d', cell: {} }];
const RECTS = [{ x1: 0, x2: 1, y1: 0, y2: 1, source: 'void' }];

function started() {
  const s = new StructuralModeState(null);
  s.startBayPick({ bays: BAYS, openingRects: RECTS });
  return s;
}

test('startBayPick: bays・openingRects を保持し、選択は空から始まる', () => {
  const s = started();
  assert.equal(s.bayPick.bays, BAYS);
  assert.equal(s.bayPick.openingRects, RECTS);
  assert.equal(s.bayPick.selectedKeys.size, 0);
});

test('toggleBay: 選択・解除を切り替え、選択集合は bays のキーの部分集合のまま', () => {
  const s = started();
  s.toggleBay('a:b:c:d');
  s.toggleBay('c:b:e:d');
  assert.deepEqual([...s.bayPick.selectedKeys].sort(), ['a:b:c:d', 'c:b:e:d']);
  s.toggleBay('a:b:c:d');
  assert.deepEqual([...s.bayPick.selectedKeys], ['c:b:e:d']);
  s.toggleBay('c:b:e:d');
  assert.equal(s.bayPick.selectedKeys.size, 0);
  assert.equal(s.bayPick.bays, BAYS, 'bays は不変');
});

test('【失敗系】toggleBay: bays に無いキー・選択中でないときは無視する（例外なし・状態不変）', () => {
  const s = started();
  s.toggleBay('no:such:bay:key');
  assert.equal(s.bayPick.selectedKeys.size, 0, '未知のキーは選択されない');
  const idle = new StructuralModeState(null);
  assert.doesNotThrow(() => idle.toggleBay('a:b:c:d'));
  assert.equal(idle.bayPick, null);
});

test('cancelBayPick / clearSelection / dispose: いずれも選択状態を閉じる', () => {
  const s = started();
  s.toggleBay('a:b:c:d');
  s.cancelBayPick();
  assert.equal(s.bayPick, null);
  const t = started();
  t.clearSelection();
  assert.equal(t.bayPick, null);
  const u = started();
  u.dispose();
  assert.equal(u.bayPick, null);
});
