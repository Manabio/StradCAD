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
 * `buildSectionFromLine`（sectionContent.js）の`opts`は、次の4群の交差型（ただし BandInjections の
 * gapFloorProfile・floorlessRanges・memberCeilZAt・memberSplitsGaps は`buildCutContent`専用で、`buildSectionFromLine`は転送しない）。形は平らなオブジェクトのまま
 * （群は読み手による分類で、キーの置き場所を変えるものではない）。契約は`sectionTypes.test.js`が
 * 関数ごと（`buildSectionFromLine`／`buildCutContent`）の`opts.*`の読み取りとこの4群の`@property`の一致で固定する。
 * `buildCutContent`の`opts`はこのうち RenderStyle の全部と、CutSpec の endExtendMm・upperPlaneOverhang、
 * ProbeInputs の bandRoomBounds、BandInjections の gapBeamRects・gapFloorProfile・floorlessRanges・memberCeilZAt・memberSplitsGaps だけを読む。
 *
 * @typedef {object} CutSpec 切断の定義（どの線を・どの向きで・どのz範囲で切るか）
 * @property {1|-1} viewSign
 * @property {1|-1} dirSign
 * @property {{loZ:number, hiZ:number}} zRange
 * @property {string} [seqNo]
 * @property {number} [baseFloorZ] 既定 zRange.loZ
 * @property {object} [face] 面固有の値の供給元（`SectionCut.face`）
 * @property {object} [ends] 端の性質（`SectionCut.ends`）
 * @property {number} [endExtendMm] 壁のない端部の探査延長量
 * @property {Array<{z0:number,z1:number}>} [cornerOpeningZLo]
 * @property {Array<{z0:number,z1:number}>} [cornerOpeningZHi]
 * @property {boolean} [upperPlaneOverhang] 層ごとの探査窓を載せる
 * @property {object[]} [ceilProfile]
 * @property {object[]} [floorZProfile]
 * @property {object[]} [aboveCeilVisibleRanges]
 *
 * @typedef {object} ProbeInputs 層・探査（レイキャストの入力と、探査が参照する部屋の情報）
 * @property {object} [probeCtx] 省略時のみ`makeProbeContext(layers)`を組む
 * @property {object} [airRoom] その帯自身の空気ボリュームを代表する Room
 * @property {Set<object>} [underRooms] 階段下に指定された部屋の集合
 * @property {object|null} [bandRoomBounds] 帯の部屋の包絡矩形（世界座標の箱）
 *
 * @typedef {object} RenderStyle 体裁
 * @property {number} [scale] px/mm
 * @property {object|null} [lineWeightsPx]
 * @property {number} [baseboardMm] 巾木高さ（0＝引かない）
 *
 * @typedef {object} BandInjections 帯固有の注入
 * @property {object|null} [stairCut] 階段帯の階段寄与
 * @property {number[]} [chDimSplitAbsYs] 左CH寸法を分割する絶対y
 * @property {object[]|null|((pcut:object)=>object[])} [gapBeamRects] アキの手前に見える梁の矩形（部屋帯）。**帯が持たない部材（dropped）だけ**
 *   （帯が持つ梁は memberCut の obstructionRects・memberFace の gapPass が担う。U1b B4）。関数は列の分割の後に
 *   切断（pcut）を受けて返す（帯が持たない部材の判定が列の分割の後に決まるため。U1b B3-1）
 * @property {Array<[number,number]>|null} [gapFloorProfile] アキのセルの下限にする断面線（階段帯）
 * @property {Array<{lo:number,hi:number}>} [floorlessRanges] 床の無い列（下階の階段の吹抜け。階段帯。`buildCutContent` 専用。梁の断面の輪郭を
 *   床の遮蔽が丸ごと描く／描かないの単位で判定する入力。U1b B3-1）
 * @property {((x:number, y:number)=>number|null)|null} [memberCeilZAt] その位置（world の x, y）の天井 z（階段室の裏面など。階段帯。
 *   `buildCutContent` 専用）。梁の見え掛かり（memberFace）は下端がこれ以上の位置では積まない＝天井裏（U1b B3-2）
 * @property {boolean} [memberSplitsGaps] false で梁の見え掛かりがアキのセルを割らない（階段帯 R5。`buildCutContent` 専用。省略・true は割る。U1b B3-2）
 * @property {Array<{graph:object, floorZMm:number, role:string}>} [memberLayers] 梁の断面（memberCut）の候補を作る層（部屋帯は上階つき。
 *   省略は `layers`。`SectionCut.memberLayers`）
 * @property {boolean} [memberFromRoomSide] 梁の断面の続きを室内側で見る（面を見る帯。`SectionCut.memberFromRoomSide`）
 */

