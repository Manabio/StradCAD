// 建具カタログ（openings/openingCatalog.js）変更の実データ検証probe。sectionProbe.mjs /
// sectionDiff.mjs と同じ実行形式・ヘッダ・終了コード規約・出力形・diffの表示形を踏襲する。
//
// 【golden系との位置づけ】既存の golden JSON（golden13/struct-*.json・elevfig-*.json 等）は
// 建具のsubType/fixtureType/mechanismを一切含まない（openingIdの参照のみ・実測で確認済み）ため
// 検出力ゼロ——本probeが建具カタログ変更に対する唯一の実データ検証。
//
// 通す関数列（App.jsx collectOpeningNumbersAllFloors と同じ「建具モード突入」境界を再現）:
//   project.planes（採用階のみ・検討/屋根は対象外）を順に collectFloorOpeningGroups →
//   建物全体で1回 assignOpeningNumbers → applyOpeningTags。
// 壁再生成・構造収束は不要（採番・カタログ解決・姿図は graph.openings と project.openingNumberIndex
// だけで完結し、壁・構造に依存しない）。
//
// 出力（階ごと。id を含まない安定キーで sort。opening 1行 = ':' 区切り）:
//   category:subType:resolved:mechanism:entry.defaultWidth:entry.defaultHeight:
//   round(width):round(effectiveHeight):sillHeight:fixtureSymbol:openingTag:elevPrims
//   （elevPrims = buildOpeningElevation の type別プリミティブ件数を "type=n" で連結。座標は持たない）
// 階ごとに unresolvedSubTypeKeys（`${category}:${subType}` で findCatalogEntry が null のもの）・
// openingCount、全体に perf_ms。
//
// 使い方: node --import ./scripts/testSetup.mjs scripts/probe/openingProbe.mjs <入力.stq> [出力.json]
import fs from 'node:fs';
import { runInAction } from 'mobx';
import { loadDocument } from './loadDoc.mjs';
import {
  collectFloorOpeningGroups, assignOpeningNumbers, applyOpeningTags, openingTagOf,
  effectiveHeight, fixtureSymbolOf,
} from '../../src/openings/openingNumbering.js';
import { findCatalogEntry } from '../../src/openings/openingCatalog.js';
import { buildOpeningElevation } from '../../src/openings/openingElevationFigure.js';

const src = process.argv[2];
const outFile = process.argv[3] ?? null;
if (!src) {
  console.error('使い方: node --import ./scripts/testSetup.mjs scripts/probe/openingProbe.mjs <入力.stq> [出力.json]');
  process.exit(1);
}

const { project } = loadDocument(src);

const round = (v) => Math.round(v);

function dumpPlane(graph, unresolvedAll) {
  const unresolved = new Set();
  const lines = graph.openings.map(o => {
    const entry = findCatalogEntry(o.category, o.subType);
    if (!entry) { const key = `${o.category}:${o.subType}`; unresolved.add(key); unresolvedAll.add(key); }
    const tag = openingTagOf(o, project);
    const prims = buildOpeningElevation(o, { tag, entry, includeDims: false });
    const primCounts = new Map();
    for (const p of prims) primCounts.set(p.type, (primCounts.get(p.type) ?? 0) + 1);
    const elevPrims = [...primCounts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([t, n]) => `${t}=${n}`).join(',');
    return [
      o.category, o.subType, entry != null, entry?.mechanism ?? null,
      entry?.defaultWidth ?? null, entry?.defaultHeight ?? null,
      round(o.width), round(effectiveHeight(o)), o.sillHeight ?? null,
      fixtureSymbolOf(o), tag ?? null, elevPrims,
    ].join(':');
  }).sort();

  return { openingCount: lines.length, openings: lines, unresolvedSubTypeKeys: [...unresolved].sort() };
}

const t0 = performance.now();

// パス1（各階、採用階のみ＝App.jsx collectOpeningNumbersAllFloorsと同じ範囲）: signatureを収集。
runInAction(() => project.clearOpeningNumberIndex());
for (const p of project.planes) {
  const graph = project.graphMap.get(p.id);
  if (!graph) continue;
  runInAction(() => collectFloorOpeningGroups(graph, project));
}
// パス2（建物全体で1回）: 記号別採番を確定。
runInAction(() => applyOpeningTags(project, assignOpeningNumbers(project)));

const unresolvedAll = new Set();
const out = {};
for (const p of project.planes) {
  const graph = project.graphMap.get(p.id);
  if (!graph) continue;
  out[p.name] = dumpPlane(graph, unresolvedAll);
}

const t1 = performance.now();

const totalOpenings = Object.values(out).reduce((sum, d) => sum + d.openingCount, 0);
if (totalOpenings === 0) console.error(`警告: 建具が0件（採番・カタログ解決を検証できない）: ${src}`);

const result = { perf_ms: Math.round((t1 - t0) * 100) / 100, planes: out };
if (outFile) fs.writeFileSync(outFile, JSON.stringify(result, null, 1));
console.log(JSON.stringify({
  perf_ms: result.perf_ms,
  totalOpenings,
  unresolvedSubTypeKeys: [...unresolvedAll].sort(),
  summary: Object.entries(out).map(([name, d]) => ({
    name, openingCount: d.openingCount, unresolvedSubTypeKeys: d.unresolvedSubTypeKeys,
  })),
}, null, 1));
