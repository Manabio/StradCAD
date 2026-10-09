// 展開図（階段室の各切断面）に描かれた階段の蹴上の縦線を世界座標へ戻し、平面の踏面線・放射線
// （buildStairGeometry install の treads）と切断線の交点と ±0.5mm で両方向に照合する関門 probe。
// 不一致が 1 本でもあれば exit 1（なければ 0、用法違反 2）。照合の中核は stairElevPlanDiff.mjs（純モジュール・単体テストあり）。
//
// 使い方:
//   node --import ./scripts/testSetup.mjs scripts/probe/diffStairElevPlan.mjs <src.stq> [階名...]
//        [--entry-turn-steps N] [--arrival-turn-steps N] [--json out] [--verbose] [--tol MM]
//   階名を省略すると全階。--entry-turn-steps N は、読込み・壁再生成（dumpElevFigure.mjs --regen と同じ順）のあとで
//   メモリ上の「出入口が側面の」全階段の取りつき蹴上 entryTurnSteps を N にし（直進部から差し引いて総蹴上数を保つ）、
//   alignPortStairsOnGraph を通さずに壁だけ再生成し直す（align を通すと鉄骨以外の 0 が 1 に戻るため）。
//   --arrival-turn-steps N は同様に「到達口が側面の」全階段の arrivalTurnSteps を N にする（復路の直進部から差し引く）。
//   実データの到達口は走行端ばかり（復路のレーンが 1 行しかない）で、該当する階段が無ければ「書き換えなし」と出る
//   （到達口の区画の単体照合は stairPlanAlign.test.js）。
//
// 展開図側の取り出し（実経路）:
//   buildStairBand と同じ前処理（elevationStair.js の層・CH_upper 解決）で stairFaceSequence を呼び、各 entry の content から
//   階段由来の蹴上を取る。階段の polyline（木造=SILHOUETTE のジグザグ・鉄骨=CUT のジグザグ）の縦線＋回り段の
//   landingStepRisers（content に実在するもののみ）。隔て板・柱・壁の縦線・鉄骨ささらの DETAIL 輪郭は数えない。
//   面ローカル x → 世界は cutOriginWorld + x*dirSign（sectionTypes.js worldOf）。
// 平面側: buildStairGeometry(view:'upper', insetView:'install', detail:false, laneGap) の treads（放射線・直線とも線分）と、
//   detail:false＝段のセル境界（stairTreadFootprints と同じ）。直進系の詳細 LOD の ±nosing（20mm）のずれは照合しない（裁定待ち）。
//   階段の基端・終端の辺（outline のうち走行方向に直交する外周）を切断線で切った交点。
// 切断面の種別: 縦断（切断線が階段の走行軸に平行＝蹴上の縦線が出る）／横断（梯子の水平線だけ＝縦線なし。未検査）。
// 判定: OK／NG／「—（未検査）」。未検査＝横断・階段なし、または面端を除いて展開図・平面とも蹴上が 0 本の縦断。
// 面端(未検査): 面の両端（0 と face.run）±tol の展開図の蹴上・平面の交点。端の縦線は sectionStair.js computeFlightProfile が
//   [loX,hiX] へクランプするため真の段鼻の位置を判定できず、一致にも不一致にも数えず別欄に出す。
// 終了コード: 0＝検査した縦断がすべて一致／1＝不一致あり／2＝用法違反／3＝検査した縦断が 0 件（階段なし等で何も見ていない）。
// 既知の差: 本番 buildStairBand は ctx.wallLessEndExtendModelMm（壁のない端部の延長量。図形側の倍率決定後の値）を渡すが、
//   本 probe は渡さず既定（150）で動かす（dumpElevFigure.mjs と同条件）。壁のない端の探査窓が実アプリと違いうるので、
//   壁のない端に面が接する階段では面端付近の蹴上の有無が実機と食い違う可能性がある（面端は未検査欄に分けてある）。
import fs from 'node:fs';
import path from 'node:path';
import { RoomFeature, StairType } from '../../src/core.js';
import { loadDocument } from './loadDoc.mjs';
import { composeRoomFaces } from '../../src/elevation/elevationFaceList.js';
import { stairBandWallFilter, switchbackCuts } from '../../src/elevation/section/cuts/switchbackCuts.js';
import { straightCuts } from '../../src/elevation/section/cuts/straightCuts.js';
import { stairFaceSequence } from '../../src/elevation/elevationStairSequence.js';
import { buildBandLayers } from '../../src/elevation/section/sectionBandLayers.js';
import { stairPortEdges, buildStairGeometry, uTurnPlanLayout, straightPlanLayout } from '../../src/finish/stair/stairGeometry.js';
import { measureStairSpans } from '../../src/finish/stair/stairClassify.js';
import { floorHeightAbove } from '../../src/finish/stair/stairDimensions.js';
import { roomCeilingHeight } from '../../src/finish/roomMetrics.js';
import { roomBounds, worldToCell } from '../../src/finish/gridCells.js';
import { buildEnclosureCellToRoom, ADJACENT_SAMPLE_EPS } from '../../src/finish/edgeClassify.js';
import { findOverlappingRoom } from '../../src/elevation/elevationVoid.js';
import { withCutLandings, landingStepRisers, stairAxisIsVertical } from '../../src/elevation/section/sectionStair.js';
import { cutOriginWorld } from '../../src/elevation/section/sectionTypes.js';
import { ElevationLineRole, weightForRole } from '../../src/elevation/elevationStyle.js';
import { withGraphReadScope } from '../../src/graphReadScope.js';
import { hasPortSides, portRunIndex, resolvePorts, MIN_RUN_RISERS } from '../../src/finish/stair/stairPorts.js';
import { StairPortSide } from '../../src/core.js';
import {
  DEFAULT_TOL_MM, noseLocalXs, verticalLineXs, localToWorldRun, planCrossings, summarizeCut, totalOf, formatRows, uniqueSorted,
} from './stairElevPlanDiff.mjs';

