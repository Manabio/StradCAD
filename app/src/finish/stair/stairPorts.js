// 折返し・回り階段（U字）の出入口（上り口 'entry'＝往路レーンA／到達口 'arrival'＝復路レーンB）の辺の
// 語彙・解決・候補列挙（純モジュール。react・store.js・snap.js・.jsx を静的に引かない）。
// 設計意図は .claude/stair-model.md「出入口の辺」。
//
// 保存値（Stair.entrySide/arrivalSide）は StairPortSide = end | left | right。left/right は「その口を歩くときの
// 進行方向」（上り口は upDirection、到達口は逆向き）から見た向きで、flip に依存しない。幾何（stairGeometry.js
// の emitPortTurnZone ほか）が使う内部語彙は 'inner'/'outer'（レーンの隣レーン側／外周側）で、変換は
// resolveStairPorts が 1 か所で行う。
import { StairType, StairPortSide, RoomFeature } from '@core';
import { roomBounds, cellBoundsList, outlineSegments, worldToCell, gridIndexOf } from '../gridCells.js';
import { buildEnclosureCellToRoom, ADJACENT_SAMPLE_EPS } from '../edgeClassify.js';
import { uTurnCellInfos, uTurnSpans, defaultPortTurnSteps, defaultSections } from './stairClassify.js';

export const PORT_EPS_MM = 0.5; // mm — レーン長の差を「張り出し」とみなす閾値
const EDGE_EPS_MM = 0.5;        // mm — 辺が外形線分上にあるかの判定許容差
/** 直進部の最小実段数。候補（stairPortCandidates）と切替（stairSectionEdit.js portSideChange）が共有する。 */
export const MIN_RUN_RISERS = 2;
/** 取りつき回転部の蹴上が属する直進部（上り口＝往路 sections[0]、到達口＝復路 sections[2]）。 */
export const PORT_RUN_INDEX = { entry: 0, arrival: 2 };
/** 口ごとの取りつき蹴上フィールド名。 */
export const stepsFieldOf = (port) => (port === 'entry' ? 'entryTurnSteps' : 'arrivalTurnSteps');

const WALK_DIR = {
  up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 },
};

function checkPort(port) {
  if (port !== 'entry' && port !== 'arrival') throw new Error(`出入口の口は 'entry' か 'arrival' のみ: ${port}`);
}

// 左の辺が makeFrame の幅方向 s のどちら側（0|1）にあたるか。y 下向き座標で進行ベクトル w の左は (w.y, -w.x)。
// s 増加の世界ベクトルは makeFrame の acrossAt から（縦走行は x 方向、横走行は y 方向。flip で反転）。
function leftS(stair, port) {
  const up = WALK_DIR[stair.upDirection] ?? WALK_DIR.up;
  const w = port === 'entry' ? up : { x: -up.x, y: -up.y };
  const left = { x: w.y, y: -w.x };
  const vertical = stair.upDirection === 'up' || stair.upDirection === 'down';
  const sign = stair.flip ? -1 : 1;
  const sVec = vertical ? { x: sign, y: 0 } : { x: 0, y: sign };
  return left.x * sVec.x + left.y * sVec.y > 0 ? 1 : 0;
}

/**
 * 側面の辺（left/right）を makeFrame の幅方向 s（0|1。設置枠の s 小側／大側）へ変換する。
 * left/right はその口を歩くときの進行方向から見た向き（flip 非依存）。
 * @param {object} stair
 * @param {'entry'|'arrival'} port
 * @param {string} side - StairPortSide.LEFT | RIGHT
 * @returns {0|1}
 */
export function sideToS(stair, port, side) {
  checkPort(port);
  if (side !== StairPortSide.LEFT && side !== StairPortSide.RIGHT) throw new Error(`側面の辺は left/right のみ: ${side}`);
  const l = leftS(stair, port);
  return side === StairPortSide.LEFT ? l : 1 - l;
}

/** sideToS の逆（幅方向 s → left/right）。 */
export function sideOfS(stair, port, s) {
  checkPort(port);
  return s === leftS(stair, port) ? StairPortSide.LEFT : StairPortSide.RIGHT;
}

/**
 * measureStairSpans（U字）の結果を、出入口の解決・候補列挙が使う形へ写す。実測できなければ null。
 * @returns {{ laneLenA:number, laneLenB:number, firstRowA:number, firstRowB:number, entryFull:boolean }|null}
 */
