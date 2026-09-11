/**
 * 空間セル索引（展開図一般化Phase 1/2。設計 `.claude/elevation-redesign.md` §5.2/§5.3(a)(b)）。
 *
 * 「(層, 世界x, 世界y) → そのセルの所有Room・床天井」を返す純モジュール。
 * `section/sectionProbe.js` の `makeProbeContext` にあった床天井の式（`floorZOf`/`chOf`）は
 * ここへ移設した——2箇所に置くと「帯のローカルz=0 ≡ その帯の部屋の実効FL」という不変条件
 * （`elevation-model.md`「不変条件: 帯のローカル z=0 ≡ その帯の部屋の実効FL」節）が将来ズレる
 * 危険があるため、式の実体は本ファイルのみに置き、`makeProbeContext`は本索引を内包して
 * 薄いラッパ（`floorZOf`/`chOf`という対外契約はそのまま）として振る舞う。
 *
 * 新規依存はゼロ——材料は既存の純関数のみ（`finish/edgeClassify.js` buildCellToRoom・
 * computeNamedBoundaryEdges・edgeGeometry・selectBoundaryMaster、`finish/gridCells.js`
 * worldToCell・roomBounds・refreshCells、`finish/roomMetrics.js` roomCeilingHeight、
 * `finish/kneeDropWall.js` kneeDropRecordsOnAxis、`graph.effectiveFloorLevel`）。
 *
 * `componentOf`/`componentAt`（Phase 2。同一空気ボリュームの連結成分）はPhase 2で追加済み。
 * **本Phaseでは本番から誰も読まない**（設計R4）——検証プローブ（`scripts/probe/
 * dumpSpaceComponents.mjs`）と単体テストのみが消費者。
 *
 * `cellsAlong`（Phase 3。設計§5.3(a)）: `cellAt`の一般形——1点プローブではなく、視線方向へ
 * 格子セル単位で進み、通過するセル（room変化点で区切った区間）を近い順に返す。腰壁・垂れ壁の
 * 向こう側の床・天井（`section/sectionHits.js`のfloorFace/ceilFaceヒット）の材料になる。
 * 消費者は`section/sectionHits.js`の`probeColumnHits`（`makeProbeContext`経由）。
 */
import { RoomFeature } from '@core';
import { buildCellToRoom, computeNamedBoundaryEdges, edgeGeometry } from '../../finish/edgeClassify.js';
import { worldToCell, roomBounds, refreshCells } from '../../finish/gridCells.js';
import { roomCeilingHeight } from '../../finish/roomMetrics.js';
import { kneeDropRecordsOnAxis, kneeDropWallGeometry } from '../../finish/kneeDropWall.js';
import { graphList } from '../../graphReadScope.js';
import { GAP_EPS_MM as GAP_EPS, PROBE_EPS_MM } from '../elevationStyle.js';

// cellsAlongの無限ループ防御（格子異常時の安全弁）。実データの通常の列は
// せいぜい数十セルなので、この上限に達すること自体が異常の兆候。
const CELLS_ALONG_MAX_STEPS = 5000;

/**
 * @typedef {object} SpaceCell
 * @property {object|null} room - そのセルの所有Room（未割当領域はnull）
 * @property {number} floorZ - 絶対z（帯のfloorOffsetMm差し引き後）
 * @property {number|null} ceilZ - 絶対z。room無しはnull（詳細はcellAtのコメント参照）
 *
 * layerは意図的に持たせない——呼び出し側は自分が渡したlayerを知っており、layer
 * （PlanGraph全体）を抱えるとassert失敗時のnode:assert差分表示がグラフを走査し
 * 10秒以上かかる（QA実測。外すと数ms）。
 */

/**
 * layers（各{graph,floorZMm,role}）から空間セル索引を組む。
 * @param {Array<{graph:object, floorZMm:number, role:string}>} layers
 * @param {{floorOffsetMm?:number}} [opts] - floorOffsetMmは帯のz原点差し引き
 *   （elevationBand.jsのbandFloorOffsetMmが単一情報源。未指定=0=階のdatum基準のまま）。
 * @returns {{
 *   cellAt:(layer:object, worldX:number, worldY:number)=>SpaceCell|null,
 *   cellToRoomFor:(layer:object)=>Map,
 *   cellToRoomByLayer:Map,
 *   floorZFor:(room:object|null, layer:object)=>number,
 *   chFor:(room:object|null, graph:object)=>number|null,
 *   componentOf:(layer:object, room:object|null)=>number|null,
 *   componentAt:(layer:object, worldX:number, worldY:number)=>number|null,
 * }}
 */
