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
import { roomBounds } from '../finish/gridCells.js';
import { makeProbeContext } from './section/sectionProbe.js';
import { buildCutContent } from './section/sectionContent.js';
import { cutPlaneOffsetMm, faceCutLine, faceViewSign } from './section/sectionCutPlane.js';
import { structuralColumnContribution } from './section/sectionStructure.js';
import { stairContribution, stairPrimitivesForCut, clipStairUnderCeiling } from './section/sectionStair.js';
import { graphList } from '../graphReadScope.js';
import { faceBoundaryLocalX, faceWallLessExtents } from './elevationFaces.js';
import { composeRoomFaces, neighborWallFace } from './elevationFaceList.js';
import { buildFaceFigure, segEndProfile } from './elevationFigure.js';
import { wallAdjacentFloorSegments, familyCeilingSegments } from './elevationFloorProfile.js';
import { roomCeilingHeight } from '../finish/roomMetrics.js';
import {
  CH_DIM_OFFSET_MM, DEFAULT_FACE_GAP_MM, DEFAULT_TRIANGLE_OFFSET_MM, BAND_TOP_MARGIN_MM,
  DEFAULT_WALL_LESS_END_EXTEND_MM, DEFAULT_DIM_FOOT_GAP_MM,
  ElevationLineRole, weightForRole, GAP_EPS_MM as BAND_GAP_EPS,
} from './elevationStyle.js';
import {
  translatePrimitive, collectGridCLs, appendRoomNameFrame, dedupeCoincidentLines,
} from './elevationPrimitives.js';

/**
 * 帯のローカルy/z原点と階のdatumのズレ（mm）。**帯のローカル z=0 ≡ その帯の部屋の実効FL**という
 * 不変条件の単一情報源で、`finalizeBand`の平行移動量と、断面エンジンの床解決
 * （`section/sectionProbe.js`の`floorZOf`。階のdatum基準で解決した値からこれを差し引く）の両方が
 * ここを参照する——2箇所に式が分かれていたため、実効FL≠0の部屋（実機「11'」FL=100）だけ
 * エンジンの床zがfloorOffsetぶん過大になり、床断面線と重ならない中線・アキの誤った下端として
 * 現れていた（ユーザー実機指摘2026-09「「11'」B1/A2に不要な中線」）。
 * @param {import('@core').Room} room
 * @param {object} graph
 * @returns {number}
 */
