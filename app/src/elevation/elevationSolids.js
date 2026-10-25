/**
 * 展開図: 通常の壁面（buildFaceFigure）への「2.5D立体の加算レイヤ」。
 * 設計意図は .claude/elevation-model.md「2.5D立体の加算レイヤ（全展開図共通）」節参照。
 *
 * 追加仕様2026-08「2.5D仕様の展開ロジックを吹抜け・階段だけでなく、全ての展開図に適用」への
 * 回答実装。**面の描画パイプライン自体（buildFaceFigure）を断面エンジン（section/sectionEngine.js）へ
 * 置き換えるのではなく**、階段帯で既に確立している「純粋な加算レイヤ」（sectionStructure.js。
 * 遮蔽判定に参加しない・レイキャストを持たない）のパターンを通常面へ広げる方式を採る——
 * buildFaceFigureは段差プロファイル・開放スパン・注記帯・巾木・建具姿図・壁2段書き等の
 * 大量の確定仕様を抱えており、ゴールデンゲート（elevationSectionGolden.test.js）で固定されている。
 * 「柱・梁型・作り付け家具の断面を描く」という目的は加算レイヤだけで満たせるため、置き換えの
 * リスクを負う理由が無い（作り付け家具はドメインモデル自体が未実装のため対象外・defer）。
 *
 * 純モジュール（node:testから単体import可能。store.js/snap.js/*.jsx/react-konva/appViewport.jsを
 * 静的importしない）。
 */
import { GAP_EPS_MM as GAP_EPS } from './elevationStyle.js';
import {
  structuralContribution, structuralPrimitivesForCut, visibleBeamPieces,
  structuralColumnContribution, structuralColumnPrimitivesForCut,
} from './section/sectionStructure.js';
import { buildBandLayers } from './section/sectionBandLayers.js';
import { cutPlaneOffsetMm, faceCutLine, faceViewSign } from './section/sectionCutPlane.js';
import { makeSectionCut } from './section/sectionTypes.js';
import { roomBounds } from '../finish/gridCells.js';
import { stairSoffitFinished } from '../ceiling/stairSoffit.js';
import { stairFootSurfaces } from '../ceiling/stairFootWallTop.js';

/**
 * 梁・柱（部材）の層: 自階（floorZMm=0）と、判っていれば上階（floorZMm=floorHeightMm）。梁は「その梁が実際に立つ階のgraph」に
 * 帰属する（sectionStructure.jsヘッダ）ので、1階の天井に現れる梁型は上階 graph の梁。加算レイヤ（faceSectionCut）と、部屋帯の
 * 断面エンジンの探査の候補収集（`cut.memberLayers`。U1b B3-1）が同じ層を使う唯一の式。
 * `solids.memberLayers` があればそれをそのまま使う（呼び出し側が 1 回の組み立ての間、全部屋・全面で同じ配列を共有する。
 * 探査の候補収集は層の配列の同一性で梁・柱の立体を覚える〔sectionHits.js memberSolidsMemo〕ので、部屋ごとに配列を作ると
 * 同じ立体・壁の合併帯を部屋の数だけ作り直す＝ElevationModeState が共有する）。
 * @param {object} graph
 * @param {{upperGraph?:object|null, floorHeightMm?:number|null, memberLayers?:object[]}} [solids]
 */
export function memberLayersOf(graph, solids) {
  if (solids?.memberLayers) return solids.memberLayers;
  return buildBandLayers(graph, solids?.upperGraph
    ? { above: [{ graph: solids.upperGraph, floorHeightMm: solids.floorHeightMm }] } : {});
}

/**
 * 自階の階段のうち、裏面が仕上げ（stairSoffitFinished＝木造または soffitFinish 'finished'）のものの裏面の面
 * （階段下の部屋の帯の天井を頭打ちにする供給源。階ごとに 1 回作って solids.underStairSoffits で全部屋の帯が共有する）。
 * 面は stairFootSurfaces（壁の天端と同じ式）。高さの基準は階段室の床（実効 FL−datum。datum 基準の絶対 z）。階高が決まらない・屋外階段・裏面が組めない型は載せない＝従来の描き方。
 * 「あらわし」の階段は載せない（その下は stairOver の機構・天井 CH のまま）。
 * @param {object} graph 自階
 * @param {{upperGraph?:object|null, floorHeightMm?:number|null}} [solids]
 * @returns {Array<{stairId:string, stairRoomId:string|null, surface:object}>}
 */