export function buildSpaceIndex(layers, opts = {}) {
  const floorOffsetMm = opts.floorOffsetMm ?? 0;
  const cellToRoomByLayer = new Map(); // layer -> Map<cellKey, Room>（呼び出し側から参照可能に公開）
  const cellToRoomByGraph = new Map(); // graph -> Map<cellKey, Room>（実体はgraph単位で共有）
  const chCacheByGraph = new Map();    // graph -> Map<room.id, mm>

  function cellToRoomFor(layer) {
    const cached = cellToRoomByLayer.get(layer);
    if (cached) return cached;
    let byGraph = cellToRoomByGraph.get(layer.graph);
    if (!byGraph) {
      byGraph = buildCellToRoom(layer.graph);
      cellToRoomByGraph.set(layer.graph, byGraph);
    }
    cellToRoomByLayer.set(layer, byGraph);
    return byGraph;
  }
  for (const layer of layers ?? []) cellToRoomFor(layer);

  // **帯のローカルz=0 ≡ その帯の部屋の実効FL**（elevationBand.jsのbandFloorOffsetMm。
  // finalizeBandの平行移動と対の不変条件）。ここを階のdatum基準のままにすると、実効FL≠0の
  // 部屋の帯だけエンジンの床zがfloorOffsetぶんズレる（実機「11'」B1/A2）。
  // layer.floorZMm自体は触らない——壁・断面のzまで動くため。
  function floorZFor(room, layer) {
    if (!room) return layer.floorZMm - floorOffsetMm; // 部屋外（所有Room不明）はlayer自身の基準面へ
    const graph = layer.graph;
    return layer.floorZMm + graph.effectiveFloorLevel(room) - graph.floorDatum - floorOffsetMm;
  }

  function chFor(room, graph) {
    if (!room) return null;
    let cache = chCacheByGraph.get(graph);
    if (!cache) { cache = new Map(); chCacheByGraph.set(graph, cache); }
    if (!cache.has(room.id)) cache.set(room.id, roomCeilingHeight(graph, room).mm);
    return cache.get(room.id);
  }

  // cellAt: (layer, worldX, worldY) → SpaceCell | null。
  // グリッドにセルが無い（layer.graphが無い・格子外）位置はnull——「セルが1つも無い」ことと
  // 「セルはあるが部屋が未割当」（room:null）は区別する（後者はfloorZ/ceilZの解決余地がある）。
  // room=nullのceilZはnull。本番の層スタック`buildLayerStack`（sectionProbe.js:532-543）は
  // cut依存の`fallbackCeilZ`（sectionProbe.js:319-323）を使うため、差し替えにはcutか既定CHを
  // 渡す引数が要る（本Phaseでは未対応）。
  function cellAt(layer, worldX, worldY) {
    if (!layer?.graph) return null;
    const cell = worldToCell(worldX, worldY, layer.graph);
    if (!cell) return null;
    const room = cellToRoomFor(layer).get(cell.key) ?? null;
    const floorZ = floorZFor(room, layer);
    const ch = chFor(room, layer.graph);
    const ceilZ = room ? floorZ + ch : null;
    return { room, floorZ, ceilZ };
  }

  // **遅延初期化**（QA指摘）: buildComponentsはbuildSpaceIndex呼び出しのたびに走る同一層内の
  // 境界走査＋壁探索で、実機12室規模で約78ms/回かかる。本Phaseはcomponentイベント自体を
  // 本番のどこからも読まないため（設計R4）、componentOf/componentAtが実際に呼ばれるまで
  // 一切計算しない——makeProbeContext（probeColumn一回ごとに呼ばれる高頻度経路）を経由する
  // 全ての実行パスでこのコストを払わせないための必須の対策。
  let componentIdByRoom = null;
  function ensureComponents() {
    if (!componentIdByRoom) componentIdByRoom = buildComponents(layers ?? []);
    return componentIdByRoom;
  }
  // layerは現状未使用——Room自体がgraph（≒layer）単位で一意なオブジェクトのため、componentIdの
  // 解決にlayerは要らない。cellAt/floorZFor等の姉妹APIとの引数対称性のために残す
  // （将来、同一Roomオブジェクトを複数layerで共有する構成が入ればここで分岐が要る）。
  function componentOf(layer, room) {
    if (!room) return null;
    return ensureComponents().get(room) ?? null;
  }
  function componentAt(layer, worldX, worldY) {
    const cell = cellAt(layer, worldX, worldY);
    return cell?.room ? componentOf(layer, cell.room) : null;
  }

  // ================================================================
  // cellsAlong（Phase 3。設計§5.3(a)）: cellAtの一般形——視線方向へ格子セル単位で進み、
  // 通過するセルを近い順に返す。
  // ================================================================

  /**
   * cut.line の位置（worldMid＝走り方向の世界座標）から `cut.viewSign` の方向へ、
   * `fromDepthMm`（切断面からの深さ。0＝切断面そのもの）〜`toDepthMm` の範囲を格子セル単位で
   * 進み、通過するセルを近い順に `{room, floorZ, ceilZ, depthMm, componentId}` で返す。
   *
   * room が変わるセルの境界だけを区切りとする（同一Roomが続く限り1件に畳む）——格子の刻み自体は
   * 「別の空気ボリューム」の境界ではないため。**この畳み込み契約はテストで固定済み**
   * （`spaceModel.test.js`「視線方向に2セルまたぐ同一室」。畳み込みを外す変異で赤化することを
   * 確認済み——QA指摘①）。`viewSign` は`cut.viewSign`をそのまま使う
   * （`faceViewSign`（`section/sectionCutPlane.js`）で解決済みの値。ここで符号を書き下ろさない）。
   * `depthMm`はそのセルへ入る距離（=セルの手前端の深さ。`fromDepthMm`未満にはならない）。
   *
   * `worldToCell`はCENTER LINEの格子分割のみを見る（壁の材厚は見ない）ため、壁の実体そのものは
   * セルとして現れない——腰壁・垂れ壁の「向こう側」の部屋がすぐ次のセルとして出てくる
   * （壁厚ぶんの深さがそのまま`depthMm`に反映される）。
   *
   * 失敗経路: `layer.graph`が無い／`cut.line`が無い／`worldMid`・`fromDepthMm`・`toDepthMm`が
   * 有限数でない／`toDepthMm<=fromDepthMm`は例外を投げず空配列を返す（`cellAt`の
   * 「セルが1つも無い→null」と同じ、例外を投げない規約）。
   * `componentId`は返さない（QA指摘④）——本Phaseでは誰も読まず、算出には`ensureComponents()`
   * （層全体の境界走査＋壁探索。実機規模で約78ms/回）が要るため、列ごとに呼ばれる本関数へ
   * 素朴に含めると全列でこのコストを払うことになる。Phase 6（階段下部屋の空気ボリューム判定）で
   * 消費者が現れたら、そのときに`componentOf(layer, seg.room)`を呼び出し側から個別に引けばよい
   * （`buildSpaceIndex`が返す`componentOf`は変わらず公開されている）。
   * @param {object} layer
   * @param {{line:{isVertical:boolean, axisValue:number}, viewSign:1|-1}} cut
   * @param {number} worldMid
   * @param {number} fromDepthMm
   * @param {number} toDepthMm
   * @returns {Array<{room:object|null, floorZ:number, ceilZ:number|null, depthMm:number}>}
   */
  function cellsAlong(layer, cut, worldMid, fromDepthMm, toDepthMm) {
    if (!layer?.graph || !cut?.line) return [];
    // toDepthMmはInfinity（未上限の探査。addHorizontalFaceHitsが渡す）を許す——非数(NaN)だけ拒む。
    // worldMid/fromDepthMmは有限数であることを要求する（探査の起点が不定では組み立てられない）。
    if (!Number.isFinite(worldMid) || !Number.isFinite(fromDepthMm) || Number.isNaN(toDepthMm)) return [];
    if (!(toDepthMm > fromDepthMm)) return [];
    const { line } = cut;
    const viewSign = cut.viewSign === -1 ? -1 : 1;
    const axisValue = line.axisValue;
    const graph = layer.graph;

    const out = [];
    let depth = fromDepthMm;
    let steps = 0;
    while (depth < toDepthMm - GAP_EPS && steps++ < CELLS_ALONG_MAX_STEPS) {
      // 境界ちょうどを避け、次のセルの内側へ逃がす（probeOwnerRoomと同じ手法）。
      const offset = viewSign * (depth + PROBE_EPS_MM);
      const px = line.isVertical ? axisValue + offset : worldMid;
      const py = line.isVertical ? worldMid : axisValue + offset;
      const cell = worldToCell(px, py, graph);
      if (!cell) break; // 格子の外＝これ以上進めない

      // セルの奥行き方向の実世界範囲をdepth軸へ変換する（isVertical=trueならx1/x2、falseならy1/y2）。
      const [wLo, wHi] = line.isVertical ? [cell.x1, cell.x2] : [cell.y1, cell.y2];
      const d0 = (wLo - axisValue) * viewSign, d1 = (wHi - axisValue) * viewSign;
      const cellLo = Math.min(d0, d1), cellHi = Math.max(d0, d1);
      if (!(cellHi > depth + GAP_EPS)) break; // 前進しない異常値は打ち切り（防御）

      const room = cellToRoomFor(layer).get(cell.key) ?? null;
      const last = out[out.length - 1];
      if (!last || last.room !== room) {
        // floorZFor（graph.effectiveFloorLevel等の純算術）は例外を投げない。ceilZ側
        // （chFor→roomCeilingHeight→room.getFinishInfo()）だけが、部屋の異常データで例外に
        // なりうる（getFinishInfo()の実装は展開帯構築時に例外を投げる想定済み——
        // buildBandsSafelyがその部屋の帯だけを落とす）。cellsAlongは視線の先の**無関係な**
        // 部屋まで辿るため、素朴に例外を伝播させると「隣・その先の部屋が壊れているだけで、
        // 手前の正常な部屋の帯まで巻き添えで失敗する」（実機QA F4相当の退行。実測して踏んだ）。
        // QA指摘③是正: 区間そのものは諦めず積む（床＝floorZは解決できているため）。
        // ceilZだけnullに落とす——`addHorizontalFaceHits`の`if (seg.ceilZ != null)`が効いて
        // 「その部屋の床線（floorFace）は出るが天井線（ceilFace）は出ない」という、
        // どこで何を諦めたかが辿れる縮退になる（区間ごと消すより情報の欠落が小さい）。
        const floorZ = floorZFor(room, layer);
        let ceilZ = null;
        if (room) {
          try { ceilZ = floorZ + chFor(room, graph); }
          catch { /* この部屋の天井だけ諦める（上記コメント） */ }
        }
        // QA指摘④: componentIdは積まない（本函数のJSDoc参照）。
        out.push({ room, floorZ, ceilZ, depthMm: Math.max(fromDepthMm, cellLo) });
      }
      depth = Math.min(cellHi, toDepthMm);
    }
    return out;
  }

  return {
    cellAt, cellToRoomFor, cellToRoomByLayer, floorZFor, chFor, componentOf, componentAt, cellsAlong,
  };
}

