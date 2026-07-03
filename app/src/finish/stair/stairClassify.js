import { roomBounds, cellBoundsFromKey } from '../gridCells.js';
import { StairType, totalStepsFromSections } from '@core';

// 直進階段の標準比率ヒント（踏面方向:走行長 ≒ 3:14）。段数推定の妥当性チェック用。
export const STRAIGHT_RATIO = 14 / 3;

const DEFAULT_TREAD = 250; // mm（段数推定用。確定値は寸法フェーズで上書きされる）
const MAX_RISER = 230;     // mm（住宅の蹴上上限。必要段数 = ceil(階高/MAX_RISER)）

// 物理長(mm)から直進部の実段数を逆算する。stair-model.md: 実段数=踏面数+1（長さは踏面数ぶんのtread相当）。
function risersFromLength(lengthMm, treadMm = DEFAULT_TREAD) {
  return Math.max(1, Math.round(lengthMm / treadMm) + 1);
}

// 走行軸方向に並ぶセルの区間（重複は統合）を lo 昇順で返す。
function runSpans(cells, graph, isVertical) {
  const seen = new Map();
  for (const key of cells) {
    const b = cellBoundsFromKey(key, graph);
    if (!b) continue;
    const lo = isVertical ? b.y1 : b.x1;
    const hi = isVertical ? b.y2 : b.x2;
    seen.set(`${Math.round(lo)}:${Math.round(hi)}`, { lo, hi });
  }
  return [...seen.values()].sort((a, b) => a.lo - b.lo);
}

// 中空き階段の検出: グリッド占有のうち「辺の中央」に空きセル（中央吹抜け）があり、
// 周囲を C 字に囲む。空きが角なら矩折、辺中央なら中空き。
// @returns {{ upDirection, straight }|null}
function detectOpenWell(cells, graph, b) {
  const cbs = [];
  const xs = new Set(), ys = new Set();
  for (const key of cells) {
    const cb = cellBoundsFromKey(key, graph);
    if (!cb) continue;
    cbs.push(cb);
    xs.add(Math.round(cb.x1)); xs.add(Math.round(cb.x2));
    ys.add(Math.round(cb.y1)); ys.add(Math.round(cb.y2));
  }
  const xa = [...xs].sort((a, b2) => a - b2);
  const ya = [...ys].sort((a, b2) => a - b2);
  const cols = xa.length - 1, rows = ya.length - 1;
  if (cols < 2 || rows < 2) return null;

  const occ = (i, j) => {
    const cx = (xa[i] + xa[i + 1]) / 2, cy = (ya[j] + ya[j + 1]) / 2;
    return cbs.some(cb => cb.x1 < cx && cx < cb.x2 && cb.y1 < cy && cy < cb.y2);
  };
  let opening = null;
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      if (occ(i, j)) continue;
      const iEdge = i === 0 || i === cols - 1;
      const jEdge = j === 0 || j === rows - 1;
      if (iEdge && !jEdge) opening = i === 0 ? 'left' : 'right';
      else if (jEdge && !iEdge) opening = j === 0 ? 'top' : 'bottom';
      else return null; // 角の空き or 完全内部 → 中空きではない
    }
  }
  if (!opening) return null;

  const W = b.x2 - b.x1, H = b.y2 - b.y1;
  const rightColW = xa[cols] - xa[cols - 1];
  const armLen = (opening === 'left' || opening === 'right') ? W : H;
  const straight = Math.max(2, risersFromLength(armLen - rightColW));
  const UP = { left: 'right', right: 'left', top: 'down', bottom: 'up' };
  return { upDirection: UP[opening], straight };
}