/**
 * @typedef {{
 *   seqNo: string,
 *   line: CutLine,
 *   viewSign: 1|-1,
 *   dirSign: 1|-1,
 *   layers: Array<{graph:object, floorZMm:number, role:'self'|'above'|'below'}>,
 *   memberLayers?: Array<{graph:object, floorZMm:number, role:'self'|'above'|'below'}>,
 *   zRange: {loZ:number, hiZ:number},
 *   baseFloorZ: number,
 *   stairCut?: object,
 *   airRoom?: object,
 *   underRooms?: Set<object>,
 *   layerRunWindows?: Map<object,{lo:number,hi:number}>,
 *   floorZProfile?: Array<{loX:number, hiX:number, floorZ:number}>,
 *   chDimSplitAbsYs?: number[],
 *   anchorRoom?: object,
 *   face?: object,
 *   ends?: {openLo:boolean, openHi:boolean, wallLessLo:boolean, wallLessHi:boolean,
 *     cornerOpeningZLo?:Array<{z0:number,z1:number}>, cornerOpeningZHi?:Array<{z0:number,z1:number}>},
 *   openGapMarks?: boolean,
 *   ceilClip?: Array<{loX:number, hiX:number, ceilZ:number, ceilZHi?:number}>,
 * }} SectionCut
 *   memberLayers（任意。展開図リファクタ U1b）… 探査の候補収集（`sectionHits.js addMemberHits`）が梁・柱の立体を作る層。
 *   無ければ`layers`を使う（B1。渡す呼び出し側は未実装）。壁の層スタック（`layers`）は変えず、梁・柱専用の層だけを別に持てる。
 *   ceilClip（任意。E5の受け口）… `ceilProfile`と同形（断面ローカルx）の**打ち切り専用**の天井断面。
 *   列の分割（`withCeilProfileBreaks`）・列の天井（`ceilZ`/`ceilEdge`）・斜線を頭打ちにする列境界
 *   （`collectCutBreaks`の`slopeLevels`）だけが `ceilProfile ?? ceilClip` で読む。帯の性格判定
 *   （`ceilStepSlabSection`の入力契約・`layerRunWindowsOf`のgate・`cellAt`の span分岐）は`ceilProfile`
 *   だけを見る——ceilProfileを付けると階段帯全体の性格が変わるため、階段帯が「天井の形だけ」を渡す口として
 *   分けた。`ceilProfile`があればそちらが勝つ。上階の床との取り合いの担当は帯の種類ではなく列のデータで決まる
 *   （`slabJunctionOf`の`slabTopIsRealFloor`。S10-3）。
 *   openGapMarks（任意）… false のときその切断の面にアキのバツ・「ア キ」を標記しない
 *   （`emitOpenGapMarks`が空配列を返す）。未指定・true は従来どおり標記する。折返し階段の
 *   踊り場前縁の切断（seq1/seq3。`switchbackCuts.js`）が false（ユーザー指示2026-10-07
 *   「踊場、回転部に『アキ』は不要」）。
 *   face（任意）… 面固有の値の供給元（展開図一般化Phase 8で「面を要求しない」よう`opts`へ
 *   降格した。`sectionContent.js`内で直読みするのは`layerRunWindowsOf`のみ。ほかに
 *   `sectionStructure.js:166`（半壁厚の許容。`cut.face`が無ければ0）・`:299`（`faceAxis`。
 *   `cut.face`が無ければ`line.axisValue`にフォールバック）・`elevationStairSequence.js:567`
 *   （はり出し基準。`pcut.face`が無ければ両端とも拡張込みの基準）が読む——いずれもQA是正
 *   コメントの示すとおり`face`欠如時のフォールバックを持つ）。
 *   ends（任意。展開図一般化Phase 8）… ローカルx=0側/run側の端の性質（openLo/Hi＝
 *   `face.hasWallAtLocal0/Run===false`、wallLessLo/Hi＝`wallLessEndAt(face,'0'/'Run')`と同値）。
 *   `buildSectionFromLine`（`sectionContent.js`）が唯一の生成元——`withProbeExtension`・
 *   `emitCtxForCut`はこちらを優先して読み、無い手組みcutだけ`face`から導出する。
 *   cornerOpeningZLo/Hi（任意。既定[]）… その端の隅で建具断面を描く建具の開口z範囲（切断のz基準＝
 *   帯のz。端の区間の床高さ込み）。端の列の凹み側面線（recessLo/Hi）はこの範囲を描かない。
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
 *   openingPassThrough?:boolean, opening?:object, openingWallRange?:{lo:number, hi:number},
 *   farStair?:boolean,
 *   farFloorZ?:number|null, farCeilZ?:number|null, farDepthMm?:number,
 *   profiledTop?:boolean, topEdge?:{zAtLo:number, zAtHi:number}|{zAtX0:number, zAtX1:number},
 *   ceilEdge?:{zAtX0:number, zAtX1:number},
 * }} ZBand
 *   openingWallRange（切断壁で三方枠の建具が通る帯だけ。`sectionHits.js`が付ける）＝その建具のホスト壁の
 *   両仕上げ面の範囲（壁厚方向の世界座標）。三方枠の断面は壁全体を包むので、帯の壁1枚の材の範囲の代わりに使う。
 *   ceilEdge（切断壁の帯だけ。`sectionEngine.js`の`clipBandsToVisible`が付ける）＝その列の天井断面が
 *   傾いている（列の`ceilEdge`）とき、天端が天井の斜線に沿う帯の、列の両端（図のx0側/x1側）での高さ。
 *   `topEdge`（隔て壁自身の斜めの天端。probeが決める）とは別の意味なので流用しない。帯の z1 は斜線の高い側。
 *   hidden（展開図一般化Phase 6b-2。`sectionHits.js`の`isHiddenWall`該当の実体）＝
 *   「そこに壁は実在するが描かない」区間。`wall`/`distMm`/`openingPassThrough`/`far*`等の
 *   付帯情報は一切持たない（他kindと違い実体の詳細を渡さない、という宣言そのもの）。
 *   `open`（アキ）とは別kind——アキのバツ・見えがかり線の対象にならず、かつ`overCutWall`
 *   （切断壁の天端の上はアキではない、の判定）にも当たらない独立したkindとして扱う。
 *   slab=床スラブ・天井懐（今回は非描画）。z0<z1（絶対z）。
 *   farVoid（Phase4。裁定済み2026-09-11・既定on）＝floorFace/ceilFaceより向こう側
 *   （向こうの部屋の天井懐・床構造）の非描画区間。
 *   slabと同じ「非描画」だが実体の所有者情報（ownerRoom/floorZ/ceilZ）を持たないため別kindにした
 *   （`sectionEngine.js`の`splitOpenByFarFace`が生成。`emitColumns`/`emitOpenGapMarks`はどちらも
 *   `'open'`しか見ないため、このkindは自動的に「線を描かずアキにもしない」）。
 *   `open`のfarFloorZ/farCeilZ/farDepthMm（Phase4）＝`sectionHits.js`の`visibleBandsOf`が
 *   付帯情報として載せる「上限内の最も近いfloorFace/ceilFaceのzと深度」（`splitOpenByFarFace`の
 *   入力）。該当が無ければ常にundefined。
 *   `open`のfarStair（`sectionEngine.js`の`buildColumns`が付ける）＝面の向こう側（面の軸CLから視線方向）の
 *   部屋が階段室（`RoomFeature.STAIR`）。抜けは階段室への通路なので`emitOpenGapMarks`はアキを標記しない。
 *   profiledTop（壁の天端プロファイル＝隔て壁の斜め天端を持つ壁の帯。cut/cutAlong/wall）＝天端は
 *   腰壁の笠木ではないため、天端の下の細線（kneeCap）を描かない。topEdge（wall帯だけ）＝斜めの天端の線の
 *   両端の高さ。probe直後（sectionHits.js）は世界座標の lo/hi 側＝{zAtLo, zAtHi}、列（SectionColumn）の帯は
 *   図のローカルx（x0側/x1側）＝{zAtX0, zAtX1}（buildColumnsが向き＝dirSignに合わせて入れ替える）。
 *   帯の z1 は天端の高い側（斜線は z1 を超えない）。
 */