// ================================================================
// 連結成分（Phase 2。設計 §5.3(a)）
// ================================================================

// Union-Find（経路圧縮のみ。ランク統合は不要な規模）。
function makeUnionFind() {
  const parent = new Map();
  function ensure(x) { if (!parent.has(x)) parent.set(x, x); return x; }
  function find(x) {
    ensure(x);
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root);
    let cur = x;
    while (parent.get(cur) !== root) { const next = parent.get(cur); parent.set(cur, root); cur = next; }
    return root;
  }
  function union(a, b) { ensure(a); ensure(b); const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); }
  return { ensure, find, union, keys: () => parent.keys() };
}

// 部屋境界1区間（edgeKey）が「全高の壁」で仕切られているか。
// QA指摘の是正: 遮断条件をmasterType（selectBoundaryMaster）に依存させない——STEP（段差。
// レベル差はあるが実壁が無い区間に付く分類）判定でも、境界区間を完全に覆う実壁があれば
// masterTypeに関わらず遮断すべき（13.stq 1階「9⇔10'」「12⇔11'」はSTEP判定だが室内壁が実在し、
// 旧実装はmasterType==='INTERIOR_WALL'限定だったため誤って連結していた）。
// 「境界区間を覆う壁が実在するか」は`kneeDropWallGeometry`（finish/kneeDropWall.js）を使う——
// `graph.walls`を軸CL一致・スパン重なりで走査し実面範囲を解決する、isCutWallと同じ材料
// （軸+スパン一致）を使う既存の純関数で、壁が1本も無ければnullを返す契約（=STEPのような
// 無壁境界を自然にfalse扱いできる）。
// 腰壁・垂れ壁（finish/kneeDropWall.jsに指定レコードがある）は全高でないため連結を切らない
// （設計 §5.3(a)「腰壁・垂れ壁は全高でないので連結を切らない」）。退化ケース（腰壁+垂れ壁の
// 組み合わせで隙間が実質0になる指定）はここでは厳密に見ない——本Phaseは連結性の粗い判定が
// 目的であり、高さ方向の厳密な式（sectionProbe.jsのkneeDropZRangesAt相当）まで持ち込むと
// 天井高さの解決が要って複雑化するため（意図的な簡略化。ASSUMED）。
// **既知の粗さ**（QA指摘・実装は変えない）: `kneeDropWallGeometry`は境界区間[lo,hi]に**一部でも**
// 重なる壁があればそれを返す契約（`SPAN_OVERLAP_EPS`を超える重なり）——境界の半分だけに壁がある
// ような構成（残り半分は開口・壁欠け）でも「壁あり」＝全高扱いになり、区間全体を過剰に遮断しうる。
// 本Phaseは連結性の粗い判定が目的であり、区間内の壁被覆率までは見ない（意図的な簡略化）。
function isFullHeightWallSpan(graph, key, cellToRoom) {
  const wallGeo = kneeDropWallGeometry(graph, key, cellToRoom);
  if (!wallGeo) return false; // 壁が1本も無い区間（STEP等）は全高ではない=遮断しない
  const records = kneeDropRecordsOnAxis(graph, wallGeo.axisCL, wallGeo.lo, wallGeo.hi)
    .filter(({ rec }) => rec.knee || rec.drop);
  return records.length === 0;
}