export function bandFloorOffsetMm(room, graph) {
  return graph.effectiveFloorLevel(room) - graph.floorDatum;
}

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
 * @returns {{primitives:object[],
 *   faceRuns:Array<{face:object, xCursor:number, floorSegments:object[]|undefined}>,
 *   chDimX:number|null, prevBoundaryHi:number|null, CH:number, chInfo:object}}
 *   faceRunsは常に収集する（buildStairBandの上階クリップ処理・全帯共通の断面エンジン呼び出し
 *   appendBandCutContentが使う）。floorSegmentsはfaceOverride適用後の確定値。
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
  // ユーザー明示指示2026-08その13: 寸法線の足はCLから実画面3mm離す（展開図で統一）。
  // 未指定（単体テスト等）は1パス目の仮値。
  const dimFootGapMm = ctx.dimFootGapModelMm ?? DEFAULT_DIM_FOOT_GAP_MM;
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
  // 規則B（パネル統合。elevationFaceList.jsのmergeSteppedFacesIntoPanel）: 同じpanelIdを持つ
  // 連続した面は「段差でしか分かれていない1枚の壁」なので、2枚目以降はギャップ・壁のない端部の
  // 延長・CH寸法オフセットを**使わず世界x整合**で置く（面のあいだに返し壁ぶんの隙間を作らない。
  // 展開図は正投影なので返し壁は見付けの線1本になり、幅を持たない）。面ラベルはパネルで1つ
  // ——先頭メンバーがパネル全幅の中心に描き、2枚目以降はskipFaceLabelで描かない。
  const boundaries = faces.map(f => faceBoundaryLocalX(f, graph));
  const inPanelWithPrev = faces.map((f, i) =>
    i > 0 && f.panelId != null && faces[i - 1].panelId === f.panelId);
  // 先頭メンバーのindex → パネル全幅の境界（先頭メンバーのローカルx系。2枚以上のときだけ）。
  const panelLabelBoundary = new Map();
  faces.forEach((f, i) => {
    if (inPanelWithPrev[i]) return;
    let hi = boundaries[i].hi, offset = 0;
    for (let j = i + 1; j < faces.length && inPanelWithPrev[j]; j++) {
      offset += (faces[j].originWorld - faces[j - 1].originWorld) * faces[j].dirSign;
      hi = Math.max(hi, offset + boundaries[j].hi);
    }
    if (hi > boundaries[i].hi) panelLabelBoundary.set(i, { lo: boundaries[i].lo, hi });
  });
  faces.forEach((face, i) => {
    const boundary = boundaries[i];
    const prevXCursor = xCursor; // 直前の面の配置x（パネル内の世界x整合の起点）
    // 寸法線の足の終点: CLからdimFootGapMmだけ寸法線側へ離した位置（CLには触れない）。
    // 寸法線(at)を越えない範囲にクランプする（極端な小縮尺で足が反転しないように）。
    const footBefore = (clX, sign) => (sign < 0
      ? Math.max(clX - dimFootGapMm, clX - CH_DIM_OFFSET_MM)
      : Math.min(clX + dimFootGapMm, clX + CH_DIM_OFFSET_MM));
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
    // 階段の高さ寸法（ユーザー明示指示2026-08その12）: faceOverrideがchDimChains
    // （{left,right}: [lo,hi]の配列。床基準の絶対高さ）を返す帯では、CH寸法の判断を
    // **すべて呼び出し側（elevationStairSequence.jsのstairChDimChains）へ委ねる**
    // ——「断面から断面まで」「前の端と高さが変わったときだけ記入」という規則は面の床・天井の
    // 継ぎ目だけでは決まらず（踊り場スラブ・壁の向こうの部屋の断面が要る）、この場では判定できない。
    const chDimChains = faceOverride?.chDimChains ?? null;
    // パネル内の継ぎ目にはCH寸法を立てない（立つとCH_DIM_OFFSET_MMぶんの隙間が入り、
    // 世界x整合＝壁芯間の鎖・通り芯の世界位置が壊れる。規則B）。
    const hasLeftChDim = inPanelWithPrev[i] ? false
      : chDimChains ? (chDimChains.left?.length ?? 0) > 0
      : (i > 0 && prevRightProfile != null && leftProfile != null &&
        (leftProfile.floorDeltaMm !== prevRightProfile.floorDeltaMm ||
         leftProfile.ceilAbsMm !== prevRightProfile.ceilAbsMm));

    // 項目6: 隣接面の間隔(gapModelMm)は壁中心線間ではなく、寸法線類（右のCH寸法を含む）の
    // 描画範囲を基準にする——項目5で段差のある面に右CH寸法が付くと、その面のboundary.hiより
    // さらにCH_DIM_OFFSET_MMぶん右まで描画物が伸びるため、そこを基準にしないと隣の面と重なる。
    // 問題修正2026-08その4改: この面の左側にCH寸法が付く場合も、そのぶん（CH_DIM_OFFSET_MM）
    // 左端側の描画物が伸びるため加味する。
    xCursor = i === 0 ? 0
      : inPanelWithPrev[i]
        // 規則B: パネル内2枚目以降は世界x整合（同letterなのでdirSignは共通）。
        ? prevXCursor + (face.originWorld - faces[i - 1].originWorld) * face.dirSign
        : prevRightExtent + gapModelMm - boundary.lo + leftExtendMm
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
      beyondCeilings, wallLessEndExtendModelMm, scale, solids: ctx.solids ?? null,
      dimFootGapModelMm: dimFootGapMm,
      // 規則B: 面ラベルはパネルで1つ（2枚目以降は描かず、先頭はパネル全幅の中心へ）。
      skipFaceLabel: inPanelWithPrev[i], faceLabelBoundary: panelLabelBoundary.get(i),
      ...(faceOverride ?? {}),
    };
    const facePrims = buildFaceFigure(face, faceCtx);
    for (const p of facePrims) primitives.push(translatePrimitive(p, xCursor, 0));
    if (chDimChains) {
      // 渡された鎖をそのまま左右へ描く（様式は既存のCH寸法と同じ: 縦書き値・足0・端部塗り丸）。
      const emit = (chain, atX, footX) => {
        for (const [lo, hi] of chain ?? []) {
          primitives.push(translatePrimitive({
            type: 'dim', dir: 'v', at: atX, from: -hi, to: lo ? -lo : 0, foot: footX, dot: true,
            label: Math.round(hi - lo),
          }, xCursor, 0));
        }
      };
      // 足はその寸法自身の側のCLの手前で止める（＝反対側のCLまで伸ばさない）。
      emit(chDimChains.left,  boundary.lo - CH_DIM_OFFSET_MM, footBefore(boundary.lo, -1));
      emit(chDimChains.right, boundary.hi + CH_DIM_OFFSET_MM, footBefore(boundary.hi, +1));
      if (i === 0) chDimX = boundary.lo - CH_DIM_OFFSET_MM; // 部屋名枠の左アンカー起点は従来どおり
    } else if (i === 0) {
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
            type: 'dim', dir: 'v', at: chDimX, from: -hi, to: lo ? -lo : 0, foot: footBefore(boundary.lo, -1), dot: true,
            label: Math.round(hi - lo),
          });
        }
      } else {
        primitives.push({
          type: 'dim', dir: 'v', at: chDimX, from: -leftCeilAbs, to: leftFloorY, foot: footBefore(boundary.lo, -1), dot: true,
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
        from: -leftProfile.ceilAbsMm, to: leftFloorY, foot: footBefore(boundary.lo, -1), dot: true,
        label: Math.round(leftProfile.ceilAbsMm - leftProfile.floorDeltaMm),
      }, xCursor, 0));
    }
    // 断面エンジン（buildCutContent）へ渡す天井の区間情報は、**天井断面線を実際に引いている値**
    // そのもの＝ここで確定したfloorSegmentsから作る（「断面の中は描画しない」の単一情報源）。
    // faceOverride適用後の値を返すこと（吹抜けの多層書きは上階天井まで伸ばした区間を持つ）。
    // boundary（面の両端の壁中心線。ローカルx）も渡す——上階ぶんのCH寸法を「その端に上階の
    // 断面がある面」の左へ置くために要る（elevationVoid.jsのappendUpperStoreyTrim）。
    faceRuns.push({ face, xCursor, floorSegments, boundary });
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
  // 1枚の帯へは buildFaceFigure と断面エンジンの2経路が流れ込むため、同じ実体の縁を別の理由で
  // 描いた**完全同一の線**が重なりうる（面端の縦線＝体裁としての端の縦線かつ壁断面の縁など）。
  // 帯が確定するこの1箇所で畳む（dedupeCoincidentLines。見た目は不変・視覚回帰の差分だけが減る）。
  const prims = dedupeCoincidentLines(primitives);
  appendRoomNameFrame(prims, room.name, { nameGapModelMm, leftX: leftAnchorX, rightX: rightAnchorX });

  // 部屋の実効FL(当該階FLからの相対レベル)ぶん全体を平行移動する。
  // 調整項目6: boundsはfloorOffset適用前（基準。floorOffset=0のときの描画範囲）の座標系で
  // 計算する——適用後の座標から計算すると、帯スロットの上端を帯自身のbounds.minYへ再アンカー
  // する仕組み（elevationLayout.jsのbandContentOriginMm）が一様シフトを常に打ち消してしまい、
  // floorOffsetが床線の見た目位置に一切効かなくなる（この不具合の発見に伴う修正。
  // bounds.minX/maxX/widthはfloorOffsetがy方向のみのシフトのため適用前後で不変）。
  // 段差高さそのものの寸法線は描かない（指示どおり）。
  const rawBounds = figureBounds(prims);
  const floorOffset = bandFloorOffsetMm(room, graph);
  const shifted = prims.map(p => translatePrimitive(p, 0, -floorOffset));
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
 * 区間（`floorSegments`）→ 断面エンジンの `cut.ceilProfile`（区間ごとの天井断面の絶対高さ）。
 *
 * 値は `buildFaceFigure` が**天井断面線を実際に引いている式**（`ceilAbs = floorDeltaMm + chMm`、
 * `chMm`未指定は帯のCH）と同一にする——「展開図では断面の中は描画しない」（ユーザー明示指示
 * 2026-08）の打ち切り高さは、その面に描かれている天井線そのものでなければならない。
 * @param {Array<{loX:number, hiX:number, floorDeltaMm?:number, chMm?:number}>|undefined} segs
 * @param {number} run - 面の走り長さ（segs未指定時のフォールバック区間の幅）
 * @param {number} CH - 帯のCH（chMm未指定区間の天井絶対高さフォールバック）
 * @returns {Array<{loX:number, hiX:number, ceilZ:number}>}
 */
