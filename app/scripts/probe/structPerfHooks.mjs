// 構造再計算の高速化検証（ステップ0: golden採取用ハーネス）のロードフック本体。
// structPerfSetup.mjs から node:module の register() で登録される。製品ソースは一切書き換えず、
// Node へ読み込む瞬間のソース文字列だけを差し替える。
//   storage/db.js の saveFloor/loadFloor をメモリ上の Map へ（IDB 抜きで本番の反映パスをそのまま動かす）
//   FloorSwapManager.peek・structural/structuralRecompute.js recomputeStructuralForGraph に
//   回数・所要時間の計測を仕込む
// 試作（プロトタイプ）段階で検討した高速化案（フットプリント索引のキャッシュ化・peek結果の使い回し等）は
// 意図的に移植しない——ステップ0の目的は「現行コードの挙動をそのまま固定したgoldenを採る」ことのみで、
// 製品コードの挙動を変える差し込みは1つも含めない（試作の差し込み部分はPROTOという環境変数で
// 分岐していたが、本ファイルには存在しない）。
//
// 使い方: 単体では効果を持たない。structPerfSetup.mjs を node --import で先に登録してから使う。
// 実データが踏まない経路: 本フックはstorage層・計測点のみを差し替えるため、経路自体は
// structPerfEntry.mjs/structPerfScenario.mjs 側のコメントを参照。
// ステップB-1: メモリ版saveFloorに差し替えても floorWriteGeneration.js の世代は本物のdb.jsと同じく
// 進む（差し替え後のsaveFloor内でnoteFloorWriteを呼ぶ）——解決コンテキスト（後続ステップB）の
// 鮮度判定がprobe上でも本番同型に検証できるようにするため。

function must(src, from, to, label) {
  if (!src.includes(from)) throw new Error(`[structPerfHooks] 置換対象が見つからない: ${label}`);
  return src.replace(from, to);
}

export async function load(url, context, nextLoad) {
  const r = await nextLoad(url, context);
  if (!url.includes('/app/src/')) return r;
  let src = r.source == null ? null : r.source.toString().split(String.fromCharCode(13)).join('');
  if (src == null) return r;

  if (url.endsWith('/storage/db.js')) {
    src = must(src, 'export async function saveFloor(', 'async function __o_saveFloor(', 'saveFloor');
    src = must(src, 'export async function loadFloor(', 'async function __o_loadFloor(', 'loadFloor');
    src += `
import { noteFloorWrite as __b1_noteFloorWrite } from './floorWriteGeneration.js';
const __M = (globalThis.__STRUCT_PERF_MEM ??= { floors: new Map(), stat: { load: 0, save: 0 } });
export async function saveFloor(planeId, bytes) {
  __b1_noteFloorWrite(planeId);
  __M.stat.save++; __M.floors.set(planeId, bytes);
}
export async function loadFloor(planeId) { __M.stat.load++; return __M.floors.get(planeId) ?? null; }
`;
  }

  if (url.endsWith('/storage/FloorSwapManager.js')) {
    src = must(src, '  async peek(plane, structGraph) {', `  async peek(plane, structGraph) {
    const __S = (globalThis.__STRUCT_PERF_STAT ??= { peek: 0, peekMs: 0, rec: 0, recMs: 0 });
    const __t = performance.now();
    try {
      return await this.__peekOrig(plane, structGraph);
    } finally { __S.peek++; __S.peekMs += performance.now() - __t; }
  }
  async __peekOrig(plane, structGraph) {`, 'peek');
  }

  if (url.endsWith('/structural/structuralRecompute.js')) {
    src = must(src, 'export async function recomputeStructuralForGraph(', 'async function __o_recompute(', 'recompute');
    src += `
export async function recomputeStructuralForGraph(...a) {
  const __S = (globalThis.__STRUCT_PERF_STAT ??= { peek: 0, peekMs: 0, rec: 0, recMs: 0 });
  const t = performance.now();
  try { return await __o_recompute(...a); } finally { __S.rec++; __S.recMs += performance.now() - t; }
}
`;
  }

  return { ...r, source: src, shortCircuit: false };
}
