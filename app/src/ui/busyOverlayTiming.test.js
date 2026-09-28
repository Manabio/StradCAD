import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LABEL_DELAY_MS, WARN_AFTER_MS, formatBusyLabel } from './busyOverlayTiming.js';

test('LABEL_DELAY_MS / WARN_AFTER_MS: 想定どおりの値（遅延ラベル400ms・長時間警告15秒）', () => {
  assert.equal(LABEL_DELAY_MS, 400);
  assert.equal(WARN_AFTER_MS, 15000);
});

test('formatBusyLabel: labelがnullなら既定文言「処理中…」を返す', () => {
  assert.equal(formatBusyLabel(null), '処理中…');
});

test('formatBusyLabel: labelがあれば末尾に「中…」を付けて返す', () => {
  assert.equal(formatBusyLabel('CL削除'), 'CL削除中…');
  assert.equal(formatBusyLabel('階切替'), '階切替中…');
});

test('【失敗系】formatBusyLabel: 空文字列もnullと同様に既定文言を返す', () => {
  assert.equal(formatBusyLabel(''), '処理中…');
});