export function ceilProfileFromSegments(segs, run, CH) {
  if (!segs?.length) return [{ loX: 0, hiX: run, ceilZ: CH }];
  return segs.map(s => ({ loX: s.loX, hiX: s.hiX, ceilZ: (s.floorDeltaMm ?? 0) + (s.chMm ?? CH) }));
}

/**
 * 区間（`floorSegments`）→ 断面エンジンの `cut.floorZProfile`（`ceilProfileFromSegments`の
 * **床側の双子**。区間ごとの床断面の高さ。帯のFL基準）。
 *
 * 下階の層への探査窓のgate（`section/sectionContent.js`の`planeOverhangForFace`）が
 * 「その端で帯の床が下階の空間まで下りているか」を判定する材料であり、**図側のはり出し量**
 * （`elevationVoid.js`の`lowerOverhangForFace`）も同じこの値から出す——gateの材料を
 * 帯ごとに作り直さないための単一の変換。
 * @param {Array<{loX:number, hiX:number, floorDeltaMm?:number}>|undefined} segs
 * @param {number} run - 面の走り長さ（segs未指定時のフォールバック区間の幅）
 * @returns {Array<{loX:number, hiX:number, floorZ:number}>}
 */
export function floorZProfileFromSegments(segs, run) {
  if (!segs?.length) return [{ loX: 0, hiX: run, floorZ: 0 }];
  return segs.map(s => ({ loX: s.loX, hiX: s.hiX, floorZ: s.floorDeltaMm ?? 0 }));
}

/**
 * 帯の全面を断面エンジン（`section/sectionContent.js`の`buildCutContent`）へ通し、
 * **壁の輪郭**（断面・見えがかり・アキ）を`primitives`へ積む——**全4種の帯**（通常の部屋・
 * 上部吹抜けを持つ部屋・吹抜け・階段）に共通する唯一の入口。
 *
 * これがあることで「壁の実体に属する表現」を足すときの変更箇所が`section/`の中だけで済む
 * （旧: `buildFaceFigure`と断面エンジンの両方へ書かないと片方だけ線が欠け、例外もログも出ない）。
 * 床線・天井線・端の縦線・幅木・建具・注記帯は`buildFaceFigure`側の責務のまま。
 *
 * 層スタック（`layers`）だけが帯ごとの違い——通常の部屋帯は自階1層、上部吹抜けは自階＋上階、
 * 吹抜け帯は自階＋下階。切断線の位置・探査延長・アキ・線種はすべて共通経路が決める。
 * @param {object[]} primitives - 積み先（`layoutBandFaces`の結果に追記する）。
 *   **`opts.stairOver`を指定する呼び出しでは、図のプリミティブ（`layoutBandFaces`の結果）を
 *   含む配列を渡すこと**——階段固有の後処理2つ（`lowerFaceEndVertical`＝面端の縦線の上端下げ、
 *   `trimCeilingLineAt`＝天井断面線の打ち切り）は、この配列を**走査して既存の線を書き換える**。
 *   空配列を渡すと例外もログも出ずに黙って何も起きない（＝階段断面と天井・端の縦線が
 *   取り合わない図になる）。`stairOver`を渡さない呼び出しはこの制約の対象外。
 * @param {import('@core').Room} room - 帯自身の部屋（見えがかり探索を帯の広がりに限る）
 * @param {object} graph - 帯自身の階のgraph
 * @param {ReturnType<typeof layoutBandFaces>} layout
 * @param {Array<{graph:object, floorZMm:number, role:'self'|'above'|'below'}>} layers
 * @param {{endExtendMm?:number, includeFace?:(face:object)=>boolean,
 *   upperPlaneOverhang?:boolean, faceOverhangOf?:(face:object)=>{lo:number,hi:number}|undefined,
 *   onFaceColumns?:(face:object, columns:object[])=>void}} [opts]
 *   includeFace … 断面エンジンへ通す面の絞り込み（既定=すべて）。
 *   onFaceColumns … 面ごとの列（`buildCutContent`の`columns`）の通知（既定=無し）。図側が
 *     列からしか分からない値を必要とする帯（上部吹抜けを持つ部屋帯の上階FL断面線の起点）用。
 *   upperPlaneOverhang … 層ごとの探査窓（`section/sectionContent.js`）を使うか（既定false＝現行と
 *     完全同一）。faceOverhangOf … その面の描画範囲を外へ広げる量（面ローカル。既定=広げない）。
 *     **2つは対で指定する**——探査だけ広げると面の外の列が描画範囲でクリップされて消え、
 *     描画範囲だけ広げても面の外に実データが無い。値の出どころは両方とも`planeOverhangForFace`。
 */
