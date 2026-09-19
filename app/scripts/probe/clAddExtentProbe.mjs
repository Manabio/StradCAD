// transform/centerLineOps.js addCenterLineFromDialog の追加extent（ステップ3: center/aux/beamの
// 直交端部候補選択を orthoAnchorCandidates 経由へ移行）を実データで確認するprobe
// （調査・回帰用。製品コードからは参照しない）。
//
// 各階・各方向（vertical/horizontal）について、自軸方向の隣接通り芯ペアの中点を worldCoord、
// 直交方向の隣接通り芯ペアを frac=[0.25, 0.5, 0.75] で内分した3点を perpCoord として、
// center/aux/beam の3種別で addCenterLineFromDialog を試行→結果（done/toast・extentLo/Hi・
// ref先の種別）を記録→undoManager.undo() で元に戻す、を全組み合わせ繰り返す。グラフは変更しない
// （各試行の直後に必ずundoする。struct kindは追加extentの直交端部候補走査を持たないため対象外）。
//
// perpCoordをfrac=0.5（中点）固定にしていた旧版は、910モジュール（通り芯が910の倍数間隔で並ぶ
// 木造データ）では梁芯が常に中点より lo 側（perpCoordより小さい値）に来てしまい、
// findBracketingCLs（d<=0→lo, d>0→hi）の構造上 lo 側の差分しか踏めなかった（QA指摘）。
// frac を複数取ることで hi 側も梁芯が perpCoord を跨いで候補になる配置を踏む。
//
// 使い方: node --import ./scripts/testSetup.mjs scripts/probe/clAddExtentProbe.mjs [入力.stq]
import { loadDocument } from './loadDoc.mjs';
import { CenterLineType } from '../../src/core/constants.js';
import { centerLineKind } from '../../src/core/centerLine.js';
import { addCenterLineFromDialog } from '../../src/transform/centerLineOps.js';
import { undoManager } from '../../src/undoManager.js';

const src = process.argv[2] ?? 'D:/tatsuya/Download/moku2-5.stq';
const { project } = loadDocument(src);
const viewport = { scaleDenominator: 100 };

function adjacentPairs(sortedValues) {
  const pairs = [];
  for (let i = 0; i + 1 < sortedValues.length; i++) pairs.push([sortedValues[i], sortedValues[i + 1]]);
  return pairs;
}

// extentLoRef/extentHiRef（{clId}|{wallId}|null）をJSON化しやすい形へ落とす。resolvedKind は
// cl._extentLoCL/_extentHiCL（解決済み参照キャッシュ）から centerLineKind を引いたもの
// （相手が project.structGraph 側の通り芯でも graph.shapeMap 探索なしで種別を確認できる）。
function describeRef(ref, resolvedKind) {
  if (!ref) return null;
  if (ref.wallId) return { type: 'wall', wallId: ref.wallId };
  return { type: 'cl', clId: ref.clId, kind: resolvedKind ?? null };
}

const results = [];
for (const plane of project.planes) {
  const graph = project.graphMap.get(plane.id);
  if (!graph) continue;

  for (const type of ['vertical', 'horizontal']) {
    const clType = type === 'vertical' ? CenterLineType.VERTICAL : CenterLineType.HORIZONTAL;
    const ownGrid  = (type === 'vertical' ? graph.gridXs : graph.gridYs).map(cl => cl.value).sort((a, b) => a - b);
    const perpGrid = (type === 'vertical' ? graph.gridYs : graph.gridXs).map(cl => cl.value).sort((a, b) => a - b);
    const ownPairs  = adjacentPairs(ownGrid);
    const perpPairs = adjacentPairs(perpGrid);
    if (ownPairs.length === 0 || perpPairs.length === 0) continue; // 直交通り芯の隣接ペアが無い階・軸はスキップ

    for (const [oa, ob] of ownPairs) {
      const worldCoord = (oa + ob) / 2;
      for (const [pa, pb] of perpPairs) {
        for (const frac of [0.25, 0.5, 0.75]) {
          const perpCoord = pa + (pb - pa) * frac;
          for (const kind of ['center', 'aux', 'beam']) {
            const beforeTop = undoManager.peekUndo();
            const result = addCenterLineFromDialog(
              graph, project,
              { clDialog: { type, worldCoord, perpCoord }, value: worldCoord, kind, refId: null, refOffset: 0 },
              viewport,
            );

            let added = null;
            if (result.done) {
              added = graph.centerLines.find(cl =>
                cl.centerLineType === clType && Math.abs(cl.value - worldCoord) < 1 && centerLineKind(cl) === kind);
            }

            results.push({
              plane: plane.name, type, kind, frac,
              worldCoord: Math.round(worldCoord), perpCoord: Math.round(perpCoord),
              done: result.done, toast: result.toast,
              extentLo: added?.extentLo == null ? null : Math.round(added.extentLo),
              extentHi: added?.extentHi == null ? null : Math.round(added.extentHi),
              extentLoRef: added ? describeRef(added.extentLoRef, added._extentLoCL ? centerLineKind(added._extentLoCL) : null) : null,
              extentHiRef: added ? describeRef(added.extentHiRef, added._extentHiCL ? centerLineKind(added._extentHiCL) : null) : null,
            });

            // グラフを汚さないよう必ず元に戻す（beam kindはグラフスナップショット方式のUndo、
            // それ以外は単発removeCenterLineのUndo——どちらもundoManager.undo()で確実に戻る）。
            if (undoManager.peekUndo() !== beforeTop) undoManager.undo();
          }
        }
      }
    }
  }
}

console.log(JSON.stringify(results, null, 2));
