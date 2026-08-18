// structuralOrchestration.test.js と同じ方針: FloorSwapManager は mobx（autorun）+
// graphSnapshot.js + db.js（indexedDB アクセス）から成る。activate/deactivate/peek/saveNow/
// setupStructGraph は indexedDB.open に到達するため node:test 環境（indexedDB 未定義。
// 事前検証で ReferenceError: indexedDB is not defined を確認済み。fake-indexeddb 等の新規
// 依存追加は本タスクの範囲外）ではテスト不能。
//
// startEditablePeek/flushEditablePeek/stopEditablePeek の「デバウンスタイマーの張り／解除」
// 自体は autorun の同期的な副作用であり indexedDB を経由しないため、ここでは
// 「flushEditablePeek が保留中タイマーの有無で分岐する（＝保留が無ければ saveFloor を
// 呼ばずautorunも維持する。保留があればsaveFloor経由でindexedDBへ到達しようとする）」
// ことだけを検証する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph } from '../core.js';
import { FloorSwapManager } from './FloorSwapManager.js';

function makeGraph(planeId = 'p1') {
  const plane = new Plane(planeId, 0, `${planeId}階`, 1, 1);
  return { plane, graph: new PlanGraph(plane) };
}

test('flushEditablePeek: 保留中のデバウンス保存が無ければ saveFloor を呼ばず即座に解決し、autorunはdisposeされない', async () => {
  const mgr = new FloorSwapManager();
  const { plane, graph } = makeGraph();

  mgr.startEditablePeek(plane, graph);
  // startEditablePeek直後は autorun の初回実行のみ（initialized=trueで戻るだけ）。
  // デバウンスタイマーはまだ張られていないため、flushEditablePeekはsaveFloor（indexedDB）
  // に到達せず即解決するはず——到達していたら node:test 環境では reject するため検出できる。
  await assert.doesNotReject(mgr.flushEditablePeek());

  // stopEditablePeekと異なり dispose されていないことを確認する（_peekCleanupが生存）。
  assert.notEqual(mgr._peekCleanup, null, 'flushEditablePeekはautorunをdisposeしない（stopEditablePeekと違う）');

  await mgr.stopEditablePeek(); // 後始末（このテストでは保留タイマーが無いためindexedDBに到達しない）
  assert.equal(mgr._peekCleanup, null);
});

test('flushEditablePeek: startEditablePeekを呼んでいない（保留中の下階編集チャネルが無い）状態では何もせず即座に解決する', async () => {
  const mgr = new FloorSwapManager();
  await assert.doesNotReject(mgr.flushEditablePeek());
});

test('flushEditablePeek: 保留中のデバウンス保存があればsaveFloor経由でindexedDBへ到達を試みる（未定義環境のためreject＝到達の証跡）', async () => {
  const mgr = new FloorSwapManager();
  const { plane, graph } = makeGraph();
  mgr.startEditablePeek(plane, graph);

  // グラフを変更してautorunを再実行させ、デバウンスタイマーを張る（400ms待たずflushで確定させる）
  graph.addPoint(0, 0);

  await assert.rejects(
    mgr.flushEditablePeek(),
    /indexedDB is not defined/,
    'pending timerがあればsaveFloor（indexedDB）へ到達する経路が呼ばれる証跡として、node:test環境でのreject（indexedDB未定義）を確認する',
  );

  // flush後もautorun自体はdisposeされていない（timerはflush時に同期的にnullへ戻るため、
  // 直後のstopEditablePeekは保留分の再送を試みず正常終了する）。
  assert.notEqual(mgr._peekCleanup, null);
  await assert.doesNotReject(mgr.stopEditablePeek());
});