// 矩形どうしが面積を持って重なるか（mm。接しているだけは重なりとみなさない）。
const OVER_ROOM_EPS_MM = 1;
function rectsOverlap(a, b) {
  return Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1) > OVER_ROOM_EPS_MM
    && Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1) > OVER_ROOM_EPS_MM;
}

// flightの世界矩形（走行×幅）。
function flightRect(f) {
  return f.isVertical
    ? { x1: f.acrossLo, x2: f.acrossHi, y1: f.runLo, y2: f.runHi }
    : { x1: f.runLo, x2: f.runHi, y1: f.acrossLo, y2: f.acrossHi };
}

/**
 * その部屋の**上を通る**レーンだけ（折返し階段は往路・復路の2レーンを持ち、階段下の部屋の上に
 * あるのは普通どちらか一方——面の高さ・ささらの見え方はそのレーンで決まる）。
 * @param {{flights:object[]}} contribution
 * @param {{x1:number,y1:number,x2:number,y2:number}|null} bounds - 帯の部屋の包絡矩形
 */
function flightsOverRoom(contribution, bounds) {
  const flights = contribution?.flights ?? [];
  if (!bounds) return flights;
  return flights.filter(f => rectsOverlap(bounds, flightRect(f)));
}

/**
 * この部屋の**上を通る**階段の3D寄与（ユーザー明示指示2026-09「「13」D: 天井に階段断面と
 * ささら（下）みえがかりが正解」）——階段下の部屋の展開図には、その上を通る階段が
 * 断面・見えがかりとして現れる。階段室自身（`stair.roomId === room.id`）は`buildStairBand`の
 * 担当なので除く。
 *
 * 判定はflightの世界矩形（走行×幅）が部屋の包絡矩形と面積を持って重なるか——`stair.cells`と
 * 部屋のセルは階段下の部屋では重複して登録されうるため、セルの所有ではなく幾何で見る。
 * @param {import('@core').Room} room
 * @param {object} graph
 * @param {number|null|undefined} floorHeight - 設置階〜上階の階高（stairContributionの必須入力）
 * @returns {ReturnType<typeof stairContribution>|null}
 */
export function stairContributionOverRoom(room, graph, floorHeight) {
  if (floorHeight == null) return null;
  const b = roomBounds(room.cells, graph);
  if (!b) return null;
  for (const stair of graph.stairs ?? []) {
    if (stair.roomId === room.id) continue;
    const contribution = stairContribution(stair, graph, floorHeight);
    if (!contribution) continue;
    if (flightsOverRoom(contribution, b).length > 0) return contribution;
  }
  return null;
}

/**
 * 面の壁（axisCL上・面の区間に掛かる実壁）の材の世界範囲の合併。無ければnull。
 */
function faceWallMaterialRange(face, graph) {
  let lo = Infinity, hi = -Infinity;
  for (const w of graphList(graph, 'walls') ?? []) {
    if (w.isVertical !== face.isVertical || w.axisCL.id !== face.axisCL.id) continue;
    const c1 = Math.min(w.coord1, w.coord2), c2 = Math.max(w.coord1, w.coord2);
    if (c2 <= face.lo + BAND_GAP_EPS || c1 >= face.hi - BAND_GAP_EPS) continue;
    if (!w.materialRange) continue;
    lo = Math.min(lo, w.materialRange.lo);
    hi = Math.max(hi, w.materialRange.hi);
  }
  return Number.isFinite(lo) ? { lo, hi } : null;
}

/**
 * この面から、上を通るレーンのささらの見えがかりが見えるか（ユーザー明示指示2026-09
 * 「「13」B: ささら（下）は、B面壁の向こう側なので見えない（=描画しないが正解）」）。
 *
 * レーンの幅方向の端（＝そのささらが立つ通り）が、**その面の壁の材を挟んで向こう側**にあれば
 * 見えない。実機「13」はB面の壁が偏芯していて材が x=−1665〜−1550（部屋の側へ165張り出す）に
 * あり、レーンの東端（x=−1500）はその向こう側——一方D面は材が −3057.5〜−2942.5 で、レーンの
 * 西端（x=−3000）は材の中なので見える（＝ご指示の「D: ささら（下）みえがかりが正解」）。
 * 面と平行に走るレーンが無ければ側面視ではないので判定対象外（true）。
 * @param {object} face
 * @param {object} graph
 * @param {{flights:object[]}} contribution
 * @returns {boolean}
 */
function stringerSightlineVisible(face, graph, contribution, bounds) {
  const flight = flightsOverRoom(contribution, bounds).find(f => f.isVertical === face.isVertical);
  if (!flight) return true;
  const mr = faceWallMaterialRange(face, graph);
  if (!mr) return true;
  return face.inward > 0
    ? flight.acrossLo >= mr.lo - BAND_GAP_EPS
    : flight.acrossHi <= mr.hi + BAND_GAP_EPS;
}

/**
 * その面が図として描かれるローカルx範囲（buildFaceFigureのdrawnX0/drawnXRunと同じ規約）。
 * 壁のある端はその端まで、壁のない端だけ`extendMm`ぶん外へ延ばす。
 *
 * `overhang`（面ローカル。省略＝0＝現行と完全同一）は**他の層の平面が面の端より外へ続いている
 * 量**（`section/sectionContent.js`の`planeOverhangForFace`）——その端の壁エッジを描くために、
 * 描画範囲をそのぶん外へ広げる。壁のない端では`planeOverhangForFace`が0を返すので、
 * 体裁のはり出し（`extendMm`）と二重に足されることはない。
 * @param {object} face
 * @param {number} extendMm
 * @param {{lo:number,hi:number}} [overhang]
 */
