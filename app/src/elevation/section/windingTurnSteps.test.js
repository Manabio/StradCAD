// windingTurnSteps.js（回り階段の回転部を段付きの踊り場＝短冊の列へ近似する純モジュール）の単体テスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { windingTurnSteps } from './windingTurnSteps.js';

// 縦（走行軸が y）の回転部: 手前の縁 y=1500・奥の縁 y=0、幅方向 x:0(S0)・1000(Mid)・2000(S1)。
const BASE = {
  vertical: true, runFront: 1500, runBack: 0, acrossS0: 0, acrossMid: 1000, acrossS1: 2000, z0: 1000, riser: 200,
};
const rect = s => [s.runLo, s.runHi, s.acrossLo, s.acrossHi, s.z];

test('windingTurnSteps: w=6（偶数）は往路側の半幅3枚が手前→奥へ、復路側の半幅3枚が奥→手前へ、高さは z0+(j-1)r', () => {
  const steps = windingTurnSteps({ ...BASE, cells: 6 });
  assert.equal(steps.length, 6);
  assert.deepEqual(steps.map(rect), [
    [1000, 1500, 0, 1000, 1000],     // j=1 往路側・手前
    [500, 1000, 0, 1000, 1200],      // j=2
    [0, 500, 0, 1000, 1400],         // j=3 往路側・奥
    [0, 500, 1000, 2000, 1600],      // j=4 復路側・奥
    [500, 1000, 1000, 2000, 1800],   // j=5
    [1000, 1500, 1000, 2000, 2000],  // j=6 復路側・手前（復路の足元）
  ]);
  assert.deepEqual(steps.map(s => s.turnStep), [1, 2, 3, 4, 5, 6]);
  assert.ok(steps.every(s => s.isVertical === true && s.frame.edges.length === 0), '桁枠は持たず、走行軸の向きを持つ');
});

test('windingTurnSteps: w=3（奇数）は奥の短冊だけ全幅の段（j=2）になり、手前の短冊は往路側・復路側の半幅', () => {
  const steps = windingTurnSteps({ ...BASE, cells: 3 });
  assert.deepEqual(steps.map(rect), [
    [750, 1500, 0, 1000, 1000],      // j=1 往路側・手前
    [0, 750, 0, 2000, 1200],         // j=2 奥の全幅
    [750, 1500, 1000, 2000, 1400],   // j=3 復路側・手前
  ]);
});

test('windingTurnSteps: w=2 は往路側・復路側の半幅が同じ奥行き全体を使う', () => {
  const steps = windingTurnSteps({ ...BASE, cells: 2 });
  assert.deepEqual(steps.map(rect), [
    [0, 1500, 0, 1000, 1000],
    [0, 1500, 1000, 2000, 1200],
  ]);
});

test('windingTurnSteps: w=1 は回転部の矩形1枚（折返しの踊り場と同形）', () => {
  const steps = windingTurnSteps({ ...BASE, cells: 1 });
  assert.deepEqual(steps.map(rect), [[0, 1500, 0, 2000, 1000]]);
});

test('windingTurnSteps: 向きが逆（runBack>runFront・S0>S1）でも runLo<runHi・acrossLo<acrossHi で、往路側はS0側に付く', () => {
  const steps = windingTurnSteps({
    ...BASE, vertical: false, runFront: 0, runBack: 1500, acrossS0: 2000, acrossMid: 1000, acrossS1: 0, cells: 4,
  });
  assert.equal(steps.length, 4);
  for (const s of steps) {
    assert.ok(s.runLo < s.runHi && s.acrossLo < s.acrossHi, JSON.stringify(s));
    assert.equal(s.isVertical, false);
  }
  assert.deepEqual(steps.map(rect), [
    [0, 750, 1000, 2000, 1000],      // j=1 往路側（S0=2000 側）・手前
    [750, 1500, 1000, 2000, 1200],   // j=2 往路側・奥
    [750, 1500, 0, 1000, 1400],      // j=3 復路側（S1=0 側）・奥
    [0, 750, 0, 1000, 1600],         // j=4 復路側・手前
  ]);
});

test('windingTurnSteps: 短冊の面積の和は回転部の矩形の面積に等しく、互いに重ならない（w=1..9）', () => {
  for (let w = 1; w <= 9; w++) {
    const steps = windingTurnSteps({ ...BASE, cells: w });
    assert.equal(steps.length, w);
    const area = steps.reduce((a, s) => a + (s.runHi - s.runLo) * (s.acrossHi - s.acrossLo), 0);
    assert.ok(Math.abs(area - 1500 * 2000) < 1e-6, `w=${w} 面積=${area}`);
    for (let i = 0; i < steps.length; i++) {
      for (let j = i + 1; j < steps.length; j++) {
        const a = steps[i], b = steps[j];
        const overlap = a.runLo < b.runHi - 1e-9 && b.runLo < a.runHi - 1e-9
          && a.acrossLo < b.acrossHi - 1e-9 && b.acrossLo < a.acrossHi - 1e-9;
        assert.ok(!overlap, `w=${w} の ${i + 1} 段と ${j + 1} 段が重なる`);
      }
    }
  }
});

test('【失敗系】windingTurnSteps: 非有限・w が 1 未満または整数でない・奥行き 0 は空配列（例外なし）', () => {
  assert.deepEqual(windingTurnSteps({ ...BASE, cells: 0 }), []);
  assert.deepEqual(windingTurnSteps({ ...BASE, cells: -2 }), []);
  assert.deepEqual(windingTurnSteps({ ...BASE, cells: 2.5 }), []);
  assert.deepEqual(windingTurnSteps({ ...BASE, cells: NaN }), []);
  assert.deepEqual(windingTurnSteps({ ...BASE, cells: 6, runBack: NaN }), []);
  assert.deepEqual(windingTurnSteps({ ...BASE, cells: 6, z0: undefined }), []);
  assert.deepEqual(windingTurnSteps({ ...BASE, cells: 6, runBack: 1500 }), [], '奥行き0');
});