/**
 * @typedef {{ x0:number, x1:number, worldLo:number, worldHi:number,
 *   bands:ZBand[], loCLId?:string, hiCLId?:string,
 *   ceilZ?:number, ceilEdge?:{zAtX0:number, zAtX1:number} }} SectionColumn
 *   ceilZ＝その列の天井断面の高さ（傾いていれば低い側。打ち切りは低い側で水平）。ceilEdge＝天井断面が
 *   傾いている列だけ付く、列の両端（図のx0側/x1側）での天井の高さ。
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
 * その帯の種類が「実体」（展開図一般化Phase 6b-2 設計(d)の「囲む実体」＝
 * `slab ∪ cut ∪ cutAlong`）か。`wall`（通常の見えがかり壁）・`hidden`（そこに壁は実在するが
 * 描かない区間。§5.10で階段の占有形状が遮蔽物として参加する側に回ったため実体には含めない）・
 * `open`・`farVoid`は対象外。`solidRectsOf`が使う単一の述語（列挙を1箇所にする）。
 * `band`はnullを許容しない契約（呼び出し側は必ず`col.bands`の要素を渡す。列自体の非null防御は
 * `solidRectsOf`側の`columns ?? []`が担う——`nearestSightlineDistMm`と同じ役割分担）。
 * @param {import('./sectionTypes.js').ZBand} band - 非null
 * @returns {boolean}
 */
export function isSolidBand(band) {
  return band.kind === 'slab' || band.kind === 'cut' || band.kind === 'cutAlong';
}

/**
 * 連続する列にまたがる同一の帯を1つのrun（x範囲）へまとめる（キーが一致し、かつ列が隣接する
 * 場合のみ連結する）。QA是正（2026-09-13・F4）: `sectionEmit.js`の同名関数の逐語コピーだった
 * ものをここへ移設し、`sectionEmit.js`側はこの関数をimportして使う（単一情報源化）。
 * @param {SectionColumn[]} columns
 * @param {string} kind
 * @param {(band:ZBand)=>*} keyOf - 同一性のキー（cut帯は壁参照、slab帯はz範囲）
 */
