/**
 * 2.5D断面エンジン: 層スタック（layer stack）の一般規則。
 *
 * `SectionCut.layers` は「どの階のgraphを、絶対zのどこに置くか」の並びでしかないのに、
 * 旧`sectionProbe.js`はそれをrole名（'self'/'above'/'below'）で場当たりに引いていた
 * （`find(role==='above')`／`role!=='self' && floorZMm<=z`／固定のROLE_ORDER表）。
 * 2層固定なら偶然正しいが、**層が3つ以上になった瞬間に配列順とrole名に依存して壊れる**
 * ——「多層の展開図で固定条件のままでは希望どおりに出ない」の構造的な原因。
 *
 * 本モジュールは層に関する問いを次の4つだけに畳み、role名を一切見ない一般規則で答える:
 *   1. その高さzを「その階」として所有するのはどの層か（`layerOwningZ`）
 *   2. 帯自身の階はどれか（`baseLayerOf`。zの原点=帯のFLという`sectionTypes.js`の契約から一意）
 *   3. ある層の上にはどの層が積まれているか（`layersAboveOf`）
 *   4. 同距離の候補が競合したらどちらを採るか（`compareLayerPriority`）
 * role文字列は`ZBand.layerRole`（`sectionEmit.js`が隣接列の同一性判定に使う識別子）としてのみ
 * 残す——意味を持つのは並び（floorZMm）であって名前ではない、という境界を保つ。
 *
 * 純モジュール（store.js/snap.js/*.jsx/react-konva/appViewport.jsを静的importしない）。
 */
import { RoomFeature } from '@core';
import { GAP_EPS_MM as GAP_EPS } from '../elevationStyle.js';

/**
 * @typedef {{layer:{graph:object, floorZMm:number, role?:string}, room:object|null,
 *   floorZ:number, ceilZ:number}} LayerInfo
 *   probeColumnが層ごとに1点プローブして作る「その列でのその層の床天井」。
 */

/**
 * VOID/STAIR_VOID（吹抜け・階段吹抜け）featureのRoomは「実床が無い」ことを表現するために
 * Room化されているだけ（CH解決等の都合）——実床が有ると誤判定しないよう除外する。
 * 見えがかり壁のz上限（`resolveSightlineTopZ`）と2FL水平線のowner判定が共有する単一情報源
 * （`elevationStairSequence.js`のaboveRoomSegmentsOnFaceと同じ判定基準）。
 * @param {object|null|undefined} room
 * @returns {boolean}
 */
export function isRealRoom(room) {
  return !!room && room.feature !== RoomFeature.VOID && room.feature !== RoomFeature.STAIR_VOID;
}

/**
 * LayerInfo[] を floorZMm 昇順（同値は入力順）へ整列した「層スタック」にする。
 * 以降の全ての層の問いはこの並びの上で答える＝**呼び出し側が`cut.layers`をどの順で
 * 並べても結果が変わらない**（`sectionProbeInvariants.test.js`で不変条件として固定）。
 * @param {LayerInfo[]} layerInfos
 * @returns {LayerInfo[]}
 */
export function orderLayerStack(layerInfos) {
  return (layerInfos ?? []).map((info, i) => ({ info, i }))
    .sort((a, b) => (a.info.layer.floorZMm - b.info.layer.floorZMm) || (a.i - b.i))
    .map(e => e.info);
}

/**
 * 帯自身の階（＝この展開図が立っている階）の層。
 * `sectionTypes.js`の契約「高さは絶対z（上が正・設置階FL=0基準）」より、**z原点に最も近い層**が
 * 帯自身の階であることが一意に決まる（role名'self'を見る必要はない。実データでも全ての
 * 生成箇所がself層をfloorZMm:0で作っている）。同距離なら上側（＝地上側）を優先する。
 *
 * **ただし層スタックが「その列に届いている層」だけの部分集合である場合は、帯自身の階が
 * そこに居るとは限らない**——層ごとの探査窓（`SectionCut.layerRunWindows`）で自階が落ちた
 * はり出し列では、残った上階が本関数の答えになる。呼び出し側は「baseの下は自階の床構造」の
 * ような、baseが帯自身の階であることに依存する推論をそのまま当ててはいけない
 * （`sectionProbe.js`の`unexploredBelowZOf`が、その高さを未探査として帯ごと落としている）。
 * @param {LayerInfo[]} stack - orderLayerStackの結果
 * @returns {LayerInfo|null}
 */