const USAGE = 'usage: diffStairElevPlan.mjs <src.stq> [階名...] [--entry-turn-steps N] [--arrival-turn-steps N] [--json out] [--verbose] [--tol MM]';
function usageError(msg) { console.error(`${msg}\n${USAGE}`); process.exit(2); }

// ---- 引数 ----
const argv = process.argv.slice(2);
const positional = [];
const opt = { entryTurnSteps: null, arrivalTurnSteps: null, json: null, verbose: false, tol: DEFAULT_TOL_MM };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--verbose') opt.verbose = true;
  else if (a === '--entry-turn-steps' || a === '--arrival-turn-steps' || a === '--json' || a === '--tol') {
    const v = argv[++i];
    if (v == null || v.startsWith('--')) usageError(`${a} に値がありません`);
    if (a === '--json') opt.json = v;
    else {
      const n = Number(v);
      const isSteps = a === '--entry-turn-steps' || a === '--arrival-turn-steps';
      if (!Number.isFinite(n) || (isSteps && (!Number.isInteger(n) || n < 0)) || (a === '--tol' && n <= 0)) usageError(`${a} の値が不正です: ${v}`);
      if (a === '--tol') opt.tol = n; else if (a === '--entry-turn-steps') opt.entryTurnSteps = n; else opt.arrivalTurnSteps = n;
    }
  } else if (a.startsWith('--')) usageError(`unknown option: ${a}`);
  else positional.push(a);
}
const src = positional[0];
if (!src) usageError('src.stq がありません');
if (!fs.existsSync(src)) usageError(`ファイルがありません: ${src}`);
const floorFilter = positional.slice(1);
const docName = path.basename(src, '.stq');

