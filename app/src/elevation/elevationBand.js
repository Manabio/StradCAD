/**
 * 展開図: 部屋1件 → 帯（面を横に並べ、天井高寸法・部屋名枠を付けた1段ぶんのプリミティブ）。
 * 設計意図は .claude/elevation-model.md 参照。
 *
 * R1: buildRoomBand（本ファイル）とbuildStairBand（elevationStair.js）はほぼ全域が重複していた
 * ため、面配置ループを layoutBandFaces に、帯確定処理（部屋名枠・bounds・floorOffset）を
 * finalizeBand に切り出し、両ファイルから共有する（elevationStair.jsはここからimportする。
 * 逆方向のimportは無いため循環しない）。
 */
import { figureBounds } from '../structural/sectionFigure/sectionGeometry.js';
import { faceBoundaryLocalX, faceWallLessExtents } from './elevationFaces.js';
import { composeRoomFaces, neighborWallFace } from './elevationFaceList.js';
import { buildFaceFigure, segEndProfile } from './elevationFigure.js';
import { wallAdjacentFloorSegments, familyCeilingSegments } from './elevationFloorProfile.js';
import { roomCeilingHeight } from '../finish/roomMetrics.js';
import {
  CH_DIM_OFFSET_MM, DEFAULT_FACE_GAP_MM, DEFAULT_TRIANGLE_OFFSET_MM, BAND_TOP_MARGIN_MM,
  DEFAULT_WALL_LESS_END_EXTEND_MM,
} from './elevationStyle.js';
import { translatePrimitive, collectGridCLs, appendRoomNameFrame } from './elevationPrimitives.js';

/**
 * 部屋1件ぶんの面配置ループ（buildRoomBand・buildStairBand共通。R1）。
 * faces を帯内へ横に並べてbuildFaceFigureのプリミティブを積み、先頭面にだけ天井高寸法(縦dim)を
 * 付ける。隣接面は互いの壁中心線（faceBoundaryLocalX）が ctx.gapModelMm だけ離れるよう配置する
 * （ユーザー仕様「隣接展開図の壁中心線同士が実画面で約30mmになるよう配置」。
 * ElevationModeState.init が screenMmToModelMm で換算した値を渡す。未指定時は
 * DEFAULT_FACE_GAP_MM＝倍率決定用の1パス目の仮値）。
 * @param {import('@core').Room} room
 * @param {object} graph
 * @param {object[]} faces - composeRoomFaces の結果（呼び出し側で回転等の前処理を済ませたもの）
 * @param {{project?:object, materialMap?:Map, gridCLs?:object[], gapModelMm?:number,
 *   faceLabelAvoidThresholdModelMm?:number, openingTagRowModelMm?:number,
 *   dimRowGapModelMm?:number, gridRowGapModelMm?:number, wallLessEndExtendModelMm?:number,
 *   scale?:number, faceOverride?:(face:object, i:number,
 *     defaults:{floorSegments:object[]|undefined, beyondCeilings:object[]|undefined, CH:number})
 *     => object|null}} [ctx]
 *   WP-1: ctx.faceOverride（未指定時は現行と完全同一）は面ごとにfloorSegments/beyondCeilings
 *   を計算した直後・hasLeftChDimの継ぎ目判定より前に呼ばれる（階段帯の勾配天井等、後続WP用の
 *   フック）。返り値（null/undefinedなら無効）はbuildFaceFigureへ渡すfaceCtxへ浅くマージする
 *   ——floorSegments/beyondCeilings自体を差し替えられる他、任意の追加フィールド（ceilingProfile
 *   等）もfaceCtxへそのまま乗る。継ぎ目判定（hasLeftChDim）・左CH寸法（i===0のfloorSegments[0]
 *   参照）もoverride後のfloorSegmentsを見る。i===0の返り値が`chDimSplitAbsYs:number[]`
 *   （分割する絶対高さの配列。床基準・正=床上）を持てば、帯先頭面の左CH寸法を
 *   [床,...chDimSplitAbsYs,天井]の隣接ペアごとに複数本へ分割する（ユーザー明示指示。階段帯の
 *   2FL分割で使用）。未指定時（既定）は現行どおり1本のまま。
 * @returns {{primitives:object[], faceRuns:Array<{face:object, xCursor:number}>,
 *   chDimX:number|null, prevBoundaryHi:number|null, CH:number, chInfo:object}}
 *   faceRunsは常に収集する（buildStairBandの上階クリップ処理が使う。buildRoomBand側は未使用）。
 */