export function bandRuns(columns, kind, keyOf) {
  const runs = [];
  columns.forEach((col, i) => {
    for (const b of col.bands ?? []) {
      if (b.kind !== kind) continue;
      const key = keyOf(b);
      const open = runs.find(r => r.key === key && r.lastIndex === i - 1);
      if (open) { open.x1 = col.x1; open.lastIndex = i; }
      else runs.push({ key, band: b, x0: col.x0, x1: col.x1, lastIndex: i });
    }
  });
  return runs;
}

// 2つのslab帯が**同じ層の床**か（`sectionProbe.js`の`slabBandOf`が層のfloorZをそのまま持たせる）。
// 手書き列（単体テスト）のようにfloorZを持たない帯どうしは「同じ」とみなす。
// QA是正（2026-09-13・F4）: `sectionEmit.js`から移設（単一情報源化）。
function sameSlabOwner(a, b) {
  if (!Number.isFinite(a.floorZ) || !Number.isFinite(b.floorZ)) {
    return !Number.isFinite(a.floorZ) && !Number.isFinite(b.floorZ);
  }
  return Math.abs(a.floorZ - b.floorZ) < GAP_EPS;
}

/**
 * スラブの走り（`bandRuns`の'slab'）。ただし**所有層が同じでzが連続するslab帯は1本のスラブ**
 * として数える（同じ1枚の床構造が、腰壁の切断高のような物理境界でない値でzBreaksが割り込むと
 * 2つの走りに割れてしまうのを防ぐ）。所有層が違う隣接slab（1階の天井懐と2階の床構造）は
 * **結合しない**——その境界（2FL）は実体の境界そのものだから。詳細な経緯は
 * `sectionEmit.js`のQA是正コメント（実機「6」C・「5」D1・B）参照。
 * QA是正（2026-09-13・F4）: `sectionEmit.js`から移設し、`solidRectsOf`も同じ関数を引く
 * （単一情報源化。移設前は`solidRectsOf`が縦マージ無しの簡易版を独自に持っていた）。
 * @param {SectionColumn[]} columns
 * @returns {{key:string, band:ZBand, x0:number, x1:number}[]}
 */
export function slabRuns(columns) {
  const merged = columns.map(col => {
    const bands = [];
    for (const b of col.bands ?? []) {
      const last = bands[bands.length - 1];
      if (b.kind === 'slab' && last?.kind === 'slab'
        && Math.abs(last.z1 - b.z0) < GAP_EPS && sameSlabOwner(last, b)) {
        bands[bands.length - 1] = { ...last, z1: b.z1 };
        continue;
      }
      bands.push(b);
    }
    return { ...col, bands };
  });
  return bandRuns(merged, 'slab', b => `${b.z0}|${b.z1}`);
}

// 切断壁の断面をz範囲で（壁参照ではなく）まとめる。**壁は片面ずつのWallオブジェクトとして
// 持つデータモデル**のため、実機の袖壁1枚が2つのWallに分かれており、壁参照でまとめると同じ
// 断面が2つのrunに割れてしまう——同じz範囲で連続する列は1枚の壁の断面とみなす。
// QA是正（2026-09-13・F4）: `sectionEmit.js`から移設（単一情報源化）。
// 天端が天井の斜線に沿う帯（`ceilEdge`）は列ごとに上端 z1 が違うので、z1 ではなく「斜線に沿う」で束ねる。
export function cutWallRuns(columns) {
  return bandRuns(columns, 'cut', b => `${b.z0}|${b.ceilEdge ? 'ceilEdge' : b.z1}`);
}

/**
 * `cutRun`（`cutWallRuns`の1件）が`slabRun`（`slabRuns`の1件）の**上に立っている**か
 * （壁の下端＝スラブの上端。GAP_EPS内で一致）。立っていなければ`null`。立っていれば、壁の
 * footprintのうちスラブに近い面`nearX`と、その**向こう側の面**`farX`を返す——壁の
 * footprintはスラブのrunとxで重なりうる（壁の厚みぶんスラブの縁へ食い込む）ため、
 * 「cutRunがslabRunのx範囲の外に完全に出ている」という前提は置かない（`slabOnLoSide`＝
 * runの始点どうしの前後関係で決める）。
 * QA是正（2026-09-13第2ラウンド・F3〈farX判定の重複解消〉）: `sectionEmit.js`の
 * `slabEdgeCutWallJunction`と本ファイルの`solidRectsOf`が同じ式（同じGAP_EPS・同じ
 * 比較対象）をそれぞれ複製していたのをこの1関数へ一本化した。
 * @param {{x0:number, x1:number, band:{z0:number,z1:number}}} slabRun
 * @param {{x0:number, x1:number, band:{z0:number,z1:number}}} cutRun
 * @returns {{nearX:number, farX:number, slabOnLoSide:boolean}|null}
 */
