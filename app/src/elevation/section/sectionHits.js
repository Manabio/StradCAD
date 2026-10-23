/**
 * ヒット列（奥行き順の面候補）と ZBand[] への畳み込み（展開図一般化Phase 2）。
 * 設計 `.claude/elevation-redesign.md` §5.2/§5.3(b)。
 *
 * `probeColumnHits(cut, worldMid, probeCtx)` は「1本の列（worldMid）に見える面の候補」を
 * **深度昇順**で全て保持したまま返す（従来の`probeColumn`が「z区間ごとに1つ選ぶ」ために
 * 途中で捨てていた情報）。候補収集そのもの（壁面探査・切断壁・cutAlong・腰壁垂れ壁・開口の
 * pass-through判定）は旧`sectionProbe.js`の`probeColumn`にあったコードを**そのまま**この
 * ファイルへ移設しただけで、ロジックは変えていない——`collectCutBreaks`（列の分割）と共有する
 * 述語（`isCutWall`/`isCutAlongWall`/`isSightlineShape`/`isHiddenWall`/`cutProbeRange`）は
 * このファイルへ集約し、`sectionProbe.js`側はここから import して使う（一方向依存。循環import
 * を避けるため）。
 *
 * kind の語彙は `cut | cutAlong | wallFace | slab | floorFace | ceilFace | slabFace | stairFace`。
 * floorFace/ceilFace/slabFace（Phase 3。設計§5.3(b)）は視線方向の奥にある床・天井・躯体を
 * 表す水平面ヒットで、`probeColumnHits`が候補として積むが、**`visibleBandsOf`は選択対象から
 * 除外する**（出力完全不変。Phase 4で深度上限を適用して初めて描画に使う——`.claude/
 * elevation-model.md`「空間セル索引」節）。openingFaceは無い——開口のpass-through情報は従来どおり
 * 各ヒットの`openRanges`に添えるだけで、独立したヒット種別にはしない。
 * stairFace（Phase 6b-1。設計§5.3(b)）は階段の占有形状（`sectionStair.js`の`stairFaceHits`。
 * 段板・踊り場桁枠・内側ささらの見えがかり）を表すヒットで、`cut.stairCut`（階段帯以外は常に
 * null）があるときだけ積む。floorFace/ceilFace/slabFaceと同様に`visibleBandsOf`は選択対象から
 * 除外する（載せるだけ。選択への参加は6b-2）。
 *
 * memberCut/memberFace（展開図リファクタ U1b・B1）は構造の梁・柱の候補（`addMemberHits`）。stairFaceと同様に
 * `visibleBandsOf`は選択対象から除外する（載せるだけ。選択への参加は B3）。memberCutのdistMmは0（切断面で切られる部材）、
 * memberFaceのdistMmは壁のwallFaceと同じ芯の距離（測定値）。入力の層は`cut.memberLayers ?? cut.layers`。
 *
 * **`SurfaceHit.distMm`の意味はkindによって違う**（QA指摘②）: cut/cutAlongは常に`0`（切断面上の
 * 実体という定義そのもの）。wallFace/floorFace/ceilFaceは**測定値**（切断面からの実距離。
 * `compareHitDepth`のソートキー）。`slabFace`の`distMm:0`だけは**測定値ではなく番兵**
 * （`addHorizontalFaceHits`。自室＝距離0の位置から見た自室自身の床天井という定義上、常に0を
 * 置いているだけで、実際の奥行きを表さない）——`slabFace`は`visibleBandsOf`の選択に参加しない
 * ため実害は無いが、Phase 4以降でdistMmをそのまま奥行きとして読む処理を書くときは要注意。
 * `stairFace`の`distMm`（=`depthNearMm`）は**cut/cutAlongの0とも`slabFace`の番兵0とも違う3つ目の
 * 意味を持つ**（QA是正2026-09・要件C）——実際に切断平面へ**接触している**実体としての0で、
 * `atCutPlane:true`がその事実を明示する。区別の要点: cut/cutAlongの0＝「切断線そのものに
 * 存在する壁」という定義値／`slabFace`の0＝「自室の位置は距離ゼロ」という定義上の置き値（番兵。
 * 実際の奥行きは無関係）／`stairFace`の0（`atCutPlane`時）＝「その実体（段板・内側ささら）の
 * 手前端が実測で切断平面と一致する」という**測定結果**（switchbackCutsのseq1/3の幾何的必然。
 * `sectionStair.js`の`stairFaceHits`コメント参照）。`stairFace`は**奥行きの範囲**
 * （`depthNearMm`〜`depthFarMm`）も持つ——floorFace/ceilFace/wallFaceのような単一のスカラー
 * 距離では表せない「手前から奥まで実体が続く」物体（flight自体の走り長さぶん）を表すため。
 * 小文字の`slab`（既存）は「その区間を塞ぐwall/cut/cutAlongが1つも無いとき、層スタックの
 * 床天井から静的に導ける躯体・天井懐」の**選択結果側**（`ZBand.kind`）の語で、候補収集
 * （壁の走査）では作れないため`visibleBandsOf`のフォールバックとして残る——`slabFace`（新規の
 * **候補**）とは別物（前者はZBandのkind、後者はSurfaceHitのkind）。
 *
 * `visibleBandsOf(hits, cut, opts)` は「深度最小のヒットだけ残し、覆われないz区間は層スタックの
 * 床天井からslab/openを導く」——現行`probeColumn`のz区間分割・選択ロジックと**完全同値**に作る
 * （これが Phase 2-3 の出力不変を担保する仕掛け）。`probeColumn`は
 * `probeColumnHits(...)`が返す`{hits, layerStack, unexploredBelowZ}`を`visibleBandsOf(hits, cut,
 * {layerStack, unexploredBelowZ})`へ橋渡しするだけの薄い合成関数（QA是正: 以前は`layerStack`等を
 * `hits`配列へ追加プロパティとして載せていたが、`[...hits]`のような配列コピーで失われ、
 * `visibleBandsOf`が`layerStack`欠落のまま実行されてslabがopenへ化ける実害があったため、
 * `probeColumnHits`の返り値を明示オブジェクトへ変えた——`hits`単体は素のSurfaceHit[]で
 * コピーしても安全）。
 *
 * **本ファイルのexport（`probeColumn`/`probeColumnHits`/`visibleBandsOf`/`isHiddenWall`/
 * `cutProbeRange`/`isCutWall`/`isCutAlongWall`/`isSightlineShape`/`buildLayerStack`）は
 * `section/`配下（`sectionProbe.js`経由の再エクスポートを含む）専用**——`elevation/`の他ディレクトリ
 * からは直接importしない（面の体裁側は`sectionContent.js`の`buildCutContent`が入口）。
 * `isWallHiddenForBand`（§5.12 D2-1是正で追加）だけは例外——`section/cuts/switchbackCuts.js`の
 * `stairBandWallFilter`（`section/`配下）が唯一の外部向け窓口として`isHiddenWall`と同じ判断を
 * 面リスト構築（`elevationFaces.js`）へ提供する。`elevationFaces.js`/`elevationStair.js`自身は
 * 本ファイルを直接importしない——`stairBandWallFilter`が返す`wallFilter`関数を受け取るだけ。
 *
 * Phase 4（裁定済み2026-09-11・既定on）:
 * `visibleBandsOf`が`open`帯へ`farFloorZ`/`farCeilZ`/`farDepthMm`（上限内の最も近いfloorFace/
 * ceilFace）を付帯情報として載せる。深度上限の適用・アキの範囲を縮める処理・見えがかり線の描画は
 * 行わない（それぞれ`sectionEngine.js`・`sectionEmit.js`が担当）。
 */
import { OpeningCategory, RoomFeature } from '@core';
import { worldToCell } from '../../finish/gridCells.js';
import { kneeDropZRangesAt } from '../../finish/kneeDropWall.js';

// 既存の import 先（テスト・sectionProbe 等）を変えないよう再公開する。
export { kneeDropZRangesAt };
import { effectiveHeight } from '../../openings/openingNumbering.js';
import { GAP_EPS_MM as GAP_EPS, PROBE_EPS_MM } from '../elevationStyle.js';
import { graphList } from '../../graphReadScope.js';
import { localXOf } from './sectionTypes.js';
import { stairFaceHits } from './sectionStair.js';
import { memberSolidsOfLayers } from './sectionStructure.js';
import {
  isRealRoom, orderLayerStack, baseLayerOf, layerOwningZ,
  compareLayerPriority, resolveSightlineTopZ,
} from './sectionLayerStack.js';

// 「切断線が壁の中心線と同一直線上（coincident）」とみなす許容差(mm)。壁厚/2に対する
// 上乗せ分（WP-E5リード裁定・coincident壁＝cutAlongカテゴリ）。CL再スナップ等による
// サブミリ〜数mm程度の誤差を吸収する目的の小さな値（PROBE_EPS_MMと同水準）。
const COINCIDENT_TOL_MM = PROBE_EPS_MM;

function clamp(z, lo, hi) { return Math.max(lo, Math.min(hi, z)); }

/**
 * その切断が「実体ごと見ない」壁か（`cut.airRoom`／`cut.underRooms`。展開図一般化Phase 6・
 * 設計§5.4「規則へ吸収」）。
 *
 * 階段の帯からは「階段自身の空気ボリューム（`cut.airRoom`＝階段室）と、階段下に指定された部屋
 * （`cut.underRooms`）を隔てる壁は見えない」という規則を、壁id列挙ではなく空気ボリュームの
 * 連結成分で表す。
 *
 * 壁の両側のセルが指すRoom（`probeCtx.cellAt`）を見る。**両側に実在の部屋があり
 * （どちらかがcellAt().room===null＝建物の外・未区画なら対象外。階段下部屋の外周のうち階段室
 * 自身の外周と重なる辺——実機「13」の南辺。その外側は建物の外——はこれで非隠蔽のまま残る）、
 * かつ片側だけが`cut.underRooms`に含まれ（両方 or どちらでもないなら対象外）、かつその
 * 「片側」の反対側が`cut.airRoom`の連結成分（`space/spaceModel.js`の`buildComponents`）と
 * 一致する**壁を「帯自身の空気ボリュームと階段下部屋を隔てる境界」とみなし非可視にする。
 *
 * **`cut.underRooms`で対象を具体的な部屋へスコープすることが必須**（QA実測: 単に
 * 「壁の両側が別の連結成分で片側が階段室の成分」まで一般化すると、階段室と無関係な別室
 * （例: 「9」）が偶然隣り合うだけの階段自身の外壁まで誤って非可視になる——13.stq「6」D面
 * （wOut1）の実壁が広範囲に消えた反例。QA是正）。
 *
 * `cut.airRoom`／`cut.underRooms`が無い（階段以外の帯・階段にroomIdが無い・階段下に部屋指定が
 * 無い等）／`probeCtx.cellAt`が無い（テスト用の簡略probeCtx等）ときは常にfalse（非隠蔽＝
 * 従来どおり全ての壁が見える）。
 *
 * **判定は`layer.role==='self'`（階段自身の階）に限る**——「階段下の閉じた部屋」は階段自身の
 * 階にしか存在し得ない概念で、上階（`role:'above'`。往復間の壁が2Fにある構成等）の壁は
 * `cut.underRooms`に該当しようがない（underRoomsは自階のgraphからしか集めない）ため実害は
 * 無いが、role制限自体は無駄な計算を避ける安全弁として残す。
 *
 * **呼び出し側は`isCutWall`/`isCutAlongWall`/`isSightlineShape`のいずれかに該当した壁だけに
 * 適用すること**（この切断と無関係な壁まで判定しない）——旧実装は壁idのSetを引くだけだったため
 * 全走査の先頭で早期continueしても無害だったが、本判定は`cellAt`を2回呼ぶため、切断と無関係な
 * 壁（他の階段・他の部屋の壁）にまで適用すると無駄な計算が積み重なる。
 *
 * **展開図一般化Phase 6b-2（設計`.claude/elevation-redesign.md`§5.11 C-1）で「候補から消す」から
 * 「描かない実体として積む」へ変わった**——該当した壁は`probeColumnHits`が`hidden:true`を
 * 付けて候補へ積み、選択されれば`ZBand.kind:'hidden'`（実体は在るが描画しない）になる。
 * `collectCutBreaks`（列の分割）はもう本関数を呼ばない——「実体として在る」以上、他の壁と同じく
 * 材の面・端点で列を割ってよい（旧実装は「候補から消える」前提で列も割らないことにより
 * 「壁は消えても壁端で列が割れたまま残る」ことを避けていたが、その前提自体が無くなった。
 * QA是正2026-09で実測: 面C自身の右端はこの列分割に依存するため列分割側を「割らない」へは
 * 戻せない——列分割による副作用は`emitColumns`側で個別に抑える）。
 * 消費者は`probeColumnHits`（`section/sectionHits.js`）と、面リスト構築時の
 * `section/cuts/switchbackCuts.js`の`stairBandWallFilter`（展開図一般化§5.12 D2-1是正）の2箇所
 * ——判定の実体は下記`isWallHiddenForBand`に集約し、本関数はcutからairRoom/underRoomsを
 * 取り出す薄いラッパになった。
 * @param {import('./sectionTypes.js').SectionCut} cut
 * @param {import('@core').Wall} wall
 * @param {object} layer - その壁が属する層（`probeColumnHits`のinfo.layer）
 * @param {ReturnType<typeof import('./sectionProbe.js').makeProbeContext>} [probeCtx]
 * @returns {boolean}
 */
export function isHiddenWall(cut, wall, layer, probeCtx) {
  return isWallHiddenForBand(wall, layer, { airRoom: cut.airRoom, underRooms: cut.underRooms }, probeCtx);
}