// ---- 読込み・壁再生成（dumpElevFigure.mjs --regen / dumpStairPlan.mjs と同じ順） ----
async function regenerateAllWalls(project, { align }) {
  const { runInAction } = await import('mobx');
  const { resolveStairContext } = await import('../../src/finish/stair/stairUnderRooms.js');
  const { regenerateWalls, loadMaterialMap } = await import('../../src/finish/wallRegeneration.js');
  const { conformWoodBacking } = await import('../../src/structural/woodAutoFill.js');
  const { alignPortStairsOnGraph } = await import('../../src/finish/stair/stairSectionEdit.js');
  const materialMap = await loadMaterialMap();
  const graphMapPeek = async (plane) => project.graphMap.get(plane.id) ?? null;
  for (const p of project.planes) {
    const graph = project.graphMap.get(p.id);
    if (!graph) continue;
    if (align) {
      runInAction(() => conformWoodBacking(graph, project));
      runInAction(() => alignPortStairsOnGraph(graph));
    }
    const { stairUnderEntries, extraStairOpenings } = await resolveStairContext(graph, project, graphMapPeek);
    await regenerateWalls(graph, { materialMap, project, stairUnderEntries, extraStairOpenings });
  }
}

// 出入口 port（'entry'|'arrival'）が側面の全階段の取りつき蹴上（entryTurnSteps / arrivalTurnSteps）を N にする
// （総蹴上数は直進部で保つ）。直進部が MIN_RUN_RISERS を割る階段は書き換えず skipped に積む。{changed, skipped} を返す。
async function overrideTurnSteps(project, port, n) {
  const field = port === 'entry' ? 'entryTurnSteps' : 'arrivalTurnSteps';
  const flag = port === 'entry' ? '--entry-turn-steps' : '--arrival-turn-steps';
  const { runInAction } = await import('mobx');
  let changed = 0;
  const skipped = [];
  for (const p of project.planes) {
    const graph = project.graphMap.get(p.id);
    if (!graph) continue;
    for (const stair of graph.stairs) {
      if (!hasPortSides(stair.type)) continue;
      const resolved = resolvePorts(stair, measureStairSpans(stair, graph));
      const side = resolved?.[port];
      if (!side || side === StairPortSide.END) continue;
      const cur = stair[field] ?? 0;
      if (cur === n) continue;
      let sections = null;
      if (Array.isArray(stair.sections)) {
        sections = [...stair.sections];
        const idx = portRunIndex(stair.type, port);
        sections[idx] += cur - n;
        if (sections[idx] < MIN_RUN_RISERS) {
          skipped.push(`${p.name}/${stair.roomId}: 直進部が ${sections[idx]} 段（< ${MIN_RUN_RISERS}）になるため ${flag} ${n} を適用せず除外（${field}=${cur} のまま）`);
          continue;
        }
      }
      runInAction(() => {
        if (sections) stair.setField('sections', sections);
        stair.setField(field, n);
      });
      changed++;
    }
  }
  return { changed, skipped };
}

// ---- buildStairBand の前処理（elevationStair.js。resolveUpperCeilingHeight は非公開のため写す） ----
function resolveUpperCeilingMm(stair, stairRoom, graph, upperGraph) {
  if (stair) {
    const cellToRoom = buildEnclosureCellToRoom(upperGraph);
    for (const edge of stairPortEdges(stair, graph, ['arrival'])) {
      const mid = (edge.lo + edge.hi) / 2;
      for (const sign of [1, -1]) {
        const probe = sign * ADJACENT_SAMPLE_EPS;
        const px = edge.isVertical ? edge.value + probe : mid;
        const py = edge.isVertical ? mid : edge.value + probe;
        const cell = worldToCell(px, py, upperGraph);
        const room = cell ? cellToRoom.get(cell.key) : null;
        if (room) return roomCeilingHeight(upperGraph, room).mm;
      }
    }
  }
  const overlap = findOverlappingRoom(roomBounds(stairRoom.cells, graph), upperGraph,
    r => r.feature === RoomFeature.VOID || r.feature === RoomFeature.STAIR_VOID);
  if (overlap) return roomCeilingHeight(upperGraph, overlap).mm;
  return upperGraph.defaultCeilingHeight;
}