// 矩折（L字90度）の検出: 包絡矩形の4象限のうち3つが埋まり1つが空。
// 空象限の対角がコーナー。@returns {{ upDirection, flip, first, straight }|null}
function detectLTurn(cells, graph, b) {
  const midX = (b.x1 + b.x2) / 2, midY = (b.y1 + b.y2) / 2;
  const q = { tl: false, tr: false, bl: false, br: false };
  const cbs = [];
  for (const key of cells) {
    const cb = cellBoundsFromKey(key, graph);
    if (!cb) continue;
    cbs.push(cb);
    if (cb.x1 < midX && cb.y1 < midY) q.tl = true;
    if (cb.x2 > midX && cb.y1 < midY) q.tr = true;
    if (cb.x1 < midX && cb.y2 > midY) q.bl = true;
    if (cb.x2 > midX && cb.y2 > midY) q.br = true;
  }
  if ([q.tl, q.tr, q.bl, q.br].filter(Boolean).length !== 3) return null;
  const empty = !q.tl ? 'tl' : !q.tr ? 'tr' : !q.bl ? 'bl' : 'br';
  // 空象限 → 昇り方向・反転・コーナー位置（arm1 は水平、コーナーは空象限の対角）
  const MAP = {
    tl: { upDirection: 'right', flip: false, cx: 'max', cy: 'max' },
    bl: { upDirection: 'right', flip: true,  cx: 'max', cy: 'min' },
    tr: { upDirection: 'left',  flip: false, cx: 'min', cy: 'max' },
    br: { upDirection: 'left',  flip: true,  cx: 'min', cy: 'min' },
  };
  const m = MAP[empty];
  const cornerPt = { x: m.cx === 'max' ? b.x2 : b.x1, y: m.cy === 'max' ? b.y2 : b.y1 };
  let cc = null, best = Infinity;
  for (const cb of cbs) {
    const d = Math.hypot((cb.x1 + cb.x2) / 2 - cornerPt.x, (cb.y1 + cb.y2) / 2 - cornerPt.y);
    if (d < best) { best = d; cc = cb; }
  }
  const cw = cc ? cc.x2 - cc.x1 : 0, ch = cc ? cc.y2 - cc.y1 : 0;
  return {
    upDirection: m.upDirection,
    flip: m.flip,
    first:    risersFromLength((b.x2 - b.x1) - cw),
    straight: risersFromLength((b.y2 - b.y1) - ch),
  };
}

// U字（180度）系の検出: 幅方向に2レーン（上下/左右）。
//   折り返し部が「両レーンをまたぐ1セル」→ 屈折（踊り場）
//   折り返し部が「レーンごとに分割された複数セル」→ 回り（回り段）
// @returns {{ kind:'switchback'|'winding', laneLen, landingHigh, turnLen }|null}
function detectUTurn(cells, graph, isVertical, b) {
  const acrossMin = isVertical ? b.x1 : b.y1;
  const acrossMax = isVertical ? b.x2 : b.y2;
  const acrossFull = (acrossMax - acrossMin) || 1;
  const mid = (acrossMin + acrossMax) / 2;

  const landingFull = []; // 両レーンをまたぐセル（踊り場）
  const laneCells = [];    // 半幅セル（レーン）
  for (const key of cells) {
    const cb = cellBoundsFromKey(key, graph);
    if (!cb) continue;
    const aLo = isVertical ? cb.x1 : cb.y1;
    const aHi = isVertical ? cb.x2 : cb.y2;
    const rLo = isVertical ? cb.y1 : cb.x1;
    const rHi = isVertical ? cb.y2 : cb.x2;
    const frac = (aHi - aLo) / acrossFull;
    const rCenter = (rLo + rHi) / 2;
    if (frac >= 0.9) landingFull.push({ rCenter });
    else if (frac <= 0.6) laneCells.push({ half: (aLo + aHi) / 2 < mid ? 'low' : 'high', rLo, rHi, rCenter, runLen: rHi - rLo });
  }
  if (!laneCells.some(c => c.half === 'low') || !laneCells.some(c => c.half === 'high')) return null;

  // 屈折: 全幅の踊り場セルがある
  if (landingFull.length >= 1) {
    const laneLen = Math.max(...laneCells.map(c => c.runLen));
    const landCenter = landingFull.reduce((s, l) => s + l.rCenter, 0) / landingFull.length;
    const laneCenter = laneCells.reduce((s, c) => s + c.rCenter, 0) / laneCells.length;
    return { kind: 'switchback', laneLen, landingHigh: landCenter > laneCenter };
  }

  // 回り: 走行方向に2列（直進部の広い列 + 回り段の狭い列）
  const spanMap = new Map();
  for (const c of laneCells) spanMap.set(`${Math.round(c.rLo)}:${Math.round(c.rHi)}`, c);
  const spans = [...spanMap.values()].sort((a, b2) => (a.runLen) - (b2.runLen));
  if (spans.length >= 2) {
    const turn = spans[0];                 // 最短列 = 回り段
    const straight = spans[spans.length - 1]; // 最長列 = 直進部
    return {
      kind: 'winding',
      laneLen: straight.runLen,
      turnLen: turn.runLen,
      landingHigh: turn.rCenter > straight.rCenter,
    };
  }
  return null;
}