export function portSpansOf(spans) {
  const ls = spans?.lengths;
  if (!Array.isArray(ls) || ls.length !== 3) return null;
  return {
    laneLenA: ls[0], laneLenB: ls[2],
    firstRowA: spans.firstRowA ?? 0, firstRowB: spans.firstRowB ?? 0, entryFull: !!spans.entryFull,
  };
}

/**
 * 口の区画（側面の出入口に取りつく回転部になる区間）の走行長。レーンが相手より長く張り出すなら張り出し区間
 * 全体（2 行以上でも全体）、そうでなければそのレーンの基端の行。
 * @returns {{ lane:'A'|'B', longer:boolean, laneLen:number, zoneLen:number }}
 */
export function portZone(info, port) {
  checkPort(port);
  const { laneLenA, laneLenB, firstRowA = 0, firstRowB = 0 } = info;
  if (port === 'entry') {
    const longer = laneLenA > laneLenB + PORT_EPS_MM;
    return { lane: 'A', longer, laneLen: laneLenA, zoneLen: longer ? laneLenA - laneLenB : firstRowA };
  }
  const longer = laneLenB > laneLenA + PORT_EPS_MM;
  return { lane: 'B', longer, laneLen: laneLenB, zoneLen: longer ? laneLenB - laneLenA : firstRowB };
}

// 内部語彙 'inner'/'outer' ↔ 幅方向 s。外側＝レーンの自側の枠線（A: s=0、B: s=1）、内側＝その反対。
const outerS = (lane) => (lane === 'A' ? 0 : 1);

/**
 * U字の出入口を解決する。保存値 null（自動）は、張り出すレーンなら内側（隣レーン側＝設置階上階のスラブの張り出し
 * に横から取りつく。ユーザー裁定 2026-09-29）、それ以外は走行端。保存された側面が幾何上選べない（区画が無い・
 * 区画を除くと直進部が残らない・内側が張り出しの無いレーン）ときは自動に戻す。
 * @param {object} stair
 * @param {{ laneLenA:number, laneLenB:number, firstRowA?:number, firstRowB?:number, entryFull?:boolean }} info
 * @returns {{ entry:string, arrival:string, entryS:(0|1|null), arrivalS:(0|1|null),
 *   entryLonger:boolean, arrivalLonger:boolean, zoneA:number[], zoneB:number[] }}
 *   entry/arrival は 'end'|'inner'|'outer'（幾何用）。entryS/arrivalS は側面の辺の幅方向 s（end は null）。
 *   zoneA/zoneB は各レーンの区画の [基端からの始点, 終点]（mm）。
 */
export function resolveStairPorts(stair, info) {
  const resolveOne = (port, explicit) => {
    const z = portZone(info, port);
    const outer = outerS(z.lane), inner = 1 - outer;
    const auto = z.longer ? { side: 'inner', s: inner } : { side: StairPortSide.END, s: null };
    if (explicit === StairPortSide.END) return { side: StairPortSide.END, s: null, z };
    if (explicit !== StairPortSide.LEFT && explicit !== StairPortSide.RIGHT) return { ...auto, z };
    const s = sideToS(stair, port, explicit);
    const hasZone = z.zoneLen > PORT_EPS_MM && (z.longer || z.laneLen - z.zoneLen > PORT_EPS_MM);
    if (!hasZone || (s === inner && !z.longer)) return { ...auto, z };
    return { side: s === outer ? 'outer' : 'inner', s, z };
  };
  const e = resolveOne('entry', stair.entrySide);
  const a = resolveOne('arrival', stair.arrivalSide);
  return {
    entry: e.side, arrival: a.side, entryS: e.s, arrivalS: a.s,
    entryLonger: e.z.longer, arrivalLonger: a.z.longer,
    zoneA: [0, e.z.zoneLen], zoneB: [0, a.z.zoneLen],
  };
}

/** 解決結果を保存値の語彙（end|left|right）へ戻す（StairPanel の選択表示用）。 */
export function portSideValue(stair, port, resolved) {
  const s = port === 'entry' ? resolved.entryS : resolved.arrivalS;
  return s == null ? StairPortSide.END : sideOfS(stair, port, s);
}

