// 課題(h)（cl-conversion-limits.md 限界16 (h)）S0: 再現 .stq の実測（構造の量・梁芯・除外キー・USER梁芯の削除の影響）。
// 目的: hMakeReproDocs.mjs が作った（または実データの）.stq を読み込み、収束まで再計算した後、対象階の
//   梁芯（種別・由来・extent）・梁（role・区間）・柱・除外キーを出す。--delete を付けると、対象階の
//   「由来 USER の梁芯」を本番の deleteCenterLineWithUndo で削除し、直後と再計算×3 の各回の状態を出す。
// 引数: <入力.stq> <対象階名> [--delete] [--out <json>]
//   例: 2階。USER 梁芯が複数あるときは最初の1本（--user-index N で選択）。
// 出力: 標準出力に JSON 要約、--out があれば詳細 JSON を書く。
// 前処理: hAnchorCoverageProbe.mjs convergeProject（structAnchorProbe.mjs と同じ前処理）。他階 peek は
//   project.graphMap の生きたグラフ。IDB へは書かない（saveFloorFn は空関数）。
// 使い方（ローダー必須。app/ で実行）:
//   node --import ./scripts/testSetup.mjs scripts/probe/hReproMeasure.mjs D:/tatsuya/Download/h-wood-near.stq 2階 --delete --out out.json
import fs from 'node:fs';
import { loadDocument } from './loadDoc.mjs';
import { floorSwapManager } from '../../src/storage/FloorSwapManager.js';
import { centerLineKind } from '../../src/core/centerLine.js';
import { CenterLineType } from '../../src/core/constants.js';
import { effectiveStructure } from '../../src/structural/structureRules.js';
import { sweepUntilConverged } from './sweepOrder.mjs';
import { deleteCenterLineWithUndo } from '../../src/transform/centerLineOps.js';
import { convergeProject, rnd } from './hAnchorCoverageProbe.mjs';

const isMain = !!process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('hReproMeasure.mjs');

const short = (id) => (id ? id.slice(0, 8) : null);

/** 対象階の状態ダンプ（梁芯・梁・柱数・除外キー）。 */
export function dumpFloor(graph, project) {
  const isV = (cl) => cl.centerLineType === CenterLineType.VERTICAL;
  const beamAxes = graph.centerLines.filter(cl => centerLineKind(cl) === 'beam').map(cl => ({
    id: short(cl.id), dir: isV(cl) ? 'V' : 'H', value: rnd(cl.effectiveValue),
    extentLo: rnd(cl.extentLo), extentHi: rnd(cl.extentHi), origin: cl.beamAxisOrigin ?? null,
    extentRefLo: !!cl.extentLoRef, extentRefHi: !!cl.extentHiRef,
  })).sort((a, b) => (a.dir + a.value).localeCompare(b.dir + b.value, 'en', { numeric: true }));
  const beams = graph.beams.map(b => ({
    role: b.role ?? null, dir: b.isVertical ? 'V' : 'H', axis: rnd(b.axisValue),
    lo: rnd(Math.min(b.clStart.effectiveValue, b.clEnd.effectiveValue)),
    hi: rnd(Math.max(b.clStart.effectiveValue, b.clEnd.effectiveValue)),
    axisCL: short(b.axisCL?.id), axisKind: b.axisCL ? centerLineKind(b.axisCL) : null,
  })).sort((a, b) => `${a.role}${a.dir}${a.axis}${a.lo}`.localeCompare(`${b.role}${b.dir}${b.axis}${b.lo}`, 'en', { numeric: true }));
  const roleCount = {};
  for (const b of beams) roleCount[b.role] = (roleCount[b.role] ?? 0) + 1;
  const colRoleCount = {};
  for (const c of graph.columns) colRoleCount[c.role ?? 'null'] = (colRoleCount[c.role ?? 'null'] ?? 0) + 1;
  return {
    structure: effectiveStructure(graph, project),
    excludedWallBeamAxes: [...graph.excludedWallBeamAxes].sort(),
    beamAxes, beams, roleCount, beamTotal: beams.length, columnTotal: graph.columns.length, colRoleCount,
  };
}