// 同一層内: 名前付き部屋どうしの境界を辿り、全高の壁で仕切られていない限りunionする。
function unionSameLayerAdjacency(uf, layer) {
  const graph = layer.graph;
  if (!graph) return;
  const cellToRoom = buildCellToRoom(graph);
  for (const key of computeNamedBoundaryEdges(graph)) {
    const geo = edgeGeometry(key, graph, cellToRoom);
    if (!geo?.roomNeg || !geo?.roomPos || geo.roomNeg === geo.roomPos) continue;
    uf.ensure(geo.roomNeg); uf.ensure(geo.roomPos);
    if (isFullHeightWallSpan(graph, key, cellToRoom)) continue; // 全高の壁=遮断
    uf.union(geo.roomNeg, geo.roomPos);
  }
}

// 世界座標の矩形が重なるか（roomBoundsの結果どうし）。
// `elevationVoid.js:34-36`のrectsOverlap（elevationStair.jsのfindOverlappingVoidRoomと共有）と
// 同型——ただしspaceModel.jsからelevationVoid.jsを直接importすると
// spaceModel.js→elevationVoid.js→section/sectionProbe.js→spaceModel.jsの循環import
// （elevationVoid.jsはmakeProbeContext経由でbuildSpaceIndexへ依存する上位モジュール）になるため、
// 依存の向きを逆転させないよう本ファイル内に独立して再実装する。
function rectsOverlap(a, b) {
  if (!a || !b) return false;
  if (![a.x1, a.x2, b.x1, b.x2].every(Number.isFinite)) return false;
  return a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;
}