/**
 * `isHiddenWall`の判定本体（cutを介さない形）。§5.12 D2-1是正で追加——面リスト構築
 * （`elevationFaces.js`の`realWallAtCorner`。`composeRoomFaces`→`snapFaceEndsToCorners`経由）が
 * 隅の実壁候補を探す時点でも、断面エンジンの候補収集（`probeColumnHits`。上記`isHiddenWall`
 * 経由）と**同じ判断**を使う必要がある——「この帯で実体として数えない壁」の単一情報源。
 * @param {import('@core').Wall} wall
 * @param {object} layer - `role`だけを見る（`role==='self'`以外は常にfalse）
 * @param {{airRoom?:object, underRooms?:Set<object>}} bandInfo - 帯自身の空気ボリューム代表Roomと
 *   階段下に指定された部屋の集合（`isHiddenWall`のcut.airRoom/cut.underRoomsと同じ形）
 * @param {ReturnType<typeof import('./sectionProbe.js').makeProbeContext>} [probeCtx]
 * @returns {boolean}
 */
export function isWallHiddenForBand(wall, layer, bandInfo, probeCtx) {
  const airRoom = bandInfo?.airRoom;
  const underRooms = bandInfo?.underRooms;
  if (!airRoom || !underRooms?.size || layer?.role !== 'self' || typeof probeCtx?.cellAt !== 'function') {
    return false;
  }
  // **部屋の生成壁（isRoomWall）だけを対象にする**——2a壁は`generateRoomWallsFromOutline`と
  // 同型の経路で生成される（実測: 13.stqの階段下部屋の2a壁4枚は全てisRoomWall:true）。
  // 往復間の壁（findMidWallが見つける自立した間仕切り。isRoomWall:false）は、たまたま
  // 階段下部屋の境界と位置が重なっても対象外——実運用ではstairUnderWalls.jsの委譲規則
  // （既存壁と重なるエッジには2a壁を生成しない）でこの重なりは起きないが、フィクスチャ等
  // 独自に壁を置く構成では起こりうるため、ここで明示的に除外する。
  if (!wall.isRoomWall) return false;
  const airComponent = probeCtx.componentOf(layer, airRoom);
  if (airComponent == null) return false;
  const mid = (wall.coord1 + wall.coord2) / 2;
  const av = wall.axisCL.effectiveValue;
  const roomOnSide = offset => (wall.isVertical
    ? probeCtx.cellAt(layer, av + offset, mid)
    : probeCtx.cellAt(layer, mid, av + offset))?.room ?? null;
  const near = roomOnSide(-PROBE_EPS_MM);
  const far = roomOnSide(PROBE_EPS_MM);
  // 片側でも部屋が無い（建物の外・未区画）なら、その壁は帯自身の外周壁そのもの——非隠蔽のまま。
  if (!near || !far) return false;
  const nearIsUnder = underRooms.has(near);
  const farIsUnder = underRooms.has(far);
  if (nearIsUnder === farIsUnder) return false; // 両方 or どちらも階段下部屋でないなら対象外
  const otherRoom = nearIsUnder ? far : near;
  // 「片側=階段下部屋」の反対側が、帯自身の空気ボリュームと連結しているか（`otherRoom`が
  // 階段室そのもの、または全高の壁で仕切られずに階段室と繋がる空間）。
  return probeCtx.componentOf(layer, otherRoom) === airComponent;
}

/**
 * 切断線の走り方向の探査範囲（`line.lo..hi` ＋ 探査延長）。
 * `collectCutBreaks`（列の切り方）と `isCutWall`（候補の拾い方）が**同じ範囲**を見るための
 * 単一実装——片方だけ延長を見ると「列はあるのに中身が無い」帯ができる。
 *
 * 読むのは`unionExtendLo/HiMm`（＝全層の探査窓の和。既定は`probeExtendLo/HiMm`と同値）——
 * 層ごとに面の端が違う（`SectionCut.layerRunWindows`）ため、ここは**どれかの層が探査してよい
 * 最大の範囲**を返し、層ごとの絞り込みは`withinLayerWindow`が行う。
 * @param {import('./sectionTypes.js').CutLine} line
 * @returns {{lo:number, hi:number}}
 */
export function cutProbeRange(line) {
  return {
    lo: line.lo - (line.unionExtendLoMm ?? line.probeExtendLoMm ?? 0),
    hi: line.hi + (line.unionExtendHiMm ?? line.probeExtendHiMm ?? 0),
  };
}

/**
 * wall が cut.line を「横切る」壁（切断壁。§5.2 step1の1）か。
 * wall.isVertical !== line.isVertical（直交）かつ wall.axisCL.effectiveValue が
 * line の run 範囲 [lo,hi] 内かつ wall のスパン(coord1/coord2)が line.axisValue を含む。
 * @param {import('@core').Wall} wall
 * @param {import('./sectionTypes.js').CutLine} line
 * @returns {boolean}
 */
export function isCutWall(wall, line) {
  if (wall.isVertical === line.isVertical) return false;
  const av = wall.axisCL.effectiveValue;
  // 走り方向の範囲は**探査延長を含めた範囲**で見る（cutProbeRange）。line.lo/hiだけで見ると、
  // 壁のない端部のすぐ外に立つ直交壁（＝その面を分割した袖壁そのもの）が丸ごと落ちる——袖壁で
  // 2断片に分かれた面では、袖壁の軸CLは一方の断片のlo/hiの内側だが**他方の断片では範囲の外**に
  // なるため、同じ1枚の袖壁の断面が片方の断片にだけ出て他方には出ない（実測）。
  // collectCutBreaksが同じ延長込みの範囲で列を切っている以上、候補判定も同じ範囲でなければ
  // 「列はあるのに中身が無い」帯になる。
  const { lo, hi } = cutProbeRange(line);
  if (!(av >= lo - GAP_EPS && av <= hi + GAP_EPS)) return false;
  const c1 = Math.min(wall.coord1, wall.coord2), c2 = Math.max(wall.coord1, wall.coord2);
  // buttToleranceMm: 切断線が「面自身の壁の中」を通る用法（部屋の展開）向けの許容差。
  // 直交壁は面の壁に**突き当たって**その室内側の面で終わるため、CL上に立てた切断線までは
  // 届かない——素の判定では実在する直交壁（腰壁・垂れ壁を含む）の断面が丸ごと落ちる。
  // 面の壁の半厚を渡すと、その厚みの中で終わる壁を「切断線を横切る」とみなす。
  // 階段帯は未指定＝0のため従来と完全同値（ユーザー明示指示2026-08「処理共有のこと」）。
  const tol = (line.buttToleranceMm ?? 0) + GAP_EPS;
  return line.axisValue >= c1 - tol && line.axisValue <= c2 + tol;
}

/**
 * その層をその位置で探査してよいか（`SectionCut.layerRunWindows`。窓が無ければ従来どおり全域）。
 * 列の分割（`collectCutBreaks`は窓へクランプして刻む）と列の中身（`probeColumnHits`の層スタック）の
 * **両方**で効かせる——片方だけだと、「列はあるのに中身が無い」／「中身が無いのに列が割れている」
 * 帯になる（`isHiddenWall`は逆にPhase 6b-2で`collectCutBreaks`側を呼ばなくなったため、この理由付けの
 * 対比先はもう`isHiddenWall`ではない）。
 * @param {import('./sectionTypes.js').SectionCut} cut
 * @param {object} layer
 * @param {number} worldCoord
 * @returns {boolean}
 */
export function withinLayerWindow(cut, layer, worldCoord) {
  const w = cut.layerRunWindows?.get(layer);
  if (!w) return true;
  return worldCoord >= w.lo - GAP_EPS && worldCoord <= w.hi + GAP_EPS;
}

/**
 * wall/opening が cut.line と平行で視線方向(viewSign)にある「見えがかり候補」（§5.2 step1の2）か。
 * axisCL・isVerticalさえ持てばWall/Opening共通で使える（S4の開口判定にも流用）。
 * @param {{isVertical:boolean, axisCL:object}} shape
 * @param {import('./sectionTypes.js').CutLine} line
 * @param {1|-1} viewSign
 * @returns {boolean}
 */
export function isSightlineShape(shape, line, viewSign) {
  if (shape.isVertical !== line.isVertical) return false;
  const diff = (shape.axisCL.effectiveValue - line.axisValue) * viewSign;
  return diff > GAP_EPS;
}

/**
 * wall が cut.line と「同一直線上（coincident）」＝縦断された壁（cutAlong。WP-E5リード裁定・
 * 設計書§6.1「seq2/4では切断線がその中を通る→全幅の断面（＝視線を遮る）」）か。
 * wall.isVertical === line.isVertical（cut.lineと同じ向き＝見えがかり候補と同じ判定対象）かつ
 * |wall.axisCL.effectiveValue - line.axisValue| <= 壁厚/2 + 許容差（壁の中心線をまたいで
 * 切断線が通っている＝壁を縦に割く形で切っている、とみなせる範囲）。
 * isSightlineShape と判定対象が重なりうる（diffが小さい正の値の壁は両方に該当）ため、
 * 呼び出し側は本関数を isSightlineShape より先に判定すること（cutAlongが優先）。
 * @param {import('@core').Wall} wall
 * @param {import('./sectionTypes.js').CutLine} line
 * @returns {boolean}
 */
export function isCutAlongWall(wall, line) {
  if (wall.isVertical !== line.isVertical) return false;
  // 部屋の外周壁（generateRoomWallsFromOutline生成。isRoomWall=true）は除外する——cut.lineが
  // 「その面自身の壁」の位置に一致する通常のface的な用法（近側=室内側にしか空間が無い）では、
  // その自壁をcutAlong（縦断された壁＝視線を遮る実体）として扱うと、既存のisSightlineShape
  // （diff>GAP_EPS。coincidentなら常にfalse＝自壁は候補にしない）の意図的な除外が壊れる。
  // cutAlongは「往復間の壁」のような自立した内部間仕切りを対象とする（WP-E5リード裁定）ため、
  // isRoomWall=trueの壁はここで除外する。
  if (wall.isRoomWall) return false;
  const mr = wall.materialRange;
  const halfThickMm = Math.abs(mr.hi - mr.lo) / 2;
  return Math.abs(wall.axisCL.effectiveValue - line.axisValue) <= halfThickMm + COINCIDENT_TOL_MM;
}

/**
 * layer.graph上で、cutの run方向 worldMid・厚み方向オフセット offsetMm の位置のセル
 * （所有Room・floorZ・ceilZ）を1点プローブする（elevationFloorProfile.jsのpushGap/
 * familyCeilingSegmentsと同じ「isVertical面ならpx=axisValue+offset・py=runCoord、そうでなければ逆」規約）。
 * 1点クエリはcellAt（buildSpaceIndex。makeProbeContext内で公開）経由。ceilZは天伏の平面区画の高さを含む。
 * @returns {{room:import('@core').Room|null, floorZ:number, ceilZ:number|null}|null}
 */
function ownerCellAtOffset(cut, worldMid, layer, probeCtx, offsetMm, span = null) {
  const { line } = cut;
  const px = line.isVertical ? line.axisValue + offsetMm : worldMid;
  const py = line.isVertical ? worldMid : line.axisValue + offsetMm;
  // 傾斜の面は cellAt の既定では**面の最高点**。cut.ceilProfile を持つ切断は呼び出し側の天井断面をエンジンが ceilEdge で
  // 打ち切るので、層スタックの上限は高い方でよい（ここを列の幅に絞ると上限が列の天井断面より低い所で天井懐の slab が出て
  // 出力が変わる）。ceilProfile を持たない切断（階段帯）は層スタックの ceilZ がそのまま帯の上端・天井の段（slab/open の境）を
  // 決めるので、列の幅（span。無ければ worldMid の1点）を切断線の深さで評価した**傾斜の面の最大値**を頼む
  // （隣室が傾斜でも列の外の高い側まで天井が届くと見なさない。E3b-4。spaceModel.js cellAt の span）。
  const colSpan = cut.ceilProfile ? null : {
    isVertical: line.isVertical, depthCoord: line.axisValue, lo: span?.worldLo ?? worldMid, hi: span?.worldHi ?? worldMid };
  return probeCtx.cellAt(layer, px, py, colSpan);
}

/**
 * 見えがかり壁の候補が「この切断が見ている部屋の中」に収まっているか
 * （ユーザー実機指摘2026-08「6」C・裁定A案）。
 * 視線方向の所有Room（info.room）を出た**先**にある壁は、この帯の作図対象ではなく
 * 見えがかり壁として描かない——描かれないz区間は`open`帯になり、`emitOpenGapMarks`が
 * アキ（一点鎖線のバツ）を描く。実機症状: 6/Cの1F部分(z0..2400)が6m先の別室の壁(d6000)を
 * 拾って見えがかり壁になっており、「3500の面を表す…四角にアキ・バツ」が出ていなかった。
 * 判定は**帯そのもののRoom（`cut.bandRoom`＝階段帯なら階段室）の包絡矩形**（`roomBounds`）の
 * 中に壁の手前側の面が収まっているか。ユーザーの言う「3500の面」＝その部屋自身の広がりの端。
 * *試して却下した案2つ*:
 * ① 壁の手前の1点プローブで**所有Roomが同一か**——階段帯では「階段」室から「階段下」室のような
 *    隣接Roomを見通すのが正常なので、部屋を跨いだ時点で全て消え、確認済みテスト（seq2の面端の
 *    壁の縁）が落ちた。
 * ② **視線方向の所有Room**（`info.room`）の包絡矩形——列ごとに所有Roomが「階段」「階段下」と
 *    入れ替わり、狭い方の矩形で切ってしまうため、面の分類（往復間の壁の検出）まで巻き添えで
 *    変わった（展開記号の回帰テストが落ちた）。帯のRoomは列によらず一定でなければならない。
 * 壁は部屋境界のCL上に載るため、許容は壁厚ぶん（`materialRange`の幅）とする。
 * cut.bandRoom・materialRange・包絡矩形が取れないときは従来どおり制限しない。
 */
