import { roomBounds, cellBoundsFromKey } from '../gridCells.js';
import { StairType, StructuralMaterialType, totalStepsFromSections } from '@core';
import { STAIR_LIMITS } from './stairDimensions.js';
import { makeFrame } from './stairFrame.js';
import { resolveStairPath } from './stairPath.js';

// 直進階段の標準比率ヒント（踏面方向:走行長 ≒ 3:14）。段数推定の妥当性チェック用。
export const STRAIGHT_RATIO = 14 / 3;

// mm — 踊り場の最小長さ。stairGeometry.jsが本ファイルをimportするため
// （measureStairSpans/detectUTurn）、循環import回避のため定義側は本ファイルに置き、
// stairGeometry.jsはre-exportする（WP-A1: resolveSwitchbackSpanLengthsが必要とするため）。
export const MIN_LANDING = 1200;

const DEFAULT_TREAD = 250; // mm（段数推定用。確定値は寸法フェーズで上書きされる）
// mm（住宅の蹴上上限。必要段数 = ceil(階高/MAX_RISER)）。基準法上の制限値は stairDimensions.js に一本化。
const MAX_RISER = STAIR_LIMITS.residential.maxRiser;
const SPAN_EPS = 0.5;      // mm — 区間実測（uTurnSpans）の辺一致・被覆判定の許容差

// STRAIGHT entryヒント: entryセル中心が走行軸中点とみなせる距離(mm)。単一セル・奇数分割の
// 中央セル等、低座標/高座標のどちらとも言えない場合に上書きを抑止するための許容値。
const STRAIGHT_ENTRY_MID_EPS = 1;

/**
 * entryCellKeys（選択順のセルキー配列）から、landingKeys（踊場・周回部セル）を除いた
 * 先頭の有効なセルキーを返す（＝上り口セル）。cells に含まれないキーは無視する。
 * 全て踊場・該当なしの場合は null（呼び出し側は現行の幾何推定にフォールバックする）。
 */
function resolveEntryCellKey(entryCellKeys, cells, landingKeys) {
  if (!entryCellKeys) return null;
  for (const key of entryCellKeys) {
    if (!cells.has(key)) continue; // 防御: cells に無いキーは無視
    if (landingKeys && landingKeys.has(key)) continue; // 踊場・周回部セルはスキップ
    return key;
  }
  return null;
}

// 走行軸(isVertical)の区間 span（{lo,hi}）に属するセルキー集合を返す（runSpans と同じ丸め規則）。
function cellKeysInSpan(cells, graph, isVertical, span) {
  const keys = new Set();
  for (const key of cells) {
    const cb = cellBoundsFromKey(key, graph);
    if (!cb) continue;
    const lo = isVertical ? cb.y1 : cb.x1;
    const hi = isVertical ? cb.y2 : cb.x2;
    if (Math.round(lo) === Math.round(span.lo) && Math.round(hi) === Math.round(span.hi)) keys.add(key);
  }
  return keys;
}

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

// L字（3象限占有）の空象限とコーナーセル実測。空象限の対角（コーナー）に最も近いセルの
// 幅 cw・高さ ch がアーム幅の実測値になる。corner はコーナーセルの実セル境界
//（アーム識別の行帯・列帯の基準）。@returns {{ empty, cw, ch, corner }|null}
function lTurnCornerCell(cells, graph, b) {
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
  const cornerPt = {
    x: empty === 'tl' || empty === 'bl' ? b.x2 : b.x1,
    y: empty === 'tl' || empty === 'tr' ? b.y2 : b.y1,
  };
  let cc = null, best = Infinity;
  for (const cb of cbs) {
    const d = Math.hypot((cb.x1 + cb.x2) / 2 - cornerPt.x, (cb.y1 + cb.y2) / 2 - cornerPt.y);
    if (d < best) { best = d; cc = cb; }
  }
  if (!cc) return null;
  return { empty, cw: cc.x2 - cc.x1, ch: cc.y2 - cc.y1, corner: cc };
}