export function farXOfCutOnSlab(slabRun, cutRun) {
  if (Math.abs(cutRun.band.z0 - slabRun.band.z1) > GAP_EPS) return null;
  const slabOnLoSide = slabRun.x0 < cutRun.x0 - GAP_EPS;
  const nearX = slabOnLoSide ? cutRun.x0 : cutRun.x1;
  const farX  = slabOnLoSide ? cutRun.x1 : cutRun.x0;
  return { nearX, farX, slabOnLoSide };
}

// 手前が空気（切断線の位置に実体が無い）とみなす帯か——`slabJunctionOf`の小口判定用。
// `open`/`farVoid`（アキ・遠側の面の向こう）・`wall`（見えがかり壁＝手前は空気）・
// `hidden`のうち**見えがかり由来**（`hiddenOf:'wall'`。2a壁＝この帯では実体として数えない）。
// 切断壁由来のhidden（`hiddenOf:'cut'`）は切断線上に実体がある＝断面の中なので空気ではない。
// 出自を持たないhidden（手書き列・旧データ）は見えがかり由来とみなす（実データの4件はすべて
// wall由来。2026-09-13実測）。
function isAirBand(band) {
  // 梁の断面（memberCut）は梁が無かったら選ばれていた帯（behind）で見る（梁は手前の空気を塞ぐ実体ではなく、従来は帯に出なかった）
  if (band.kind === 'memberCut') return band.behind === 'open' || band.behind === 'wall' || band.behind === 'farVoid';
  // 梁の見え掛かり（member。U1b B3-2）は切断面の後ろにある実体＝切断線の位置は空気（壁の見えがかりと同じ）
  if (band.kind === 'open' || band.kind === 'farVoid' || band.kind === 'wall' || band.kind === 'member') return true;
  return band.kind === 'hidden' && (band.hiddenOf ?? 'wall') === 'wall';
}

/**
 * スラブの**上面が実在する床**か（`slabJunctionOf`の関門）。見かけだけのスラブ（上階が吹抜けで床が
 * 無いのに、天井〜上階FLが天井懐のslab帯に分類される列。`upperFloorZ === null`）の上に壁が載っても、
 * そこに床の小口は立たない（ユーザー確定「吹抜けには天井断面まで水平断面が無い」）。
 * 見る列＝スラブの走りのうち`hit.nearX`にスラブ側から接する列。真になる条件（どれか）:
 *  (1) `upperFloorZ`が未定義（手書きの列。`isAirBand`の「出自なしは見えがかり由来」と同じ慣例の素通し）
 *  (2) `upperFloorZ`が有限で、スラブの上面z1と一致（上階の実在の床）
 *  (3) スラブ帯の`floorZ`が有限で、z1と一致（自階の床構造。下階に階段がある階の床の取り合い）
 * @param {SectionColumn[]} columns
 * @param {{x0:number, x1:number, band:{z0:number,z1:number,floorZ?:number}}} slabRun
 * @param {{nearX:number, slabOnLoSide:boolean}} hit
 * @returns {boolean}
 */
export function slabTopIsRealFloor(columns, slabRun, hit) {
  const c = (columns ?? []).find(col => (hit.slabOnLoSide
    ? Math.abs(col.x1 - hit.nearX) < GAP_EPS
    : Math.abs(col.x0 - hit.nearX) < GAP_EPS)
    && col.x0 >= slabRun.x0 - GAP_EPS && col.x1 <= slabRun.x1 + GAP_EPS);
  if (!c) return true; // 見る列が無い（手書き・走りの外）は従来どおり
  if (c.upperFloorZ === undefined) return true;
  const z1 = slabRun.band.z1;
  if (Number.isFinite(c.upperFloorZ) && Math.abs(c.upperFloorZ - z1) < GAP_EPS) return true;
  const floorZ = slabRun.band.floorZ;
  return Number.isFinite(floorZ) && Math.abs(z1 - floorZ) < GAP_EPS;
}

