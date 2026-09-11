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
 *
 * Phase 4（`elevationStyle.js`の`HORIZONTAL_FACES_ENABLED`。裁定済み2026-09-11・既定on）:
 * `visibleBandsOf`が`open`帯へ`farFloorZ`/`farCeilZ`/`farDepthMm`（上限内の最も近いfloorFace/
 * ceilFace）を付帯情報として載せる。深度上限の適用・アキの範囲を縮める処理・見えがかり線の描画は
 * 行わない（それぞれ`sectionEngine.js`・`sectionEmit.js`が担当）。フラグoff（旧挙動比較用）では
 * この付帯情報自体を付けない（出力完全不変）。
 */
import { OpeningCategory } from '@core';
import { worldToCell } from '../../finish/gridCells.js';
import { kneeDropRecordsAtPointOnWall } from '../../finish/kneeDropWall.js';
import { effectiveHeight } from '../../openings/openingNumbering.js';
import { GAP_EPS_MM as GAP_EPS, PROBE_EPS_MM, HORIZONTAL_FACES_ENABLED } from '../elevationStyle.js';
import { graphList } from '../../graphReadScope.js';
import { localXOf } from './sectionTypes.js';
import { stairFaceHits } from './sectionStair.js';
import {
  isRealRoom, orderLayerStack, baseLayerOf, layerOwningZ,
  compareLayerPriority, resolveSightlineTopZ,
} from './sectionLayerStack.js';

// kneeDropRecordsAtPointOnWall（区間重なり判定）への点クエリ用の微小幅(mm)。GAP_EPSより大きく
// PROBE_EPS_MMより小さい値にして、区間境界ちょうどのレコードも安定して拾えるようにする。
const POINT_QUERY_EPS_MM = 0.5;

// POINT_QUERY_EPS_MMの点クエリが0件だったときの再クエリ幅(mm)——隅の取り合いで壁端がレコード
// 区間の外へ食い込む量の許容差。kneeDropWall.jsのSPAN_OVERLAP_EPSと同じ規約値（同ファイルの
// isConstituentWallが壁の全スパン基準で使う許容差そのもの。chamferWalls・wallJunctionResolveの
// CORNER_EXCLUSION・closeConvexCornersのCONTINUE_TOLとも揃えた150mm）——kneeDropZRangesAt参照。
const CORNER_OVERHANG_EPS_MM = 150;

// 「切断線が壁の中心線と同一直線上（coincident）」とみなす許容差(mm)。壁厚/2に対する
// 上乗せ分（WP-E5リード裁定・coincident壁＝cutAlongカテゴリ）。CL再スナップ等による
// サブミリ〜数mm程度の誤差を吸収する目的の小さな値（PROBE_EPS_MMと同水準）。
const COINCIDENT_TOL_MM = PROBE_EPS_MM;

function clamp(z, lo, hi) { return Math.max(lo, Math.min(hi, z)); }

/**
 * その切断が「実体ごと見ない」壁か（`cut.airRoom`／`cut.underRooms`。展開図一般化Phase 6・
 * 設計§5.4「規則へ吸収」）。
 *
 * 旧実装（`cut.hiddenWallIds`。壁idのSet）は階段下部屋の2a壁を`stairUnderInfo`が
 * footprintの内外（`FOOTPRINT_EDGE_TOL_MM`）で判定し、id単位で列挙していた——階段の帯からは
 * 「階段自身の空気ボリューム（`cut.airRoom`＝階段室）と、階段下に指定された部屋（`cut.underRooms`）
 * を隔てる壁は見えない」という規則を**id列挙という実装**でしか表せていなかった。
 *
 * 新実装: 壁の両側のセルが指すRoom（`probeCtx.cellAt`）を見る。**両側に実在の部屋があり
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
 * 消費者は`probeColumnHits`（`section/sectionHits.js`）1箇所のみ。
 * @param {import('./sectionTypes.js').SectionCut} cut
 * @param {import('@core').Wall} wall
 * @param {object} layer - その壁が属する層（`probeColumnHits`のinfo.layer）
 * @param {ReturnType<typeof import('./sectionProbe.js').makeProbeContext>} [probeCtx]
 * @returns {boolean}
 */
