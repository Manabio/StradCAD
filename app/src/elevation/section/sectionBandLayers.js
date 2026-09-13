/**
 * 展開図: 帯の層スタック（`cut.layers`）の組み立てを1関数へ統合する（Phase 7。
 * `.claude/elevation-redesign.md` §5.12「Phase 7 設計」参照）。
 *
 * 通常帯（elevationBand.js）・上部吹抜け帯／吹抜け帯（elevationVoid.js）・加算レイヤ
 * （elevationSolids.js）の4つのビルダーが、それぞれ `[{graph, floorZMm, role}]` を
 * リテラルで組み立てていた（8箇所）。層スタック自体はN層に一般化できる形（`sectionLayerStack.js`
 * がrole名・配列順に依存しない一般規則で読む）なのに、**組み立てる側**がどの帯も2層決め打ちの
 * リテラルだったため、まず入口を1箇所へ揃える。層に関する「問い」（自階はどれか・直上は
 * どれか等）は本ファイルではなく`sectionLayerStack.js`が答える——組み立て（本ファイル）と
 * 問い合わせ（`sectionLayerStack.js`）は別モジュールに分ける（QA指摘F1・F6でファイル名を
 * `sectionBandLayers.js`へ改名し役割を明示）。
 *
 * 連結（「上がVOIDなら上階まで層を積む」等の可視判定）はこの関数の外
 * （section/sectionVisibility.js等）に残る——本関数は**呼び出し側が持つ階リストを宣言的に
 * 渡すだけ**の入口で、帯種別のif分岐を持たない。
 *
 * 純モジュール（node:testから単体import可能。store.js/snap.js/*.jsx/react-konva/appViewport.jsを
 * 静的importしない）。
 */
import { roomCeilingHeight } from '../../finish/roomMetrics.js';

/**
 * @param {object} selfGraph - 帯自身の階のgraph。**falsy（null/undefined）でも検証しない**——
 *   旧実装（各帯ビルダーが直接組んでいたリテラル`{graph, floorZMm:0, role:'self'}`）もgraph引数を
 *   無条件にそのまま埋めていたため、本関数もその挙動をそのまま引き継ぐ（selfLayerは常に
 *   `{graph:selfGraph, floorZMm:..., role:'self'}`の形で1件返る。呼び出し側がgraph不在を
 *   検出したいときは戻り値の`layers[0].graph`を見る）。
 * @param {{above?:Array<{graph:object, floorHeightMm:number}>,
 *   below?:Array<{graph:object, floorHeightMm:number, anchorRoom?:object}>,
 *   selfFloorZMm?:number}} [spec]
 *   above … 直上から順（1つ目が直上階）。below … 直下から順（1つ目が直下階）。
 *   selfFloorZMm … 帯自身の層のfloorZMm（既定0。elevationVoid.jsのmakeUpperStoreyContextのように
 *   「上階を自階として立てる」場合に使う）。
 * @returns {Array<{graph:object, floorZMm:number, role:'self'|'above'|'below', ceilZMm?:number}>}
 *   規則:
 *   1. self が先頭 {graph:selfGraph, floorZMm:selfFloorZMm??0, role:'self'}。
 *   2. above を順に積む。graphがfalsyかfloorHeightMmが非有限なら**その時点で打ち切り**
 *      （以降のabove要素は積まない）。floorZMm = 直前の層のfloorZMm + floorHeightMm。
 *   3. below を順に下ろす。
 *      flDiff = anchorRoom ? graph.effectiveFloorLevel(anchorRoom) - graph.floorDatum : 0
 *      dropMm = max(0, floorHeightMm + flDiff)
 *      graphがfalsyかfloorHeightMmが非有限かdropMm<=0なら**その時点で打ち切り**。
 *      floorZMm = 直前の層のfloorZMm - dropMm。anchorRoomがあるときだけ
 *      ceilZMm = floorZMm + roomCeilingHeight(graph, anchorRoom).mm（無ければceilZMmキー自体を
 *      持たない——探査側の「材料が無ければgate素通り」契約はキー有無でなくvalueの非有限で
 *      判定するため、undefinedを明示するのとキー無しは等価）。
 *   4. 返り順は self → |Δz| 昇順（above・belowを絶対距離でマージ。片方だけ指定した現行の
 *      [self, ...above] / [self, ...below] という並びとそのまま一致する）。
 */
export function buildBandLayers(selfGraph, spec = {}) {
  const selfFloorZMm = spec.selfFloorZMm ?? 0;
  const selfLayer = { graph: selfGraph, floorZMm: selfFloorZMm, role: 'self' };

  const aboveLayers = [];
  let z = selfFloorZMm;
  for (const entry of spec.above ?? []) {
    if (!entry?.graph || !Number.isFinite(entry.floorHeightMm)) break;
    z += entry.floorHeightMm;
    aboveLayers.push({ graph: entry.graph, floorZMm: z, role: 'above' });
  }

  const belowLayers = [];
  z = selfFloorZMm;
  for (const entry of spec.below ?? []) {
    if (!entry?.graph || !Number.isFinite(entry.floorHeightMm)) break;
    const flDiff = entry.anchorRoom
      ? entry.graph.effectiveFloorLevel(entry.anchorRoom) - entry.graph.floorDatum
      : 0;
    const dropMm = Math.max(0, entry.floorHeightMm + flDiff);
    if (dropMm <= 0) break;
    z -= dropMm;
    const layer = { graph: entry.graph, floorZMm: z, role: 'below' };
    if (entry.anchorRoom) layer.ceilZMm = z + roomCeilingHeight(entry.graph, entry.anchorRoom).mm;
    belowLayers.push(layer);
  }

  // self → |Δz|昇順（above/belowを絶対距離でマージ）。
  const merged = [];
  let ai = 0, bi = 0;
  while (ai < aboveLayers.length || bi < belowLayers.length) {
    const a = aboveLayers[ai], b = belowLayers[bi];
    const da = a ? Math.abs(a.floorZMm - selfFloorZMm) : Infinity;
    const db = b ? Math.abs(b.floorZMm - selfFloorZMm) : Infinity;
    if (db < da) { merged.push(b); bi++; } else { merged.push(a); ai++; }
  }
  return [selfLayer, ...merged];
}
