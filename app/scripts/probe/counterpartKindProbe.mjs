// 課題(i)（cl-conversion-limits.md 限界16 (i)）S0: findCounterpartCL が種別の述語なしで同座標の線を拾うことの実測。
// 目的: 全階の組(S,T)×S の各 CL について、本番の findCounterpartCL(T, type, value) が返す相手の種別が源の種別と
//   違う件数、同種別の相手が別にあるのに違う種別を返した件数(C)、同種別が無い件数(D)、相手なし(none)を、呼び出し地点別に数える。
//   呼び出し地点: translateCLId(全CL / 内壁の乗るCL / 偏芯レコードのあるCL)・translateExtent(extent 参照先)・
//   translateCellSet(階段のセル / 部屋のセル / 連動に関わる部屋のセル)。関係: self(S==T。アクティブ階が自分を探し直す)・
//   adjacent(階が隣り合う)・far。主構造は相手階 T の実効主構造。あわせて同座標に複数種別が並ぶ組の shapeMap（graph.centerLines。
//   通り芯共通グラフが先頭、続いて階の挿入順）での並び順を数える。読み取り専用（IDB へは書かない）。
// 引数: <入力.stq> [出力.json] [--raw|--conv|--both（既定 both）]
//   raw = 読込み直後。conv = structAnchorProbe.mjs と同じ前処理（conform→壁再生成→梁芯追従）＋ sweepUntilConverged('desc')。
// 使い方（ローダー必須。app/ で実行）:
//   node --import ./scripts/testSetup.mjs scripts/probe/counterpartKindProbe.mjs D:/tatsuya/Download/moku4.stq out.json
// 出力: 標準出力に要約JSON、出力.json に詳細。
import fs from 'node:fs';
import { loadDocument } from './loadDoc.mjs';
import { findCounterpartCL } from '../../src/finish/floorCLMap.js';
import { centerLineKind } from '../../src/core/centerLine.js';
import { isCeilingOnlyKind } from '../../src/core/centerLineKindPolicy.js';
import { effectiveStructure } from '../../src/structural/structureRules.js';
import { RoomFeature, isShaftFeature } from '../../src/core.js';
import { convergeProject } from './hAnchorCoverageProbe.mjs';

const EPS = 1e-6;
const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const flags = process.argv.slice(2).filter(a => a.startsWith('--'));
const src = args[0];
const outPath = args[1] ?? null;
if (!src) { console.error('usage: counterpartKindProbe.mjs <in.stq> [out.json] [--raw|--conv|--both]'); process.exit(1); }
const modes = flags.includes('--raw') ? ['raw'] : flags.includes('--conv') ? ['conv'] : ['raw', 'conv'];

function inc(o, k, n = 1) { o[k] = (o[k] ?? 0) + n; }

/** 1回の lookup を分類して tally へ積む。 */
function classify(tally, T, cl) {
  const got = findCounterpartCL(T, cl.centerLineType, cl.value);
  const srcKind = centerLineKind(cl);
  tally.total++;
  if (!got) { tally.none++; return; }
  const gotKind = centerLineKind(got);
  if (gotKind === srcKind) { tally.same++; return; }
  const sameKindExists = T.centerLines.some(o =>
    o.centerLineType === cl.centerLineType && Math.abs(o.value - cl.value) < EPS && !isCeilingOnlyKind(o) && centerLineKind(o) === srcKind);
  if (sameKindExists) { tally.diffWithSameKind++; } else { tally.diffNoSameKind++; }
  inc(tally.diffPairs, `${srcKind}->${gotKind}${sameKindExists ? '(同種別あり)' : '(同種別なし)'}`);
}
const newTally = () => ({ total: 0, none: 0, same: 0, diffWithSameKind: 0, diffNoSameKind: 0, diffPairs: {} });

function sitesOf(S) {
  const own = (id) => S.shapeMap.get(id);
  const ownCLs = [...S.shapeMap.values()].filter(s => s.centerLineType != null && typeof s.value === 'number' && !isCeilingOnlyKind(s));
  const interiorIds = new Set();
  for (const e of S.edges) if (e.masterType === 'INTERIOR_WALL' && own(e.axisCLId)) interiorIds.add(e.axisCLId);
  const eccIds = [...S.clEccentricities.keys()].filter(id => own(id));
  const extentRefs = [];
  for (const cl of ownCLs) {
    for (const ref of [cl.extentLoRef, cl.extentHiRef]) {
      const r = ref?.clId ? own(ref.clId) : null;
      if (r && r.centerLineType != null) extentRefs.push(r);
    }
  }
  const cellIds = (cells) => { const s = new Set(); for (const k of cells) for (const id of k.split(':')) if (own(id)?.centerLineType != null) s.add(id); return [...s]; };
  const stairCL = [], roomCL = [], roomLinkedCL = [];
  for (const st of S.stairs ?? []) for (const id of cellIds(st.cells)) stairCL.push(own(id));
  for (const r of S.rooms) {
    const ids = cellIds(r.cells).map(own);
    roomCL.push(...ids);
    const f = r.feature;
    if (f === RoomFeature.STAIR || f === RoomFeature.STAIR_VOID || f === RoomFeature.VOID || isShaftFeature(f)) roomLinkedCL.push(...ids);
  }
  // addMissingCLs が実際に translateExtent を通すのは collectNeededCLs の対象＝階段／連動部屋のセルキーが参照する CL だけ
  const neededExtentRefs = [];
  for (const cl of [...new Set([...stairCL, ...roomLinkedCL])]) {
    for (const ref of [cl.extentLoRef, cl.extentHiRef]) {
      const r = ref?.clId ? own(ref.clId) : null;
      if (r && r.centerLineType != null) neededExtentRefs.push(r);
    }
  }
  return {
    'translateExtent:階段/連動部屋セルのCLのextent参照先': neededExtentRefs,
    'translateCLId:全CL': ownCLs,
    'translateCLId:内壁の乗るCL': [...interiorIds].map(own),
    'translateCLId:偏芯レコードのあるCL': eccIds.map(own),
    'translateExtent:extent参照先': extentRefs,
    'translateCellSet:階段セル': stairCL,
    'translateCellSet:部屋セル(全)': roomCL,
    'translateCellSet:部屋セル(階段/吹抜け/昇降路)': roomLinkedCL,
  };
}