function faceDrawnXRange(face, extendMm, overhang) {
  return {
    lo: ((face.hasWallAtLocal0 ?? true) ? 0 : -extendMm) - (overhang?.lo ?? 0),
    hi: ((face.hasWallAtLocalRun ?? true) ? face.run : face.run + extendMm) + (overhang?.hi ?? 0),
  };
}

/**
 * 断面エンジンの出力を、その面が描かれる範囲（faceDrawnXRange）へ切り詰める。
 *
 * 探査は端の取り合いを見るために面の外まで延長する（withProbeExtension）が、**壁のある端の
 * 向こうは描かない**——ユーザー明示指示2026-09「「13」C: 左側壁断面の左側にある縦線（2本）は、
 * 壁の向こう側なので描画不要」。壁のない端の延長（続きがあることを示すはね出し）は
 * faceDrawnXRangeがそのまま許すので従来どおり。
 */
function clipContentToFace(prims, range) {
  const inX = x => x >= range.lo - BAND_GAP_EPS && x <= range.hi + BAND_GAP_EPS;
  const out = [];
  for (const q of prims) {
    if (q.type === 'line') {
      const lo = Math.min(q.x1, q.x2), hi = Math.max(q.x1, q.x2);
      if (hi < range.lo - BAND_GAP_EPS || lo > range.hi + BAND_GAP_EPS) continue;
      if (lo >= range.lo - BAND_GAP_EPS && hi <= range.hi + BAND_GAP_EPS) { out.push(q); continue; }
      if (Math.abs(q.x1 - q.x2) < BAND_GAP_EPS) continue; // 縦線は範囲外なら落とすだけ
      const at = t => [q.x1 + (q.x2 - q.x1) * t, q.y1 + (q.y2 - q.y1) * t];
      const tOf = x => (x - q.x1) / (q.x2 - q.x1);
      const t0 = Math.min(Math.max(tOf(range.lo), 0), 1), t1 = Math.min(Math.max(tOf(range.hi), 0), 1);
      const [ta, tb] = t0 <= t1 ? [t0, t1] : [t1, t0];
      if (tb - ta < 1e-9) continue;
      const [x1, y1] = at(ta), [x2, y2] = at(tb);
      out.push({ ...q, x1, y1, x2, y2 });
    } else if (q.type === 'polyline' && Array.isArray(q.points)) {
      for (const pts of clipPolylineX(q.points, range.lo, range.hi)) out.push({ ...q, points: pts });
    } else if (q.type === 'text' || q.type === 'rect') {
      if (inX(q.x)) out.push(q);
    } else {
      out.push(q);
    }
  }
  return out;
}

// 点列をx範囲[lo,hi]でクリップし、連続する残り区間ごとの点列を返す（範囲の境界では補間する
// ——点の取捨だけだと、範囲を跨ぐ2点の線分がまるごと消える）。
function clipPolylineX(points, lo, hi) {
  const out = [];
  let run = [];
  const push = pt => {
    const last = run[run.length - 1];
    if (!last || Math.abs(last[0] - pt[0]) > 1e-9 || Math.abs(last[1] - pt[1]) > 1e-9) run.push(pt);
  };
  const flush = () => { if (run.length > 1) out.push(run); run = []; };
  for (let i = 0; i + 1 < points.length; i++) {
    const [x1, y1] = points[i], [x2, y2] = points[i + 1];
    const at = t => [x1 + (x2 - x1) * t, y1 + (y2 - y1) * t];
    let ta = 0, tb = 1;
    if (Math.abs(x2 - x1) < 1e-9) {
      if (x1 < lo - BAND_GAP_EPS || x1 > hi + BAND_GAP_EPS) { flush(); continue; }
    } else {
      const t0 = (lo - x1) / (x2 - x1), t1 = (hi - x1) / (x2 - x1);
      ta = Math.max(0, Math.min(t0, t1));
      tb = Math.min(1, Math.max(t0, t1));
      if (tb - ta < 1e-9) { flush(); continue; }
    }
    push(at(ta)); push(at(tb));
    if (tb < 1 - 1e-9) flush(); // 線分の途中で範囲外へ出た＝ここで途切れる
  }
  flush();
  return out;
}

/**
 * その走行位置（世界座標）での階段（flight）の段鼻の高さ。区間の外は端の高さでクランプする。
 */
function stairZAtRun(flight, runWorld) {
  const start = flight.travelSign > 0 ? flight.runLo : flight.runHi;
  const end   = flight.travelSign > 0 ? flight.runHi : flight.runLo;
  if (Math.abs(end - start) < BAND_GAP_EPS) return flight.baseZ;
  const t = Math.min(Math.max((runWorld - start) / (end - start), 0), 1);
  return flight.baseZ + t * flight.steps * flight.riserMm;
}

/**
 * 面の端の縦線（SILHOUETTE。buildFaceFigureが天井から床まで引く）の上端を`topY`まで下げる。
 * 階段下の部屋では、その端の天井は階段そのもの（ユーザー明示指示2026-09「「13」B: 左の壁断面：
 * 階段断面との取り合いまで」「「13」D: 右の縦断面は、階段断面と出会ったところが終点」）。
 */