function withinViewRoom(cut, worldMid, info, probeCtx, wall) {
  const mr = wall.materialRange;
  if (!mr) return true;
  // 包絡矩形は**世界座標の箱**なので層に依らず1つ。`cut.bandRoomBounds`として呼び出し側が
  // 自階graphで一度だけ求めて渡す——旧実装は層ごとのgraphで引き直しており、上階レイヤーでは
  // 自階Roomのセルキーが解決できずbounds不定→制限なしになっていた（実機「6」Cで上階の
  // 6m先の壁(d6000)がz3800..5400に残り、アキにならなかった）。
  const b = cut.bandRoomBounds;
  if (!b || !Number.isFinite(b.x1) || !Number.isFinite(b.x2)) return true;
  const nearFace = cut.viewSign > 0 ? Math.min(mr.lo, mr.hi) : Math.max(mr.lo, mr.hi);
  const tol = Math.abs(mr.hi - mr.lo) + GAP_EPS;
  // cut.lineがisVertical（縦の切断線）なら視線＝X方向、そうでなければY方向。
  const [lo, hi] = cut.line.isVertical ? [b.x1, b.x2] : [b.y1, b.y2];
  return nearFace >= lo - tol && nearFace <= hi + tol;
}

/**
 * 面の平面の**向こう側**（壁を挟んで視線の先＝面の軸CLから`viewSign`方向へ`PROBE_EPS_MM`）のセルの部屋。
 * 自階の層で引く。面（`cut.face.axisCL`）・自階の層・`probeCtx.cellAt`のどれかが無い・階段帯
 * （`cut.stairCut`。切断線が階段室の中にあり`viewSign`の規約が違う）は null（引けない）。
 * 切断線は面の軸CLから室内側へ下がっている（`faceCutLine`）ので、`line.axisValue`を基準にすると
 * 自室を引いてしまう——必ず面の軸CLを基準にする。部屋は feature で判定する（名前は見ない）。
 * @param {import('./sectionTypes.js').SectionCut} cut
 * @param {number} worldMid
 * @param {ReturnType<typeof import('./sectionProbe.js').makeProbeContext>} probeCtx
 * @returns {{kind:'stair'|'none'|'other', room:object|null}|null} stair＝階段室／none＝部屋が無い（壁の厚みの帯など）／other＝普通の部屋
 */
export function farRoomAt(cut, worldMid, probeCtx) {
  const axis = cut.face?.axisCL?.effectiveValue;
  const layer = (cut.layers ?? []).find(l => l?.role === 'self');
  if (cut.stairCut || !Number.isFinite(axis) || !layer || typeof probeCtx?.cellAt !== 'function') return null;
  const d = axis + cut.viewSign * PROBE_EPS_MM;
  const cell = cut.line.isVertical ? probeCtx.cellAt(layer, d, worldMid) : probeCtx.cellAt(layer, worldMid, d);
  if (!cell?.room) return { kind: 'none', room: null };
  return { kind: cell.room.feature === RoomFeature.STAIR ? 'stair' : 'other', room: cell.room };
}

/**
 * 階段室越しの壁か（`viaStair`。ユーザー裁定2026-10-14 S4「正面壁の見え掛かり」）の位置の条件。
 * 面の向こう側が階段室で、壁の手前の面が面の軸CLより向こう側にある（階段室側に立つ）壁。
 * 呼び出し側が、天端が階段の裏面との取り合い（junction＝復路下の壁）であることを併せて確かめる。
 * 見えがかりの奥行き上限（800）と帯の部屋の包絡矩形（`withinViewRoom`）はこの壁には掛けない
 * ——掛けるかどうかの最終判断（最初の壁だけ残す）は`sectionEngine.js`の`buildColumns`。
 * @returns {boolean}
 */
function isWallViaStairRoom(cut, wall, farKindOf) {
  const axis = cut.face?.axisCL?.effectiveValue;
  const mr = wall.materialRange;
  if (!Number.isFinite(axis) || !mr) return false;
  const nearFace = cut.viewSign > 0 ? Math.min(mr.lo, mr.hi) : Math.max(mr.lo, mr.hi);
  if ((nearFace - axis) * cut.viewSign < -PROBE_EPS_MM) return false; // 面の手前（室内側）の壁
  return farKindOf() === 'stair';
}

// kneeDropZRangesAt（腰壁・垂れ壁指定を反映した壁のz存在範囲の並び。アキは2帯）は
// finish/kneeDropWall.js へ移した（平面の立体モデル plan/planSolids.js が展開図エンジンの内部を
// 引かないため。上の import と下の export を参照）。

// 層ごとの壁の天端プロファイル（probeCtx.wallTopProfileFor。隔て壁の斜め天端）から壁1本分を引く。
// probeCtx がプロファイルを持たない（スタブ等）・該当壁なしは null＝従来どおり。
function wallTopOf(probeCtx, layer, wall) {
  return probeCtx?.wallTopProfileFor?.(layer)?.get(wall.id) ?? null;
}

/**
 * 斜めの天端の帯（wallFace）の天端の線: 列の幅の両端（世界座標の lo/hi 側）での天端の高さ。
 * 傾きが無い（両端が同じ）・上限（capZ）で頭打ちされて帯の上端が斜面の高い側より低いときは null
 * ＝水平の帯のまま（斜線は帯の上端より上へ出られない）。
 * @param {{z1:number, topAt?:(along:number)=>number}} range - kneeDropZRangesAt の1件
 * @param {{worldLo:number, worldHi:number}|null} span
 * @returns {{zAtLo:number, zAtHi:number}|null}
 */
function topEdgeOf(range, span) {
  if (!span || !range.topAt) return null;
  const zAtLo = range.topAt(span.worldLo), zAtHi = range.topAt(span.worldHi);
  if (Math.abs(zAtLo - zAtHi) < GAP_EPS) return null;
  if (range.z1 < Math.max(zAtLo, zAtHi) - GAP_EPS) return null;
  return { zAtLo, zAtHi };
}

/**
 * 切断壁（切断線を横切る壁）の斜めの天端が、切断面より視線側で達する最高の絶対 z（壁の視線側の端での天端。天端は線形なので
 * 端で最高）。天井の打ち切り（capZ）を超えない。壁の端が切断面より手前（視線の反対側）なら null。
 * 隔て板の天板の見え掛かり（ユーザー指示 2026-10-19 roof-test1 2階 階段 A「隔て板断面線の上、傾斜している天板の見え掛かりを
 * 細線描画」）の供給源。
 * @param {import('@core').Wall} wall
 * @param {{zAt:(along:number)=>number}} wallTop
 * @param {number} cutAlong 切断線の軸（壁の長さ方向の座標）
 * @param {number|undefined} viewSign
 * @param {number} capZ
 * @returns {number|null}
 */
export function cutWallTopBeyondZ(wall, wallTop, cutAlong, viewSign, capZ) {
  const vs = viewSign === -1 ? -1 : 1;
  const c1 = Math.min(wall.coord1, wall.coord2), c2 = Math.max(wall.coord1, wall.coord2);
  const far = vs > 0 ? c2 : c1;
  if ((far - cutAlong) * vs <= GAP_EPS) return null;
  const z = wallTop.zAt(far);
  if (!Number.isFinite(z)) return null;
  return Number.isFinite(capZ) ? Math.min(z, capZ) : z;
}

/**
 * 天端プロファイルを持つ壁の「視線の上限」（cut/cutAlong 経路。見えがかり壁の capZ と同じ規則）。
 * 階段室の吹抜けには部屋の天井（CH）が無く、隔て壁の天端（仕様 2600〜3800）が CH で止まるのは誤りのため、
 * 上が吹抜けなら上階の天井まで登る（resolveSightlineTopZ）。プロファイルの無い壁は呼ばない（従来どおり info.ceilZ）。
 * @param {Array} layerStack
 * @param {{layer:object, ceilZ:number}} info
 * @param {import('@core').Wall} wall
 * @param {number} along - 壁の長さ方向の位置（cut なら切断線の位置・cutAlong なら列の位置）
 * @param {import('./sectionTypes.js').SectionCut} cut
 * @param {object} probeCtx
 * @returns {number}
 */
function profiledWallCapZ(layerStack, info, wall, along, cut, probeCtx) {
  return resolveSightlineTopZ(
    layerStack, info, roomAtWallPosition(wall, along, cut.viewSign, probeCtx), cut.zRange?.hiZ ?? 0,
    wallContinuesOnLayer(wall, along),
  );
}

/**
 * その壁のz範囲が、その層の床天井いっぱいではない＝**天端または下端が露出している**
 * （腰壁・垂れ壁の類）か。
 *
 * 「展開図では断面の中は描画しない」の**唯一の例外**を決める（ユーザー明示指示2026-08・案A）:
 * 天井の向こうにある切断壁でも、天端が見える壁（腰壁）・下端が見える壁（垂れ壁）は描く
 * ——その露出した縁は吹抜け側の空間に面していて実際に見えるため。上下いっぱいに立つ壁は
 * 隣室との仕切りであり天井の向こうに隠れるので描かない（実機「5」A面左3200・C1面右400）。
 * `sectionEngine.js`の`clipBandsToCeil`が本フラグを見る。
 * @param {number} z0
 * @param {number} z1
 * @param {{floorZ:number, ceilZ:number}} info - その壁が属する層の床天井
 * @returns {boolean}
 */
function isKneeDropRange(z0, z1, info) {
  return z0 > info.floorZ + GAP_EPS || z1 < info.ceilZ - GAP_EPS;
}

/**
 * 視線方向に所有Roomが見つからない層のceilZフォールバック（QA指摘・WP-E7bで修正）。
 * 実機で最も普通の構成（2F床=踊り場のみ・レーン上は吹抜け）では、往復間の壁(midWall)が
 * 属する'above'層の視線方向プローブがレーン上（吹抜け＝所有Room無し）で失敗しceilZ==nullに
 * なり、旧実装（呼び出し側の`if (info.ceilZ==null) continue`）は候補収集そのものを層ごと
 * 丸ごと捨てていた——「視線方向に所有Roomが無い＝部屋の外」ではあっても、isCutWall/
 * isCutAlongWallで検出される壁自体はそこに実在するため、候補収集を諦めてはいけない
 * （壁の2縁・腰壁高さ反映が消える実機不具合の原因だった）。room有りなら従来どおりCH。
 * 無ければ(a)layer.graph.defaultCeilingHeight、(b)それも無ければcut.zRange.hiZ、
 * (c)それも無ければfloorZそのもの、の順でフォールバックする（kneeDropレコードがあれば
 * kneeDropZRangeAtがこのceilZより優先されるため、ここは「腰壁・垂れ壁指定が無いときの
 * 全高上限」としてのみ効く）。
 * @param {{graph:object, floorZMm:number}} layer
 * @param {number} floorZ
 * @param {import('./sectionTypes.js').SectionCut} cut
 * @returns {number}
 */
function fallbackCeilZ(layer, floorZ, cut) {
  const defaultCH = layer.graph?.defaultCeilingHeight;
  if (defaultCH != null) return floorZ + defaultCH;
  return cut.zRange?.hiZ ?? floorZ;
}

/**
 * 壁の実位置（axisCL.effectiveValue × worldMid）を室内側へ`PROBE_EPS_MM`だけ逃がした点で、
 * 指定層の所有Roomを1点プローブする（`resolveSightlineTopZ`へ渡す`roomAtLayer`の実体）。
 * 壁のちょうど中心線上は境界セルで所有Roomが不安定なため、probeOwnerRoomと同じ手法で逃がす
 * ——壁は line から見て+viewSign側にあるので、-viewSign側が壁の手前＝室内側になる。
 * 切断壁（profiledWallCapZ 経由）では壁のどちら側でもよい前提で使う（隔て壁は両側が同じ空間＝階段室）。
 * @param {import('@core').Wall} wall
 * @param {number} worldMid
 * @param {1|-1} viewSign
 * @param {ReturnType<typeof import('./sectionProbe.js').makeProbeContext>} probeCtx
 * @returns {(upper:{layer:{graph:object}})=>object|null}
 */
function roomAtWallPosition(wall, worldMid, viewSign, probeCtx) {
  const offset = -viewSign * PROBE_EPS_MM;
  const px = wall.isVertical ? wall.axisCL.effectiveValue + offset : worldMid;
  const py = wall.isVertical ? worldMid : wall.axisCL.effectiveValue + offset;
  return upper => {
    const cell = worldToCell(px, py, upper.layer.graph);
    return cell ? (probeCtx.cellToRoomFor(upper.layer).get(cell.key) ?? null) : null;
  };
}

/**
 * 「その層にもこの壁が続いているか」（`resolveSightlineTopZ`へ渡す`wallContinuesAt`の実体）。
 *
 * 判定は**その層の同じ通り（同じ向き・同じ軸CL実効値。グラフが層ごとに別なのでidは一致しない）
 * に壁が引かれているか**で二段に分ける:
 *   - その通りに壁が1本も無い層 … 「その通りについて何も言っていない層」とみなし`true`
 *     （＝従来どおり吹抜けを天井まで登る。上階が吹抜けだけで壁の記録を持たない構成が該当）。
 *   - その通りに壁がある層 … その壁割りが唯一の情報源なので、worldMidを覆う壁があるときだけ
 *     `true`。**この位置の抜けは上階の平面が決めた意図的な抜け**（実機「6」C: 2階のY1から3500の
 *     壁はX2〜X3から1500の区間だけ無い）。
 * 壁の厚み・偏芯・仕上げは問わない——「そこに壁が立っているか」だけの判定。
 * @param {import('@core').Wall} wall
 * @param {number} worldMid - 列の中央（壁の長さ方向の世界座標）
 * @returns {(upper:{layer:{graph:object}})=>boolean}
 */
function wallContinuesOnLayer(wall, worldMid) {
  const axisValue = wall.axisCL.effectiveValue;
  return upper => {
    const onAxis = (graphList(upper.layer.graph, 'walls') ?? []).filter(w2 =>
      w2.isVertical === wall.isVertical
      && Math.abs(w2.axisCL.effectiveValue - axisValue) <= COINCIDENT_TOL_MM);
    if (onAxis.length === 0) return true;
    return onAxis.some(w2 => {
      const c1 = Math.min(w2.coord1, w2.coord2), c2 = Math.max(w2.coord1, w2.coord2);
      return worldMid >= c1 - GAP_EPS && worldMid <= c2 + GAP_EPS;
    });
  };
}

