/**
 * 2.5D断面エンジン: makeProbeContext / collectCutBreaks / upperFloorZAt（WP-E1）。
 * 設計意図はarchitect承認済みの実装指示書§5参照（.claude/elevation-model.md「階をまたぐ2層帯」節
 * が現行仕様）。WP-E5bでelevationStairSequence.jsから（switchbackCuts.js経由・直接の両方で）
 * 呼ばれるようになった。
 *
 * §5.7「既存部品の転用」どおり、レイキャスト自体は新規実装だが、断点抽出・セル所有者探索は
 * 既存の純関数（collectRunBreaks・worldToCell・kneeDropRecordsOnAxis）をそのまま再利用する。
 * セル所有者・床天井の解決（buildCellToRoom・roomCeilingHeight）は展開図一般化Phase 1で
 * `space/spaceModel.js`の`buildSpaceIndex`へ集約し、本ファイルはそれを`makeProbeContext`
 * 経由で呼ぶ側になった。
 *
 * 展開図一般化Phase 2: 1列の候補収集・z区間分割・オクルージョン選択（旧`probeColumn`の実体）は
 * `section/sectionHits.js`（`probeColumnHits`/`visibleBandsOf`）へ移設した。`probeColumn`は
 * そこからの**再エクスポートで対外契約は不変**——このファイルからimportする既存の呼び出し側は
 * 変更不要。`collectCutBreaks`（列の分割）と共有する述語（`isCutWall`/`isCutAlongWall`/
 * `isSightlineShape`/`cutProbeRange`）もsectionHits.jsへ集約し、ここから
 * importして使う（一方向依存。sectionHits.js側はsectionProbe.jsを一切importしない）。
 * `isHiddenWall`はPhase 6b-2（設計`.claude/elevation-redesign.md`§5.11 C-1）で
 * `probeColumnHits`側だけが読む判定へ変わった——「候補から消す」から「描かない実体として積む」へ
 * 変わったことで、`collectCutBreaks`（列の分割）は非可視かどうかに関わらず常に壁の端で列を割る
 * （下記`collectCutBreaks`のコメント参照）。QA是正2026-09: 列を割ること自体は面C自身の右端
 * （1492.5）に必須（実測: 割らないと隣接するCLの break へフォールバックし1442.5にずれる）——
 * 「別の面で無関係な縁線が生える」副作用は`emitColumns`側（隣接列がhidden帯なら通常の実体と
 * 同格に扱う）で個別に抑える（`sectionEmit.js`のコメント参照）。
 */
import { buildSpaceIndex } from '../space/spaceModel.js';
import { collectRunBreaks } from './floorProfileMath.js';
import { GAP_EPS_MM as GAP_EPS } from '../elevationStyle.js';
import { graphList } from '../../graphReadScope.js';
import { isRealRoom, baseLayerOf, orderLayerStack, layersAboveOf } from './sectionLayerStack.js';
import { effectiveStructure } from '../../structural/structureRules.js';
import { ceilClipProfileOf, worldOf } from './sectionTypes.js';
import { zoneCeilingFieldOf } from '../space/zoneCeiling.js';
import {
  stairPartitionDescriptors, partitionTopZAt, partitionTopCrossings, matchStairPartitionLine,
} from '../../finish/stair/stairPartition.js';
import { stairUnderReturnSoffit } from '../../ceiling/stairSoffit.js';
import { stairContinuesAbove } from '../../finish/stair/stairChains.js';
import {
  cutProbeRange, isCutWall, isCutAlongWall, isSightlineShape,
  buildLayerStack, probeColumn, nearMembersOf,
} from './sectionHits.js';

export { probeColumn, stairUnderReturnSoffit };

// layer の直上の層。層の比較式は sectionLayerStack.js の既存ヘルパー（orderLayerStack・layersAboveOf）に任せる。
function layerDirectlyAbove(layers, layer) {
  const stack = orderLayerStack((layers ?? []).map(l => ({ layer: l })));
  return layersAboveOf(stack, { layer })[0]?.layer ?? null;
}

// stairUnderReturnSoffit（復路下の壁・天端・復路の裏面の立体の唯一の供給源）は ceiling/stairSoffit.js へ移した
// （平面の立体モデル plan/planSolids.js が展開図エンジンの内部を引かないため）。既存の import 先
// （elevationStairSequence.js・テスト）を変えないよう、上の export から再公開する。