export function layoutBandFaces(room, graph, faces, ctx = {}) {
  const project     = ctx.project ?? null;
  const materialMap  = ctx.materialMap ?? null;
  const gridCLs      = ctx.gridCLs ?? collectGridCLs(graph);
  const gapModelMm   = ctx.gapModelMm ?? DEFAULT_FACE_GAP_MM;
  const faceLabelAvoidThresholdModelMm = ctx.faceLabelAvoidThresholdModelMm; // 未指定はbuildFaceFigure既定(QA B3)
  const openingTagRowModelMm = ctx.openingTagRowModelMm; // 未指定はbuildFaceFigure既定(QA C1)
  const dimRowGapModelMm     = ctx.dimRowGapModelMm;      // 未指定はbuildFaceFigure既定(QA C1/D2)
  const gridRowGapModelMm    = ctx.gridRowGapModelMm;     // 未指定はbuildFaceFigure既定(QA D1)
  const wallLessEndExtendModelMm = ctx.wallLessEndExtendModelMm; // 未指定はbuildFaceFigure既定(項目1)
  const scale = ctx.scale; // 未指定はbuildFaceFigure既定=壁2段書き省略判定を行わない（項目4）
  const chInfo       = roomCeilingHeight(graph, room);
  const CH           = chInfo.mm;

  const primitives = [];
  const faceRuns = [];
  let xCursor = 0;
  let prevBoundaryHi = null; // 直前面の壁中心線(hi側)の帯内絶対x（rightAnchorXの起点。項目9はこちらのまま）
  let prevRightExtent = null; // 直前面の寸法線類を含む右端の帯内絶対x（項目6のギャップ起点）
  let chDimX = null; // 天井高寸法線のx（先頭面のみ設定。項目9の左アンカー起点）
  // 問題修正2026-08その4改（ユーザー明示指示: 「B1の右側の床は+100、つづくC1の左側の床は+0。
  // 床の起点高さが変わるので、C1の左側に天井高さの寸法線が必要」「次のA2も同様」）:
  // 直前の面の右端区間の床・天井の起点（segEndProfile）を持ち回り、次の面の左端区間と
  // 異なればその面の左側にCH寸法（左端区間の実際の床〜天井・値=実効CH）を描く。
  // 段差見付け面（floorSegments未指定）は実質的な隣接関係を変えないため持ち回りを更新しない。
  let prevRightProfile = null;
  faces.forEach((face, i) => {
    const boundary = faceBoundaryLocalX(face, graph);
    // QA G2: この面自身のhasWallAtLocal0（壁のない左端。項目1）が false なら、床線・天井線が
    // 図の外側（boundary.loよりさらに左）へwallLessEndExtendModelMmぶん延長される（buildFaceFigure
    // 側と同じ延長量。elevationFaces.jsのfaceWallLessExtents）。隣の面（prevRightExtent側）との
    // 実間隔がgapModelMmを下回らないよう、この延長ぶんをxCursor算出に加味する。
    const wallLessExtendMm = wallLessEndExtendModelMm ?? DEFAULT_WALL_LESS_END_EXTEND_MM;
    const { leftExtendMm, rightExtendMm } = faceWallLessExtents(face, wallLessExtendMm);
    // 項目4: 部分指定（referenceRoomIds）が壁際の一部を占めfloorLevelが異なる区間があれば、
    // 床線を段差付きにする（elevationFloorProfile.js。未該当なら常にフラット1区間を返す）。
    // 新仕様: 段差見付け面（kind==='step'）自体は段差そのものを表す専用描画分岐を持つため
    // floorSegmentsは渡さない（buildFaceFigure側がフラット1区間フォールバックする）。
    const rawFloorSegments = face.kind === 'step' ? undefined : wallAdjacentFloorSegments(face, room, graph);
    // 問題修正2026-08その3改: 「壁の向こう側にある部分指定関係の部屋の天井」の破線描画用
    // （far側プローブ。familyCeilingSegments）。
    const rawBeyondCeilings = face.kind === 'step' ? undefined : familyCeilingSegments(face, room, graph);
    // WP-1: ctx.faceOverride（後続WPの階段勾配天井フック）は floorSegments/beyondCeilings を
    // 計算した直後・hasLeftChDimの継ぎ目判定より前に適用する——順序を誤ると継ぎ目判定・faceCtx
    // どちらかがoverride前のfloorSegmentsを見てしまい、面ごとCH寸法の継ぎ目判定が狂う。
    const faceOverride = ctx.faceOverride?.(
      face, i, { floorSegments: rawFloorSegments, beyondCeilings: rawBeyondCeilings, CH },
    ) ?? null;
    const floorSegments  = faceOverride?.floorSegments  ?? rawFloorSegments;
    const beyondCeilings = faceOverride?.beyondCeilings ?? rawBeyondCeilings;

    // 問題修正2026-08その4改: 直前の面の右端と、この面の左端で床・天井の起点が変われば、
    // この面の左側にCH寸法を描く（下のhasLeftChDimブロック）。
    // 問題修正2026-08その6: 段差見付け面（kind==='step'。実機の「C1」）も参加する——
    // 見付け面の床=低い側床(baseFloorDeltaMm)・天井=低い側エリアの天井(ceilAbsMm)で、
    // 直前の面（例: B1の右端の床+100）と床の起点が変わればその左側にCH寸法が要る
    // （ユーザー明示指示「つづくC1の1200の左側の床は1FL+0…C1の左側に天井高さの寸法線が必要」。
    // 旧実装は見付け面を継ぎ目判定から除外しており、実機でC1の寸法が一切出なかった根本原因）。
    const stepProfile = face.kind === 'step'
      ? { floorDeltaMm: face.baseFloorDeltaMm, ceilAbsMm: face.ceilAbsMm ?? CH }
      : null;
    const leftProfile = stepProfile ?? segEndProfile(floorSegments, CH, 'first');
    const hasLeftChDim = i > 0 && prevRightProfile != null && leftProfile != null &&
      (leftProfile.floorDeltaMm !== prevRightProfile.floorDeltaMm ||
       leftProfile.ceilAbsMm !== prevRightProfile.ceilAbsMm);

    // 項目6: 隣接面の間隔(gapModelMm)は壁中心線間ではなく、寸法線類（右のCH寸法を含む）の
    // 描画範囲を基準にする——項目5で段差のある面に右CH寸法が付くと、その面のboundary.hiより
    // さらにCH_DIM_OFFSET_MMぶん右まで描画物が伸びるため、そこを基準にしないと隣の面と重なる。
    // 問題修正2026-08その4改: この面の左側にCH寸法が付く場合も、そのぶん（CH_DIM_OFFSET_MM）
    // 左端側の描画物が伸びるため加味する。
    xCursor = i === 0 ? 0 : prevRightExtent + gapModelMm - boundary.lo + leftExtendMm
      + (hasLeftChDim ? CH_DIM_OFFSET_MM : 0);

    // 項目3: 直交壁（隣・次の面）の建具が切断位置にかかる場合の断面描画用。段差見付け面
    // （kind==='step'）を挟んでも実質的な隣接関係は変わらないため、neighborWallFaceでスキップする
    // （新仕様。elevationFaceList.js）。
    const prevFace = neighborWallFace(faces, i, -1);
    const nextFace = neighborWallFace(faces, i, 1);
    // WP-1: faceOverrideの返り値をfaceCtxへ浅くマージする——floorSegments/beyondCeilings自体
    // （既にfloorSegments/beyondCeilings変数へ反映済みのため実質同じ値を上書くだけ）に加え、
    // 任意の追加フィールド（後続WPのceilingProfile等）もそのままbuildFaceFigureへ渡る。
    const faceCtx = {
      graph, project, room, ceilingHeight: CH, materialMap, gridCLs, faceLabelAvoidThresholdModelMm,
      prevFace, nextFace, openingTagRowModelMm, dimRowGapModelMm, gridRowGapModelMm, floorSegments,
      beyondCeilings, wallLessEndExtendModelMm, scale, ...(faceOverride ?? {}),
    };
    for (const p of buildFaceFigure(face, faceCtx)) primitives.push(translatePrimitive(p, xCursor, 0));
    if (i === 0) {
      chDimX = boundary.lo - CH_DIM_OFFSET_MM;
      // 問題修正2026-08(QA F1): 左CH寸法も右CH寸法（buildFaceFigure側）と同じく「左端区間の
      // 実際の床〜天井」に追従させる——帯CH固定のままだと、先頭面の左端区間に明示CHの部分指定が
      // あるとき天井線に届かない線＋食い違う値になる。左端区間が帯自身（親と同じ床・天井）の
      // ときは従来どおりchInfo.raw（傾斜天井のレンジ表記等の原文ラベル）を保つ。
      const leftSeg = floorSegments?.[0];
      const leftDelta = leftSeg?.floorDeltaMm ?? 0;
      const leftCeilAbs = leftSeg?.chMm != null ? leftDelta + leftSeg.chMm : CH;
      const isBandOwn = leftDelta === 0 && leftCeilAbs === CH;
      const leftFloorY = leftDelta ? -leftDelta : 0;
      // ユーザー明示指示（階段帯・2FLで寸法線を分ける）: faceOverrideがchDimSplitAbsYs
      // （分割する絶対高さの配列。床基準・正=床上。例: 階段帯seq1のfloorHeight=2FL）を返せば、
      // [床, ...分割点, 天井]の隣接ペアごとに複数本のdimへ分割する。未指定時は現行の1本のまま
      // （既存挙動完全不変。この節はfaceOverride側が明示的に配列を返した場合にのみ発動する）。
      const splitAbsYs = faceOverride?.chDimSplitAbsYs;
      if (Array.isArray(splitAbsYs) && splitAbsYs.length > 0) {
        const marks = [leftDelta, ...splitAbsYs, leftCeilAbs].sort((a, b) => a - b);
        for (let k = 0; k + 1 < marks.length; k++) {
          const lo = marks[k], hi = marks[k + 1];
          if (hi - lo <= 0) continue; // 分割点が床・天井と同値等、退化した区間は描かない
          primitives.push({
            type: 'dim', dir: 'v', at: chDimX, from: -hi, to: lo ? -lo : 0, foot: 0, dot: true,
            label: Math.round(hi - lo),
          });
        }
      } else {
        primitives.push({
          type: 'dim', dir: 'v', at: chDimX, from: -leftCeilAbs, to: leftFloorY, foot: 0, dot: true,
          label: isBandOwn ? chInfo.raw : Math.round(leftCeilAbs - leftDelta),
        });
      }
    } else if (hasLeftChDim) {
      // 問題修正2026-08その4改（ユーザー明示指示）: 床の起点高さが直前の面から変わった面の
      // 左側にCH寸法（この面の左端区間の実際の床〜天井・値=実効CH）。様式は先頭面の左CH寸法・
      // 右CH寸法と同じ（縦書き値・端部塗り丸）。
      const leftFloorY = leftProfile.floorDeltaMm ? -leftProfile.floorDeltaMm : 0;
      primitives.push(translatePrimitive({
        type: 'dim', dir: 'v', at: boundary.lo - CH_DIM_OFFSET_MM,
        from: -leftProfile.ceilAbsMm, to: leftFloorY, foot: 0, dot: true,
        label: Math.round(leftProfile.ceilAbsMm - leftProfile.floorDeltaMm),
      }, xCursor, 0));
    }
    faceRuns.push({ face, xCursor });
    prevBoundaryHi = xCursor + boundary.hi;
    // 問題修正2026-08その6: 段差見付け面も持ち回りを更新する（見付け面の床・天井は
    // baseFloorDeltaMm/ceilAbsMmで一様。次の面（例: A2）との継ぎ目判定に使う——
    // 「次のA2の床は1FL+100…A2の左側に天井高さの寸法線が必要」）。
    const rightProfile = stepProfile ?? segEndProfile(floorSegments, CH, 'last');
    if (rightProfile != null) prevRightProfile = rightProfile;
    // 項目5・6: この面に段差があれば右CH寸法（boundary.hi + CH_DIM_OFFSET_MM）ぶん右まで
    // 描画物が伸びる（buildFaceFigure側の実装と同じ位置の式）。
    // QA G2: この面自身のhasWallAtLocalRun（壁のない右端。項目1）が false なら、床線・天井線が
    // さらにwallLessEndExtendModelMmぶん右へ延長される（rightExtendMm。上でleftExtendMmと
    // 同時に算出済み）。項目5の右CH寸法とは独立（併発しうる）ため加算する（安全側＝実間隔が
    // 縮む方向には効かない）。
    prevRightExtent = prevBoundaryHi
      + ((floorSegments?.length ?? 0) > 1 ? CH_DIM_OFFSET_MM : 0)
      + rightExtendMm;
  });

  return { primitives, faceRuns, chDimX, prevBoundaryHi, CH, chInfo };
}