/**
 * openingの絶対z範囲（§5.4「openingPassThrough」）。sill/heightの規約はopeningElevationFigure.js
 * ・openingNumbering.jsと同じ単一情報源を使う（フィッティング=sill0・窓=sillHeight??0、
 * heightはeffectiveHeightでカタログ既定へフォールバック——展開図の建具姿図と同じ解釈）。
 * @param {import('@core').Opening} o
 * @param {number} floorZ - このopeningが属する壁のfloorZ（絶対z基準）
 * @returns {{z0:number, z1:number}}
 */
function openingAbsZRange(o, floorZ) {
  const sill = o.category === OpeningCategory.WINDOW ? (o.sillHeight ?? 0) : 0;
  const height = effectiveHeight(o);
  return { z0: floorZ + sill, z1: floorZ + sill + height };
}

/**
 * wall（見えがかり壁面。kind:'wallFace'候補）に重なる開口の絶対z範囲を、候補自身のz存在範囲
 * [z0,z1]（腰壁・垂れ壁反映済み）へクランプして返す（§5.4・WP-E7 D1）。
 * openingsOnFace（elevationFaces.js）と同じ絞り込み（isVertical一致・axisCL.id一致）に加え、
 * worldMidがopeningのx範囲(coord1..coord2)内にあることを要求する（この列に実際に写る開口のみ）。
 * @param {import('@core').Wall} wall
 * @param {object} graph
 * @param {number} worldMid
 * @param {number} floorZ
 * @param {number} z0 - wall候補のz存在範囲下端
 * @param {number} z1 - wall候補のz存在範囲上端
 * @returns {Array<{z0:number, z1:number}>}
 */
function openingPassThroughRangesFor(wall, graph, worldMid, floorZ, z0, z1) {
  const ranges = [];
  for (const o of graphList(graph, 'openings') ?? []) {
    if (o.isVertical !== wall.isVertical || o.axisCL.id !== wall.axisCL.id) continue;
    const c1 = Math.min(o.coord1, o.coord2), c2 = Math.max(o.coord1, o.coord2);
    if (worldMid < c1 - GAP_EPS || worldMid > c2 + GAP_EPS) continue;
    const abs = openingAbsZRange(o, floorZ);
    const lo = clamp(abs.z0, z0, z1), hi = clamp(abs.z1, z0, z1);
    // openingも添える——切断壁ではその建具の断面（枠・扉）を描くため（sectionEmit.js）。
    if (hi - lo > GAP_EPS) ranges.push({ z0: lo, z1: hi, opening: o });
  }
  return ranges;
}

/**
 * 1本の列（worldMid）における層スタック（層ごとの「視線方向の自室」と、その層でのfloorZ/ceilZ）。
 *
 * 層ごとに視線方向へ1点プローブする（§5.2「層の床天井」・step5）——階段のような複数layer構成では
 * 層ごとに異なるgraphを同じ位置で引く必要があるため。壁面自身の位置＝cut.line.axisValueぴったりの
 * probeでも、+viewSign*PROBE_EPS_MMだけ視線方向へ逃がせば単純な矩形室では正しく自室を拾える。
 * orderLayerStackでfloorZMm昇順へ整列して返す——以降の層の判断（所有層・上位層・優先順位）は
 * 全て並びの上で答えるため、呼び出し側がcut.layersをどの順で渡しても結果は変わらない。
 * @param {import('./sectionTypes.js').SectionCut} cut
 * @param {number} worldMid
 * @param {ReturnType<typeof import('./sectionProbe.js').makeProbeContext>} probeCtx
 * @param {{worldLo:number, worldHi:number}|null} [span] - 列の世界座標の幅。省略は worldMid の1点。傾斜の天井の面は
 *   **列の幅を切断線の深さ（仕上げ面）で評価した最大値**を ceilZ にする（自室の帯では列の高い側 highZ と一致。隣室の帯が
 *   傾斜の部屋を覗く列でも、列の外の高い側までは届かない。E3b-4）。傾斜でない面は従来どおり。
 * @returns {Array<{layer:object, room:object|null, floorZ:number, ceilZ:number}>}
 */
export function buildLayerStack(cut, worldMid, probeCtx, span = null) {
  // **その層の平面が届いていない位置では、その層は層スタックに現れない**（withinLayerWindow）。
  // 壁の候補だけを落とすのでは足りない——床天井の分類（slab/open）も所有層の判断
  // （`layerOwningZ`・`upperFloorZAt`）もこのスタックが情報源で、面の外に自階の床天井が
  // 残っていると、面の端に実在しない天井段差（＝上階の床の断面線）が生まれる。
  return orderLayerStack((cut.layers ?? []).filter(layer => withinLayerWindow(cut, layer, worldMid)).map(layer => {
    const cell = ownerCellAtOffset(cut, worldMid, layer, probeCtx, cut.viewSign * PROBE_EPS_MM, span);
    const room = cell?.room ?? null;
    const floorZ = probeCtx.floorZOf(room, layer);
    // QA修正: room=nullでも壁候補は諦めない（fallbackCeilZ参照）。ceilZが実質nullになるのは
    // layer.graph自体が無い等の防御的ケースのみ。
    // 天井は探査点の天伏区画の高さ（cell.ceilZ）。簡易probeCtxのテスト向けにchOfへ落とす防御を残す。
    const ceilZ = room ? (cell.ceilZ ?? floorZ + probeCtx.chOf(room, layer.graph)) : fallbackCeilZ(layer, floorZ, cut);
    return { layer, room, floorZ, ceilZ };
  }));
}

/**
 * **はり出し列（探査窓で自階が落ちた列）で「未探査」になる高さの上限**。窓が無い切断・自階が
 * 残っている列ではnull（従来どおり制限なし）。
 *
 * `sectionLayerStack.js`の`baseLayerOf`は「z原点に最も近い層＝帯自身の階」を返すが、
 * **窓で自階が落ちた列ではその契約が自階を指さない**——残っているのは上階だけなので、上階が
 * baseになる。その結果`probeColumnHits`の床天井の分類が「baseのFLより下＝自階の床構造」を
 * 上階のFL（実データ「6」では3000）に対して適用し、はり出し列の地面から2FLまでが丸ごと
 * slab（2階の床構造が地面まで続く）になっていた。そこは**面の外＝その高さを持つ平面が
 * どれも届いていない未探査域**であって、床構造ではない。
 *
 * したがって、はり出し列ではその列に実在する最下層のFL（`floorZMm`）より下に帯を作らない
 * （＝何も描かない）。列の外＝未探査を「実体が無い（アキ）」とも「躯体（slab）」とも言わない、
 * という`emitColumns`の端の扱い（「隣接列が無いことは『そこで壁が終わる』ことを意味しない」）と
 * 同じ境界の引き方。
 * @param {import('./sectionTypes.js').SectionCut} cut
 * @param {Array<{layer:object}>} layerStack - buildLayerStackの結果
 * @param {number} worldMid
 * @returns {number|null}
 */
function unexploredBelowZOf(cut, layerStack, worldMid) {
  if (!cut.layerRunWindows) return null;
  const present = layerStack.map(i => i.layer?.floorZMm).filter(Number.isFinite);
  if (present.length === 0) return null;
  const lowest = Math.min(...present);
  const droppedBelow = (cut.layers ?? []).some(layer => Number.isFinite(layer?.floorZMm)
    && layer.floorZMm < lowest - GAP_EPS && !withinLayerWindow(cut, layer, worldMid));
  return droppedBelow ? lowest : null;
}

// LayerInfo（層ごとの床天井）→ 非描画のslab ZBand。床構造・天井懐・上階床のどれであっても
// 「その高さを所有する層の床天井」を持たせる、という一点だけが分類の情報源。
function slabBandOf(info, z0, z1) {
  return { kind: 'slab', z0, z1, ownerRoom: info.room, floorZ: info.floorZ, ceilZ: info.ceilZ };
}

/**
 * 水平面ヒット（floorFace/ceilFace/slabFace。Phase 3。設計§5.3(b)）を候補へ積む。
 *
 * - `slabFace`: この層自身の床構造・天井懐の高さ（既存`slabBandOf`と同じ情報源＝
 *   layerStackの自室floorZ/ceilZ）を、選択に使わない「候補」としても持たせる（Phase 4以降の
 *   準備。`visibleBandsOf`は`slab`《ZBandのkind》のフォールバックロジックを従来どおり自分で
 *   再計算するため、ここで積む`slabFace`候補は今は誰も読まない）。
 * - `floorFace`/`ceilFace`: `probeCtx.cellsAlong`で視線方向の奥にある各室の床・天井を辿る。
 *   `info.room`と同じセグメント（この層自身の室）はスキップする——その高さはz-band自体の
 *   床天井として既に表現されているため、ヒットとして重複させない。
 *
 * `z0===z1`（厚みゼロの面）で登録する——`visibleBandsOf`の選択（frontMatch/wallMatch）からは
 * 除外されるため、z範囲としての意味は持たせず「その高さに面がある」事実だけを保持する。
 *
 * 視線方向の探査に上限は掛けない（`toDepthMm=Infinity`。安全弁は`cellsAlong`自身の
 * ステップ数上限）——深度上限（`SIGHTLINE_DEPTH_LIMIT_MM`）の適用はPhase 4（設計ユーザー裁定2）。
 * `probeCtx.cellsAlong`が無い（テスト用の簡略probeCtx等）場合は静かに何もしない。
 *
 * **`cut.line`が切断対象の壁の中心線ちょうど（cutPlaneOffsetMm===0。`sectionCutPlane.js`の
 * オフセットが0）だと floorFace/ceilFace は一切出ない**（QA指摘⑤。実測で確認済み）——
 * `buildLayerStack`の`probeOwnerRoom`（`info.room`の解決）も本関数の`cellsAlong`も、同じ
 * `cut.line.axisValue`から同じ`+viewSign*PROBE_EPS_MM`だけ進んだ点を見る。オフセットが無いと
 * その最初の一点が**向こう側の部屋**（境界を挟んで先の部屋）に着地し、`info.room`自体が
 * その部屋になってしまう——`cellsAlong`が返す最初のセグメントは`info.room`と一致して
 * スキップされ（このセグメントは既に自室として表現されているため）、floorFace/ceilFaceは
 * 生成されず、その部屋は`slabFace`（自室の床構造・天井懐）経路だけで表現される。
 * production（`sectionCutPlane.js`）の切断線は常に「壁仕上げ面まで室内側へ下がる」正のオフセットを
 * 持つため実害は無いが、`cut`を手書きするテスト・将来の呼び出し側はこの前提を崩さないこと。
 * @param {import('./sectionTypes.js').SectionCut} cut
 * @param {number} worldMid
 * @param {{layer:object, room:object|null, floorZ:number, ceilZ:number}} info
 * @param {ReturnType<typeof import('./sectionProbe.js').makeProbeContext>} probeCtx
 * @param {Array} hits - 追記先
 */
function addHorizontalFaceHits(cut, worldMid, info, probeCtx, hits) {
  const { layer } = info;
  if (info.room) {
    // distMm:0は番兵（自室＝切断面の位置そのものという定義上の値。測定値ではない。
    // ファイル冒頭のSurfaceHit.distMmの注記参照。QA指摘②）。
    hits.push({ kind: 'slabFace', layer, room: info.room, distMm: 0, z0: info.floorZ, z1: info.floorZ });
    hits.push({ kind: 'slabFace', layer, room: info.room, distMm: 0, z0: info.ceilZ, z1: info.ceilZ });
  }
  if (typeof probeCtx?.cellsAlong !== 'function') return;
  const segs = probeCtx.cellsAlong(layer, cut, worldMid, 0, Infinity);
  for (const seg of segs) {
    if (!seg.room || seg.room === info.room) continue; // 自室は既にz-band構造で表現済み
    hits.push({ kind: 'floorFace', layer, room: seg.room, distMm: seg.depthMm, z0: seg.floorZ, z1: seg.floorZ });
    if (seg.ceilZ != null) {
      hits.push({ kind: 'ceilFace', layer, room: seg.room, distMm: seg.depthMm, z0: seg.ceilZ, z1: seg.ceilZ });
    }
  }
}

/**
 * 階段の占有形状（`sectionStair.js`の`stairFaceHits`。展開図一般化Phase 6b-1。設計§5.3(b)）を
 * 候補へ積む。`cut.stairCut`が無い（階段帯以外の帯すべて）ときは何もしない——階段以外の帯の
 * 出力には一切影響しない。
 *
 * `stairFaceHits(cut.stairCut, cut)`はローカルx範囲（`sectionTypes.js`の`localXOf`と同じ座標系）
 * で占有矩形・占有線を返すため、`worldMid`を同じ変換へ通してから領域判定する
 * （`GAP_EPS`は境界ちょうどの列を拾うための許容差。他のヒット種別のx/spanクランプと同水準）。
 * layerは自階（`role:'self'`）を単一情報源にする——階段の`baseZ`・`floorHeight`は自階基準の
 * 絶対z（stairContribution参照）で、上階レイヤーには対応する概念が無い。
 * @param {import('./sectionTypes.js').SectionCut} cut
 * @param {number} worldMid
 * @param {Array} hits - 追記先
 */
