// 建具モード 平面記号（renderer/OpeningsLayer.jsx）の Konva props を直接評価するprobe。
// ステップ11「作図P2＝建具の平面記号の純関数化」の before/after 検証に使う
// （openingProbe.mjs / sectionProbe.mjs と同じ実行形式・ヘッダ・終了コード規約を踏襲）。
//
// 【通常モード】文書の全planeについて、graph.openings 全件を LOD 3段（SCHEMATIC/STANDARD/DETAIL）
// それぞれで OpeningsLayer に通し、Konva props（tag+props。イベントハンドラ・key・children除外、
// props キー sort、数値は丸めない。正規化は「閉じていない Line の fill を無視」の1点のみ）を
// 安定キー（plane名:isVertical:round(axisValue):round(coord1):opening id）で束ねてJSONへ出す。
//
// 【--sweep】文書ごとに 外壁/内壁 × 縦/横 の実在建具を最大4件選び、IMPLEMENTED_MECHANISMS全機構
// （FRAME_ONLYはfixtureType WF/SF/SSFの3通りに展開）＋未実装1件（IMPLEMENTED_MECHANISMSから
// 一時的に1機構を外して代用。製品側のSetを実行中だけ操作し、必ず元へ戻す）＋entry null
// （カタログに無いsubType）× hingeSide±1 × swingSide±1 × frameDepth{0,50} × LOD3 を
// runInAction で opening を上書きしながらダンプする（各openingの元の値へ必ず戻す）。
//
// 実データが踏まない機構・組合せ（未実装機構・entry null・宙吊りhingeSide等）はsweepで補う——
// 通常モードの「実データ」ダンプだけでは検出できない退行がある。
//
// 使い方: node --import ./scripts/testSetup.mjs --import ./scripts/probe/openingPlanSymbolJsxSetup.mjs
//   scripts/probe/openingPlanSymbolProbe.mjs <入力.stq> [出力.json] [--sweep]
import fs from 'node:fs';
import { runInAction } from 'mobx';
import { loadDocument } from './loadDoc.mjs';
import { buildHostWallByOpening } from '../../src/openings/openingGeometry.js';
import {
  IMPLEMENTED_MECHANISMS, OpeningMechanism, openingSubTypeBuiltinList,
} from '../../src/openings/openingCatalog.js';
import { LodLevel, resolveLineWeightsPx, DEFAULT_PX_PER_MM } from '../../src/viewport.js';

const USAGE = '使い方: openingPlanSymbolProbe.mjs <入力.stq> [出力.json] [--sweep]';

const args = process.argv.slice(2);
const src = args.find(a => !a.startsWith('--'));
const outFile = args.filter(a => !a.startsWith('--'))[1] ?? null;
const sweep = args.includes('--sweep');
if (!src) {
  console.error(USAGE);
  process.exit(2);
}
if (!fs.existsSync(src)) {
  console.error(`入力.stqが見つかりません: ${src}`);
  process.exit(2);
}

// OpeningsLayer.jsx は .jsx（JSX構文）のため、openingPlanSymbolJsxHooks.mjs（node --import
// ./scripts/probe/openingPlanSymbolJsxSetup.mjs で登録）を経由しないと読めない。
const openingsLayerUrl = new URL('../../src/renderer/OpeningsLayer.jsx', import.meta.url);
let OpeningsLayer;
try {
  ({ OpeningsLayer } = await import(openingsLayerUrl.href));
} catch (e) {
  console.error('OpeningsLayer.jsx の読み込みに失敗しました。' +
    ' node --import ./scripts/testSetup.mjs --import ./scripts/probe/openingPlanSymbolJsxSetup.mjs' +
    ' で起動しているか確認してください。');
  throw e;
}

