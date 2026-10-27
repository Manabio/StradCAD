// 課題(i)（cl-conversion-limits.md 限界16 (i)）S0: 症状の実測（本番の関数を呼ぶ）。
// 目的: (1) 本番の propagateCLEccentricities を、各階をアクティブにして内壁の乗る各 CL に偏芯を設定して呼び、
//   連動で保存された階・偏芯レコードが付いた CL の種別・偏芯した壁の数を出す（actual）。
//   並び順を 3 通りで比べる: native（文書のまま）／centerFirst（全階の shapeMap で同座標の非「中心線」を末尾へ。delete→set）／
//   beamFirst（同座標の中心線を末尾へ＝梁芯が先）。centerFirst との差が findCounterpartCL の「種別を見ない」ことの実害。
//   (2) addMissingCLs（階段の写し・吹抜け整合・新階・地階初期化が通る）で、写した中心線の extent 参照が梁芯を指すか、
//   指した梁芯が isProtectedWallBeamAxis で保護されるか（孤児の壁由来梁芯の撤去に効く）。
//   (3) translateCellSet が返すセルキーに梁芯の id が混じるか。
// 引数: <入力.stq> [出力.json]   （IDB へは書かない。saveFloorFn はスタブ。読込み直後の状態で測る）
// 使い方（ローダー必須。app/ で実行）:
//   node --import ./scripts/testSetup.mjs scripts/probe/counterpartKindSymptomProbe.mjs D:/tatsuya/Download/i-repro-a-void-upper.stq
import fs from 'node:fs';
import { runInAction } from 'mobx';
import { loadDocument } from './loadDoc.mjs';
import { floorSwapManager } from '../../src/storage/FloorSwapManager.js';
import { loadMaterialMap } from '../../src/finish/wallRegeneration.js';
import { propagateCLEccentricities } from '../../src/finish/eccentricityFloorSync.js';
import { collectNeededCLs, addMissingCLs, translateCellSet } from '../../src/finish/floorCLMap.js';
import { refreshCells } from '../../src/finish/gridCells.js';
import { isProtectedWallBeamAxis } from '../../src/structural/wallBeamAxes.js';
import { centerLineKind } from '../../src/core/centerLine.js';
import { CenterLineType } from '../../src/core/constants.js';
import { Discipline } from '../../src/core.js';

const src = process.argv[2];
const outPath = process.argv[3] ?? null;
if (!src) { console.error('usage: counterpartKindSymptomProbe.mjs <in.stq> [out.json]'); process.exit(1); }
const EPS = 1e-6;
const materialMap = await loadMaterialMap();
const SPEC = { mode: 'face', value: 0, side: 1, backing: '' };

/**
 * 同座標に中心線と他種別(梁芯等)が並ぶ線について shapeMap(delete→set で末尾へ)の順を作り替える。
 * order='centerFirst': 中心線以外を末尾へ。order='beamFirst': 中心線を末尾へ（梁芯が先）。'native'は触らない。
 */
function reorder(project, order) {
  if (order === 'native') return;
  runInAction(() => {
    for (const p of project.planes) {
      const g = project.graphMap.get(p.id);
      const all = [...g.shapeMap.values()].filter(s => s.centerLineType != null);
      for (const cl of all) {
        const isCenter = centerLineKind(cl) === 'center';
        const movable = order === 'centerFirst' ? !isCenter : isCenter;
        if (!movable) continue;
        const coexist = all.some(o => o !== cl && o.centerLineType === cl.centerLineType && Math.abs(o.value - cl.value) < EPS
          && (order === 'centerFirst' ? centerLineKind(o) === 'center' : centerLineKind(o) !== 'center'));
        if (!coexist) continue;
        g.shapeMap.delete(cl.id);
        g.shapeMap.set(cl.id, cl);
      }
    }
  });
}

function open(order) {
  const { project } = loadDocument(src);
  floorSwapManager.peek = async (plane) => project.graphMap.get(plane.id) ?? null;
  reorder(project, order);
  return project;
}
// 偏芯の効果: その階の水平壁(y=3000 付近)の axisOffset の並び（偏芯が効けば 0 から変わる）
const wallOffsets = (g) => g.walls.filter(w => !w.isVertical && Math.abs(w.axisCL.effectiveValue - 3000) < 1).map(w => Math.round(w.axisOffset ?? 0)).sort((a, b) => a - b);

async function runPropagate(order, activeIdx, clIdx) {
  const project = open(order);
  const planes = project.planes;
  const active = project.graphMap.get(planes[activeIdx].id);
  const ids = [...active.edges].filter(e => e.masterType === 'INTERIOR_WALL' && active.shapeMap.has(e.axisCLId) && centerLineKind(active.shapeMap.get(e.axisCLId)) === 'center').map(e => e.axisCLId);
  const unique = [...new Set(ids)];
  if (clIdx >= unique.length) return null;
  const clId = unique[clIdx];
  const cl = active.shapeMap.get(clId);
  runInAction(() => active.setCLEccentricity(clId, SPEC));
  const baseOff = planes.map(p => wallOffsets(project.graphMap.get(p.id)));
  const saved = [];
  await propagateCLEccentricities(project, active, [clId], { materialMap, saveFloorFn: async (planeId) => { saved.push(planes.find(p => p.id === planeId).name); } });
  const targets = {};
  planes.forEach((p, i) => {
    if (i === activeIdx) return;
    const g = project.graphMap.get(p.id);
    const kinds = [...g.clEccentricities.keys()].map(id => {
      const c = g.shapeMap.get(id); return c ? `${centerLineKind(c)}@${c.centerLineType === CenterLineType.VERTICAL ? 'V' : 'H'}${Math.round(c.value)}` : '(不明)';
    });
    targets[p.name] = { records: kinds, wallAxisOffsets: `${baseOff[i]}=>${wallOffsets(g)}` };
  });
  return {
    active: planes[activeIdx].name,
    cl: `${centerLineKind(cl)}@${cl.centerLineType === CenterLineType.VERTICAL ? 'V' : 'H'}${Math.round(cl.value)}`,
    saved, targets,
  };
}