// 復路下の壁（stairPartition.js isStairUnderReturnWall）→ 平らな天端。壁は復路レーンの裏面で止まる（その上は階段の
// 踏面・裏面で、壁は立ち上がらない）。高さは階段の裏面の式の唯一の供給源 ceiling/stairSoffit.js stairSoffitSolids を
// 壁の軸上・区間の中央で評価した値（壁の厚みは 115 なので平らで足りる）。式の入力は階段・graph・蹴上（階高/総段数）・
// 階段室の床の絶対z。直上の層が無い（階高不明で蹴上が決まらない）・鉄骨階段・裏面が求まらない場合は載せない＝フルハイト。
function addUnderReturnTops(out, graph, floorHeight, layer, floorZFor, aboveGraph = null) {
  for (const stair of graphList(graph, 'stairs') ?? []) {
    const room = graph.roomMap?.get(stair.roomId) ?? null;
    const found = stairUnderReturnSoffit(stair, graph, { floorHeight, floorZMm: floorZFor(room, layer), aboveGraph });
    if (!found || found.wallTopZ == null) continue; // 復路下の壁なし・裏面が組めない＝フルハイト
    const { walls, wallTopZ: z } = found;
    // junction … 天端は階段の裏面（傾斜天井）との取り合い。壁の自由な縁ではないので、見えがかりの天端は細線（sectionEmit.js emitColumns）。
    // 階段帯の seq5 は壁の仕上げ空間側の面だけを描き天端は描かない（elevationStairSequence.js underReturnSpaceOf）
    for (const w of walls) out.set(w.id, { zAt: () => z, crossings: () => [], junction: true });
  }
}

// 層の隔て壁（オーナー壁・薄壁とも）→ 天端プロファイル。直上の層が無ければ階高が決まらず
// 斜め天端にできない（full＝プロファイルなし）。続きの階段（上階に重なる階段）があれば full。
function buildWallTopProfiles(layers, layer, floorZFor, fallbackFloorHeightMm = null, fallbackUpperGraph = null) {
  const out = new Map();
  const graph = layer.graph;
  if (!graph) return out;
  const above = layerDirectlyAbove(layers, layer);
  // 復路下の壁の天端だけは、直上の層が無い単層の帯でも呼び出し側が渡す階高（fallbackFloorHeightMm。部屋帯の
  // solids.floorHeightMm）で付ける——ホールから階段室を見通すとき復路下の壁が最初の壁になる（S4）。
  addUnderReturnTops(out, graph, above ? above.floorZMm - layer.floorZMm : fallbackFloorHeightMm, layer, floorZFor, above?.graph ?? fallbackUpperGraph);
  const structGraph = graph._structGraph;
  const descs = stairPartitionDescriptors(graph, {
    structure: effectiveStructure(graph),
    floorHeight: above ? above.floorZMm - layer.floorZMm : null,
    continuesAbove: stair => stairContinuesAbove(stair, graph, above?.graph ?? null, structGraph),
  }).filter(d => d.desc.top.kind === 'slope');
  if (descs.length === 0) return out;
  const lines = descs.map(d => d.line);
  for (const w of graphList(graph, 'walls') ?? []) {
    const line = matchStairPartitionLine(w, lines);
    if (!line) continue;
    const { desc, stair } = descs[lines.indexOf(line)];
    // 絶対zの基準は階段室の床（spaceIndex.floorZFor＝実効FL・datum・floorOffset を含む。層の floorZMm 直でない）
    const baseZ = floorZFor(graph.roomMap?.get(stair.roomId) ?? null, layer);
    // crossings … 斜めの天端が各 z（絶対）を横切る along（昇順）。列の境界（collectCutBreaks）の材料。
    out.set(w.id, {
      zAt: along => baseZ + partitionTopZAt(desc, along),
      crossings: zLevels => partitionTopCrossings(desc, (zLevels ?? []).map(z => z - baseZ)),
    });
  }
  return out;
}

