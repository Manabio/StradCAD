// 在来木造の土台（role:'sill'、記号SL。基礎伏図＝最下階専用。2026-09-18仕様）の実データ確認用probe。
// 最下階（基礎伏図）の土台本数を「壁線由来のみ」「基礎梁由来のみ」「両方（同spanKey）」に仕分け、
// 土台はあるが基礎梁が無い区間（＝基礎梁を壁線へ移す次ステップの材料）を座標で列挙する。
// woodTieBeamProbe.mjs を骨格に、収束（sweepがchanged=[]になる）・冪等（もう1回回しても本数不変）を確認する。
// 非在来（framingを持たない主構造）は土台が1本も生成されないこと自体を確認する。
//
// 使い方: node --import ./scripts/testSetup.mjs scripts/probe/woodSillProbe.mjs [入力.stq]
import { loadDocument } from './loadDoc.mjs';
import { floorSwapManager } from '../../src/storage/FloorSwapManager.js';
import { recomputeStructuralForGraph } from '../../src/structural/structuralRecompute.js';
import { isTraditionalWoodStructure, effectiveStructure } from '../../src/structural/structureRules.js';
import { spanKey } from '../../src/core.js';
import { selfWallSegments } from '../../src/structural/wallBeamAxes.js';
import { wallLineThroughRuns } from '../../src/structural/woodAutoFill.js';
import { mergeWallIntervals } from '../../src/structural/woodFraming.js';
import { sweepUntilConverged } from './sweepOrder.mjs';

const src = process.argv[2] ?? 'D:/tatsuya/Download/moku4.stq';
const { project } = loadDocument(src);
// loadDoc.mjs は実IDBを使わないインメモリ復元のため、非アクティブ階のpeekはgraphMapから直接返す
// （woodTieBeamProbe.mjs等と同じ差し替え）。
floorSwapManager.peek = async (plane) => project.graphMap.get(plane.id) ?? null;

console.log(`=== ${src} ===`);
console.log('主構造:', project.structuralInfo.mainStructure);

// 冪等収束チェック（他probeと同じ規律。在来木造の収束期待はsweep4以内——2026-09-18裁定で3から
// 改定。woodTieBeamProbe.mjsと同じ根拠——3h-2の点源に床梁を加えたことで3階またぎの連鎖が成立し、
// 1スイープでは1段ずつしか伝播しない。本probeは元々MAX_SWEEPS自体を上限として直接OK判定に使って
// いた＝実測sweep4でちょうど通るだけの余裕ゼロだったため、超過を検知できるよう5へ引き上げる）。
// 【小屋伏図にも梁・柱ルールを適用する計画のステップ7・R-5是正】本番の反映パス
// （reflectStructuralToOtherFloors）と同じ並び（在来なら降順・屋根が先頭）で回す（sweepOrder.mjs）。
// 土台（role:'sill'）自体は最下階（基礎伏図）専用で屋根には生成されないが、収束判定・スイープ回数は
// 屋根込みの本番順で行う必要がある。
const MAX_SWEEPS = 5;
const convergedAt = await sweepUntilConverged(project, 'desc', MAX_SWEEPS,
  (i, changedPlanes) => console.log(`sweep${i}: changed=[${changedPlanes.join(',')}]`));

// 最下階（基礎伏図）だけが対象（role:'sill'は最下階専用）。
const lowest = project.planes[0];
const g0 = project.graphMap.get(lowest.id);
const lowestIsWood = isTraditionalWoodStructure(effectiveStructure(g0, project));
console.log(`--- ${lowest.name}（基礎伏図。実効主構造=${effectiveStructure(g0, project)}）の土台（role:'sill'）本数 ---`);

const sills = g0.beams.filter(b => b.role === 'sill');
const foundations = g0.beams.filter(b => b.role === 'foundation');
const foundationKeys = new Set(foundations.map(b => spanKey(b.axisCL, b.clStart, b.clEnd)));

function coordsOf(b) {
  return {
    isVertical: b.isVertical, axis: b.axisValue,
    lo: Math.min(b.clStart.effectiveValue, b.clEnd.effectiveValue),
    hi: Math.max(b.clStart.effectiveValue, b.clEnd.effectiveValue),
  };
}

let both = 0;
const sillOnlyList = [];
for (const b of sills) {
  const key = spanKey(b.axisCL, b.clStart, b.clEnd);
  if (foundationKeys.has(key)) both++; else sillOnlyList.push(coordsOf(b));
}
console.log(`土台合計: ${sills.length}本（基礎梁と同位置=${both}本／壁線のみ（基礎梁なし）=${sillOnlyList.length}本）`);
console.log(`基礎梁合計: ${foundations.length}本`);

console.log('--- 土台はあるが基礎梁が無い区間（次ステップ「基礎梁を壁線へ移す」の材料） ---');
const sorted = [...sillOnlyList].sort((a, b) =>
  (a.isVertical === b.isVertical ? a.axis - b.axis : (a.isVertical ? 1 : -1)));
