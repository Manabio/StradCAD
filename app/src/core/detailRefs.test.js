// 建具 1 件の部分詳細図の上書き（Opening.detailRefs）の正規形（core/detailRefs.js）の単体テスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDetailRefs, withDetailRef } from './detailRefs.js';
import { DetailSlot } from './constants.js';

const { JAMB, HEAD } = DetailSlot;

test('normalizeDetailRefs: 空の写像・null・undefined・配列・文字列は null に正規化する', () => {
  assert.equal(normalizeDetailRefs({}), null);
  assert.equal(normalizeDetailRefs(null), null);
  assert.equal(normalizeDetailRefs(undefined), null);
  assert.equal(normalizeDetailRefs(['df-1']), null);
  assert.equal(normalizeDetailRefs('df-1'), null);
});

test('normalizeDetailRefs: 空文字・null・文字列でない値は捨て、全部捨てたら null。残りはキー昇順の凍結オブジェクト', () => {
  assert.equal(normalizeDetailRefs({ [JAMB]: '', [HEAD]: null, sill: 3, nageshi: undefined }), null);
  const n = normalizeDetailRefs({ [JAMB]: 'df-j', [HEAD]: 'df-h', sill: '' });
  assert.deepEqual(n, { [HEAD]: 'df-h', [JAMB]: 'df-j' });
  assert.deepEqual(Object.keys(n), [HEAD, JAMB], 'キーは昇順（挿入順に依らない）');
  assert.ok(Object.isFrozen(n));
  assert.equal(JSON.stringify(normalizeDetailRefs({ [JAMB]: 'a', [HEAD]: 'b' })), JSON.stringify(normalizeDetailRefs({ [HEAD]: 'b', [JAMB]: 'a' })));
});

test('normalizeDetailRefs: 全 slot（sill・sashSection・nageshi・shikii）をデータとして通す', () => {
  const all = { [DetailSlot.JAMB]: 'a', [DetailSlot.HEAD]: 'b', [DetailSlot.SILL]: 'c', [DetailSlot.SASH_SECTION]: 'd', [DetailSlot.NAGESHI]: 'e', [DetailSlot.SHIKII]: 'f' };
  assert.deepEqual({ ...normalizeDetailRefs(all) }, all);
});

test('withDetailRef: 追加・差し替え・外すを元を変えずに行い、最後の 1 件を外すと null', () => {
  const a = withDetailRef(null, JAMB, 'df-1');
  assert.deepEqual(a, { [JAMB]: 'df-1' });
  const b = withDetailRef(a, HEAD, 'df-2');
  assert.deepEqual(b, { [HEAD]: 'df-2', [JAMB]: 'df-1' });
  assert.deepEqual(a, { [JAMB]: 'df-1' }, '元は変えない');
  assert.deepEqual(withDetailRef(b, JAMB, 'df-3'), { [HEAD]: 'df-2', [JAMB]: 'df-3' });
  assert.deepEqual(withDetailRef(b, JAMB, ''), { [HEAD]: 'df-2' });
  assert.equal(withDetailRef(a, JAMB, ''), null);
  assert.equal(withDetailRef(a, JAMB, null), null);
  assert.equal(withDetailRef(null, JAMB, ''), null, '無いものを外しても null のまま');
});