/**
 * 帯確定処理（buildRoomBand・buildStairBand共通。R1）: 部屋名枠＋左右留め三角を追加し、
 * floorOffsetの平行移動・bounds・heightMm/topMarginMmを算出して返却オブジェクトを組み立てる。
 *
 * 部屋名枠の左右留め三角は、preBounds由来の座標ではなく明示的なアンカー
 * （leftAnchorX=天井高寸法線の外側、rightAnchorX=一番右の壁中心線の外側。それぞれ
 * triOffsetMmぶん）に置く（項目9）。leftAnchorXは帯の水平初期位置の既定値としても返す
 * （band.leftAnchorX。項目10: 全帯を左三角の位置で揃える。ElevationModeState.faceOffsetFor参照）。
 *
 * WP-0: opts.heightUnits（既定1。整数）は「この帯が標準帯高さの何層分か」を表す（吹抜け帯・
 * 階段帯の2層帯用）。unitHeightMm=bounds.height/heightUnitsは「1層あたりの高さ」——
 * chooseElevationScaleが縮尺の予算基準にこちらを使うことで、2層帯が全体の縮尺を半減させない
 * （1層帯はheightUnits=1のためunitHeightMm===bounds.heightで従来と同値）。heightMm/topMarginMm/
 * boundsの既存の意味・値はheightUnits指定の有無に関わらず一切変えない。
 * @param {import('@core').Room} room
 * @param {object} graph
 * @param {object[]} primitives - layoutBandFaces等が積んだプリミティブ（この関数がpushで追記する）
 * @param {{faceCount:number, chDimX:number|null, prevBoundaryHi:number|null,
 *   triOffsetMm?:number, nameGapModelMm?:number, heightUnits?:number}} [opts]
 * @returns {{roomId:string, roomName:string, primitives:object[], bounds:object,
 *   heightMm:number, widthMm:number, faceCount:number, leftAnchorX:number|null,
 *   topMarginMm:number, heightUnits:number, unitHeightMm:number}}
 *   heightMm/topMarginMmはどちらもbounds.heightそのものではない
 *   （QA A2。elevationLayout.jsのlayoutBandsが読む積み上げ専用の値。詳細は下記コメント参照）。
 */
