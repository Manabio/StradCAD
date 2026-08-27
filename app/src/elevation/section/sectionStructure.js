/**
 * 2.5D断面エンジン: 構造梁の展開図への加算寄与（WP-C。第3層＝階段幾何（sectionStair.js）と並ぶ
 * 別の寄与源。architect承認済み実装指示書§5参照）。設計意図は.claude/elevation-model.md
 * 「階をまたぐ2層帯」節参照。純モジュール（node:testから単体import可能。store.js/snap.js/
 * *.jsx/react-konva/appViewport.jsを静的importしない）。
 *
 * 遮蔽はしない（純粋な加算レイヤ。他の壁・アキとの重なり判定は取らない——構造梁はレイキャスト
 * （sectionProbe.js）の塞ぎ判定には一切参加しない。将来的な遮蔽対応はdefer）。
 *
 * 各層（cut.layers。自階=floorZMm:0・上階=floorZMm:floorHeight）のgraph.beamsをそのまま拾う——
 * 構造梁は「その梁が実際に立つ階のgraph」に帰属するため（structural-model.md「柱は自階の柱を
 * 自階graphに持つ」と同じ規律を梁にも適用）、伏図と同じ帰属をそのまま展開図の高さ方向へ投影する
 * だけで正しい階の梁が正しい高さに出る。role（primary/secondary/landing等）でのフィルタは
 * **基礎梁(role:'foundation')の除外1件のみ**——踊り場受け梁(landing)専用ではなく、その切断が
 * 拾う全構造梁が対象、という原則は変えない（追加仕様2026-08「2.5D展開では、基礎、基礎梁の
 * 描画は不要」）。1平面に基礎伏図＋1階伏図の2スロットが乗る（App.jsx）ため、1階のgraph.beamsには
 * 基礎梁と1階の梁が同居する——除外しないと室内展開図の床下に基礎梁が細破線で出る。
 * 基礎・柱脚（footingMap）・べた基礎（slab role:'mat_foundation'）は元々本モジュールの
 * 対象外（graph.beams/graph.columnsしか読まない）ため、追加の除外は要らない。
 */
import { findSectionEntry } from '../../structural/sectionCatalog.js';
import { ElevationLineRole, GAP_EPS_MM as GAP_EPS } from '../elevationStyle.js';
import { localXOf, cutDrawRange } from './sectionTypes.js';
import { halfWallThicknessMm } from '../elevationFloorProfile.js';
import { emitLine } from './sectionEmit.js';

// 断面成(depthMm)のフォールバック既定値（sectionDefIdがカタログに無く・beamDepthも未設定の
// 場合の保険。木造既定断面WOOD-105x105と同値）。
const DEFAULT_DEPTH_MM = 105;

// 基礎（梁=基礎梁・地中梁 / 柱=杭）を表すrole。展開図では一律に描かない（追加仕様2026-08）。
const FOUNDATION_ROLE = 'foundation';

/**
 * @typedef {{isVertical:boolean, axisWorld:number, spanLo:number, spanHi:number,
 *   widthMm:number, topZ:number, depthMm:number, role:string}} BeamSolid
 */

/**
 * @typedef {{xLo:number, xHi:number, yLo:number, yHi:number, baseZ:number}} ColumnSolid
 *   平面の占有矩形（軸並行）＋足元の絶対z。柱は「その階の床から天井まで立つ」ものとして扱い、
 *   上端zは持たない（下記 structuralColumnPrimitivesForCut の設計判断を参照）。
 */