const LOD_LEVELS = [LodLevel.SCHEMATIC, LodLevel.STANDARD, LodLevel.DETAIL];
// scaleDenominator の閾値（viewport.js LOD_SCHEMATIC_DENOM=90 / LOD_DETAIL_DENOM=60）を跨がない
// 固定値。viewport固定スタブ——実際の Viewport クラス（localStorage依存）は使わず、
// OpeningsLayer が読む5フィールドだけを持つ素のオブジェクトを組む。
const LOD_DENOM = { [LodLevel.SCHEMATIC]: 120, [LodLevel.STANDARD]: 75, [LodLevel.DETAIL]: 40 };

function viewportFor(lodLevel) {
  const pxPerMmX = DEFAULT_PX_PER_MM;
  const scale = pxPerMmX / LOD_DENOM[lodLevel];
  return { scaleX: scale, scaleY: scale, lodLevel, lineWeightsPx: resolveLineWeightsPx(pxPerMmX), pxPerMmX };
}

const round = (v) => Math.round(v);

// 要素ツリー（Fragment/配列/false込み）を {tag, props} 列へ平らにする。
// イベントハンドラ（onXxx）・key・children は除外し、props キーは sort、数値は丸めない。
// 正規化は「閉じていない Line の fill を無視」の1点のみ（fillEnabled:false で無効化されている
// ため描画上意味を持たない差異を検出力に含めない）。
//
// 注記（QA指摘・ステップ11a再報告分）: ここで収集した props はキー自体を落とさない
// （`dash: undefined` のような明示的にundefined値を持つキーもオブジェクトには残る）が、
// before/after の突合せ（openingPlanSymbolDiff.mjs）は JSON.stringify で比較しており、
// JSON.stringify は値がundefinedのキーを出力から自動的に落とす。そのため「propに
// `dash`キー自体が存在しない（旧経路）」と「`dash:undefined`というキーがある（新経路。
// 例: `<Line dash={p.dash} .../>` でp.dashが未定義のとき）」はこのprobeでは区別できない
// ——検出力の既知の穴（両者は描画上・Konvaの実際のprops解決上も等価なため実害はない）。
function flattenNode(node, out) {
  if (node == null || node === false || node === true) return;
  if (Array.isArray(node)) { for (const c of node) flattenNode(c, out); return; }
  if (typeof node !== 'object') return;
  const { type, props } = node;
  // Fragment（automatic runtimeのFragmentはSymbol）・Group（構造上のラッパーのみ。中身を辿る）
  if (typeof type === 'symbol' || type === 'Group') {
    flattenNode(props?.children, out);
    return;
  }
  if (typeof type === 'string') {
    const clean = {};
    for (const k of Object.keys(props ?? {})) {
      if (k === 'children' || k === 'key') continue;
      if (/^on[A-Z]/.test(k)) continue; // イベントハンドラ
      clean[k] = props[k];
    }
    if (type === 'Line' && !clean.closed && Object.hasOwn(clean, 'fill')) delete clean.fill;
    const sorted = {};
    for (const k of Object.keys(clean).sort()) sorted[k] = clean[k];
    out.push({ tag: type, props: sorted });
    return;
  }
  // 想定外のtype（関数コンポーネント等）。OpeningsLayer.jsxはホスト要素とFragmentしか
  // 返さない想定だが、安全側でchildrenだけ辿って落とさない。
  flattenNode(props?.children, out);
}

// 1つのopeningの記号行を1件のitemへ（安定キー＝plane名:isVertical:round(axisValue):round(coord1):id）。
function dumpGraphAtLod(graph, viewport, planeName, hostByOpening) {
  const elements = OpeningsLayer({ graph, viewport }) ?? [];
  const items = graph.openings.map((opening, i) => {
    const el = elements[i];
    const host = hostByOpening.get(opening.id) ?? null;
    const axisValue = host ? round(host.axisValue) : null;
    const key = `${planeName}:${opening.isVertical}:${axisValue ?? 'NA'}:${round(opening.coord1)}:${opening.id}`;
    const rows = [];
    if (el) flattenNode(el.props?.children, rows);
    return { key, hostMissing: !host, rows };
  });
  items.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { openingCount: items.length, items };
}

