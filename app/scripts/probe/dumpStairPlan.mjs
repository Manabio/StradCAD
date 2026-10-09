// 平面に描く階段の線（S7a 安全網）の golden 比較 probe。
// renderer/StairLayer.jsx が実際に描く線（踏面・外周・破れ先の破線・破れ線・矢印・段数字・隔て壁の輪郭）を、
// App.jsx の上下 peek（upperStairEntriesPeek＝直下階 peek、upperSlabOpenings＝直上階スラブ開口）まで含めて
// 再現して文書・階ごとに golden-stair-plan/<文書>.json と比べる。
//   エントリ構築 … buildUpperStairPeekEntries → slabOpeningRects → buildStairEntries（App.jsx 790-860・2449 と同じ手順）
//   描画の写像 … StairLayer.jsx の 1〜3 パス目（resolveStairSideLines・破れ線クリップ・矢印クリップ・段数字の間引き・
//     stairLineRenderProps による線幅/破線/L字結合）を同じ関数で再現する。StairLayer 側の判断を変えたらここも追随させる
//     （追随し忘れは golden 差分として現れず、probe が古いまま通る——StairLayer.jsx を変えたら本 probe の写像も見直す）。
// 使い方（app/ から）:
//   node --import ./scripts/testSetup.mjs scripts/probe/dumpStairPlan.mjs            … golden と比較（差分があれば終了コード 1）
//   node --import ./scripts/testSetup.mjs scripts/probe/dumpStairPlan.mjs --write    … golden を書き直す（意図した変更のときだけ）
//   文書を指定するときは末尾に *.stq のパスを並べる（golden は同名 .json）。省略すると DEFAULT_DOCS（D:/tatsuya/Download）。
// 壁の再生成（既定）… 実アプリは文書を開くと鮮度キー（v7）で全階の壁を再生成し、在来の隔て壁の柱は PB 包み
//   （通り芯±57.5）になる。保存済みのままだと包みが無く柱材の面（±45）で階段を描いてしまうので、既定では
//   dumpElevFigure.mjs --regen／dumpPlanRegen.mjs と同じ手順（conformWoodBacking → resolveStairContext →
//   regenerateWalls。graphMapPeek は project.graphMap）で全階を再生成してから描く。--no-regen で保存済みの壁のまま比べる。
//   golden はこの既定（再生成後）で採る。
// 環境変数 NO_PEEK=1 … 上下 peek を渡さない変異（検出力確認用: peek 経路が出力に効いていることの確認）。
// 前提（ASSUMED の根拠）: Viewport は実クラスを使い scaleX を縮尺 1/50（DETAIL LOD）に固定、校正値は loadCalibration の既定。
import fs from 'node:fs';
import path from 'node:path';
import { loadDocument } from './loadDoc.mjs';
import { Viewport } from '../../src/viewport.js';
import { overhangMm } from '../../src/snapGeometry.js';
import { buildStairEntries, buildUpperStairPeekEntries } from '../../src/finish/stair/stairEntries.js';
import { slabOpeningRects } from '../../src/finish/stair/slabOpening.js';
import { stairRiserOf } from '../../src/finish/stair/stairDimensions.js';
import { buildStairGeometry, resolveStairSideLines, LABEL_OUT } from '../../src/finish/stair/stairGeometry.js';
import {
  clipSegmentsBeyondBreak, reversePointPairs, trimBreakOverhang,
  clipPolylineStartAtBreak, clipPolylineEndAtBreak,
} from '../../src/finish/stair/beyondBreakClip.js';
import { pointInRects, clipSegmentsToRects } from '../../src/finish/stair/segmentClip.js';
import { stairLineRenderProps, stairDownviewDashPx, outlineStrokeWidth } from '../../src/finish/stair/stairLineJoinPrimitives.js';

const DEFAULT_DOCS = ['13', '14', 'moku1-6', 'moku4', 'wood-void-test', 'opening-test', 'plan-solids-test'];
const GOLDEN_DIR = path.resolve(import.meta.dirname, 'golden-stair-plan');
const args = process.argv.slice(2);
const write = args.includes('--write');
const regen = !args.includes('--no-regen');
const unknownOption = args.find(a => a.startsWith('-') && a !== '--write' && a !== '--no-regen');
if (unknownOption) { console.error(`unknown option: ${unknownOption}`); process.exit(1); }
const srcArgs = args.filter(a => a.endsWith('.stq'));
const sources = srcArgs.length ? srcArgs : DEFAULT_DOCS.map(n => `D:/tatsuya/Download/${n}.stq`);
const noPeek = process.env.NO_PEEK === '1';