function lowerFaceEndVertical(primitives, xCursor, localX, ceilAbs, topY) {
  // **線種で絞らない**——面端の縦線は壁断面(CUT)で描かれ（仮想断面を横切る壁がある端）、
  // 同じ位置に断面エンジンの凹み側面線(SILHOUETTE)も出る。中線だけを対象にすると、
  // 壁断面は天井まで伸びたまま中線だけが階段の高さで止まり、取り合わない（実機「13」B・D）。
  const weights = new Set([weightForRole(ElevationLineRole.SILHOUETTE), weightForRole(ElevationLineRole.CUT)]);
  const x = xCursor + localX;
  for (let i = 0; i < primitives.length; i++) {
    const q = primitives[i];
    if (q.type !== 'line' || !weights.has(q.weight)) continue;
    if (Math.abs(q.x1 - x) > BAND_GAP_EPS || Math.abs(q.x2 - x) > BAND_GAP_EPS) continue;
    const top = Math.min(q.y1, q.y2), bottom = Math.max(q.y1, q.y2);
    if (Math.abs(top + ceilAbs) > BAND_GAP_EPS) continue; // その面の天井から立ち上がる縦線だけ
    if (topY <= top + BAND_GAP_EPS) continue;
    primitives[i] = { ...q, x1: x, y1: topY, x2: x, y2: bottom };
  }
}

/**
 * 天井断面線（CUTの水平線）を、階段断面とぶつかったxで止める。`primitives`のうちこの面の
 * パネル範囲に掛かる y=-ceilAbs の水平CUT線だけを対象に、残す側へ縮める（範囲外になった線は
 * 取り除く）。図（buildFaceFigure）は断面エンジンより前に組まれるため、階段断面との交点は
 * ここでしか分からない——交点は描かれた階段断面そのもの（clipStairUnderCeilingのcrossXs）から
 * 採るので、天井線と階段断面はかならず同じ点で出会う。
 */
function trimCeilingLineAt(primitives, xCursor, face, ceilAbs, keep) {
  const cutWeight = weightForRole(ElevationLineRole.CUT);
  const y = -ceilAbs;
  const panelLo = xCursor - DEFAULT_WALL_LESS_END_EXTEND_MM - 1;
  const panelHi = xCursor + face.run + DEFAULT_WALL_LESS_END_EXTEND_MM + 1;
  for (let i = primitives.length - 1; i >= 0; i--) {
    const q = primitives[i];
    if (q.type !== 'line' || q.weight !== cutWeight) continue;
    if (Math.abs(q.y1 - y) > BAND_GAP_EPS || Math.abs(q.y2 - y) > BAND_GAP_EPS) continue;
    const lo = Math.min(q.x1, q.x2), hi = Math.max(q.x1, q.x2);
    if (hi < panelLo || lo > panelHi) continue;
    const nLo = Math.max(lo, keep.lo), nHi = Math.min(hi, keep.hi);
    if (nHi - nLo <= BAND_GAP_EPS) { primitives.splice(i, 1); continue; }
    primitives[i] = { ...q, x1: nLo, x2: nHi };
  }
}