const sameLine = (a, b) => ['x1', 'y1', 'x2', 'y2'].every(k => Math.abs(a[k] - b[k]) < 1e-6);
const WEIGHT_ZIGZAG = new Set([weightForRole(ElevationLineRole.SILHOUETTE), weightForRole(ElevationLineRole.CUT)]);

// 階段由来の蹴上: ジグザグの polyline（content の polyline は階段のものだけ）の段鼻＋content に実在する回り段の蹴上線
function stairRiserLocalXs(content, cut, stair, edgeXs) {
  const zigzag = content.filter(p => p.type === 'polyline' && WEIGHT_ZIGZAG.has(p.weight));
  // 蹴込は flight が持つ値（U 字系は stair.nosing・直進系は 0＝垂直の蹴上）。stair.nosing を直接使うと直進系の最終段を誤補正する
  const nosingMm = Math.max(0, ...(cut.stairCut?.flights ?? []).map(f => f.nosingMm ?? 0));
  const xs = noseLocalXs(zigzag, { nosingMm, edgeXs });
  const contribution = cut.stairCut ? withCutLandings(cut.stairCut, cut) : null;
  if (contribution) {
    const turnRisers = landingStepRisers(contribution.landings, stairAxisIsVertical(contribution, cut), cut);
    xs.push(...verticalLineXs(turnRisers.filter(t => content.some(c => c.type === 'line' && sameLine(c, t)))));
  }
  return xs;
}

// 平面の幾何（install 枠で全段を描いた踏面線・放射線・外周。view 'upper' は破れで打ち切らない）
function planGeometry(stair, graph, project) {
  const floorHeight = floorHeightAbove(project, graph.plane);
  const riser = stair.riser ?? (floorHeight / Math.max(1, stair.totalSteps));
  // detail:false＝段のセルの境界（stairTreadFootprints・straightPlanLayout と同じ位置）。直進系の平面は詳細 LOD（detail:true）で踏面線を
  // ±nosing ずらして描く（buildStraight の nosingMm。U 字系は無し）ので、detail:true だと直進系の蹴上が一律に蹴込ぶんずれて見える。
  // 展開図はセルの境界に揃える（ずらし分は平面側の描画規約で、本 probe の対象外）
  return buildStairGeometry(stair, roomBounds(stair.cells, graph), {
    view: 'upper', insetView: 'install', detail: false, riser, spans: measureStairSpans(stair, graph), laneGap: true, graph,
  });
}

// 踏面線に載らない「最初/最後の蹴上の辺」の走行座標（平面側の値だけから取る）。外周 outline のうちこの位置にあるものだけを
// 蹴上の辺として数える（外周には踊り場の奥壁など蹴上でない辺も含まれるため）。
//   U 字系: uTurnPlanLayout の baseA（走行端の上り口か取りつき段ありのとき最初の蹴上の辺）と startB（最後の蹴上の辺）
//     — stairPlanAlign.test.js の planOut/planIn と同じ定義。
//   直進系: straightPlanLayout の exitA（最後の直進部の終端＝最後の蹴上の辺）・base（走行端の上り口か取りつき段ありのとき最初の蹴上の辺）・
//     end（到達口の区画に段があるとき、区画の外縁の上階の床との蹴上）。
function boundaryRunValues(stair, graph) {
  if (stair.type === StairType.STRAIGHT || stair.type === StairType.STRAIGHT_LANDING) {
    const p = straightPlanLayout(stair, graph);
    if (!p) return [];
    const vals = [p.run.exitA];
    if (p.entryPort === 'end' || p.entryTurnSteps >= 1) vals.push(p.run.base);
    if (p.arrivalPort !== 'end' && p.arrivalTurnSteps >= 1) vals.push(p.run.end);
    return vals;
  }
  if (stair.type === StairType.SWITCHBACK || stair.type === StairType.WINDING) {
    const p = uTurnPlanLayout(stair, graph);
    if (!p) return [];
    const vals = [p.run.startB];
    if (p.entryPort === 'end' || p.entryTurnSteps >= 1) vals.push(p.run.baseA);
    if (p.arrivalPort !== 'end' && p.arrivalTurnSteps >= 1) vals.push(p.run.baseB); // 到達口の区画の外縁（上階の床との蹴上）
    return vals;
  }
  return [];
}

