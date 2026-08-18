/**
 * 展開図: 段差見付け面（部分指定の子Roomが親より低いFLで壁際に接するとき、その段差の
 * 「見えがかり（見付け）」を1枚の面として描くための抽出・合成）。設計意図は
 * .claude/elevation-model.md 参照。
 */
import { CenterLineType } from '@core';
import { refreshCells, cellBoundsList, outlineSegments, worldToCell } from '../finish/gridCells.js';
import { letterOf, DIR_SIGN } from './elevationFaces.js';

const CORNER_TOL_MM = 200; // 見付け面の挿入位置判定（直交壁面のfaceValueとの最近接判定）許容差

/**
 * parentRoom（自身の未指定セル＋各部分指定の子）をFLの異なるゾーンごとにグループ化し、
 * 「自分より低い隣」に接する外形線分（見付け面の元）を抽出する。
 * まずセルキー→owner（親 or 部分指定の子。子が親を上書き）の索引を室内全域について作り、
 * ownerごとにグループ化してcellBoundsList→outlineSegments（finish/gridCells.js）で外形線分を
 * 求める。各線分を分割CL値で刻み、外側（±PROBE_EPS_MM）の点をworldToCellで判定する:
 *   - 索引に無いセル（部屋外・他室）→ 捨てる（壁がある境界は既存のwallAdjacentFloorSegmentsが
 *     床の段差プロファイルとして描く。ここは「同じ部屋の中で壁の無い内部境界」だけを対象にする）
 *   - 自分自身のグループ（内側へ覗いた場合）→ 捨てる
 *   - 相手のFL >= 自分のFL → 捨てる（見えがかりが生じない・重複排除。低い側からは生成しない）
 *   - 相手のFL < 自分のFL → 採用。inward=相手（低い側）へ向かう符号
 * 同一value・inward・(highFL,lowFL)で隣接する区間は結合する。
 * @param {import('@core').Room} parentRoom
 * @param {object} graph
 * @returns {Array<{isVertical:boolean, value:number, lo:number, hi:number, inward:1|-1,
 *   highFL:number, lowFL:number, ownerRoom:import('@core').Room}>}
 */
export function stepRiserSegments(parentRoom, graph) {
  const children = graph.rooms.filter(r => r.referenceRoomIds?.has(parentRoom.id));

  // 部屋全体をownerごとにグループ化する索引（子が親を上書き）。
  const ownerByCell = new Map();
  for (const key of refreshCells(parentRoom.cells, graph)) ownerByCell.set(key, parentRoom);
  for (const child of children) {
    for (const key of refreshCells(child.cells, graph)) ownerByCell.set(key, child);
  }
  const groups = new Map(); // owner -> cellKey[]
  for (const [key, owner] of ownerByCell) {
    if (!groups.has(owner)) groups.set(owner, []);
    groups.get(owner).push(key);
  }

  const out = [];
  for (const [owner, keys] of groups) {
    const ownerFL = graph.effectiveFloorLevel(owner);
    const bounds = cellBoundsList(keys, graph);
    if (bounds.length === 0) continue;

    for (const seg of outlineSegments(bounds)) {
      const breaks = collectAxisBreaks(graph, seg.isVertical, seg.lo, seg.hi);
      for (let i = 0; i + 1 < breaks.length; i++) {
        const lo = breaks[i], hi = breaks[i + 1];
        if (hi <= lo) continue;
        const mid = (lo + hi) / 2;
        for (const inward of [1, -1]) {
          const probe = inward * PROBE_EPS_MM;
          const wx = seg.isVertical ? seg.value + probe : mid;
          const wy = seg.isVertical ? mid : seg.value + probe;
          const cell = worldToCell(wx, wy, graph);
          if (!cell) continue; // セルなし（部屋外）→ 捨てる
          const otherOwner = ownerByCell.get(cell.key);
          if (!otherOwner || otherOwner === owner) continue; // 他室 or 自グループ側 → 捨てる
          const otherFL = graph.effectiveFloorLevel(otherOwner);
          if (otherFL >= ownerFL) continue; // 相手が高い/同じ → 重複排除で捨てる
          out.push({
            isVertical: seg.isVertical, value: seg.value, lo, hi, inward,
            highFL: ownerFL, lowFL: otherFL, ownerRoom: owner,
          });
        }
      }
    }
  }
  return mergeRiserSegments(out);
}

