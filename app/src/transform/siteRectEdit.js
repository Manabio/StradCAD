// 敷地モード（長方形入力）の確定操作＋Undo登録。三斜の commitSiteTapLine（siteEdit.js）と同じ作法
// （runInAction で実体を作り、undoManager.push で removeRect / 同 id の addRect）。
// 選択状態（SiteModeState）は undo 対象外。
import { runInAction } from 'mobx';
import { undoManager } from '../undoManager.js';
import {
  computeAttachedRect, isEdgeAttachable, computeOutlinePieces, canDeleteRect, canEditRect, rectNeighbors,
} from '../site/siteRectGeometry.js';

export const TOAST_RECT_EDGE_INNER   = '内側の辺には長方形を付けられません';
export const TOAST_RECT_ROAD_INNER   = '内側の辺は道路に指定できません';
export const TOAST_RECT_ATTACH_BAD   = '長方形を構成できません（辺長が不正）';
export const TOAST_RECT_SIZE_BAD     = '長方形を構成できません（寸法が不正）';
export const TOAST_RECT_BASE_MISSING = '基になる長方形がありません';
export const TOAST_RECT_EDIT_LOCKED   = '他の長方形が付いている長方形は修正できません';
export const TOAST_RECT_DELETE_LOCKED = '削除すると長方形が分かれます';

// 外周から外れた辺（isEdgeAttachable が偽）の道路指定を外し、外した {rectId, side} を返す（格下げ）
function demoteInnerRoadSides(site) {
  const demoted = [];
  const rects = site.rects;
  for (const r of rects) {
    for (const side of [...r.roadSides]) {
      if (!isEdgeAttachable(rects, r.id, side)) {
        r.roadSides.delete(side);
        demoted.push({ rectId: r.id, side });
      }
    }
  }
  return demoted;
}

function addRectWithUndo(site, x, y, w, h, demote = false) {
  let rect;
  let demoted = [];
  runInAction(() => {
    rect = site.addRect(x, y, w, h);
    if (demote) demoted = demoteInnerRoadSides(site);
  });
  const { id } = rect;
  undoManager.push(
    () => runInAction(() => {
      site.removeRect(id);
      for (const d of demoted) site.rectMap.get(d.rectId)?.roadSides.add(d.side);
    }),
    () => runInAction(() => {
      site.addRect(x, y, w, h, id);
      for (const d of demoted) site.rectMap.get(d.rectId)?.roadSides.delete(d.side);
    }),
  );
  return id;
}

/**
 * 外周上の辺の道路指定をトグルする（undo あり）。内側の辺（外周片が無い）は拒否して undo を積まない。
 * 同一直線で重なる長方形で同じ片が複数の辺に属するときは、どれかが道路なら全て外し、無ければこの辺だけ付ける。
 * @returns {{ ok: boolean, toast: string|null }}
 */
export function toggleRectRoadSide(site, rectId, side) {
  const rect = site.rectMap.get(rectId);
  if (!rect || !isEdgeAttachable(site.rects, rectId, side)) {
    return { ok: false, toast: TOAST_RECT_ROAD_INNER };
  }
  const pieces = computeOutlinePieces(site.rects);
  const piece = pieces.find(p => p.owners.some(o => o.rectId === rectId && o.side === side));
  const owners = piece ? piece.owners : [{ rectId, side }];
  const isRoad = o => site.rectMap.get(o.rectId)?.roadSides.has(o.side);
  const anyRoad = owners.some(isRoad);
  // 変更する辺の集合（変更前の状態を保存）
  const changes = anyRoad
    ? owners.filter(isRoad)
    : [{ rectId, side }];
  const apply = (toRoad) => runInAction(() => {
    for (const c of changes) {
      const rs = site.rectMap.get(c.rectId)?.roadSides;
      if (!rs) continue;
      if (toRoad) rs.add(c.side); else rs.delete(c.side);
    }
  });
  const next = !anyRoad;
  apply(next);
  undoManager.push(() => apply(!next), () => apply(next));
  return { ok: true, toast: null };
}

/**
 * 最初の長方形（origin=左上角）を追加する。
 * @returns {{ ok: boolean, rectId: string|null, toast: string|null }}
 */
export function commitFirstRect(site, origin, w, h) {
  if (!origin || !Number.isFinite(origin.x) || !Number.isFinite(origin.y)
      || !Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    return { ok: false, rectId: null, toast: TOAST_RECT_SIZE_BAD };
  }
  const rectId = addRectWithUndo(site, origin.x, origin.y, w, h);
  return { ok: true, rectId, toast: null };
}

/**
 * 共有辺（baseRectId の side）の外側に長方形を付ける。
 * @param {'a'|'b'} anchor 基点
 * @returns {{ ok: boolean, rectId: string|null, toast: string|null }}
 */