/**
 * 梁の平面占有帯が、いずれかの壁の材厚（`Wall.materialRange`）の中に完全に収まり、かつ
 * その壁のスパンが梁のスパンを覆っているか（＝壁に隠れて見えない梁か）。
 *
 * 壁厚を`materialRange`から求める規約は`switchbackCuts.js`の往復間の壁検出と同じ
 * （壁厚をハードコードしない）。厚み方向は**完全に収まる**ことを要求する——壁より太い梁は
 * 一部が室内へ現れるため隠さない。
 *
 * スパン方向は「壁厚ぶんの食い違い」を許容する（完全被覆を要求しない）——梁はCLからCLまで
 * 張るのに対し、壁は隅で隣接壁と取り合うため`chamferWalls`がstart/endOffsetを半壁厚ほど
 * 詰める。完全被覆を要求すると、実データでは壁に埋まった梁でも常に「はみ出している」と
 * 判定され、この規則が一度も発動しない（実際にそう作り込んで検出した）。許容量を壁厚
 * そのものにしているのは、隅の詰めが隣接壁の半厚程度に収まるため——それを大きく超えて
 * 伸びる梁（隣のスパンまで通る梁）は端が見えるので隠さない。
 * @param {object} beam - graph.beams の1件
 * @param {object[]} walls
 * @returns {boolean}
 */
function isInsideWall(beam, walls) {
  const halfW = (beam.sectionWidth ?? 0) / 2;
  const bLo = beam.axisValue - halfW, bHi = beam.axisValue + halfW;
  const bSpanLo = Math.min(beam.coord1, beam.coord2), bSpanHi = Math.max(beam.coord1, beam.coord2);
  for (const wall of walls) {
    if (wall.isVertical !== beam.isVertical) continue; // 同じ向きの壁だけが梁を丸ごと隠せる
    const mr = wall.materialRange;
    if (!mr) continue;
    if (!(bLo >= mr.lo - GAP_EPS && bHi <= mr.hi + GAP_EPS)) continue;
    const tol = Math.abs(mr.hi - mr.lo); // 隅の取り合い（chamferWalls）ぶんの許容
    const wLo = Math.min(wall.coord1, wall.coord2), wHi = Math.max(wall.coord1, wall.coord2);
    if (bSpanLo >= wLo - tol - GAP_EPS && bSpanHi <= wHi + tol + GAP_EPS) return true;
  }
  return false;
}

/**
 * 梁の**切断位置での断面**が壁の中に納まっているか（＝そこでは壁に隠れて見えないか）。
 * `isInsideWall`（梁の全スパンを1枚の壁が覆うことを要求）との違いが要点——実機の2階床梁は
 * span=-7625..-3290のように建物を貫いて走るため、どの壁セグメントでも全スパンを覆えず
 * あの規則が一度も発動しない。断面は**切断線と交わる一点**で描かれるのだから、判定も
 * その位置（`atCoord`＝梁の長さ方向の座標＝`cut.line.axisValue`）で行う
 * （ユーザー実機指摘2026-08「6」「Y2の壁際、2FL床高付近に謎の構造材断面」の原因）。
 * 厚み方向は`isInsideWall`と同じく**完全に収まる**ことを要求する（壁より太い梁は室内へ出る）。
 * @param {object} beam - BeamSolid
 * @param {object[]} walls
 * @param {number} atCoord
 * @returns {boolean}
 */
function isBeamInWallAt(beam, walls, atCoord) {
  const halfW = (beam.widthMm ?? 0) / 2;
  const bLo = beam.axisWorld - halfW, bHi = beam.axisWorld + halfW;
  for (const wall of walls) {
    if (wall.isVertical !== beam.isVertical) continue;
    const mr = wall.materialRange;
    if (!mr) continue;
    if (!(bLo >= mr.lo - GAP_EPS && bHi <= mr.hi + GAP_EPS)) continue;
    const tol = Math.abs(mr.hi - mr.lo); // 隅の取り合い（chamferWalls）ぶんの許容。isInsideWall参照
    const wLo = Math.min(wall.coord1, wall.coord2), wHi = Math.max(wall.coord1, wall.coord2);
    if (atCoord >= wLo - tol - GAP_EPS && atCoord <= wHi + tol + GAP_EPS) return true;
  }
  return false;
}

// 梁の芯が帯自身の部屋の広がり（cut.bandRoomBounds。世界座標の箱）の中にあるか。
// 未設定（部屋が特定できない呼び出し）は制限しない。
function withinBandRoom(cut, axisWorld) {
  const b = cut.bandRoomBounds;
  if (!b || !Number.isFinite(b.x1) || !Number.isFinite(b.x2)) return true;
  const [lo, hi] = cut.line.isVertical ? [b.x1, b.x2] : [b.y1, b.y2];
  return axisWorld >= lo - GAP_EPS && axisWorld <= hi + GAP_EPS;
}

