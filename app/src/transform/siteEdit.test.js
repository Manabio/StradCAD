// centerLineOps.test.js と同じ方針: ダックタイピングでは Site の observable 配列
// (history/lineOrder) の実挙動を再現できないため、実 core/site.js の Site を使う。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Site, SiteLineKind } from '../core.js';
import { undoManager } from '../undoManager.js';
import {
  editSiteLineLength, confirmSiteLineLen, confirmSiteTriangle, cycleSiteLineKind, commitSiteTapLine,
  deleteSiteTriangle, deleteSiteBaseLine, deleteSiteRow, TOAST_TRI_DELETE_LOCKED, TOAST_BASE_DELETE_LOCKED,
} from './siteEdit.js';
import { SiteModeState } from '../modes/SiteModeState.js';
import { cloneHistory, computePendingQueue } from './siteHistory.js';
import { computeLineTriNums, computeOuterLineIds } from '../site/lineClassification.js';

const evalExpr = (s) => Number(s);

// ---- cycleSiteLineKind ----

test('cycleSiteLineKind: 外周の線は無指定(SURVEY)⇄道路(ROAD)の2値トグルで、undoで直前の線種に戻る', () => {
  const site = new Site();
  const sp   = site.addPoint(0, 0);
  const ep   = site.addPoint(1000, 0);
  const line = site.addLine(sp, ep, SiteLineKind.SURVEY);

  assert.deepEqual(cycleSiteLineKind(site, line.id), { ok: true });
  assert.equal(line.lineKind, SiteLineKind.ROAD);

  cycleSiteLineKind(site, line.id);
  assert.equal(line.lineKind, SiteLineKind.SURVEY);

  undoManager.undo();
  assert.equal(line.lineKind, SiteLineKind.ROAD, '直前の切替（道路）に戻る');
});

test('cycleSiteLineKind: 旧BOUNDARYは無指定扱いで次はROAD', () => {
  const site = new Site();
  const line = site.addLine(site.addPoint(0, 0), site.addPoint(1000, 0), SiteLineKind.BOUNDARY);
  cycleSiteLineKind(site, line.id);
  assert.equal(line.lineKind, SiteLineKind.ROAD);
});

test('cycleSiteLineKind【失敗系】: 内側の線（三角形2つの共有辺）・存在しないidは何も変えず{ok:false}でundoも積まない', () => {
  const site = new Site();
  const sp = site.addPoint(0, 0), ep = site.addPoint(1000, 0), ap = site.addPoint(640, 480), ap2 = site.addPoint(-200, 600);
  const base = site.addLine(sp, ep, SiteLineKind.SURVEY);
  site.addTriangle(base, ap, SiteLineKind.SURVEY);
  const red  = site.addLine(sp, ap, SiteLineKind.SURVEY);
  site.addLine(ep, ap, SiteLineKind.SURVEY);
  site.addTriangle(red, ap2, SiteLineKind.SURVEY); // red は2つの三角形に属する＝内側
  site.addLine(sp, ap2, SiteLineKind.SURVEY);
  site.addLine(ap, ap2, SiteLineKind.SURVEY);
  const beforeTop = undoManager.peekUndo();

  assert.deepEqual(cycleSiteLineKind(site, red.id), { ok: false });
  assert.equal(red.lineKind, SiteLineKind.SURVEY, '内側の線は変わらない');
  assert.deepEqual(cycleSiteLineKind(site, 'no-such-id'), { ok: false });
  assert.equal(undoManager.peekUndo(), beforeTop, 'undoは積まれない');
});

// ---- editSiteLineLength ----

test('editSiteLineLength: base線分の辺長編集でendPointとhistory[0].lengthが更新され、undoで元に戻る', () => {
  const site = new Site();
  const sp   = site.addPoint(0, 0);
  const ep   = site.addPoint(1000, 0);
  const line = site.addLine(sp, ep, SiteLineKind.SURVEY);
  site.history.push({ type: 'base', lineId: line.id, length: line.length });

  const result = editSiteLineLength(site, line.id, 2000);

  assert.equal(result.ok, true);
  assert.equal(result.toast, null);
  assert.equal(ep.x, 2000);
  assert.equal(site.history[0].length, 2000);

  undoManager.undo();
  assert.equal(ep.x, 1000, 'undoでendPointの座標が戻る');
  assert.equal(site.history[0].length, 1000, 'undoでhistoryの記録済み長さも戻る');
});

