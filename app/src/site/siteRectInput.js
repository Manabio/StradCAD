// 敷地の長方形入力タブ・描画の判断を担う純関数（SiteInfoPanel.jsx / SiteRectsLayer.jsx が使う）。
// JSX は node:test で直接テストできないため、表の行・入力行・プレビュー矩形・Enter の遷移はここへ寄せる。
import {
  computeAttachedRect, computeUnionAreaM2, computeOutlinePieces, canEditRect, canDeleteRect,
} from './siteRectGeometry.js';
import { siteLineKindLabel } from './siteLineStyle.js';
import { SiteLineKind } from '../core/constants.js';
import { evalNumpadExpr } from '../ui/numpadUtils.js';

// 基点の丸（赤・青）の Konva ノード名。pointerUp の「空白タップ＝選択解除」から除外するために使う
// （Konva は pointerup のあとで click を出すため、丸のタップが先に選択を消してしまう）
export const RECT_ANCHOR_NODE_NAME = 'site-rect-anchor';

// 入力欄の式を数値化する（有限かつ >0 のみ。それ以外は NaN）
export const evalRectLen = (s) => evalNumpadExpr(s, { positiveOnly: true });

/**
 * 長方形タブの表。番号は rects の順（1 始まり）。合計は和集合の面積（重なりは数えない）。
 * canEdit / canDelete は「端の長方形」だけが真（修正可＝隣接 0、または隣接 1 で基の辺・基点を復元できる／削除可＝除いても残りが連結。隣接 2 以上でも削除可はあり得る）。
 * @returns {{ rows: {id:string, num:number, w:number, h:number, areaM2:number, canEdit:boolean, canDelete:boolean}[], totalAreaM2: number }}
 */
export function buildRectTableRows(rects) {
  const rows = rects.map((r, i) => ({
    id: r.id, num: i + 1, w: r.w, h: r.h, areaM2: (r.w * r.h) / 1_000_000,
    canEdit: canEditRect(rects, r.id), canDelete: canDeleteRect(rects, r.id),
  }));
  return { rows, totalAreaM2: computeUnionAreaM2(rects) };
}

const SIDE_ORDER = ['n', 'e', 's', 'w'];
const SIDE_LABEL = { n: '北', e: '東', s: '南', w: '西' };

/**
 * 長方形タブの「外周」表。外周片ごとの行（長方形の番号順→辺 北東南西順）。
 * 線種は辺の道路指定（どれかの所有辺が道路なら道路）で「道路」、無ければ「隣地」。
 * 辺が 2 片以上に分かれるときラベルに連番「1-北(1)」、片が複数の辺に属するときは「1-北/3-南」と並べる。
 * @returns {{ key:string, rectId:string, side:string, pos:number, label:string, length:number, isRoad:boolean, kindLabel:string }[]}
 */
export function buildOutlineRows(rects) {
  const numOf = new Map(rects.map((r, i) => [r.id, i + 1]));
  const roadOf = new Map(rects.map(r => [r.id, r.roadSides]));
  const pieces = computeOutlinePieces(rects);
  // 辺（rectId+side）ごとの片を位置順に並べ、2 片以上なら連番（所有辺ごと）
  const pos = p => p.a.x + p.a.y;
  const ownerKey = o => `${o.rectId}/${o.side}`;
  const byOwner = new Map();
  for (const p of pieces) {
    for (const o of p.owners) {
      const k = ownerKey(o);
      if (!byOwner.has(k)) byOwner.set(k, []);
      byOwner.get(k).push(p);
    }
  }
  for (const list of byOwner.values()) list.sort((u, v) => pos(u) - pos(v));
  const ownerLabel = (o, p) => {
    const list = byOwner.get(ownerKey(o));
    const base = `${numOf.get(o.rectId)}-${SIDE_LABEL[o.side]}`;
    return list.length > 1 ? `${base}(${list.indexOf(p) + 1})` : base;
  };
  return pieces.map((p, i) => {
    const isRoad = p.owners.some(o => roadOf.get(o.rectId)?.has(o.side));
    return {
      key: `${p.rectId}-${p.side}-${i}`,
      rectId: p.rectId,
      side: p.side,
      pos: pos(p),
      label: p.owners.map(o => ownerLabel(o, p)).join('/'),
      length: Math.hypot(p.b.x - p.a.x, p.b.y - p.a.y),
      isRoad,
      kindLabel: siteLineKindLabel(true, isRoad ? SiteLineKind.ROAD : SiteLineKind.SURVEY),
    };
  }).sort((u, v) => numOf.get(u.rectId) - numOf.get(v.rectId) || SIDE_ORDER.indexOf(u.side) - SIDE_ORDER.indexOf(v.side)
    || u.pos - v.pos);
}