function addStairFaceHits(cut, worldMid, hits) {
  // このガードは`stairFaceHits`自身の`if (!contribution || !cut?.line) return [];`と二重——
  // 通常帯（cut.stairCutが無い）に積まない保証は`stairFaceHits`のnullチェック側が持つ。
  // ここでの早期returnは無駄な関数呼び出しを避けるための最適化に過ぎない（QA指摘D）。
  if (!cut.stairCut) return;
  const layer = (cut.layers ?? []).find(l => l.role === 'self') ?? cut.layers?.[0] ?? null;
  const localX = localXOf(cut, worldMid);
  for (const face of stairFaceHits(cut.stairCut, cut)) {
    if (localX < face.xLo - GAP_EPS || localX > face.xHi + GAP_EPS) continue;
    hits.push({
      kind: 'stairFace', layer, side: face.side, part: face.part,
      // distMmはdepthNearMmと同値にする——compareHitDepth（下記）が全kind共通でdistMmを
      // ソートキーに使うため、SurfaceHit.distMmは常に「最も手前」の深度を指す規約を保つ
      // （QA是正2026-09・要件C）。
      distMm: face.depthNearMm, depthNearMm: face.depthNearMm, depthFarMm: face.depthFarMm,
      atCutPlane: face.atCutPlane === true, z0: face.z0, z1: face.z1,
    });
  }
}

// ---- 梁・柱（部材）の候補（展開図リファクタ U1b・B1。選択には参加しない）----
// 立体は切断ごとに 1 回だけ作る（layers 配列の同一性で覚える）。その切断線の近傍の部材への絞り込みも切断ごとに 1 回（cut で覚える）。
// どちらも切断・層の寿命と同じ WeakMap なので、呼び出しの間で内容が変わらない前提（探査中に graph は変わらない）。
const memberSolidsMemo = new WeakMap(); // 層の配列 → memberSolidsOfLayers の結果
const memberNearMemo = new WeakMap(); // cut → 切断線の近傍の部材
// 候補の位置の空気（天井）を引く点を、部材の芯から切断線の側へ寄せる量（visibleBeamPieces の天井判定と同じ 1mm。
// 部材が部屋の境界の通り芯に乗るとき、境界ちょうどの点が隣室のセルに落ちないように）
const MEMBER_PROBE_OFFSET_MM = 1;

/**
 * その切断の部材（梁・柱）のうち、探査範囲（cutDrawRange の延長込み）で切断線の近傍にあるものだけ。
 * 入力の層は `cut.memberLayers`（梁・柱専用の層。渡されなければ `cut.layers`）。
 * 梁: 直交するなら切断位置がスパンに入り芯±半幅の帯が範囲に掛かる／平行なら視線側にある（または切断線が梁の幅の帯を通る）
 * かつスパンが範囲に掛かる。
 * 柱: 走り方向の範囲が探査範囲に掛かり、切断線が通る（across が軸を含む）か視線側にある。
 * 候補収集（`addMemberHits`）と列の分割（`collectCutBreaks`。U1b B2）が同じ一覧を共有する（メモも共有）。
 */
export function nearMembersOf(cut) {
  let near = memberNearMemo.get(cut);
  if (near) return near;
  // memberLayers が無ければ cut.layers を使う（リード裁定: 吹抜け帯・上部吹抜け帯にも梁を出す〔ユーザー裁定 2〕ため。
  // memberLayers は将来の上階 graph 注入用）
  const layers = cut.memberLayers ?? cut.layers ?? [];
  let all = memberSolidsMemo.get(layers);
  if (!all) { all = memberSolidsOfLayers(layers); memberSolidsMemo.set(layers, all); }
  const { line } = cut;
  const sign = cut.viewSign === -1 ? -1 : 1;
  const lo = line.lo - (line.unionExtendLoMm ?? line.probeExtendLoMm ?? 0);
  const hi = line.hi + (line.unionExtendHiMm ?? line.probeExtendHiMm ?? 0);
  const overlaps = (aLo, aHi) => aHi >= lo - GAP_EPS && aLo <= hi + GAP_EPS;
  const beams = all.beams.filter(({ solid: b }) => {
    const halfW = b.widthMm / 2;
    if (!!b.isVertical !== !!line.isVertical) {
      return line.axisValue >= b.spanLo - GAP_EPS && line.axisValue <= b.spanHi + GAP_EPS
        && overlaps(b.axisWorld - halfW, b.axisWorld + halfW);
    }
    const diff = b.axisWorld - line.axisValue;
    return (Math.abs(diff) <= halfW + GAP_EPS || diff * sign > GAP_EPS) && overlaps(b.spanLo, b.spanHi);
  });
  const columns = all.columns.filter(({ solid: c }) => {
    const [runLo, runHi] = line.isVertical ? [c.yLo, c.yHi] : [c.xLo, c.xHi];
    const [acrossLo, acrossHi] = line.isVertical ? [c.xLo, c.xHi] : [c.yLo, c.yHi];
    if (!overlaps(runLo, runHi)) return false;
    return (line.axisValue >= acrossLo - GAP_EPS && line.axisValue <= acrossHi + GAP_EPS)
      || (sign > 0 ? acrossLo > line.axisValue + GAP_EPS : acrossHi < line.axisValue - GAP_EPS);
  });
  near = { beams, columns, isEmbeddedAtCut: all.isEmbeddedAtCut };
  memberNearMemo.set(cut, near);
  return near;
}

/**
 * 梁・柱（部材）を候補へ積む（展開図リファクタ U1b・B1。設計 261023_…U1〜U5の検討.md §9「候補収集」）。
 * **`visibleBandsOf` は `memberCut`／`memberFace` を選択対象から除外する**（`coverableHits`。Phase 3 の水平面ヒットと
 * 同じ出力完全不変の仕掛け）ので、ここで積んでも帯・描画は変わらない。後続（B2 列の分割・B3 選択）の材料。
 *
 * - `memberCut` … 切断線が部材を切る。直交する梁（切断位置がスパンに入り、worldMid が芯±半幅に入る）・切断線が通る柱。distMm=0。
 *   切断線が平行な梁の幅の帯を通る（|芯−line.axisValue| ≤ 半幅）梁も memberCut（壁の cutAlong に相当）で、`along:true` を付けて区別する。
 * - `memberFace` … 視線側にある部材。平行な梁（空中の梁・面の通りの梁）・視線側の柱。distMm は壁と同じ芯の距離 |芯−line.axisValue|
 *   （柱は柱の中心）。柱には視線側の手前の縁までの距離 depthNearMm も添える。
 * - z … 梁は [天−成, 天]。柱は柱の足元〜その位置の天井。**その位置の空気へ切る**: 下は列の自階の床（天が床以下の部材は積まない）、
 *   上は `probeCtx.cellAt(部材の層, 位置).ceilZ`（取れなければ梁は切らず、柱は層スタックの天井）。天井より下端が上の梁（天井裏）は積まない。
 *   **ただし memberCut の梁は天井で切らない**（現行の断面は天井裏でも描き、天井より上は emit が細破線へ降格する。
 *   天井裏を落とすのは空中・面の通りの見え掛かり〔visibleBelowCeiling〕だけ。along の memberCut も同じ）。
 *   列の自階が床の穴（吹抜け・階段吹抜け・昇降路＝`isRealRoom` でない部屋）なら下は切らない（現行の床の遮蔽の floorlessRanges と同じ。
 *   階段帯の梁はほぼこの列にあるため、穴は「床が無いから積まない」にしない）。
 * - **積まないもの** … 列の自階に部屋が無い（建物の外・未区画）列／壁に埋まった梁
 *   （立体の時点で全スパンが埋まる梁は落ちている。ここでは切断位置が壁の足元に入る梁〔`isEmbeddedAtCut`〕と、worldMid が平行な
 *   壁の足元〔`embedding.along`〕に入る梁）——hidden で積むと将来 frontMatch で壁の断面より先に選ばれ壁断面が消えるため、積まない。
 * - 付帯 … `member`（梁・柱の立体）・`memberType`（'beam'|'column'）・`section`（梁のカタログ断面。梁成 beamDepthMm の出どころ。柱は無し）・
 *   `layer`（部材の属する層。compareLayerPriority 用）。B2 が列の分割に使う部材の端は `member`（梁: axisWorld±widthMm/2・spanLo/Hi／
 *   柱: xLo/xHi/yLo/yHi）から取る。
 * `probeCtx.cellAt` が無い（簡略 probeCtx）なら何もしない。
 * @param {import('./sectionTypes.js').SectionCut} cut
 * @param {number} worldMid
 * @param {ReturnType<typeof import('./sectionProbe.js').makeProbeContext>} probeCtx
 * @param {Array} hits - 追記先
 * @param {Array} layerStack - この列の層スタック（`buildLayerStack`）
 */
function addMemberHits(cut, worldMid, probeCtx, hits, layerStack) {
  if (typeof probeCtx?.cellAt !== 'function') return;
  const near = nearMembersOf(cut);
  if (near.beams.length === 0 && near.columns.length === 0) return;
  const base = baseLayerOf(layerStack);
  // 列の自階に部屋が無い（建物の外・未区画）なら積まない。吹抜け・階段吹抜け・昇降路（実床の無い部屋＝床の穴）は積むが、
  // 床で下を切らない（現行の床の遮蔽 `occludeByFloor` の floorlessRanges＝穴では床以下も切らない、と同じ）。
  if (!base?.room) return;
  const hasFloor = isRealRoom(base.room);
  const floorZ = base.floorZ;
  const { line } = cut;
  const sign = cut.viewSign === -1 ? -1 : 1;
  const cellAtRunDepth = (layer, run, depth) => probeCtx.cellAt(layer, line.isVertical ? depth : run, line.isVertical ? run : depth);
  // 部材の z [z0,z1] を、その位置（run, depth）の空気＝[自階の床, 天井] へ切る。空気が残らなければ null。
  // z1 が Infinity（柱）のときの天井は層スタックのもの（セルが天井を持たないとき）。
  // withCeiling=false は天井で切らない（梁の断面。現行の断面は天井裏でも描き、天井より上は emit が細破線へ降格する——
  // 天井裏を落とすのは空中・面の通りの見え掛かり〔visibleBelowCeiling〕だけ。床以下を切る床の遮蔽は断面にも掛かる）。
  const clipToAir = (z0, z1, run, depth, withCeiling = true) => {
    let ceil = Infinity;
    if (withCeiling) {
      const owner = layerOwningZ(layerStack, Number.isFinite(z1) ? (z0 + z1) / 2 : z0 + GAP_EPS);
      const cellCeil = owner ? cellAtRunDepth(owner.layer, run, depth)?.ceilZ : null;
      ceil = Number.isFinite(cellCeil) ? cellCeil : (Number.isFinite(z1) ? Infinity : owner?.ceilZ ?? Infinity);
    }
    const lo = hasFloor ? Math.max(z0, floorZ) : z0, hi = Math.min(z1, ceil);
    return hi - lo > GAP_EPS ? { z0: lo, z1: hi } : null;
  };

  for (const { layer, solid: b } of near.beams) {
    const halfW = b.widthMm / 2;
    const zTop = b.topZ, zBot = b.topZ - b.depthMm;
    if (!!b.isVertical !== !!line.isVertical) {
      // 直交する梁: 切断位置がスパンに入り、worldMid が芯±半幅に入る（nearMembersOf がスパン側は済み）
      if (Math.abs(worldMid - b.axisWorld) > halfW + GAP_EPS) continue;
      if (near.isEmbeddedAtCut(cut, b)) continue;
      const z = clipToAir(zBot, zTop, worldMid, line.axisValue, false); // 断面は天井で切らない
      if (!z) continue;
      hits.push({ kind: 'memberCut', layer, distMm: 0, ...z, member: b, memberType: 'beam', section: b.section });
    } else {
      // 平行な梁（nearMembersOf が切断線の帯の中か視線側かを済み）: worldMid がスパンに入り、壁の足元に埋まっていない
      if (worldMid < b.spanLo - GAP_EPS || worldMid > b.spanHi + GAP_EPS) continue;
      if ((b.embedding?.along ?? []).some(([a, c]) => worldMid > a + GAP_EPS && worldMid < c - GAP_EPS)) continue;
      const diff = b.axisWorld - line.axisValue;
      if (Math.abs(diff) <= halfW + GAP_EPS) {
        // 切断線が梁の幅の帯を通る（壁の cutAlong に相当）: memberCut・distMm 0・along:true（直交の memberCut と区別する）。
        // 現行は parallel の細線で、描画範囲・天井裏では切らない＝天井で切らない
        const z = clipToAir(zBot, zTop, worldMid, line.axisValue, false);
        if (!z) continue;
        hits.push({ kind: 'memberCut', layer, distMm: 0, ...z, along: true, member: b, memberType: 'beam', section: b.section });
        continue;
      }
      const z = clipToAir(zBot, zTop, worldMid, b.axisWorld - sign * MEMBER_PROBE_OFFSET_MM);
      if (!z) continue;
      hits.push({ kind: 'memberFace', layer, distMm: Math.abs(diff), ...z,
        member: b, memberType: 'beam', section: b.section });
    }
  }

  for (const { layer, solid: c } of near.columns) {
    const [runLo, runHi] = line.isVertical ? [c.yLo, c.yHi] : [c.xLo, c.xHi];
    if (worldMid < runLo - GAP_EPS || worldMid > runHi + GAP_EPS) continue;
    const [acrossLo, acrossHi] = line.isVertical ? [c.xLo, c.xHi] : [c.yLo, c.yHi];
    const acrossMid = (acrossLo + acrossHi) / 2;
    const z = clipToAir(c.baseZ, Infinity, worldMid, acrossMid);
    if (!z) continue;
    if (line.axisValue >= acrossLo - GAP_EPS && line.axisValue <= acrossHi + GAP_EPS) {
      hits.push({ kind: 'memberCut', layer, distMm: 0, ...z, member: c, memberType: 'column' });
    } else {
      const nearEdge = sign > 0 ? acrossLo : acrossHi;
      hits.push({ kind: 'memberFace', layer, distMm: Math.abs(acrossMid - line.axisValue), ...z,
        depthNearMm: (nearEdge - line.axisValue) * sign, member: c, memberType: 'column' });
    }
  }
}