/** 同座標に複数種別が並ぶグループの shapeMap(graph.centerLines)順での並びを数える。 */
function orderPatterns(G) {
  const cls = G.centerLines.filter(c => !isCeilingOnlyKind(c));
  const used = new Set();
  const out = { groups: 0, patterns: {}, centerAndBeam: 0, beamFirst: 0, centerFirst: 0, nonCenterFirstWhenCenterPresent: 0 };
  for (let i = 0; i < cls.length; i++) {
    if (used.has(i)) continue;
    const grp = [];
    for (let j = i; j < cls.length; j++) {
      if (!used.has(j) && cls[j].centerLineType === cls[i].centerLineType && Math.abs(cls[j].value - cls[i].value) < EPS) { grp.push(cls[j]); used.add(j); }
    }
    const kinds = grp.map(centerLineKind);
    if (new Set(kinds).size < 2) continue;
    out.groups++;
    inc(out.patterns, kinds.join('<'));
    const ic = kinds.indexOf('center'), ib = kinds.indexOf('beam');
    if (ic >= 0 && ib >= 0) { out.centerAndBeam++; if (ib < ic) out.beamFirst++; else out.centerFirst++; }
    if (ic > 0) out.nonCenterFirstWhenCenterPresent++;
  }
  return out;
}

async function measure(mode) {
  const { project } = loadDocument(src);
  let conv = null;
  if (mode === 'conv') conv = await convergeProject(project);
  const planes = project.planes;
  const floors = planes.map(p => ({ plane: p.name, structure: effectiveStructure(project.graphMap.get(p.id), project) }));
  const bySite = {};
  const orders = {};
  for (const p of planes) orders[p.name] = orderPatterns(project.graphMap.get(p.id));
  for (let si = 0; si < planes.length; si++) {
    const S = project.graphMap.get(planes[si].id);
    const sites = sitesOf(S);
    for (let ti = 0; ti < planes.length; ti++) {
      const T = project.graphMap.get(planes[ti].id);
      const rel = si === ti ? 'self' : Math.abs(si - ti) === 1 ? 'adjacent' : 'far';
      const structure = floors[ti].structure;
      for (const [site, cls] of Object.entries(sites)) {
        const key = `${site}|${rel}|T=${structure}`;
        bySite[key] ??= newTally();
        for (const cl of cls) classify(bySite[key], T, cl);
      }
    }
  }
  return { mode, convergedSweeps: conv, floors, bySite, orders };
}

const result = { src, modes: {} };
for (const m of modes) result.modes[m] = await measure(m);

// 要約: 地点×関係ごとに（主構造は合算）違う種別の件数
const summary = {};
for (const [m, r] of Object.entries(result.modes)) {
  const agg = {};
  for (const [k, t] of Object.entries(r.bySite)) {
    const [site, rel, st] = k.split('|');
    const a = (agg[`${site}|${rel}|${st}`] ??= newTally());
    for (const f of ['total', 'none', 'same', 'diffWithSameKind', 'diffNoSameKind']) a[f] += t[f];
    for (const [pk, n] of Object.entries(t.diffPairs)) inc(a.diffPairs, pk, n);
  }
  summary[m] = {
    floors: r.floors, convergedSweeps: r.convergedSweeps,
    orderTotals: Object.fromEntries(Object.entries(r.orders).map(([n, o]) => [n, { groups: o.groups, centerAndBeam: o.centerAndBeam, beamFirst: o.beamFirst, centerFirst: o.centerFirst, patterns: o.patterns }])),
    sites: Object.fromEntries(Object.entries(agg).filter(([, t]) => t.total > 0 && (t.diffWithSameKind + t.diffNoSameKind) > 0)),
    siteTotals: Object.fromEntries(Object.entries(agg).filter(([k]) => k.includes('|adjacent|') || k.includes('|self|')).map(([k, t]) => [k, t.total])),
  };
}
if (outPath) fs.writeFileSync(outPath, JSON.stringify(result, null, 1));
// 人が読む表（標準エラーへ）。列: 地点|関係 total none same C(違う種別・同種別あり) D(違う種別・同種別なし) 内訳
for (const [m, s] of Object.entries(summary)) {
  console.error(`== ${src} [${m}] 階: ${s.floors.map(f => `${f.plane}=${f.structure}`).join(' / ')}${s.convergedSweeps != null ? ` sweep=${s.convergedSweeps}` : ''}`);
  console.error(`   同座標複数種別の並び(graph.centerLines順): ${Object.entries(s.orderTotals).map(([n, o]) => `${n}:${JSON.stringify(o.patterns)}`).join(' ')}`);
  const rows = Object.entries(summary[m].sites);
  if (rows.length === 0) console.error('   違う種別を返した lookup: 0件');
  for (const [k, t] of rows) console.error(`   ${k}\ttotal=${t.total} none=${t.none} same=${t.same} C=${t.diffWithSameKind} D=${t.diffNoSameKind} ${JSON.stringify(t.diffPairs)}`);
}
console.log(JSON.stringify({ src, summary }));