/**
 * 設置エリア（cells）から階段タイプと向きを推定する。
 * MVP: 常に STRAIGHT。長辺を走行軸、短辺を階段幅とみなす。
 *
 * @param {Set<string>} cells - 設置エリアのセルキー集合
 * @param {object} graph
 * @returns {{
 *   type: string,
 *   bounds: { x1, y1, x2, y2 },
 *   isVertical: boolean,  // 走行軸が Y方向か（縦長エリア）
 *   runLength: number,    // 走行方向の全長(mm)
 *   runWidth: number,     // 階段幅方向の寸法(mm)
 *   upDirection: string,  // 'up'|'down'|'left'|'right'（既定の昇り方向。後でユーザーが反転可）
 * }}
 */
export function classifyStairArea(cells, graph, floorHeight = null) {
  const b = roomBounds(cells, graph);
  const w = b.x2 - b.x1;   // 横幅
  const h = b.y2 - b.y1;   // 縦幅
  const isVertical = h >= w;            // 縦長なら走行軸=Y
  const runLength  = isVertical ? h : w;
  const runWidth   = isVertical ? w : h;
  // 既定の昇り方向: 縦長は上向き(-y)、横長は右向き(+x)。flip/回転で調整。
  let upDirection = isVertical ? 'up' : 'right';

  let type = StairType.STRAIGHT;
  let sections = null;
  let flip = false;

  // 中空き（中央吹抜け）を優先判定。踊り場（1段）を挟んだ [n1,1,n2,1,n3] の5区間。
  const ow = detectOpenWell(cells, graph, b);
  if (ow) {
    const owSections = [ow.straight, 1, ow.straight, 1, ow.straight];
    return {
      type: StairType.OPEN_WELL, bounds: b, isVertical, runLength, runWidth,
      upDirection: ow.upDirection, flip: false,
      sections: owSections,
      totalSteps: totalStepsFromSections(owSections),
    };
  }

  // 矩折（L字）を判定（4象限のうち1象限が空）。
  const lt = detectLTurn(cells, graph, b);
  if (lt) {
    // 矩折（直進2アーム）の段数。階高に対して不足するならコーナーを曲がり段（実段）で補い FLARED に落とす。
    // コーナーは平踊り場なら1段（総段数に足されない）、曲がり段なら実段差（マスw＝w段ぶん足される）。
    const baseTotal = lt.first + lt.straight; // 矩折（コーナー平踊り場）の総段数
    const required = floorHeight ? Math.ceil(floorHeight / MAX_RISER) : 0;
    const corner = required > baseTotal ? required - baseTotal + 1 : 1;
    const ltType = corner > 1 ? StairType.FLARED : StairType.L_TURN;
    const ltSections = [lt.first, corner, lt.straight];
    return {
      type: ltType, bounds: b, isVertical, runLength, runWidth,
      upDirection: lt.upDirection, flip: lt.flip,
      sections: ltSections,
      totalSteps: totalStepsFromSections(ltSections),
    };
  }

  // U字（屈折／回り）を判定。
  const ut = detectUTurn(cells, graph, isVertical, b);
  if (ut) {
    // 折り返し部が走行高位端にあれば昇り起点は低位側 → 高位へ向かう向き
    upDirection = isVertical
      ? (ut.landingHigh ? 'down' : 'up')
      : (ut.landingHigh ? 'right' : 'left');
    const straight = risersFromLength(ut.laneLen);
    if (ut.kind === 'switchback') {
      type = StairType.SWITCHBACK;
      sections = [straight, 1, straight];      // 踊り場（1段）を挟んだ往路・復路
    } else {
      type = StairType.WINDING;
      const winder = risersFromLength(ut.turnLen);
      sections = [straight, winder, straight]; // 回り段（実段）を挟んだ往路・復路
    }
    return {
      type, bounds: b, isVertical, runLength, runWidth, upDirection, sections,
      totalSteps: totalStepsFromSections(sections), flip,
    };
  }

  // 走行軸が「広い・狭い・広い」の3区間なら踊り場付直進と判定する。
  const spans = runSpans(cells, graph, isVertical);
  let totalSteps;
  if (spans.length === 3) {
    const len = (s) => s.hi - s.lo;
    const [s0, s1, s2] = spans;
    if (len(s1) < len(s0) * 0.85 && len(s1) < len(s2) * 0.85) {
      type = StairType.STRAIGHT_LANDING;
      // 基部側（昇り起点）の外側区間を first、反対側を straight とする。踊り場は常に1段。
      const baseLow = upDirection === 'right' || upDirection === 'down';
      const firstSpan    = baseLow ? s0 : s2;
      const straightSpan = baseLow ? s2 : s0;
      const first    = risersFromLength(len(firstSpan));
      const straight = risersFromLength(len(straightSpan));
      sections = [first, 1, straight];
      totalSteps = totalStepsFromSections(sections);
    }
  }

  return {
    type,
    bounds: b,
    isVertical,
    runLength,
    runWidth,
    upDirection,
    sections,
    totalSteps,
    flip,
  };
}