// cutの全レイヤーの壁（自階・上階）。梁が壁の中かの判定に使う。
function wallsOf(cut) {
  return (cut.layers ?? []).flatMap(l => l.graph?.walls ?? []);
}

/**
 * 断面ローカルx（＋許容はみ出しtolMm）が、その切断の描画範囲（cut.line.lo..hi。壁のない端部の
 * 探査延長probeExtendLo/HiMmを含む）に掛かっているか。
 * @param {import('./sectionTypes.js').SectionCut} cut
 * @param {number} x
 * @param {number} tolMm
 * @returns {boolean}
 */
function withinCutDrawRange(cut, x, tolMm = 0) {
  const { lo, hi } = cutDrawRange(cut);
  // 切断線の範囲は**壁の仕上げ面基準**で、室境界の壁芯（CL）より半壁厚ぶん内側に詰まっている。
  // 梁はCLからCLまで張るため、CL上に乗る梁を取りこぼさないよう半壁厚を許容に加える
  // （`drawnSpanBoundaryX`等と同じ`halfWallThicknessMm`を使う。数値のハードコードはしない）。
  const tol = tolMm + (cut.face ? halfWallThicknessMm(cut.face) : 0);
  return x + tol >= lo - GAP_EPS && x - tol <= hi + GAP_EPS;
}

/**
 * cut.layers（SectionCut.layers。自階・上階のgraph参照＋floorZMm）から、各層のgraph.beamsを
 * BeamSolid[]へ変換する。layers・beamsが空なら空配列（例外なし）。
 * @param {Array<{graph:object, floorZMm:number, role:string}>} layers
 * @returns {BeamSolid[]}
 */
export function structuralContribution(layers) {
  // ユーザー実機指摘2026-08「2階床の構造材梁断面は、壁の中なら描画しない」: 壁の材厚の中に
  // 収まる梁は壁に隠れて見えないため寄与から落とす。壁は全レイヤー（自階・上階）から集める
  // ——2階床梁は1階の壁の上に乗る（自階の壁が隠す）ことも、2階の壁の中に入ることもあるため。
  const walls = (layers ?? []).flatMap(l => l.graph?.walls ?? []);
  const result = [];
  for (const layer of layers ?? []) {
    for (const beam of layer.graph?.beams ?? []) {
      if (beam.role === FOUNDATION_ROLE) continue; // 追加仕様2026-08: 基礎梁は展開図に描かない
      if (isInsideWall(beam, walls)) continue;
      const entry = findSectionEntry(beam.sectionDefId);
      const depthMm = entry?.height ?? beam.beamDepth ?? DEFAULT_DEPTH_MM;
      result.push({
        section: entry ?? null, // 断面形状（H形鋼のフランジ・ウェブ等）を作図で使う
        isVertical: beam.isVertical,
        axisWorld: beam.axisValue,
        spanLo: Math.min(beam.coord1, beam.coord2),
        spanHi: Math.max(beam.coord1, beam.coord2),
        widthMm: beam.sectionWidth,
        topZ: layer.floorZMm + beam.levelOffset,
        depthMm,
        role: beam.role,
      });
    }
  }
  return result;
}

/**
 * cut.layers の各層の graph.columns を ColumnSolid[] へ変換する（構造梁と対になる加算レイヤ。
 * 追加仕様2026-08「柱・梁型の断面を展開図に描く」）。杭（role:'foundation'）は基礎梁と同じく除外。
 *
 * 平面の占有矩形は柱芯(x,y)＋カタログ断面の width(X方向)×height(Y方向)——renderer/
 * StructuralLayer.jsx の ColumnSymbol/columnDiaphragmSize と同じ規約。rotation は 90/270 のとき
 * width/height を入れ替える。それ以外の角度（ASSUMED: 実データでは稀）は軸並行の外接矩形として
 * 扱わず、回転前の寸法をそのまま使う——展開図は軸並行の切断面しか持たないため、斜め柱の正確な
 * 見付け幅は本レイヤの対象外（defer）。
 * @param {Array<{graph:object, floorZMm:number, role:string}>} layers
 * @returns {ColumnSolid[]}
 */
