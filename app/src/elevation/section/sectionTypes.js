/**
 * 2.5D断面エンジン: 型定義（JSDoc）・world↔断面ローカルx・z↔描画y変換（純関数のみ）。
 * 設計意図は architect承認済みの実装指示書（section-engine-design.md。タスク発注時の
 * スクラッチパスに格納。§番号はそちらを参照）参照。関連する現行仕様は
 * .claude/elevation-model.md「階をまたぐ2層帯」節。
 *
 * WP-E1（sectionTypes.js + sectionProbe.js）。WP-E5bでelevationStairSequence.js/
 * sectionStair.js/switchbackCuts.jsから呼ばれるようになった。純モジュール不変条件
 * （store.js/snap.js/*.jsx/react-konva/appViewport.js を静的importしない）を維持する。
 *
 * 高さはこのモジュール以下すべて「絶対z（上が正・設置階FL=0基準）」で扱い、プリミティブ化の
 * 最後（sectionEmit.js）でのみ y=-z へ変換する（§2項目6）。
 */

/**
 * @typedef {{ isVertical:boolean, axisValue:number, lo:number, hi:number }} CutLine
 *   既存faceの (isVertical, axisCL.value, lo, hi) と同型。isVertical=trueは切断線自身が
 *   固定X（axisValue）・Y方向(lo..hi)に伸びることを表す（faceの規約と同じ）。
 */

/**
 * @typedef {{
 *   seqNo: string,
 *   line: CutLine,
 *   viewSign: 1|-1,
 *   dirSign: 1|-1,
 *   layers: Array<{graph:object, floorZMm:number, role:'self'|'above'|'below'}>,
 *   zRange: {loZ:number, hiZ:number},
 *   baseFloorZ: number,
 *   stairCut?: object,
 *   chDimSplitAbsYs?: number[],
 *   anchorRoom?: object,
 * }} SectionCut
 */

/**
 * @typedef {{
 *   kind: 'cut'|'wall'|'open'|'slab',
 *   z0:number, z1:number,
 *   wall?:object, layerRole?:string, distMm?:number, ownerRoom?:object,
 *   floorZ?:number, ceilZ?:number, thicknessMm?:number,
 *   nearEdgeOpen?:boolean, farEdgeOpen?:boolean,
 *   openingPassThrough?:boolean,
 * }} ZBand
 *   slab=床スラブ・天井懐（今回は非描画）。z0<z1（絶対z）。
 */

/**
 * @typedef {{ x0:number, x1:number, worldLo:number, worldHi:number,
 *   bands:ZBand[], loCLId?:string, hiCLId?:string }} SectionColumn
 */

/**
 * cut.line の run方向（isVerticalならY、falseならX）で、図のx=0に対応する世界座標
 * （dirSignの向きに応じてline.lo/hiのどちらかが起点になる。faceのoriginWorldと同じ規約）。
 * @param {SectionCut} cut
 * @returns {number}
 */
export function cutOriginWorld(cut) {
  return cut.dirSign > 0 ? cut.line.lo : cut.line.hi;
}

/**
 * world座標（cut.lineのrun方向の値）→ 断面ローカルx（elevationFigure.jsのlocalXOf(face,coord)と
 * 同じ式。cutは面ではなく別の型のため、section/配下に独立実装として持つ——faceの
 * originWorld/dirSignの一般化であり、section/がelevationFigure.jsへ依存する必要はない）。
 * @param {SectionCut} cut
 * @param {number} worldCoord
 * @returns {number}
 */
export function localXOf(cut, worldCoord) {
  return (worldCoord - cutOriginWorld(cut)) * cut.dirSign;
}

/**
 * 断面ローカルx → world座標（localXOfの逆写像）。
 * @param {SectionCut} cut
 * @param {number} localX
 * @returns {number}
 */
export function worldOf(cut, localX) {
  return cutOriginWorld(cut) + localX * cut.dirSign;
}

/**
 * その切断の描画範囲（断面ローカルx。`cut.line.lo..hi` ＋ 壁のない端部の探査延長
 * `probeExtendLo/HiMm`）。**面の外に断面（梁・ささら・踊り場桁枠の矩形）を描かない**ための
 * 共通判定の単一情報源（ユーザー実機指摘2026-08「6」。面が0..2885なのに x=-57.5 や x=2942.5、
 * さらに別スパンの梁が x=-6882.5 に描かれていた）。
 * @param {SectionCut} cut
 * @returns {{lo:number, hi:number}}
 */
export function cutDrawRange(cut) {
  const line = cut.line;
  const a = localXOf(cut, line.lo - (line.probeExtendLoMm ?? 0));
  const b = localXOf(cut, line.hi + (line.probeExtendHiMm ?? 0));
  return { lo: Math.min(a, b), hi: Math.max(a, b) };
}

/**
 * 絶対z（上が正）→ 描画y（下向き正のy=-z。展開図の既存プリミティブ座標系）。
 * プリミティブ化の最後（sectionEmit.js）にのみ使う（§2項目6。エンジン内部はzのまま扱う）。
 * @param {number} z
 * @returns {number}
 */
export function zToY(z) { return -z; }