const PROBE_EPS_MM = 5; // 輪郭線分から内側/外側へ覗き込むプローブ距離

// [lo,hi] 区間を、その区間内に厳密に含まれる（isVertical方向と直交する軸の）分割CL値で刻む。
function collectAxisBreaks(graph, isVertical, lo, hi) {
  // outlineSegments の線分は縦線(isVertical=true)ならy方向に、横線ならx方向に伸びる。
  // その線分をさらに刻むのは「線分の伸びる方向と直交する」CLではなく、線分自身の伸びる
  // 方向のCL（＝線分と同じ向きの中心線。例えば縦線分はY方向の水平CLで刻まれる）。
  const type = isVertical ? CenterLineType.HORIZONTAL : CenterLineType.VERTICAL;
  const values = new Set([lo, hi]);
  for (const cl of graph.centerLines) {
    if (cl.centerLineType !== type) continue;
    if (cl.value > lo && cl.value < hi) values.add(cl.value);
  }
  return [...values].sort((a, b) => a - b);
}

// 同一value・inward・(highFL,lowFL)で隣接する区間を結合する。
function mergeRiserSegments(segs) {
  const sorted = [...segs].sort((a, b) =>
    a.isVertical - b.isVertical || a.value - b.value || a.inward - b.inward || a.lo - b.lo);
  const merged = [];
  for (const s of sorted) {
    const last = merged[merged.length - 1];
    if (last && last.isVertical === s.isVertical && last.value === s.value && last.inward === s.inward &&
        last.highFL === s.highFL && last.lowFL === s.lowFL && last.hi === s.lo) {
      last.hi = s.hi;
    } else {
      merged.push({ ...s });
    }
  }
  return merged;
}

/**
 * stepRiserSegments の1件 → 見付け面（buildRoomFacesの面と同型＋kind:'step'）。
 * letter/dirSign/originWorldは通常面と同じ式（letterOf(seg.isVertical,seg.inward)・DIR_SIGN）。
 * lo/hiは両端にある直交壁面のfaceValueへ詰める（CORNER_TOL_MM以内に直交壁面が無ければCL値のまま）。
 * @param {object} seg - stepRiserSegmentsの1件
 * @param {object[]} wallFaces - buildRoomFacesの面配列（隅探索用）
 * @param {object} graph
 * @param {number} parentFL - 親Roomの実効FL（graph.effectiveFloorLevel(parentRoom)）。
 *   baseFloorDeltaMmは他の面のfloorDeltaMmと同じ「親Room基準の相対値」で持つ
 *   （buildFaceFigureのfloorYOf(s)=-s.floorDeltaMmと同じ座標系に揃えるため）。
 * @returns {object}
 */
export function buildStepFaces(seg, wallFaces, graph, parentFL) {
  const letter = letterOf(seg.isVertical, seg.inward);
  const dirSign = DIR_SIGN[letter];
  const axisCL = findAxisCL(graph, seg.isVertical, seg.value);
  const loFace = nearestPerpFaceAt(wallFaces, seg.isVertical, seg.value, seg.lo);
  const hiFace = nearestPerpFaceAt(wallFaces, seg.isVertical, seg.value, seg.hi);
  const lo = loFace ? loFace.faceValue : seg.lo;
  const hi = hiFace ? hiFace.faceValue : seg.hi;
  const stepHeightMm = seg.highFL - seg.lowFL;
  return {
    letter, dirSign, isVertical: seg.isVertical, axisCL, inward: seg.inward,
    faceValue: seg.value, hasRealWall: true,
    lo, hi, run: hi - lo, originWorld: dirSign > 0 ? lo : hi,
    startCLId: axisCL?.id ?? null, endCLId: axisCL?.id ?? null,
    hasWallAtLocal0: true, hasWallAtLocalRun: true,
    kind: 'step', stepHeightMm, baseFloorDeltaMm: seg.lowFL - parentFL,
  };
}

