/**
 * 展開図: 階段の歩行順面シーケンス（WP-S2→WP-E5→WP-E5b→WP-E6でエンジン化・タイプ拡張）。
 * 設計意図は .claude/elevation-model.md・.claude/stair-model.md 参照。純モジュール
 * （store.js/snap.js/*.jsx/react-konva/appViewport.jsを静的importしない）。
 *
 * WP-E5/E5b: SWITCHBACK専用の切断定義表・エンジン化については `section/cuts/switchbackCuts.js`
 * のヘッダコメント参照（面の分類・往復間の壁の検出・断面パラメータ解決の委譲先）。
 * WP-E6: タイプ別ディスパッチを追加した——SWITCHBACK→`switchbackCuts`（従来どおり手組みの
 * entries組み立て＋contentForCut）、STRAIGHT/STRAIGHT_LANDING→`straightCuts`（§6.2。
 * face/floorSegments/ceilingProfileの算出もエンジン汎用の`buildSectionFigure`にそのまま
 * 委ねる——直進階段は往路・復路の二重管理が無い単純な1本道のため）、
 * WINDING/L_TURN/FLARED/OPEN_WELL（扇形レーン。`fanCuts.js`）→常にnull。
 * いずれもnullを返す場合は呼び出し側（elevationStair.jsのbuildStairBand）が従来の
 * composeRoomFaces+rotateFacesToStart のフォールバック経路を使う（フォールバック契約自体は
 * WP-E6でも不変。対象タイプが増えただけ）。
 *
 * 返り値の型は一切変えない（{seqNo,face,floorSegments,ceilingProfile?,chDimSplitAbsYs?,
 * content,skipBaseboard,skipWallLabel,floorSpanX?}[]）。
 *
 * SWITCHBACKのシーケンス（歩行順。各cutの切断線・視線方向・第3層データはswitchbackCuts.js
 * §6.1参照）:
 *   1   踊り場前縁（見返り・全幅）: 往路・復路の踏面梯子線を重ねる（踊り場より下の往路は破線）。
 *   2   W_out1（実際の壁面。上り口端〜踊り場前縁まで）: 往路の断面プロファイル＋踊り場区間の
 *       床・天井断面線＋往復間の壁（実在すれば）の断面。
 *   2.5 レーン境界（往路・復路の間の壁が実在する場合のみ）: 往路側からの断面。
 *   3   W_landing（全幅）: 踊り場の壁。階段の重ね描きなし。
 *   4   W_out2（seq2の鏡像構成）: 復路の断面プロファイル＋往復間の壁の断面。
 *   4.5 レーン境界 復路側（同上）。
 *   5   W_out2の残り区間: 復路の断面を反対側（踊り場が右端）から見た図。
 *
 * STRAIGHT/STRAIGHT_LANDINGのシーケンス（§6.2。straightCuts.js参照）:
 *   1 上り口端（全幅） / 2 W_out1（s=0側の断面プロファイル） /
 *   3 到達端（全幅。STRAIGHT_LANDINGは踊り場壁が実在する場合のみ挿入。無ければ3は到達端のまま）/
 *   （STRAIGHT_LANDINGのみ）4 W_out2（s=1側） / 5 到達端（全幅）。
 */
import { StairType } from '@core';
import { switchbackCuts } from './section/cuts/switchbackCuts.js';
import { straightCuts } from './section/cuts/straightCuts.js';
import { UNSUPPORTED_FAN_LANE_TYPES, fanLaneCuts } from './section/cuts/fanCuts.js';
import { makeProbeContext } from './section/sectionProbe.js';
import { buildColumns, buildSectionFigure } from './section/sectionEngine.js';
import { emitColumns, emitOpenGapMarks } from './section/sectionEmit.js';
import { stairPrimitivesForCut } from './section/sectionStair.js';
import { structuralContribution, structuralPrimitivesForCut } from './section/sectionStructure.js';
import { GAP_EPS_MM as GAP_EPS } from './elevationStyle.js';

function flatFloorSegments(run, floorDeltaMm, chMm) {
  return [{ loX: 0, hiX: run, floorDeltaMm, chMm }];
}