/**
 * layers（各{graph,floorZMm,role}）から、レイキャストに必要な索引（層別cellToRoom・
 * 天井高さ・floorZ算出）をまとめたプローブコンテキストを作る（§4 sectionProbe.js冒頭）。
 *
 * 展開図一般化Phase 1（`.claude/elevation-redesign.md` §5.2/§5.3）: 床天井の式（cellToRoomの
 * メモ化・chOf・floorZOf）の実体は`space/spaceModel.js`の`buildSpaceIndex`へ移設した。
 * ここは索引を呼ぶ**薄いラッパ**——既存4キー（cellToRoomByLayer/cellToRoomFor/chOf/floorZOf）の
 * 対外契約（返り値の形・各関数の入出力）は移設前と完全に同一。`cellAt`はQA指摘で追加した5つ目の
 * キーで、`ownerRoomAtOffset`（probeOwnerRoomの一般形）の本番呼び出しがこれ経由になった。
 * @param {Array<{graph:object, floorZMm:number, role:string}>} layers
 * @returns {{cellToRoomByLayer:Map, cellToRoomFor:(layer:object)=>Map,
 *   chOf:(room:object|null, graph:object)=>number|null,
 *   floorZOf:(room:object|null, layer:object)=>number,
 *   cellAt:(layer:object, worldX:number, worldY:number, span?:{isVertical:boolean, depthCoord:number, lo:number, hi:number}|null)=>{room:object|null, floorZ:number, ceilZ:number|null}|null,
 *   cellsAlong:(layer:object, cut:object, worldMid:number, fromDepthMm:number, toDepthMm:number)=>Array<object>,
 *   componentOf:(layer:object, room:object|null)=>number|null,
 *   componentAt:(layer:object, worldX:number, worldY:number)=>number|null}}
 */
export function makeProbeContext(layers, opts = {}) {
  const spaceIndex = buildSpaceIndex(layers, opts);
  const wallTopByLayer = new Map(); // layer -> Map<wallId, {zAt, crossings}>
  function wallTopProfileFor(layer) {
    let m = wallTopByLayer.get(layer);
    if (!m) { m = buildWallTopProfiles(layers, layer, spaceIndex.floorZFor, opts.floorHeightMm ?? null, opts.upperGraph ?? null); wallTopByLayer.set(layer, m); }
    return m;
  }
  return {
    cellToRoomByLayer: spaceIndex.cellToRoomByLayer,
    cellToRoomFor: spaceIndex.cellToRoomFor,
    chOf: spaceIndex.chFor,
    chAt: spaceIndex.chAt,
    floorZOf: spaceIndex.floorZFor,
    cellAt: spaceIndex.cellAt,
    // Phase 3（展開図一般化）: 水平面ヒット（floorFace/ceilFace。`section/sectionHits.js`の
    // `probeColumnHits`）の材料。`cellAt`（1点プローブ）の一般形。
    cellsAlong: spaceIndex.cellsAlong,
    // 天伏の天井高さ場（graph ごとにメモ。collectCutBreaks が部材の端を足す可否の判定に使う）
    zoneFieldFor: spaceIndex.zoneFieldFor,
    // Phase 6（展開図一般化。設計§5.4「規則へ吸収」）: 空気ボリュームの連結成分。
    // `section/sectionHits.js`の`isHiddenWall`（階段下の閉じた部屋の壁を「描かない実体」
    // ＝ZBand.kind:'hidden'として扱う判定。Phase 6b-2で「候補から消す」から変更）が消費する。
    // 呼ばれるまで計算しない（spaceIndex側の遅延初期化のまま）。
    componentOf: spaceIndex.componentOf,
    componentAt: spaceIndex.componentAt,
    // 壁の天端プロファイル（関所 kneeDropZRangesAt の wallTop 引数）。隔て壁（在来木造の折返し・回り階段（U 字系））が
    // 斜め天端のとき {zAt(along)→絶対z, crossings(zLevels)→along[]} を壁idで引く。層ごとに1回だけ作る（stairPartitionLines 等が重い）。
    wallTopProfileFor,
    // 呼び出し側が渡した階高（設置階〜上階。部屋帯のsolids.floorHeightMm。無ければnull）。直上の層が無い単層の帯で
    // 階段の蹴上が要る処理（復路下の壁の天端・階段室越しの階段の見えがかり）が使う。
    floorHeightMm: opts.floorHeightMm ?? null,
    // 同じく直上階の graph（部屋帯の solids.upperGraph。復路の到達辺＝上階の床梁の面）。層スタックに直上の層が無い単層の帯用のフォールバック
    upperGraph: opts.upperGraph ?? null,
  };
}