/**
 * 1本の列（worldMid。`collectCutBreaks`が返す隣接ペアの中点を渡す想定）に見える面の候補を
 * **深度昇順**で全て返す（§5.2 step1-2の候補収集。「z区間ごとに1つ選ぶ」（旧step3-4）は行わない）。
 * 層0件・切断線が部屋外・壁ゼロのいずれでも例外を投げず、候補が無ければ空のhits配列を返す。
 *
 * QA指摘の是正: 旧実装は`layerStack`/`unexploredBelowZ`を配列自身へ追加プロパティとして
 * 持たせていたが、**配列のプロパティはスプレッド複製（`[...hits]`）で失われる**——
 * `visibleBandsOf([...hits], cut)`のような一見安全な呼び方でslab帯がopen（アキ）に化ける実害を
 * QAが実測した。返り値を`{hits, layerStack, unexploredBelowZ}`の明示オブジェクトにし、
 * 付帯情報を配列から切り離す。
 * @param {import('./sectionTypes.js').SectionCut} cut
 * @param {number} worldMid
 * @param {ReturnType<typeof import('./sectionProbe.js').makeProbeContext>} probeCtx
 * @param {{worldLo:number, worldHi:number}|null} [span] - 列の世界座標の幅。省略は worldMid の1点。
 *   あれば斜めの天端（wallTop）の帯の上端を幅の両端の高い方に取り、wallFace ヒットへ topEdge
 *   （{zAtLo, zAtHi}＝世界座標の lo/hi 側の天端の高さ）を載せる。天端プロファイルの無い壁は span の有無に関わらず不変。
 * @returns {{hits:Array<{kind:'cut'|'cutAlong'|'wallFace'|'floorFace'|'ceilFace'|'slabFace'|'stairFace'|'memberCut'|'memberFace',
 *   wall?:import('@core').Wall, room?:object, layer:object,
 *   member?:object, memberType?:'beam'|'column', section?:object|null, depthNearMm?:number,
 *   distMm:number, z0:number, z1:number, openRanges?:Array, isKneeDrop?:boolean}>,
 *   layerStack:Array, unexploredBelowZ:number|null}}
 */
export function probeColumnHits(cut, worldMid, probeCtx, span = null) {
  const line = cut.line;
  const layerStack = buildLayerStack(cut, worldMid, probeCtx, span);
  const unexploredBelowZ = unexploredBelowZOf(cut, layerStack, worldMid);

  const hits = [];
  // 面の向こう側の部屋の種別（階段室越しの壁の判定用。必要になるまで引かない）。
  let farKind;
  const farKindOf = () => (farKind === undefined ? (farKind = farRoomAt(cut, worldMid, probeCtx)?.kind ?? null) : farKind);
  for (const info of layerStack) {
    const { layer } = info;
    if (info.ceilZ == null) continue; // 防御的ガード（fallbackCeilZにより通常到達しない）
    for (const w of graphList(layer.graph, 'walls') ?? []) {
      if (isCutWall(w, line)) {
        // Phase 6b-2 C-1: isHiddenWall該当でも候補から消さない（「描かない実体」として積む）。
        // `hidden:true`はvisibleBandsOfが選択したときだけ効く——列の分割（collectCutBreaks側の
        // isHiddenWall呼び出し）は従来どおり別判定のまま、候補収集側だけがこの変更の対象。
        const hidden = isHiddenWall(cut, w, layer, probeCtx);
        const mr = w.materialRange;
        if (worldMid < mr.lo - GAP_EPS || worldMid > mr.hi + GAP_EPS) continue;
        // アキ（腰壁＋垂れ壁）は2つの帯になる（kneeDropZRangesAt）ため、候補も範囲ごとに積む。
        const wallTop = wallTopOf(probeCtx, layer, w);
        const cutCapZ = wallTop ? profiledWallCapZ(layerStack, info, w, line.axisValue, cut, probeCtx) : info.ceilZ;
        // 斜めの天端（隔て板の天板）が切断面より向こう（視線側）で上がる分の最高＝壁の視線側の端での天端（天端は物理端まで続く。
        // 裁定 2026-10-14）。切断帯の天端より高ければ、その見え掛かりを帯の上に描く（sectionEmit.js cutWallTopBeyondSightlines）
        const topBeyondZ = wallTop && !wallTop.junction ? cutWallTopBeyondZ(w, wallTop, line.axisValue, cut.viewSign, cutCapZ) : null;
        for (const { z0, z1 } of kneeDropZRangesAt(layer.graph, w, line.axisValue, info.floorZ, cutCapZ, wallTop)) {
          // **仮想断面がその壁の建具を切っているか**（ユーザー明示指示2026-09「仮想断面抽出時、
          // 建具を切っているものがないか判定する処理を追加して反映させて」）。切断壁における
          // 「壁の長さ方向の位置」は切断線の軸そのもの（line.axisValue）——見えがかり壁が
          // worldMid（列の位置）で見るのと対になる。ここで拾ったz範囲の帯は壁ではなく建具の
          // 開口なので、`emitColumns`が壁の断面ではなく開口として描く。
          const openRanges = openingPassThroughRangesFor(
            w, layer.graph, line.axisValue, info.floorZ, z0, z1);
          hits.push({ kind: 'cut', wall: w, layer, distMm: 0, z0, z1, openRanges,
            isKneeDrop: isKneeDropRange(z0, z1, info), hidden, ...(wallTop ? { profiledTop: true } : {}),
            ...(topBeyondZ != null && topBeyondZ > z1 + GAP_EPS ? { topBeyondZ } : {}) });
        }
      } else if (isCutAlongWall(w, line)) {
        const hidden = isHiddenWall(cut, w, layer, probeCtx);
        // cutAlong（縦断された壁。§6.1「切断線がその中を通る→全幅の断面」）: x範囲=壁スパン
        // [coord1,coord2]∩切断線範囲、z範囲=kneeDropRecordsOnAxisによる実存在範囲
        // （pointCoord=worldMid。壁自身の長さ方向＝cutのrun方向と一致するためwallと同じ規約）。
        const c1 = Math.min(w.coord1, w.coord2), c2 = Math.max(w.coord1, w.coord2);
        if (worldMid < c1 - GAP_EPS || worldMid > c2 + GAP_EPS) continue;
        const wallTop = wallTopOf(probeCtx, layer, w);
        const alongCapZ = wallTop ? profiledWallCapZ(layerStack, info, w, worldMid, cut, probeCtx) : info.ceilZ;
        for (const { z0, z1 } of kneeDropZRangesAt(layer.graph, w, worldMid, info.floorZ, alongCapZ, wallTop)) {
          hits.push({ kind: 'cutAlong', wall: w, layer, distMm: 0, z0, z1,
            isKneeDrop: isKneeDropRange(z0, z1, info), hidden, ...(wallTop ? { profiledTop: true } : {}) });
        }
      } else if (isSightlineShape(w, line, cut.viewSign)) {
        const hidden = isHiddenWall(cut, w, layer, probeCtx);
        const c1 = Math.min(w.coord1, w.coord2), c2 = Math.max(w.coord1, w.coord2);
        if (worldMid < c1 - GAP_EPS || worldMid > c2 + GAP_EPS) continue;
        const distMm = Math.abs(w.axisCL.effectiveValue - line.axisValue);
        // 階段室越しの壁（viaStair）は部屋の外でも候補に残す。対象は天端が階段の裏面との取り合い（junction）の壁＝復路下の壁
        // だけ（階段室の他の壁——階段の向こうの外壁等——は従来どおり見通さない）。最初の壁だけ残すのは buildColumns。
        const wallTop = wallTopOf(probeCtx, layer, w);
        const viaStair = wallTop?.junction === true && isWallViaStairRoom(cut, w, farKindOf);
        if (!viaStair && !withinViewRoom(cut, worldMid, info, probeCtx, w)) continue; // 部屋の外の壁は描かない
        // A2の一般化: 上限（info.ceilZ）を「上が吹抜けなら上階の天井まで延ばす」規則で解決し直す
        // （sectionLayerStack.jsのresolveSightlineTopZ）。旧実装はself層の壁だけを対象に
        // 上階1段しか見ていなかったが、規則自体は層の役割にも段数にも依存しない。
        const capZ = resolveSightlineTopZ(
          layerStack, info, roomAtWallPosition(w, worldMid, cut.viewSign, probeCtx), cut.zRange?.hiZ ?? 0,
          wallContinuesOnLayer(w, worldMid),
        );
        for (const range of kneeDropZRangesAt(layer.graph, w, worldMid, info.floorZ, capZ, wallTop, span)) {
          const { z0, z1 } = range;
          // 腰壁・垂れ壁指定で高さが制限された壁か（アキのバツのクリップ対象。sectionEmit.jsの
          // obstructionRects。ユーザー実機指摘2026-08「6」C「バツが腰壁と交差する場合はクリップ」）。
          const isKneeDrop = isKneeDropRange(z0, z1, { floorZ: info.floorZ, ceilZ: capZ });
          // WP-E7 D1: この壁（見えがかり壁面）に重なる開口のz範囲を候補へ添える
          // （openingPassThroughRangesForはz0/z1へクランプ済み）。band選択後、選ばれたz区間が
          // そのいずれかに含まれれば ZBand.openingPassThrough:true を付与する（visibleBandsOf参照）。
          const openRanges = openingPassThroughRangesFor(w, layer.graph, worldMid, info.floorZ, z0, z1);
          // 斜めの天端: 帯の上端 z1 は列の幅の高い側（遮る範囲を広めに）、天端の線は topEdge（両端の高さ）で描く。
          const topEdge = topEdgeOf(range, span);
          hits.push({ kind: 'wallFace', wall: w, layer, distMm, z0, z1, openRanges, isKneeDrop, hidden,
            ...(wallTop ? { profiledTop: true } : {}), ...(topEdge ? { topEdge } : {}),
            ...(wallTop?.junction ? { junctionTop: true } : {}), ...(viaStair ? { viaStair: true } : {}) });
        }
      }
    }
    // Phase 3: 水平面ヒット（floorFace/ceilFace/slabFace）を追加する。visibleBandsOfは
    // これらを選択対象から除外するため、出力（ZBand[]）は不変のまま。
    addHorizontalFaceHits(cut, worldMid, info, probeCtx, hits);
  }
  // Phase 6b-1: 階段の占有面（stairFace）を追加する。cut.stairCutが無ければ何もしない
  // （階段帯以外は素通し）。層ごとではなく列に対して1回——stairContributionの絶対zは
  // 自階基準で層に依らないため、layerStackのループの外で良い。visibleBandsOfは選択対象から
  // 除外するため、出力（ZBand[]）は不変のまま。
  addStairFaceHits(cut, worldMid, hits);
  // U1b B1: 梁・柱（memberCut/memberFace）を積む。同じく visibleBandsOf が選択対象から除外する（出力不変）。
  addMemberHits(cut, worldMid, probeCtx, hits, layerStack);

  hits.sort(compareHitDepth);
  return { hits, layerStack, unexploredBelowZ };
}

// 深度の並び（浅い=手前が先）。cut/cutAlongは常にdistMm=0（同一平面上の実体）、wallFaceは
// 実距離。同深度の同点(cut/cutAlong)はcutを先に、wallFace同士はcompareLayerPriorityで解決する
// ——旧probeColumnのfrontMatch/wallMatch選択の並べ替え条件と完全に同じ規則を1つの比較関数へ畳む。
// QA指摘②: floorFace/ceilFace（水平面。視線の先の別室の床天井）とslabFace（自室の床構造・
// 天井懐）にも明示的なrankを割る——同じdistMmで垂直面（cut/cutAlong/wallFace＝視線を遮る実体）と
// 水平面（floorFace/ceilFace）が並ぶとき、**遮蔽物である垂直面を先にする**規則を固定する
// （実ケース: 腰壁のwallFaceと、その向こうの部屋のfloorFaceが同じ距離＝腰壁の軸位置が
// 部屋境界そのものであるため、生成順に依存させず規則で決める）。slabFaceは自室由来で
// 常にdistMm:0の番兵のため最後（rank最大）に置く——cut/cutAlong（実体の遮蔽物。同じdistMm:0）を
// 優先させるため。floorFace/ceilFaceは現状visibleBandsOfの選択には参加しない
// （`coverableHits`で除外。Phase 3は出力不変が目的）が、hits配列自体の並びは
// Phase 4以降の消費者（奥の床天井の見えがかり線を「一番近い遮蔽物」と付き合わせる処理）が
// 依存しうるため、このrankをここで固定しておく。
// QA指摘②の追記（Phase 6b-1）: stairFace（階段の占有形状。垂直な実体）はwallFaceと
// floorFace/ceilFace（水平面）の間に置く——腰壁と同様「遮蔽物である垂直面を先にする」規則を
// 階段にも適用する（stairFace自身は本Phaseでは選択に参加しないため実害は無いが、6b-2で
// 同じ規則を前提にできるようここで固定しておく）。
function kindRank(kind) {
  switch (kind) {
    case 'cut': return 0;
    case 'cutAlong': return 1;
    case 'memberCut': return 1.5; // 切断面で切られる梁・柱（壁の cut/cutAlong の次・見えがかりの壁の前）
    case 'wallFace': return 2;
    case 'memberFace': return 2.2; // 同距離なら壁の見えがかりが先
    case 'stairFace': return 2.5;
    case 'floorFace': case 'ceilFace': return 3;
    case 'slabFace': return 4;
    default: return 5;
  }
}
function compareHitDepth(a, b) {
  return (a.distMm - b.distMm) || (kindRank(a.kind) - kindRank(b.kind)) || compareLayerPriority(a, b);
}

