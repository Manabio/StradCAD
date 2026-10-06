// 折返し・回り階段（U字。上り口 'entry'＝往路レーンA／到達口 'arrival'＝復路レーンB）と直進系（直進・踊場付直進。
// 区画は先頭の行＝上り口・末尾の行＝到達口）の出入口の辺の語彙・解決・候補列挙
//（純モジュール。react・store.js・snap.js・.jsx を静的に引かない）。
// 設計意図は .claude/stair-model.md「出入口の辺」。
//
// 保存値（Stair.entrySide/arrivalSide）は StairPortSide = end | left | right。left/right は「その口を歩くときの
// 進行方向」（上り口は upDirection、到達口は逆向き）から見た向きで、flip に依存しない。幾何（stairGeometry.js
// の emitPortTurnZone ほか）が使う内部語彙は 'inner'/'outer'（レーンの隣レーン側／外周側）で、変換は
// resolveStairPorts が 1 か所で行う。
import { StairType, StairPortSide, RoomFeature } from '@core';
import { roomBounds, cellBoundsList, outlineSegments, worldToCell, gridIndexOf } from '../gridCells.js';
import { buildEnclosureCellToRoom, ADJACENT_SAMPLE_EPS } from '../edgeClassify.js';
import {
  uTurnCellInfos, uTurnSpans, defaultPortTurnSteps, defaultSections, straightEndRows, measureStairSpans,
} from './stairClassify.js';

export const PORT_EPS_MM = 0.5; // mm — レーン長の差を「張り出し」とみなす閾値
const EDGE_EPS_MM = 0.5;        // mm — 辺が外形線分上にあるかの判定許容差
/** 直進部の最小実段数。候補（stairPortCandidates）と切替（stairSectionEdit.js portSideChange）が共有する。 */
export const MIN_RUN_RISERS = 2;
/** 取りつき回転部の蹴上が属する直進部（U字: 上り口＝往路 sections[0]、到達口＝復路 sections[2]）。 */
export const PORT_RUN_INDEX = { entry: 0, arrival: 2 };
/** 出入口の辺を選べる型。U字（折返し・回り）と直進系（直進・踊場付直進）。 */
export const U_TURN_TYPES = new Set([StairType.SWITCHBACK, StairType.WINDING]);
export const STRAIGHT_TYPES = new Set([StairType.STRAIGHT, StairType.STRAIGHT_LANDING]);
export const hasPortSides = (type) => U_TURN_TYPES.has(type) || STRAIGHT_TYPES.has(type);
/** 取りつき蹴上が属する直進部の sections 添字（直進は区間が1つなので上り口・到達口とも 0）。 */
export const portRunIndex = (type, port) => (type === StairType.STRAIGHT ? 0 : PORT_RUN_INDEX[port]);
/** 出入口の辺を選べる型の sections の区間数（直進 1／それ以外 3）。 */
export const portSectionCount = (type) => (type === StairType.STRAIGHT ? 1 : 3);
/** 保存値が側面（left/right）を指している口が1つでもあるか。 */
export const hasSidePort = (stair) =>
  [stair.entrySide, stair.arrivalSide].some(v => v === StairPortSide.LEFT || v === StairPortSide.RIGHT);
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

/**
 * measureStairSpans（直進系）の結果を、側面の出入口の解決・候補列挙が使う形へ写す。実測できなければ null。
 * 区画は先頭の行（上り口）・末尾の行（到達口）。踊場付直進は区画が各直進部の中に収まる必要がある（runE/runA）。
 * @returns {{ total:number, firstRow:number, lastRow:number, landing:boolean, runE:number, runA:number }|null}
 */
export function straightPortInfoOf(spans) {
  const ls = spans?.lengths;
  if (!Array.isArray(ls) || (ls.length !== 1 && ls.length !== 3)) return null;
  if (!(spans.firstRow > 0) || !(spans.lastRow > 0)) return null;
  const total = ls.reduce((s, v) => s + v, 0);
  return { total, firstRow: spans.firstRow, lastRow: spans.lastRow, landing: ls.length === 3, runE: ls[0], runA: ls[ls.length - 1] };
}