/**
 * 設置セルから区間長（歩行順・sections 対応の mm 配列）を実測する（区間長指定の描画反映用）。
 * セル割りから導出できないタイプ・形状は null（描画側は 踏面寸×マス数 の合成にフォールバック）。
 * @returns {{ lengths:number[] }|null}
 */
export function measureStairSpans(stair, graph) {
  if (!graph || !stair?.cells || stair.cells.size === 0) return null;
  const vertical = stair.upDirection === 'up' || stair.upDirection === 'down';
  const b = roomBounds(stair.cells, graph);
  if (![b.x1, b.y1, b.x2, b.y2].every(Number.isFinite)) return null;
  const runLength = (vertical ? b.y2 - b.y1 : b.x2 - b.x1) || 1;
  switch (stair.type) {
    case StairType.STRAIGHT_LANDING: {
      const spans = runSpans(stair.cells, graph, vertical);
      if (spans.length !== 3) return null;
      const lens = spans.map(s => s.hi - s.lo);
      // 歩行順（昇り始端→終端）に並べる: 昇りが軸負方向（up/left）なら反転
      if (stair.upDirection === 'up' || stair.upDirection === 'left') lens.reverse();
      return { lengths: lens };
    }
    case StairType.SWITCHBACK:
    case StairType.WINDING: {
      const ut = detectUTurn(stair.cells, graph, vertical, b);
      if (!ut || !(ut.laneLen > 0) || ut.laneLen >= runLength) return null;
      // [往路, 踊り場・回り部の深さ, 復路]。復路レーン長は往路と同じ（平行レーン）。
      return { lengths: [ut.laneLen, runLength - ut.laneLen, ut.laneLen] };
    }
    default:
      return null;
  }
}