/**
 * ヒット列（`probeColumnHits(...).hits`。深度昇順のSurfaceHit配列）を、深度最小のヒットだけ残して
 * ZBand[]へ畳み込む——現行`probeColumn`のz区間分割・選択ロジックと**完全同値**（旧`probeColumn`の
 * step3〈zBreaks組み立て〉・step4〈z区間ごとの選択・slab/openフォールバック〉をそのまま移設）。
 *
 * `hits`自体は`SurfaceHit[]`（プレーン配列。コピーしても壊れない）——slab/openフォールバックに
 * 要る`layerStack`は`opts`で**明示的に渡すこと**（QA指摘の是正。省略時に黙って`[]`へ倒すと、
 * 本来`slab`になるべき区間が`open`（アキ）に化ける実害があったため、無ければ例外にする）。
 * `unexploredBelowZ`は省略可（既定null）——`'unexploredBelowZ' in opts`で明示nullと未指定を
 * 区別する（`??`で畳むと明示nullが「未指定」と誤認される）。
 * @param {Array} hits - `probeColumnHits(...).hits`
 * @param {import('./sectionTypes.js').SectionCut} cut
 * @param {{layerStack:Array, unexploredBelowZ?:number|null}} opts - `layerStack`は必須
 *   （`probeColumnHits(...).layerStack`をそのまま渡す）。
 * @returns {import('./sectionTypes.js').ZBand[]}
 */
/**
 * z区間 (z0,z1) の**内部**（両端に触れない）にある指定kindのヒットのうち、深度が最小のもの
 * （Phase4「上限内の最も近いfloorFace/ceilFace」。設計§5.5「情報の流れ」）。
 * 深度上限そのものはここでは適用しない——上限判定には「その切断全体で最も手前の壁面」が要り、
 * 列単体を扱う`visibleBandsOf`にはその値が渡っていない。上限は`sectionEngine.js`の
 * 深度上限適用（壁と同じ場所）で掛ける。
 * 境界（z0・z1ちょうど）は対象外——そこは既に他の帯の縁として表現済みで、縮める意味が無い
 * （動かない付帯情報がwall帯にまで余分に付き、その境界にもう1本冗長な水平線が出てしまう）。
 * **floorFaceだけ、`allowBelowZ0`が真のときに限り区間の下端z0より厳密に下
 * （`h.z0 < z0 - GAP_EPS`）も候補にする**（Phase 5。設計`.claude/elevation-redesign.md`§5.5
 * 「残る非対称」の解消——実機「11'」A2型: 遠側床が近側の探査z0より低い《破線の1FL線が奥に
 * 見えている》構成では、その floorFace ヒット自体は深度最小（`distMm`最小）で実在するが、
 * 旧・区間内部限定の判定では拾えなかった）。
 * **`allowBelowZ0`はz0がこの列自身の探査下限（`cut.zRange.loZ`）と一致するときだけ真にする**
 * （呼び出し元`farFaceAnnotation`が判定）——腰壁のように、z0がこの帯自身の下（実在する
 * `wall`帯。腰壁本体）との境界でしかない場合、その下は既に壁の断面として実体があり、
 * 遠側床まで素通しに伸ばすと壁の中を突き抜けてしまう（QA是正: 深度上限超えで`open`へ作り替え
 * られた「腰壁の向こうの外周壁」帯がz0=800からz0=0へ誤って伸びる不具合を実データ相当の
 * フィクスチャで検出・修正）。
 * 上端(ceilFace)には対称ケースが無い——アキの上端は常に近側z1（この帯自身の天井）が上限
 * （`splitOpenByFarFace`のhi計算は区間内部のみ）で、z1より上のceilFaceを候補にする意味が無い
 * （`.claude/elevation-model.md`「アキの上端＝低い方の天井」）。
 * @param {Array} hits - `probeColumnHits(...).hits`（深度昇順・floorFace/ceilFaceを含む生のまま）
 * @param {'floorFace'|'ceilFace'} kind
 * @param {number} z0
 * @param {number} z1
 * @param {boolean} allowBelowZ0
 * @returns {{z0:number, distMm:number}|null}
 */
function nearestFaceInRange(hits, kind, z0, z1, allowBelowZ0) {
  let best = null;
  for (const h of hits) {
    if (h.kind !== kind) continue;
    if (h.z0 >= z1 - GAP_EPS) continue; // 上端ちょうど・より上は対象外（両kind共通）
    if (Math.abs(h.z0 - z0) < GAP_EPS) continue; // 下端ちょうどは対象外（両kind共通）
    if (h.z0 < z0 && !(kind === 'floorFace' && allowBelowZ0)) continue; // 下端より下は原則対象外
    if (!best || h.distMm < best.distMm) best = h;
  }
  return best;
}

/**
 * `open`帯へ「上限内の最も近いfloorFace/ceilFace」の付帯情報を載せる（Phase4。設計§5.5
 * 「情報の流れ」＝`farFloorZ`/`farCeilZ`/`farDepthMm`）。
 * floorFace/ceilFaceは独立に探す（同じ奥の部屋から一緒に出ることが多いが、必ずしも対にならない
 * ——例: 片方がceilZ:null《Phase3の縮退》で積まれなかった場合）。
 *
 * **床と天井は別々の実体から見つかることがある**（QA是正2026-09: 全高壁の向こうにある別室の
 * 天井が、手前の開いた室の床より深い位置から拾われる構成。「11」の向こうの全高壁を挟んだ「10」の
 * 天井が、「11」自身の床より深い位置から誤って採用されていた）——`farDepthMm`（床天井の
 * 深度の最小値）だけを返すと、**深い側（上限を超えるはずの側）の深度が浅い側の深度に隠れて
 * 上限判定をすり抜ける**。`farFloorDepthMm`/`farCeilDepthMm`を別々に返し、上限判定
 * （`sectionEngine.js`の`splitOpenByFarFace`）を床・天井それぞれで行えるようにする。
 * `farDepthMm`（両者の最小値）は後方互換のため残す——`emitColumns`の`sightRole`（線の重み）判定は
 * まだこれを使う。
 * @param {Array} hits
 * @param {number} z0
 * @param {number} z1
 * @param {number} zLo - この列自身の探査下限（`cut.zRange.loZ`。呼び出し元`visibleBandsOf`が
 *   計算済みの値をそのまま渡す）。z0がこれと一致する（＝z0より下は何も探査していない）ときだけ
 *   floorFaceの下端拡張（Phase 5）を許す。
 * @returns {{farFloorZ?:number|null, farCeilZ?:number|null, farDepthMm?:number,
 *   farFloorDepthMm?:number|null, farCeilDepthMm?:number|null}}
 */
function farFaceAnnotation(hits, z0, z1, zLo) {
  const allowBelowZ0 = Math.abs(z0 - zLo) < GAP_EPS;
  const floor = nearestFaceInRange(hits, 'floorFace', z0, z1, allowBelowZ0);
  const ceil = nearestFaceInRange(hits, 'ceilFace', z0, z1, allowBelowZ0);
  if (!floor && !ceil) return {};
  return {
    farFloorZ: floor ? floor.z0 : null,
    farCeilZ: ceil ? ceil.z0 : null,
    farDepthMm: Math.min(floor?.distMm ?? Infinity, ceil?.distMm ?? Infinity),
    farFloorDepthMm: floor?.distMm ?? null,
    farCeilDepthMm: ceil?.distMm ?? null,
  };
}

export function visibleBandsOf(hits, cut, opts = {}) {
  const zLo = cut.zRange?.loZ ?? 0;
  const zHi = cut.zRange?.hiZ ?? 0;
  if (!Array.isArray(opts.layerStack)) {
    throw new TypeError(
      'visibleBandsOf: opts.layerStackが必須です（probeColumnHits(...).layerStackをそのまま渡すこと）');
  }
  const layerStack = opts.layerStack;
  const unexploredBelowZ = 'unexploredBelowZ' in opts ? opts.unexploredBelowZ : null;

  // Phase 3（設計§5.3(b)）: 水平面ヒット（floorFace/ceilFace/slabFace）は選択対象から除外する
  // ——出力完全不変の仕掛けそのもの。これらのkindが追加される前は`hits`と`coverableHits`は
  // 常に同一だったため、この1行の追加自体が挙動を変えることはない。Phase 4で深度上限を適用して
  // 初めて、これらのkindを見る側（新しい選択ロジック）が追加される。
  // Phase 6b-1: stairFace（階段の占有形状）も同じ理由で除外する——除外しないとz0/z1が
  // 下のzBreaksへ紛れ込み、階段帯の帯がstairFaceの端で余分に分割される（`frontMatch`/
  // `wallMatch`のkindホワイトリストには最初から入っていないため選択結果自体は変わらないが、
  // `mergeAdjacentZBands`に「必ず戻る」保証を持たせるより、floorFace/ceilFace/slabFaceと
  // 同じ場所で先に弾く方が出力完全不変の仕掛けとして一貫する）。
  // U1b B1: memberCut/memberFace（梁・柱の候補。`addMemberHits`）も同じ理由で除外する——B3 で選択に入れるまでは帯・描画を変えない。
  const coverableHits = hits.filter(h =>
    h.kind !== 'floorFace' && h.kind !== 'ceilFace' && h.kind !== 'slabFace' && h.kind !== 'stairFace'
    && h.kind !== 'memberCut' && h.kind !== 'memberFace');

  // zBreaks = 全ヒットのz端点 ∪ 層の床天井 ∪ zRange端 ∪ cut.baseFloorZ（§5.2 step3。WP-E5b追加:
  // baseFloorZはemitLineの§5.6最終フィルタ（両端がbaseFloorZ未満なら向こう側=DETAIL破線へ
  // 降格）の境界そのものであり、ここをz区間の境界にしておかないと1本の線分がbaseFloorZを
  // またいでしまい、降格判定が「両端とも」を要求するせいで下側だけ降格されない
  // ——例: 壁の断面縦線が0〜chLowerMmの1本のまま出ると、seq1の「踊り場より下の壁断面=破線」
  // が成立しない。baseFloorZをz区間の境界に割ることで、下側の区間だけが正しく降格される）。
  const zSet = new Set([zLo, zHi]);
  if (cut.baseFloorZ != null) zSet.add(clamp(cut.baseFloorZ, zLo, zHi));
  for (const c of coverableHits) {
    zSet.add(clamp(c.z0, zLo, zHi)); zSet.add(clamp(c.z1, zLo, zHi));
    // WP-E7 D1: 開口のz端点もz区間の境界にする（開口の有無で'wall'帯を分割し、開口の
    // 部分だけにopeningPassThroughを付与できるようにするため）。
    for (const r of c.openRanges ?? []) { zSet.add(clamp(r.z0, zLo, zHi)); zSet.add(clamp(r.z1, zLo, zHi)); }
  }
  for (const info of layerStack) {
    if (info.floorZ != null) zSet.add(clamp(info.floorZ, zLo, zHi));
    if (info.ceilZ  != null) zSet.add(clamp(info.ceilZ,  zLo, zHi));
  }
  const zBreaks = [...zSet].sort((a, b) => a - b);

  // 各z区間で1つ選ぶ（オクルージョン優先順位。§5.2 step4）。
  const bands = [];
  for (let i = 0; i + 1 < zBreaks.length; i++) {
    const z0 = zBreaks[i], z1 = zBreaks[i + 1];
    if (z1 - z0 < GAP_EPS) continue;
    const zm = (z0 + z1) / 2;
    const covering = coverableHits.filter(c => zm > c.z0 - GAP_EPS && zm < c.z1 + GAP_EPS);

    // cut・cutAlongは同格の最前面（§6.1裁定）。同一z区間に両方あれば直交して横切るcutを
    // 優先する（cutAlongより明確に「その場を塞ぐ」実体のため）。
    const frontMatch = covering
      .filter(c => c.kind === 'cut' || c.kind === 'cutAlong')
      .sort((a, b) =>
        (a.kind === b.kind ? 0 : a.kind === 'cut' ? -1 : 1) ||
        compareLayerPriority(a, b))[0];
    if (frontMatch) {
      // Phase 6b-2 C-1: hiddenヒットが選ばれたら「描かない実体」帯——wall/distMm/opening/far
      // 付帯情報は一切持たせない（壁の実体の詳細を一切渡さない、という宣言そのもの。
      // sectionTypes.jsのZBand doc参照）。
      if (frontMatch.hidden) {
        // hiddenOf（2026-09-13）: 出自だけは持つ——'cut'は切断線上に実体がある（断面の中）、
        // 'wall'は見えがかり（手前は空気）。`sectionTypes.js`の`slabJunctionOf`（スラブの小口が
        // 壁の向こう側に見えるか）が空気かどうかを問うために要る。他の付帯情報は従来どおり持たない。
        bands.push({ kind: 'hidden', z0, z1, hiddenOf: 'cut' });
        continue;
      }
      const mr = frontMatch.wall.materialRange;
      const band = {
        kind: frontMatch.kind, z0, z1, wall: frontMatch.wall, layerRole: frontMatch.layer.role,
        thicknessMm: Math.abs(mr.hi - mr.lo), isKneeDrop: frontMatch.isKneeDrop === true,
        ...(frontMatch.profiledTop ? { profiledTop: true } : {}),
        // 切断面より向こうで上がる天板の見え掛かり（候補の上端に届いている帯だけ。topEdge と同じ規約）
        ...(frontMatch.topBeyondZ != null && Math.abs(z1 - frontMatch.z1) < GAP_EPS ? { topBeyondZ: frontMatch.topBeyondZ } : {}),
      };
      // 切断壁でも、そのz区間が建具の開口なら開口として印を付ける（見えがかり壁と同じ規約）。
      // どの建具かも持たせる——emitColumnsがその建具の断面（枠・扉）を描くため。
      const hit = (frontMatch.openRanges ?? []).find(r => zm > r.z0 - GAP_EPS && zm < r.z1 + GAP_EPS);
      if (hit) {
        band.openingPassThrough = true;
        if (hit.opening) band.opening = hit.opening;
      }
      bands.push(band);
      continue;
    }

    const wallMatch = covering
      .filter(c => c.kind === 'wallFace')
      .sort((a, b) => a.distMm - b.distMm || compareLayerPriority(a, b))[0];
    if (wallMatch) {
      // Phase 6b-2 C-1: frontMatchと同じ「描かない実体」宣言（上記コメント参照）。
      if (wallMatch.hidden) {
        bands.push({ kind: 'hidden', z0, z1, hiddenOf: 'wall' }); // 出自はfrontMatch側のコメント参照
        continue;
      }
      // QA是正（Phase4・A）: `wall`帯にも「区間内部にある最も近いfloorFace/ceilFace」の
      // 付帯情報を載せる——**選択には使わない**（wallMatchが選ばれる規則自体は不変）が、
      // `sectionEngine.js`の深度上限適用で`b.distMm`が上限超えのためこの帯自身が`open`へ
      // 作り替えられたとき（`:342-344`）、その場で新規に`{kind:'open',z0,z1}`を作ると付帯情報が
      // 引き継がれない——奥室のCHが自室と異なる図面で、手前の壁が上限超えの構成だと、線もアキ
      // 縮小も出なくなる実害があった。ここで先に載せておけば、上限超え変換時に引き継ぐだけでよい。
      const band = {
        kind: 'wall', z0, z1, wall: wallMatch.wall, layerRole: wallMatch.layer.role,
        distMm: wallMatch.distMm, isKneeDrop: wallMatch.isKneeDrop === true,
        ...farFaceAnnotation(hits, z0, z1, zLo),
        ...(wallMatch.profiledTop ? { profiledTop: true } : {}),
        // 天端が階段の裏面との取り合い（平らな天端が連続する天井との接線）か／階段室越しの壁か
        ...(wallMatch.junctionTop ? { junctionTop: true } : {}),
        ...(wallMatch.viaStair ? { viaStair: true } : {}),
        // 斜めの天端の線は、候補の上端に届いている帯（z区間の分割で上端が切られた下の帯ではない）だけが持つ。
        ...(wallMatch.topEdge && Math.abs(z1 - wallMatch.z1) < GAP_EPS ? { topEdge: wallMatch.topEdge } : {}),
      };
      // WP-E7 D1: このz区間(zm)が選ばれたwallMatchの開口z範囲のいずれかに含まれれば
      // openingPassThroughを付与する（描画は貫通させない=kindは'wall'のまま。§5.4）。
      if ((wallMatch.openRanges ?? []).some(r => zm > r.z0 - GAP_EPS && zm < r.z1 + GAP_EPS)) {
        band.openingPassThrough = true;
      }
      bands.push(band);
      continue;
    }

    // 壁が1枚も無いz区間の分類（§5.2 step4(5)）。**帯自身の階に所有Roomがある列でのみ**
    // 床スラブ・天井懐を主張する（室外の列は従来どおり全てopen＝アキX判定の対象。ユーザーの
    // 「壁の無い辺は面にしない」規則と同根の保守的な境界であり、意図して残している）。
    // **はり出し列で未探査になる高さには帯を作らない**（unexploredBelowZOf）——そこはアキでも
    // 躯体でもなく「面の外」で、slabを主張すると上階の床構造が地面まで続いてしまう。
    if (unexploredBelowZ != null && z1 <= unexploredBelowZ + GAP_EPS) continue;
    const baseInfo = baseLayerOf(layerStack);
    if (baseInfo?.room && z1 <= baseInfo.floorZ + GAP_EPS) {
      bands.push(slabBandOf(baseInfo, z0, z1)); // 帯のFLより下＝自階の床構造
      continue;
    }
    if (baseInfo?.room && z0 >= baseInfo.ceilZ - GAP_EPS) {
      // 帯の天井より上は「その高さを所有する層」で決める（layerOwningZ＝floorZMmがzm以下で
      // 最も高い層）。旧実装は`role!=='self' && floorZMm<=zm`の**配列順で最初の一致**を
      // 拾っており、層が3つ以上あるとzmを含まない階の層を掴みえた。
      //   - 所有層が帯自身の階のまま = 天井と上階の床の間の懐 → slab（非描画）
      //   - 所有層に実Roomがある = 上階の実床構造 → slab（境界がSILHOUETTEの2FL水平線になる）
      //   - 所有層が吹抜け（VOID/STAIR_VOID）または所有Room無し → open（アキX判定の対象）
      //     ……実機フィードバック第3弾G。実Roomの判定基準はresolveSightlineTopZと共有する。
      const owner = layerOwningZ(layerStack, zm);
      if (!owner || owner === baseInfo) {
        bands.push(slabBandOf(baseInfo, z0, z1));
      } else {
        bands.push(isRealRoom(owner.room) ? slabBandOf(owner, z0, z1)
          : { kind: 'open', z0, z1, ...farFaceAnnotation(hits, z0, z1, zLo) });
      }
      continue;
    }

    bands.push({ kind: 'open', z0, z1, ...farFaceAnnotation(hits, z0, z1, zLo) });
  }

  // 帯が1本も無い列は通常「候補ゼロ＝全域アキ」だが、**はり出し列では未探査で空になっただけ**
  // なので、アキを主張せず空のまま返す（面の外にアキのバツを出さない）。
  if (bands.length === 0 && unexploredBelowZ == null) {
    bands.push({ kind: 'open', z0: zLo, z1: zHi, ...farFaceAnnotation(hits, zLo, zHi, zLo) });
  }
  return mergeAdjacentZBands(bands, cut.baseFloorZ);
}