// 往路（entry→landing）の勾配天井プロファイル。upperCeilCappedなら往路上はceilLowAbsで水平のまま
// （リード裁定の解釈で、最上階キャップ時の踊り場側との段差の縦線は本WPでは描画しない。
// .claude/elevation-model.mdの階段帯節・完了条件の「逸脱＋理由」参照）。
function outboundCeilingProfile(run, ceilLowAbs, ceilTopAbs, upperCeilCapped) {
  return upperCeilCapped
    ? [[0, ceilLowAbs], [run, ceilLowAbs]]
    : [[0, ceilLowAbs], [run, ceilTopAbs]];
}

// cut(SectionCut) → content（WP-E5b: §4「内部フロー」のcontent生成部分のみをここで組み立てる。
// face/floorSegments/ceilingProfileはswitchbackCuts供給の現行方式のまま——本関数はcontentだけを
// 返す。cutがnull（例: seq3。§6.1表「階段寄与: なし」）はstairPrimitivesForCutにnullを渡す
// （contribution=null契約で空配列を返す）。
// QA実機フィードバック修正: 階段の断面ジグザグ(stairPrimitivesForCutが返すpolyline)が占める
// x範囲では、その向こうに見える壁の輪郭線（emitColumnsが一般規則で描く見えがかり壁の
// z=0=設置階FL位置の縁）は、実際には階段自体（段板・ささら）に隠れて見えないはず
// （「設置階FLは階段断面に出会ったらそこが終点」の一般化）。一般規則のレイキャスト
// （probeColumn/emitColumns）は階段自体の占有形状を知らず、壁の見えがかりだけで塞ぎ判定する
// ため、この重なりだけは切断定義の出力側で後処理として取り除く。
function clipWallFloorEdgeUnderZigzag(wallContent, stairContent) {
  const zigzagXRanges = stairContent
    .filter(p => p.type === 'polyline')
    .map(p => ({
      lo: Math.min(...p.points.map(pt => pt[0])),
      hi: Math.max(...p.points.map(pt => pt[0])),
    }));
  if (zigzagXRanges.length === 0) return wallContent;
  return wallContent.filter(p => {
    if (p.type !== 'line' || p.y1 !== p.y2 || p.y1 !== 0) return true; // 設置階FL(z=0)の水平線のみ対象
    const xLo = Math.min(p.x1, p.x2), xHi = Math.max(p.x1, p.x2);
    return !zigzagXRanges.some(r => xLo < r.hi - GAP_EPS && xHi > r.lo + GAP_EPS);
  });
}

function contentForCut(cut, probeCtx) {
  if (!cut) return [];
  const columns = buildColumns(cut, probeCtx);
  const emitCtx = { ceilZ: cut.zRange?.hiZ };
  const wallContent = [...emitColumns(columns, cut, emitCtx), ...emitOpenGapMarks(columns, cut, emitCtx)];
  const stairContent = stairPrimitivesForCut(cut.stairCut ?? null, cut, columns);
  // WP-C: 構造梁（踊り場受け梁等）の加算寄与。stairContentと独立の別レイヤのため、
  // clipWallFloorEdgeUnderZigzag（階段ジグザグの向こうの壁縁除去）の対象には含めない。
  const structuralContent = structuralPrimitivesForCut(structuralContribution(cut.layers), cut, columns);
  return [...clipWallFloorEdgeUnderZigzag(wallContent, stairContent), ...stairContent, ...structuralContent];
}

/**
 * STRAIGHT/STRAIGHT_LANDING（§6.2・WP-E6）の歩行順面シーケンス。straightCutsが返す各cutを
 * そのままbuildSectionFigure（sectionEngine.js。face/floorSegments/ceilingProfileの算出も
 * エンジン汎用の経路に委ねる。straightCuts.jsヘッダコメント参照）へ渡すだけ——SWITCHBACKの
 * ような手組みのfloorSegments/ceilingProfile算出（往路・復路二重管理の特殊事情）が無いため。
 * straightCutsがnullを返す条件（対象外タイプ・cells空・floorHeight未確定・面分類不能）は
 * そのままstairFaceSequenceのnull契約へ延長する。
 * @returns {ReturnType<typeof stairFaceSequence>}
 */
