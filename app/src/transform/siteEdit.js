// 敷地モード（三斜計算）に対するユーザー操作（辺長編集・三角形確定・線種循環・タップによる
// 線分追加確定）の実処理＋Undo登録。App.jsx から状態を持たない純粋な形へ抽出したもの
// （挙動は元コードのまま。ダイアログ/入力欄のフォーカス制御などモード状態の操作だけを App.jsx に残す）。
import { runInAction } from 'mobx';
import { SiteLineKind } from '@core';
import { undoManager } from '../undoManager.js';
import { computeSiteApex, pickRedPointId, getSiteLineRedBlue, computeApexSide } from '../site/siteGeometry.js';
import { findLineHistoryStep, recomputeSiteFromHistory, cloneHistory, computePendingQueue } from './siteHistory.js';

// ---- 三斜 線分長さ編集（history を起点に再計算してUndo登録）----
// @returns {{ ok: boolean, toast: string|null }}
export function editSiteLineLength(site, lineId, newLen) {
  const step = findLineHistoryStep(site, lineId);
  if (!step) {
    return { ok: false, toast: '編集できない線分です' };
  }

  // 影響を受ける可能性のある全ての頂点(apex)位置 + line0 の自由端をスナップショット
  const snapshotPositions = () => {
    const map = new Map();
    const base = site.history[0];
    const ln0  = base && site.lineMap.get(base.lineId);
    if (ln0) map.set(ln0.endPoint.id, { x: ln0.endPoint.x, y: ln0.endPoint.y });
    for (let i = 1; i < site.history.length; i++) {
      const st  = site.history[i];
      const tri = site.triangleMap.get(st.triangleId);
      if (tri) map.set(tri.apexPoint.id, { x: tri.apexPoint.x, y: tri.apexPoint.y });
    }
    return map;
  };
  const restorePositions = (snap) => {
    for (const [id, pos] of snap) {
      const pt = site.pointMap.get(id);
      if (pt) { pt.x = pos.x; pt.y = pos.y; }
    }
  };

  const before     = snapshotPositions();
  const histBefore = cloneHistory(site.history);

  let ok = true;
  runInAction(() => {
    if (step.role === 'base') {
      const ln = site.lineMap.get(site.history[0].lineId);
      const sp = ln.startPoint, ep = ln.endPoint;
      const dx = ep.x - sp.x, dy = ep.y - sp.y;
      const d  = Math.hypot(dx, dy);
      if (d < 1e-6) { ok = false; return; }
      ep.x = sp.x + (dx / d) * newLen;
      ep.y = sp.y + (dy / d) * newLen;
      site.history[0].length = newLen;
      ok = recomputeSiteFromHistory(site, 1);
    } else {
      const st = site.history[step.index];
      if (step.role === 'red') st.redLen = newLen; else st.blueLen = newLen;
      ok = recomputeSiteFromHistory(site, step.index);
    }
  });

  if (!ok) {
    runInAction(() => {
      restorePositions(before);
      site.history.replace(histBefore);
    });
    return { ok: false, toast: '三角形を構成できません（辺長が不正）' };
  }

  const after     = snapshotPositions();
  const histAfter = cloneHistory(site.history);
  undoManager.push(
    () => runInAction(() => { restorePositions(before); site.history.replace(histBefore); }),
    () => runInAction(() => { restorePositions(after);  site.history.replace(histAfter);  }),
  );
  return { ok: true, toast: null };
}

// ---- 三斜 線分長さ確定（NumPad/テキスト入力からの確定） ----
// mode: SiteModeState インスタンス（modeRef.current）。evalExpr は呼び出し側（App.jsx）の
// positiveOnly 版を渡す。
// @returns {{ toast: string|null }}
export function confirmSiteLineLen(site, mode, evalExpr) {
  const m = mode;
  if (!m || !m.inputState || !m.selectedLine || m.inputState.focusedCell !== 'len') return { toast: null };
  const newLen     = evalExpr(m.inputState.lenValue);
  const isEditOnly = m.inputState.redLen === undefined;
  // 未入力 or 無効値の場合は lenValue を現在の線分長さに戻す
  if (!isFinite(newLen) || newLen <= 0) {
    runInAction(() => {
      m.inputState = isEditOnly
        ? { ...m.inputState, lenValue: m.selectedLine.length.toFixed(0) }
        : { ...m.inputState, focusedCell: 'red', lenValue: m.selectedLine.length.toFixed(0) };
    });
    return { toast: null };
  }
  const result = editSiteLineLength(site, m.selectedLine.id, newLen);
  if (!result.ok) return { toast: result.toast };
  runInAction(() => {
    if (isEditOnly) m.clearInput();
    else            m.setFocusedCell('red');
  });
  return { toast: null };
}