/**
 * 直進系の出入口を解決する。自動（null）は走行端。保存された側面が幾何上選べない（区画を除くと直進部が
 * 残らない）ときは走行端へ戻す。直進は区画（先頭の行・末尾の行）が両口とも側面なら合わせて全長に収まること
 * （上り口を先に確保し、到達口は残りに収まるときだけ側面）。踊場付直進は各区画が各直進部に収まること。
 * @param {object} stair
 * @param {ReturnType<typeof straightPortInfoOf>} info
 * @returns {{ entry:'end'|'side', arrival:'end'|'side', entryS:(0|1|null), arrivalS:(0|1|null),
 *   zoneE:number, zoneA:number, total:number }}
 *   zoneE/zoneA は側面の口の区画長（mm。走行端は 0）、total は実測全長（区画長と同じ mm の単位）。
 */
export function resolveStraightPorts(stair, info) {
  const sideOf = (v) => (v === StairPortSide.LEFT || v === StairPortSide.RIGHT ? v : null);
  const eSide = sideOf(stair.entrySide), aSide = sideOf(stair.arrivalSide);
  const entryOk = !!(info && eSide && info.firstRow > PORT_EPS_MM
    && (info.landing ? info.runE : info.total) - info.firstRow > PORT_EPS_MM);
  const aRoom = info ? (info.landing ? info.runA : info.total - (entryOk ? info.firstRow : 0)) : 0;
  const arrivalOk = !!(info && aSide && info.lastRow > PORT_EPS_MM && aRoom - info.lastRow > PORT_EPS_MM);
  return {
    entry: entryOk ? 'side' : 'end', arrival: arrivalOk ? 'side' : 'end',
    entryS: entryOk ? sideToS(stair, 'entry', eSide) : null,
    arrivalS: arrivalOk ? sideToS(stair, 'arrival', aSide) : null,
    zoneE: entryOk ? info.firstRow : 0, zoneA: arrivalOk ? info.lastRow : 0,
    total: info ? info.total : 0,
  };
}

/** 型を問わない出入口の解決（U字・直進系。他の型や実測できないときは null）。StairPanel が使う。 */
export function resolvePorts(stair, spans) {
  if (STRAIGHT_TYPES.has(stair.type)) {
    const info = straightPortInfoOf(spans);
    return info ? resolveStraightPorts(stair, info) : null;
  }
  if (U_TURN_TYPES.has(stair.type)) {
    const info = portSpansOf(spans);
    return info ? resolveStairPorts(stair, info) : null;
  }
  return null;
}

/** 型を問わない、口の区画の長さ（mm。実測できなければ 0）。 */
export function portZoneLen(stair, spans, port) {
  checkPort(port);
  if (STRAIGHT_TYPES.has(stair.type)) {
    const info = straightPortInfoOf(spans);
    return info ? (port === 'entry' ? info.firstRow : info.lastRow) : 0;
  }
  const info = portSpansOf(spans);
  return info ? portZone(info, port).zoneLen : 0;
}

// 床のある部屋か。床なし＝部屋なし（屋根は buildEnclosureCellToRoom が外す）／吹抜け・階段吹抜け・階段・昇降機・
// 未定義の部屋（ユーザー裁定: 未定義部屋は床なし）。feature=null と屋外部屋は床あり。
const FLOORLESS = new Set([
  RoomFeature.VOID, RoomFeature.STAIR_VOID, RoomFeature.STAIR, RoomFeature.ELEVATOR_EQUIPMENT,
  RoomFeature.ROOF, RoomFeature.UNDEFINED,
]);
const hasFloor = (room) => !!room && !FLOORLESS.has(room.feature);

/**
 * 辺の一覧（{ ta, sa, tb, sb, dt, ds }。t,s 空間の線分と外側の向き）がすべて
 * (a) 階段の外形線分上（他の階段セルと共有しない）・(b) floorGraph を渡したとき外側の隣が床あり、か判定する関数を作る。
 * 床グラフの格子が辺の途中で分かれることがあるので、辺を床グラフの直交する CL の値で区切り、
 * 各区間の中点（外側へずらす）がすべて床あり、のときだけ true（有効区間外の CL でも区切るだけで安全側）。
 */
function makeEdgesOk(stair, graph, f, floorGraph) {
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
  // 辺の外側（dt,ds の向き）の隣が床か
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
  return (edges) => edges.length > 0 && edges.every(e =>
    onOutline(f.pt(e.ta, e.sa), f.pt(e.tb, e.sb))
    && (!floorGraph || floorOutside(e.ta, e.sa, e.tb, e.sb, e.dt, e.ds)));
}