/**
 * `cutRun`が`slabRun`の縁に立ち、その**向こう側に小口が見える**取り合い（`farXOfCutOnSlab`＋
 * 空気のgate）。立っていない・向こう側が空気でなければ`null`。
 *
 * gate（ユーザー裁定2026-09-13「6」C: 「X3の踊り場ささら断面…腰壁天端で折り返して2FL床断面、
 * はりだしで囲まれる範囲は壁・天井内部。したがって内部はクリップされて描画しない」）:
 * 壁の向こう側の面（farX）の**その先の列**で、スラブのz範囲**全体**が探査済みの空気の帯
 * （`isAirBand`）で覆われていなければ、スラブはそこで終わっていない——列が無い（探査窓の外＝
 * 未知）なら実体とも空気とも言わない（`sectionHits.js`の`unexploredBelowZOf`と同じ境界の引き方:
 * 「未知」を「アキ」にしない）。z範囲の一部だけが空気（残りが`slab`/`cut`）でも小口とは言わない
 * ——小口は断面の輪郭で、輪郭の途中に実体があるならそこは断面の中。
 * 実機「6」Cの左端は上階の腰壁だけがはり出し列に立ち、その下（自階の壁＋床構造）は自階の窓の外で
 * 未探査だった——そこへ「スラブが腰壁の向こう側まで延びる」と仮定して小口と1F天井線を描くと、
 * 壁断面の**内部**に線が入る。実機「6」B/D1（壁のない端部）は、腰壁の向こう側＝階段室側の列に
 * 見えがかり壁（B）／見えがかり由来のhidden（D1。2a壁）が探査済みで在るため従来どおり小口が立つ。
 * `slab`が続く／別の`cut`が立つ向こう側にも小口は無い（スラブが続いている・壁の中）。
 * `slabEdgeCutWallJunction`（`sectionEmit.js`）と`slabSolidRectsOf`（本ファイル）が**同じこの
 * 1関数**で「壁が載っているか・どこまで延ばすか」を決める（別々に書くと片方だけ壁の中へ
 * スラブが延びる）。
 * @param {SectionColumn[]} columns - x0昇順
 * @param {{x0:number, x1:number, band:{z0:number,z1:number}}} slabRun
 * @param {{x0:number, x1:number, band:{z0:number,z1:number}}} cutRun
 * @returns {{nearX:number, farX:number, slabOnLoSide:boolean}|null}
 */
export function slabJunctionOf(columns, slabRun, cutRun) {
  const hit = farXOfCutOnSlab(slabRun, cutRun);
  if (!hit) return null;
  if (!slabTopIsRealFloor(columns, slabRun, hit)) return null;
  const beyond = (columns ?? []).find(c => (hit.slabOnLoSide
    ? Math.abs(c.x0 - hit.farX) < GAP_EPS
    : Math.abs(c.x1 - hit.farX) < GAP_EPS));
  if (!beyond) return null;
  // スラブのz範囲から空気の帯を引いていき、残りが無ければ全体が空気。
  let rest = [{ z0: slabRun.band.z0, z1: slabRun.band.z1 }];
  for (const b of beyond.bands ?? []) {
    if (!isAirBand(b)) continue;
    rest = rest.flatMap(r => {
      if (b.z1 <= r.z0 + GAP_EPS || b.z0 >= r.z1 - GAP_EPS) return [r];
      const out = [];
      if (b.z0 > r.z0 + GAP_EPS) out.push({ z0: r.z0, z1: b.z0 });
      if (b.z1 < r.z1 - GAP_EPS) out.push({ z0: b.z1, z1: r.z1 });
      return out;
    });
  }
  return rest.every(r => r.z1 - r.z0 <= GAP_EPS) ? hit : null;
}

/**
 * スラブ（床構造・天井懐）の実体矩形（z空間・縮めない）。`slab`の矩形は、その縁に立ち
 * 向こう側に小口が見える`cut`壁の**向こう側の面**（farX）まで延ばす（`slabJunctionOf`。
 * `sectionEmit.js`の`slabEdgeCutWallJunction`が小口の縦線を立てるxと同一の規則・同一関数）。
 * `wall`（見えがかり壁。断面ではない）が上に載っている場合は延ばさない——「小口の縦線は
 * 切断壁の断面にだけ現れる」という既存規則と同じ境界線をここでも守る。
 * `solidRectsOf`（ささらの一般判定）と`sectionContent.js`の`buildCutContent`（壁content
 * の「断面内部は描画しない」一般判定）が共有する。
 * @param {SectionColumn[]} columns
 * @returns {Array<{xLo:number, xHi:number, zLo:number, zHi:number}>}
 */
export function slabSolidRectsOf(columns) {
  const rects = [];
  const cutRuns = cutWallRuns(columns ?? []);
  for (const run of slabRuns(columns ?? [])) {
    let xLo = run.x0, xHi = run.x1;
    for (const c of cutRuns) {
      const hit = slabJunctionOf(columns, run, c);
      if (!hit) continue;
      if (hit.slabOnLoSide) xHi = Math.max(xHi, hit.farX); // slabのhi側に立つ壁→farXへ延ばす
      else xLo = Math.min(xLo, hit.farX); // slabのlo側に立つ壁→farXへ延ばす
    }
    rects.push({ xLo, xHi, zLo: run.band.z0, zHi: run.band.z1 });
  }
  return rects;
}

/**
 * 矩形を**GAP_EPSだけ内側へ縮めた厳密内部**にする（`elevationPrimitives.js`の
 * `subtractRectsFromPrimitives`が使う`segmentInsideRect`はLiang-Barskyのp≈0分岐で辺上を内側と
 * 判定するため、縮めないと矩形の縁にちょうど乗る裁定済みの線（例: 面C x=1492.5の復路ささら・
 * スラブ小口の縦線そのもの）まで消えてしまう）。退化した矩形は捨てる。
 * @param {Array<{xLo:number, xHi:number, zLo:number, zHi:number}>} rects
 * @returns {Array<{xLo:number, xHi:number, zLo:number, zHi:number}>}
 */