export function structuralColumnContribution(layers) {
  // 梁と同じ「壁の中なら描画しない」規則を柱にも適用する（ユーザー実機指摘2026-08。
  // 通り芯の交点には自動補完で柱が立つため、外壁の中に納まる管柱まで柱型として描くと
  // 壁面の途中に実在しない縦線2本が出る＝実機の「C2のX2上のエッジ線」の正体）。
  // 壁より太い柱は室内へ出るため従来どおり柱型として描く（架構としての柱型は正しい表現）。
  const walls = (layers ?? []).flatMap(l => l.graph?.walls ?? []);
  const result = [];
  for (const layer of layers ?? []) {
    for (const column of layer.graph?.columns ?? []) {
      if (column.role === FOUNDATION_ROLE) continue; // 杭は展開図に描かない
      const sec = findSectionEntry(column.sectionDefId);
      let w = sec?.width ?? DEFAULT_DEPTH_MM;
      let h = sec?.height ?? DEFAULT_DEPTH_MM;
      const rot = (((column.rotation ?? 0) % 360) + 360) % 360;
      if (Math.abs(rot - 90) < 1 || Math.abs(rot - 270) < 1) { const t = w; w = h; h = t; }
      const solid = {
        xLo: column.x - w / 2, xHi: column.x + w / 2,
        yLo: column.y - h / 2, yHi: column.y + h / 2,
        baseZ: layer.floorZMm,
      };
      if (isColumnInsideWall(solid, walls)) continue;
      result.push(solid);
    }
  }
  return result;
}

/**
 * 柱の平面占有矩形が、いずれかの壁の材厚に収まり（厚み方向は完全に）、かつその壁のスパンに
 * 収まっているか（＝壁に隠れて見えない柱か）。判定の考え方・許容量は`isInsideWall`（梁）と同じ。
 * @param {ColumnSolid} solid
 * @param {object[]} walls
 * @returns {boolean}
 */
function isColumnInsideWall(solid, walls) {
  for (const wall of walls) {
    const mr = wall.materialRange;
    if (!mr) continue;
    // 壁の材厚方向は isVertical=true なら X・false なら Y。スパンはその直交軸。
    const [acrossLo, acrossHi, spanLo, spanHi] = wall.isVertical
      ? [solid.xLo, solid.xHi, solid.yLo, solid.yHi]
      : [solid.yLo, solid.yHi, solid.xLo, solid.xHi];
    if (!(acrossLo >= mr.lo - GAP_EPS && acrossHi <= mr.hi + GAP_EPS)) continue;
    const tol = Math.abs(mr.hi - mr.lo); // 隅の取り合い（chamferWalls）ぶんの許容。isInsideWall参照
    const wLo = Math.min(wall.coord1, wall.coord2), wHi = Math.max(wall.coord1, wall.coord2);
    if (spanLo >= wLo - tol - GAP_EPS && spanHi <= wHi + tol + GAP_EPS) return true;
  }
  return false;
}

/**
 * ColumnSolid[] → 1つの切断（cut）に対するプリミティブ。柱の平面矩形が切断線をまたぎ、かつ
 * run方向の見付け区間が切断線の範囲と重なるものだけを、**見付け幅の両端の縦線2本**（CUT太線）で
 * 描く（＝室内展開図の「柱型」）。
 *
 * 設計判断（ASSUMED・報告済み）: 上下端の水平線は描かない。StructuralColumn.topLevel は既定0で
 * 実データでは未編集のまま（＝高さの信頼できる情報源が無い）一方、柱は床から天井まで通しで
 * 立つのが常態のため、z範囲は cut.zRange（帯の床〜天井）そのものを使い、床線・天井線と重なる
 * 水平線は積まない。baseZ が既に cut.zRange.hiZ 以上の層（例: 1階の展開図から見た2階の柱）は
 * 退化するため何も描かない。
 * @param {ColumnSolid[]} contribution
 * @param {import('./sectionTypes.js').SectionCut} cut
 * @returns {object[]}
 */