// 矩折（L字90度）の検出: 包絡矩形の4象限のうち3つが埋まり1つが空。
// 空象限の対角がコーナー。upDirection/flip は水平アームを arm1（上り始め）とする既定写像。
// entryヒント用に armOf（セルキー → 'h'水平アーム|'v'垂直アーム。コーナーセルは登録しない
// ＝スキップ対象）と、垂直アームを arm1 とする代替写像 vAlt も返す。
// first/straight は水平/垂直アームの実段数（vAlt 採用時は呼び出し側が歩行順に入れ替える）。
// @returns {{ upDirection, flip, vAlt:{upDirection,flip}, armOf, first, straight }|null}
function detectLTurn(cells, graph, b) {
  const cc = lTurnCornerCell(cells, graph, b);
  if (!cc) return null;
  // 空象限 → 昇り方向・反転。normToWorld（stairGeometry.js）は upDirection×flip の8通りで
  // 正方形の全対称を写像でき、同じL字形状（コーナー位置）に対して MAP=水平アームが arm1
  //（left/right 系。u軸=水平）と V_MAP=垂直アームが arm1（up/down 系。u軸=垂直）の2通りがある。
  // どちらもコーナー（正規化(1,1)）は空象限の対角に写る。
  const MAP = {
    tl: { upDirection: 'right', flip: false },
    bl: { upDirection: 'right', flip: true },
    tr: { upDirection: 'left',  flip: false },
    br: { upDirection: 'left',  flip: true },
  };
  const V_MAP = {
    tl: { upDirection: 'down', flip: false },
    bl: { upDirection: 'up',   flip: false },
    tr: { upDirection: 'down', flip: true },
    br: { upDirection: 'up',   flip: true },
  };
  // アーム識別: セル中心がコーナーセルの行帯（y範囲）内なら水平アーム、列帯（x範囲）内なら
  // 垂直アーム。両方＝コーナーセル自身はどちらでもないため登録しない。
  const armOf = new Map();
  for (const key of cells) {
    const cb = cellBoundsFromKey(key, graph);
    if (!cb) continue;
    const cx = (cb.x1 + cb.x2) / 2, cy = (cb.y1 + cb.y2) / 2;
    const inRow = cy > cc.corner.y1 && cy < cc.corner.y2;
    const inCol = cx > cc.corner.x1 && cx < cc.corner.x2;
    if (inRow !== inCol) armOf.set(key, inRow ? 'h' : 'v');
  }
  const m = MAP[cc.empty];
  return {
    upDirection: m.upDirection,
    flip: m.flip,
    vAlt: V_MAP[cc.empty],
    armOf,
    first:    risersFromLength((b.x2 - b.x1) - cc.cw),
    straight: risersFromLength((b.y2 - b.y1) - cc.ch),
  };
}

// U字（180度）系の検出: 幅方向に2レーン（上下/左右）。
//   折り返し部が「両レーンをまたぐ1セル」→ 屈折（踊り場）
//   折り返し部が「レーンごとに分割された複数セル」→ 回り（回り段）
// @returns {{ kind:'switchback'|'winding', laneLen, landingHigh, turnLen }|null}
export function detectUTurn(cells, graph, isVertical, b) {
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
    else if (frac <= 0.6) laneCells.push({ key, half: (aLo + aHi) / 2 < mid ? 'low' : 'high', rLo, rHi, rCenter, runLen: rHi - rLo });
  }
  if (!laneCells.some(c => c.half === 'low') || !laneCells.some(c => c.half === 'high')) return null;

  // 屈折: 全幅の踊り場セルがある。laneHalf = レーンセルキー → 幅方向どちらの半分か
  //（entryヒントのレーン識別用。踊り場セルは含まれない＝スキップ対象になる）。
  if (landingFull.length >= 1) {
    const laneLen = Math.max(...laneCells.map(c => c.runLen));
    const landCenter = landingFull.reduce((s, l) => s + l.rCenter, 0) / landingFull.length;
    const laneCenter = laneCells.reduce((s, c) => s + c.rCenter, 0) / laneCells.length;
    return {
      kind: 'switchback', laneLen, landingHigh: landCenter > laneCenter,
      laneHalf: new Map(laneCells.map(c => [c.key, c.half])),
    };
  }

  // 回り: 走行方向に2列（直進部の広い列 + 回り段の狭い列）
  const spanMap = new Map();
  for (const c of laneCells) spanMap.set(`${Math.round(c.rLo)}:${Math.round(c.rHi)}`, c);
  // 同長なら走行座標の低い列を先にする（Set の並び順に依存しない決定的なタイ・ブレーク）
  const spans = [...spanMap.values()].sort((a, b2) => (a.runLen - b2.runLen) || (a.rLo - b2.rLo));
  if (spans.length >= 2) {
    const turn = spans[0];                 // 最短列 = 回り段
    const straight = spans[spans.length - 1]; // 最長列 = 直進部
    const turnSpanKey = `${Math.round(turn.rLo)}:${Math.round(turn.rHi)}`;
    return {
      kind: 'winding',
      laneLen: straight.runLen,
      turnLen: turn.runLen,
      landingHigh: turn.rCenter > straight.rCenter,
      // 回り段列（周回部）のセルはレーン識別から除外＝entryヒントのスキップ対象
      laneHalf: new Map(laneCells
        .filter(c => `${Math.round(c.rLo)}:${Math.round(c.rHi)}` !== turnSpanKey)
        .map(c => [c.key, c.half])),
    };
  }
  return null;
}