test('editSiteLineLength: history に登録されていない線分は編集不可（ok:false）でundoも積まれない', () => {
  const site = new Site();
  const sp   = site.addPoint(0, 0);
  const ep   = site.addPoint(1000, 0);
  const line = site.addLine(sp, ep, SiteLineKind.SURVEY);
  // history未登録（三斜入力の起点でない線分）
  const beforeTop = undoManager.peekUndo();

  const result = editSiteLineLength(site, line.id, 500);

  assert.equal(result.ok, false);
  assert.equal(result.toast, '編集できない線分です');
  assert.equal(undoManager.peekUndo(), beforeTop, 'undoは積まれない');
});

test('editSiteLineLength: 三角形の再計算が失敗（辺長不正）した場合は座標とhistoryをロールバックしundoを積まない', () => {
  const site = new Site();
  const sp = site.addPoint(0, 0);
  const ep = site.addPoint(1000, 0);
  const baseLine = site.addLine(sp, ep, SiteLineKind.SURVEY);
  site.history.push({ type: 'base', lineId: baseLine.id, length: baseLine.length });

  // 既存の三角形（底辺1000・赤辺800・青辺600）を手動構築（confirmSiteTriangle相当）
  const apexPt   = site.addPoint(640, 480);
  const tri      = site.addTriangle(baseLine, apexPt, SiteLineKind.SURVEY);
  const redLine  = site.addLine(sp, apexPt, SiteLineKind.BOUNDARY);
  const blueLine = site.addLine(ep, apexPt, SiteLineKind.ROAD);
  site.history.push({
    type: 'triangle', baseLineId: baseLine.id,
    redLineId: redLine.id, redLen: 800, redKind: SiteLineKind.BOUNDARY,
    blueLineId: blueLine.id, blueLen: 600, blueKind: SiteLineKind.ROAD,
    triangleId: tri.id, triangleLineKind: SiteLineKind.SURVEY, side: 1,
  });
  const beforeTop = undoManager.peekUndo();

  // 赤辺を100へ編集 → 100+600=700 < 底辺1000 で三角形が成立しない
  const result = editSiteLineLength(site, redLine.id, 100);

  assert.equal(result.ok, false);
  assert.equal(result.toast, '三角形を構成できません（辺長が不正）');
  assert.equal(apexPt.x, 640, '頂点座標がロールバックされる');
  assert.equal(apexPt.y, 480, '頂点座標がロールバックされる');
  assert.equal(site.history[1].redLen, 800, 'historyのredLenもロールバックされる');
  assert.equal(undoManager.peekUndo(), beforeTop, 'undoは積まれない');
});

// ---- confirmSiteLineLen（editSiteLineLengthへの委譲＋inputStateのクリア） ----

test('confirmSiteLineLen: focusedCell=lenで有効な数値なら辺長を確定しclearInputを呼ぶ', () => {
  const site = new Site();
  const sp   = site.addPoint(0, 0);
  const ep   = site.addPoint(1000, 0);
  const line = site.addLine(sp, ep, SiteLineKind.SURVEY);
  site.history.push({ type: 'base', lineId: line.id, length: line.length });

  let cleared = false;
  const mode = {
    inputState:   { focusedCell: 'len', lenValue: '2000' }, // redLen===undefined → 編集のみモード
    selectedLine: line,
    clearInput()      { cleared = true; },
    setFocusedCell()  {},
  };

  const result = confirmSiteLineLen(site, mode, evalExpr);

  assert.equal(result.toast, null);
  assert.equal(ep.x, 2000);
  assert.equal(cleared, true, '編集のみモードではclearInputが呼ばれる');
});