export function isHiddenWall(cut, wall, layer, probeCtx) {
  const airRoom = cut.airRoom;
  const underRooms = cut.underRooms;
  if (!airRoom || !underRooms?.size || layer?.role !== 'self' || typeof probeCtx?.cellAt !== 'function') {
    return false;
  }
  // **部屋の生成壁（isRoomWall）だけを対象にする**——2a壁は`generateRoomWallsFromOutline`と
  // 同型の経路で生成される（実測: 13.stqの旧hiddenWallIds4枚は全てisRoomWall:true）。
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
 * layer.graph上で、cutの run方向 worldMid・厚み方向オフセット sign*PROBE_EPS_MM の位置の
 * 所有Roomを1点プローブする（elevationFloorProfile.jsのpushGap/familyCeilingSegmentsと同じ
 * 「isVertical面ならpx=axisValue+offset・py=runCoord、そうでなければ逆」規約）。
 * @returns {import('@core').Room|null}
 */
function probeOwnerRoom(cut, worldMid, layer, probeCtx, sign) {
  return ownerRoomAtOffset(cut, worldMid, layer, probeCtx, sign * PROBE_EPS_MM);
}

// 切断線から視線方向へoffsetMm進んだ位置の所有Room（probeOwnerRoomの一般形）。
// 1点クエリはcellAt（buildSpaceIndex。makeProbeContext内で公開）の一般形なので、cellAt経由にする。
function ownerRoomAtOffset(cut, worldMid, layer, probeCtx, offsetMm) {
  const { line } = cut;
  const px = line.isVertical ? line.axisValue + offsetMm : worldMid;
  const py = line.isVertical ? worldMid : line.axisValue + offsetMm;
  return probeCtx.cellAt(layer, px, py)?.room ?? null;
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
 * 腰壁・垂れ壁指定を反映したwallのz存在**範囲の並び**（§5.2 step2）。
 * 指定なし=[[floorZ,ceilZ]]（全高）。腰壁指定=[[floorZ,floorZ+topHeight]]、垂れ壁指定=
 * [[ceilZ-bottomHeight,ceilZ]]。
 *
 * **両方同時指定（＝アキ）は2つの範囲を返す**（腰壁の帯と垂れ壁の帯）。旧実装は「腰壁優先の
 * if/else」で垂れ壁側を捨てており、その結果アキの上を塞ぐ垂れ壁が実体として存在しないことに
 * なって、`open`帯が腰壁の天端から**天井まで**伸びていた（アキ＝四角い穴にならない）。
 * アキの表現をエンジンへ一本化するにはここが実体を正しく持っていなければならない。
 * 退化（腰壁と垂れ壁が接する／重なる）した指定は1本へ潰す——穴が無いなら壁は連続した1枚。
 * @param {object} graph
 * @param {import('@core').Wall} wall
 * 点クエリに掛かるレコードでも、**wall自身がその区間の構成壁でなければ無視する**
 * （kneeDropRecordsAtPointOnWall）。隅の取り合いで隣区間へ食い込んだ壁端が隣区間の腰壁指定を
 * 拾うと、全高の壁の端だけが腰壁の高さになる（実機2026-09「22」2階 A1×X2の「腰壁の残骸」）。
 *
 * 逆に、狭い点クエリ（±POINT_QUERY_EPS_MM）が**0件**、かつ**pointCoordがwall自身の端
 * （wLo/wHi＝wall.coord1/coord2）からCORNER_OVERHANG_EPS_MM以内**のときだけ、検索窓を
 * ±CORNER_OVERHANG_EPS_MMへ広げて再クエリする（wall自身が区間の構成壁かの判定＝
 * isConstituentWallは`kneeDropRecordsAtPointOnWall`内で従来どおりwallの全スパン基準のまま
 * 変えない）。壁自身がその区間の腰壁として指定された本人でも、隅の取り合いで壁端がレコード
 * 区間の外（例: 区間端CLから57.5mm先）へ食い込むと、その食い込み部の点だけを見る狭い点クエリは
 * レコードのhi/loの外に出てしまい0件になる（実機2026-09「6」面C x=0: knee壁-1500..57.5のうち
 * 57.5mm食い込み部手前が全高に落ちていた）。CORNER_OVERHANG_EPS_MMは隅の取り合いの許容差
 * （kneeDropWall.jsのSPAN_OVERLAP_EPSと同じ規約値。chamferWalls・wallJunctionResolveの
 * CORNER_EXCLUSION・closeConvexCornersのCONTINUE_TOLとも揃えた150mm）。
 * **「壁自身の端から150mm以内」の絞り込みが必須**（QA是正2026-09）——これが無いと、
 * mergeSegmentsで結合された長い壁（例: X1..X3の1本）の、区間境界(X2)の手前150mm
 * （壁自身の端からは遠いがレコード境界には近い点）まで隣区間の腰壁指定を拾ってしまい、
 * 全高であるべき区間が腰壁の高さへ縮む誤爆になる（区間境界の手前で切り替わる従来挙動が壊れる）。
 * @param {number} pointCoord - 点クエリ位置（wall自身の長さ方向座標）
 * @param {number} floorZ
 * @param {number} ceilZ
 * @returns {Array<{z0:number, z1:number}>} 1件 or 2件（z0昇順）
 */
function kneeDropZRangesAt(graph, wall, pointCoord, floorZ, ceilZ) {
  let records = kneeDropRecordsAtPointOnWall(graph, wall, pointCoord, POINT_QUERY_EPS_MM);
  if (records.length === 0) {
    const wLo = Math.min(wall.coord1, wall.coord2), wHi = Math.max(wall.coord1, wall.coord2);
    const nearWallEnd = pointCoord < wLo + CORNER_OVERHANG_EPS_MM || pointCoord > wHi - CORNER_OVERHANG_EPS_MM;
    if (nearWallEnd) {
      records = kneeDropRecordsAtPointOnWall(graph, wall, pointCoord, CORNER_OVERHANG_EPS_MM);
    }
  }
  for (const { rec } of records) {
    if (!rec.knee && !rec.drop) continue;
    const kneeTop  = rec.knee ? floorZ + rec.knee.topHeight : null;
    const dropBase = rec.drop ? ceilZ - rec.drop.bottomHeight : null;
    if (kneeTop != null && dropBase != null) {
      // アキ（四角い穴）: 腰壁 [floorZ, kneeTop] と垂れ壁 [dropBase, ceilZ]。
      if (dropBase <= kneeTop + GAP_EPS) return [{ z0: floorZ, z1: ceilZ }]; // 穴が潰れる指定
      return [{ z0: floorZ, z1: kneeTop }, { z0: dropBase, z1: ceilZ }];
    }
    if (kneeTop != null) return [{ z0: floorZ, z1: kneeTop }];
    return [{ z0: dropBase, z1: ceilZ }];
  }
  return [{ z0: floorZ, z1: ceilZ }];
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
 * @returns {Array<{layer:object, room:object|null, floorZ:number, ceilZ:number}>}
 */
export function buildLayerStack(cut, worldMid, probeCtx) {
  // **その層の平面が届いていない位置では、その層は層スタックに現れない**（withinLayerWindow）。
  // 壁の候補だけを落とすのでは足りない——床天井の分類（slab/open）も所有層の判断
  // （`layerOwningZ`・`upperFloorZAt`）もこのスタックが情報源で、面の外に自階の床天井が
  // 残っていると、面の端に実在しない天井段差（＝上階の床の断面線）が生まれる。
  return orderLayerStack((cut.layers ?? []).filter(layer => withinLayerWindow(cut, layer, worldMid)).map(layer => {
    const room = probeOwnerRoom(cut, worldMid, layer, probeCtx, cut.viewSign);
    const floorZ = probeCtx.floorZOf(room, layer);
    // QA修正: room=nullでも壁候補は諦めない（fallbackCeilZ参照）。ceilZが実質nullになるのは
    // layer.graph自体が無い等の防御的ケースのみ。
    const ceilZ = room ? floorZ + probeCtx.chOf(room, layer.graph) : fallbackCeilZ(layer, floorZ, cut);
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
 * @returns {{hits:Array<{kind:'cut'|'cutAlong'|'wallFace'|'floorFace'|'ceilFace'|'slabFace',
 *   wall?:import('@core').Wall, room?:object, layer:object,
 *   distMm:number, z0:number, z1:number, openRanges?:Array, isKneeDrop?:boolean}>,
 *   layerStack:Array, unexploredBelowZ:number|null}}
 */
export function probeColumnHits(cut, worldMid, probeCtx) {
  const line = cut.line;
  const layerStack = buildLayerStack(cut, worldMid, probeCtx);
  const unexploredBelowZ = unexploredBelowZOf(cut, layerStack, worldMid);

  const hits = [];
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
        for (const { z0, z1 } of kneeDropZRangesAt(layer.graph, w, line.axisValue, info.floorZ, info.ceilZ)) {
          // **仮想断面がその壁の建具を切っているか**（ユーザー明示指示2026-09「仮想断面抽出時、
          // 建具を切っているものがないか判定する処理を追加して反映させて」）。切断壁における
          // 「壁の長さ方向の位置」は切断線の軸そのもの（line.axisValue）——見えがかり壁が
          // worldMid（列の位置）で見るのと対になる。ここで拾ったz範囲の帯は壁ではなく建具の
          // 開口なので、`emitColumns`が壁の断面ではなく開口として描く。
          const openRanges = openingPassThroughRangesFor(
            w, layer.graph, line.axisValue, info.floorZ, z0, z1);
          hits.push({ kind: 'cut', wall: w, layer, distMm: 0, z0, z1, openRanges,
            isKneeDrop: isKneeDropRange(z0, z1, info), hidden });
        }
      } else if (isCutAlongWall(w, line)) {
        const hidden = isHiddenWall(cut, w, layer, probeCtx);
        // cutAlong（縦断された壁。§6.1「切断線がその中を通る→全幅の断面」）: x範囲=壁スパン
        // [coord1,coord2]∩切断線範囲、z範囲=kneeDropRecordsOnAxisによる実存在範囲
        // （pointCoord=worldMid。壁自身の長さ方向＝cutのrun方向と一致するためwallと同じ規約）。
        const c1 = Math.min(w.coord1, w.coord2), c2 = Math.max(w.coord1, w.coord2);
        if (worldMid < c1 - GAP_EPS || worldMid > c2 + GAP_EPS) continue;
        for (const { z0, z1 } of kneeDropZRangesAt(layer.graph, w, worldMid, info.floorZ, info.ceilZ)) {
          hits.push({ kind: 'cutAlong', wall: w, layer, distMm: 0, z0, z1,
            isKneeDrop: isKneeDropRange(z0, z1, info), hidden });
        }
      } else if (isSightlineShape(w, line, cut.viewSign)) {
        const hidden = isHiddenWall(cut, w, layer, probeCtx);
        const c1 = Math.min(w.coord1, w.coord2), c2 = Math.max(w.coord1, w.coord2);
        if (worldMid < c1 - GAP_EPS || worldMid > c2 + GAP_EPS) continue;
        const distMm = Math.abs(w.axisCL.effectiveValue - line.axisValue);
        if (!withinViewRoom(cut, worldMid, info, probeCtx, w)) continue; // 部屋の外の壁は描かない
        // A2の一般化: 上限（info.ceilZ）を「上が吹抜けなら上階の天井まで延ばす」規則で解決し直す
        // （sectionLayerStack.jsのresolveSightlineTopZ）。旧実装はself層の壁だけを対象に
        // 上階1段しか見ていなかったが、規則自体は層の役割にも段数にも依存しない。
        const capZ = resolveSightlineTopZ(
          layerStack, info, roomAtWallPosition(w, worldMid, cut.viewSign, probeCtx), cut.zRange?.hiZ ?? 0,
          wallContinuesOnLayer(w, worldMid),
        );
        for (const { z0, z1 } of kneeDropZRangesAt(layer.graph, w, worldMid, info.floorZ, capZ)) {
          // 腰壁・垂れ壁指定で高さが制限された壁か（アキのバツのクリップ対象。sectionEmit.jsの
          // obstructionRects。ユーザー実機指摘2026-08「6」C「バツが腰壁と交差する場合はクリップ」）。
          const isKneeDrop = isKneeDropRange(z0, z1, { floorZ: info.floorZ, ceilZ: capZ });
          // WP-E7 D1: この壁（見えがかり壁面）に重なる開口のz範囲を候補へ添える
          // （openingPassThroughRangesForはz0/z1へクランプ済み）。band選択後、選ばれたz区間が
          // そのいずれかに含まれれば ZBand.openingPassThrough:true を付与する（visibleBandsOf参照）。
          const openRanges = openingPassThroughRangesFor(w, layer.graph, worldMid, info.floorZ, z0, z1);
          hits.push({ kind: 'wallFace', wall: w, layer, distMm, z0, z1, openRanges, isKneeDrop, hidden });
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
    case 'wallFace': return 2;
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
 * 「情報の流れ」＝`farFloorZ`/`farCeilZ`/`farDepthMm`）。`HORIZONTAL_FACES_ENABLED`がfalseなら
 * 常に空オブジェクト——これが出力完全不変（Phase3までの契約）を保つ唯一の分岐点。
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
  if (!HORIZONTAL_FACES_ENABLED) return {};
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
  const coverableHits = hits.filter(h =>
    h.kind !== 'floorFace' && h.kind !== 'ceilFace' && h.kind !== 'slabFace' && h.kind !== 'stairFace');

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
        bands.push({ kind: 'hidden', z0, z1 });
        continue;
      }
      const mr = frontMatch.wall.materialRange;
      const band = {
        kind: frontMatch.kind, z0, z1, wall: frontMatch.wall, layerRole: frontMatch.layer.role,
        thicknessMm: Math.abs(mr.hi - mr.lo), isKneeDrop: frontMatch.isKneeDrop === true,
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
        bands.push({ kind: 'hidden', z0, z1 });
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
      // Phase 6b-2 C-1: hidden帯は付帯情報を一切持たない（wall参照すら無い）ため、
      // 隣接するhidden同士は常に同一実体の続きとみなして良い。
      return true;
    case 'open':
      // Phase4: farFloorZ/farCeilZ/farDepthMmが違えば別の帯（フラグoffでは両方常にundefined
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
    // Phase 5でopenSpans注入をこの付帯情報へ一本化した（elevationBand.jsの`cut.openSpans`を撤去）。
    // 13.stq/11.stq/knee-drop-test.stqのゴールデン差分確認では、この片側切り捨てに起因する
    // 追加の差分は見つからなかった（この関数がマージするのは`'wall'`帯どうしの隣接のみで、
    // 過少報告側＝線が減る方向なので、万一起きても実害は「見えがかり線が1本減る」程度に留まる）。
    if (last && !atBaseFloorZ && Math.abs(last.z1 - band.z0) < GAP_EPS && sameZBand(last, band)) {
      last.z1 = band.z1;
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
 * @returns {import('./sectionTypes.js').ZBand[]}
 */
export function probeColumn(cut, worldMid, probeCtx) {
  const { hits, layerStack, unexploredBelowZ } = probeColumnHits(cut, worldMid, probeCtx);
  return visibleBandsOf(hits, cut, { layerStack, unexploredBelowZ });
}