// 床のある部屋か。床なし＝部屋なし（屋根は buildEnclosureCellToRoom が外す）／吹抜け・階段吹抜け・階段・昇降機・
// 未定義の部屋（ユーザー裁定: 未定義部屋は床なし）。feature=null と屋外部屋は床あり。
const FLOORLESS = new Set([
  RoomFeature.VOID, RoomFeature.STAIR_VOID, RoomFeature.STAIR, RoomFeature.ELEVATOR_EQUIPMENT,
  RoomFeature.ROOF, RoomFeature.UNDEFINED,
]);
const hasFloor = (room) => !!room && !FLOORLESS.has(room.feature);

/**
 * 出入口の候補（保存値の語彙 end|left|right）を列挙する。U字（SWITCHBACK/WINDING）のみ（他型は走行端だけ。
 * 直進・矩折の区画は後続ステップ）。
 *   (a) 幾何: 区画の辺（end・s=0・s=1）を構成するセルの辺がすべて外形線分上（他の階段セルと共有しない）。
 *       内側は張り出すレーンのみ。区画を除いた直進部が残り、直進部の実段数が 2 以上に保てること。
 *   (b) 床: floorGraph を渡したとき、辺の外側の隣セルがすべて床のある部屋であること。
 *       上り口は設置階 N、到達口は N+1 のグラフを渡す。null なら (a) だけで列挙し floorChecked=false。
 * @param {object} stair
 * @param {object} graph - 階段が属する階のグラフ
 * @param {'entry'|'arrival'} port
 * @param {{ floorGraph?: object|null }} [opts]
 * @returns {{ sides: string[], floorChecked: boolean }} sides は end, left, right の順
 */