export function appendBandCutContent(primitives, room, graph, layout, layers, opts = {}) {
  const endExtendMm = opts.endExtendMm ?? DEFAULT_WALL_LESS_END_EXTEND_MM;
  const includeFace = opts.includeFace ?? (() => true);
  // 帯のz原点は**この帯の部屋の実効FL**（finalizeBandの平行移動と対）。プローブの床解決は階の
  // datum基準なので、その差を渡して差し引かせる（floorOffset=0の帯では出力完全不変）。
  const probeCtx = makeProbeContext(layers, { floorOffsetMm: bandFloorOffsetMm(room, graph) });
  const bandRoomBounds = roomBounds(room.cells, graph);
  // 柱型は全層ぶんを一度だけ求めて全面で使い回す（仮想断面位置の決定に使う。層ごとに引き直すと
  // 面の数×層の数だけ全柱を走査することになる）。
  const columnSolids = structuralColumnContribution(layers);
  layout.faceRuns.forEach(({ face, xCursor, floorSegments }, i) => {
    // 段差見付け面（kind==='step'）は「面」ではなく段差そのものの専用描画のため対象外
    // （断面エンジンに対応概念が無い。buildFaceFigure側の責務のまま）。
    if (face.kind === 'step' || !includeFace(face)) return;
    const ceilProfile = ceilProfileFromSegments(floorSegments, face.run, layout.CH);
    // 帯のz原点は帯自身のFL（=0）。**下へ伸びる帯**（吹抜け帯は下階のFLまで床を下げる）では
    // 区間の床がマイナスへ回るので、探査範囲・床断面の基準をその最下点まで広げる
    // ——0のままだと下階ぶんの壁が一切探査されない（zRange外）。上へ伸びる帯（上部吹抜け）は
    // 天井側のceilProfileが伸びるだけで床は動かないため、この値は0のまま。
    const floorZ = Math.min(0, ...(floorSegments ?? []).map(s => s.floorDeltaMm ?? 0));
    const cut = {
      seqNo: String(i), dirSign: face.dirSign, face,
      viewSign: faceViewSign(face),
      // 仮想断面線は面の壁芯ではなく**室内側へ下がった位置**（section/sectionCutPlane.js）。
      // 壁芯ちょうどに置くと切断面が壁の中を通り、見えがかり候補も所有Roomも取れない。
      line: faceCutLine(face, cutPlaneOffsetMm(face, layers, { columnSolids })),
      layers, baseFloorZ: floorZ,
      zRange: { loZ: floorZ, hiZ: Math.max(...ceilProfile.map(s => s.ceilZ)) },
      // 断面の中（天井の向こう）は描かない。区間ごとの天井断面高さで打ち切る（sectionEngine.js）。
      ceilProfile,
      // `ceilProfile`の**床側の双子**（区間ごとの床断面高さ）。**下階の層への探査窓のgate**
      // （`section/sectionContent.js`の`planeOverhangForFace`）が「その端で帯の床が下階の
      // 空間まで下りているか」を判定する唯一の材料——`baseFloorZ`は全区間の最小値なので
      // 端ごとの違い（吹抜け帯の「下階に壁が無い区間は設置階の床のまま」）を表せない。
      floorZProfile: floorZProfileFromSegments(floorSegments, face.run),
      // 天井断面より上で描画してよい範囲（面ローカルx＝断面ローカルx）。省略＝制限しない。
      // 多層帯（上部吹抜け）だけが渡す（elevationVoid.jsのupperStoreySegments）。
      // **はり出し（faceOverhangOf）ではこの範囲を広げない**——広げる必要が無いため:
      // 唯一の消費点は`sectionEmit.js`の`ceilStepSlabSection`（上階の床の断面線）で、
      // そちらは`cutDrawRange`（＝面の端＋体裁のはり出し）で閉じており、gate下でははり出しが
      // 認められる端＝吹抜けが端まで達している端＝その端に上階の床が無い端だから。
      // 同じ理由で`elevationVoid.js`の`appendUpperStoreyTrim`（上階の天井線・巾木）も広げない。
      aboveCeilVisibleRanges: opts.aboveCeilVisibleRangesOf?.(face),
      // 開放スパン（face.spans の kind==='open'）の遠側の床・天井（帯FL基準のz）。アキ（バツ）の
      // 下端を遠側床へ着け、上端を近側/遠側の天井の低い方で止めるためにエンジンが使う
      // （ユーザー裁定2026-09「高低差」）。判定材料が主cutに無いものは呼び出し側から渡す、という
      // aboveCeilVisibleRangesと同じ形。**値の単一情報源はface.spans**——図側に残る遠側床線と
      // 同じ値から出るので、線とアキの下端が食い違わない。
      openSpans: (face.spans ?? []).filter(sp => sp.kind === 'open').map(sp => ({
        loX: sp.loX, hiX: sp.hiX,
        // **?? 0 で埋めない**——引けない値を「帯の床」と断定するとアキの下端が引き上げられる
        // （エンジン側は非有限なら「クランプしない」へ倒す）。**閾値と埋め方は対で意味を持つ**:
        // 現ルールは`farFloorZ > GAP_EPS`のときだけクランプするため0で埋めても観測上は同じだが、
        // クランプ条件を広げるならfar値の欠損時の扱いをここで再検討すること。
        farFloorZ: sp.farFloorDeltaMm,
        farCeilZ: sp.farCeilAbsMm,
      })),
    };
    const { cut: pcut, columns, content } = buildCutContent(
      cut, probeCtx,
      { endExtendMm, bandRoomBounds, scale: opts.scale, upperPlaneOverhang: opts.upperPlaneOverhang });
    // 図側がcontentの列からしか分からない値（上階FL断面線の起点＝はり出し外端に立つ切断壁の
    // 向こう側の面）を取り出すためのフック。列そのものを渡し、意味づけは呼び出し側の1つの関数
    // （`section/sectionContent.js`の`upperFloorCutWallEndsOf`）に任せる。
    opts.onFaceColumns?.(face, columns);
    const drawnX = faceDrawnXRange(face, endExtendMm, opts.faceOverhangOf?.(face));
    for (const p of clipContentToFace(content, drawnX)) {
      primitives.push(translatePrimitive(p, xCursor, 0));
    }
    // 階段下の部屋: 上を通る階段の断面・見えがかりを重ねる（階段帯とまったく同じ部品）。
    // 梯子（正面視の踏面）は出さない——下から見上げる面には踏面の正面は見えない。
    if (opts.stairOver) {
      const ceilAbs = layout.CH;
      // **階段の作図は面のはり出しに乗せない**（階段は`cutDrawRange`で止める規約。
      // .claude/elevation-model.md「面の端も層ごとに違う」）——はり出しは他の層の平面が
      // 続いている量で、その先に自階の上を通る階段が続いているとは限らない。
      const stairDrawnX = faceDrawnXRange(face, endExtendMm);
      const crossFlight = flightsOverRoom(opts.stairOver, bandRoomBounds)
        .find(f => f.isVertical !== face.isVertical);
      // **面を横切るレーンでは、仮想断面の位置で階段が天井より上なら階段を一切描かない**
      // （ユーザー明示指示2026-09「「13」C: CH2400の天井平場で切断なので、階段梯子は見えない
      // はず」）——梯子（flightLadderPrimitives）はレーンの**全段を絶対高さで**描く規約で、
      // 切断線の位置に依らない。天井より上を落とすクリップ（clipStairUnderCeiling）は
      // プリミティブ単位のz比較なので、踏面が天井より低ければ残ってしまい、実機「13」Cでは
      // 仮想断面の位置の階段（段鼻2938・ささら下端2698）が天井2400の上にあるのに、
      // 踏面（1636〜2318）が見えていた。判定は**仮想断面の位置の段鼻**で行う——天井を止める
      // 基準（「CHの線が階段断面とぶつかるところ」）と同じ「階段断面＝段鼻」基準に揃える。
      const stairHiddenByCeil = crossFlight
        && stairZAtRun(crossFlight, cut.line.axisValue) >= ceilAbs - BAND_GAP_EPS;
      // 梯子（踏面の見えがかり。DETAIL＝細線）は描く（ユーザー明示指示2026-09「「13」A:
      // 階段見えがかりの梯子（細線）を描く」）。
      const raw = stairHiddenByCeil ? [] : stairPrimitivesForCut(opts.stairOver, pcut, columns, {
        includeStringerSightline: stringerSightlineVisible(face, graph, opts.stairOver, bandRoomBounds),
        stringerSightlineLowerOnly: true,
      });
      // 天井が張られている範囲では、その上の階段は天井に隠れる（clipStairUnderCeiling）。
      const { prims: shown, crossXs } = clipStairUnderCeiling(raw, ceilAbs);
      for (const p of clipContentToFace(shown, stairDrawnX)) {
        primitives.push(translatePrimitive(p, xCursor, 0));
      }
      if (crossFlight && !stairHiddenByCeil) {
        // **天井高さは動かさない**（ユーザー明示指示2026-09「「13」A: 仮想断面の位置を確認して
        // 天井高さをプローブ／2400が正解」）——仮想断面の位置でプローブした天井は部屋のCHで、
        // 上を通る階段はその下に現わしで見えるだけ。**端の縦線（仮想断面）も最も高い位置まで**
        // （同指示「天井に高低差が生じ、低い方を見る場合は、最も高い位置まで仮想断面を引く」）。
        // 階段の高さ（踊り場の高さ）は**見えがかりなので細線**（同指示）。
        const z = stairZAtRun(crossFlight, face.axisCL.effectiveValue);
        if (z < ceilAbs - BAND_GAP_EPS) {
          primitives.push(translatePrimitive({
            type: 'line', x1: stairDrawnX.lo, y1: -z, x2: stairDrawnX.hi, y2: -z,
            weight: weightForRole(ElevationLineRole.DETAIL),
          }, xCursor, 0));
        }
      }
      // 面と**平行**なレーン（側面視）では、階段断面が面の端まで届いていれば、その端の縦線は
      // 階段断面と出会ったところで終わる（同指示「「13」B: 左の壁断面：階段断面との取り合いまで」
      // 「「13」D: 右の縦断面は、階段断面と出会ったところが終点」）。
      // **面と平行なレーン（側面視）のときだけ**。面を横切るレーン（正面視。実機「13」A）では
      // 端の縦線＝仮想断面は最も高い位置まで引く（上記）ので、ささらの断面の高さで下げない。
      const alongFlight = flightsOverRoom(opts.stairOver, bandRoomBounds)
        .find(f => f.isVertical === face.isVertical);
      const cutWeightStair = weightForRole(ElevationLineRole.CUT);
      const stairPts = alongFlight
        ? shown.filter(q => q.weight === cutWeightStair)
          .flatMap(q => (q.type === 'polyline' ? q.points : [[q.x1, q.y1], [q.x2, q.y2]]))
        : [];
      for (const localX of [0, face.run]) {
        const ys = stairPts.filter(([px]) => Math.abs(px - localX) < BAND_GAP_EPS).map(([, py]) => py);
        if (ys.length > 0) lowerFaceEndVertical(primitives, xCursor, localX, ceilAbs, Math.max(...ys));
      }
      // 階段断面が天井とぶつかったなら、そこで天井断面線を止める（残すのは階段が無い側）。
      // **階段がどちら側に残るかは重心で決める**——交点の直前・直後の点だけで見ると、段鼻の
      // 出っ張り（数十mm）で向きが反転して判定を誤る。
      if (crossXs.length > 0) {
        const cutWeight = weightForRole(ElevationLineRole.CUT);
        const xs = shown.filter(q => q.weight === cutWeight)
          .flatMap(q => (q.type === 'polyline' ? q.points : [[q.x1, q.y1], [q.x2, q.y2]]))
          .filter(([, py]) => py > -ceilAbs + BAND_GAP_EPS) // 天井より下＝現わしの側
          .map(([px]) => px);
        if (xs.length > 0) {
          const centroid = xs.reduce((a, b) => a + b, 0) / xs.length;
          const stairOnLoSide = centroid < Math.min(...crossXs);
          const boundary = xCursor + (stairOnLoSide ? Math.max(...crossXs) : Math.min(...crossXs));
          trimCeilingLineAt(primitives, xCursor, face, ceilAbs, stairOnLoSide
            ? { lo: boundary, hi: Infinity }
            : { lo: -Infinity, hi: boundary });
        }
      }
    }
  });
}