// 取りつき蹴上を足しても直進部が MIN_RUN_RISERS 以上残るか（portSideChange と同じ判定）。
function stepsRemainOk(stair, port, zoneMm) {
  if ((stair[stepsFieldOf(port)] ?? 0) > 0) return true;
  const want = defaultPortTurnSteps(stair.structure, zoneMm, stair.tread);
  if (!(want > 0)) return true;
  const sections = stair.sections ?? defaultSections(stair);
  return Array.isArray(sections) && sections.length === portSectionCount(stair.type)
    && sections[portRunIndex(stair.type, port)] - want >= MIN_RUN_RISERS;
}

// 直進系: 区画は先頭の行（上り口）・末尾の行（到達口）。辺 end は行の走行端、側面は行のセルの側辺。
function straightPortCandidates(stair, graph, port, floorGraph) {
  const floorChecked = !!floorGraph;
  const fallback = { sides: [StairPortSide.END], floorChecked: false };
  const info = straightPortInfoOf(measureStairSpans(stair, graph));
  const rows = straightEndRows(stair, graph);
  if (!info || !rows) return fallback;
  const { f, L, sEps, near, far, firstCells, lastCells } = rows;
  const isEntry = port === 'entry';
  const zoneMm = isEntry ? info.firstRow : info.lastRow;
  const cur = resolveStraightPorts(stair, info);
  const otherZone = isEntry ? cur.zoneA : cur.zoneE; // 相手の口が側面なら、その区画も直進部の外
  const room = info.landing ? (isEntry ? info.runE : info.runA) : info.total - otherZone;
  const hasZone = zoneMm > PORT_EPS_MM;
  const straightRemains = room - zoneMm > PORT_EPS_MM;
  const edgesOk = makeEdgesOk(stair, graph, f, floorGraph);

  const endEdges = isEntry
    ? firstCells.map(c => ({ ta: c.tNear, sa: c.sLo, tb: c.tNear, sb: c.sHi, dt: -1, ds: 0 }))
    : lastCells.map(c => ({ ta: c.tFar, sa: c.sLo, tb: c.tFar, sb: c.sHi, dt: 1, ds: 0 }));
  // 側面（幅方向 s=line）: 区画のセルのうち、その線上に辺を持つもの。区画は上り口 [near, tExit]・到達口 [tExit, far]
  const tExit = isEntry ? near + zoneMm / L : far - zoneMm / L;
  const sideEdges = (line, ds) => (isEntry ? firstCells : lastCells)
    .filter(c => Math.abs((ds > 0 ? c.sHi : c.sLo) - line) <= sEps)
    .map(c => ({
      ta: isEntry ? c.tNear : Math.max(c.tNear, tExit), sa: line,
      tb: isEntry ? Math.min(c.tFar, tExit) : c.tFar, sb: line, dt: 0, ds,
    }));

  const sides = [];
  if (edgesOk(endEdges)) sides.push(StairPortSide.END);
  if (hasZone && straightRemains && stepsRemainOk(stair, port, zoneMm)) {
    for (const [line, ds] of [[0, -1], [1, 1]]) {
      if (edgesOk(sideEdges(line, ds))) sides.push(sideOfS(stair, port, line));
    }
  }
  const order = { [StairPortSide.END]: 0, [StairPortSide.LEFT]: 1, [StairPortSide.RIGHT]: 2 };
  sides.sort((x, y) => order[x] - order[y]);
  return { sides, floorChecked };
}

/**
 * 出入口の候補（保存値の語彙 end|left|right）を列挙する。U字（SWITCHBACK/WINDING）と直進系（STRAIGHT/
 * STRAIGHT_LANDING。区画は先頭・末尾の行）。他型（矩折ほか）は走行端だけ。
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
  if (STRAIGHT_TYPES.has(stair.type)) return straightPortCandidates(stair, graph, port, floorGraph);
  if (!U_TURN_TYPES.has(stair.type)) return fallback;
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

  const edgesOk = makeEdgesOk(stair, graph, f, floorGraph);

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
  const stepsOk = () => stepsRemainOk(stair, port, z.zoneLen);
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