export function stairPortCandidates(stair, graph, port, { floorGraph = null } = {}) {
  if (!stair || !graph) throw new Error('stairPortCandidates: stair と graph が必要');
  checkPort(port);
  const floorChecked = !!floorGraph;
  const fallback = { sides: [StairPortSide.END], floorChecked: false };
  if (stair.type !== StairType.SWITCHBACK && stair.type !== StairType.WINDING) return fallback;
  const b = roomBounds(stair.cells, graph);
  const us = uTurnSpans(stair, graph, b);
  const ci = uTurnCellInfos(stair, graph, b);
  if (!us || !ci) return fallback;
  const info = portSpansOf({ lengths: [us.laneA, us.depth, us.laneB], entryFull: us.entryFull, firstRowA: us.firstRowA, firstRowB: us.firstRowB });

  const { f, L, tEps, tRun, infos } = ci;
  const z = portZone(info, port);
  const outer = outerS(z.lane);
  const tBase = tRun - z.laneLen / L;
  const tExit = tBase + z.zoneLen / L;
  const sEps = tEps * L / (f.vertical ? (b.x2 - b.x1) : (b.y2 - b.y1)); // SPAN_EPS 相当の s 許容差
  const laneCells = infos.filter(c => c.lane === z.lane && c.tNear < tRun - tEps);
  const zoneCells = laneCells.filter(c => c.tNear < tExit - tEps);
  const baseCells = laneCells.filter(c => c.tNear <= tBase + tEps);
  const hasZone = z.zoneLen > PORT_EPS_MM && zoneCells.length > 0;

  const outline = outlineSegments(cellBoundsList(stair.cells, graph));
  const onOutline = (p, q) => {
    const vertical = Math.abs(p.x - q.x) < Math.abs(p.y - q.y);
    const value = vertical ? (p.x + q.x) / 2 : (p.y + q.y) / 2;
    const lo = vertical ? Math.min(p.y, q.y) : Math.min(p.x, q.x);
    const hi = vertical ? Math.max(p.y, q.y) : Math.max(p.x, q.x);
    return outline.some(o => o.isVertical === vertical && Math.abs(o.value - value) <= EDGE_EPS_MM
      && o.lo - EDGE_EPS_MM <= lo && hi <= o.hi + EDGE_EPS_MM);
  };
  const cellToRoom = floorGraph ? buildEnclosureCellToRoom(floorGraph) : null;
  // 辺（t,s 空間の線分 [ta,sa]-[tb,sb]）の外側（dt,ds の向き）の隣が床か
  // 床グラフの格子が辺の途中で分かれることがあるので、辺を床グラフの直交する CL の値で区切り、
  // 各区間の中点（外側へずらす）がすべて床あり、のときだけ true（有効区間外の CL でも区切るだけで安全側）。
  const floorOutside = (ta, sa, tb, sb, dt, ds) => {
    const pa = f.pt(ta, sa), pb = f.pt(tb, sb);
    const tm = (ta + tb) / 2, sm = (sa + sb) / 2;
    const p0 = f.pt(tm, sm), p1 = f.pt(tm + dt * 0.01, sm + ds * 0.01);
    const len = Math.hypot(p1.x - p0.x, p1.y - p0.y) || 1;
    const ox = (p1.x - p0.x) / len * ADJACENT_SAMPLE_EPS, oy = (p1.y - p0.y) / len * ADJACENT_SAMPLE_EPS;
    const vertical = Math.abs(pa.x - pb.x) < Math.abs(pa.y - pb.y);
    const lo = vertical ? Math.min(pa.y, pb.y) : Math.min(pa.x, pb.x);
    const hi = vertical ? Math.max(pa.y, pb.y) : Math.max(pa.x, pb.x);
    const grid = gridIndexOf(floorGraph);
    const cuts = [lo, ...(vertical ? grid.yValues : grid.xValues).filter(v => v > lo + EDGE_EPS_MM && v < hi - EDGE_EPS_MM).sort((x, y) => x - y), hi];
    for (let i = 0; i + 1 < cuts.length; i++) {
      const m = (cuts[i] + cuts[i + 1]) / 2;
      const px = (vertical ? p0.x : m) + ox, py = (vertical ? m : p0.y) + oy;
      const cell = worldToCell(px, py, floorGraph);
      if (!hasFloor(cell ? cellToRoom.get(cell.key) : null)) return false;
    }
    return true;
  };
  // 辺の一覧（{ ta, sa, tb, sb, dt, ds }）がすべて (a) 外形線分上・(b) 床あり か
  const edgesOk = (edges) => edges.length > 0 && edges.every(e =>
    onOutline(f.pt(e.ta, e.sa), f.pt(e.tb, e.sb))
    && (!floorGraph || floorOutside(e.ta, e.sa, e.tb, e.sb, e.dt, e.ds)));

  // 辺 end: 基端の行のセルの基端側の辺（外側＝走行軸の負方向）
  const endEdges = baseCells.map(c => ({ ta: c.tNear, sa: c.sLo, tb: c.tNear, sb: c.sHi, dt: -1, ds: 0 }));
  // 側面（幅方向 s=line）: 区画のセルのうち、その線上に辺を持つもの。外側＝s の outer 向き
  const sideEdges = (line, ds) => zoneCells
    .filter(c => Math.abs((ds > 0 ? c.sHi : c.sLo) - line) <= sEps)
    .map(c => ({ ta: c.tNear, sa: line, tb: Math.min(c.tFar, tExit), sb: line, dt: 0, ds }));
  const innerLine = z.lane === 'A' ? (info.entryFull && z.longer ? 1 : 0.5) : 0.5;
  const outerEdges = sideEdges(outer, outer === 0 ? -1 : 1);
  const innerEdges = sideEdges(innerLine, z.lane === 'A' ? 1 : -1);

  // 総蹴上数を保つ（portSideChange）: 取りつき回転部の蹴上を足しても直進部が 2 段以上残ること
  const stepsField = stepsFieldOf(port);
  const runIdx = PORT_RUN_INDEX[port];
  const stepsOk = () => {
    if ((stair[stepsField] ?? 0) > 0) return true;
    const want = defaultPortTurnSteps(stair.structure, z.zoneLen, stair.tread);
    if (!(want > 0)) return true;
    const sections = stair.sections ?? defaultSections(stair); // portSideChange と同じ判定
    return Array.isArray(sections) && sections.length === 3 && sections[runIdx] - want >= MIN_RUN_RISERS;
  };
  const straightRemains = z.longer || z.laneLen - z.zoneLen > PORT_EPS_MM;

  const sides = [];
  if (edgesOk(endEdges)) sides.push(StairPortSide.END);
  const consider = (edges, s, isInner) => {
    if (!hasZone || !straightRemains || (isInner && !z.longer) || !stepsOk() || !edgesOk(edges)) return;
    sides.push(sideOfS(stair, port, s));
  };
  consider(outerEdges, outer, false);
  consider(innerEdges, 1 - outer, true);
  // 出力順 end, left, right
  const order = { [StairPortSide.END]: 0, [StairPortSide.LEFT]: 1, [StairPortSide.RIGHT]: 2 };
  sides.sort((x, y) => order[x] - order[y]);
  return { sides, floorChecked };
}
