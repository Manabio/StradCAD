import { roomBounds, cellBoundsFromKey } from '../gridCells.js';
import { StairType, totalStepsFromSections } from '@core';

// 直進階段の標準比率ヒント（踏面方向:走行長 ≒ 3:14）。段数推定の妥当性チェック用。
export const STRAIGHT_RATIO = 14 / 3;

const DEFAULT_TREAD = 250; // mm（段数推定用。確定値は寸法フェーズで上書きされる）
const MAX_RISER = 230;     // mm（住宅の蹴上上限。必要段数 = ceil(階高/MAX_RISER)）

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
  const spans = [...spanMap.values()].sort((a, b2) => (a.runLen) - (b2.runLen));
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
 * 設置エリア（cells）から階段タイプと向きを推定する。
 * MVP: 常に STRAIGHT。長辺を走行軸、短辺を階段幅とみなす。
 *
 * @param {Set<string>} cells - 設置エリアのセルキー集合
 * @param {object} graph
 * @param {number|null} floorHeight
 * @param {string[]|null} entryCellKeys - 上り口ヒント（部屋ドラッグの選択順セルキー配列。
 *   フェーズ4: 最初に選択したセルを設置階の上り口とする。踊場・周回部セルなら選択順で次のセルを使う。
 *   タイプ判定（直進/L字/U字/中空き等）は変えず、upDirection・flip・sectionsの歩行順の決定にのみ使う。
 *   未指定・解決不能（cellsに含まれない等）なら現行の幾何推定にフォールバックする。
 *   対応: STRAIGHT・STRAIGHT_LANDING（upDirectionへ反映）、SWITCHBACK・WINDING（flipへ反映＝
 *   往路レーンの選択）、L_TURN/FLARED（(upDirection,flip)へ反映＝上り始めのアーム選択。
 *   entryセルの属するアームを arm1 とみなし、コーナー接続と反対側の辺が上り口になる）。
 *   OPEN_WELL のみ未対応（フェーズ4スコープ外。分岐のコメント参照）。
 * @returns {{
 *   type: string,
 *   bounds: { x1, y1, x2, y2 },
 *   isVertical: boolean,  // 走行軸が Y方向か（縦長エリア）
 *   runLength: number,    // 走行方向の全長(mm)
 *   runWidth: number,     // 階段幅方向の寸法(mm)
 *   upDirection: string,  // 'up'|'down'|'left'|'right'（既定の昇り方向。後でユーザーが反転可）
 * }}
 */
export function classifyStairArea(cells, graph, floorHeight = null, entryCellKeys = null) {
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