const rows = [];
const notes = [];
const { project } = loadDocument(src);
if (floorFilter.length > 0) {
  const names = new Set(project.planes.map(p => p.name));
  for (const f of floorFilter) if (!names.has(f)) usageError(`階が見つかりません: ${f}（あるのは ${[...names].join(', ')}）`);
}
await regenerateAllWalls(project, { align: true });
// 取りつき蹴上の上書き（上り口・到達口。どちらか／両方）。書き換えがあれば壁を再生成する（align は通さない）
let overridden = false;
for (const [port, flag, n, label] of [
  ['entry', '--entry-turn-steps', opt.entryTurnSteps, '上り口'],
  ['arrival', '--arrival-turn-steps', opt.arrivalTurnSteps, '到達口'],
]) {
  if (n == null) continue;
  const { changed, skipped } = await overrideTurnSteps(project, port, n);
  notes.push(changed > 0
    ? `${flag} ${n}: 側面の${label}の階段 ${changed} 件を書き換えて壁を再生成`
    : `${flag} ${n}: 書き換えなし（側面の${label}の階段は既に ${n}、または無い／除外。再生成もしていない）`);
  for (const sk of skipped) notes.push(sk);
  if (changed > 0) overridden = true;
}
if (overridden) await regenerateAllWalls(project, { align: false });