function buildStraightFaceSequence(stair, faces, graph, opts) {
  const table = straightCuts(stair, faces, graph, opts);
  if (!table) return null;
  const probeCtx = makeProbeContext(table.cuts[0].layers);
  return table.cuts.map(cut =>
    buildSectionFigure(cut, probeCtx, { wallFaces: faces, ceilZ: cut.zRange?.hiZ }));
}

/**
 * 階段の歩行順面シーケンスを組み立てる（WP-E6: タイプ別ディスパッチ。ファイル冒頭コメント参照）。
 * @param {import('@core').Stair} stair
 * @param {object[]} faces - composeRoomFaces(stairRoom, graph) の結果
 * @param {object} graph - 設置階のgraph
 * @param {{floorHeight:number, chUpperAbsMm:number, chLowerMm:number, upperCeilCapped?:boolean}} opts
 *   chUpperAbsMm … 上階天井の絶対高さ（floorHeight+CH_upper。呼び出し側で計算済みの値をそのまま使う）。
 *   chLowerMm … 設置階の天井高さ（CH。絶対高さそのもの＝設置階FL=0基準）。
 * @returns {Array<{seqNo:string, face:object, floorSegments:object[], ceilingProfile?:Array<[number,number]>,
 *   content:object[], skipBaseboard:true, skipWallLabel:true, floorSpanX?:object}>|null}
 */