// 入力状態 → 入力行の定義（cell は setRectFocusedCell へ渡す値）
export function rectInputRowDefs(st) {
  if (!st) return [];
  if (st.kind === 'first') {
    return [
      { cell: 'w', label: 'よこ', value: st.wValue },
      { cell: 'h', label: 'たて', value: st.hValue },
    ];
  }
  return [
    { cell: 'along', label: '辺長', value: st.alongValue },
    { cell: 'depth', label: '奥行', value: st.depthValue },
  ];
}

// 基点の端の表示名（赤丸が付く側）。a は座標の小さい側（辺が横なら左、縦なら上）
export function rectAnchorLabel(side, anchor) {
  const horizontal = side === 'n' || side === 's';
  if (anchor === 'a') return horizontal ? '左端' : '上端';
  return horizontal ? '右端' : '下端';
}

// フォーカス中のセルの値（キーボード・NumPad が現在値として使う）
export function rectFocusedValue(st) {
  return rectInputRowDefs(st).find(d => d.cell === st?.focusedCell)?.value ?? '';
}

// 修正中の列（'w'＝よこ／'h'＝たて）に対応する入力セル。修正中でなければ null
export function rectEditCell(st, col) {
  return st?.editColumns?.[col] ?? null;
}

// 修正中の列の入力中の値（表のセルに出す）。修正中でなければ ''
export function rectEditColumnValue(st, col) {
  const cell = rectEditCell(st, col);
  return rectInputRowDefs(st).find(d => d.cell === cell)?.value ?? '';
}

// 修正中のフォーカスセルから見た列（'w' | 'h'）。修正中でなければ null
function rectEditColumnOf(st) {
  if (!st?.editColumns) return null;
  return ['w', 'h'].find(col => st.editColumns[col] === st.focusedCell) ?? null;
}

// NumPad の見出し（修正中は表の列名 よこ/たて）
export function rectNumpadLabel(st) {
  const col = rectEditColumnOf(st);
  if (col) return col === 'w' ? 'よこ' : 'たて';
  return rectInputRowDefs(st).find(d => d.cell === st?.focusedCell)?.label ?? '';
}

/**
 * Enter の遷移。1 つ目のセル（w / along）なら 2 つ目へ、2 つ目なら確定。
 * 修正中は表の列順（editColumns.w → editColumns.h）で判定する（attach×縦辺では depth → along になるため）。
 * @returns {{ type:'focus', cell:string } | { type:'confirm' } | null}
 */
export function rectEnterAction(st) {
  if (!st) return null;
  if (st.editColumns) {
    return rectEditColumnOf(st) === 'w' ? { type: 'focus', cell: st.editColumns.h } : { type: 'confirm' };
  }
  if (st.focusedCell === 'w') return { type: 'focus', cell: 'h' };
  if (st.focusedCell === 'along') return { type: 'focus', cell: 'depth' };
  return { type: 'confirm' };
}

/**
 * 入力中の長方形のプレビュー矩形。両方の値が有効（有限かつ >0）でなければ null。
 * attach は共有辺（selectedEdge）の基の長方形と基点から computeAttachedRect で求める。
 * @returns {{x:number, y:number, w:number, h:number} | null}
 */
export function computeRectPreview(rectMap, selectedEdge, anchor, st) {
  if (!st) return null;
  if (st.kind === 'first') {
    const w = evalRectLen(st.wValue);
    const h = evalRectLen(st.hValue);
    if (!Number.isFinite(w) || !Number.isFinite(h)) return null;
    return { x: st.origin.x, y: st.origin.y, w, h };
  }
  if (!selectedEdge) return null;
  const base = rectMap.get(selectedEdge.rectId);
  if (!base) return null;
  const along = evalRectLen(st.alongValue);
  const depth = evalRectLen(st.depthValue);
  if (!Number.isFinite(along) || !Number.isFinite(depth)) return null;
  return computeAttachedRect(base, selectedEdge.side, anchor, along, depth);
}