export function baseLayerOf(stack) {
  let best = null;
  for (const info of stack ?? []) {
    if (!best || compareLayerPriority(info, best) < 0) best = info;
  }
  return best;
}

/**
 * 絶対z=zの高さを「その階」として所有する層＝floorZMmがz以下で最も高い層。
 * 該当が無ければ（zが最下層の床より下）最下層を返す。
 * 旧実装の`find(role!=='self' && floorZMm<=z)`は配列順で最初の一致を返していたため、
 * 3層以上ではzを含まない階の層を拾いえた。
 * @param {LayerInfo[]} stack - orderLayerStackの結果
 * @param {number} z
 * @returns {LayerInfo|null}
 */
export function layerOwningZ(stack, z) {
  let owner = stack?.[0] ?? null;
  for (const info of stack ?? []) {
    if (info.layer.floorZMm <= z + GAP_EPS) owner = info;
  }
  return owner;
}

/**
 * ある層の上に積まれた層（floorZMmが真に大きいもの）を下から順に返す。
 * @param {LayerInfo[]} stack - orderLayerStackの結果
 * @param {LayerInfo} info
 * @returns {LayerInfo[]}
 */
export function layersAboveOf(stack, info) {
  const z = info?.layer?.floorZMm;
  if (!Number.isFinite(z)) return [];
  return (stack ?? []).filter(o => o.layer.floorZMm > z + GAP_EPS);
}

/**
 * 生の層配列（`sectionBandLayers.js`の`buildBandLayers`が返す`{graph, floorZMm, role}[]`。
 * role名は問わない）から「自階の直上の層」を返す（無ければnull）。
 *
 * Phase 7b-2是正（QA指摘F1）: 旧`elevationStairSequence.js`の実装は
 * `layers.find(l => l.role !== 'self')`（配列先頭の非自階層を無条件に拾う。3層以上や
 * below層しか無い帯で誤った層を選びうる）と、その置換として一度書かれた本ファイル外の
 * 個別実装（`l?.role === 'self'`でrole名に依存し、εも素の`>`）の**どちらも**本モジュールが
 * 廃した規約に反していた。本関数は`baseLayerOf`（z原点に最も近い層＝自階。role名を見ない）と
 * `layersAboveOf`（εを含む一般規則で自階より上の層を昇順に返す）だけを合成する薄いアダプタで、
 * 独自の比較式を持たない——`baseLayerOf`/`layersAboveOf`は`.layer.floorZMm`しか読まないため、
 * 生の層をそのまま`{layer}`（`LayerInfo`のroom/floorZ/ceilZを持たない最小形）へ包んで渡せる。
 *
 * 同一floorZMmの層が複数あるとき（物理的には同じ絶対高さの階が複数あるという退化例。実データでは
 * 生じない前提）は**入力配列内で先に現れたもの**を返す——`orderLayerStack`の安定ソートが同値を
 * 入力順のまま残すため、`layersAboveOf`が返す配列も同値の先頭は入力順で決まる。
 * `compareLayerPriority`は`|floorZMm|`と符号しか見ないため同値では常に0を返し優劣を付けられず、
 * 使えない——したがって「入力配列の順序に依存する、決定的だが恣意的な規則」であることを明示する。
 * @param {Array<{graph:object, floorZMm:number, role?:string}>} layers
 * @returns {{graph:object, floorZMm:number, role?:string}|null}
 */
export function layerDirectlyAboveSelf(layers) {
  const stack = orderLayerStack((layers ?? []).map(layer => ({ layer })));
  const self = baseLayerOf(stack);
  if (!self) return null;
  return layersAboveOf(stack, self)[0]?.layer ?? null;
}

/**
 * 同距離の候補が競合したときの層の優先順位（負ならaが優先）。
 * 「帯自身の階（z原点）に近い層を優先し、同距離なら上側（地上側）を優先」——旧ROLE_ORDER表
 * `{self:0, above:1, below:2}`と2層構成では完全に同値で、層数に依らず定義できる一般形。
 * @param {LayerInfo} a
 * @param {LayerInfo} b
 * @returns {number}
 */
export function compareLayerPriority(a, b) {
  const za = a.layer.floorZMm, zb = b.layer.floorZMm;
  return (Math.abs(za) - Math.abs(zb)) || ((za < 0 ? 1 : 0) - (zb < 0 ? 1 : 0));
}