export function strictInteriorOf(rects) {
  return rects
    .map(r => ({
      xLo: Math.min(r.xLo, r.xHi) + GAP_EPS, xHi: Math.max(r.xLo, r.xHi) - GAP_EPS,
      zLo: Math.min(r.zLo, r.zHi) + GAP_EPS, zHi: Math.max(r.zLo, r.zHi) - GAP_EPS,
    }))
    .filter(r => r.xHi > r.xLo && r.zHi > r.zLo);
}

/**
 * z空間の矩形（`solidRectsOf`/`slabSolidRectsOf`の返り）を面ローカル（y=-z。
 * `elevationPrimitives.js`の`subtractRectsFromPrimitives`が受ける形）へ写す。
 * `sectionStair.js`（ささら）と`sectionContent.js`（壁content）が共有する（式を複製しない）。
 * @param {Array<{xLo:number, xHi:number, zLo:number, zHi:number}>} rects
 * @returns {Array<{xLo:number, xHi:number, yLo:number, yHi:number}>}
 */
export function rectsToFaceLocal(rects) {
  return rects.map(r => ({ xLo: r.xLo, xHi: r.xHi, yLo: zToY(r.zHi), yHi: zToY(r.zLo) }));
}

/**
 * 列群から「実体で囲まれた矩形」の集合を作る（展開図一般化Phase 6b-2 設計(d)。「6」面Cのアキ矩形
 * （6b-2）と同じ考え方を階段自身の幾何へ広げ、階段のささらの見えがかりのうちこの矩形の
 * **厳密内部**にある区間を描かない、という一般判定の入力にする——`.claude/elevation-redesign.md`
 * §5.12参照）。
 *
 * 囲む実体＝`cut`∪`cutAlong`（列ごとの直接矩形）∪`slab`（`slabSolidRectsOf`。farX延長込み）。
 * 返す矩形は**GAP_EPSだけ内側へ縮めた厳密内部**（`strictInteriorOf`）。
 * @param {import('./sectionTypes.js').SectionColumn[]} columns
 * @returns {Array<{xLo:number, xHi:number, zLo:number, zHi:number}>}
 */
export function solidRectsOf(columns) {
  const rects = [];
  for (const col of columns ?? []) {
    for (const b of col.bands ?? []) {
      // slabは列にまたがるrun（sameSlabOwnerの縦マージ込み）＋farX延長が要るため
      // slabSolidRectsOfでまとめて扱う（ここでは素通り）。
      if (isSolidBand(b) && b.kind !== 'slab') rects.push({ xLo: col.x0, xHi: col.x1, zLo: b.z0, zHi: b.z1 });
    }
  }
  return strictInteriorOf([...rects, ...slabSolidRectsOf(columns)]);
}

// 全呼び出し側（部屋帯・吹抜け帯・階段cut表・面図の梁cut）が必ず渡すキー。
const REQUIRED_CUT_KEYS = ['line', 'viewSign', 'dirSign', 'layers', 'zRange', 'baseFloorZ'];

/**
 * 新しい`SectionCut`を組む唯一の生成器（派生は`{...cut}`の展開で作る）。渡された`spec`のown キーと値をそのまま持つcutを返す——
 * **渡されていないキーを既定値で足さない**（`'ends' in cut`・`'face' in cut`のような存在判定、
 * `{...cut}`の展開で挙動が変わりうるため）。必須キー（REQUIRED_CUT_KEYS）が欠けたら投げる。
 * @param {Partial<SectionCut> & {line:CutLine, viewSign:1|-1, dirSign:1|-1, layers:object[],
 *   zRange:{loZ:number,hiZ:number}, baseFloorZ:number}} spec
 * @returns {SectionCut}
 */