function dumpPlane(graph, planeName) {
  const hostByOpening = buildHostWallByOpening(graph);
  const byLod = {};
  for (const lodLevel of LOD_LEVELS) {
    byLod[lodLevel] = dumpGraphAtLod(graph, viewportFor(lodLevel), planeName, hostByOpening);
  }
  return { openingCount: graph.openings.length, byLod };
}

// ================================================================
// --sweep
// ================================================================

// mechanism → 代表subType（openingSubTypeBuiltinList先頭一致。builtinカタログの並び順を
// 唯一の情報源にする——探索側で個別に決め直さない）。
function mechanismSubTypeMap() {
  const list = openingSubTypeBuiltinList();
  const map = new Map();
  for (const m of IMPLEMENTED_MECHANISMS) {
    const entry = list.find(e => e.mechanism === m);
    if (entry) map.set(m, { category: entry.category, subType: entry.key });
  }
  return map;
}

// 外壁/内壁 × 縦/横 の組合せを埋める実在建具（最大4件。文書が組合せを持たなければその分だけ減る）。
function selectSweepOpenings(project) {
  const wanted = [
    { ext: true, vertical: true }, { ext: true, vertical: false },
    { ext: false, vertical: true }, { ext: false, vertical: false },
  ];
  const picked = [];
  const usedIds = new Set();
  for (const w of wanted) {
    let found = null;
    for (const p of project.planes) {
      const graph = project.graphMap.get(p.id);
      if (!graph) continue;
      const hostByOpening = buildHostWallByOpening(graph);
      for (const opening of graph.openings) {
        if (usedIds.has(opening.id)) continue;
        const host = hostByOpening.get(opening.id);
        if (!host) continue;
        if (!!host.isExteriorWall !== w.ext || !!opening.isVertical !== w.vertical) continue;
        found = { plane: p, graph, opening, wallKind: w.ext ? 'ext' : 'int' };
        break;
      }
      if (found) break;
    }
    if (found) { picked.push(found); usedIds.add(found.opening.id); }
  }
  return picked;
}

function snapshotOpening(opening) {
  return {
    category: opening.category, subType: opening.subType, hingeSide: opening.hingeSide,
    swingSide: opening.swingSide, frameDepth: opening.frameDepth, fixtureType: opening.fixtureType,
  };
}

function restoreOpening(opening, snap) {
  runInAction(() => {
    opening.category = snap.category; opening.subType = snap.subType;
    opening.hingeSide = snap.hingeSide; opening.swingSide = snap.swingSide;
    opening.frameDepth = snap.frameDepth; opening.fixtureType = snap.fixtureType;
  });
}

const UNIMPLEMENTED_PROXY_MECHANISM = OpeningMechanism.PIVOT; // 一時的にIMPLEMENTEDから外して代用
const ENTRY_NULL_SUBTYPE = 'probeUnknownSubType';
const FRAME_ONLY_SYMBOLS = ['WF', 'SF', 'SSF'];
const HINGE_SIDES = [-1, 1];
const SWING_SIDES = [-1, 1];
const FRAME_DEPTHS = [0, 50];

// 1openingぶんの variant 列（{label, category, subType, fixtureType}）。
function buildVariants(mechSubType) {
  const variants = [];
  for (const [mechanism, { category, subType }] of mechSubType) {
    if (mechanism === OpeningMechanism.FRAME_ONLY) {
      for (const sym of FRAME_ONLY_SYMBOLS) {
        variants.push({ label: `frameOnly:${sym}`, category, subType, fixtureType: sym });
      }
      continue;
    }
    variants.push({ label: mechanism, category, subType, fixtureType: null });
  }
  const unimpl = mechSubType.get(UNIMPLEMENTED_PROXY_MECHANISM);
  variants.push({
    label: `unimplemented:${UNIMPLEMENTED_PROXY_MECHANISM}`,
    category: unimpl.category, subType: unimpl.subType, fixtureType: null,
    unimplementedMechanism: UNIMPLEMENTED_PROXY_MECHANISM,
  });
  variants.push({ label: 'entryNull', category: 'fitting', subType: ENTRY_NULL_SUBTYPE, fixtureType: null });
  return variants;
}