/**
 * 部屋1件 → 帯（面を横に並べ、部屋名枠・天井高寸法を付ける）。
 * @param {import('@core').Room} room
 * @param {object} graph
 * @param {{project?:object, materialMap?:Map, gridCLs?:object[], gapModelMm?:number,
 *   nameGapModelMm?:number, triangleOffsetModelMm?:number,
 *   faceLabelAvoidThresholdModelMm?:number, openingTagRowModelMm?:number,
 *   dimRowGapModelMm?:number, gridRowGapModelMm?:number, wallLessEndExtendModelMm?:number,
 *   scale?:number, solids?:{upperGraph?:object|null, floorHeightMm?:number|null}|null}} [ctx]
 *   solids（追加仕様2026-08）指定時のみ、各面へ2.5D立体の加算レイヤ（構造柱の柱型・梁型。
 *   elevationSolids.js）を重ねる。未指定なら出力は従来と完全同一（ゴールデンゲートで担保）。
 * @returns {{roomId:string, roomName:string, primitives:object[], bounds:object,
 *   heightMm:number, widthMm:number, faceCount:number, leftAnchorX:number|null,
 *   topMarginMm:number}}
 */
export function buildRoomBand(room, graph, ctx = {}) {
  const faces = composeRoomFaces(room, graph);
  const layout = layoutBandFaces(room, graph, faces, ctx);
  const primitives = [...layout.primitives];
  // 壁の輪郭は**他の3種の帯とまったく同じ共通経路**（appendBandCutContent→buildCutContent）
  // へ任せる。通常の部屋帯の層スタックは自階1層だけ——上階・下階が無いだけで、切断線の位置・
  // 探査延長・見えがかりの距離判定・アキは多層帯と同一の処理を通る。
  appendBandCutContent(primitives, room, graph, layout, [{ graph, floorZMm: 0, role: 'self' }],
    { endExtendMm: ctx.wallLessEndExtendModelMm,
      stairOver: stairContributionOverRoom(room, graph, ctx.solids?.floorHeightMm) });
  return finalizeBand(room, graph, primitives, {
    faceCount: faces.length, chDimX: layout.chDimX, prevBoundaryHi: layout.prevBoundaryHi,
    triOffsetMm: ctx.triangleOffsetModelMm, nameGapModelMm: ctx.nameGapModelMm,
  });
}
