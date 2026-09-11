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
import { collectRunBreaks } from '../elevationFloorProfile.js';
import { GAP_EPS_MM as GAP_EPS } from '../elevationStyle.js';
import { graphList } from '../../graphReadScope.js';
import { isRealRoom, baseLayerOf } from './sectionLayerStack.js';
import {
  cutProbeRange, isCutWall, isCutAlongWall, isSightlineShape,
  buildLayerStack, probeColumn,
} from './sectionHits.js';

export { probeColumn };

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
 *   cellAt:(layer:object, worldX:number, worldY:number)=>{room:object|null, floorZ:number, ceilZ:number|null}|null,
 *   cellsAlong:(layer:object, cut:object, worldMid:number, fromDepthMm:number, toDepthMm:number)=>Array<object>,
 *   componentOf:(layer:object, room:object|null)=>number|null,
 *   componentAt:(layer:object, worldX:number, worldY:number)=>number|null}}
 */
export function makeProbeContext(layers, opts = {}) {
  const spaceIndex = buildSpaceIndex(layers, opts);
  return {
    cellToRoomByLayer: spaceIndex.cellToRoomByLayer,
    cellToRoomFor: spaceIndex.cellToRoomFor,
    chOf: spaceIndex.chFor,
    floorZOf: spaceIndex.floorZFor,
    cellAt: spaceIndex.cellAt,
    // Phase 3（展開図一般化）: 水平面ヒット（floorFace/ceilFace。`section/sectionHits.js`の
    // `probeColumnHits`）の材料。`cellAt`（1点プローブ）の一般形。
    cellsAlong: spaceIndex.cellsAlong,
    // Phase 6（展開図一般化。設計§5.4「規則へ吸収」）: 空気ボリュームの連結成分。
    // `section/sectionHits.js`の`isHiddenWall`（階段下の閉じた部屋の壁を「描かない実体」
    // ＝ZBand.kind:'hidden'として扱う判定。Phase 6b-2で「候補から消す」から変更）が消費する。
    // 呼ばれるまで計算しない（spaceIndex側の遅延初期化のまま）。
    componentOf: spaceIndex.componentOf,
    componentAt: spaceIndex.componentAt,
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
  const addIfInside = v => { if (v > probeLo + GAP_EPS && v < probeHi - GAP_EPS) values.add(v); };
  // 面の端そのものは常に列境界にする（延長した場合、面の内と外を1列に融合させない）。
  addIfInside(line.lo); addIfInside(line.hi);

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
      }
    }
    for (const o of graphList(layer.graph, 'openings') ?? []) {
      if (!isSightlineShape(o, line, cut.viewSign)) continue;
      addIfInsideLayer(o.coord1); addIfInsideLayer(o.coord2);
    }
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
 * @returns {number|null}
 */
export function upperFloorZAt(cut, worldMid, probeCtx) {
  const stack = buildLayerStack(cut, worldMid, probeCtx); // floorZMm昇順
  const base = baseLayerOf(stack);
  if (!base || !Number.isFinite(base.ceilZ)) return null;
  for (const upper of stack) {
    if (upper === base) continue;
    if (!Number.isFinite(upper.floorZ) || upper.floorZ <= base.ceilZ + GAP_EPS) continue;
    if (isRealRoom(upper.room)) return upper.floorZ;
  }
  return null;
}