function runSweep(project) {
  const picked = selectSweepOpenings(project);
  const mechSubType = mechanismSubTypeMap();
  const variants = buildVariants(mechSubType);
  const items = [];
  let combosRun = 0;

  for (const { plane, graph, opening, wallKind } of picked) {
    const idx = graph.openings.indexOf(opening);
    const snap = snapshotOpening(opening);
    const baseKey = `${plane.name}:${wallKind}:${opening.isVertical ? 'V' : 'H'}:${opening.id}`;

    for (const variant of variants) {
      const removedMechanism = variant.unimplementedMechanism ?? null;
      if (removedMechanism) IMPLEMENTED_MECHANISMS.delete(removedMechanism);
      try {
        for (const hingeSide of HINGE_SIDES) {
          for (const swingSide of SWING_SIDES) {
            for (const frameDepth of FRAME_DEPTHS) {
              runInAction(() => {
                opening.category = variant.category;
                opening.subType = variant.subType;
                opening.hingeSide = hingeSide;
                opening.swingSide = swingSide;
                opening.frameDepth = frameDepth;
                opening.fixtureType = variant.fixtureType;
              });
              for (const lodLevel of LOD_LEVELS) {
                const elements = OpeningsLayer({ graph, viewport: viewportFor(lodLevel) }) ?? [];
                const el = elements[idx];
                const rows = [];
                if (el) flattenNode(el.props?.children, rows);
                const comboKey = `${baseKey}|${variant.label}|${hingeSide}|${swingSide}|${frameDepth}|${lodLevel}`;
                items.push({ comboKey, rows });
                combosRun += 1;
              }
            }
          }
        }
      } finally {
        if (removedMechanism) IMPLEMENTED_MECHANISMS.add(removedMechanism);
      }
    }
    restoreOpening(opening, snap);
  }

  items.sort((a, b) => (a.comboKey < b.comboKey ? -1 : a.comboKey > b.comboKey ? 1 : 0));
  return {
    openingsUsed: picked.map(p => `${p.plane.name}:${p.wallKind}:${p.opening.isVertical ? 'V' : 'H'}:${p.opening.id}`),
    variantLabels: variants.map(v => v.label),
    combosRun,
    items,
  };
}

// ================================================================

const t0 = performance.now();
const { project } = loadDocument(src);
const planesOut = {};
for (const p of project.planes) {
  const graph = project.graphMap.get(p.id);
  if (!graph) continue;
  planesOut[p.name] = dumpPlane(graph, p.name);
}
const result = { perf_ms: 0, planes: planesOut };
if (sweep) result.sweep = runSweep(project);
const t1 = performance.now();
result.perf_ms = Math.round((t1 - t0) * 100) / 100;

const totalOpenings = Object.values(planesOut).reduce((sum, d) => sum + d.openingCount, 0);
if (totalOpenings === 0) console.error(`警告: 建具が0件（記号ダンプを検証できない）: ${src}`);

if (outFile) fs.writeFileSync(outFile, JSON.stringify(result, null, 1));
console.log(JSON.stringify({
  perf_ms: result.perf_ms,
  totalOpenings,
  planes: Object.entries(planesOut).map(([name, d]) => ({ name, openingCount: d.openingCount })),
  sweep: result.sweep ? {
    openingsUsed: result.sweep.openingsUsed, variantCount: result.sweep.variantLabels.length,
    combosRun: result.sweep.combosRun,
  } : null,
}, null, 1));