/**
 * U字の各セルを走行軸 t・幅方向 s の区間へ写し、レーン（A=往路 s<0.5／B=復路 s>0.5／null=回転部ほか）に
 * 分類する。uTurnSpans（区間実測）と stairPorts.js（出入口の候補列挙）が同じ分類を使う。
 * 回転部が取れない（遠端に接するセルが無い・回転部が走行全長を占める）なら null。
 * @returns {{ f:object, L:number, tEps:number, tRun:number, isBaseStrip:(c:object)=>boolean,
 *   infos:{ key:string, cb:object, tNear:number, tFar:number, sLo:number, sHi:number,
 *     fullWidth:boolean, farTouching:boolean, lane:'A'|'B'|null }[] }|null}
 */
export function uTurnCellInfos(stair, graph, b = null) {
  if (!graph || !stair?.cells || stair.cells.size === 0) return null;
  const bb = b ?? roomBounds(stair.cells, graph);
  if (![bb.x1, bb.y1, bb.x2, bb.y2].every(Number.isFinite)) return null;
  const f = makeFrame(stair, bb);
  const L = f.runLength;
  const acrossLen = (f.vertical ? bb.x2 - bb.x1 : bb.y2 - bb.y1) || 1;
  const tEps = SPAN_EPS / L, sEps = SPAN_EPS / acrossLen;

  const infos = [];
  for (const key of stair.cells) {
    const cb = cellBoundsFromKey(key, graph);
    if (!cb) continue;
    const p1 = { x: cb.x1, y: cb.y1 }, p2 = { x: cb.x2, y: cb.y2 };
    const t1 = f.tOf(p1), t2 = f.tOf(p2), s1 = f.sOf(p1), s2 = f.sOf(p2);
    const tNear = Math.min(t1, t2), tFar = Math.max(t1, t2);
    const sLo = Math.min(s1, s2), sHi = Math.max(s1, s2);
    infos.push({ key, cb, tNear, tFar, sLo, sHi, fullWidth: sLo <= sEps && sHi >= 1 - sEps, farTouching: tFar >= 1 - tEps, lane: null });
  }
  // 基端側の全幅セル（レーンが始まるより手前にある全幅セル）は回転部ではなく往路の取りつき
  //（設置階上階スラブの張り出し下の踏み込み。実データ moku2-2）。往路レーンAの被覆に数える。
  const laneInfos = infos.filter(c => !c.fullWidth);
  const minLaneNear = laneInfos.length ? Math.min(...laneInfos.map(c => c.tNear)) : 0;
  const isBaseStrip = (c) => c.fullWidth && !c.farTouching && c.tNear < minLaneNear - tEps;
  const turnCells = infos.filter(c => c.farTouching || (c.fullWidth && !isBaseStrip(c)));
  if (turnCells.length === 0) return null;
  const tRun = Math.min(...turnCells.map(c => c.tNear));
  if (!(tRun > tEps) || tRun >= 1 - tEps) return null;
  for (const c of infos) {
    if (isBaseStrip(c)) c.lane = 'A';
    else if (!c.fullWidth) c.lane = (c.sLo + c.sHi) / 2 < 0.5 ? 'A' : ((c.sLo + c.sHi) / 2 > 0.5 ? 'B' : null);
  }
  return { f, L, tEps, tRun, isBaseStrip, infos };
}

/**
 * U字（SWITCHBACK/WINDING）の区間実測。回転部（踊り場・回り段）＝**走行軸の遠端（upDirection の先）
 * に接する帯**（全幅セルがあればそれも含む）と定義し、往路＝幅方向 s<0.5 側（flip 込み）、
 * 復路＝s>0.5 側のセルが回転部前縁までに走行軸を覆う長さを各レーン長とする（往路≠復路の不等長可）。
 * 旧 detectUTurn の「最短スパン＝回り段」「安定ソート＝Set の並び順」への依存を持たない。
 * 描画（uTurnLayout）・破れ先セル判定（cellsBeyondBreak）・階段下壁（stairUnderWalls）が同じ tRun を読む。
 * @returns {{ laneA:number, depth:number, laneB:number, tRun:number, entryFull:boolean, firstRowA:number, firstRowB:number }|null} mm 長と回転部前縁 t。
 *   entryFull は往路の張り出し（取りつき）が全幅セル（両レーンにまたがる基端側の全幅セル）か。
 *   firstRowA/B は各レーンの基端の行の走行長（mm。等長レーンで出入口を側面にするときの区画）。
 *   回転部が取れない（遠端に接するセルが無い・回転部が走行全長を占める・片レーンが空）なら null。
 */