test('confirmSiteLineLen: 無効値（空文字/0以下）はlenValueを現在長へ戻すだけでSiteは変わらない（編集専用/三斜入力の両分岐）', () => {
  const site = new Site();
  const sp   = site.addPoint(0, 0);
  const ep   = site.addPoint(1000, 0);
  const line = site.addLine(sp, ep, SiteLineKind.SURVEY);
  site.history.push({ type: 'base', lineId: line.id, length: line.length });
  const beforeTop = undoManager.peekUndo();

  // 編集専用モード（redLen===undefined）: 空文字入力 → focusedCellは変えずlenValueだけ現在長に戻す
  const modeEditOnly = {
    inputState:   { focusedCell: 'len', lenValue: '' },
    selectedLine: line,
    clearInput()     {},
    setFocusedCell() {},
  };
  const r1 = confirmSiteLineLen(site, modeEditOnly, evalExpr);
  assert.equal(r1.toast, null);
  assert.equal(modeEditOnly.inputState.lenValue, '1000');
  assert.equal(modeEditOnly.inputState.focusedCell, 'len', '編集専用モードはfocusedCellを変えない');

  // 三斜入力モード（redLen定義済み）: 0以下の入力 → 赤辺入力へフォーカス移動しつつlenValueを戻す
  const modeSansha = {
    inputState:   { focusedCell: 'len', lenValue: '0', redLen: '', blueLen: '' },
    selectedLine: line,
    clearInput()     {},
    setFocusedCell() {},
  };
  const r2 = confirmSiteLineLen(site, modeSansha, evalExpr);
  assert.equal(r2.toast, null);
  assert.equal(modeSansha.inputState.lenValue, '1000');
  assert.equal(modeSansha.inputState.focusedCell, 'red', '三斜入力モードは赤辺入力へフォーカス移動する');

  assert.equal(ep.x, 1000, 'Siteの座標はどちらの分岐でも変わらない');
  assert.equal(undoManager.peekUndo(), beforeTop, 'undoは積まれない');
});

// ---- confirmSiteTriangle ----
// viewport は worldToScreen を恒等写像とするスタブ、size は1000x1000。
// 底辺(0,0)-(1000,0)・赤辺800・青辺600 は3-4-5系の直角三角形になり、apexは(640,480)に確定する
// （computeSiteApex内: 水平線につき中点の画面y座標(0) < screenH/2(500) → 下側(y大)のc1を採用）。

test('confirmSiteTriangle: 頂点確定でapex・三角形・赤/青辺・history(triangle)が追加され、undoで全て消える', () => {
  const site     = new Site();
  const project  = { site };
  const viewport = { worldToScreen: (x, y) => ({ x, y }) };
  const size     = { width: 1000, height: 1000 };

  const sp   = site.addPoint(0, 0);
  const ep   = site.addPoint(1000, 0);
  const line = site.addLine(sp, ep, SiteLineKind.SURVEY);
  site.history.push({ type: 'base', lineId: line.id, length: line.length });

  let selectedId = null;
  const mode = {
    inputState: {
      redLen: '800', blueLen: '600',
      redKind: SiteLineKind.BOUNDARY, blueKind: SiteLineKind.ROAD,
    },
    selectedLine: line,
    selectLine(id) { selectedId = id; },
    clearInput()   {},
  };

  const result = confirmSiteTriangle(project, mode, viewport, size, evalExpr);

  assert.equal(result.toast, null);
  assert.equal(site.triangles.length, 1);
  assert.equal(site.lines.length, 3, '底辺＋赤辺＋青辺');
  assert.equal(site.history.length, 2);
  assert.equal(site.history[1].type, 'triangle');
  const tri = site.triangles[0];
  assert.equal(Math.round(tri.apexPoint.x), 640);
  assert.equal(Math.round(tri.apexPoint.y), 480);
  assert.ok(selectedId, '連続入力: 次に底辺とすべき線分（赤辺）が自動選択される');

  undoManager.undo();
  assert.equal(site.triangles.length, 0, 'undoで三角形が消える');
  assert.equal(site.lines.length, 1, 'undoで赤/青辺が消え底辺のみ残る');
  assert.equal(site.history.length, 1, 'undoでhistoryのtriangleステップも消える');
});