/** 梁芯 beamAxes のうち座標 (dir,value) のものと、その梁芯を軸とする梁・柱を抜き出す（短い要約用）。 */
export function atCoord(dump, dir, value) {
  return {
    axes: dump.beamAxes.filter(a => a.dir === dir && Math.abs(a.value - value) < 1),
    beams: dump.beams.filter(b => b.dir === dir && Math.abs(b.axis - value) < 1),
  };
}

/** 全階（＋在来木造の屋根）を1 sweep だけ再計算する（収束判定は見ない）。 */
async function onePass(project) {
  await sweepUntilConverged(project, 'desc', 1);
}

if (isMain) {
  const args = process.argv.slice(2);
  const src = args[0], floorName = args[1];
  const doDelete = args.includes('--delete');
  const outIdx = args.indexOf('--out');
  const outPath = outIdx >= 0 ? args[outIdx + 1] : null;
  const uiIdx = args.indexOf('--user-index');
  const userIndex = uiIdx >= 0 ? Number(args[uiIdx + 1]) : 0;
  if (!src || !floorName) { console.error('usage: hReproMeasure.mjs <in.stq> <floor> [--delete] [--user-index N] [--out json]'); process.exit(1); }

  const { project } = loadDocument(src);
  const plane = project.planes.find(p => p.name === floorName);
  if (!plane) { console.error(`階が無い: ${floorName}`); process.exit(1); }
  const graph = project.graphMap.get(plane.id);
  const conv = await convergeProject(project);
  const out = { src, floor: floorName, convergedSweeps: conv, afterConverge: dumpFloor(graph, project) };
  const users = graph.centerLines.filter(cl => centerLineKind(cl) === 'beam' && cl.beamAxisOrigin === 'user');
  out.userAxes = users.map(cl => ({ id: short(cl.id), dir: cl.centerLineType === CenterLineType.VERTICAL ? 'V' : 'H', value: rnd(cl.effectiveValue), extentLo: rnd(cl.extentLo), extentHi: rnd(cl.extentHi) }));

  if (doDelete) {
    const target = users[userIndex];
    if (!target) { console.error('由来 USER の梁芯が無い'); process.exit(1); }
    const dir = target.centerLineType === CenterLineType.VERTICAL ? 'V' : 'H';
    const value = target.effectiveValue;
    out.deleteTarget = { id: short(target.id), dir, value: rnd(value) };
    floorSwapManager.peek = async (p) => project.graphMap.get(p.id) ?? null;
    project.activePlaneId = plane.id;
    const res = await deleteCenterLineWithUndo(graph, project, target, {
      saveFloorFn: async () => {},
      peek: async (p) => project.graphMap.get(p.id) ?? null,
      peekBelow: async (p) => project.graphMap.get(p.id) ?? null,
    });
    out.deleteResult = res;
    out.afterDelete = dumpFloor(graph, project);
    out.passes = [];
    for (let i = 1; i <= 3; i++) {
      await onePass(project);
      out.passes.push(dumpFloor(graph, project));
    }
    out.coordAfterPass3 = atCoord(out.passes[2], dir, value);
    out.coordBefore = atCoord(out.afterConverge, dir, value);
  }
  if (outPath) fs.writeFileSync(outPath, JSON.stringify(out, null, 1));
  const brief = (d) => ({ structure: d.structure, roleCount: d.roleCount, columns: d.columnTotal, excluded: d.excludedWallBeamAxes, beamAxes: d.beamAxes.length });
  console.log(JSON.stringify({
    src, floor: floorName, convergedSweeps: conv, userAxes: out.userAxes,
    afterConverge: brief(out.afterConverge),
    ...(doDelete ? { deleteTarget: out.deleteTarget, deleteResult: out.deleteResult, afterDelete: brief(out.afterDelete), passes: out.passes.map(brief), coordBefore: out.coordBefore, coordAfterPass3: out.coordAfterPass3 } : {}),
  }, null, 1));
}
