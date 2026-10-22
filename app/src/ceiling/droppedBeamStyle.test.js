// droppedBeamStyle.js（下がり梁の外形を中線にする後処理）の単体テスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markDroppedBeamLines, DROPPED_BEAM_WEIGHT } from './droppedBeamStyle.js';

const line = (id, kind, extra = {}) => ({
  kind: 'line', key: `${kind}:${id}`, points: [0, 0, 100, 0], weight: 'thin', cls: 'below', detailOnly: false,
  source: { kind, id, ...(extra.source ?? {}) }, ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== 'source')),
});

test('下がり梁の見え掛かりの線（自階の層・cls below）だけが中線になり、droppedBeam が付く。入力は変更しない', () => {
  const prims = [line('b1', 'beam'), line('b2', 'beam'), line('c1', 'ceiling')];
  const before = JSON.stringify(prims);
  const out = markDroppedBeamLines(prims, ['b1']);
  assert.equal(DROPPED_BEAM_WEIGHT, 'medium');
  assert.equal(out[0].weight, 'medium');
  assert.equal(out[0].droppedBeam, true);
  assert.equal(out[1], prims[1], '下がり梁でない梁はそのまま');
  assert.equal(out[2], prims[2], '天井の線はそのまま');
  assert.equal(JSON.stringify(prims), before);
});

test('対象外: cut の線・上階の層の梁・線でない prim・別の id は触らない', () => {
  const cut = line('b1', 'beam', { cls: 'cut', weight: 'thick' });
  const upper = line('b1', 'beam', { source: { layerFloorZ: 2800 } });
  const label = { kind: 'label', source: { kind: 'beam', id: 'b1' }, cls: 'below' };
  const out = markDroppedBeamLines([cut, upper, label], ['b1']);
  assert.deepEqual(out, [cut, upper, label]);
  assert.equal(out[0], cut);
});

test('【失敗系】下がり梁の id が無い・prims が配列でない・undefined の線は例外にせずそのまま返す', () => {
  const prims = [line('b1', 'beam')];
  assert.equal(markDroppedBeamLines(prims, []), prims);
  assert.equal(markDroppedBeamLines(prims, undefined), prims);
  assert.equal(markDroppedBeamLines(null, ['b1']), null);
  assert.deepEqual(markDroppedBeamLines([undefined, null], ['b1']), [undefined, null]);
});
