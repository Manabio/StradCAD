// 在来木造・折返し階段の隔て壁（resolveStairPartition）の実データ確認 probe（読み取り専用）。
// 各階・各階段について 種別・実効主構造・continuesAbove・descriptor（または null＋理由）を出し、
// 隔て壁の軸（レーン間中心線）上に中心線（通り芯・補助線を問わない）が実在するかを調べる
// （S2 の前提＝レーン間中心線は常に CL か、の確認）。
// 使い方: node --import ./scripts/testSetup.mjs scripts/probe/stairPartitionProbe.mjs [stqパス...]
//   既定: D:/tatsuya/Download/{moku2,moku4,moku5}.stq（無いファイルは飛ばす）
// 検出力確認用の環境変数: PROBE_FORCE_CONTINUES=1（continuesAbove を常に true にする）
// 【lint対象外】.mjs は eslint.config.js の対象外。
import fs from 'node:fs';
import path from 'node:path';
import { loadDocument } from './loadDoc.mjs';
import { StairType, CenterLineType } from '../../src/core.js';
import { effectiveStructure, isTraditionalWoodStructure } from '../../src/structural/structureRules.js';
import { floorHeightAbove } from '../../src/finish/stair/stairDimensions.js';
import { buildStairChains } from '../../src/finish/stair/stairChains.js';
import { uTurnSpans } from '../../src/finish/stair/stairClassify.js';
import { roomBounds } from '../../src/finish/gridCells.js';
import { resolveStairPartition } from '../../src/finish/stair/stairPartition.js';
import { generateStairPartitionWalls } from '../../src/finish/stair/stairPartitionWalls.js';

const DEFAULTS = ['moku2', 'moku4', 'moku5'].map(n => `D:/tatsuya/Download/${n}.stq`);
const files = process.argv.length > 2 ? process.argv.slice(2) : DEFAULTS;
const forceContinues = process.env.PROBE_FORCE_CONTINUES === '1';
const r1 = (v) => (typeof v === 'number' ? Math.round(v * 10) / 10 : v);

// 軸上（1mm 以内）の中心線を列挙する。通常 CL と構造 CL（struct）の両方を見る（stairUnderWalls.js getShape と同じ範囲）。
function centerLinesAt(graph, project, isVerticalWall, axisValue) {
  const want = isVerticalWall ? CenterLineType.VERTICAL : CenterLineType.HORIZONTAL;
  const found = [];
  const scan = (map, origin) => {
    for (const cl of map.values()) {
      if (cl.centerLineType !== want || !Number.isFinite(cl.value)) continue;
      if (Math.abs(cl.value - axisValue) <= 1) found.push(`${origin}:${cl.id}@${r1(cl.value)}(${cl.discipline ?? '-'})`);
    }
  };
  scan(graph.shapeMap, 'plane');
  if (graph._structGraph?.shapeMap && graph._structGraph.shapeMap !== graph.shapeMap) scan(graph._structGraph.shapeMap, 'struct');
  if (project.structGraph?.shapeMap && project.structGraph.shapeMap !== graph.shapeMap
    && project.structGraph.shapeMap !== graph._structGraph?.shapeMap) scan(project.structGraph.shapeMap, 'struct');
  return found;
}