/**
 * cut.line のx区間分割点（run方向のworld座標。昇順）を4源から集める（§5.1）。
 * S1: 各層のcollectRunBreaksの和集合（1F/2FのCL粒度差対策。層ごとに回して和集合を取る——
 *     1点だけの代表値で済ませると .claude/elevation-model.md「粗いセル境界での1点プローブ誤分類」
 *     と同根の取りこぼしが起きる）。
 * S2: 切断線を横切る壁（isCutWall）のmaterialRange両端。
 * S3: 視線方向の壁（isSightlineShape）の端点(coord1/coord2)。
 * S4: 視線方向の開口（isSightlineShape。Wallと同じisVertical/axisCLインターフェースで判定できる）
 *     の端点——アキの連結性判定（openingPassThrough。WP-E7スコープ）が列境界を必要とするため、
 *     このWPでも列境界自体は用意しておく（実際のopeningPassThrough付与はWP-E7で行う）。
 * S5: 梁・柱（nearMembersOf）の run 方向の端（層の探査窓でクランプ。U1b B2）。
 * GAP_EPS未満の重複・line.lo/hiちょうどの値は素通し（Setで自然に併合される）。
 * @param {import('./sectionTypes.js').SectionCut} cut
 * @param {ReturnType<typeof makeProbeContext>} [probeCtx] - 層別cellToRoomのウォームアップに使う
 *   （後続の`probeColumn`呼び出しのキャッシュ寄与。§5.1自体はgraph.centerLines/walls/openingsの
 *   直接走査で完結するため省略しても動く）。
 * @returns {number[]} 昇順・重複除去済み
 */