export function uTurnSpans(stair, graph, b = null) {
  const ci = uTurnCellInfos(stair, graph, b);
  if (!ci) return null;
  const { L, tEps, tRun, infos, isBaseStrip } = ci;

  // レーン長 = 回転部前縁までの走行軸の被覆長（区間の和集合。幅方向に細分されたセルの二重計上を防ぐ）
  const coverage = (side) => {
    const ivs = infos
      .filter(c => c.lane === side)
      .map(c => [c.tNear, Math.min(c.tFar, tRun)])
      .filter(([lo, hi]) => hi - lo > tEps)
      .sort((p, q) => p[0] - q[0]);
    let total = 0, curLo = null, curHi = null;
    for (const [lo, hi] of ivs) {
      if (curHi == null || lo > curHi) { if (curHi != null) total += curHi - curLo; curLo = lo; curHi = hi; }
      else curHi = Math.max(curHi, hi);
    }
    if (curHi != null) total += curHi - curLo;
    return total * L;
  };
  const laneA = coverage('A'), laneB = coverage('B');
  if (!(laneA > 0) || !(laneB > 0)) return null;
  // 基端の行 = レーンの基端（最小 tNear）から始まるセル群が走行軸を覆う長さ（等長レーンの出入口の区画。
  // 幅方向に細分されたセルは同じ行。行内で終端がそろわないときは短い方に合わせる）
  const firstRow = (side) => {
    const own = infos.filter(c => c.lane === side && c.tNear < tRun - tEps);
    if (own.length === 0) return 0;
    const near = Math.min(...own.map(c => c.tNear));
    const row = own.filter(c => c.tNear <= near + tEps);
    return (Math.min(...row.map(c => Math.min(c.tFar, tRun))) - near) * L;
  };
  // t（比率）経由の往復で生じる 1e-13 級の丸め誤差を落とす（区間長は mm。消費側は等値比較もする）
  const mm = (v) => Math.round(v * 1e6) / 1e6;
  return {
    laneA: mm(laneA), depth: mm((1 - tRun) * L), laneB: mm(laneB), tRun, entryFull: infos.some(isBaseStrip),
    firstRowA: mm(firstRow('A')), firstRowB: mm(firstRow('B')),
  };
}

/**
 * stair.sections が未設定（null）の場合に totalSteps から妥当な既定値を組み立てる
 *（totalStepsFromSections の逆算。区間の実段数は直進部≥2・周回部≥1 を保つ）。
 */
export function defaultSections(stair) {
  const total = Math.max(2, stair.totalSteps);
  const half = (t) => { const a = Math.max(2, Math.ceil(t / 2)); return [a, Math.max(2, t - a)]; };
  switch (stair.type) {
    case StairType.STRAIGHT:
      return [total];
    case StairType.STRAIGHT_LANDING:
    case StairType.L_TURN:
    case StairType.SWITCHBACK: {
      const [a, s] = half(total);
      return [a, 1, s];
    }
    case StairType.WINDING: {
      const w = 3;
      const [a, s] = half(total + 1 - w);
      return [a, w, s];
    }
    case StairType.FLARED: {
      const w = 2;
      const [a, s] = half(total + 1 - w);
      return [a, w, s];
    }
    case StairType.OPEN_WELL: {
      const n = Math.max(2, Math.ceil(total / 3));
      return [n, 1, n, 1, Math.max(2, total - 2 * n)];
    }
    default:
      return null;
  }
}

/**
 * 側面の出入口に取りつく回転部（張り出し区間）の初期蹴上数。鉄骨は 0（平場の踏み込み踊り場）、
 * 木造は張り出し奥行÷踏面（中間の回転部 R の初期値と同じ規則）。
 * classifyStairArea（新規作成）と StairPanel の出入口切替（stairSectionEdit.js）が共有する。
 */
export function defaultPortTurnSteps(structure, overhangMm, tread = DEFAULT_TREAD) {
  if (structure === StructuralMaterialType.STEEL) return 0;
  return Math.max(1, Math.round(overhangMm / (tread > 0 ? tread : DEFAULT_TREAD)));
}

// 建築基準法（住宅の蹴上上限）から必要蹴上数を求める。階高未確定なら 0。
function requiredRisers(floorHeight) {
  return floorHeight > 0 ? Math.ceil(floorHeight / MAX_RISER) : 0;
}