export function structuralColumnPrimitivesForCut(contribution, cut) {
  const prims = [];
  const loZ = cut.zRange?.loZ ?? 0;
  const hiZ = cut.zRange?.hiZ ?? 0;
  for (const col of contribution ?? []) {
    const z0 = Math.max(col.baseZ, loZ);
    if (z0 >= hiZ - GAP_EPS) continue; // 上階の柱等、この帯の描画範囲に掛からない
    // 切断線（line.isVertical=true なら固定X・Y方向に伸びる）をまたぐか＋run方向の重なり。
    const [acrossLo, acrossHi, runLo, runHi] = cut.line.isVertical
      ? [col.xLo, col.xHi, col.yLo, col.yHi]
      : [col.yLo, col.yHi, col.xLo, col.xHi];
    const straddles = cut.line.axisValue >= acrossLo - GAP_EPS && cut.line.axisValue <= acrossHi + GAP_EPS;
    if (!straddles || !rangesOverlap(cut.line.lo, cut.line.hi, runLo, runHi)) continue;
    const xA = localXOf(cut, runLo), xB = localXOf(cut, runHi);
    prims.push(emitLine(cut, xA, z0, xA, hiZ, ElevationLineRole.CUT));
    prims.push(emitLine(cut, xB, z0, xB, hiZ, ElevationLineRole.CUT));
  }
  return prims;
}

// [aLo,aHi]と[bLo,bHi]が正の幅で重なるか（sectionStair.jsのrangesOverlapと同じ規約。section/内で
// 独立実装にする——sectionStair.jsへ依存すると階段固有の関数群(landing/flight向け)に構造梁の
// 関心事が紛れ込み、第3層同士が互いに依存する構成になるため）。
function rangesOverlap(aLo, aHi, bLo, bHi) {
  return aLo < bHi - GAP_EPS && aHi > bLo + GAP_EPS;
}

// 断面矩形4辺（CUT太線。sectionStair.jsのstringerRectLinesと同型の独立実装）。
function rectLines(cut, xLo, xHi, zTop, depthMm) {
  const zBot = zTop - depthMm;
  return [
    emitLine(cut, xLo, zBot, xLo, zTop, ElevationLineRole.CUT),
    emitLine(cut, xHi, zBot, xHi, zTop, ElevationLineRole.CUT),
    emitLine(cut, xLo, zTop, xHi, zTop, ElevationLineRole.CUT),
    emitLine(cut, xLo, zBot, xHi, zBot, ElevationLineRole.CUT),
  ];
}

// 閉じた点列（[x,z]の並び）をCUTの線分列にする。
function closedOutline(cut, pts) {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const [x1, z1] = pts[i], [x2, z2] = pts[(i + 1) % pts.length];
    out.push(emitLine(cut, x1, z1, x2, z2, ElevationLineRole.CUT));
  }
  return out;
}

/**
 * 部材の断面形状を、指定構造材（カタログのshape/webThickness/flangeThickness/wallThickness）に
 * 合わせて描く（ユーザー実機指摘2026-08「6」「断面形状を指定構造材に合わせて」）。
 * 矩形（木角材・RC）は従来どおり外形4本。H形鋼はフランジ・ウェブの実形状（12辺の閉じた輪郭）。
 * 角形鋼管・丸形鋼管は外形＋肉厚ぶん内側の輪郭。丸（RC丸柱）はプリミティブに円弧が無いため
 * 外接矩形のまま（既知の単純化。defer）。
 * @param {import('./sectionTypes.js').SectionCut} cut
 * @param {number} xLo - 見付け幅の左端（ローカルx）
 * @param {number} xHi - 同 右端
 * @param {number} zTop - 断面の上端（絶対z）
 * @param {number} depthMm - 断面の成
 * @param {object|null} entry - findSectionEntryの結果（未指定・未知形状は矩形）
 */