export function commitAttachedRect(site, baseRectId, side, anchor, alongLen, depthLen) {
  const base = site.rectMap.get(baseRectId);
  if (!base) return { ok: false, rectId: null, toast: TOAST_RECT_BASE_MISSING };
  if (!isEdgeAttachable(site.rects, baseRectId, side)) {
    return { ok: false, rectId: null, toast: TOAST_RECT_EDGE_INNER };
  }
  const g = computeAttachedRect(base, side, anchor, alongLen, depthLen);
  if (!g) return { ok: false, rectId: null, toast: TOAST_RECT_ATTACH_BAD };
  const rectId = addRectWithUndo(site, g.x, g.y, g.w, g.h, true);
  return { ok: true, rectId, toast: null };
}

/**
 * 長方形を削除する（undo あり）。残りが連結でなくなる削除は拒否して undo を積まない。
 * 削除で外周でない辺が新たに内側になることはない（辺は減る一方）ため、道路指定の格下げは不要。
 * undo は同 id・同 roadSides・同じ表示番号（挿入順の位置）で復元する。
 * @returns {{ ok: boolean, toast: string|null }}
 */
export function deleteRect(site, rectId) {
  const rect = site.rectMap.get(rectId);
  if (!rect || !canDeleteRect(site.rects, rectId)) {
    return { ok: false, toast: TOAST_RECT_DELETE_LOCKED };
  }
  const { x, y, w, h } = rect;
  const roadSides = [...rect.roadSides];
  const index = site.rects.findIndex(r => r.id === rectId); // 表示番号（挿入順）を undo で戻すため
  runInAction(() => site.removeRect(rectId));
  undoManager.push(
    () => runInAction(() => { site.insertRectAt(index, x, y, w, h, rectId, [...roadSides]); }),
    () => runInAction(() => site.removeRect(rectId)),
  );
  return { ok: true, toast: null };
}

// 同じ SiteRect の x,y,w,h を書き換え（id・roadSides・選択の reaction を保つ）、外周から外れた辺を格下げして undo 登録する
function rewriteRectWithUndo(site, rect, g) {
  const rectId = rect.id;
  const old = { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
  const setGeom = (v) => {
    const r = site.rectMap.get(rectId);
    if (!r) return;
    r.x = v.x; r.y = v.y; r.w = v.w; r.h = v.h;
  };
  let demoted = [];
  runInAction(() => {
    setGeom(g);
    demoted = demoteInnerRoadSides(site);
  });
  undoManager.push(
    () => runInAction(() => {
      setGeom(old);
      for (const d of demoted) site.rectMap.get(d.rectId)?.roadSides.add(d.side);
    }),
    () => runInAction(() => {
      setGeom(g);
      for (const d of demoted) site.rectMap.get(d.rectId)?.roadSides.delete(d.side);
    }),
  );
}

/**
 * 隣接 0 の長方形の寸法を直す（左上角 x,y は固定）。
 * @returns {{ ok: boolean, toast: string|null }}
 */
export function commitEditFirstRect(site, rectId, w, h) {
  const rect = site.rectMap.get(rectId);
  if (!rect) return { ok: false, toast: TOAST_RECT_BASE_MISSING };
  if (rectNeighbors(site.rects, rectId).length > 0) return { ok: false, toast: TOAST_RECT_EDIT_LOCKED };
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    return { ok: false, toast: TOAST_RECT_SIZE_BAD };
  }
  rewriteRectWithUndo(site, rect, { x: rect.x, y: rect.y, w, h });
  return { ok: true, toast: null };
}

/**
 * 付加入力形式の長方形（隣接 1）の辺長・奥行・基点を直す。幾何は computeAttachedRect。
 * 基の辺の外周判定は対象を除いた rects で行う（対象が基の辺を全部覆っていると全体では内側に見えるため）。
 * @param {'a'|'b'} anchor 基点
 * @returns {{ ok: boolean, toast: string|null }}
 */
export function commitEditAttachedRect(site, rectId, baseRectId, side, anchor, alongLen, depthLen) {
  const rect = site.rectMap.get(rectId);
  if (!rect) return { ok: false, toast: TOAST_RECT_BASE_MISSING };
  if (!canEditRect(site.rects, rectId)) return { ok: false, toast: TOAST_RECT_EDIT_LOCKED };
  const base = site.rectMap.get(baseRectId);
  if (!base || baseRectId === rectId) return { ok: false, toast: TOAST_RECT_BASE_MISSING };
  const others = site.rects.filter(r => r.id !== rectId);
  if (!isEdgeAttachable(others, baseRectId, side)) return { ok: false, toast: TOAST_RECT_EDGE_INNER };
  const g = computeAttachedRect(base, side, anchor, alongLen, depthLen);
  if (!g) return { ok: false, toast: TOAST_RECT_ATTACH_BAD };
  rewriteRectWithUndo(site, rect, g);
  return { ok: true, toast: null };
}
