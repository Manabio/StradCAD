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
import { GAP_EPS_MM as GAP_EPS } from '../elevationStyle.js';

/**
 * @typedef {{ isVertical:boolean, axisValue:number, lo:number, hi:number }} CutLine
 *   既存faceの (isVertical, axisCL.value, lo, hi) と同型。isVertical=trueは切断線自身が
 *   固定X（axisValue）・Y方向(lo..hi)に伸びることを表す（faceの規約と同じ）。
 *   probeExtendLo/HiMm（任意）… 壁のない端部で図の外へ伸ばす量。`cutDrawRange`の情報源。
 *   unionExtendLo/HiMm（任意。既定=probeExtendLo/HiMm）… **探査だけ**を広げる量＝全層の
 *   探査窓（`SectionCut.layerRunWindows`）の和。層ごとに面の端が違うため（下記）、実際に
 *   レイキャストする範囲は`cutDrawRange`より広くなりうる。
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
 *   airRoom?: object,
 *   underRooms?: Set<object>,
 *   layerRunWindows?: Map<object,{lo:number,hi:number}>,
 *   floorZProfile?: Array<{loX:number, hiX:number, floorZ:number}>,
 *   chDimSplitAbsYs?: number[],
 *   anchorRoom?: object,
 * }} SectionCut
 *   airRoom（任意。展開図一般化Phase 6）… その帯自身の空気ボリュームを代表するRoom
 *   （階段帯なら階段室。`section/cuts/switchbackCuts.js`が設定）。
 *   underRooms（任意。展開図一般化Phase 6）… 階段下に指定された部屋の集合（同上が設定）。
 *   `section/sectionHits.js`の`isHiddenWall`が、壁の両側のセルのRoomを見て、片側だけが
 *   `underRooms`に含まれ、かつその反対側が`airRoom`の連結成分と一致する壁を「実体ごと見ない」
 *   （階段下の閉じた部屋の壁は階段帯から見えない）判定に使う。どちらも未指定なら常に非隠蔽
 *   （従来どおり全ての壁が見える）。
 *   layerRunWindows（任意）… 層 → その層を探査してよい走り方向の世界範囲。**面の端は層ごとに
 *   違う**（自階の面は自階の壁で終わるが、同じ通りの上階の壁はその先へ続きうる）ことを表す
 *   付加データで、`cut.layers`配列自体は写さない（参照同一性とprobeCtxのキャッシュを壊さない）。
 *   生成は`sectionContent.js`の`withProbeExtension`、消費は`sectionProbe.js`。
 *   floorZProfile（任意）… `ceilProfile`の床側の双子（区間ごとの床断面高さ・断面ローカルx）。
 *   下階の層への探査窓のgate（`sectionContent.js`の`planeOverhangForFace`）だけが読む。
 *   layers[].ceilZMm（任意）… その層の天井z。**下階の層**のgateで「帯の床がその層の天井より
 *   下か」を見るために呼び出し側（帯）が載せる（層の部屋のCHは帯しか知らない）。
 */

/**
 * @typedef {{
 *   kind: 'cut'|'cutAlong'|'wall'|'open'|'slab'|'farVoid'|'hidden',
 *   z0:number, z1:number,
 *   wall?:object, layerRole?:string, distMm?:number, ownerRoom?:object,
 *   floorZ?:number, ceilZ?:number, thicknessMm?:number,
 *   nearEdgeOpen?:boolean, farEdgeOpen?:boolean,
 *   openingPassThrough?:boolean,
 *   farFloorZ?:number|null, farCeilZ?:number|null, farDepthMm?:number,
 * }} ZBand
 *   hidden（展開図一般化Phase 6b-2。`sectionHits.js`の`isHiddenWall`該当の実体）＝
 *   「そこに壁は実在するが描かない」区間。`wall`/`distMm`/`openingPassThrough`/`far*`等の
 *   付帯情報は一切持たない（他kindと違い実体の詳細を渡さない、という宣言そのもの）。
 *   `open`（アキ）とは別kind——アキのバツ・見えがかり線の対象にならず、かつ`overCutWall`
 *   （切断壁の天端の上はアキではない、の判定）にも当たらない独立したkindとして扱う。
 *   slab=床スラブ・天井懐（今回は非描画）。z0<z1（絶対z）。
 *   farVoid（Phase4。`elevationStyle.js`の`HORIZONTAL_FACES_ENABLED`。裁定済み2026-09-11・
 *   既定on）＝floorFace/ceilFaceより向こう側（向こうの部屋の天井懐・床構造）の非描画区間。
 *   slabと同じ「非描画」だが実体の所有者情報（ownerRoom/floorZ/ceilZ）を持たないため別kindにした
 *   （`sectionEngine.js`の`splitOpenByFarFace`が生成。`emitColumns`/`emitOpenGapMarks`はどちらも
 *   `'open'`しか見ないため、このkindは自動的に「線を描かずアキにもしない」）。
 *   `open`のfarFloorZ/farCeilZ/farDepthMm（Phase4）＝`sectionHits.js`の`visibleBandsOf`が
 *   付帯情報として載せる「上限内の最も近いfloorFace/ceilFaceのzと深度」（`splitOpenByFarFace`の
 *   入力）。フラグoffでは常にundefined。
 */

/**
 * @typedef {{ x0:number, x1:number, worldLo:number, worldHi:number,
 *   bands:ZBand[], loCLId?:string, hiCLId?:string }} SectionColumn
 */

/**
 * その列に「z（＝上階のFL）からそのまま立ち上がる切断壁」の帯があるか。
 *
 * 「上階の床の断面線は、境界に立つ切断壁の**断面の中**を通さない／壁の向こう側の面から
 * 描き始める」という既存規約（`sectionEmit.js`の`ceilStepSlabSection`）と、はり出し外端の
 * 判定（`sectionContent.js`の`upperFloorCutWallEndsOf`）は**同じ1つの問い**なので、述語も
 * εもここへ一本化する（別々に書くと片方だけ腰壁の中を線が通る）。
 *
 * 見るのは`kind==='cut'`だけ——面と**平行**な壁（`kind==='cutAlong'`＝縦断された壁）は端の外縁を
 * 決めないため**意図的に除外**する。`sectionEngine.js`の`isCutBand`等が`cutAlong`を含むのとは
 * **別の問い**（あちらは「その帯を断面として扱うか」、こちらは「上階の床の断面線をどこから
 * 描き始めるか＝その列の外縁が床の小口の起点になるか」）。`ceilStepSlabSection`との同値性を
 * 保つため、片方だけ`cutAlong`を足してはいけない。
 * @param {SectionColumn|undefined} column
 * @param {number} z - 絶対z（上階のFL）
 * @returns {boolean}
 */
export function hasCutWallStandingOn(column, z) {
  if (!column || !Number.isFinite(z)) return false;
  return (column.bands ?? []).some(b => b.kind === 'cut' && Math.abs(b.z0 - z) < GAP_EPS);
}

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