export function finalizeBand(room, graph, primitives, opts = {}) {
  const { faceCount = 0, chDimX, prevBoundaryHi, nameGapModelMm } = opts;
  const triOffsetMm = opts.triOffsetMm ?? DEFAULT_TRIANGLE_OFFSET_MM;
  const heightUnits = opts.heightUnits ?? 1;

  const leftAnchorX  = chDimX != null ? chDimX - triOffsetMm : null;
  const rightAnchorX = prevBoundaryHi != null ? prevBoundaryHi + triOffsetMm : null;
  appendRoomNameFrame(primitives, room.name, { nameGapModelMm, leftX: leftAnchorX, rightX: rightAnchorX });

  // 部屋の実効FL(当該階FLからの相対レベル)ぶん全体を平行移動する。
  // 調整項目6: boundsはfloorOffset適用前（基準。floorOffset=0のときの描画範囲）の座標系で
  // 計算する——適用後の座標から計算すると、帯スロットの上端を帯自身のbounds.minYへ再アンカー
  // する仕組み（elevationLayout.jsのbandContentOriginMm）が一様シフトを常に打ち消してしまい、
  // floorOffsetが床線の見た目位置に一切効かなくなる（この不具合の発見に伴う修正。
  // bounds.minX/maxX/widthはfloorOffsetがy方向のみのシフトのため適用前後で不変）。
  // 段差高さそのものの寸法線は描かない（指示どおり）。
  const rawBounds = figureBounds(primitives);
  const floorOffset = graph.effectiveFloorLevel(room) - graph.floorDatum;
  const shifted = primitives.map(p => translatePrimitive(p, 0, -floorOffset));
  // 調整項目4: 帯の描画範囲の上端（天井線・通り芯突き出しの上）にBAND_TOP_MARGIN_MMぶんの
  // 余白を確保する（minYをさらに上へ広げるだけ。他の辺は変えない）。boundsはbandContentOriginMm
  // の原点計算に使われるため、ここにfloorOffset由来の項を混ぜてはいけない（QA A2: 混ぜると
  // 上のfloorOffset不具合修正と同じ理屈で打ち消し合い、item6の効果が消えてしまう）。
  const bounds = {
    ...rawBounds, minY: rawBounds.minY - BAND_TOP_MARGIN_MM, height: rawBounds.height + BAND_TOP_MARGIN_MM,
  };
  // QA A2: floorOffsetの差だけ隣接帯の実描画間隔が縮み、重なりうる（帯自身がfloorOffsetぶん
  // 上下どちらかへずれるため。boundsはfloorOffset非依存のまま=item6のために動かせない）。
  // 「片側だけ」（例えばheightMmだけ）にMath.abs(floorOffset)を足しても、この帯自身が上へ
  // せり出す方向（floorOffsetが正）は防げない——上端がせり出すのを防ぐには「この帯を置く前に
  // 追加で空ける量」が要り、それはこの帯のheightMmではなく手前の間隔（elevationLayout.jsの
  // layoutBandsが読むtopMarginMm）でしか表現できない（bounds.minYをfloorOffset依存にすると
  // item6の打ち消し問題が再発するため、そちらでは対応できない）。そのため両方を対で確保する:
  //   heightMm    … この帯自身が下（floorOffsetが負）へせり出しても次の帯へ食い込まない
  //   topMarginMm … この帯自身が上（floorOffsetが正）へせり出しても手前の帯に食い込まれない
  // QA B2: 上記2方向は互いに排他（floorOffsetの符号でどちらか一方にしか実際にはせり出さない）
  // ため、両方に一律Math.abs(floorOffset)を足すと使わない側が過剰予約になる（例: floorOffset=-700
  // なら上方向は一切せり出さないのにtopMarginMmも700確保してしまい、実すき間がBAND_GAP_MMより
  // 700広がる＝逆に間延びする）。符号で向きごとに正しい側だけへ加算する。
  const downwardSlackMm = Math.max(0, -floorOffset); // 帯自身が下へせり出す量（floorOffset<0）
  const upwardSlackMm   = Math.max(0, floorOffset);  // 帯自身が上へせり出す量（floorOffset>0）

  return {
    roomId: room.id, roomName: room.name, primitives: shifted, bounds,
    heightMm: bounds.height + downwardSlackMm, widthMm: bounds.width, faceCount,
    leftAnchorX, topMarginMm: upwardSlackMm,
    heightUnits, unitHeightMm: bounds.height / heightUnits,
  };
}