function sectionOutline(cut, xLo, xHi, zTop, depthMm, entry) {
  const zBot = zTop - depthMm;
  const shape = entry?.shape;
  if (shape === 'hSection') {
    // 実寸のフランジ幅・成に対する比でローカル寸法へ換算する（見付け幅xHi-xLoは梁のwidth、
    // depthMmはheightに対応する——どちらもカタログ値そのものだが、将来の縮尺差に備えて比で持つ）。
    const w = xHi - xLo, h = depthMm;
    const tf = (entry.flangeThickness ?? 0) * (h / (entry.height || h));
    const tw = (entry.webThickness ?? 0) * (w / (entry.width || w));
    if (tf > 0 && tw > 0 && 2 * tf < h && tw < w) {
      const xc = (xLo + xHi) / 2, wl = xc - tw / 2, wr = xc + tw / 2;
      return closedOutline(cut, [
        [xLo, zTop], [xHi, zTop], [xHi, zTop - tf], [wr, zTop - tf],
        [wr, zBot + tf], [xHi, zBot + tf], [xHi, zBot], [xLo, zBot],
        [xLo, zBot + tf], [wl, zBot + tf], [wl, zTop - tf], [xLo, zTop - tf],
      ]);
    }
  }
  if (shape === 'squarePipe' || shape === 'roundPipe') {
    const t = entry.wallThickness ?? 0;
    if (t > 0 && 2 * t < xHi - xLo && 2 * t < depthMm) {
      return [
        ...rectLines(cut, xLo, xHi, zTop, depthMm),
        ...rectLines(cut, xLo + t, xHi - t, zTop - t, depthMm - 2 * t),
      ];
    }
  }
  return rectLines(cut, xLo, xHi, zTop, depthMm);
}

/**
 * BeamSolid[]（structuralContributionの結果）を、1つの切断（cut）に対する断面プリミティブへ
 * 変換する（columnsは他の第3層関数とシグネチャを揃えるためだけに受け取り、x範囲のクランプには
 * 使わない——構造梁は柱の有無と無関係にCL間の実スパンで存在するため）。
 * - 切断線と直交し、かつ切断線の位置(cut.line.axisValue)が梁のスパン内・梁の位置
 *   (beam.axisWorld)が切断線の範囲(cut.line.lo..hi)内 → 幅×せいの断面矩形（CUT太線）。
 * - 切断線と平行かつ切断線の位置が梁の幅の帯内・spanが重なる → 上端線・下端線・両端縦線
 *   （DETAIL細線）。
 * - それ以外は何も出さない。
 * baseFloorZより下・天井より上はemitLineの既存フィルタ（cut.baseFloorZ/zRange.hiZ）で自動的に
 * 細破線へ降格する（本関数は新規の破線判定を持たない）。beams空・levelOffset=0でも例外は
 * 投げない。
 * @param {BeamSolid[]} contribution
 * @param {import('./sectionTypes.js').SectionCut} cut
 * @param {import('./sectionTypes.js').SectionColumn[]} [columns]
 * @returns {object[]}
 */
