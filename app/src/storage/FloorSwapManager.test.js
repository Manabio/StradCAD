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
import { runInAction } from 'mobx';
import { Plane, PlanGraph, Site, SiteLineKind, CenterLineType, Discipline } from '../core.js';
import { FloorSwapManager } from './FloorSwapManager.js';
import { isDirty, clearDirty } from '../dirtyState.js';

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

// ----------------------------------------------------------------
// startSiteDirtyTracking/disposeSiteDirtyTracking（敷地dirty追跡）
//
// mobx（autorun）+ core/site.js（Site）+ dirtyState.js（markDirty/isDirty）だけで完結し、
// indexedDB を経由しないため node:test 環境で直接検証できる。dirtyState.js はモジュール
// スコープの状態（_dirty）を持つため、各testは冒頭で clearDirty() して前testの汚染を断つ。
// ----------------------------------------------------------------

test('startSiteDirtyTracking: 開始直後（初回autorunの同期実行）はmarkDirtyしない', () => {
  clearDirty();
  const mgr  = new FloorSwapManager();
  const site = new Site();

  mgr.startSiteDirtyTracking(site);

  assert.equal(isDirty(), false, '初回autorun実行はinitializedフラグを立てるだけでmarkDirtyしない');
  mgr.disposeSiteDirtyTracking();
});

test('startSiteDirtyTracking: 点の座標だけが動く編集（辺長編集相当）でmarkDirtyする', () => {
  clearDirty();
  const mgr  = new FloorSwapManager();
  const site = new Site();
  const pt   = site.addPoint(0, 0);

  mgr.startSiteDirtyTracking(site);
  assert.equal(isDirty(), false, '前提: 開始直後はdirtyでない');

  runInAction(() => { pt.x = 100; });

  assert.equal(isDirty(), true, '点のx座標変更（p.x観測）でmarkDirtyされる（editSiteLineLength等の辺長編集相当）');
  mgr.disposeSiteDirtyTracking();
});

test('startSiteDirtyTracking: lineKindだけが変わる編集でmarkDirtyする', () => {
  clearDirty();
  const mgr  = new FloorSwapManager();
  const site = new Site();
  const sp   = site.addPoint(0, 0);
  const ep   = site.addPoint(1000, 0);
  const line = site.addLine(sp, ep, SiteLineKind.SURVEY);

  mgr.startSiteDirtyTracking(site);
  assert.equal(isDirty(), false, '前提: 開始直後はdirtyでない');

  runInAction(() => { line.lineKind = SiteLineKind.BOUNDARY; });

  assert.equal(isDirty(), true, 'lineKind変更（l.lineKind観測）でmarkDirtyされる（cycleSiteLineKind相当）');
  mgr.disposeSiteDirtyTracking();
});

test('startSiteDirtyTracking: history.push（三角形確定相当）でmarkDirtyする', () => {
  clearDirty();
  const mgr  = new FloorSwapManager();
  const site = new Site();

  mgr.startSiteDirtyTracking(site);
  assert.equal(isDirty(), false, '前提: 開始直後はdirtyでない');

  runInAction(() => { site.history.push({ type: 'base', lineId: 'dummy', length: 1000 }); });

  assert.equal(isDirty(), true, 'history.length観測でmarkDirtyされる（confirmSiteTriangle等の三角形確定相当）');
  mgr.disposeSiteDirtyTracking();
});

test('【失敗系】startSiteDirtyTracking: disposeSiteDirtyTracking後は変更してもmarkDirtyしない', () => {
  clearDirty();
  const mgr  = new FloorSwapManager();
  const site = new Site();
  const pt   = site.addPoint(0, 0);

  mgr.startSiteDirtyTracking(site);
  mgr.disposeSiteDirtyTracking();

  runInAction(() => { pt.x = 999; });

  assert.equal(isDirty(), false, 'disposeされたautorunは変更を観測しないためmarkDirtyされない');
});

test('startSiteDirtyTracking: 二重呼び出しでautorunが二重登録されない（2回呼び→1回dispose→変更→isDirty()===false）', () => {
  clearDirty();
  const mgr  = new FloorSwapManager();
  const site = new Site();
  const pt   = site.addPoint(0, 0);

  mgr.startSiteDirtyTracking(site);
  mgr.startSiteDirtyTracking(site); // 2回目（二重登録されていれば2本のautorunが生きてしまう）

  mgr.disposeSiteDirtyTracking(); // 1回のdisposeで完全停止するはず

  runInAction(() => { pt.x = 500; });

  assert.equal(isDirty(), false, '二重登録されていれば1回のdisposeでは止まらずmarkDirtyされてしまう（多重登録ガードの検証）');
});

// ----------------------------------------------------------------
// _healDerivedGeometry（読み込み経路の導出幾何の復元）
//
// activate/peek は indexedDB.open に到達するためここでは呼べないが、その両方が
// restoreGraph の直後に通す _healDerivedGeometry 自体は純粋な壁操作のため直接検証できる。
// 「出隅の取り合いは仕上げモード脱出でしか閉じない」ままだと、そのロジックより古い保存
// データは何度読み直しても欠けたまま残る（実機指摘2026-08「21」の2階 X2×Y2+3500）。
// ----------------------------------------------------------------

test('_healDerivedGeometry: 読み込んだグラフの開いたままの出隅を閉じ直す（古い保存データの自己修復）', () => {
  const mgr = new FloorSwapManager();
  const { graph } = makeGraph();
  const cl = (type, v) => graph.addCenterLine(type, v, { labeled: false, discipline: Discipline.ARCH });
  const x0 = cl(CenterLineType.VERTICAL, 0), xW = cl(CenterLineType.VERTICAL, -6000);
  const y0 = cl(CenterLineType.HORIZONTAL, 0), yN = cl(CenterLineType.HORIZONTAL, -6000);
  // 保存データ相当: 角を挟む2枚が互いの軸CL上（=材の中心）でちょうど止まっている＝欠けた状態
  const v = graph.addWall(x0, 57.5, true, yN, 0, y0, 0, { isRoomWall: true, wallFinish: 12.5 });
  const h = graph.addWall(y0, 57.5, false, xW, 0, x0, 0, { isRoomWall: true, wallFinish: 12.5 });

  mgr._healDerivedGeometry(graph);

  assert.equal(v.coord2, 57.5, '垂直壁が水平壁の材の外面まで伸びるはず');
  assert.equal(h.coord2, 57.5, '水平壁が垂直壁の材の外面まで伸びるはず');
});

test('【失敗系】_healDerivedGeometry: 既に閉じているデータには何もしない（冪等。読み込みのたびに動かない）', () => {
  const mgr = new FloorSwapManager();
  const { graph } = makeGraph();
  const cl = (type, v) => graph.addCenterLine(type, v, { labeled: false, discipline: Discipline.ARCH });
  const x0 = cl(CenterLineType.VERTICAL, 0), xW = cl(CenterLineType.VERTICAL, -6000);
  const y0 = cl(CenterLineType.HORIZONTAL, 0), yN = cl(CenterLineType.HORIZONTAL, -6000);
  const v = graph.addWall(x0, 57.5, true, yN, 0, y0, 57.5, { isRoomWall: true, wallFinish: 12.5 });
  const h = graph.addWall(y0, 57.5, false, xW, 0, x0, 57.5, { isRoomWall: true, wallFinish: 12.5 });

  mgr._healDerivedGeometry(graph);
  mgr._healDerivedGeometry(graph);

  assert.equal(v.coord2, 57.5);
  assert.equal(h.coord2, 57.5);
});