export function makeSectionCut(spec) {
  for (const key of REQUIRED_CUT_KEYS) {
    if (spec?.[key] === undefined) throw new Error(`makeSectionCut: 必須キー「${key}」がありません`);
  }
  return { ...spec };
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
 * 列の打ち切り（分割・天井の高さ・斜線の頭打ち）に使う天井断面。`ceilProfile`が優先で、無ければ
 * `ceilClip`（E5の受け口。打ち切り専用で帯の性格判定には使わない）。どちらも無ければundefined。
 * @param {import('./sectionTypes.js').SectionCut} cut
 */
export function ceilClipProfileOf(cut) {
  return cut.ceilProfile ?? cut.ceilClip;
}

/**
 * `ceilProfile`（`SectionCut.ceilProfile`と同型。区間ごとの天井断面の高さ。断面ローカルx）から、
 * [x0,x1]の中点を含む区間の天井を引く。profileが無ければnull＝打ち切らない（階段帯など、区間の
 * 天井を持たない呼び出し側は従来どおり）。
 *
 * **profileの範囲外（壁のない端部の探査延長で作られる面の外の列）は端の区間の値へクランプする**
 * ——面図側が天井線を`drawnX0..drawnXRun`（延長込み）まで端の区間の高さで引き延ばしている
 * （`elevationFigure.js`の`ceilAbsAtX`と同じ規約）以上、打ち切り高さもそこまで同じ値でなければ
 * ならない。nullを返すと**その列だけ打ち切りが効かず**、描かれている天井線より上の帯の側縁が
 * 面の端に出る（実測: 実機「5」で面の左端に z2400..3000 の中線が出た）。
 *
 * `sectionEngine.js`の列分割（`ceilZ`・`ceilEdge`）が使う天井プロファイル解決の単一情報源（旧実装は
 * `sectionEngine.js`内の私設関数`ceilZAt`だった。展開図一般化Phase 6b-3でここへ集約）。
 * 返すのは区間の天井断面の**x0側・x1側の高さ**（傾斜天井の受け口）。
 *
 * 区間は`ceilZ`（loXでの高さ）と任意の`ceilZHi`（hiXでの高さ）で直線を表す——傾斜は厳密に直線
 * なので1区間1線分（円弧・ドームも呼び出し側が折れ線へ刻んで同じ表現で渡す。列ごとに天井を
 * サンプリングする方式は採らない）。`ceilZHi`が無い・非有限・`ceilZ`と同値・区間幅0なら平面
 * （z0===z1）。範囲外の列は端の区間の**端点の値で水平**（先頭は`ceilZ`・末尾は端点の高さ）。
 * 区間の`ceilZ`が非有限ならnull＝打ち切らない。
 * @param {Array<{loX:number, hiX:number, ceilZ:number, ceilZHi?:number}>|undefined} ceilProfile
 * @param {number} x0
 * @param {number} x1
 * @returns {{z0:number, z1:number}|null}
 */
export function ceilProfileEdgeAt(ceilProfile, x0, x1) {
  const prof = ceilProfile;
  if (!Array.isArray(prof) || prof.length === 0) return null;
  const mid = (x0 + x1) / 2;
  const hit = prof.find(s => mid >= s.loX - GAP_EPS && mid <= s.hiX + GAP_EPS)
    ?? (mid < prof[0].loX ? prof[0] : prof[prof.length - 1]);
  if (!hit || !Number.isFinite(hit.ceilZ)) return null;
  const width = hit.hiX - hit.loX;
  const sloped = Number.isFinite(hit.ceilZHi) && Math.abs(hit.ceilZHi - hit.ceilZ) > GAP_EPS && width > GAP_EPS;
  if (!sloped) return { z0: hit.ceilZ, z1: hit.ceilZ };
  const zAt = x => {
    const t = Math.min(1, Math.max(0, (x - hit.loX) / width));
    return hit.ceilZ + (hit.ceilZHi - hit.ceilZ) * t;
  };
  return { z0: zAt(x0), z1: zAt(x1) };
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
 * 断面エンジン（`sectionEmit.js emitColumns`）が部材（梁。memberCut の帯）から作ったプリミティブに付ける出所の印
 * （`WHOLE_OUTLINE`〔sectionStructure.js〕と同じ流儀の enumerable なシンボル。JSON・golden には出ない）。
 * 階段帯 `contentForCut` は、印の付いた線を壁の線の後加工（断面線クリップ・破線化など）へ流さず、
 * 従来の構造材の経路（`dashLinesInsideRects(behindRects)`→`clipContentBelowProfileInRanges`）へ流す。
 */
export const MEMBER_PRIM = Symbol.for('strad.memberPrim');

/** 丸ごと描くと決めた断面の輪郭の線に付ける印（`sectionStructure.js occludeByFloor`・`sectionEmit.js` の memberCut の輪郭が付ける。階段帯は線ごとの切り直しから守る）。 */
export const WHOLE_OUTLINE = Symbol.for('strad.wholeOutline');

/**
 * 「アキ（open）として扱う」帯か。open の帯と、梁の断面（memberCut）で**梁が無ければ open だった**帯（`behind:'open'`。
 * 梁の断面はアキのセル・遠側の部屋の判定を割らない＝バツの線を梁の矩形で切り抜くだけ。階段帯のアキを割らない裁定 R5 と同じ扱い）。
 * 切断線の帯の中を通る梁（along）は従来どおりアキのセルを割る（加算の parallel は split:true だった）ので含めない。
 * @param {ZBand} band
 * @returns {boolean}
 */
export function isOpenLikeBand(band) {
  // 梁の見え掛かり（member。U1b B3-2）は、アキを割らない切断（階段帯。R5。`gapPass`）のときだけ、梁が無ければ open だった帯をアキとして扱う。
  // 割る切断（部屋帯）では梁がアキのセルを割る（加算の gapBeamRects split:true 相当）ので含めない。
  return band.kind === 'open' || (band.kind === 'memberCut' && band.behind === 'open' && band.along !== true)
    || (band.kind === 'member' && band.gapPass === true && band.behind === 'open');
}

/**
 * 絶対z（上が正）→ 描画y（下向き正のy=-z。展開図の既存プリミティブ座標系）。
 * プリミティブ化の最後（sectionEmit.js）にのみ使う（§2項目6。エンジン内部はzのまま扱う）。
 * @param {number} z
 * @returns {number}
 */
export function zToY(z) { return -z; }