const viewport = new Viewport(1200, 900, 0, 0);
viewport.scaleX = viewport.pxPerMmX / 50; // 縮尺 1/50（DETAIL LOD）
viewport.scaleY = viewport.pxPerMmY / 50;
if (viewport.lodLevel !== 'detail') throw new Error(`LOD が detail でない: ${viewport.lodLevel}`);

const r3 = v => Math.round(v * 1000) / 1000;
const r4 = v => Math.round(v * 10000) / 10000;
const pts = a => a.map(r3);
const segPts = s => pts([s.x1, s.y1, s.x2, s.y2]);
const byKey = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const lineStr = o => JSON.stringify(o);

// StairLayer.jsx 1〜3 パス目の写像。1 エントリ → 線の配列（role・points・width・dash・cls）。
function entryLines(e, ctx) {
  const { stair, bounds: b, riser, spans, view, graph, wallGraph } = e;
  const { breakOverhangMm, installGeomById, coveredByDownView, laneGap } = ctx;
  const resolve = g => (graph ? resolveStairSideLines(stair, graph, g, { wallGraph }) : g);
  const built = buildStairGeometry(stair, b, { view, detail: true, riser, spans, laneGap, breakOverhangMm, graph });
  const geom = resolve(built);
  const beyondGeom = view === 'install'
    ? resolve(buildStairGeometry(stair, b, { view: 'upper', insetView: 'install', detail: true, riser, spans, laneGap, breakOverhangMm, graph }))
    : null;
  const installGeom = e.installOverlap && e.clipAgainstId ? installGeomById.get(e.clipAgainstId) : null;
  const installBreakLine = trimBreakOverhang(installGeom?.breakLine, breakOverhangMm);
  const isDownView = !!e.installOverlap && e.beyondBreakBounds?.length > 0;
  const ownBreakLine = view === 'install' ? trimBreakOverhang(geom.breakLine, breakOverhangMm) : null;
  const beyondDrawable = ownBreakLine?.length > 0 && e.beyondBreakBounds?.length > 0;
  const drawOwnBeyond = beyondDrawable && !!beyondGeom && !coveredByDownView.has(e.id);
  const beyondOutlineSegs = drawOwnBeyond
    ? clipSegmentsToRects(clipSegmentsBeyondBreak(beyondGeom.outline, ownBreakLine, e.beyondBreakBounds), e.slabOpeningBounds)
    : [];
  const treadSegs = isDownView ? clipSegmentsBeyondBreak(geom.treads, installBreakLine, e.beyondBreakBounds) : geom.treads;
  const outlineSegs = isDownView
    ? clipSegmentsBeyondBreak(geom.outline, installBreakLine, e.beyondBreakBounds)
    : beyondDrawable
      ? clipSegmentsBeyondBreak(geom.outline, ownBreakLine, e.beyondBreakBounds, { keep: 'near' })
      : geom.outline;

  const out = [];
  const lw = viewport.lineWeightsPx;
  const props = stairLineRenderProps({ view, id: e.id, treadSegs, outlineSegs, isDownView }, viewport, lw);
  props.treads.forEach((p, i) => out.push({ role: 'tread', points: pts(p.points), width: r4(p.strokeWidth), dash: p.dash?.map(r3) ?? null, cls: treadSegs[i].heavy ? 'heavy' : '' }));
  props.outline.forEach((p, i) => {
    const s = outlineSegs[i];
    const cls = ['thin', 'medium', 'side', 'floorEdge', 'port'].filter(k => s[k]).map(k => (k === 'port' ? `port:${s.port}` : k)).join(',');
    out.push({ role: 'outline', points: pts(p.points), width: r4(p.strokeWidth), dash: p.dash?.map(r3) ?? null, cls });
  });
  const downviewDash = stairDownviewDashPx(viewport.scaleX);
  for (const s of beyondOutlineSegs) {
    out.push({ role: 'beyond', points: segPts(s), width: r4(outlineStrokeWidth(s, viewport.scaleX, lw)), dash: downviewDash.map(r3), cls: '' });
  }
  for (const s of (geom.breakLine ?? [])) out.push({ role: 'break', points: segPts(s), width: null, dash: null, cls: '' });
  for (const s of (e.partitionOutline ?? [])) out.push({ role: 'partition', points: segPts(s), width: r4(lw.thin / viewport.scaleX), dash: null, cls: '' });

  for (const a of (geom.arrows ?? [])) {
    let ar = a;
    if (installBreakLine?.length) {
      const p = a.points ?? [a.x1, a.y1, a.x2, a.y2];
      const bounds = e.beyondBreakBounds;
      const startIsBeyond = !(bounds?.length > 0) || pointInRects(bounds, p[0], p[1]);
      const endIsBeyond = bounds?.length > 0 && pointInRects(bounds, p[p.length - 2], p[p.length - 1]);
      let c;
      if (!startIsBeyond && endIsBeyond) {
        const cl = clipPolylineStartAtBreak(p, installBreakLine);
        c = cl ? reversePointPairs(cl) : null;
      } else c = clipPolylineEndAtBreak(p, installBreakLine);
      if (c) {
        const [nx, ny, nx2, ny2] = c;
        const dx = nx - nx2, dy = ny - ny2, len = Math.hypot(dx, dy) || 1;
        ar = { ...a, x1: nx, y1: ny, points: c, labelX: nx + (dx / len) * LABEL_OUT, labelY: ny + (dy / len) * LABEL_OUT };
      }
    }
    out.push({ role: 'arrow', points: pts(ar.points ?? [ar.x1, ar.y1, ar.x2, ar.y2]), width: null, dash: null, cls: `label=${ar.label ?? ''}@${r3(ar.labelX ?? 0)},${r3(ar.labelY ?? 0)}` });
  }
  const numbers = e.installOverlap
    ? (e.beyondBreakBounds?.length > 0 ? geom.stepNumbers.filter(n => pointInRects(e.beyondBreakBounds, n.clipX ?? n.x, n.clipY ?? n.y)) : [])
    : geom.stepNumbers;
  for (const n of numbers) out.push({ role: 'number', points: pts([n.x, n.y]), width: null, dash: null, cls: `text=${n.text}` });
  return out.map(lineStr).sort(byKey);
}

