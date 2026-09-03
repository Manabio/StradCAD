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
 * @param {LayerInfo[]} stack - orderLayerStackの結果
 * @param {LayerInfo} info - この壁候補を見つけた層
 * @param {(upper:LayerInfo)=>object|null} roomAtLayer - 壁の位置でその層の所有Roomを1点プローブする
 * @param {number} fallbackZ - 上位層のceilZが求まらない防御的ケースの最終フォールバック
 * @returns {number}
 */
export function resolveSightlineTopZ(stack, info, roomAtLayer, fallbackZ) {
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
    // 上が吹抜けなら壁はそのまま上階の天井まで続く（天井裏ぶんも含めて見える）。
    const upperFloorZ = Number.isFinite(upper.floorZ) ? upper.floorZ : upper.layer.floorZMm;
    topZ = Math.max(topZ, Number.isFinite(upperFloorZ) ? upperFloorZ : topZ,
      upper.ceilZ ?? fallbackZ);
  }
  return topZ;
}