test('confirmSiteTriangle: 道路指定の底辺が内側（三角形2つ）になると無指定へ格下げされ、undoで道路に戻りredoで再び格下げ', () => {
  const site     = new Site();
  const project  = { site };
  const viewport = { worldToScreen: (x, y) => ({ x, y }) };
  const size     = { width: 1000, height: 1000 };

  // 三角形1つ（底辺・赤辺・青辺）を手動構築し、赤辺を道路指定にする
  const sp   = site.addPoint(0, 0);
  const ep   = site.addPoint(1000, 0);
  const ap   = site.addPoint(640, 480);
  const base = site.addLine(sp, ep, SiteLineKind.SURVEY);
  site.addTriangle(base, ap, SiteLineKind.SURVEY);
  const red  = site.addLine(sp, ap, SiteLineKind.ROAD);
  site.addLine(ep, ap, SiteLineKind.SURVEY);

  const mode = {
    inputState: { redLen: '500', blueLen: '500', redKind: SiteLineKind.SURVEY, blueKind: SiteLineKind.SURVEY },
    selectedLine: red,
    selectLine() {}, clearInput() {},
  };
  const result = confirmSiteTriangle(project, mode, viewport, size, evalExpr);
  assert.equal(result.toast, null);
  assert.equal(site.triangles.length, 2);
  assert.equal(red.lineKind, SiteLineKind.SURVEY, '底辺が内側になり道路指定は無指定へ格下げ');
  assert.equal(site.history.at(-1).triangleLineKind, SiteLineKind.ROAD, '三角形の kind（底辺の元の kind）は保つ');

  undoManager.undo();
  assert.equal(site.triangles.length, 1);
  assert.equal(red.lineKind, SiteLineKind.ROAD, 'undoで道路指定に戻る（同じ undo エントリ）');

  undoManager.redo();
  assert.equal(site.triangles.length, 2);
  assert.equal(site.lineMap.get(red.id).lineKind, SiteLineKind.SURVEY, 'redoで再び格下げ');
});

test('confirmSiteTriangle: 底辺が外周のまま（最初の三角形）なら道路指定は保たれる', () => {
  const site     = new Site();
  const project  = { site };
  const viewport = { worldToScreen: (x, y) => ({ x, y }) };
  const size     = { width: 1000, height: 1000 };
  const line = site.addLine(site.addPoint(0, 0), site.addPoint(1000, 0), SiteLineKind.ROAD);
  site.history.push({ type: 'base', lineId: line.id, length: line.length });
  const mode = {
    inputState: { redLen: '800', blueLen: '600', redKind: SiteLineKind.SURVEY, blueKind: SiteLineKind.SURVEY },
    selectedLine: line,
    selectLine() {}, clearInput() {},
  };
  confirmSiteTriangle(project, mode, viewport, size, evalExpr);
  assert.equal(site.triangles.length, 1);
  assert.equal(line.lineKind, SiteLineKind.ROAD, '三角形1つの底辺は外周のまま＝格下げしない');
});

test('confirmSiteTriangle: 辺長が三角形として不正（h2<0）ならtoastを返しSiteを一切変更せずundoも積まれない', () => {
  const site     = new Site();
  const project  = { site };
  const viewport = { worldToScreen: (x, y) => ({ x, y }) };
  const size     = { width: 1000, height: 1000 };

  const sp   = site.addPoint(0, 0);
  const ep   = site.addPoint(1000, 0);
  const line = site.addLine(sp, ep, SiteLineKind.SURVEY);
  site.history.push({ type: 'base', lineId: line.id, length: line.length });
  const beforeTop = undoManager.peekUndo();

  // 100+100=200 < 底辺1000 で三角形が成立しない（h2<0）
  const mode = {
    inputState: {
      redLen: '100', blueLen: '100',
      redKind: SiteLineKind.BOUNDARY, blueKind: SiteLineKind.BOUNDARY,
    },
    selectedLine: line,
    selectLine() {},
    clearInput() {},
  };

  const result = confirmSiteTriangle(project, mode, viewport, size, evalExpr);

  assert.equal(result.toast, '三角形を構成できません（辺長が不正）');
  assert.equal(site.triangles.length, 0);
  assert.equal(site.lines.length, 1, '底辺のみ（赤/青辺は追加されない）');
  assert.equal(site.history.length, 1, 'historyにtriangleステップは追加されない');
  assert.equal(undoManager.peekUndo(), beforeTop, 'undoは積まれない');
});

// ---- commitSiteTapLine ----