const tabs = project.orderedTabs;
for (let i = 0; i < tabs.length; i++) {
  const p = tabs[i];
  if (floorFilter.length > 0 && !floorFilter.includes(p.name)) continue;
  const graph = project.graphMap.get(p.id);
  if (!graph) continue;
  const upperGraph = project.graphMap.get(tabs[i + 1]?.id) ?? null;
  const lowerGraph = project.graphMap.get(tabs[i - 1]?.id) ?? null;
  const run = () => {
    const floorHeight = floorHeightAbove(project, graph.plane);
    for (const stair of graph.stairs) {
      const room = stair.roomId ? graph.roomMap?.get(stair.roomId) : null;
      const roomName = room?.name || stair.roomId || '(部屋なし)';
      const tag = `${docName}/${p.name}/${roomName}`;
      if (!room || room.feature !== RoomFeature.STAIR) { notes.push(`${tag}: 階段室の Room が無い→対象外`); continue; }
      if (![StairType.SWITCHBACK, StairType.WINDING, StairType.STRAIGHT, StairType.STRAIGHT_LANDING].includes(stair.type)) {
        notes.push(`${tag}: 型 ${stair.type} は断面切断表が無い（フォールバック描画）→対象外`); continue;
      }
      if (!upperGraph) { notes.push(`${tag}: 直上階が無く 2 層帯にならない→対象外`); continue; }
      const chUpperAbsMm = floorHeight + resolveUpperCeilingMm(stair, room, graph, upperGraph);
      const wallFilter = stairBandWallFilter(stair, graph);
      const composedFaces = composeRoomFaces(room, graph, { keepWallLessFaces: true, wallFilter });
      const layers = buildBandLayers(graph, { above: [{ graph: upperGraph, floorHeightMm: floorHeight }] });
      const seqOpts = { floorHeight, chUpperAbsMm, chLowerMm: roomCeilingHeight(graph, room).mm, upperGraph, layers };
      const sequence = stairFaceSequence(stair, composedFaces, graph, seqOpts);
      const table = (stair.type === StairType.STRAIGHT || stair.type === StairType.STRAIGHT_LANDING)
        ? straightCuts(stair, composedFaces, graph, seqOpts) : switchbackCuts(stair, composedFaces, graph, seqOpts);
      if (!sequence || !table) { notes.push(`${tag}: 歩行順の面シーケンスが組めない→対象外`); continue; }
      const geom = planGeometry(stair, graph, project);
      const boundary = boundaryRunValues(stair, graph);
      for (const entry of sequence) {
        const cut = table.cuts.find(c => c.seqNo === entry.seqNo);
        if (!cut) { notes.push(`${tag}: seq${entry.seqNo} の切断が表に無い`); continue; }
        const contribution = cut.stairCut ? withCutLandings(cut.stairCut, cut) : null;
        const lengthwise = contribution ? stairAxisIsVertical(contribution, cut) === cut.line.isVertical : false;
        const origin = cutOriginWorld(cut);
        const faceOrigin = entry.face?.originWorld;
        if (faceOrigin != null && Math.abs(faceOrigin - origin) > 1e-6) notes.push(`${tag}: seq${entry.seqNo} 面の origin ${faceOrigin} ≠ 切断の origin ${origin}`);
        let elevRuns = [], planRuns = [];
        if (lengthwise) {
          elevRuns = stairRiserLocalXs(entry.content, cut, stair, [0, entry.face?.run ?? NaN]).map(x => localToWorldRun(x, origin, cut.dirSign));
          planRuns = planCrossings(geom.treads, cut.line, { tol: opt.tol });
          const edgeRuns = planCrossings(geom.outline, cut.line, { tol: opt.tol });
          for (const b of boundary) {
            const v = typeof b === 'number' ? b : (b.isVertical !== cut.line.isVertical ? b.value : null);
            if (v == null) continue;
            for (const r of edgeRuns) if (Math.abs(r - v) <= opt.tol) planRuns.push(r);
          }
          planRuns = uniqueSorted(planRuns);
        }
        const row = summarizeCut({
          doc: docName, floor: p.name, room: roomName, seq: `seq${entry.seqNo}`,
          kind: lengthwise ? '縦断' : (contribution ? '横断' : '階段なし'),
          elevRuns, planRuns, edgeRuns: lengthwise ? [0, entry.face?.run ?? NaN].map(x => localToWorldRun(x, origin, cut.dirSign)) : [],
          tol: opt.tol,
        });
        row.origin = origin; row.dirSign = cut.dirSign; row.line = cut.line;
        rows.push(row);
      }
    }
  };
  withGraphReadScope(graph, () => withGraphReadScope(upperGraph, () => withGraphReadScope(lowerGraph, run)));
}

const localOf = (r, w) => (w - r.origin) * r.dirSign;
console.log(formatRows(rows, { verbose: opt.verbose, localOf }));
for (const n of notes) console.error(`[note] ${n}`);
const total = totalOf(rows);
console.log(`合計: 切断面 ${total.cuts}・検査した縦断 ${total.checked}（OK ${total.okCuts}・不一致 ${total.badCuts}）・展開図の蹴上 ${total.elev}・平面の交点 ${total.plan}・一致 ${total.matched}・展開図だけ ${total.elevOnly}・平面だけ ${total.planOnly}・面端(未検査) ${total.edge}`);
if (opt.json) fs.writeFileSync(opt.json, JSON.stringify({ src, options: opt, notes, rows, total }, null, 1));
if (total.checked === 0) {
  console.error('検査した縦断が 0 件です（階段なし・対象外の型・直上階なし等）。exit 3');
  process.exit(3);
}
process.exit(total.elevOnly + total.planOnly > 0 ? 1 : 0);
