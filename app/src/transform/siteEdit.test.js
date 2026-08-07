// centerLineOps.test.js と同じ方針: ダックタイピングでは Site の observable 配列
// (history/lineOrder) の実挙動を再現できないため、実 core/site.js の Site を使う。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Site, SiteLineKind } from '../core.js';
import { undoManager } from '../undoManager.js';
import {
  editSiteLineLength, confirmSiteLineLen, confirmSiteTriangle, cycleSiteLineKind, commitSiteTapLine,
} from './siteEdit.js';

const evalExpr = (s) => Number(s);

// ---- cycleSiteLineKind ----

test('cycleSiteLineKind: 境界→道路境界→測量→境界の順で循環し、undoで直前の線種に戻る', () => {
  const site = new Site();
  const sp   = site.addPoint(0, 0);
  const ep   = site.addPoint(1000, 0);
  const line = site.addLine(sp, ep, SiteLineKind.BOUNDARY);

  cycleSiteLineKind(site, line.id);
  assert.equal(line.lineKind, SiteLineKind.ROAD);

  cycleSiteLineKind(site, line.id);
  assert.equal(line.lineKind, SiteLineKind.SURVEY);

  cycleSiteLineKind(site, line.id);
  assert.equal(line.lineKind, SiteLineKind.BOUNDARY);

  undoManager.undo();
  assert.equal(line.lineKind, SiteLineKind.SURVEY, '直前の切替（測量）に戻る');
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

  const { lineId } = commitSiteTapLine(project, viewport, 'sansha', { x: 0, y: 0 }, { x: 1000, y: 0 });

  assert.equal(site.lines.length, 1);
  assert.equal(site.history.length, 1);
  assert.equal(site.history[0].type, 'base');
  assert.equal(site.lineMap.get(lineId).lineKind, SiteLineKind.SURVEY, 'sansha確定は測量線として追加される');

  undoManager.undo();
  assert.equal(site.lines.length, 0, 'undoで線分が消える');
  assert.equal(site.points.length, 0, 'undoで端点も消える');
  assert.equal(site.history.length, 0, 'undoでhistoryも巻き戻る');
});

test('commitSiteTapLine: subMode="other"はSiteLineKind.OTHERとして追加される', () => {
  const site     = new Site();
  const project  = { site };
  const viewport = { worldToScreen: (x, y) => ({ x, y }) };

  const { lineId } = commitSiteTapLine(project, viewport, 'other', { x: 0, y: 0 }, { x: 500, y: 500 });

  assert.equal(site.lineMap.get(lineId).lineKind, SiteLineKind.OTHER);
});