// 総蹴上数 total から回転部の段数 R を除いた残りを往路・復路へ配分する（原則同数。端数は往路へ）。
function splitRuns(total, turnSteps) {
  const n = Math.max(2, total - turnSteps);
  const n1 = Math.ceil(n / 2);
  return [Math.max(1, n1), Math.max(1, n - n1)];
}

// 走行軸方向の全長（セル列の走行方向の被覆。区間セルは歩行順に連続しているので端点差で足りる）。
function runExtentOf(keys, graph, vertical) {
  let lo = Infinity, hi = -Infinity;
  for (const key of keys) {
    const cb = cellBoundsFromKey(key, graph);
    if (!cb) continue;
    lo = Math.min(lo, vertical ? cb.y1 : cb.x1);
    hi = Math.max(hi, vertical ? cb.y2 : cb.x2);
  }
  return Number.isFinite(lo) && Number.isFinite(hi) ? hi - lo : 0;
}

// 幅方向（走行軸に直交）の中心座標。
function acrossCenterOf(key, graph, vertical) {
  const cb = cellBoundsFromKey(key, graph);
  if (!cb) return null;
  return vertical ? (cb.x1 + cb.x2) / 2 : (cb.y1 + cb.y2) / 2;
}

/**
 * 歩行経路（resolveStairPath の結果）から階段モデルを機械的に導く。
 *   upDirection = 往路の進行方向（上り口＝先頭セルの、往路方向と反対の辺）。
 *   flip        = 往路レーンが幅方向の高座標側なら true（makeFrame の s=0 側に往路を置くため）。
 *   sections    = 階高が分かれば必要蹴上数（基準法）を往路・回転部・復路へ配分。不明なら区間長÷踏面。
 *   回転部の段数 R（取りつきの往路・復路各 1 段を除いた回転部固有の蹴上数）は sections[1] = R+1。
 *   R=0（平踊り場）→ SWITCHBACK、R>0 → WINDING。全幅の踊り場セルがあれば R=0。鉄骨の初期値は R=0。
 * 幾何が経路と矛盾する場合（L字の象限が取れない等）は null（呼び出し側は幾何推定へ）。
 */
function classifyByPath(path, cells, graph, b, floorHeight, structure) {
  const vertical = path.dir === 'up' || path.dir === 'down';
  const w = b.x2 - b.x1, h = b.y2 - b.y1;
  const base = {
    bounds: b, isVertical: vertical,
    runLength: vertical ? h : w, runWidth: vertical ? w : h,
  };
  const required = requiredRisers(floorHeight);
  const finish = (type, upDirection, flip, sections, extra = {}) => ({
    ...base, type, upDirection, flip, sections, ...extra,
    totalSteps: totalStepsFromSections(sections) + (extra.entryTurnSteps ?? 0) + (extra.arrivalTurnSteps ?? 0),
  });

  if (path.kind === 'straight') {
    const spans = runSpans(cells, graph, vertical);
    if (spans.length === 3) {
      const len = (s) => s.hi - s.lo;
      const [s0, s1, s2] = spans;
      if (len(s1) < len(s0) * 0.85 && len(s1) < len(s2) * 0.85) {
        // 歩行順（軸負方向へ昇るなら反転）に外側区間を並べる
        const walk = (path.dir === 'up' || path.dir === 'left') ? [s2, s0] : [s0, s2];
        const [n1, n2] = required ? splitRuns(required, 0) : walk.map(s => risersFromLength(len(s)));
        return finish(StairType.STRAIGHT_LANDING, path.dir, false, [n1, 1, n2]);
      }
    }
    const total = required || risersFromLength(base.runLength);
    return finish(StairType.STRAIGHT, path.dir, false, [total]);
  }

  if (path.kind === 'lTurn') {
    const lt = detectLTurn(cells, graph, b);
    if (!lt) return null;
    // アーム1（上り始め）が垂直なら代替写像（detectLTurn の vAlt）へ切り替え、実段数も歩行順に入れ替える。
    const arm1Vertical = path.dirs[0] === 'up' || path.dirs[0] === 'down';
    const { upDirection, flip } = arm1Vertical ? lt.vAlt : lt;
    const [first, straight] = arm1Vertical ? [lt.straight, lt.first] : [lt.first, lt.straight];
    // 矩折（直進2アーム）の段数。階高に対して不足するならコーナーを曲がり段（実段）で補い FLARED に落とす。
    const baseTotal = first + straight;
    const corner = required > baseTotal ? required - baseTotal + 1 : 1;
    return finish(corner > 1 ? StairType.FLARED : StairType.L_TURN, upDirection, flip, [first, corner, straight]);
  }

  // uTurn
  const [outbound, turn, inbound] = path.segments;
  const laneA = runExtentOf(outbound, graph, vertical);
  const laneB = runExtentOf(inbound, graph, vertical);
  const depth = runExtentOf(turn, graph, vertical);
  if (!(laneA > 0) || !(laneB > 0) || !(depth > 0)) return null;
  // 往路レーンの幅方向位置は取りつき（全幅セル。path.entryStrip）を除いた最初のレーンセルで見る
  const cA = acrossCenterOf(outbound[path.entryStrip ?? 0], graph, vertical);
  const cB = acrossCenterOf(inbound[inbound.length - 1], graph, vertical);
  if (cA == null || cB == null || cA === cB) return null;
  const flip = cA > cB;
  // 全幅の踊り場セル（往路・復路の両レーンにまたがる）が回転部にあれば平踊り場。
  const acrossOf = (key) => { const cb = cellBoundsFromKey(key, graph); return vertical ? [cb.x1, cb.x2] : [cb.y1, cb.y2]; };
  const covers = ([lo, hi], c) => lo - SPAN_EPS <= c && c <= hi + SPAN_EPS;
  const hasFullWidthLanding = turn.some(key => { const a = acrossOf(key); return covers(a, cA) && covers(a, cB); });
  const turnSteps = (hasFullWidthLanding || structure === StructuralMaterialType.STEEL)
    ? 0
    : Math.max(1, Math.round(depth / DEFAULT_TREAD));
  // 張り出すレーン（相手より長い方）の張り出し区間は側面の出入口に取りつく回転部になる
  //（既定の出入口＝内側。resolveUTurnPorts）。直進部の長さは両レーンの共通区間（短い方）。
  const overhangA = laneA > laneB + SPAN_EPS ? laneA - laneB : 0;
  const overhangB = laneB > laneA + SPAN_EPS ? laneB - laneA : 0;
  const entryTurnSteps   = overhangA > 0 ? defaultPortTurnSteps(structure, overhangA) : 0;
  const arrivalTurnSteps = overhangB > 0 ? defaultPortTurnSteps(structure, overhangB) : 0;
  const runLen = Math.min(laneA, laneB);
  const [n1, n2] = required
    ? splitRuns(required, turnSteps + entryTurnSteps + arrivalTurnSteps)
    : [risersFromLength(runLen), risersFromLength(runLen)];
  const type = turnSteps === 0 ? StairType.SWITCHBACK : StairType.WINDING;
  return finish(type, path.dir, flip, [n1, turnSteps + 1, n2], { entryTurnSteps, arrivalTurnSteps });
}