const result = { src, propagate: [], extentRef: null, cellSet: null };
const nPlanes = open(false).planes.length;
for (let a = 0; a < nPlanes; a++) {
  for (let k = 0; ; k++) {
    const act = await runPropagate('native', a, k);
    if (!act) break;
    const ctl = await runPropagate('centerFirst', a, k);
    const bf = await runPropagate('beamFirst', a, k);
    result.propagate.push({ actual: act, control: ctl, beamFirst: bf, differs: JSON.stringify(act) !== JSON.stringify(ctl), differsBeamFirst: JSON.stringify(bf) !== JSON.stringify(ctl) });
  }
}

// (2) addMissingCLs の extent 参照 / (3) translateCellSet。源 = 先頭階、相手 = 次の階（同座標に梁芯と中心線が並ぶ階を想定）。
async function runExtentAndCells(order) {
  const project = open(order);
  const [p1, p2] = project.planes;
  const g1 = project.graphMap.get(p1.id), g2 = project.graphMap.get(p2.id);
  const own = (g) => [...g.shapeMap.values()].filter(s => s.centerLineType != null);
  const R = own(g1).find(c => c.centerLineType === CenterLineType.HORIZONTAL && Math.abs(c.value - 3000) < EPS && centerLineKind(c) === 'center');
  if (!R) return { skipped: '源階に y=3000 の中心線が無い' };
  // 源階に x=3000 の新しい中心線 V を足し、その extentHi が R（y=3000）を参照する
  // 値 1234 は相手階に同座標の線が無い座標（3000 には相手階に梁芯があり、V の対応先が梁芯になってしまうため避ける）
  const V = runInAction(() => {
    const v = g1.addCenterLine(CenterLineType.VERTICAL, 1234, { labeled: false, discipline: Discipline.ARCH, trim: true });
    g1.setCenterLineExtentRef(v, 'hi', { clId: R.id, offset: 0 }, null);
    return v;
  });
  const x0 = own(g1).find(c => c.centerLineType === CenterLineType.VERTICAL && Math.abs(c.value) < EPS && centerLineKind(c) === 'center');
  const y0 = own(g1).find(c => c.centerLineType === CenterLineType.HORIZONTAL && Math.abs(c.value) < EPS && centerLineKind(c) === 'center');
  const key = `${x0.id}:${y0.id}:${V.id}:${R.id}`;
  const needed = collectNeededCLs(new Set([key]), g1);
  const bBefore = own(g2).filter(c => centerLineKind(c) === 'beam' && c.centerLineType === CenterLineType.HORIZONTAL && Math.abs(c.value - 3000) < EPS);
  const protBefore = bBefore.map(b => ({ origin: b.beamAxisOrigin ?? null, protected: isProtectedWallBeamAxis(g2, b) }));
  const added = runInAction(() => addMissingCLs(needed, g1, project.structGraph, g2));
  const nv = own(g2).find(c => c.centerLineType === CenterLineType.VERTICAL && Math.abs(c.value - 1234) < EPS);
  const refId = nv?.extentHiRef?.clId ?? null;
  const refCl = refId ? g2.shapeMap.get(refId) : null;
  const protAfter = bBefore.map(b => ({ origin: b.beamAxisOrigin ?? null, protected: isProtectedWallBeamAxis(g2, b) }));
  // translateCellSet
  const tr = translateCellSet(new Set([key]), g1, project.structGraph, g2);
  const kindsInKeys = tr ? [...tr].map(k => k.split(':').map(id => { const c = g2.shapeMap.get(id) ?? project.structGraph.shapeMap.get(id); return c ? centerLineKind(c) : '?'; })) : null;
  const refreshed = tr ? [...refreshCells(tr, g2)] : null;
  return {
    addedCount: added,
    newCLExtentHiRefKind: refCl ? centerLineKind(refCl) : (nv ? (nv.extentHi != null ? `静的値 ${nv.extentHi}` : 'ref/静的値なし') : '新CLなし'),
    g2BeamAxesAtY3000: { before: protBefore, after: protAfter },
    translateCellSetKeyKinds: kindsInKeys, rawKeyIsRefreshedKey: tr ? [...tr].every(k => refreshed.includes(k)) : null,
  };
}
result.extentRef = {};
for (const order of ['native', 'centerFirst', 'beamFirst']) result.extentRef[order] = await runExtentAndCells(order);

for (const p of result.propagate) {
  const f = (x) => x && `active=${x.active} CL=${x.cl} saved=[${x.saved}] ` + Object.entries(x.targets).map(([n, t]) => `${n}:records=[${t.records}] 壁axisOffset ${t.wallAxisOffsets}`).join(' ');
  console.log(`${p.differs ? 'DIFF' : 'same'}(native) ${p.differsBeamFirst ? 'DIFF' : 'same'}(beamFirst) | native  ${f(p.actual)}\n     | centerFirst ${f(p.control)}\n     | beamFirst  ${f(p.beamFirst)}`);
}
console.log('extent/cellset:', JSON.stringify(result.extentRef));
if (outPath) fs.writeFileSync(outPath, JSON.stringify(result, null, 1));