for (const c of sorted) {
  console.log(`${c.isVertical ? 'V' : 'H'} ${c.isVertical ? 'x' : 'y'}=${c.axis} [${c.lo}..${c.hi}]`);
}
if (sorted.length === 0) console.log('（無し）');

// 2026-09-18裁定「1階の土台が同軸で重複」修正の確認: 同軸（isVertical・axis丸め一致）で区間が
// 重なる（内包含む）土台の組を数える。0件であることを4文書で確認する（候補源(a)壁線run優先＋
// 候補源(b)基礎梁スパンの差し引きが効いていれば、同軸の土台どうしは重ならないはず）。
console.log('--- 同軸で区間が重なる土台の件数（0件が期待値） ---');
const sillByAxis = new Map();
for (const c of sills.map(coordsOf)) {
  const key = `${c.isVertical}:${Math.round(c.axis)}`;
  if (!sillByAxis.has(key)) sillByAxis.set(key, []);
  sillByAxis.get(key).push(c);
}
let overlapCount = 0;
for (const [key, arr] of sillByAxis) {
  for (let i = 0; i < arr.length; i++) {
    for (let j = i + 1; j < arr.length; j++) {
      const overlap = Math.min(arr[i].hi, arr[j].hi) - Math.max(arr[i].lo, arr[j].lo);
      if (overlap > 0) { overlapCount++; console.log(`重複: ${key} [${arr[i].lo}..${arr[i].hi}] <-> [${arr[j].lo}..${arr[j].hi}]`); }
    }
  }
}
console.log(`同軸重複件数: ${overlapCount}`);

// 土台の総延長が「壁線through-run∪基礎梁スパン」の和集合の延長と一致することを確認する
// （差し引きが正しく効いていれば、土台は隙間なく・重複なくその和集合をちょうど覆うはず）。
console.log('--- 土台の総延長 vs 壁線∪基礎梁の和集合の延長 ---');
const wallRunsByAxisProbe = new Map();
for (const line of wallLineThroughRuns(selfWallSegments(g0))) {
  const key = `${line.isVertical}:${Math.round(line.coord)}`;
  if (!wallRunsByAxisProbe.has(key)) wallRunsByAxisProbe.set(key, []);
  for (const run of line.runs) wallRunsByAxisProbe.get(key).push({ lo: run.lo, hi: run.hi });
}
for (const f of foundations) {
  const c = coordsOf(f);
  const key = `${c.isVertical}:${Math.round(c.axis)}`;
  if (!wallRunsByAxisProbe.has(key)) wallRunsByAxisProbe.set(key, []);
  wallRunsByAxisProbe.get(key).push({ lo: c.lo, hi: c.hi });
}
let expectedTotal = 0;
for (const [, intervals] of wallRunsByAxisProbe) {
  for (const iv of mergeWallIntervals(intervals)) expectedTotal += iv.hi - iv.lo;
}
let sillTotal = 0;
for (const c of sills.map(coordsOf)) sillTotal += c.hi - c.lo;
const lengthDiff = Math.round((sillTotal - expectedTotal) * 100) / 100;
console.log(`土台総延長=${Math.round(sillTotal)}mm  壁線∪基礎梁の和集合の延長=${Math.round(expectedTotal)}mm  差=${lengthDiff}mm`);

// 冪等性の再確認: もう一度回しても土台本数が変わらないこと（作って→撤去のチャーンが無いこと）。
const beforeExtra = sills.length;
await recomputeStructuralForGraph(g0, project, g0.structureOverride ?? project.structuralInfo.mainStructure);
const afterExtra = g0.beams.filter(b => b.role === 'sill').length;
const stable = beforeExtra === afterExtra;

if (!lowestIsWood) {
  if (sills.length === 0) {
    console.log('OK: 非在来（最下階は土台が1本も生成されない）');
  } else {
    console.log('NG: 非在来なのに土台が生成されている');
    process.exitCode = 1;
  }
} else if (overlapCount > 0) {
  console.log(`NG: 同軸で区間が重なる土台がある（${overlapCount}件）`);
  process.exitCode = 1;
} else if (Math.abs(lengthDiff) > 1) {
  console.log(`NG: 土台総延長が壁線∪基礎梁の和集合と一致しない（差=${lengthDiff}mm）`);
  process.exitCode = 1;
} else if (convergedAt != null && stable) {
  console.log(`OK: 収束（sweep${convergedAt}で changed=[]）かつ土台本数が安定・同軸重複0件・総延長一致`);
} else if (convergedAt == null) {
  console.log(`NG: 収束しない（sweep${MAX_SWEEPS}までchangedの階がある）`);
  process.exitCode = 1;
} else {
  console.log('NG: 土台本数が再計算のたびに変わる（チャーン）');
  process.exitCode = 1;
}