export function structuralPrimitivesForCut(contribution, cut, columns) {
  void columns; // 意図的に未使用（他の第3層関数とシグネチャを揃えるためだけに受け取る。上記コメント参照）。
  const prims = [];
  for (const beam of contribution ?? []) {
    const halfW = beam.widthMm / 2;
    // crosses（直交）: sectionStair.jsのcrossesFlightと同じ規約——cut.line自身の描画範囲
    // (lo/hi)は見ず、cut.lineの位置(axisValue)が梁のスパン内かどうかだけで判定する
    // （crossesFlightがflight.runLo/runHiだけを見てcut.line.lo/hiを見ないのと同じ理由：
    // 梁は室境界の壁芯（CL）に乗ることがあり、cut.lineの描画範囲は壁面基準でわずかに
    // 内側へ詰まっている——lo/hiまで要求すると壁芯上の梁を取りこぼす）。
    const crosses = cut.line.isVertical !== beam.isVertical &&
      cut.line.axisValue >= beam.spanLo - GAP_EPS && cut.line.axisValue <= beam.spanHi + GAP_EPS;
    if (crosses) {
      const x = localXOf(cut, beam.axisWorld);
      // **梁の位置が切断線の描画範囲内であること**（上のdocコメントの契約。実装が抜けており、
      // 面のはるか外——実機「6」では x=-6882.5 や x=-3325、面は 0..2885／-285..3442.5——にある
      // 別スパンの梁の断面まで描いていた。ユーザー実機指摘2026-08「壁の中にある2階床梁の断面
      // 描画不要」）。梁が室境界の壁芯（CL）に乗る場合を取りこぼさないよう、梁の半幅ぶんの
      // はみ出しは許容する。壁のない端部の探査延長（probeExtendLo/HiMm）も範囲に含める。
      if (!withinCutDrawRange(cut, x, halfW)) continue;
      // **切断位置で壁の中に納まる梁は描かない**（isBeamInWallAt参照）。
      if (isBeamInWallAt(beam, wallsOf(cut), cut.line.axisValue)) continue;
      prims.push(...sectionOutline(cut, x - halfW, x + halfW, beam.topZ, beam.depthMm, beam.section));
      continue;
    }
    // **室内を空中で横断する梁の見えがかり**（ユーザー実機指摘2026-08「6」A「材が空中に
    // 横断しているので、『A』に中線で鋼材の天地に線を描画」）。切断線と平行だが芯が離れている梁は
    // 旧`parallel`判定（切断線が梁の幅の帯を通ることを要求）に入らず、一切描かれなかった
    // ——実機の梁はY2の通り芯から225mm室内側にあり、面Aから見ると空中を横切って見える。
    // 天地（上端・下端）の2本だけをSILHOUETTE（中線）で描く（輪郭の縦線は持たせない——
    // 梁は面の端から端まで通っており、視界の中で端部が見えるわけではない）。
    const airborne = cut.line.isVertical === beam.isVertical
      && (beam.axisWorld - cut.line.axisValue) * (cut.viewSign ?? 1) > GAP_EPS
      && withinBandRoom(cut, beam.axisWorld)
      && rangesOverlap(cut.line.lo, cut.line.hi, beam.spanLo, beam.spanHi)
      && !(cut.line.axisValue >= beam.axisWorld - halfW - GAP_EPS
        && cut.line.axisValue <= beam.axisWorld + halfW + GAP_EPS); // 芯上は下のparallelが担当
    if (airborne) {
      const { lo: drawLo, hi: drawHi } = cutDrawRange(cut);
      const xa = localXOf(cut, beam.spanLo), xb = localXOf(cut, beam.spanHi);
      const loX = Math.max(drawLo, Math.min(xa, xb));
      const hiX = Math.min(drawHi, Math.max(xa, xb));
      if (hiX - loX > GAP_EPS) {
        prims.push(emitLine(cut, loX, beam.topZ, hiX, beam.topZ, ElevationLineRole.SILHOUETTE));
        prims.push(emitLine(cut, loX, beam.topZ - beam.depthMm, hiX, beam.topZ - beam.depthMm,
          ElevationLineRole.SILHOUETTE));
      }
      continue;
    }
    const parallel = cut.line.isVertical === beam.isVertical &&
      cut.line.axisValue >= beam.axisWorld - halfW - GAP_EPS && cut.line.axisValue <= beam.axisWorld + halfW + GAP_EPS &&
      rangesOverlap(cut.line.lo, cut.line.hi, beam.spanLo, beam.spanHi);
    if (!parallel) continue;
    const xLo = localXOf(cut, beam.spanLo), xHi = localXOf(cut, beam.spanHi);
    const loX = Math.min(xLo, xHi), hiX = Math.max(xLo, xHi);
    const zTop = beam.topZ, zBot = beam.topZ - beam.depthMm;
    prims.push(emitLine(cut, loX, zTop, hiX, zTop, ElevationLineRole.DETAIL));
    prims.push(emitLine(cut, loX, zBot, hiX, zBot, ElevationLineRole.DETAIL));
    prims.push(emitLine(cut, loX, zTop, loX, zBot, ElevationLineRole.DETAIL));
    prims.push(emitLine(cut, hiX, zTop, hiX, zBot, ElevationLineRole.DETAIL));
  }
  return prims;
}