// z区間が隣接し同一の実体（同じwall/room・同じ距離）を表すband同士を1本へ統合する
// （実機フィードバック第3弾A2）。probeColumnHitsのzBreaksは複数の目的（cut/cutAlong/wall候補の
// 端点・baseFloorZ・各層のfloorZ/ceilZ）から集めるため、同一の壁・同一の距離(distMm)が続く
// 区間でも「他レイヤーの床天井位置」だけを理由に内部で区切られることがある——A2（見えがかり壁の
// z上限をabove層の実Room有無で拡張。resolveWallCapZ参照）で新たに発生するケース: 自層の壁が
// above層の天井まで伸びると、途中にabove層自身のfloorZ/ceilZがzBreaksとして挟まりz区間が
// 分割されるが、この境界は壁自体の見た目には何の変化もない。emitColumnsは各bandの上端/下端の
// 縁線を無条件に描くため、統合しないままだと実在しない水平の継ぎ目線（誤ったキャップ線と同じ
// 症状）が残ってしまう。mergeColumns（sectionEngine.js。x方向の隣接列併合）と同じ考え方を
// z方向へ適用する。
function sameZBand(a, b) {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'wall':
      // Phase4・QA是正2026-09: ここではfarFloorZ/farCeilZ/farDepthMmを**意図的に比較しない**
      // ——'open'側（下記）と同じ理由で比較を足すと、同じ壁・同じ距離(distMm)の隣接z区間が
      // floorFace/ceilFaceの付帯情報の僅かな違いだけで畳まれなくなり、本来1枚の壁の断面に
      // 実在しない継ぎ目線が出る（本関数冒頭の「上端/下端の縁線を無条件に描く」ため、畳まれず
      // 内部分割されたz区間の境界にもその縁線が重ねて出てしまう）。実機「5」（voidAbove・
      // 多層帯）で、1枚の壁の断面線に本来1本のところ縦線3本（既存のCUT線と同位置にSILHOUETTE線
      // が余分に2本）が出る回帰として発覚した。畳んだ結果どちらの付帯情報が残るかは
      // `mergeAdjacentZBands`の注記を参照——比較しない代償として、畳まれた帯の**上側だけに
      // あった**付帯情報は失われうる。
      return a.wall === b.wall && a.distMm === b.distMm && a.layerRole === b.layerRole
        && (a.openingPassThrough ?? false) === (b.openingPassThrough ?? false);
    case 'cut':
    case 'cutAlong':
      // 建具の開口で切れている区間は「同じ壁」でも別の帯（壁ではなく開口）——統合すると
      // openingPassThroughが消えて詰まった壁の断面に戻る（'wall'側と同じ理由）。
      return a.wall === b.wall && a.layerRole === b.layerRole
        && (a.openingPassThrough ?? false) === (b.openingPassThrough ?? false);
    case 'slab':
      return a.ownerRoom === b.ownerRoom && a.floorZ === b.floorZ && a.ceilZ === b.ceilZ;
    case 'hidden':
      // Phase 6b-2 C-1: hidden帯は付帯情報を（出自hiddenOf以外）持たない（wall参照すら無い）ため、
      // 出自が同じ隣接hidden同士は常に同一実体の続きとみなして良い。
      if ((a.hiddenOf ?? null) !== (b.hiddenOf ?? null)) return false;
      return true;
    case 'open':
      // Phase4: farFloorZ/farCeilZ/farDepthMmが違えば別の帯（far値が付かない列は両側undefined
      // ＝この比較は常にtrueで従来どおり。WP-E7 D1のopeningPassThroughと同じ理由——比較しないと
      // 「片方だけ水平面が見える」列が誤って統合され、その区間の一部でfarFloorZ/farCeilZが
      // 取りこぼされる）。
      return (a.farFloorZ ?? null) === (b.farFloorZ ?? null)
        && (a.farCeilZ ?? null) === (b.farCeilZ ?? null)
        && (a.farDepthMm ?? null) === (b.farDepthMm ?? null);
    default:
      return false;
  }
}

// baseFloorZの境界だけは併合しない（emitColumns/emitLineの§5.6最終フィルタは「band全体が
// baseFloorZ以下か」で降格を決めるため、baseFloorZをまたいで併合すると「下側だけ破線」が
// 再現できなくなる——probeColumnHitsが意図的にbaseFloorZをzBreaksへ割り込ませている理由
// そのもの。この境界だけは実体が同じでも独立したbandのまま残す）。
function mergeAdjacentZBands(bands, baseFloorZ) {
  const merged = [];
  for (const band of bands) {
    const last = merged[merged.length - 1];
    const atBaseFloorZ = baseFloorZ != null && Math.abs(band.z0 - baseFloorZ) < GAP_EPS;
    // QA是正2026-09: 'wall'帯を畳むとき（sameZBandがfarFloorZ/farCeilZ/farDepthMmを比較しない
    // ため）、残る付帯情報は常に`last`（zが下側＝先に積まれた帯）のもの——`band`（上側）にだけ
    // 近い水平面があった場合はそちらが失われる（過少報告側。線が余分に出ることはない）。
    // 13.stq/11.stq/knee-drop-test.stqのゴールデン差分確認では、この片側切り捨てに起因する
    // 追加の差分は見つからなかった（この関数がマージするのは`'wall'`帯どうしの隣接のみで、
    // 過少報告側＝線が減る方向なので、万一起きても実害は「見えがかり線が1本減る」程度に留まる）。
    if (last && !atBaseFloorZ && Math.abs(last.z1 - band.z0) < GAP_EPS && sameZBand(last, band)) {
      last.z1 = band.z1;
      if (band.topEdge) last.topEdge = band.topEdge; // 斜めの天端の線は上側（天端に届いている帯）のもの
      if (band.topBeyondZ != null) last.topBeyondZ = band.topBeyondZ; // 向こうで上がる天板の見え掛かりも同じ
    } else {
      merged.push({ ...band });
    }
  }
  return merged;
}

/**
 * 1本のx列（world run座標 worldMid。collectCutBreaksが返す隣接ペアの中点を渡す想定）の
 * z区間分割・オクルージョン解決（§5.2）。層0件・切断線が部屋外・壁ゼロのいずれでも例外を
 * 投げず、候補が1つも無ければ zRange 全域を1本の open ZBand として返す。
 *
 * `probeColumnHits`（候補収集・深度順）→`visibleBandsOf`（深度最小の選択・畳み込み）の
 * 合成（展開図一般化Phase 2。対外契約は不変）。
 * @param {import('./sectionTypes.js').SectionCut} cut
 * @param {number} worldMid
 * @param {ReturnType<typeof import('./sectionProbe.js').makeProbeContext>} probeCtx
 * @param {{worldLo:number, worldHi:number}|null} [span] - probeColumnHits と同じ
 * @returns {import('./sectionTypes.js').ZBand[]}
 */
export function probeColumn(cut, worldMid, probeCtx, span = null) {
  const { hits, layerStack, unexploredBelowZ } = probeColumnHits(cut, worldMid, probeCtx, span);
  return visibleBandsOf(hits, cut, { layerStack, unexploredBelowZ });
}

/**
 * 面に直交して奥へ延びる壁（視線に平行な壁）のz存在範囲（絶対z）。`sectionEmit.js`の
 * `emitOpenSpanEdgeOnWalls`（開放スパンの中に見える隔て板等の両面の縦線）が縦線を引くz範囲の情報源。
 * 見えがかり壁（wallFace候補）と**同じ式**——上限は`resolveSightlineTopZ`（上が吹抜けなら上階の天井まで）、
 * 腰壁・垂れ壁・天端プロファイルは`kneeDropZRangesAt`——で求める（別式を持たない）。
 * @param {import('./sectionTypes.js').SectionCut} cut
 * @param {{graph:object, floorZMm:number, role:string}} layer - 壁の属する層
 * @param {import('@core').Wall} wall - 面に直交する壁
 * @param {number} depth - 壁の長さ方向（視線方向）の位置。面の線での値を渡す
 * @param {number} lateral - 壁の軸CLの座標（切断線の走り方向。層スタックを引く列の位置）
 * @param {ReturnType<typeof import('./sectionProbe.js').makeProbeContext>} probeCtx
 * @returns {Array<{z0:number, z1:number}>} 層スタックに層が無い等は空
 */
export function edgeOnWallZRanges(cut, layer, wall, depth, lateral, probeCtx) {
  const stack = buildLayerStack(cut, lateral, probeCtx);
  const info = stack.find(i => i.layer === layer);
  if (!info || info.ceilZ == null) return [];
  // roomAtWallPosition / wallContinuesOnLayer は壁の向き（wall.isVertical）で軸を選ぶので、直交壁には
  // 「第2引数＝壁の長さ方向の位置」を渡す（見えがかり壁の呼び出しとは座標の役割が入れ替わるだけ）。
  const capZ = resolveSightlineTopZ(
    stack, info, roomAtWallPosition(wall, depth, cut.viewSign, probeCtx), cut.zRange?.hiZ ?? 0,
    wallContinuesOnLayer(wall, depth),
  );
  return kneeDropZRangesAt(layer.graph, wall, depth, info.floorZ, capZ, wallTopOf(probeCtx, layer, wall));
}