function floorDump(project, planes, idx, peeks) {
  const plane = planes[idx];
  const graph = project.graphMap.get(plane.id);
  project.activePlaneId = plane.id; // buildStairEntries は project.activePlane から階高を引く
  const belowPlane = idx > 0 ? planes[idx - 1] : null;
  const abovePlane = idx + 1 < planes.length ? planes[idx + 1] : null;
  let upperStairEntriesPeek = [];
  let upperSlabOpenings = null;
  if (peeks && belowPlane) {
    upperStairEntriesPeek = buildUpperStairPeekEntries(project.graphMap.get(belowPlane.id), plane.elevation - belowPlane.elevation);
  }
  if (peeks && abovePlane) {
    upperSlabOpenings = slabOpeningRects(project.graphMap.get(abovePlane.id), { riserOf: s => stairRiserOf(s, project, abovePlane) });
  }
  const breakOverhangMm = overhangMm(viewport, false);
  const built = buildStairEntries(graph, project, { appMode: 'floorplan', viewport, upperStairEntriesPeek, upperSlabOpenings, stairBreakOverhangMm: breakOverhangMm });
  const all = [...built.installEntries, ...built.upperEntries];
  // StairLayer と同じ前処理: install エントリの幾何（矢印クリップ用）と「見下げで覆われる install」の集合
  const installGeomById = new Map();
  for (const e of built.installEntries) {
    if (!e.bounds || ![e.bounds.x1, e.bounds.y1, e.bounds.x2, e.bounds.y2].every(Number.isFinite)) continue;
    const g = buildStairGeometry(e.stair, e.bounds, { view: 'install', detail: true, riser: e.riser, spans: e.spans, laneGap: built.stairLaneGap, breakOverhangMm, graph: e.graph });
    installGeomById.set(e.id, e.graph ? resolveStairSideLines(e.stair, e.graph, g, { wallGraph: e.wallGraph }) : g);
  }
  const coveredByDownView = new Set(all.filter(e => e.installOverlap && e.beyondBreakBounds?.length > 0).map(e => e.clipAgainstId));
  const ctx = { breakOverhangMm, installGeomById, coveredByDownView, laneGap: built.stairLaneGap };
  const posKey = e => { const b = e.bounds; return `${e.view}|${[b.x1, b.y1, b.x2, b.y2].map(r3).join(',')}|${e.stair.type}|${e.stair.totalSteps}`; };
  const result = {};
  for (const e of all) {
    const b = e.bounds;
    if (!b || ![b.x1, b.y1, b.x2, b.y2].every(Number.isFinite) || b.x2 <= b.x1 || b.y2 <= b.y1) continue;
    let key = posKey(e);
    while (key in result) key += '+'; // 同位置の重複でも落とさない
    result[key] = entryLines(e, ctx);
  }
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => byKey(a, b)));
}