export function collectCutBreaks(cut, probeCtx) {
  const line = cut.line;
  const layers = cut.layers ?? [];
  // 探査範囲は切断線そのもの[lo,hi]だけでなく、**壁のない端部の外側**（probeExtendLo/HiMm。
  // ユーザー実機指摘2026-08「6」D／裁定A案）も含む——面の端で切れている壁・床スラブ・天井は
  // 「そこで終わる」のではなく面の外へ続いており、その取り合い（腰壁の外側面・隣室の1F天井・
  // 2FL床）を作図するには、外側にも実データの列が要るため。x=0の起点（cutOriginWorld）は
  // line.lo/hiのままで動かさないので、既存のローカルx座標は一切ずれない。
  const { lo: probeLo, hi: probeHi } = cutProbeRange(line);
  const values = new Set([probeLo, probeHi]);
  // 斜めの天端（壁の天端プロファイル）が横切ると列の中で水平線（上階FL・切断の床/上端）をまたぐ高さ。
  // 斜線を頭打ちにする高さ（切断の天井断面 cut.ceilProfile〔無ければ打ち切り専用の cut.ceilClip〕・プロファイルを持つ壁の層の各部屋の実効天井）も含める
  // ——列が斜線の途中で天井をまたぐと、列全体が水平へ倒れて斜線より下の空気に壁を描いてしまう。
  const slopeLevels = [...layers.map(l => l?.floorZMm), cut.baseFloorZ, cut.zRange?.loZ, cut.zRange?.hiZ,
    ...(ceilClipProfileOf(cut) ?? []).flatMap(s => [s?.ceilZ, s?.ceilZHi])].filter(Number.isFinite);
  const ceilLevelsOf = layer => (graphList(layer.graph, 'rooms') ?? [])
    .map(room => probeCtx.floorZOf(room, layer) + probeCtx.chOf(room, layer.graph)).filter(Number.isFinite);
  const addIfInside = v => { if (v > probeLo + GAP_EPS && v < probeHi - GAP_EPS) values.add(v); };
  // 面の端そのものは常に列境界にする（延長した場合、面の内と外を1列に融合させない）。
  addIfInside(line.lo); addIfInside(line.hi);
  // 列の割り方が出力へ出る区間（斜めの天井断面・視線側の斜め天端の壁・天伏の斜面）の world 区間。部材の端（下）はここに掛かる列には足さない。
  const slopeSpans = [];
  for (const seg of ceilClipProfileOf(cut) ?? []) {
    if (!(Number.isFinite(seg?.ceilZHi) && Math.abs(seg.ceilZHi - seg.ceilZ) > GAP_EPS && seg.hiX - seg.loX > GAP_EPS)) continue;
    const a = worldOf(cut, seg.loX), b = worldOf(cut, seg.hiX);
    slopeSpans.push([Math.min(a, b), Math.max(a, b)]);
  }

  for (const layer of layers) {
    probeCtx?.cellToRoomFor?.(layer); // ウォームアップ（後続のprobeColumn呼び出しのキャッシュ寄与）
    // **層ごとの探査窓へクランプする**（withinLayerWindow）——その層の平面が届いていない範囲で
    // 列を割ると、中身の無い列（＝存在しない壁端の縦線）が出る。窓が無い層は従来どおり全域。
    const win = cut.layerRunWindows?.get(layer);
    const loOf = Math.max(probeLo, win?.lo ?? -Infinity);
    const hiOf = Math.min(probeHi, win?.hi ?? Infinity);
    const addIfInsideLayer = v => { if (v > loOf + GAP_EPS && v < hiOf - GAP_EPS) addIfInside(v); };
    for (const v of collectRunBreaks(layer.graph, line.isVertical, loOf, hiOf)) values.add(v);
    for (const w of graphList(layer.graph, 'walls') ?? []) {
      // 展開図一般化Phase 6b-2（設計`.claude/elevation-redesign.md`§5.11 C-1）: 非可視の壁
      // （`isHiddenWall`該当）も**列は割る**——「候補から消す」のではなく「描かない実体
      // （ZBand.kind:'hidden'）として積む」方式へ変わったため、その壁の材の面・端点は他の実体と
      // 同じく列の境界になる。QA是正2026-09の実測: ここを「割らない」へ戻すと面C自身の右端が
      // 1492.5から隣接CLの1442.5へずれて壊れる（面Cの右端はこの壁自身のmaterialRange境界に
      // 依存する）ため不可——「別の面（D1/A/D2等）で無関係な縁線が生える」副作用は列分割側では
      // なく`emitColumns`側で個別に抑える（下記コメント参照）。
      if (isCutWall(w, line)) {
        const mr = w.materialRange;
        addIfInsideLayer(mr.lo); addIfInsideLayer(mr.hi);
      } else if (isCutAlongWall(w, line)) {
        const c1 = Math.min(w.coord1, w.coord2), c2 = Math.max(w.coord1, w.coord2);
        addIfInsideLayer(c1); addIfInsideLayer(c2);
      } else if (isSightlineShape(w, line, cut.viewSign)) {
        const c1 = Math.min(w.coord1, w.coord2), c2 = Math.max(w.coord1, w.coord2);
        addIfInsideLayer(c1); addIfInsideLayer(c2);
        // 斜めの天端が水平線の高さを横切る位置も列の境界にする（列の中で斜線が水平線をまたがない）。
        const prof = probeCtx?.wallTopProfileFor?.(layer)?.get(w.id);
        if (prof) slopeSpans.push([c1, c2]);
        for (const a of prof?.crossings?.([...slopeLevels, ...ceilLevelsOf(layer)]) ?? []) {
          if (a > c1 + GAP_EPS && a < c2 - GAP_EPS) addIfInsideLayer(a);
        }
      }
    }
    for (const o of graphList(layer.graph, 'openings') ?? []) {
      if (!isSightlineShape(o, line, cut.viewSign)) continue;
      addIfInsideLayer(o.coord1); addIfInsideLayer(o.coord2);
    }
  }
  // 梁・柱（U1b B2）: 梁・柱（部材）の run 方向の端。直交する梁は芯±半幅・平行な梁（切断線が帯を通るものを含む）はスパン両端・
  // 柱は矩形の run 方向の辺。層ごとの探査窓（上の壁の端と同じ withinLayerWindow）へクランプする。
  // 部材の一覧は候補収集（sectionHits.js addMemberHits）と同じ nearMembersOf（絞り込み・メモを共有）。
  // 選択（visibleBandsOf）は memberCut/memberFace を帯にしない（B1 のまま）ので、部材の端で割れた隣接列は帯列が同じになり
  // mergeColumns が併合する＝出力は不変。座標は world の run 座標（この関数が返す値と同じ）で、面ローカル x への変換は不要。
  // **例外: 斜めの区間に掛かる列は割らない**。足す前の列（base）のうち端 v を含む列が斜めの区間と重なるなら足さない。
  // その列は天端・天井の高さを列ごとの低い側／両端値で持ち（ceilZ・ceilEdge・topEdge）、mergeColumns が併合しない＝割り方が
  // そのまま出力（斜線の分割・天井の高さ）に出るため。区間は次の 3 つだけ（QA アブレーションで必要と確認 2026-10-24。
  // 他の候補〔cutAlong の天端・平面区画の継ぎ目・階段の裏面の足元〕は 83 本で発火せず／ceil と重複のため削除）:
  // ceil＝斜めの天井断面、wtpSight＝視線側の wallTopProfile 壁のスパン、zone＝天伏の天井高さ場の斜面・円弧・ドームの run 範囲。
  // 列の増減で描画が変わるのは B3 以降（選択へ参加させる段）で斜線の連結を直すときに合わせて扱う。
  const near = nearMembersOf(cut);
  if (near.beams.length > 0 || near.columns.length > 0) {
    for (const layer of layers) {
      const field = probeCtx?.zoneFieldFor ? probeCtx.zoneFieldFor(layer.graph) : zoneCeilingFieldOf(layer.graph);
      for (const s of field?.surfaces ?? []) {
        if (s.shape === 'flat') continue;
        for (const r of s.rects) {
          const [a, b] = line.isVertical ? [r.y1, r.y2] : [r.x1, r.x2];
          slopeSpans.push([Math.min(a, b), Math.max(a, b)]);
        }
      }
    }
  }
  const base = [...values].sort((a, b) => a - b);
  const addMemberEdge = (layer, v) => {
    const win = cut.layerRunWindows?.get(layer);
    if (!(v > Math.max(probeLo, win?.lo ?? -Infinity) + GAP_EPS && v < Math.min(probeHi, win?.hi ?? Infinity) - GAP_EPS)) return;
    const i = base.findIndex(b => b > v);
    const colLo = base[i - 1] ?? -Infinity, colHi = base[i] ?? Infinity;
    if (slopeSpans.some(([a, b]) => colHi > a + GAP_EPS && colLo < b - GAP_EPS)) return;
    addIfInside(v);
  };
  for (const { layer, solid: b } of near.beams) {
    if (!!b.isVertical !== !!line.isVertical) {
      addMemberEdge(layer, b.axisWorld - b.widthMm / 2); addMemberEdge(layer, b.axisWorld + b.widthMm / 2);
    } else {
      addMemberEdge(layer, b.spanLo); addMemberEdge(layer, b.spanHi);
    }
  }
  for (const { layer, solid: c } of near.columns) {
    const [runLo, runHi] = line.isVertical ? [c.yLo, c.yHi] : [c.xLo, c.xHi];
    addMemberEdge(layer, runLo); addMemberEdge(layer, runHi);
  }
  return [...values].sort((a, b) => a - b);
}