/**
 * 設置エリア（cells）から階段タイプと向きを推定する。
 *
 * 判定順序: **選択順＝歩行順**（resolveStairPath → classifyByPath）を第一の根拠にし、経路が取れない
 * 入力（選択順なし・非隣接・全セル未網羅・3回以上の折れ）だけを従来の幾何推定（中空き→L字→U字→
 * 踊り場付直進→直進。先頭セルを上り口とする entry ヒント込み）で処理する。
 *
 * @param {Set<string>} cells - 設置エリアのセルキー集合
 * @param {object} graph
 * @param {number|null} floorHeight - 設置階〜上階の階高(mm)。必要蹴上数（基準法）の算出に使う
 * @param {string[]|null} entryCellKeys - 部屋ドラッグの選択順セルキー配列（歩行順）。
 *   フォールバック時は従来どおり「先頭の有効セル＝上り口」のヒントとしてだけ使う
 *   （STRAIGHT・STRAIGHT_LANDING→upDirection、SWITCHBACK・WINDING→flip、L_TURN/FLARED→
 *   上り始めのアーム選択。OPEN_WELL は未対応）。
 * @param {string|null} structure - 階段の構造材（StructuralMaterialType）。鉄骨なら回転部の初期段数 R=0
 * @returns {{
 *   type: string,
 *   bounds: { x1, y1, x2, y2 },
 *   isVertical: boolean,  // 走行軸が Y方向か
 *   runLength: number,    // 走行方向の全長(mm)
 *   runWidth: number,     // 階段幅方向の寸法(mm)
 *   upDirection: string,  // 'up'|'down'|'left'|'right'（既定の昇り方向。後でユーザーが反転可）
 * }}
 */