function findAxisCL(graph, isVertical, value) {
  const type = isVertical ? CenterLineType.VERTICAL : CenterLineType.HORIZONTAL;
  return graph.centerLines.find(cl => cl.centerLineType === type && cl.value === value) ?? null;
}

// wallFaces（直交面）のうち、この見付け面の端点に接するものを返す（CORNER_TOL_MM以内）。
// 直交面fはisVertical=falseなら自身の位置(axisCL)がY・スパン(lo/hi)がXという具合に、段差面
// (stepIsVertical)とは軸が入れ替わる——「段差の固定軸位置(stepAxisValue)がfのスパン内か」
// （到達判定）と「段差の端点(pos。段差自身の伸びる方向の座標)とfの位置(axisCL)の近さ」
// （どちらが最寄りか）は別の軸同士の比較になる点に注意。
function nearestPerpFaceAt(wallFaces, stepIsVertical, stepAxisValue, pos) {
  let best = null, bestDist = Infinity;
  for (const f of wallFaces) {
    if (f.kind === 'step') continue;
    if (f.isVertical === stepIsVertical) continue; // 直交面のみ
    if (!(stepAxisValue >= f.lo - CORNER_TOL_MM && stepAxisValue <= f.hi + CORNER_TOL_MM)) continue;
    const dist = Math.abs(f.axisCL.effectiveValue - pos);
    if (dist < bestDist) { bestDist = dist; best = f; }
  }
  return best;
}

/**
 * faces（袖壁分割済みの面配列）に段差見付け面を挿入する（仕様3）。
 * 挿入位置: 見付け面の始点（local x=0 の世界座標）を含む壁面W（直交・span内包・faceValue
 * 最近接。CORNER_TOL_MM）の直後。候補複数ならchain index最大。Wが無ければ末尾。
 * @param {object[]} faces
 * @param {import('@core').Room} room
 * @param {object} graph
 * @returns {object[]}
 */
export function insertStepFaces(faces, room, graph) {
  const risers = stepRiserSegments(room, graph);
  if (risers.length === 0) return faces;

  const parentFL = graph.effectiveFloorLevel(room);
  const stepFaces = risers.map(seg => buildStepFaces(seg, faces, graph, parentFL));
  const out = [...faces];
  for (const step of stepFaces) {
    const startWorld = step.dirSign > 0 ? step.lo : step.hi; // local x=0 の世界座標（段差自身の軸上）
    // 直交面fはisVertical=false（例）ならfの位置(axisCL)がY・スパン(lo/hi)がXという具合に、
    // 段差面とは軸が入れ替わる——「段差の固定軸位置(faceValue)がfのスパン内か」（到達判定）と
    // 「段差の始点(startWorld)とfの位置(axisCL)の近さ」（どちらが最寄りか）は別の軸同士の比較になる
    // 点に注意（nearestPerpFaceAtと同じ理屈）。
    let insertAfter = -1;
    let bestDist = Infinity;
    for (let i = 0; i < out.length; i++) {
      const f = out[i];
      if (f.kind === 'step') continue;
      if (f.isVertical === step.isVertical) continue; // 直交のみ
      if (!(step.faceValue >= f.lo - CORNER_TOL_MM && step.faceValue <= f.hi + CORNER_TOL_MM)) continue;
      const dist = Math.abs(f.axisCL.effectiveValue - startWorld);
      if (dist <= bestDist) { bestDist = dist; insertAfter = i; } // 同着はindex最大を優先(<=)
    }
    if (insertAfter === -1) out.push(step);
    else out.splice(insertAfter + 1, 0, step);
  }
  return out;
}