export function underStairSoffitsOf(graph, solids) {
  const floorHeightMm = solids?.floorHeightMm;
  if (!Number.isFinite(floorHeightMm) || floorHeightMm <= 0) return [];
  const out = [];
  for (const stair of graph?.stairs ?? []) {
    if (!stairSoffitFinished(stair)) continue;
    const [surface] = stairFootSurfaces(graph, {
      floorHeightOf: s => (s === stair ? floorHeightMm : null),
      // 裏面の基準は階段室の床（実効 FL−階の datum。sectionProbe addUnderReturnTops・spaceModel floorZFor と同じ約束）。
      // 区間の ch は帯の部屋の床（bandFloorOffsetMm＋床段差）との差で出す
      floorZOf: s => graph.effectiveFloorLevel(graph.roomMap?.get(s.roomId) ?? null) - graph.floorDatum,
      aboveGraph: solids.upperGraph ?? null,
    });
    if (surface) out.push({ stairId: String(stair.id), stairRoomId: stair.roomId ?? null, surface });
  }
  return out;
}

/**
 * face（buildRoomFacesの1件）→ 断面エンジンの SectionCut 相当のアダプタ。
 * CutLineは「(isVertical, axisCL.value, lo, hi)」がfaceと同型（sectionTypes.js）のためそのまま
 * 移せる。cutOriginWorld(cut)=dirSign>0?line.lo:line.hi は face.originWorld の定義と一致するため、
 * localXOf(cut,...) と localXOf(face,...) は同じ値を返す（＝面のローカル座標のまま合成できる）。
 *
 * 高さの基準は帯そのもの: baseFloorZ=0（帯FL）・zRange=0..CH。
 * layersは自階（floorZMm=0）と、判っていれば上階（floorZMm=floorHeightMm）——梁は「その梁が
 * 実際に立つ階のgraph」に帰属する（sectionStructure.jsヘッダ）ため、1階の天井に現れる梁型は
 * 2階伏図＝上階graphの梁である。
 * @param {object} face
 * @param {{graph:object, ceilingHeight:number, upperGraph?:object|null,
 *   floorHeightMm?:number|null}} opts
 * @returns {import('./section/sectionTypes.js').SectionCut|null}
 *   面の軸位置（axisCL.effectiveValue）・dirSign・lo/hiのいずれかが数値でなければnull
 *   （合成face・単体テストのフェイクface。呼び出し側は何も描かない）。
 */
export function faceSectionCut(face, opts) {
  const axisValue = face?.axisCL?.effectiveValue;
  if (!Number.isFinite(axisValue)) return null;
  if (!Number.isFinite(face.lo) || !Number.isFinite(face.hi)) return null;
  if (face.dirSign !== 1 && face.dirSign !== -1) return null;
  const CH = opts.ceilingHeight;
  if (!Number.isFinite(CH) || CH <= 0) return null;

  const layers = memberLayersOf(opts.graph, opts);
  return makeSectionCut({
    seqNo: 'face',
    line: { isVertical: face.isVertical, axisValue, lo: face.lo, hi: face.hi },
    // **ここのviewSignは「室内側＝視線の手前側を正に採る」**＝`sectionCutPlane.js`の`faceViewSign`（壁を見る向き）の符号反転。
    // 柱型の入口判定（`structuralColumnPrimitivesForCut`の`onNearSide`＝柱が面のどちら側に出っ張るか）がこの向きの符号を読む
    // （その関数の規約。fake cut の単体テストも同じ規約）。向きの定義は`faceViewSign`の 1 箇所に寄せ、ここは反転だけ（B6）。
    // 符号は elevationSolids.test.js の符号固定テストで留める。
    viewSign: -faceViewSign(face),
    dirSign: face.dirSign,
    layers,
    zRange: { loZ: 0, hiZ: CH },
    baseFloorZ: 0,
  });
}

/**
 * BeamSolid[] を帯の描画z範囲（0..CH）へクリップする。範囲外へ完全に外れる梁は落とす。
 *
 * これが「梁型（下がり天井の梁）だけが出る」という建築的に正しい挙動をそのまま与える——
 * 自階graphの床梁（天端がFL以下。在来木造は levelOffset=−100＝FL−100、他は 0）は帯の床より下で全消し、
 * 上階graphの梁は天端=階高＋levelOffset のため、梁成が階高−CH（在来木造は −100 して）を超えて天井から
 * 降りてくる分だけが残る。副次的に、
 * 床より下の細破線が注記帯（tag行・ROW1/ROW2・通り芯丸）へ被る問題も原理的に起きない。
 * @param {object[]} beams - structuralContribution の結果
 * @param {number} loZ
 * @param {number} hiZ
 * @returns {object[]}
 */
