import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noteFloorWrite, noteAllFloorsWritten, floorWriteGeneration } from './floorWriteGeneration.js';

// 世代はモジュールスコープの状態（同一ファイル内のtestは同じプロセスで順に走る）——絶対値では
// なく形式で確かめ、宣言順に依存させない。
test('floorWriteGeneration: 未書込みのplaneは書込み回数0（"epoch:0"形式）を返す', () => {
  assert.match(floorWriteGeneration('未使用のplaneId'), /^\d+:0$/);
});

test('noteFloorWrite: 同一planeへ2回書くと世代が2回変わる（別値になる）', () => {
  const planeId = 'p-same';
  const g0 = floorWriteGeneration(planeId);
  noteFloorWrite(planeId);
  const g1 = floorWriteGeneration(planeId);
  assert.notEqual(g1, g0, '1回目の書込みで世代が変わる');
  noteFloorWrite(planeId);
  const g2 = floorWriteGeneration(planeId);
  assert.notEqual(g2, g1, '2回目の書込みでさらに世代が変わる');
});

test('noteFloorWrite: 別planeの世代には影響しない', () => {
  const other = 'p-untouched';
  const before = floorWriteGeneration(other);
  noteFloorWrite('p-touched');
  assert.equal(floorWriteGeneration(other), before, '書いていないplaneの世代は不変');
});

test('noteAllFloorsWritten: 既に書込み済みのplane・未書込みのplaneの両方の世代が変わる', () => {
  const touched = 'p-touched-2';
  const untouched = 'p-untouched-2';
  noteFloorWrite(touched);
  const touchedBefore = floorWriteGeneration(touched);
  const untouchedBefore = floorWriteGeneration(untouched);

  noteAllFloorsWritten();

  assert.notEqual(floorWriteGeneration(touched), touchedBefore, '既存planeの世代も変わる');
  assert.notEqual(floorWriteGeneration(untouched), untouchedBefore, '未書込みのplaneの世代も変わる（epoch一括更新）');
});
