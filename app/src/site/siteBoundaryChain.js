/**
 * 敷地の境界線の線種（一点鎖線）を、区間ごとに破線部の位置を決めて実線の小区間（runs）へ割る純モジュール。
 * 区間＝mergeCollinearPieces が結合した同一直線・同種の連なり。Konva の dash は線全体に一定の周期を掛けるため、
 * 長い辺と短い辺で破線部の個数・位置を揃えられない。ここで位置を決めて、描画側（配置図・編集画面・他モードの重ね）は runs を Line にするだけにする。
 * 破線部＝中心に「間・点・間」（点は実線、両側の間は空き）。破線部以外は実線。
 * store.js・snap.js・.jsx を静的に import しない（node:test から単体で import できる）。
 */
import { SITE_BOUNDARY_CHAIN_BREAK_FRACTION, SITE_BOUNDARY_CHAIN_SINGLE_BREAK_MAX_RATIO } from '../core/constants.js';
import { SITE_BOUNDARY_CHAIN } from './siteLineStyle.js';
import { boundaryPieces, mergeCollinearPieces } from './siteBoundaryLabels.js';

/**
 * 区間の破線部の中心位置（区間の始点からの距離 mm）。最長の区間に対して短い区間（比がしきい値以下）は中央 1 か所、それ以外は両端寄り 2 か所。
 * @param {number} lengthMm 区間の長さ
 * @param {number} longestMm 敷地の全区間のうち最長の長さ
 * @returns {number[]} 昇順
 */
export function chainBreakPositions(lengthMm, longestMm) {
  if (lengthMm <= longestMm * SITE_BOUNDARY_CHAIN_SINGLE_BREAK_MAX_RATIO) return [lengthMm / 2];
  return [lengthMm * SITE_BOUNDARY_CHAIN_BREAK_FRACTION, lengthMm * (1 - SITE_BOUNDARY_CHAIN_BREAK_FRACTION)];
}

/**
 * 区間 a→b を実線の小区間へ割る。各破線部は中心に「間・点・間」（点は dotMm の実線、両側に gapMm の空き）。
 * 破線部が区間の端に届く（全長 2·gap＋dot が区間長以上、または端に接する・越える）ときはその破線部を置かず実線のまま
 * ——端（角）は常に実線になる。隣の破線部と重なるなら後の方を置かない。長さ 0 の小区間は出さない。
 * @param {{x:number,y:number}} a
 * @param {{x:number,y:number}} b
 * @param {number[]} breakCentersMm 破線部の中心（a からの距離 mm）
 * @param {{gapMm:number, dotMm:number}} dims
 * @returns {Array<{points:[number,number,number,number]}>}
 */
export function chainSolidRuns(a, b, breakCentersMm, { gapMm, dotMm }) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return [];
  const ux = dx / length, uy = dy / length;
  const at = d => [a.x + ux * d, a.y + uy * d];
  const half = gapMm + dotMm / 2; // 破線部の全長の半分
  // 置く破線部だけを昇順に残す
  const placed = [];
  let prevEnd = -Infinity;
  for (const c of [...breakCentersMm].sort((p, q) => p - q)) {
    if (c - half <= 0 || c + half >= length) continue; // 端にかかる（全長が区間長以上の場合も含む）
    if (c - half < prevEnd) continue; // 前の破線部と重なる
    placed.push(c);
    prevEnd = c + half;
  }
  // 実線の区間 [from, to]（距離）を順に並べる: 区間の頭→破線部の手前、点、破線部の先→次の破線部の手前、…、最後の破線部の先→終点
  const spans = [];
  let from = 0;
  for (const c of placed) {
    spans.push([from, c - half], [c - dotMm / 2, c + dotMm / 2]);
    from = c + half;
  }
  spans.push([from, length]);
  return spans.filter(([s, e]) => e > s).map(([s, e]) => ({ points: [...at(s), ...at(e)] }));
}

/**
 * 結合した区間（座標は呼び出し側で写してあるもの）それぞれの runs。最長の区間を基準に破線部の個数を決め、
 * 間・点の長さは SITE_BOUNDARY_CHAIN（スクリーン px）÷ scale。戻り値は pieces と同じ順・同じ長さ（呼び出し側が添字で片へ戻せる）。
 * @param {Array<{key:string, a:{x:number,y:number}, b:{x:number,y:number}, owners?:Array}>} pieces
 * @param {number} scale 画面 px → 世界 mm の倍率（viewport.scaleX）
 * @returns {Array<{key:string, runs:Array<{points:number[]}>, owners:Array}>}
 */
export function composeBoundaryChains(pieces, scale) {
  const lengthOf = p => Math.hypot(p.b.x - p.a.x, p.b.y - p.a.y);
  const longest = pieces.reduce((m, p) => Math.max(m, lengthOf(p)), 0);
  const dims = { gapMm: SITE_BOUNDARY_CHAIN.gapPx / scale, dotMm: SITE_BOUNDARY_CHAIN.dotPx / scale };
  return pieces.map(p => ({
    key: p.key,
    runs: chainSolidRuns(p.a, p.b, chainBreakPositions(lengthOf(p), longest), dims),
    owners: p.owners ?? [],
  }));
}

/**
 * 編集画面の描き分け。三斜の線を含む区間（混在を含む）は SiteLinesLayer、長方形だけの区間は SiteRectsLayer が描く。
 * 片でも chain（composeBoundaryChains の要素）でも owners を持てば判定できる。owners が空なら SiteRectsLayer 側。
 * 2 つは互いに補完（どの区間もちょうど一方だけを通る）。
 */
export const isLinesLayerChain = c => (c.owners ?? []).some(o => o.lineId !== undefined);
export const isRectsLayerChain = c => !isLinesLayerChain(c);

/** 敷地（三斜＋長方形の全体）の外周を結合した区間ごとの runs（敷地座標）。最長の判定は敷地全体で行う。編集画面が使う。 */
export function composeSiteBoundaryChains(site, scale) {
  return composeBoundaryChains(mergeCollinearPieces(boundaryPieces(site)), scale);
}