function clipBeamsToBand(beams, loZ, hiZ) {
  const out = [];
  for (const b of beams) {
    const top = Math.min(b.topZ, hiZ);
    const bot = Math.max(b.topZ - b.depthMm, loZ);
    if (top - bot <= GAP_EPS) continue;
    out.push({ ...b, topZ: top, depthMm: top - bot });
  }
  return out;
}

/**
 * 面のローカルx範囲 [0, run] へ線プリミティブをクランプする（軸並行の矩形辺しか来ない前提。
 * 斜め線は本レイヤでは生成されない）。範囲外の縦線・退化した水平線は落とす。
 * 構造材は壁中心線（CL）間の実スパンで存在するため、クランプしないと隣の面の領域まで
 * はみ出して描かれる（面間ギャップは寸法線類の実寸で決めており、この加算レイヤ分は
 * 見込んでいない）。
 * @param {object[]} prims
 * @param {number} run
 * @returns {object[]}
 */
function clampPrimsToRun(prims, run) {
  // -0 を 0 へ正規化する（sectionEmit.jsのzToYはz=0に対し-0を返す。buildFaceFigureの既存
  // プリミティブは -0 を作らない規約（elevationFigure.jsのfloorYOf参照）のため、帯へ合流する
  // ここで揃えておく——等値比較・テストの落とし穴を新経路に持ち込まない）。
  const z = v => (v === 0 ? 0 : v);
  const out = [];
  for (const p of prims) {
    const x1 = Math.min(Math.max(p.x1, 0), run);
    const x2 = Math.min(Math.max(p.x2, 0), run);
    // 縦線: クランプで位置が動く＝元々範囲外だったため描かない（幅を偽らない）。
    if (Math.abs(p.x1 - p.x2) < GAP_EPS) {
      if (Math.abs(x1 - p.x1) > GAP_EPS) continue;
      out.push({ ...p, x1: z(p.x1), y1: z(p.y1), x2: z(p.x2), y2: z(p.y2) });
      continue;
    }
    if (Math.abs(x2 - x1) <= GAP_EPS) continue; // 完全に範囲外の水平線
    out.push({ ...p, x1: z(x1), y1: z(p.y1), x2: z(x2), y2: z(p.y2) });
  }
  return out;
}

/**
 * 梁の断面・along・見え掛かり（空中・面の通り）のうち、**帯（memberCut・memberFace）が持たない部材**（`droppedKeys`＝列の端を捨てた・z 範囲に
 * 掛からない部材のキー）だけを加算レイヤの規則で描く。柱も同じ（帯が持たない柱だけ入口条件〔面の壁に接続 or 切断線をまたぐ〕で描く。U1b B3-3）。
 * 梁の見え掛かりは柱の包み込み外形に隠れる区間を描かない（同じ柱を渡す）。基礎・基礎梁・杭は描かない（sectionStructure.js 側で除外）。
 * 遮蔽判定には参加しない純粋な加算（sectionStructure.js の方針）。呼び出しは `droppedMemberKeysOf(pcut, { inZRange: true })`（列の分割の後）。
 * @param {object} face
 * @param {{graph:object, ceilingHeight:number, upperGraph?:object|null, floorHeightMm?:number|null,
 *   columnTopZAt?:(face:object, runWorld:number)=>number}} opts
 * @param {Set<string>} droppedKeys
 * @returns {object[]}
 */
export function droppedMemberPrimitivesForFace(face, opts, droppedKeys) {
  if (!droppedKeys || droppedKeys.size === 0) return [];
  const parts = faceParts(face, opts);
  if (!parts) return [];
  const { cut, beams, columnSolids, beamCut } = parts;
  return clampPrimsToRun([
    ...structuralPrimitivesForCut(beams, beamCut, undefined, null,
      { columnSolids, fromRoomSide: true, memberCuts: { dropped: droppedKeys } }),
    // columnTopZAt（階段下の部屋の帯だけが渡す。buildRoomBand）… 柱の縁の縦線を天井線（階段の裏面）で止める。無ければ帯の上端まで（従来どおり）
    ...structuralColumnPrimitivesForCut(columnSolids, cut, {
      dropped: droppedKeys, topZAt: opts.columnTopZAt ? run => opts.columnTopZAt(face, run) : undefined }),
  ], face.run);
}

