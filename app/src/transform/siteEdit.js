// 敷地モード（三斜計算）に対するユーザー操作（辺長編集・三角形確定・線種循環・タップによる
// 線分追加確定）の実処理＋Undo登録。App.jsx から状態を持たない純粋な形へ抽出したもの
// （挙動は元コードのまま。ダイアログ/入力欄のフォーカス制御などモード状態の操作だけを App.jsx に残す）。
import { runInAction } from 'mobx';
import { SiteLineKind } from '@core';
import { undoManager } from '../undoManager.js';
import { computeSiteApex, pickRedPointId, getSiteLineRedBlue, computeApexSide } from '../site/siteGeometry.js';
import { computeOuterLineIds } from '../site/lineClassification.js';
import { findLineHistoryStep, recomputeSiteFromHistory, cloneHistory, computePendingQueue } from './siteHistory.js';
import { computeDeletableTriangleIds, rowDeleteAction } from '../site/triangleDeletion.js';

export const TOAST_TRI_DELETE_LOCKED  = '他の三角形の底辺になっている三角形は削除できません';
export const TOAST_BASE_DELETE_LOCKED = '三角形があるため最初の線分は削除できません';

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
  let demoted = false; // 底辺が内側になり道路指定が無指定へ格下げされたか
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

    // 底辺が内側（三角形2つ）になったとき、道路指定は無指定へ格下げ（外周でなくなるため）
    if (lineKind === SiteLineKind.ROAD && !computeOuterLineIds(project.site).has(line.id)) {
      line.lineKind = SiteLineKind.SURVEY;
      demoted = true;
    }
  });
  undoManager.push(
    () => runInAction(() => {
      if (demoted) {
        const bl = project.site.lineMap.get(line.id);
        if (bl) bl.lineKind = lineKind;
      }
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
      if (demoted) ln2.lineKind = SiteLineKind.SURVEY;
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

// ---- 外周の線分の道路指定を切替（無指定=SURVEY ⇄ 道路=ROAD。BOUNDARY は無指定扱い） ----
// 内側の線（外周でない）・存在しない線は何も変えず { ok:false }（UI は呼ばない）。
// @returns {{ ok: boolean }}
export function cycleSiteLineKind(site, lineId) {
  const line = site.lineMap.get(lineId);
  if (!line || !computeOuterLineIds(site).has(lineId)) return { ok: false };
  const prev = line.lineKind;
  const next = prev === SiteLineKind.ROAD ? SiteLineKind.SURVEY : SiteLineKind.ROAD;
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
  return { ok: true };
}

// ---- 敷地線分描画のタップ確定（2点目のタップで SitePoint×2 + SiteLine を追加）----
// ジェスチャー判定（ドラッグかタップかの判別）・1点目の確定/選択解除・siteDrawState の
// 更新/クリアは呼び出し側（App.jsx, handlePointerUp）が担う。
// 線種は常に無指定（SURVEY）。「その他」タブ（OTHER 線種の入力）は 2026-11-09 に廃止した。
// undo 登録は本関数内（selectLine 呼び出しより前）で完結する——選択状態（selectedLineId／
// inputState）は undo の対象に含めていない（contextProvider がモード内選択状態を含まない現状に
// 依存する。呼び出し側が戻り値の lineId で modeRef.current.selectLine() するのは副作用の外）。
// @returns {{ lineId: string }}  lineId: 三斜サブモードで直後に選択すべき線分ID
export function commitSiteTapLine(project, viewport, startWorld, endWorld) {
  const lineKind = SiteLineKind.SURVEY;
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

// ---- 三斜 削除（三角形・最初の1本）----
// undo は lineMap の挿入位置（三角番号の採番）と lineOrder の位置（表の順）まで完全復元する。
// 選択状態（selectedLineId／inputState）は undo の対象外（消えた線の選択は SiteModeState の reaction が解除）。

// 線分の復元用スナップショット（挿入位置込み）
function snapshotLine(site, line) {
  return {
    id: line.id,
    startId: line.startPoint.id, endId: line.endPoint.id,
    lineKind: line.lineKind, redPointId: line.redPointId,
    mapIndex: [...site.lineMap.keys()].indexOf(line.id),
    orderIndex: site.lineOrder.indexOf(line.id),
  };
}

// 挿入位置の昇順に戻す（先に低い index を戻せば、後の index は元の並びでの位置になる）。
// 端点は pointMap に在ること。無ければ false
function restoreLines(site, snaps) {
  for (const s of [...snaps].sort((a, b) => a.mapIndex - b.mapIndex)) {
    const sp = site.pointMap.get(s.startId);
    const ep = site.pointMap.get(s.endId);
    if (!sp || !ep) return false;
    site.insertLineAt(s.mapIndex, s.orderIndex, sp, ep, s.lineKind, s.id, s.redPointId);
  }
  return true;
}

// 端の三角形（赤辺・青辺がどちらも他の三角形の底辺でない）を削除する。
// 赤辺・青辺の2本・三角形・頂点・historyの該当ステップ（末尾とは限らない）を消す。
// 底辺の道路指定は触らない: 削除で底辺が外周に戻っても自動復活させない（格下げのみの規則。
// 道路指定は外周になった線へユーザーが明示的に行う）。
// @returns {{ ok: boolean, toast: string|null }}
export function deleteSiteTriangle(site, triangleId) {
  const tri = site.triangleMap.get(triangleId);
  const hIdx = site.history.findIndex(s => s.type === 'triangle' && s.triangleId === triangleId);
  if (!tri || hIdx < 0 || !computeDeletableTriangleIds(site).has(triangleId)) {
    return { ok: false, toast: TOAST_TRI_DELETE_LOCKED };
  }
  const step = { ...site.history[hIdx] };
  const redLine  = site.lineMap.get(step.redLineId);
  const blueLine = site.lineMap.get(step.blueLineId);
  if (!redLine || !blueLine) return { ok: false, toast: TOAST_TRI_DELETE_LOCKED };

  const snaps = [snapshotLine(site, redLine), snapshotLine(site, blueLine)];
  const apexId = tri.apexPoint.id;
  const ax = tri.apexPoint.x, ay = tri.apexPoint.y;
  const triKind = tri.lineKind;

  const apply = () => runInAction(() => {
    // 端の三角形の赤辺・青辺はどの三角形の底辺でもないので removeLine の連鎖削除は起きない
    site.removeLine(step.blueLineId);
    site.removeLine(step.redLineId);
    site.removeTriangle(triangleId);
    site.removePoint(apexId);
    const i = site.history.findIndex(s => s.type === 'triangle' && s.triangleId === triangleId);
    if (i >= 0) site.history.splice(i, 1);
  });
  apply();
  undoManager.push(
    () => runInAction(() => {
      const baseLine = site.lineMap.get(step.baseLineId);
      if (!baseLine) return;
      const apex = site.addPoint(ax, ay, apexId);
      site.addTriangle(baseLine, apex, triKind, triangleId);
      restoreLines(site, snaps);
      site.history.splice(hIdx, 0, { ...step });
    }),
    apply,
  );
  return { ok: true, toast: null };
}

// 三斜表の行の削除（rowDeleteAction の振り分け＋実削除＋選択線の入力行の作り直し）。
// 削除でバッヂ数が変わると選択中の線の入力行の要否が変わるため、成功後に選択線が残っていれば selectLine し直す
// （confirmSiteTriangle の後処理と同じ形）。
// @returns {{ toast: string|null }}
export function deleteSiteRow(site, mode, lineId) {
  const action = rowDeleteAction(site, lineId);
  if (!action) return { toast: null };
  const result = action.type === 'triangle'
    ? deleteSiteTriangle(site, action.triangleId)
    : deleteSiteBaseLine(site);
  if (!result.ok) return { toast: result.toast };
  runInAction(() => {
    const sel = mode?.selectedLineId;
    if (sel && site.lineMap.has(sel)) mode.selectLine(sel);
  });
  return { toast: null };
}

// 三角形が無いときの最初の1本（history が base 1件だけ）を削除して空に戻す。
// @returns {{ ok: boolean, toast: string|null }}
export function deleteSiteBaseLine(site) {
  if (site.history.length !== 1 || site.history[0].type !== 'base') {
    return { ok: false, toast: TOAST_BASE_DELETE_LOCKED };
  }
  const lineId = site.history[0].lineId;
  const line = site.lineMap.get(lineId);
  if (!line) return { ok: false, toast: TOAST_BASE_DELETE_LOCKED };
  const snap = snapshotLine(site, line);
  const sp = line.startPoint, ep = line.endPoint;
  const pts = [
    { id: sp.id, x: sp.x, y: sp.y },
    { id: ep.id, x: ep.x, y: ep.y },
  ];
  const length = line.length;

  const apply = () => runInAction(() => {
    site.removeLine(lineId);
    for (const p of pts) site.removePoint(p.id);
    site.history.pop();
  });
  apply();
  undoManager.push(
    () => runInAction(() => {
      for (const p of pts) site.addPoint(p.x, p.y, p.id);
      restoreLines(site, [snap]);
      site.history.push({ type: 'base', lineId, length });
    }),
    apply,
  );
  return { ok: true, toast: null };
}
