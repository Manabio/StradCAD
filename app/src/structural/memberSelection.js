// ================================================================
// 構造リストで選んだ部材を描画エリア（伏図）で「選択状態」に見せるためのハイライト矩形を解く純モジュール
// （react/konva/store 非依存。node:test から単体 import 可能——team-lessons「抽出モジュールは呼び出し側も
// テストで守る」）。ユーザー裁定2026-09-16「構造パネル構造リスト・タブ内の材（柱、梁など）を選択すると、
// 描画エリアの当該材が選択状態に」。
//
// 選択の単位は構造リストのカード（同一タグ＝同一形状の全部材）——展開中のカードの members 全員を
// StructuralModeState.selectedMemberIds に載せ、renderer/StructuralLayer.jsx がこのモジュールで矩形へ写す。
// 伏図が全黒（在来木造 framingPlanColor:'mono'）でも見分けられるよう、部材の実形状に重ねる半透明の
// 青塗り＋青枠（アプリ共通の選択色 '#2563eb'。renderer/OpeningTagLayer.jsx・SnapIndicator.jsx と同じ）で示す。
// 線色を変える方式は採らない——全黒規約（framingColor）と衝突し、非在来の材種色とも紛れるため。
// ================================================================

/** アプリ共通の選択色（枠線）。 */
export const MEMBER_SELECTION_COLOR = '#2563eb';
/** 塗り（半透明の同色。Konva の opacity は枠線まで薄めるため rgba で塗りだけ薄くする）。 */
export const MEMBER_SELECTION_FILL  = 'rgba(37, 99, 235, 0.22)';
/** 枠線の太さ（画面px。ズームに依らず一定）。 */
export const MEMBER_SELECTION_STROKE_PX = 1.5;
/** 帯状部材（梁・耐力壁）のハイライト半幅の最小値（画面px）。略図LODの単線（幅null）や仮幅の細い帯でも
 *  指で見える太さを保つ。 */
export const MEMBER_SELECTION_MIN_HALF_PX = 5;
/** 部材の外形からハイライトを広げる余白（画面px）。輪郭線と枠が重なって見えなくならないため。 */
export const MEMBER_SELECTION_PAD_PX = 3;

// 帯状部材（軸 axisValue に沿って lo〜hi、半幅 half）の軸並行矩形。
function bandRect(key, isVertical, axisValue, lo, hi, half, pad) {
  const a = Math.min(lo, hi) - pad, b = Math.max(lo, hi) + pad;
  const h = half + pad;
  return isVertical
    ? { key, x: axisValue - h, y: a, width: 2 * h, height: b - a, offsetX: 0, offsetY: 0, rotation: 0 }
    : { key, x: a, y: axisValue - h, width: b - a, height: 2 * h, offsetX: 0, offsetY: 0, rotation: 0 };
}

// 点状部材（中心 x,y・外形 w×h・回転 rotation）の中心原点矩形（Konva Rect の offset 規約）。
function centeredRect(key, x, y, w, h, rotation, pad) {
  const W = w + 2 * pad, H = h + 2 * pad;
  return { key, x, y, width: W, height: H, offsetX: W / 2, offsetY: H / 2, rotation: rotation ?? 0 };
}

/**
 * 選択中の部材のハイライト矩形（ワールド座標。Konva Rect にそのまま渡せる props）を返す。
 * 入力は呼び出し側（StructuralLayer.jsx）が描画に使っているのと同じ解決済みの幾何を渡す——ここで
 * 断面カタログや spanForColumns を引き直さない（描画とハイライトの位置ズレを作らないため）。
 * @param {object} src 省略・undefined の配列は空扱い
 *   columns:  [{ id, x, y, rotation, width, height }]        断面外形（columnSectionSize で解決済み）
 *   beams:    [{ id, isVertical, axisValue, coord1, coord2, halfWidth }] スパンは柱手前でトリム済み。halfWidth null＝単線
 *   footings: [{ id, x, y, widthX, widthY }]
 *   walls:    [{ id, isVertical, axisValue, coord1, coord2, half }]  耐力壁は開口で分割せず全長1本で示す（選択の単位は部材）
 *   slabs:    [{ id, cells: [{ x1, y1, x2, y2 }] }]            セル矩形の集合（1部材=複数矩形）
 * @param {Iterable<string>|null|undefined} selectedIds 選択中の部材id集合
 * @param {number} pxToWorld 画面1pxのワールド長（= 1 / scale）。最小半幅・余白の換算に使う
 * @returns {Array<{ key, x, y, width, height, offsetX, offsetY, rotation }>}
 */
export function memberSelectionRects(src, selectedIds, pxToWorld) {
  const ids = selectedIds instanceof Set ? selectedIds : new Set(selectedIds ?? []);
  if (ids.size === 0 || !src) return [];
  const pad     = MEMBER_SELECTION_PAD_PX * pxToWorld;
  const minHalf = MEMBER_SELECTION_MIN_HALF_PX * pxToWorld;
  const out = [];
  for (const c of src.columns ?? []) {
    if (ids.has(c.id)) out.push(centeredRect(`sel:column:${c.id}`, c.x, c.y, c.width, c.height, c.rotation, pad));
  }
  for (const b of src.beams ?? []) {
    if (!ids.has(b.id)) continue;
    const half = Math.max(b.halfWidth ?? 0, minHalf);
    out.push(bandRect(`sel:beam:${b.id}`, b.isVertical, b.axisValue, b.coord1, b.coord2, half, pad));
  }
  for (const f of src.footings ?? []) {
    if (ids.has(f.id)) out.push(centeredRect(`sel:footing:${f.id}`, f.x, f.y, f.widthX, f.widthY, 0, pad));
  }
  for (const w of src.walls ?? []) {
    if (!ids.has(w.id)) continue;
    const half = Math.max(w.half ?? 0, minHalf);
    out.push(bandRect(`sel:wall:${w.id}`, w.isVertical, w.axisValue, w.coord1, w.coord2, half, pad));
  }
  for (const s of src.slabs ?? []) {
    if (!ids.has(s.id)) continue;
    (s.cells ?? []).forEach((cell, i) => {
      out.push({
        key: `sel:slab:${s.id}:${i}`, x: cell.x1, y: cell.y1,
        width: cell.x2 - cell.x1, height: cell.y2 - cell.y1, offsetX: 0, offsetY: 0, rotation: 0,
      });
    });
  }
  return out;
}

/** 2つのid集合が同じ要素を持つか（選択の更新で同内容なら observable を書き換えない判定用）。 */
export function sameIdSet(a, b) {
  if (a === b) return true;
  if (!a || !b || a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}