/**
 * その列で、**帯の天井より上に上階の床が実在するか**——実在すればその床のz（その層のfloorZ）、
 * しなければnull。`sectionEmit.js`の`ceilStepSlabSection`が「上階の床の断面」を描いてよいかの
 * 判定に使う。
 *
 * 上に部屋が無い（吹抜けがそのまま続く）位置に床の断面線を描いてはいけない
 * （ユーザー確定「吹抜けには天井断面まで水平断面が無い」）。帯の形（上階のFLで帯が切り替わるか）
 * から推測すると、**上階の壁の断面**が同じFLで始まるだけの位置まで拾ってしまうため、
 * 層スタックの所有Roomを直接見る。
 * @param {import('./sectionTypes.js').SectionCut} cut
 * @param {number} worldMid
 * @param {ReturnType<typeof makeProbeContext>} probeCtx
 * @param {{worldLo:number, worldHi:number}|null} [span] - 列の幅（probeColumn と同じ層スタックで判定するため）
 * @returns {number|null}
 */
export function upperFloorZAt(cut, worldMid, probeCtx, span = null) {
  const stack = buildLayerStack(cut, worldMid, probeCtx, span); // floorZMm昇順
  const base = baseLayerOf(stack);
  if (!base || !Number.isFinite(base.ceilZ)) return null;
  for (const upper of stack) {
    if (upper === base) continue;
    if (!Number.isFinite(upper.floorZ) || upper.floorZ <= base.ceilZ + GAP_EPS) continue;
    if (isRealRoom(upper.room)) return upper.floorZ;
  }
  return null;
}
