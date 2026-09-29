// 階段指定時の選択順（ドラッグ順のセルキー列）を「歩行経路」として読む純関数。
//
// 幾何ヒューリスティック（包絡矩形の縦横比・最短スパン等）で型・軸・回転部を決めてから選択順を
// おまけで当てはめる従来の順序では、2×2 のように幾何が対称な入力で選択順しか根拠が無いのに
// それが最後に・部分的にしか使われず、結果が cells の Set 並び順に依存していた。
// ここでは判定を「連続セルの辺共有」と「進行方向の変化」の列挙だけに限定し、閾値を持ち込まない。
// 経路が取れない入力（非隣接・重複・全セル未網羅・3回以上の折れ）は null を返し、呼び出し側
// （classifyStairArea）は従来の幾何推定へフォールバックする。
import { cellBoundsFromKey } from '../gridCells.js';

const EPS = 0.5; // mm — 辺一致・重なり判定の許容差

const OPPOSITE = Object.freeze({ up: 'down', down: 'up', left: 'right', right: 'left' });
const VEC = Object.freeze({ right: [1, 0], down: [0, 1], left: [-1, 0], up: [0, -1] });

// a→b が辺を共有して隣接しているときの進行方向。共有しなければ null。
function stepDirection(a, b) {
  const overlapY = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1) > EPS;
  const overlapX = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1) > EPS;
  if (overlapY && Math.abs(b.x1 - a.x2) <= EPS) return 'right';
  if (overlapY && Math.abs(b.x2 - a.x1) <= EPS) return 'left';
  if (overlapX && Math.abs(b.y1 - a.y2) <= EPS) return 'down';
  if (overlapX && Math.abs(b.y2 - a.y1) <= EPS) return 'up';
  return null;
}

// 回転の向き（画面座標。+1/-1 が 90° の左右、0 は 180° 反転または直進）。
function turnSense(d1, d2) {
  const [ax, ay] = VEC[d1], [bx, by] = VEC[d2];
  return Math.sign(ax * by - ay * bx);
}

// 幅方向（走行軸に直交）の区間 [lo, hi]。
function acrossOf(cb, runDir) {
  const vertical = runDir === 'up' || runDir === 'down';
  return vertical ? [cb.x1, cb.x2] : [cb.y1, cb.y2];
}
const overlaps = ([aLo, aHi], [bLo, bHi]) => Math.min(aHi, bHi) - Math.max(aLo, bLo) > EPS;

// U字（同じ向きの 90° が 2 回、または 1 セルでの 180° 反転）。
// 往路＝先頭から、復路＝末尾から、それぞれ反対レーンの幅方向区間と重ならないセルの連続。
// 残り（方向変化セルと、その間・両脇の全幅セル）が回転部。往路・復路の幅方向区間が重なる
// （2 レーンにならない）場合は null。
// 先頭に両レーンにまたがる全幅セルが続く場合（設置階上階スラブの張り出し下に横から取りつく踏み込み。
// 実データ moku2-2）は「取りつき」として往路区間の先頭に含め、その数を entryStrip で返す。
function uTurn(keys, bounds, dirs, firstTurn, lastTurn) {
  const runDir = dirs[0];
  const n = keys.length;
  const acrossLast = acrossOf(bounds[n - 1], runDir);
  let strip = 0;
  while (strip < firstTurn && overlaps(acrossOf(bounds[strip], runDir), acrossLast)) strip++;
  if (strip >= firstTurn) return null; // 往路レーンのセルが無い
  const acrossFirst = acrossOf(bounds[strip], runDir);
  if (overlaps(acrossFirst, acrossLast)) return null;
  for (let k = 0; k < strip; k++) {
    if (!overlaps(acrossOf(bounds[k], runDir), acrossFirst)) return null; // 取りつきは両レーンにまたがる全幅セル
  }

  let turnStart = firstTurn;
  for (let k = strip; k < firstTurn; k++) {
    if (overlaps(acrossOf(bounds[k], runDir), acrossLast)) { turnStart = k; break; }
  }
  let turnEnd = lastTurn;
  for (let k = n - 1; k > lastTurn; k--) {
    if (overlaps(acrossOf(bounds[k], runDir), acrossFirst)) { turnEnd = k; break; }
  }
  if (turnStart <= strip || turnEnd === n - 1) return null;
  return {
    kind: 'uTurn',
    dir: runDir,
    entryStrip: strip,
    segments: [keys.slice(0, turnStart), keys.slice(turnStart, turnEnd + 1), keys.slice(turnEnd + 1)],
  };
}

/**
 * 選択順セルキー列から歩行経路を確定する。
 * @param {string[]|null} orderKeys - 選択順（ドラッグ順）のセルキー配列
 * @param {Set<string>} cells - 設置エリアのセルキー集合（orderKeys が全件を網羅していること）
 * @param {object} graph
 * @returns {{
 *   kind: 'straight'|'lTurn'|'uTurn',
 *   dir: string,                 // 往路（先頭区間）の進行方向 'up'|'down'|'left'|'right'
 *   dirs?: [string, string],     // lTurn のみ: [アーム1の方向, アーム2の方向]
 *   entryStrip?: number,         // uTurn のみ: 往路区間の先頭にある全幅の取りつきセル数（0 なら無し）
 *   segments: string[][],        // 歩行順の区間セル列。straight=[全セル]、lTurn/uTurn=[往路, 回転部, 復路]
 * }|null} 経路が取れなければ null（呼び出し側は幾何推定へフォールバック）
 */
export function resolveStairPath(orderKeys, cells, graph) {
  if (!Array.isArray(orderKeys) || !cells || orderKeys.length < 2 || orderKeys.length !== cells.size) return null;
  const seen = new Set();
  const bounds = [];
  for (const key of orderKeys) {
    if (!cells.has(key) || seen.has(key)) return null;
    seen.add(key);
    const cb = cellBoundsFromKey(key, graph);
    if (!cb) return null;
    bounds.push(cb);
  }
  const dirs = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const d = stepDirection(bounds[i], bounds[i + 1]);
    if (!d) return null;
    dirs.push(d);
  }
  // 方向変化セル（index 1..n-2）
  const turns = [];
  for (let i = 1; i < bounds.length - 1; i++) if (dirs[i - 1] !== dirs[i]) turns.push(i);

  if (turns.length === 0) return { kind: 'straight', dir: dirs[0], segments: [orderKeys.slice()] };

  if (turns.length === 1) {
    const i = turns[0];
    if (dirs[i] === OPPOSITE[dirs[i - 1]]) return uTurn(orderKeys, bounds, dirs, i, i); // 180°（全幅踊り場）
    return {
      kind: 'lTurn', dir: dirs[0], dirs: [dirs[i - 1], dirs[i]],
      segments: [orderKeys.slice(0, i), [orderKeys[i]], orderKeys.slice(i + 1)],
    };
  }

  if (turns.length === 2) {
    const [i, j] = turns;
    const s1 = turnSense(dirs[i - 1], dirs[i]), s2 = turnSense(dirs[j - 1], dirs[j]);
    if (s1 === 0 || s1 !== s2) return null; // 180° を含む／逆向き（S字）は経路として扱わない
    return uTurn(orderKeys, bounds, dirs, i, j);
  }
  return null; // 3 回以上（中空き等）は幾何推定へ
}