// 実アプリが文書を開いたときと同じ全階の壁再生成（dumpElevFigure.mjs --regen と同手順）。階ごとの壁数・隔て壁数は stderr。
async function regenerateAllWalls(project) {
  const { runInAction } = await import('mobx');
  const { resolveStairContext } = await import('../../src/finish/stair/stairUnderRooms.js');
  const { regenerateWalls, loadMaterialMap } = await import('../../src/finish/wallRegeneration.js');
  const { conformWoodBacking } = await import('../../src/structural/woodAutoFill.js');
  const { alignPortStairsOnGraph } = await import('../../src/finish/stair/stairSectionEdit.js');
  const { isStairPartitionWall, stairPartitionLines } = await import('../../src/finish/stair/stairPartition.js');
  const materialMap = await loadMaterialMap();
  const graphMapPeek = async (plane) => project.graphMap.get(plane.id) ?? null;
  for (const p of project.planes) {
    const graph = project.graphMap.get(p.id);
    if (!graph) continue;
    runInAction(() => conformWoodBacking(graph, project));
    const aligned = runInAction(() => alignPortStairsOnGraph(graph));
    if (aligned) console.error(`[regen] ${p.name}: 木造の側面の取りつき蹴上 0 を 1 へそろえた`);
    const { stairUnderEntries, extraStairOpenings } = await resolveStairContext(graph, project, graphMapPeek);
    const before = graph.walls.length;
    await regenerateWalls(graph, { materialMap, project, stairUnderEntries, extraStairOpenings });
    const lines = stairPartitionLines(graph);
    const partitions = [...graph.walls].filter(w => isStairPartitionWall(w, lines)).length;
    console.error(`[regen] ${p.name}: 壁 ${before}→${graph.walls.length}・隔て壁 ${partitions}`);
  }
}

let bad = 0;
console.log('doc\tfloor\tinstall/upper\t線数\t判定');
for (const src of sources) {
  const doc = path.basename(src, '.stq');
  let project;
  try { ({ project } = loadDocument(src)); } catch (e) { console.log(`${doc}\t(読み込み失敗: ${e.message})`); bad++; continue; }
  if (regen) await regenerateAllWalls(project);
  const planes = project.planes;
  const now = {};
  planes.forEach((plane, idx) => {
    if (!project.graphMap.get(plane.id)) return;
    now[plane.name] = floorDump(project, planes, idx, !noPeek);
  });
  const goldenPath = path.join(GOLDEN_DIR, `${doc}.json`);
  if (write) {
    fs.mkdirSync(GOLDEN_DIR, { recursive: true });
    fs.writeFileSync(goldenPath, `${JSON.stringify(now, null, 1)}\n`);
  }
  let golden = null;
  try { golden = JSON.parse(fs.readFileSync(goldenPath, 'utf8')); } catch { /* golden なし */ }
  for (const [floor, entries] of Object.entries(now)) {
    const keys = Object.keys(entries);
    const nInst = keys.filter(k => k.startsWith('install')).length;
    const nLines = keys.reduce((n, k) => n + entries[k].length, 0);
    const g = golden?.[floor];
    const ok = !!g && JSON.stringify(g) === JSON.stringify(entries);
    if (!ok) bad++;
    console.log(`${doc}\t${floor}\t${nInst}/${keys.length - nInst}\t${nLines}\t${write ? '書込' : ok ? '一致' : g ? '差分' : 'golden なし'}`);
    if (!ok && g) {
      for (const k of new Set([...Object.keys(g), ...keys])) {
        const a = g[k] ?? [], c = entries[k] ?? [];
        for (const l of a.filter(x => !c.includes(x))) console.log(`   golden のみ [${k}]: ${l}`);
        for (const l of c.filter(x => !a.includes(x))) console.log(`   新のみ [${k}]: ${l}`);
      }
    }
  }
  if (golden) for (const floor of Object.keys(golden)) if (!(floor in now)) { bad++; console.log(`${doc}\t${floor}\t(階が消えた)`); }
}
console.log(bad ? `差分あり: ${bad}` : write ? 'golden を書き込んだ' : '差分なし（golden と一致）');
process.exitCode = bad ? 1 : 0;