test('commitSiteTapLine: タップ確定でSitePoint×2+SiteLine+history(base)を追加し、undoで全て消える', () => {
  const site    = new Site();
  const project = { site };
  const viewport = { worldToScreen: (x, y) => ({ x, y }) };

  const { lineId } = commitSiteTapLine(project, viewport, { x: 0, y: 0 }, { x: 1000, y: 0 });

  assert.equal(site.lines.length, 1);
  assert.equal(site.history.length, 1);
  assert.equal(site.history[0].type, 'base');
  assert.equal(site.lineMap.get(lineId).lineKind, SiteLineKind.SURVEY, 'sansha確定は測量線として追加される');

  undoManager.undo();
  assert.equal(site.lines.length, 0, 'undoで線分が消える');
  assert.equal(site.points.length, 0, 'undoで端点も消える');
  assert.equal(site.history.length, 0, 'undoでhistoryも巻き戻る');
});

// ---- deleteSiteTriangle / deleteSiteBaseLine ----
// base(A-B) → tri1（頂点C）→ tri2（底辺＝tri1 の赤辺。頂点D）→ tri3（底辺＝tri1 の青辺。頂点E）。
// tri2 は history の中間（index 2）・lineMap の中間にある端の三角形。
function buildThree() {
  const site = new Site();
  const A = site.addPoint(0, 0), B = site.addPoint(1000, 0);
  const base = site.addLine(A, B, SiteLineKind.SURVEY);
  site.history.push({ type: 'base', lineId: base.id, length: 1000 });
  const addTri = (baseLine, p, q, apex, side) => {
    const ap = site.addPoint(apex.x, apex.y);
    const t = site.addTriangle(baseLine, ap, SiteLineKind.SURVEY);
    const red = site.addLine(p, ap, SiteLineKind.SURVEY);
    const blue = site.addLine(q, ap, SiteLineKind.SURVEY);
    site.history.push({
      type: 'triangle', baseLineId: baseLine.id,
      redLineId: red.id, redLen: red.length, redKind: SiteLineKind.SURVEY,
      blueLineId: blue.id, blueLen: blue.length, blueKind: SiteLineKind.SURVEY,
      triangleId: t.id, triangleLineKind: SiteLineKind.SURVEY, side,
    });
    return { t, red, blue, ap };
  };
  const t1 = addTri(base, A, B, { x: 640, y: 480 }, 1);
  const t2 = addTri(t1.red, A, t1.ap, { x: -200, y: 600 }, -1);
  const t3 = addTri(t1.blue, B, t1.ap, { x: 1300, y: 700 }, 1);
  return { site, base, t1, t2, t3 };
}

function dumpSite(site) {
  return {
    lines: site.lines.map(l => [l.id, l.startPoint.id, l.endPoint.id, l.lineKind, l.redPointId]),
    lineOrder: [...site.lineOrder],
    history: cloneHistory(site.history),
    triNums: [...computeLineTriNums(site)].map(([k, v]) => [k, [...v]]),
    pending: computePendingQueue(site),
    // triangleMap・pointMap の並びは三角番号にも表の順にも使われない（底辺の lineMap 順・lineOrder が使われる）ので id 順で比べる
    tris: site.triangles.map(t => [t.id, t.baseLine.id, t.apexPoint.id, t.apexPoint.x, t.apexPoint.y, t.lineKind]).sort((a, b) => (a[0] < b[0] ? -1 : 1)),
    points: site.points.map(p => p.id).sort(),
  };
}

test('deleteSiteTriangle: 中間の端の三角形を消し、undoで lineMap順・lineOrder・history・三角番号・候補キューまで完全復元、redoで再削除', () => {
  const { site, t1, t2 } = buildThree();
  const before = dumpSite(site);

  const result = deleteSiteTriangle(site, t2.t.id);
  assert.deepEqual(result, { ok: true, toast: null });
  assert.equal(site.triangleMap.has(t2.t.id), false);
  assert.equal(site.lineMap.has(t2.red.id) || site.lineMap.has(t2.blue.id), false);
  assert.equal(site.pointMap.has(t2.ap.id), false);
  assert.equal(site.history.length, 3, 'base + tri1 + tri3');
  assert.equal(site.lineMap.has(t1.red.id), true, '底辺だった線は残る');
  const after = dumpSite(site);

  undoManager.undo();
  assert.deepEqual(dumpSite(site), before);

  undoManager.redo();
  assert.deepEqual(dumpSite(site), after);

  undoManager.undo();
  assert.deepEqual(dumpSite(site), before, '再undoでも完全復元');
});