// boundsと重なる、predicate該当RoomをtargetGraphから1つ返す（先勝ち。無ければnull）。
// `elevationVoid.js`の`findOverlappingRoom`（elevationVoid.js:47-64。「吹抜けの直下室は1室」という
// 製品側の規約そのもの）と**同じ契約**——境界矩形（bbox）は非矩形の部屋形状より広いことがあり、
// bboxに単純に重なる部屋を**全部**連結すると、無関係な部屋まで巻き込む
// （QA指摘の反例: 13.stq「13」＝天井を持ち全高壁で囲まれた階段下の部屋が、階段吹抜けのbboxに
// 重なるだけで成分4へ混入していた）。製品コードと同じ「1室だけを対応先とする」規約に揃える。
function findSingleOverlappingRoom(bounds, targetGraph, predicate) {
  if (!bounds) return null;
  for (const r of graphList(targetGraph, 'rooms') ?? []) {
    if (!predicate(r)) continue;
    const b = roomBounds(refreshCells(r.cells, targetGraph), targetGraph);
    if (b && rectsOverlap(bounds, b)) return r;
  }
  return null;
}

// 階またぎ連結（設計ASSUMED 4。QA指摘でリード改訂の上、ユーザー裁定2026-09でVOID側を再改訂）:
//   (i)  上の層のセルがVOID       → **重なる吹抜けの最下階の親部屋1室**とだけ連結する。
//        直下層に**重なるVOID**（feature===VOID）が1室あれば、まずそれとだけ連結して終える——
//        下のVOIDが自分自身の処理（このループの1つ下のペア）でさらに下へつなぐため、
//        層ペアを1段ずつ辿るだけで**連鎖**が成立する（3階VOID⇔2階VOID⇔1階の親部屋、のように
//        Union-Findの推移性で1つの成分にまとまる）。直下層に重なるVOIDが無ければ従来どおり
//        **親部屋1室**（feature==null。`elevationVoid.js`の`findLowerRoom`と同じ規約）と連結する。
//        両方が重なる配置ではVOID側を優先する（親部屋は連鎖の終端でしか見ない）。
//        層スタックに吹抜けの最下階そのものが含まれない（`layers`に渡されていない）場合は、
//        渡された範囲の中で連鎖できるところまでで止まる（それより下は評価しようがない）。
//   (ii) 上の層のセルがSTAIR_VOID → 直下の**階段室1室**（feature===STAIR）とだけ連結（変更なし。
//        `elevationStair.js`の`findOverlappingVoidRoom`が使う対応と対称の向き）。
// 階段下の閉じた部屋（天井を持ち全高壁で囲まれる。例: 13.stq「13」）はどちらの規則にも
// 該当しないため連結しない——旧実装（bbox重なり全部）が誤って混入させていた反例。
// `findSingleOverlappingRoom`の「先に見つかった1室だけを対応先とする」規約はそのまま使う。
// 隣接する層ペア（floorZMm昇順で連続する2層）だけを見る。
function unionCrossLayerAdjacency(uf, layers) {
  const ordered = [...layers].filter(l => l?.graph).sort((a, b) => a.floorZMm - b.floorZMm);
  for (let i = 0; i + 1 < ordered.length; i++) {
    const lower = ordered[i], upper = ordered[i + 1];
    for (const upperRoom of graphList(upper.graph, 'rooms') ?? []) {
      const bounds = roomBounds(refreshCells(upperRoom.cells, upper.graph), upper.graph);
      let target;
      if (upperRoom.feature === RoomFeature.VOID) {
        target = findSingleOverlappingRoom(bounds, lower.graph, r => r.feature === RoomFeature.VOID)
          ?? findSingleOverlappingRoom(bounds, lower.graph, r => r.feature == null);
      } else if (upperRoom.feature === RoomFeature.STAIR_VOID) {
        target = findSingleOverlappingRoom(bounds, lower.graph, r => r.feature === RoomFeature.STAIR);
      } else {
        continue;
      }
      if (!target) continue;
      uf.ensure(upperRoom); uf.ensure(target); uf.union(upperRoom, target);
    }
  }
}

/**
 * layersに現れる全Room（名前の有無を問わない）を連結成分へ分ける。
 * 境界の列挙（`computeNamedBoundaryEdges`）は**名前付き部屋**のセル境界しか見ないため、
 * 名前の無い部屋は自分自身だけの成分になる（設計の対象外・期待どおりの制約として明示する）。
 * @param {Array<{graph:object, floorZMm:number}>} layers
 * @returns {Map<object, number>} Room → 連結成分id
 */
function buildComponents(layers) {
  const uf = makeUnionFind();
  for (const layer of layers) {
    if (!layer?.graph) continue;
    for (const room of graphList(layer.graph, 'rooms') ?? []) uf.ensure(room);
    unionSameLayerAdjacency(uf, layer);
  }
  unionCrossLayerAdjacency(uf, layers);

  const idByRoot = new Map();
  const idByRoom = new Map();
  let nextId = 0;
  for (const room of uf.keys()) {
    const root = uf.find(room);
    if (!idByRoot.has(root)) idByRoot.set(root, nextId++);
    idByRoom.set(room, idByRoot.get(root));
  }
  return idByRoom;
}