/**
 * 見えがかり壁（kind:'wall'候補）のz上限（§5.6・実機フィードバック第3弾A2の一般化）。
 *
 * **天井から上階FLまで（天井裏）にある面も「壁」扱いする**（ユーザー明示指示2026-08の点4）——
 * 壁は天井で終わるのではなく上階の床まで立っているため、上限は自層の天井ではなく**上階のFL**。
 * これにより「CHの上が天井裏なら同じ壁が同じ距離で続く」＝`emitColumns`の一般規則
 * （距離が変わるところにだけ見えがかり線を描く）が自動的に「CHに線を描かない」を導く
 * ——CH専用の例外を持たずに済む、というのがこの設計の要点。
 *
 * さらに「上が吹抜けなら壁は上階の天井までそのまま続く」を、**自層に限らず全ての層の壁**へ、
 * かつ**吹抜けが続く限り何層でも**登って適用する（旧実装はself層の壁だけを対象に上階1段だけを
 * 見ていたため、3層以上の吹抜けや上階側の壁で誤ったキャップ線が残った）。実Room
 * （VOID/STAIR_VOID以外）＝上階に実床があればそこで止める。
 * cutAlong/cut（切断壁）は対象外（壁自身のkneeDrop/実存在範囲を維持）。
 *
 * **ただし「上階にその壁が続いていない」なら上階のFLで止める**（ユーザー実機指摘2026-09
 * 「「6」C: X3から1500、2FLから2階天井断面まで縦線は不要」「2階のバツの右側頂点は
 * 上がX2-2階天井断面、下がX2-2FL」）——吹抜けを登る規則は「壁がそこに立っている」ことが前提で、
 * 上階の平面にその壁が無ければ、壁面を上階まで描くのは平面照合のない描画になる。
 * 実機は1階の壁（Y1から3500・X2〜X3から1500）の上に2階の壁が無く、階段の吹抜け（stairVoid）
 * ごしに壁面が2階天井まで伸びていた。
 * @param {LayerInfo[]} stack - orderLayerStackの結果
 * @param {LayerInfo} info - この壁候補を見つけた層
 * @param {(upper:LayerInfo)=>object|null} roomAtLayer - 壁の位置でその層の所有Roomを1点プローブする
 * @param {number} fallbackZ - 上位層のceilZが求まらない防御的ケースの最終フォールバック
 * @param {(upper:LayerInfo)=>boolean} [wallContinuesAt] - その層にこの壁が続いているか
 *   （既定=常にtrue＝従来どおり吹抜けを天井まで登る）
 * @returns {number}
 */
export function resolveSightlineTopZ(stack, info, roomAtLayer, fallbackZ, wallContinuesAt = () => true) {
  let topZ = info.ceilZ;
  for (const upper of layersAboveOf(stack, info)) {
    // **上階に実床があれば、その手前の天井で見えがかりは終わる**（ユーザー実機指摘2026-08
    // 「「5」D1: 1F天井見えがかり（細線）が…1FL天井断面に衝突するまで」）——天井裏（自層の
    // 天井〜上階FL）にも壁の実体はあるが、**見えがかりは見えるものだけ**で、天井に隠れて
    // 見えない。旧実装は上階に実床がある場合でも上階FLまで伸ばしており、列の描画範囲が
    // 天井より高い（吹抜けを通して上まで描く列）と、その天井裏ぶんまで壁面が続いて見え、
    // 天井の見えがかり線が出なかった。区間2400..3000は`probeColumn`が天井懐（slab・非描画）に
    // 分類する。
    if (isRealRoom(roomAtLayer(upper))) break;
    const upperFloorZ = Number.isFinite(upper.floorZ) ? upper.floorZ : upper.layer.floorZMm;
    // **上階にこの壁が無ければ、そこで壁は終わる**（上記）——吹抜けごしに見えるのは
    // 上階のFL（床スラブの縁）までで、その上に壁面は無い。
    if (!wallContinuesAt(upper)) {
      if (Number.isFinite(upperFloorZ)) topZ = Math.max(topZ, upperFloorZ);
      break;
    }
    // 上が吹抜けで、かつ壁が続いているなら上階の天井まで（天井裏ぶんも含めて見える）。
    topZ = Math.max(topZ, Number.isFinite(upperFloorZ) ? upperFloorZ : topZ,
      upper.ceilZ ?? fallbackZ);
  }
  return topZ;
}