// 面ごとの切断・梁・柱・梁の判定用の切断（faceBeamCut）は、beamBlockerRectsForFace・droppedMemberPrimitivesForFace の
// 2 箇所が同じ面に同じ入力で作る——面の配列の同一性と入力（graph・上階・階高・CH・層・部屋）が同じなら作り直さない。
// 前提: 面は `composeRoomFaces` が組み立てごとに作り直す（面オブジェクトの同一性＝その組み立て）。面をキャッシュして使い回す変更を
// 入れると、graph が変わっても同じ面で古い値を返す（入力の同一性しか見ていない）ので、その場合はこのメモを見直すこと。
const facePartsMemo = new WeakMap();
function faceParts(face, opts) {
  const key = { graph: opts.graph, upperGraph: opts.upperGraph ?? null, floorHeightMm: opts.floorHeightMm ?? null,
    ceilingHeight: opts.ceilingHeight, memberLayers: opts.memberLayers ?? null, room: opts.room ?? null };
  const hit = face && typeof face === 'object' ? facePartsMemo.get(face) : null;
  if (hit && Object.keys(key).every(k => hit.key[k] === key[k])) return hit.parts;
  const cut = faceSectionCut(face, opts);
  let parts = null;
  if (cut) {
    const { beams, columnSolids } = faceBeamsAndColumns(cut);
    parts = { cut, beams, columnSolids, beamCut: faceBeamCut(face, cut, columnSolids, opts) };
  }
  if (face && typeof face === 'object') facePartsMemo.set(face, { key, parts });
  return parts;
}

function faceBeamsAndColumns(cut) {
  const { loZ, hiZ } = cut.zRange;
  return {
    beams: clipBeamsToBand(structuralContribution(cut.layers), loZ, hiZ),
    columnSolids: structuralColumnContribution(cut.layers),
  };
}

/**
 * 面に加算される梁のうち**帯が持たない部材（droppedKeys）**（`droppedMemberPrimitivesForFace` と同じ可視区間 `visibleBeamPieces`）の矩形（面ローカルx×絶対z）。
 * アキのバツが梁で分かれるように、部屋帯がアキの手前を塞ぐものとして渡す（section/sectionEmit.js の emitOpenGapMarks の `gapBeamRects`）。
 * droppedKeys が無い・空なら空配列（帯の部材は帯が担う）。
 * split … 面の平面上（parallel）・空中（airborne）の梁＝アキのセルから抜く／false（断面）＝バツの線を切り抜くだけ。
 * 判定は新しく行わず、可視区間を読むだけ。解決できない面・梁が無い面は空配列。
 * @returns {Array<{xLo:number, xHi:number, zLo:number, zHi:number, split:boolean}>}
 */
export function beamBlockerRectsForFace(face, opts, droppedKeys = null) {
  // 帯が持つ梁（断面・along は memberCut の obstructionRects、空中・面の通りは memberFace の gapPass）は帯が担う（U1b B4）。
  // ここは帯が持たない部材（droppedKeys。加算で描くもの）の矩形だけ
  if (!droppedKeys || droppedKeys.size === 0) return [];
  const parts = faceParts(face, opts);
  if (!parts) return [];
  const { beams, columnSolids, beamCut } = parts;
  if (beams.length === 0) return [];
  const rects = [];
  for (const p of visibleBeamPieces(beams, beamCut, undefined, null,
    { columnSolids, fromRoomSide: true, memberCuts: { dropped: droppedKeys } })) {
    const xLo = Math.max(p.xLo, 0), xHi = Math.min(p.xHi, face.run);
    if (xHi - xLo <= GAP_EPS) continue;
    rects.push({ xLo, xHi, zLo: p.zLo, zHi: p.zHi, split: p.kind !== 'section' });
  }
  return rects;
}

/**
 * 梁の判定に使う切断＝階段帯と同じ**室内側へ下がった仮想断面（pcut）**と壁を見る向き（`faceViewSign`）。
 * 面の壁芯上の切断（`faceSectionCut`）で解くと、柱の手前で止まる梁は切断位置が梁のスパンの外になって断面が出ない
 * （plan-solids-test 2階 子ども1 の C: 梁 829d5ee8）。面の平面上の梁は `cut.face` の軸で parallel と判定される
 * （sectionStructure.js の faceAxisInBeam。B1 の梁は細線のまま）。柱型は壁との接続（onFaceWall）の照合が壁芯基準なので従来の `cut` のまま。
 * 帯の部屋の広がり（bandRoomBounds）は帯の切断（elevationBand.js）と同じ値——部屋の外の空中の梁を描かない。
 * @returns {import('./section/sectionTypes.js').SectionCut}
 */
function faceBeamCut(face, cut, columnSolids, opts) {
  return makeSectionCut({
    ...cut,
    face,
    line: faceCutLine(face, cutPlaneOffsetMm(face, cut.layers, { columnSolids })),
    viewSign: faceViewSign(face),
    bandRoomBounds: opts.room?.cells ? roomBounds(opts.room.cells, opts.graph) : null,
  });
}