export function classifyStairArea(cells, graph, floorHeight = null, entryCellKeys = null, structure = null) {
  const b = roomBounds(cells, graph);
  const path = resolveStairPath(entryCellKeys, cells, graph);
  if (path) {
    const byPath = classifyByPath(path, cells, graph, b, floorHeight, structure);
    if (byPath) return byPath;
  }

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
  // entryヒント: 未対応（開口位置から個々の踊場セルを一意に識別するのが複雑なため。フェーズ4スコープ外）。
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
  // entryヒント: (upDirection,flip) で対応＝上り始めのアーム選択。先頭の有効セル（コーナー
  // セルはスキップ）が属するアームを arm1（sections[0]、上り始めの直進部）とみなし、
  // 上り口はそのアームのコーナー（踊り場）接続と反対側の辺になる。垂直アームが arm1 なら
  // 代替写像 vAlt（up/down 系。detectLTurn 参照）へ切り替え、アーム実段数（first/straight）
  // も歩行順に入れ替える。ヒント未指定・解決不能なら既定（水平アームが arm1）のまま。
  const lt = detectLTurn(cells, graph, b);
  if (lt) {
    let ltUp = lt.upDirection, ltFlip = lt.flip;
    let first = lt.first, straight = lt.straight;
    if (entryCellKeys) {
      // アーム識別できないセル（コーナーセル等）はスキップ対象
      const skipKeys = new Set([...cells].filter(k => !lt.armOf.has(k)));
      const entryKey = resolveEntryCellKey(entryCellKeys, cells, skipKeys);
      if (entryKey && lt.armOf.get(entryKey) === 'v') {
        ({ upDirection: ltUp, flip: ltFlip } = lt.vAlt);
        [first, straight] = [straight, first];
      }
    }
    // 矩折（直進2アーム）の段数。階高に対して不足するならコーナーを曲がり段（実段）で補い FLARED に落とす。
    // コーナーは平踊り場なら1段（総段数に足されない）、曲がり段なら実段差（マスw＝w段ぶん足される）。
    const baseTotal = first + straight; // 矩折（コーナー平踊り場）の総段数
    const required = floorHeight ? Math.ceil(floorHeight / MAX_RISER) : 0;
    const corner = required > baseTotal ? required - baseTotal + 1 : 1;
    const ltType = corner > 1 ? StairType.FLARED : StairType.L_TURN;
    const ltSections = [first, corner, straight];
    return {
      type: ltType, bounds: b, isVertical, runLength, runWidth,
      upDirection: ltUp, flip: ltFlip,
      sections: ltSections,
      totalSteps: totalStepsFromSections(ltSections),
    };
  }

  // U字（屈折／回り）を判定。
  // entryヒント: flip で対応。2レーンは対称で upDirection は landingHigh から一意に決まるが、
  // 「どちらのレーンから歩き始めるか」は flip が写像する（makeFrame の acrossAt。
  // 往路レーンA は flip=false で幅方向低座標側 s=0 に置かれる——buildSwitchback/buildWinding 参照）。
  // 先頭の有効セル（踊り場・周回部セルはスキップ）が高座標側レーンなら flip=true。
  const ut = detectUTurn(cells, graph, isVertical, b);
  if (ut) {
    // 折り返し部が走行高位端にあれば昇り起点は低位側 → 高位へ向かう向き
    upDirection = isVertical
      ? (ut.landingHigh ? 'down' : 'up')
      : (ut.landingHigh ? 'right' : 'left');
    if (entryCellKeys) {
      // レーン識別できないセル（全幅踊り場・回り段列・中間幅）はすべてスキップ対象
      const skipKeys = new Set([...cells].filter(k => !ut.laneHalf.has(k)));
      const entryKey = resolveEntryCellKey(entryCellKeys, cells, skipKeys);
      if (entryKey) flip = ut.laneHalf.get(entryKey) === 'high';
    }
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
      if (entryCellKeys) {
        // 中央区間（s1）は踊場としてスキップ対象。
        const landingKeys = cellKeysInSpan(cells, graph, isVertical, s1);
        const entryKey = resolveEntryCellKey(entryCellKeys, cells, landingKeys);
        if (entryKey) {
          if (cellKeysInSpan(cells, graph, isVertical, s0).has(entryKey)) {
            upDirection = isVertical ? 'down' : 'right'; // s0（低座標側）が上り口 → 高座標側へ昇る
          } else if (cellKeysInSpan(cells, graph, isVertical, s2).has(entryKey)) {
            upDirection = isVertical ? 'up' : 'left';    // s2（高座標側）が上り口 → 低座標側へ昇る
          }
        }
      }
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

  // 直進（上記のいずれにも該当しない場合）: entryヒントで upDirection を直接決定する
  // （踊場・周回部の概念が無いため、スキップ対象は無し＝先頭の有効キーをそのまま使う）。
  if (entryCellKeys && type === StairType.STRAIGHT && cells.size > 1) {
    const entryKey = resolveEntryCellKey(entryCellKeys, cells, null);
    if (entryKey) {
      const cb = cellBoundsFromKey(entryKey, graph);
      if (cb) {
        const mid    = isVertical ? (b.y1 + b.y2) / 2 : (b.x1 + b.x2) / 2;
        const center = isVertical ? (cb.y1 + cb.y2) / 2 : (cb.x1 + cb.x2) / 2;
        // entryセルが走行軸中点をまたぐ（中央セル等）場合は低座標/高座標のどちらとも
        // 言えないため上書きせず、幾何既定のまま維持する（食い違った反転を防ぐ）。
        if (Math.abs(center - mid) >= STRAIGHT_ENTRY_MID_EPS) {
          const entryIsLow = center < mid;
          // 上り口から遠ざかる向きに昇る
          upDirection = isVertical
            ? (entryIsLow ? 'down' : 'up')
            : (entryIsLow ? 'right' : 'left');
        }
      }
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
 * L_TURN/FLARED は widths（[アーム1幅, アーム2幅] mm）も返す（アーム帯の実測反映用）。
 * @returns {{ lengths:number[], widths?:number[] }|null}
 */
export function measureStairSpans(stair, graph) {
  if (!graph || !stair?.cells || stair.cells.size === 0) return null;
  const vertical = stair.upDirection === 'up' || stair.upDirection === 'down';
  const b = roomBounds(stair.cells, graph);
  if (![b.x1, b.y1, b.x2, b.y2].every(Number.isFinite)) return null;
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
      // [往路, 踊り場・回り部の深さ, 復路]。回転部＝走行軸遠端の帯（uTurnSpans）。往路≠復路の不等長可。
      const us = uTurnSpans(stair, graph, b);
      if (!us) return null;
      return { lengths: [us.laneA, us.depth, us.laneB], entryFull: us.entryFull, firstRowA: us.firstRowA, firstRowB: us.firstRowB };
    }
    case StairType.L_TURN:
    case StairType.FLARED: {
      const cc = lTurnCornerCell(stair.cells, graph, b);
      if (!cc || !(cc.cw > 0) || !(cc.ch > 0)) return null;
      // 歩行順 [アーム1走行長, コーナー（u軸寸）, アーム2走行長]。widths=[アーム1幅, アーム2幅]。
      // u軸（アーム1の走行軸）は upDirection が left/right のとき水平（normToWorld と同じ対応）。
      const cu = vertical ? cc.ch : cc.cw; // コーナーのu軸寸 = アーム2幅
      const cv = vertical ? cc.cw : cc.ch; // コーナーのv軸寸 = アーム1幅
      const uLen = vertical ? b.y2 - b.y1 : b.x2 - b.x1;
      const vLen = vertical ? b.x2 - b.x1 : b.y2 - b.y1;
      const L1 = uLen - cu, L2 = vLen - cv;
      if (!(L1 > 0) || !(L2 > 0)) return null;
      return { lengths: [L1, cu, L2], widths: [cv, cu] };
    }
    default:
      return null;
  }
}

/**
 * SWITCHBACK階段の区間長（往路len1・踊り場landingLen・復路len2）と段数（n1・n2・totalSteps）を
 * 実測優先（measureStairSpans）・合成フォールバック（tread×マス数）で解決する。floorHeightに
 * 依存しない部分のみを切り出したもの——elevationStairSection.jsのresolveSwitchbackParams（本関数＋
 * floorHeightから算出するriserを合成）とfinish/stair/stairLanding.jsのlandingRect（踊り場矩形の
 * 単一情報源。floorHeight不要）が共有する（WP-A1: 挙動不変のリファクタ抽出）。
 * SWITCHBACK以外はnull。
 * @param {import('@core').Stair} stair
 * @param {object} graph
 * @returns {{totalSteps:number, n1:number, n2:number, len1:number, landingLen:number, len2:number}|null}
 */
export function resolveSwitchbackSpanLengths(stair, graph) {
  if (!stair || stair.type !== StairType.SWITCHBACK) return null;

  const totalSteps = Math.max(2, stair.totalSteps ?? 2);
  const sections = Array.isArray(stair.sections) && stair.sections.length === 3 ? stair.sections : null;
  const n1 = sections ? Math.max(1, sections[0]) : Math.round(totalSteps / 2);
  const n2 = sections ? Math.max(1, sections[2]) : totalSteps - n1;

  const spans = measureStairSpans(stair, graph);
  const tread = stair.tread > 0 ? stair.tread : 250;
  const [len1, landingLen, len2] = spans?.lengths ?? [
    tread * Math.max(1, n1 - 1),
    Math.max(4 * tread, MIN_LANDING),
    tread * Math.max(1, n2 - 1),
  ];

  return { totalSteps, n1, n2, len1, landingLen, len2 };
}