// ---- 三斜 頂点確定（赤辺・青辺もまとめて SiteLine として追加） ----
// size: { width, height }（computeSiteApex に渡すキャンバスサイズ）
// @returns {{ toast: string|null }}
export function confirmSiteTriangle(project, mode, viewport, size, evalExpr) {
  const m = mode;
  if (!m || !m.inputState || !m.selectedLine) return { toast: null };
  const { redLen, blueLen, redKind, blueKind } = m.inputState;
  const rLen = evalExpr(redLen);
  const bLen = evalExpr(blueLen);
  if (!isFinite(rLen) || !isFinite(bLen)) return { toast: null };

  const apex = computeSiteApex(m.selectedLine, rLen, bLen, viewport, size.width, size.height);
  if (!apex) {
    return { toast: '三角形を構成できません（辺長が不正）' };
  }

  const line     = m.selectedLine;
  const lineKind = line.lineKind;
  const { red, blue } = getSiteLineRedBlue(line);
  const redPtId  = red.id;
  const bluePtId = blue.id;
  const side     = computeApexSide(line, apex);
  let triId, apexPtId, ax, ay;
  let redLineId, redLineRedPointId, blueLineId, blueLineRedPointId;
  runInAction(() => {
    const apexPt = project.site.addPoint(apex.x, apex.y);
    const tri    = project.site.addTriangle(line, apexPt, lineKind);
    triId    = tri.id;
    apexPtId = apexPt.id;
    ax = apex.x; ay = apex.y;

    redLineRedPointId  = pickRedPointId(red,  apexPt, viewport);
    const redLine  = project.site.addLine(red,  apexPt, redKind,  undefined, redLineRedPointId);
    redLineId = redLine.id;

    blueLineRedPointId = pickRedPointId(blue, apexPt, viewport);
    const blueLine = project.site.addLine(blue, apexPt, blueKind, undefined, blueLineRedPointId);
    blueLineId = blueLine.id;

    project.site.history.push({
      type: 'triangle',
      baseLineId: line.id,
      redLineId, redLen: rLen, redKind,
      blueLineId, blueLen: bLen, blueKind,
      triangleId: triId, triangleLineKind: lineKind,
      side,
    });
  });
  undoManager.push(
    () => runInAction(() => {
      project.site.removeLine(blueLineId);
      project.site.removeLine(redLineId);
      project.site.removeTriangle(triId);
      project.site.removePoint(apexPtId);
      project.site.history.pop();
    }),
    () => runInAction(() => {
      const ln2 = project.site.lineMap.get(line.id);
      if (!ln2) return;
      const ap2 = project.site.addPoint(ax, ay, apexPtId);
      project.site.addTriangle(ln2, ap2, lineKind, triId);
      const redPt2  = project.site.pointMap.get(redPtId);
      const bluePt2 = project.site.pointMap.get(bluePtId);
      if (redPt2)  project.site.addLine(redPt2,  ap2, redKind,  redLineId,  redLineRedPointId);
      if (bluePt2) project.site.addLine(bluePt2, ap2, blueKind, blueLineId, blueLineRedPointId);
      project.site.history.push({
        type: 'triangle',
        baseLineId: line.id,
        redLineId, redLen: rLen, redKind,
        blueLineId, blueLen: bLen, blueKind,
        triangleId: triId, triangleLineKind: lineKind,
        side,
      });
    }),
  );
  // 連続入力: 次に底辺とすべき線分を自動選択（赤辺入力にフォーカス）
  runInAction(() => {
    const nextId = computePendingQueue(project.site)[0];
    if (nextId) m.selectLine(nextId);
    else        m.clearInput();
  });
  return { toast: null };
}

// ---- 確定済み線分の線種を循環切替（境界 → 道路境界 → 測量 → 境界...） ----
export function cycleSiteLineKind(site, lineId) {
  const line = site.lineMap.get(lineId);
  if (!line) return;
  const order = [SiteLineKind.BOUNDARY, SiteLineKind.ROAD, SiteLineKind.SURVEY];
  const prev = line.lineKind;
  const next = order[(order.indexOf(prev) + 1) % order.length];
  runInAction(() => { line.lineKind = next; });
  undoManager.push(
    () => runInAction(() => {
      const l = site.lineMap.get(lineId);
      if (l) l.lineKind = prev;
    }),
    () => runInAction(() => {
      const l = site.lineMap.get(lineId);
      if (l) l.lineKind = next;
    }),
  );
}

// ---- 敷地線分描画のタップ確定（2点目のタップで SitePoint×2 + SiteLine を追加）----
// ジェスチャー判定（ドラッグかタップかの判別）・1点目の確定/選択解除・siteDrawState の
// 更新/クリアは呼び出し側（App.jsx, handlePointerUp）が担う。
// sm: modeRef.current.subMode（'sansha' | 'other'）
// undo 登録は本関数内（selectLine 呼び出しより前）で完結する——選択状態（selectedLineId／
// inputState）は undo の対象に含めていない（contextProvider がモード内選択状態を含まない現状に
// 依存する。呼び出し側が戻り値の lineId で modeRef.current.selectLine() するのは副作用の外）。
// @returns {{ lineId: string }}  lineId: 三斜サブモードで直後に選択すべき線分ID
export function commitSiteTapLine(project, viewport, sm, startWorld, endWorld) {
  const lineKind = sm === 'other' ? SiteLineKind.OTHER : SiteLineKind.SURVEY;
  let spId, epId, lineId, redPointId, sx, sy, ex, ey;
  runInAction(() => {
    const sp   = project.site.addPoint(startWorld.x, startWorld.y);
    const ep   = project.site.addPoint(endWorld.x,   endWorld.y);
    redPointId = pickRedPointId(sp, ep, viewport);
    const line = project.site.addLine(sp, ep, lineKind, undefined, redPointId);
    spId = sp.id; epId = ep.id; lineId = line.id;
    sx = sp.x; sy = sp.y; ex = ep.x; ey = ep.y;
    project.site.history.push({ type: 'base', lineId, length: line.length });
  });
  undoManager.push(
    () => runInAction(() => {
      project.site.removeLine(lineId);
      project.site.removePoint(epId);
      project.site.removePoint(spId);
      project.site.history.pop();
    }),
    () => runInAction(() => {
      const sp2 = project.site.addPoint(sx, sy, spId);
      const ep2 = project.site.addPoint(ex, ey, epId);
      const line2 = project.site.addLine(sp2, ep2, lineKind, lineId, redPointId);
      project.site.history.push({ type: 'base', lineId, length: line2.length });
    }),
  );
  return { lineId };
}