test('deleteSiteTriangle: 底辺の線種は触らない（削除で外周に戻っても道路指定を自動復活しない）', () => {
  const { site, t1, t2 } = buildThree();
  t1.red.lineKind = SiteLineKind.SURVEY; // tri2 の底辺（内側＝格下げ済み）
  deleteSiteTriangle(site, t2.t.id);
  assert.ok(computeOuterLineIds(site).has(t1.red.id), '削除後は外周へ戻っている');
  assert.equal(t1.red.lineKind, SiteLineKind.SURVEY);
});

test('deleteSiteRow: 削除でバッヂが減った選択線は入力行が作り直され（red フォーカス）、選択は同じ線のまま。ロック時は toast', () => {
  const { site, t1, t2 } = buildThree();
  const mode = new SiteModeState(site);
  mode.selectLine(t1.red.id);
  assert.equal(mode.inputState, null, 'バッヂ2の線は選択のみ');

  assert.deepEqual(deleteSiteRow(site, mode, t2.red.id), { toast: null });
  assert.equal(mode.selectedLineId, t1.red.id);
  assert.equal(mode.inputState.focusedCell, 'red');

  // t1 は tri3 の底辺（青辺）が残るのでロック対象ではないが、赤辺の行は削除不可（null）→ toast なし・変化なし
  assert.deepEqual(deleteSiteRow(site, mode, t1.red.id), { toast: null });
  mode.dispose();
});

test('deleteSiteRow【失敗系】: 削除不可の行（三角形ありの最初の1本・端でない三角形の辺）は何も変えず toast も出さない（UI はボタンを出さない）', () => {
  const { site, base, t1 } = buildThree();
  const mode = new SiteModeState(site);
  const top = undoManager.peekUndo();
  assert.deepEqual(deleteSiteRow(site, mode, base.id), { toast: null });
  assert.deepEqual(deleteSiteRow(site, mode, t1.blue.id), { toast: null });
  assert.equal(site.history.length, 4);
  assert.equal(undoManager.peekUndo(), top);
  mode.dispose();
});

test('deleteSiteTriangle【失敗系】: 他の三角形の底辺になっている三角形・存在しない id は toast を返し何も変えず undo も積まない', () => {
  const { site, t1 } = buildThree();
  const before = dumpSite(site);
  const top = undoManager.peekUndo();

  assert.deepEqual(deleteSiteTriangle(site, t1.t.id), { ok: false, toast: TOAST_TRI_DELETE_LOCKED });
  assert.deepEqual(deleteSiteTriangle(site, 'none'), { ok: false, toast: TOAST_TRI_DELETE_LOCKED });
  assert.deepEqual(dumpSite(site), before);
  assert.equal(undoManager.peekUndo(), top, 'undoは積まれない');
});

test('deleteSiteBaseLine: 三角形が無い最初の1本を消して空に戻し、undoで同idの線・点・historyが戻り、redoで再削除', () => {
  const site = new Site();
  const { lineId } = commitSiteTapLine({ site }, { worldToScreen: (x, y) => ({ x, y }) }, { x: 0, y: 0 }, { x: 1000, y: 0 });
  const before = dumpSite(site);

  assert.deepEqual(deleteSiteBaseLine(site), { ok: true, toast: null });
  assert.equal(site.lines.length, 0);
  assert.equal(site.points.length, 0);
  assert.equal(site.history.length, 0);
  assert.equal(site.lineOrder.length, 0);

  undoManager.undo();
  assert.deepEqual(dumpSite(site), before);
  assert.equal(site.lineMap.has(lineId), true);

  undoManager.redo();
  assert.equal(site.lines.length, 0);
  assert.equal(site.history.length, 0);
});

test('deleteSiteBaseLine【失敗系】: 三角形がある・線が無いときは toast を返し何も変えず undo も積まない', () => {
  const { site } = buildThree();
  const before = dumpSite(site);
  const top = undoManager.peekUndo();
  assert.deepEqual(deleteSiteBaseLine(site), { ok: false, toast: TOAST_BASE_DELETE_LOCKED });
  assert.deepEqual(dumpSite(site), before);

  assert.deepEqual(deleteSiteBaseLine(new Site()), { ok: false, toast: TOAST_BASE_DELETE_LOCKED });
  assert.equal(undoManager.peekUndo(), top);
});
