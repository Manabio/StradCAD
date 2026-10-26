// S0: 同座標の追加の可否の総当り（直交方向の位置つき）。clCoexistProbe.mjs は直交位置が perpCoord:0 の
// 1点だけで、梁芯の extent（直交する通り芯で挟んだ範囲）しだいで変わる抜け道を検出できないため、
// 直交する通り芯の隣り合う中点ごと（＋両外側＋0）にも試す。
// 各階の既存CLの座標（V/H）ごとに kind=struct/center/aux/beam を addCenterLineFromDialog で試行→undo。
// struct は直交位置に依存しない（extent を持たない）ので座標ごと1回だけ（perp='-'）。
// 出力は id を含めない: {header, records:[{plane,structure,type,coord,kindsAt,perp,kind,done,toast}]}
// 使い方: node --import ./scripts/testSetup.mjs scripts/probe/s0CoexistPerpProbe.mjs <入力.stq> [出力.json]
import { runInAction } from 'mobx';
import { openDoc, planeHeader, writeOut, coordGroups, perpPositions } from './s0Common.mjs';
import { centerLineKind } from '../../src/core/centerLine.js';
import { undoManager } from '../../src/undoManager.js';
import { addCenterLineFromDialog } from '../../src/transform/centerLineOps.js';

const project = openDoc(process.argv[2]);
const header = planeHeader(project);
const viewport = { scaleDenominator: 100 };
const noopSaveFloorFn = async () => {};
const records = [];
const original = project.activePlaneId;

for (const [i, plane] of project.planes.entries()) {
  const graph = project.graphMap.get(plane.id);
  if (!graph) continue;
  runInAction(() => { project.activePlaneId = plane.id; });
  for (const g of coordGroups(graph)) {
    const kindsAt = [...new Set(g.cls.map(centerLineKind))].sort();
    const perps = perpPositions(graph, g.type);
    for (const kind of ['struct', 'center', 'aux', 'beam']) {
      for (const perp of (kind === 'struct' ? [null] : perps)) {
        const beforeTop = undoManager.peekUndo();
        const r = await addCenterLineFromDialog(
          graph, project,
          { clDialog: { type: g.type, worldCoord: g.value, perpCoord: perp ?? 0 }, value: g.value, kind, refId: null, refOffset: 0 },
          viewport, { saveFloorFn: noopSaveFloorFn });
        records.push({
          plane: plane.name, structure: header[i].effectiveStructure, type: g.type, coord: g.coord, kindsAt,
          perp: perp ?? '-', kind, done: r.done, toast: r.toast,
        });
        if (undoManager.peekUndo() !== beforeTop) undoManager.undo();
      }
    }
  }
}
runInAction(() => { project.activePlaneId = original; });
writeOut(process.argv[3] ?? null, { header, records });