export function stairFaceSequence(stair, faces, graph, opts = {}) {
  if (stair && (stair.type === StairType.STRAIGHT || stair.type === StairType.STRAIGHT_LANDING)) {
    return buildStraightFaceSequence(stair, faces, graph, opts);
  }
  if (stair && UNSUPPORTED_FAN_LANE_TYPES.includes(stair.type)) {
    return fanLaneCuts(stair); // 常にnull（扇形レーン未対応。fanCuts.js参照）
  }

  const cutTable = switchbackCuts(stair, faces, graph, opts);
  if (!cutTable) return null; // フォールバック契約: switchbackCutsのnull条件をそのまま延長する

  const {
    cuts, wEntry, wLanding, wOut1, wOut2, landingAbs,
    ceilTopAbs, ceilLowAbs, upperCeilCapped,
  } = cutTable;
  const { landingLen } = cutTable.params;
  const floorHeight = opts.floorHeight;
  const hasCut = seqNo => cuts.some(c => c.seqNo === seqNo);
  const cutOf = seqNo => cuts.find(c => c.seqNo === seqNo);

  // WP-E5b: content生成はエンジン経由（makeProbeContext→cutごとにcontentForCut）。
  // 全cutが同一のlayers参照を共有する（switchbackCuts.js参照）ため、probeCtxは1回だけ作る。
  const probeCtx = makeProbeContext(cuts[0].layers);

  const entries = [];

  // ---- 1: 踊り場前縁（見返り・全幅） ----
  entries.push({
    seqNo: '1', face: wEntry,
    floorSegments: flatFloorSegments(wEntry.run, landingAbs, ceilTopAbs - landingAbs),
    chDimSplitAbsYs: [floorHeight],
    content: contentForCut(cutOf('1'), probeCtx), skipBaseboard: true, skipWallLabel: true,
  });

  // ---- 2: W_out1（実際の壁面。クリップ廃止） ----
  const outFace2 = wOut1;
  {
    const laneLenOnFace = Math.max(0, outFace2.run - landingLen);
    entries.push({
      seqNo: '2', face: outFace2,
      floorSegments: laneLenOnFace > 0
        ? [
            // QA実機フィードバック修正: レーン区間(floorDeltaMm:0)の床線(z=0)は、段鼻の断面
            // ジグザグ(stairCutのcontent)が既にその区間の輪郭を表しているため、床の水平線が
            // ジグザグの下を素通りして踊り場側の隅まで貫通してしまう（「階段設置階FLは階段断面
            // に出会ったらそこが終点」）——hideFlatLine:trueでこの区間だけ床線を描かない
            // （elevationFigure.jsのbuildFaceFigure参照。段差縦線・注記等の他の処理は不変）。
            { loX: 0, hiX: laneLenOnFace, floorDeltaMm: 0, chMm: ceilLowAbs, hideFlatLine: true },
            { loX: laneLenOnFace, hiX: outFace2.run, floorDeltaMm: landingAbs, chMm: ceilTopAbs - landingAbs },
          ]
        : [{ loX: 0, hiX: outFace2.run, floorDeltaMm: landingAbs, chMm: ceilTopAbs - landingAbs }],
      ceilingProfile: upperCeilCapped
        ? [[0, ceilLowAbs], [outFace2.run, ceilLowAbs]]
        : laneLenOnFace > 0
          ? [[0, ceilLowAbs], [laneLenOnFace, ceilTopAbs], [outFace2.run, ceilTopAbs]]
          : [[0, ceilTopAbs], [outFace2.run, ceilTopAbs]],
      content: contentForCut(cutOf('2'), probeCtx), skipBaseboard: true, skipWallLabel: true,
    });
  }

  // ---- 2.5: レーン境界 往路側（midWallがあれば） ----
  if (hasCut('2.5')) {
    const midOutFace = cutOf('2.5').face;
    entries.push({
      seqNo: '2.5', face: midOutFace,
      floorSegments: flatFloorSegments(midOutFace.run, 0, ceilLowAbs),
      ceilingProfile: outboundCeilingProfile(midOutFace.run, ceilLowAbs, ceilTopAbs, upperCeilCapped),
      content: contentForCut(cutOf('2.5'), probeCtx), skipBaseboard: true, skipWallLabel: true,
    });
  }

  // ---- 3: W_landing（全幅。階段の重ね描きなし） ----
  entries.push({
    seqNo: '3', face: wLanding,
    floorSegments: flatFloorSegments(wLanding.run, landingAbs, ceilTopAbs - landingAbs),
    content: contentForCut(cutOf('3'), probeCtx), skipBaseboard: true, skipWallLabel: true,
  });

  // ---- 4: W_out2（seq2の鏡像構成） ----
  const outFace4 = wOut2;
  {
    const laneLenOnFace4 = Math.max(0, outFace4.run - landingLen);
    const landingHi4 = outFace4.run - laneLenOnFace4;
    entries.push({
      seqNo: '4', face: outFace4,
      floorSegments: landingHi4 < outFace4.run
        ? [
            { loX: 0, hiX: landingHi4, floorDeltaMm: landingAbs, chMm: ceilTopAbs - landingAbs },
            // QA実機フィードバック修正: seq2と同じ理由でレーン区間の床線を描かない（seq4は
            // 踊り場が左・レーンが右の鏡像構成のため、こちらは第2区間がレーンにあたる）。
            { loX: landingHi4, hiX: outFace4.run, floorDeltaMm: 0, chMm: ceilLowAbs, hideFlatLine: true },
          ]
        : [{ loX: 0, hiX: outFace4.run, floorDeltaMm: landingAbs, chMm: ceilTopAbs - landingAbs }],
      ceilingProfile: upperCeilCapped
        ? [[0, ceilLowAbs], [outFace4.run, ceilLowAbs]]
        : landingHi4 < outFace4.run
          ? [[0, ceilTopAbs], [landingHi4, ceilTopAbs], [outFace4.run, ceilLowAbs]]
          : [[0, ceilTopAbs], [outFace4.run, ceilTopAbs]],
      content: contentForCut(cutOf('4'), probeCtx), skipBaseboard: true, skipWallLabel: true,
    });
  }

  // ---- 4.5: レーン境界 復路側（あれば。踊り場が左端） ----
  if (hasCut('4.5')) {
    const midRetFace = cutOf('4.5').face;
    entries.push({
      seqNo: '4.5', face: midRetFace,
      floorSegments: flatFloorSegments(midRetFace.run, landingAbs, ceilTopAbs - landingAbs),
      content: contentForCut(cutOf('4.5'), probeCtx), skipBaseboard: true, skipWallLabel: true,
    });
  }

  // ---- 5: 復路断面を反対側から見た図（踊り場が右端） ----
  {
    const outFace5 = cutOf('5').face;
    entries.push({
      seqNo: '5', face: outFace5,
      floorSegments: flatFloorSegments(outFace5.run, landingAbs, ceilTopAbs - landingAbs),
      content: contentForCut(cutOf('5'), probeCtx), skipBaseboard: true, skipWallLabel: true,
    });
  }

  return entries;
}
