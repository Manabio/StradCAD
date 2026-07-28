/**
 * per-floor CL の階またぎ対応付け（type:value 照合）。
 *
 * per-floor CL（中心線・補助線）は階ごとに別インスタンス（別id）のため、ある階で解決した
 * CL を別階へ持ち越すには「同種別・同座標」で対応先を探す必要がある。通り芯（structGraph
 * 側の CL）は全階共通idのため、この照合は不要——呼び出し側が先に structGraph.shapeMap.has(id)
 * で判定する（本ファイルの translateCLId 参照）。
 *
 * stairFloorSync.js（階段の上階自動同期）・finish/eccentricityFloorSync.js（CL偏芯の階またぎ
 * 連動）が共用する。
 */

const EPS = 1e-6;

// graph 内で type:value が一致する CL を探す。
// 既知の限界: type と value のみで照合し、線種（lineType）・discipline は見ない。同一座標に
// 別種のCL（例: 通り芯と補助線）が併存する構成では誤って別種CLへ解決しうる。stairFloorSync.js
// での既存の実績を踏まえ、挙動は変更しない（影響範囲を読み切れないため）。
export function findCounterpartCL(graph, type, value) {
  return graph.centerLines.find(
    c => c.centerLineType === type && Math.abs(c.value - value) < EPS,
  ) ?? null;
}

/**
 * per-floor CL id を別階（またはstructGraph共通）の対応CL idへ変換する。
 * 通り芯（structGraph 側）は全階共通のため同一IDのまま。設置階 per-floor CLは
 * type:value 照合で対象階側の対応CLを探す。解決できなければ null（呼び出し側は安全側でスキップ）。
 * @param {string} id - 変換元グラフ（sourceGraph）に属する CL の id
 * @param {object} sourceGraph - id が属するグラフ
 * @param {object} structGraph - 通り芯共通グラフ（project.structGraph）
 * @param {object} targetGraph - 対応先を探すグラフ
 */
export function translateCLId(id, sourceGraph, structGraph, targetGraph) {
  if (structGraph?.shapeMap.has(id)) return id;
  const cl = sourceGraph.shapeMap.get(id);
  if (!cl) return null;
  const counterpart = findCounterpartCL(targetGraph, cl.centerLineType, cl.value);
  return counterpart ? counterpart.id : null;
}