let total = 0, wood = 0, nonNull = 0, withCL = 0, wallsMade = 0, expectedWalls = 0;
for (const file of files) {
  if (!fs.existsSync(file)) { console.log(`## ${file}: (無し・スキップ)`); continue; }
  const { project } = loadDocument(file);
  const planes = project.planes;
  const chains = buildStairChains(planes.map(p => ({ plane: p, graph: project.graphMap.get(p.id) })), project.structGraph);
  const continuesOf = new Map(); // `${planeId}:${stairId}` → 末尾でない
  for (const ch of chains) ch.members.forEach((m, i) => continuesOf.set(`${m.planeId}:${m.stairId}`, i < ch.members.length - 1));
  console.log(`## ${path.basename(file)}  planes=${planes.map(p => p.name).join(',')}  主構造=${project.structuralInfo?.mainStructure ?? '(未設定)'}`);

  for (const plane of planes) {
    const graph = project.graphMap.get(plane.id);
    // S2: 軸CL・端CL（lo/hi）が既存の分割線CLとして解決でき、隔て壁が2枚ずつ生成されるか。
    // 無ければ黙って生成されない設計のため、在来SWITCHBACKの数×2 と実際の枚数を突き合わせる。
    // 生成した壁は読み込んだメモリ上のグラフに足すだけ（保存しない）。確認後に取り除く。
    {
      const st = effectiveStructure(graph, project) ?? null;
      const nSw = isTraditionalWoodStructure(st) ? graph.stairs.filter(x => x.type === StairType.SWITCHBACK).length : 0;
      const made = generateStairPartitionWalls(graph, { structure: st, underEdges: [] });
      expectedWalls += nSw * 2; wallsMade += made.length;
      console.log(`  [${plane.name}] 隔て壁の生成: 期待 ${nSw * 2} 枚 / 実際 ${made.length} 枚${made.length === nSw * 2 ? '' : '  **不一致（CL未解決の階段あり）**'}`);
      for (const w of made) console.log(`      ${w.isVertical ? 'V' : 'H'} axis=${r1(w.axisCL.effectiveValue)} off=${w.axisOffset} span=[${r1(Math.min(w.coord1, w.coord2))},${r1(Math.max(w.coord1, w.coord2))}] dep=${w.backingDepth}`);
      made.forEach(w => graph.removeShape(w.id));
    }
    for (const stair of graph.stairs) {
      total++;
      const structure = effectiveStructure(graph, project) ?? null;
      const isWood = isTraditionalWoodStructure(structure);
      if (isWood && stair.type === StairType.SWITCHBACK) wood++;
      const continuesAbove = forceContinues ? true : (continuesOf.get(`${plane.id}:${stair.id}`) ?? false);
      const floorHeight = floorHeightAbove(project, plane);
      const head = `  [${plane.name}] ${stair.id} type=${stair.type} structure=${structure} 在来=${isWood} continuesAbove=${continuesAbove} fh=${floorHeight} sections=${JSON.stringify(stair.sections)} entryTurn=${stair.entryTurnSteps ?? 0}`;
      const p = resolveStairPartition(stair, graph, { structure, continuesAbove, floorHeight });
      if (!p) {
        let reason = !isWood ? '在来木造でない' : stair.type !== StairType.SWITCHBACK ? `type=${stair.type}（SWITCHBACKのみ）` : null;
        if (!reason) {
          const b = roomBounds(stair.cells, graph);
          reason = uTurnSpans(stair, graph, b) ? '不明' : 'uTurnSpans=null（回転部/レーンが取れない）';
        }
        console.log(`${head}\n      -> null: ${reason}`);
        continue;
      }
      nonNull++;
      const cls = centerLinesAt(graph, project, p.isVertical, p.axisValue);
      if (cls.length) withCL++;
      const top = p.top.kind === 'full' ? 'full' : `slope(entry=${r1(p.top.zAtEntryEnd)}, landing=${r1(p.top.zAtLandingEnd)})`;
      console.log(`${head}\n      -> vertical=${p.isVertical} axis=${r1(p.axisValue)} span=[${r1(p.lo)},${r1(p.hi)}] len=${r1(p.hi - p.lo)} top=${top}`
        + `\n         中心線@axis: ${cls.length ? cls.join(' ') : '**無し**'}`);
    }
  }
}
console.log(`\n合計 階段=${total} / 在来SWITCHBACK=${wood} / descriptor有=${nonNull} / うち軸上に中心線あり=${withCL}`);
console.log(`隔て壁 期待=${expectedWalls} 実際=${wallsMade}`);