/**
 * 部屋1件 → 帯（面を横に並べ、部屋名枠・天井高寸法を付ける）。
 * @param {import('@core').Room} room
 * @param {object} graph
 * @param {{project?:object, materialMap?:Map, gridCLs?:object[], gapModelMm?:number,
 *   nameGapModelMm?:number, triangleOffsetModelMm?:number,
 *   faceLabelAvoidThresholdModelMm?:number, openingTagRowModelMm?:number,
 *   dimRowGapModelMm?:number, gridRowGapModelMm?:number, wallLessEndExtendModelMm?:number,
 *   scale?:number}} [ctx]
 * @returns {{roomId:string, roomName:string, primitives:object[], bounds:object,
 *   heightMm:number, widthMm:number, faceCount:number, leftAnchorX:number|null,
 *   topMarginMm:number}}
 */
export function buildRoomBand(room, graph, ctx = {}) {
  const faces = composeRoomFaces(room, graph);
  const { primitives, chDimX, prevBoundaryHi } = layoutBandFaces(room, graph, faces, ctx);
  return finalizeBand(room, graph, primitives, {
    faceCount: faces.length, chDimX, prevBoundaryHi,
    triOffsetMm: ctx.triangleOffsetModelMm, nameGapModelMm: ctx.nameGapModelMm,
  });
}
