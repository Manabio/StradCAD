// テスト専用。製品コードからは import されない。
// floorSwapManager.peek（他階の読込み）を一時的に差し替えて fn を実行し、必ず元へ戻す。
// 差し替える式（「生きたグラフを返す代用」か「本番と同じ手順の代用」か）は呼び出し側が渡す——ここでは種類を決めない。
import { floorSwapManager } from './FloorSwapManager.js';

export async function withPeek(peek, fn) {
  const original = floorSwapManager.peek;
  floorSwapManager.peek = peek;
  try { return await fn(); } finally { floorSwapManager.peek = original; }
}

/** グラフの配列を渡す版: plane.id が一致するグラフを返し、無ければ null。 */
export async function withPeekGraphs(graphs, fn) {
  const peekMap = Object.fromEntries(graphs.map(g => [g.plane.id, g]));
  return withPeek(async (plane) => peekMap[plane.id] ?? null, fn);
}
