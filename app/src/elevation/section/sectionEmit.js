/**
 * 2.5D断面エンジン: emitColumns / emitOpenGapMarks（線種テーブル・アキX連結・最終降格。WP-E2）。
 * 設計意図はarchitect承認済みの実装指示書§5.6参照。WP-E5bでelevationStairSequence.js
 * （直接。stairPrimitivesForCut内のemitLine経由でも）から呼ばれるようになった。
 *
 * §5.6「線種テーブル」の唯一の情報源。破線は必ずlineプリミティブで出す
 * （レンダラのpolyline分岐はdash非対応。.claude/elevation-model.md）。
 */
import {
  GAP_LABEL_WIDTH_PX,
  ElevationLineRole, weightForRole, GAP_EPS_MM as GAP_EPS, PROBE_EPS_MM, kneeCapBottomMm, kneeCapFaceMm,
  ElevationDash, FLOAT_EPS, COORD_EPS_MM,
} from '../elevationStyle.js';
import { graphList } from '../../graphReadScope.js';
import {
  zToY, cutDrawRange, localXOf, hasCutWallStandingOn, slabRuns, cutWallRuns, slabJunctionOf, MEMBER_PRIM, WHOLE_OUTLINE, isOpenLikeBand,
} from './sectionTypes.js';
import { openingSectionPrimitives } from '../../openings/openingSection.js';
import { drawnFloorProfileZMax, drawnFloorProfileZAt } from './floorProfileMath.js';
import { FRAME_OVERHANG_MM } from '../../openings/openingPlanSymbolGeometry.js';
import {
  mergeIntervals, segmentInsideRect, subtractRectsFromLine, isZeroLengthLine, line, text,
} from '../elevationPrimitives.js';

// アキの下辺が1本の直線か（斜めの天端の上＝台形）の判定の許容差。列ごとの斜線の端の値は同じ式から出るので
// 実際には浮動小数の誤差（1e-9級）しか出ないが、GAP_EPS（1e-6）ちょうどに頼らない。
const SLOPE_FIT_EPS_MM = 0.01;

/**
 * §5.6最終フィルタの唯一の適用箇所（emitLine(x1,z1,x2,z2,role)の1箇所だけで適用する、という
 * 設計方針どおり）。線分の両端がともに「baseFloorZより下」または「天井断面より上」（向こう側）
 * なら、role・dashに関わらずDETAIL+dash:'dashed'へ降格する。
 * @param {import('./sectionTypes.js').SectionCut} cut
 * @param {number} x1
 * @param {number} z1
 * @param {number} x2
 * @param {number} z2
 * @param {string} role - ElevationLineRoleの値
 * @param {{dash?:string, ceilZ?:number, neverDowngrade?:boolean}} [opts] - ceilZ未指定は
 *   cut.zRange.hiZへフォールバック（§5.6「天井断面」＝この列で見えている天井——通常はzRange
 *   上端と一致するため、これを既定にする）。neverDowngrade:true（実機フィードバック第3弾C。
 *   リード裁定で契約変更を承認済み）は本関数のbeyond/forceDash判定を丸ごと無効化し、
 *   渡されたrole・dashをそのまま使う——CUT断面（ささら12×300矩形・踊り場床CUT線・踊り場桁断面）
 *   はbaseFloorZより下でも太線実線のまま、ささらの見えがかり帯（DETAIL）は同じくbaseFloorZより
 *   下でも細線実線のまま、という「降格が残るのは踏面梯子(正面視)と壁断面の見えがかりだけ」という
 *   線種裁定を呼び出し側（sectionStair.js）から明示的に選択できるようにするフラグ
 *   （既定false＝既存呼び出しは無変更）。
 * @returns {object} lineプリミティブ（y=zToY(z)変換済み）
 */
export function emitLine(cut, x1, z1, x2, z2, role, opts = {}) {
  const baseFloorZ = cut.baseFloorZ ?? 0;
  const ceilZ = opts.ceilZ ?? cut.zRange?.hiZ ?? Infinity;
  // 水平線（z1===z2。床線・天井線・段の踏面線等の大半）は「ちょうどbaseFloorZ／ceilZに触れる」
  // だけでは向こう側と判定しない（strict <・>）——通常の床線(z=baseFloorZそのもの)を誤って
  // 降格しないため（WP-E5b回帰: 元は両端の緩い判定(<=)にしていたところ、床z=baseFloorZの
  // 通常の水平線まで「向こう側」扱いされてしまった）。垂直線・斜め線（z1!==z2）は、
  // sectionProbe.jsがcut.baseFloorZをzBreaksに割り込ませるため片端がbaseFloorZちょうどに
  // 一致するのが通常のケースになる——「ちょうど境界」を含めて向こう側とみなす（Math.max/minの
  // 緩い判定）。水平線側で「band全体がbaseFloorZ以下」を降格させたい場合はopts.forceDashで
  // 明示する（emitColumns参照）。
  const isDegenerate = Math.abs(z1 - z2) < GAP_EPS;
  const beyond = isDegenerate
    ? (z1 < baseFloorZ - GAP_EPS || z1 > ceilZ + GAP_EPS)
    : (Math.max(z1, z2) <= baseFloorZ + GAP_EPS || Math.min(z1, z2) >= ceilZ - GAP_EPS);
  const forced = opts.forceDash === true;
  const downgrade = !opts.neverDowngrade && (beyond || forced);
  const finalRole = downgrade ? ElevationLineRole.DETAIL : role;
  const finalDash = downgrade ? ElevationDash.DASHED : (opts.dash ?? undefined);
  // role が undefined/null でも weight（'thin'）を必ず持つ（旧挙動）。role 文字列のままだと style 省略と区別できないため明示する
  const prim = line(x1, zToY(z1), x2, zToY(z2), { weight: weightForRole(finalRole) });
  if (finalDash) prim.dash = finalDash;
  return prim;
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
 * 梁の断面の輪郭の唯一の実装——断面エンジンの memberCut の描画（`emitColumns`）と加算レイヤ（sectionStructure.js）が共有する
 * （U1b B3-1 で sectionStructure.js からここへ移した。sectionEmit.js が sectionStructure.js を import すると循環になるため）。
 * @param {import('./sectionTypes.js').SectionCut} cut
 * @param {number} xLo - 見付け幅の左端（ローカルx）
 * @param {number} xHi - 同 右端
 * @param {number} zTop - 断面の上端（絶対z）
 * @param {number} depthMm - 断面の成
 * @param {object|null} entry - findSectionEntryの結果（未指定・未知形状は矩形）
 */
export function sectionOutline(cut, xLo, xHi, zTop, depthMm, entry) {
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

// band全体がbaseFloorZ以下／ceilZ以上（水平な上端・下端エッジが「ちょうど境界に触れるだけ」
// でも降格させたい場合の判定。emitLineのopts.forceDashに渡す）。
function bandFullyBeyond(cut, band, ceilZ) {
  const baseFloorZ = cut.baseFloorZ ?? 0;
  const top = ceilZ ?? cut.zRange?.hiZ ?? Infinity;
  return band.z1 <= baseFloorZ + GAP_EPS || band.z0 >= top - GAP_EPS;
}

// z区間が重なるか（隣接列の同一kind判定・アキ連結成分判定の共通ヘルパ）。
function overlapsZ(a, b) {
  return a.z0 < b.z1 - GAP_EPS && a.z1 > b.z0 + GAP_EPS;
}

// col（SectionColumn|null）から、[z0,z1]と重なる指定kindのband（無ければnull）を返す。
function matchingBand(col, z0, z1, kind) {
  if (!col) return null;
  return col.bands.find(b => b.kind === kind && overlapsZ(b, { z0, z1 })) ?? null;
}

// 2つの帯が「同じ壁面」を見ているか。壁オブジェクトは通り芯位置で分割されるため参照一致では
// 見分けられず、軸CL（同一graph内の同一オブジェクト）と材の面位置で比較する。層が違えば
// graphも違うため軸CLが一致せず、自動的にfalseになる。
function sameWallFace(a, b) {
  return !!a.wall && !!b.wall && a.wall.axisCL === b.wall.axisCL
    && Math.abs(a.wall.axisValue - b.wall.axisValue) < GAP_EPS;
}

// z区間の配列から1つの帯のz範囲を引く（uncoveredZRangesの内部ヘルパ）。
function subtractZ(ranges, nb) {
  const rest = [];
  for (const r of ranges) {
    if (!overlapsZ(nb, r)) { rest.push(r); continue; }
    if (nb.z0 > r.z0 + GAP_EPS) rest.push({ z0: r.z0, z1: nb.z0 });
    if (nb.z1 < r.z1 - GAP_EPS) rest.push({ z0: nb.z1, z1: r.z1 });
  }
  return rest;
}

/**
 * 見えがかり壁の帯が梁の断面（memberCut）で上下に分かれているとき、梁の高さを挟んで続く 1 枚の壁としてつないだ z 範囲
 * （分かれていなければ null）。`uncoveredZRanges` の同じ壁面の早期 return を帯の全体で判定するための範囲。
 * @param {{bands:object[]}} col
 * @param {object} band - col.bands の要素（kind:'wall'）
 * @returns {{z0:number, z1:number}|null}
 */
function wallExtentAcrossMembers(col, band) {
  const bs = col.bands, i = bs.indexOf(band);
  if (i < 0 || !band.wall) return null;
  let z0 = band.z0, z1 = band.z1;
  const sameWall = b => b?.kind === 'wall' && b.wall === band.wall && b.layerRole === band.layerRole;
  const reach = (dir) => {
    let j = i + dir, crossed = false, end = null;
    while (bs[j]?.kind === 'memberCut' || bs[j]?.kind === 'member') { crossed = true; j += dir; }
    if (crossed && sameWall(bs[j])) end = bs[j];
    return end;
  };
  const lower = reach(-1), upper = reach(+1);
  if (lower) z0 = lower.z0;
  if (upper) z1 = upper.z1;
  return lower || upper ? { z0, z1 } : null;
}

/**
 * band の [z0,z1] のうち、隣接列 col で**同じ壁面が続いていない**z区間（＝側縁の縦線を描くべき
 * 範囲）を返す。col が null（探査範囲外）なら全区間を返す。
 *
 * 「続いていない（＝縦線を描く）」のは、隣接列の壁帯が **同じ層(layerRole)で距離(distMm)だけが
 * 違う**場合＝1枚の面が折れた凹みで側面が見えるときだけ。層が変わっただけ（見えている壁が
 * 別階のものへ入れ替わった）のは連続面の折れ角ではないので描かない（ユーザー実機指摘2026-08
 * 「6」D。実機症状: 左CL上のz3800..5400に縦線が出ていた）。
 *
 * 旧実装は `matchingBand`（重なる帯を1つ見つけたら連続とみなす）でband全体を一括判定していたため、
 * **隣接列の壁が途中までしか無い**ケースで側縁が丸ごと消えていた（ユーザー実機指摘2026-08その17
 * 「「6」D2: 2階X2通りの壁を見ているので、3500左CLの2階に壁エッジ」——手前列は上が吹抜けで
 * 壁がz0..5400まで続くのに対し隣接列は1F天井までの0..2400しか無く、その差分2400..5400が
 * 壁面の実際の終端であるにもかかわらず縦線が出ていなかった）。
 * @param {object|null} col
 * @param {object} band
 * @returns {{z0:number,z1:number}[]}
 */
function uncoveredZRanges(col, band, side = null, extent = null, cut = null) {
  if (!col) return [{ z0: band.z0, z1: band.z1 }];
  let ranges = [{ z0: band.z0, z1: band.z1 }];
  for (const nb of col.bands) {
    // 梁の見え掛かり（member。U1b B3-2）: 梁が壁より手前（同じ奥行きを含む）なら壁はその裏へ続く＝側縁の縦線は引かない（梁の縁は member の枝が
    // 担う。壁の縁が梁の高さで途切れる＝f1）。壁のほうが手前なら梁はその向こうにあるだけで、梁の無い帯と同じ扱い（覆わない）。
    if (nb.kind === 'member') {
      if (!overlapsZ(nb, band)) continue;
      const a = cut ? faceNearMm(cut, band) : null, b = cut ? faceNearMm(cut, nb) : null;
      if (a !== null && b !== null && b <= a + GAP_EPS) ranges = subtractZ(ranges, nb);
      continue;
    }
    // 覆う（＝縦線を出さない）のは「同層・同距離＝そのまま続く壁」「別層＝見えている壁が
    // 入れ替わっただけ」、そして**隣接列の手前に切断壁がある**の3通り。残る「同層・別距離」
    // だけが凹みの側面として縦線になる。
    //
    // 切断壁(cut)を覆う側に数えるのは、**壁はその裏へ続いており凹んでいない**ため
    // ——境界に立つ縦線は切断壁自身の断面縁（CUT・太線）が描くので、見えがかり側で重ねて
    // 描くと同じ位置に2本出る。水平線側は`hiddenByCutWall`が同じ理由で既に抑止しており
    // （「手前の切断壁でこの帯が切られただけの縁は描かない」）、縦線側だけが取り残されていた。
    // 従来はこの重複が**線種が同じ（どちらもSILHOUETTE）ゆえに`dedupeLines`で消えていた**だけで、
    // 線種を「切断壁の縁=太線／見えがかり=中線・細線」へ分けた時点（ユーザー明示指示2026-08）に
    // 重複が表面化した——偶然の重複除去に頼らず、描かない理由の側で決める。
    if (nb.kind === 'cut') {
      if (!overlapsZ(nb, band)) continue;
      // 天端が天井の斜線に沿う切断壁（ceilEdge）は、境界での斜線の高さまでしか覆わない。
      const cutTop = side && nb.ceilEdge ? Math.min(nb.z1, side === 'prev' ? nb.ceilEdge.zAtX1 : nb.ceilEdge.zAtX0) : nb.z1;
      ranges = subtractZ(ranges, cutTop === nb.z1 ? nb : { z0: nb.z0, z1: cutTop });
      continue;
    }
    // QA是正2026-09（Phase 6b-2 C-1後の実機回帰）: hidden帯（展開図一般化Phase 6b-2 C-1。
    // 「描かない実体」）も覆う側に数える——理由はcutと同じで、hiddenの裏にも実体（今は描かない
    // だけの壁）が在り、その位置で視界が途切れているわけではない。hidden自身は自分の縁を
    // 一切描かない（sectionEmit.jsの`emitColumns`のif/elseチェーンに該当分岐が無い）ため、
    // ここで覆わないと「hiddenの手前でこの帯（無関係な別の壁）が終わった」という誤った凹みの
    // 縦線が生える（実機13.stq「6」面D1: 同じ`cut.airRoom`/`cut.underRooms`を帯の全cutで共有する
    // ため、この帯とは無関係な部屋13の2a壁がD1でも非可視候補になり、その span の両端
    // （`(3780,0)-(3780,-2400)`・`(6305,-1500)-(6305,-5400)`）に凹みの縦線が誤って出ていた。
    // 裁定9130007「13の壁関連の2本の縦線は描画しない」に反する回帰）。
    if (nb.kind === 'hidden') {
      if (!overlapsZ(nb, band)) continue;
      ranges = subtractZ(ranges, nb);
      continue;
    }
    // 梁の断面（memberCut。U1b B3-1）も覆う側: 断面の縁（梁の輪郭＝CUT）がその位置の縦線を担う。覆わないと、梁の幅の端
    // （列の境界）に壁の凹み側面線が輪郭と重なって出る。
    if (nb.kind === 'memberCut') {
      if (!overlapsZ(nb, band)) continue;
      ranges = subtractZ(ranges, nb);
      continue;
    }
    if (nb.kind !== 'wall') continue;
    if (nb.layerRole === band.layerRole && nb.distMm !== band.distMm) continue;
    // 同じ壁面かの早期 return（下）は帯の全体で判定する——帯が梁の断面（memberCut）で上下に分かれていても、梁の高さを挟んで
    // 続く 1 枚の壁の帯として扱う（`extent`＝梁で分かれた帯をつないだ z 範囲。分かれていなければ帯自身）。分けて判定すると
    // 下の片は隣の同じ壁面が重なって return するのに、上の片は重ならず梁の上に短い縦線が出る。
    const reach = extent ?? band;
    if (!overlapsZ(nb, reach)) continue;
    if (!overlapsZ(nb, band) && !(!nb.isKneeDrop && !band.isKneeDrop && sameWallFace(nb, band))) continue;
    // 同じ壁面がキャップ（天井高さ・上階セルの有無）の違いだけで高さを変えている境界は、
    // 壁が途切れたわけではないので**帯全体**を覆う＝縦線を出さない（ユーザー明示指示
    // 2026-08その18「セル境界は描画対象としない」。実機症状: 上階のセルが部屋⇄吹抜けで
    // 切り替わる位置＝CL上に、1階壁のキャップ差ぶんの縦線が出ていた——キャップはセル境界で
    // 切り替わるため、この線は必ずCL（一点鎖線）に重なる）。
    // 腰壁・垂れ壁で実際に高さが制限された帯（isKneeDrop）は実体の高さ差なので対象外。
    if (!nb.isKneeDrop && !band.isKneeDrop && sameWallFace(nb, band)) {
      // **ただし、その境界に切断壁が立っているならセル境界ではない**——上階の壁はその壁に
      // 突き当たって実際に終わっており、切断壁の天端より上は実体の終わりなので縦線が要る
      // （ユーザー実機指摘2026-08「「5」B: 2階Y1から2000と3500のCLにエッジが描画されない」）。
      // 天端より下は切断壁自身の断面が境界を示すので、そこまでは従来どおり抑止する。
      // 「必ずCL（一点鎖線）に重なる」というその18の根拠は、境界に実体が無い場合の話である。
      const cutTop = Math.max(...col.bands.filter(b => b.kind === 'cut').map(b => b.z1));
      if (!Number.isFinite(cutTop)) return [];
      // 天端までは「セル境界」として覆う。**その上は隣の壁面自身（nb）の被覆で決める**
      // ——隣で同じ壁面が天端の上まで続いていれば消え（袖壁の上に縦線を出さない＝その17）、
      // 続いていなければ残る（「5」B: 上階の壁が腰壁で終わっている）。
      ranges = subtractZ(ranges, { z0: band.z0, z1: cutTop });
    }
    // 斜めの天端の帯（topEdge）は境界での天端の高さまでしか覆わない（帯の上端 z1 は高い側の値）。
    // side: 隣接列が自列の手前側（'prev'＝その x1 が境界）か向こう側（'next'＝その x0 が境界）か。
    const nbTop = side && nb.topEdge ? Math.min(nb.z1, side === 'prev' ? nb.topEdge.zAtX1 : nb.topEdge.zAtX0) : nb.z1;
    ranges = subtractZ(ranges, nbTop === nb.z1 ? nb : { z0: nb.z0, z1: nbTop });
  }
  return ranges.filter(r => r.z1 - r.z0 > GAP_EPS);
}

/**
 * 背景側の水平線（見えがかり壁の上下端縁・スラブ端）が、**手前の切断壁に隠される**か
 * （ユーザー実機指摘2026-08「6」D1・B「1F天井断面が2階袖壁断面線とトリムされていない」）。
 *
 * 判定は「その高さが、この列の**空気ではない**（切断壁の実体が占めている）か」——
 * 「断面の中は描画しない」の一般則をこの列の高さ方向へ適用したもので、
 * `sectionVisibility.js`の空気区間と同じ見方をする（旧実装は「切断壁の天端以下ならすべて」で、
 * 床に立たない壁＝垂れ壁の**下**まで巻き込んで隠していた）。天端より上（腰壁・袖壁の上を通る
 * 上階天井）は壁に遮られないので、従来どおり対象外。
 */
function hiddenByCutWall(col, z) {
  return col.bands.some(b => b.kind === 'cut'
    && z >= b.z0 - GAP_EPS && z <= b.z1 + GAP_EPS);
}

/**
 * 見えがかり壁の帯の**側縁を立てるx**。
 *
 * 原則は列の境界（fallbackX）。ただし**その区間が隣接列の切断壁の天端から始まる**とき、つまり
 * 見えがかり壁の面が切断壁の上で終わっているとき、縦線は切断壁の**向こう側の面**へ送る
 * （ユーザー実機指摘2026-08「「5」D1: 2階Y1から2000のCL左側の腰壁の上から2階天井までの線は、
 * 同じCL右側が正解」）。
 *
 * 理由は平面にある——腰壁が突き当たる隅では壁の実体は連続しており、壁面が無くなる（アキになる）のは
 * その切断壁の**向こう側**から。手前の面に立てると、線が切断壁の断面の手前の縁から生えて見え、
 * 断面の厚みの中が壁なのかアキなのか図から読み取れなくなる（＝断面の厚みの中に、その厚みに
 * 属さない情報が入る）。切断壁は片面ずつのWallオブジェクトで複数列に割れるため、同じ天端を持つ
 * 切断壁の列が続くあいだ送り続ける。
 * @param {object[]} columns
 * @param {number} i - 見えがかり帯が乗る列
 * @param {-1|1} dir - -1=lo側 / +1=hi側
 * @param {number} z0 - この区間の下端
 * @param {number} fallbackX
 * @returns {number}
 */
function wallEndXAt(columns, i, dir, z0, fallbackX) {
  let x = fallbackX;
  for (let j = i + dir; columns[j]; j += dir) {
    if (!columns[j].bands.some(b => b.kind === 'cut' && Math.abs(b.z1 - z0) < GAP_EPS)) break;
    x = dir > 0 ? columns[j].x1 : columns[j].x0;
  }
  return x;
}

/** 切断壁の連なり run の天井側の上限＝run が覆う列の打ち切り値 col.ceilZ の最小（無ければ topZ）。 */
function runLimitZ(columns, run, topZ) {
  let limit = topZ;
  for (const c of columns) {
    if (c.x0 < run.x0 - GAP_EPS || c.x1 > run.x1 + GAP_EPS) continue;
    if (Number.isFinite(c.ceilZ)) limit = Math.min(limit, c.ceilZ);
  }
  return limit;
}

/**
 * 切断壁の斜めの天端（隔て板の天板）が切断面より向こうで上がる分の見え掛かり（ユーザー指示 2026-10-19 roof-test1 2階 階段 A
 * 「隔て板断面線の上、傾斜している天板の見え掛かりを細線描画」）。壁の帯の天端 z1 から、視線側の壁の端での天端
 * （`band.topBeyondZ`。sectionHits.js cutWallTopBeyondZ。列の打ち切り値 col.ceilZ＝runLimitZ を超えない）まで、両縁の
 * 立ち上がりと天端の水平を細線で描く——斜めの天板を正面から見ると、切断面の天端より上に板の両縁と遠端の天端が見える。
 * 壁ごとに 1 組（cutWallRuns。列は壁と無関係な断点でも分割される。連なりの中で値が違えば高い方）。帯の天端が天井に
 * 届いている壁（topBeyondZ 無し）は従来どおり何も描かない。
 * @param {import('./sectionTypes.js').SectionColumn[]} columns
 * @param {import('./sectionTypes.js').SectionCut} cut
 * @param {number|undefined} ceilZ
 * @returns {object[]}
 */
function cutWallTopBeyondSightlines(columns, cut, ceilZ) {
  const topZ = ceilZ ?? cut.zRange?.hiZ ?? Infinity;
  return cutWallRuns(columns).flatMap(r => {
    const beyond = Math.max(...columns
      .filter(c => c.x0 >= r.x0 - GAP_EPS && c.x1 <= r.x1 + GAP_EPS)
      .flatMap(c => c.bands.filter(b => b.kind === 'cut' && Math.abs(b.z1 - r.band.z1) < GAP_EPS && Number.isFinite(b.topBeyondZ)).map(b => b.topBeyondZ)));
    const z0 = r.band.z1, z1 = Math.min(beyond, runLimitZ(columns, r, topZ));
    if (!(z1 > z0 + GAP_EPS)) return [];
    return [
      emitLine(cut, r.x0, z0, r.x0, z1, ElevationLineRole.DETAIL, { ceilZ }),
      emitLine(cut, r.x1, z0, r.x1, z1, ElevationLineRole.DETAIL, { ceilZ }),
      emitLine(cut, r.x0, z1, r.x1, z1, ElevationLineRole.DETAIL, { ceilZ }),
    ].map(p => Object.assign(p, { __o: 'cutTopBeyond' }));
  });
}

/**
 * 切断壁（`cut`帯）の天端のCUT水平線。腰壁のように**見えている天井より下で終わる**切断壁は、
 * その上端が切断面の一部（そこで断面が閉じる）なので水平線を描く
 * （ユーザー実機指摘2026-08「6」D「腰壁断面線は、天端で曲がり、壁厚だけ左に進み」。
 * `cutAlong`の上端エッジと同じ扱い）。列ごとではなく**壁ごとに1本**描く——列は壁と無関係な
 * 断点でも分割されるため、列ごとに描くと同じ天端が複数本になる（seq1の既存テストが
 * 「上端水平線は1本・幅=壁厚」を固定している）。下端は描かない: 壁が載っている床
 * （スラブ端・床断面線）が既に描いており、同指摘のプロファイルも天端→外側面→2FL床と回って
 * 壁の下を通らない。
 */
function cutWallTopEdges(columns, cut, ceilZ, emitCtx) {
  const topZ = ceilZ ?? cut.zRange?.hiZ ?? null;
  if (topZ == null) return [];
  return cutWallRuns(columns)
    // 天端が天井の斜線に沿う壁（ceilEdge）に水平の天端線は無い（斜めの天井線は体裁が引く）。
    // 天井に届いた壁（その壁の連なりの列の打ち切り値 col.ceilZ 以上まで立つ）は天端が露出しない。列ごとに打ち切り値が違う
    // （階段帯の裏面の ceilClip）ときは列の min と比べる（どれかの列で天井に届いていれば天端は引かない）。
    .filter(r => !r.band.ceilEdge && r.band.z1 < runLimitZ(columns, r, topZ) - GAP_EPS)
    .flatMap(r => [
      emitLine(cut, r.x0, r.band.z1, r.x1, r.band.z1, ElevationLineRole.CUT, { ceilZ }),
      // 笠木の帯は腰壁・垂れ壁のもの——天端プロファイルの壁（隔て壁の斜め天端）には無い。
      ...(r.band.profiledTop ? []
        : kneeCapUnderline(cut, r.x0, r.x1, r.band.z1, r.band.z0, ceilZ, emitCtx, weightForRole(ElevationLineRole.CUT))),
    ]);
}

/**
 * 腰壁の端部抑えの**内側の細線**（`emitColumns`の見えがかり壁の分岐から呼ぶ）。
 *
 * 天端の帯（`kneeCapUnderline`が下端を描く帯）は、壁がそこで終わる端では**端面**としても
 * 見える。端の中線（帯の外形の外側1本）は凹み側面線が既に描いているので、ここは帯の見付ぶん
 * 内側の細線だけを足す。見付と退化ガードは`kneeCapBottomMm`（elevationStyle.js）へ委ねる
 * ——面図側（elevationFigure.jsの旧kneeCapMarksOnFace）と同じ規則を1箇所に置くため。
 * @param {object[]} prims 積み先
 * @param {import('./sectionTypes.js').SectionCut} cut
 * @param {object} col
 * @param {object} band 見えがかり壁の帯（isKneeDrop以外は無視する）
 * @param {{prev:object|null, next:object|null, loRanges:object[], hiRanges:object[], ceilZ:number|undefined, scale?:number}} ctx
 *   scale は表示倍率(px/mm)。見付の1px保証（elevationStyle.js kneeCapFaceMm）に使う。
 */
function appendKneeCapEndFaces(prims, cut, col, band, ctx) {
  if (!band.isKneeDrop || band.profiledTop) return; // 天端プロファイルの壁に笠木の端面は無い
  const top = (col.ceilZ ?? ctx.ceilZ ?? Infinity);
  if (!(band.z1 < top - GAP_EPS)) return; // 天井まで届く壁＝天端が露出していない
  // 端面: 外側の線は凹み側面線（中線）、内側は細線。余白1px保証は中線×細線の線幅で取る。
  const outerWeight = weightForRole(ElevationLineRole.SILHOUETTE);
  if (kneeCapBottomMm(band.z1 - band.z0, ctx.scale, ctx.lineWeightsPx, outerWeight) == null) return; // 見付に満たない退化指定
  const faceMm = kneeCapFaceMm(ctx.scale, ctx.lineWeightsPx, outerWeight);
  const coversWholeBand = ranges => ranges.length === 1
    && Math.abs(ranges[0].z0 - band.z0) < GAP_EPS && Math.abs(ranges[0].z1 - band.z1) < GAP_EPS;
  // 内側へ寄せる向きは列の内側（lo端なら+、hi端なら−）。
  if (ctx.prev && coversWholeBand(ctx.loRanges)) {
    const x = col.x0 + faceMm;
    prims.push(emitLine(cut, x, band.z0, x, band.z1, ElevationLineRole.DETAIL, { ceilZ: ctx.ceilZ }));
  }
  if (ctx.next && coversWholeBand(ctx.hiRanges)) {
    const x = col.x1 - faceMm;
    prims.push(emitLine(cut, x, band.z0, x, band.z1, ElevationLineRole.DETAIL, { ceilZ: ctx.ceilZ }));
  }
}

/**
 * 腰壁の天端の帯の**下端**（細線）。天端そのもの（上端）は呼び出し側が既に描いているので、
 * ここは帯の下端1本だけを返す（仕様2026-08「展開図 中線＝天端／細線＝その下」）。
 * 見付と退化ガードは展開図の唯一の情報源 `kneeCapBottomMm`（elevationStyle.js）へ委ねる
 * ——面図側（elevationFigure.js の kneeCapMarksOnFace）と同じ規則にするため。
 * @param {number} topZ 天端のz（絶対）
 * @param {number} floorZ その壁の足元のz（帯のz0。層の床）
 * @param {{scale?:number, lineWeightsPx?:object}} [emitCtx] 表示倍率(px/mm)と線幅表。見付の1px保証
 *   （天端の線が高さを守り、細線が線幅込みで余白1px以上下がる）
 * @param {string} [topWeight] 天端の線のweight（切断壁は'thick'、見えがかりは描いた線のrole）
 * @returns {object[]} 0本 or 1本
 */
function kneeCapUnderline(cut, x0, x1, topZ, floorZ, ceilZ, emitCtx = {}, topWeight = 'thick') {
  const bottom = kneeCapBottomMm(topZ - floorZ, emitCtx.scale, emitCtx.lineWeightsPx, topWeight);
  if (bottom == null) return [];
  const z = floorZ + bottom;
  return [emitLine(cut, x0, z, x1, z, ElevationLineRole.DETAIL, { ceilZ })];
}

/**
 * **天井断面の高さが変わる境界に立つ、上階の床構造（スラブ）の断面**（ユーザー明示指示の図形）。
 *
 * 低い側の天井（1階天井）と上階の床（2FL）に挟まれた区間は、**断面の中**＝建物の躯体で、
 * その中には何も描かない。描くのはその**輪郭**だけ:
 * ```
 *   ...吹抜け側...   |          ← 小口（低い側の天井 → 上階の床）
 *                    +--------  ← 上階の床の断面線（低い天井の側へ走る）
 *                       a       ← 断面の中（何も描かない）
 *   -----------------+--------  ← 低い側の天井の断面線（既に描かれている）
 * ```
 * この輪郭が無いと、1階天井の線と2階天井の線が繋がらないまま宙で終わる。
 * 境界に壁が立つ場合（腰壁・袖壁）は、その壁の断面がこの床の上に載る形になる——壁の帯自体は
 * 実体のz範囲のまま（`sectionEngine.js`の`clipBandsToCeil`）で、下へ引き伸ばさない。
 *
 * 上階の床レベルは層スタックから取る（低い側の天井より上・高い側の天井より下にある層のFL）。
 * 該当する層が無い＝同じ階の中の天井段差なので、この規則の対象外（何も描かない）。
 * @param {import('./sectionTypes.js').SectionColumn[]} columns - x0昇順
 * @param {import('./sectionTypes.js').SectionCut} cut
 * @param {number|undefined} ceilZ
 * @returns {object[]}
 */
/**
 * [xa,xb]のうち`cut.aboveCeilVisibleRanges`（天井断面より上で描画してよい断面ローカルxの範囲。
 * 「断面の中は描画しない」の判定結果。省略＝制限しない）に入る部分。向きは元のまま保つ。
 *
 * 現状は呼び出し側（`elevationVoid.js`の`upperStoreySegments`）が空気セルの連結成分から求めて
 * 渡す。段階2でエンジン自身が全帯について求めるようになったら、この入力は不要になる。
 * @param {import('./sectionTypes.js').SectionCut} cut
 * @param {number} xa
 * @param {number} xb
 * @returns {Array<[number,number]>}
 */
function aboveCeilVisibleSpans(cut, xa, xb) {
  const ranges = cut.aboveCeilVisibleRanges;
  if (!Array.isArray(ranges)) return [[xa, xb]];
  const lo = Math.min(xa, xb), hi = Math.max(xa, xb);
  const out = [];
  for (const r of ranges) {
    const s = Math.max(lo, r.lo), e = Math.min(hi, r.hi);
    if (e - s > GAP_EPS) out.push(xa <= xb ? [s, e] : [e, s]);
  }
  return out;
}

function ceilStepSlabSection(columns, cut, ceilZ) {
  // 入力契約: 区間ごとの天井（cut.ceilProfile）を持つ切断だけが対象（持たない切断は何も出さない）。
  if (!(cut.ceilProfile?.length)) return [];
  const prims = [];
  const range = cutDrawRange(cut);
  for (let i = 0; i + 1 < columns.length; i++) {
    const a = columns[i], b = columns[i + 1];
    if (!Number.isFinite(a.ceilZ) || !Number.isFinite(b.ceilZ)) continue;
    if (Math.abs(a.ceilZ - b.ceilZ) < GAP_EPS) continue;
    // 傾いた天井（ceilEdge）の列どうしは、境界での天井の高さが続いていれば段差ではない（斜線の続き）。
    // 段差の高さは境界での値（傾いた列は斜線の端の値）で見る。
    const aZ = a.ceilEdge?.zAtX1 ?? a.ceilZ, bZ = b.ceilEdge?.zAtX0 ?? b.ceilZ;
    if (Math.abs(aZ - bZ) < GAP_EPS) continue;
    const zLow = Math.min(aZ, bZ), zHigh = Math.max(aZ, bZ);
    // 低い天井の側が「上階の床が実在する」と言っている場合だけ描く（sectionEngine.jsの
    // upperFloorZ）。上に部屋が無い＝床が無い境界に床の断面線を描いてはいけない
    // （ユーザー確定「吹抜けには天井断面まで水平断面が無い」）。
    // 境界のすぐ隣の列は**まだ吹抜けのセルの中**でありうる（天井段差の位置は壁の手前の面、
    // 上階の床が始まるのは壁の向こうの面で、半壁厚ずれる）ため、低い天井が続くあいだ
    // 外側へ走査して最初に見つかった値を使う。
    const step = aZ < bZ ? -1 : +1; // 低い天井の側へ進む向き
    let floorZ = null;
    for (let k = aZ < bZ ? i : i + 1; k >= 0 && k < columns.length; k += step) {
      // 傾いた列は天井の範囲[低い側, 高い側]に zLow を含めば「低い天井が続く」とみなす。
      const hiK = columns[k].ceilEdge ? Math.max(columns[k].ceilEdge.zAtX0, columns[k].ceilEdge.zAtX1) : columns[k].ceilZ;
      if (!(zLow >= (columns[k].ceilZ ?? NaN) - GAP_EPS && zLow <= hiK + GAP_EPS)) break;
      if (Number.isFinite(columns[k].upperFloorZ)) { floorZ = columns[k].upperFloorZ; break; }
    }
    if (!Number.isFinite(floorZ) || floorZ <= zLow + GAP_EPS || floorZ >= zHigh - GAP_EPS) continue;
    const x = a.x1;
    // 小口（低い側の天井 → 上階の床）。境界そのものなので必ず1本。
    prims.push(emitLine(cut, x, zLow, x, floorZ, ElevationLineRole.CUT, { ceilZ }));
    // 上階の床の断面線は**低い天井の側**へ走る（高い側は吹抜けで床が無い）。
    // 端は面の描画範囲の端（壁のない端部のはね出しを含む）——ユーザー明示指示
    // 「1500CLの右側はね出しまで」。
    // 上階の床の断面線は、境界に立つ切断壁（腰壁・袖壁）の**断面の中**を通ってはいけない
    // ——上階の床と、その上に載る壁は1つの連続した切断面で、その内部にこの線を引くと
    // 「展開図では断面の中は描画しない」に反する（ユーザー明示指示2026-08「「5」D1: CL右側の
    // 腰壁天端から2FLまでの断面線と2FL断面が取り合うのが正解」——壁の向こう側の面で
    // 床の断面線へ折れるのが1本の輪郭）。壁の列を越えた位置＝壁の向こう側の面から描き始める。
    let startX = x;
    for (let k = step > 0 ? i + 1 : i; columns[k]; k += step) {
      if (!hasCutWallStandingOn(columns[k], floorZ)) break;
      startX = step > 0 ? columns[k].x1 : columns[k].x0;
    }
    const outX = a.ceilZ < b.ceilZ ? range.lo : range.hi;
    if (Math.abs(outX - startX) > GAP_EPS) {
      // 上階の床の断面線は**低い天井の断面線より上**に載る＝その区間の上階が見えているときだけ
      // 描いてよい（見えていなければ「断面の中」で、上階の床は天井裏の躯体になる）。
      for (const [sx, ex] of aboveCeilVisibleSpans(cut, startX, outX)) {
        prims.push(emitLine(cut, sx, floorZ, ex, floorZ, ElevationLineRole.CUT, { ceilZ }));
      }
    }
  }
  return prims;
}


/**
 * スラブ天端の水平線を`nearX`から`targetX`へ伸ばすとき、**その天端に腰壁が同面で載っている
 * 列の手前**で止めたx。
 *
 * 根拠は`emitColumns`の`flushOnSlab`と同じユーザー裁定（実機「6」C「2FLの線は、左の壁断面から
 * 腰壁が終わるエッジまで不要。この腰壁の仕上げ面は、直下の2FLから1F天井線までの面と同面のため」）
 * ——腰壁は床の端に立つので、その仕上げ面と直下のスラブ小口は同一平面で、見た目に線は現れない。
 * `flushOnSlab`は見えがかり帯の側（腰壁の下端縁）でこの線を抑止しているが、スラブの側から
 * 張り出す本経路が抑止を持たないと、同じ線を反対側から引き直してしまう（はり出し列に腰壁の
 * **断面**が立つと、面の中の走りとzが一致してペアになり、面の中へ侵入していた）。
 *
 * 「面の外に立つ切断壁は相手にしない」（`cutDrawRange`で弾く）案は採らない——同じ切断壁から
 * 出る1F天井断面線と2FLへの立上り（実機「6」D2の裁定どおりの線）まで一緒に消えるため。
 * 消すべきは「同面ゆえに見えない」1本だけであり、その理由は`flushOnSlab`が既に述べている。
 * @param {object[]} columns
 * @param {number} nearX - 張り出しの起点（切断壁の手前の面）
 * @param {number} targetX - 抑止が無ければ届く先（スラブの端）
 * @param {number} slabTopZ - スラブの天端z
 * @returns {number}
 */
function flushKneeStopX(columns, nearX, targetX, slabTopZ) {
  const dir = targetX > nearX ? 1 : -1;
  const lo = Math.min(nearX, targetX), hi = Math.max(nearX, targetX);
  const ordered = dir > 0 ? columns : [...columns].reverse();
  let x = nearX;
  for (const col of ordered) {
    if (col.x0 < lo - GAP_EPS || col.x1 > hi + GAP_EPS) continue;
    if (col.bands.some(b => b.isKneeDrop && Math.abs(b.z0 - slabTopZ) < GAP_EPS)) break;
    x = dir > 0 ? col.x1 : col.x0;
  }
  return x;
}

/**
 * 上階床スラブの端に**切断壁が載っている**（袖壁・腰壁）ときの取り合い
 * （ユーザー実機指摘2026-08「6」D1・B「CL内側まで進んで、上を向いて2階袖壁の階段側断面線と
 * トリム／1FL天井から2FL床までの上へ向かう線分がない」）。
 * スラブは吹抜けの開口縁（CL）で終わるが、袖壁はそのCLに芯を合わせて左右へ張り出す。作図は
 *   下階天井(slab.z0) …→ 袖壁の反対側の面 → そこを**上へ**立ち上げて 上階床(slab.z1) へ
 * とつなぎ、袖壁の断面線と交点で取り合わせる。この立上りが無いと天井線が宙で終わる。
 * 上階床側（slab.z1）の水平線は袖壁の手前の面で止まる（`hiddenByCutWall`）——同指摘の
 * 「2FL床断面まで下りる、再度CLの外へ延長して終わる」どおり、壁の下は通らない。
 *
 * **小口が立つのは、壁の向こう側に探査済みの空気があるスラブだけ**（`sectionTypes.js`の
 * `slabJunctionOf`のgate。ユーザー裁定2026-09-13「6」C: 壁のある端では自階の壁＋床構造が
 * 未探査のまま上階の腰壁だけがはり出し列に立つ——そこへ小口と1F天井線を描くと壁断面の
 * **内部**に線が入る）。
 * **この取り合いの3本（下階天井・立上り・上階床）はすべて断面＝CUT**（ユーザー裁定2026-09-13
 * 「6」B「Y2から3500にある1階天井、1階天井から2FLまでの縦線は断面を表す太線が正解」）——
 * スラブは仮想断面が実際に切っている躯体で、その輪郭は壁の断面縁と同格。下階天井の線は
 * **スラブの走り全体**（外端〜壁の向こう側の面）を1本で描き、走りの中で見えがかり側が出す
 * 同じ高さの中線（見えがかり壁の上端縁・slab/open境界）は`emitColumns`が抑止する
 * （`sectionSlabRunsOf`。同じ線を2種類の線種で重ねない）。
 */
function slabEdgeCutWallJunction(columns, cut, ceilZ, sectionSlabs) {
  const prims = [];
  for (const { run: s, hits } of sectionSlabs) {
    // 下階天井の断面線: スラブの走り全体を、立つ壁の向こう側の面まで含めて1本で描く。
    const xs = [s.x0, s.x1, ...hits.map(h => h.farX)];
    prims.push(emitLine(cut, Math.min(...xs), s.band.z0, Math.max(...xs), s.band.z0,
      ElevationLineRole.CUT, { ceilZ }));
    for (const { nearX, farX, slabOnLoSide } of hits) {
      // 小口（立上り）: 壁の向こう側の面で下階天井→上階床。
      prims.push(emitLine(cut, farX, s.band.z0, farX, s.band.z1, ElevationLineRole.CUT, { ceilZ }));
      // **上階床の断面線を袖壁の手前の面からスラブ側へ張り出す**（ユーザー実機指摘2026-08「6」D1
      // 「2F腰壁断面が2FLまで下りたあと、左を向いて2FL床断面線はりだし」）。旧はこの線を
      // 「スラブの上に立つ遠い壁の下端縁」に頼っていたが、その壁が帯の部屋の外（d7250）で
      // 探索対象から外れた結果、線ごと消えていた——スラブ自身から描くのが本来の姿。
      // 張り出しは**腰壁が同面で載っている区間の手前で止める**（`flushOnSlab`と同じ規約を、
      // スラブの側から見たもの）。
      const outX = flushKneeStopX(columns, nearX, slabOnLoSide ? s.x0 : s.x1, s.band.z1);
      if (Math.abs(outX - nearX) > GAP_EPS) {
        prims.push(emitLine(cut, nearX, s.band.z1, outX, s.band.z1, ElevationLineRole.CUT, { ceilZ }));
      }
    }
  }
  return prims;
}

/**
 * 「切断壁が縁に載り、その向こう側に小口が見える」スラブの走り（＝断面として輪郭を描く
 * スラブ）とその取り合い（`slabJunctionOf`の結果）の一覧。`slabEdgeCutWallJunction`が輪郭を
 * 描き、`emitColumns`が同じ高さの見えがかり側の中線を抑止するための共通の問い。
 * @param {import('./sectionTypes.js').SectionColumn[]} columns
 * @returns {Array<{run:{x0:number,x1:number,band:object}, hits:Array<{nearX:number,farX:number,slabOnLoSide:boolean}>}>}
 */
function sectionSlabRunsOf(columns) {
  const cutRuns = cutWallRuns(columns);
  const out = [];
  for (const run of slabRuns(columns)) {
    const hits = cutRuns.map(c => slabJunctionOf(columns, run, c)).filter(Boolean);
    if (hits.length > 0) out.push({ run, hits });
  }
  return out;
}

// その列・その高さの水平線は「断面として輪郭を描くスラブ」の下端（下階天井の断面線）か
// ——`slabEdgeCutWallJunction`がCUTで1本描くので、見えがかり側（壁の上端縁・slab/open境界）は
// 同じ位置に中線を重ねない。
function ownedBySectionSlab(sectionSlabs, col, z) {
  return sectionSlabs.some(({ run }) => Math.abs(run.band.z0 - z) < GAP_EPS
    && col.x0 >= run.x0 - GAP_EPS && col.x1 <= run.x1 + GAP_EPS);
}

/**
 * 見えがかりの線種は**奥行き**で決まる（ユーザー明示指示2026-08「切断壁の縁は太線が正で、その他の
 * 見えがかりの線を直近を中線、それ以外を細線で分類」）。この切断で見えている最も手前の壁面までの
 * 距離を返す（見えがかり壁が1枚も無ければInfinity）。
 *
 * 「直近」は列ごとではなく**その切断（＝その1枚の図）全体**で決める——列ごとに最小を取ると、
 * 奥まった凹みもその列では最前面なので中線になり、面の中で奥行きの表現が失われる。図全体で
 * 最も手前＝その面自身の壁面（`sectionCutPlane.js`で下げたぶんの距離）が中線、そこから奥は
 * 全て細線、という深度の階調になる。
 * @param {import('./sectionTypes.js').SectionColumn[]} columns
 * @returns {number}
 */
export function nearestSightlineDistMm(columns) {
  let min = Infinity;
  for (const col of columns ?? []) {
    for (const band of col.bands) {
      // 階段室越しの壁（viaStair）は数えない——面から離れた階段室の壁が「直近」になって手前の線種の階調を変えない
      if (band.kind === 'wall' && !band.viaStair && Number.isFinite(band.distMm)) min = Math.min(min, band.distMm);
    }
  }
  return min;
}

/**
 * その帯が見せている「仮想断面からの距離」。open/slabは**何も見えていない**のでnull。
 * 見えがかり線を描くかどうかは、隣り合う帯どうしでこの値が変わるかだけで決まる
 * （ユーザー明示指示2026-08「仮想断面からの距離が変わるところに垂直、水平、または、斜めの
 * 見えがかり線を描画」）——同じ距離が続いていればそこは1枚の連続面であり、線は存在しない。
 * @param {object|null|undefined} band
 * @returns {number|null}
 */
function visibleDepthMm(band) {
  if (!band) return null;
  if (band.kind === 'wall') return Number.isFinite(band.distMm) ? band.distMm : null;
  if (band.kind === 'cut' || band.kind === 'cutAlong') return 0; // 切断面は距離0
  if (band.kind === 'memberCut') return 0; // 梁の断面も切断面で切られる実体＝距離0（壁の見えがかりの縁はその手前に出ない。U1b B3-1）
  // 梁の見え掛かり（member。U1b B3-2）: 手前の面までの奥行き nearMm（帯の distMm）。負（切断線より手前に梁の面がある）は 0 に寄せる
  if (band.kind === 'member') return Number.isFinite(band.distMm) ? Math.max(0, band.distMm) : null;
  return null; // open/slab
}

// 壁の見えがかりの帯の、切断線から材の範囲の手前の縁までの視線方向の距離（sectionHits.js の wallFace の nearMm と同じ式）。
// 梁の見え掛かり（member）との手前奥の比較だけに使う（壁どうしは従来どおり distMm）。材の範囲が取れなければ distMm。
function wallNearMm(cut, band) {
  const mr = band.wall?.materialRange;
  if (!mr) return band.distMm;
  const sign = cut.viewSign === -1 ? -1 : 1;
  const edge = sign < 0 ? Math.max(mr.lo, mr.hi) : Math.min(mr.lo, mr.hi);
  return (edge - cut.line.axisValue) * sign;
}

// 帯の「手前の面までの奥行き」。壁と梁の見え掛かり（member）の比較用（壁は材の手前の縁、梁は nearMm）。比較できない帯は null。
function faceNearMm(cut, band) {
  if (!band) return null;
  if (band.kind === 'member') return Number.isFinite(band.distMm) ? band.distMm : null;
  if (band.kind === 'wall') { const v = wallNearMm(cut, band); return Number.isFinite(v) ? v : null; }
  return null;
}

// 列の中で、指定zにz方向で隣接する帯（dir=-1なら下側・+1なら上側）。範囲外はundefined。
function neighborBandAt(col, z, dir) {
  return col.bands.find(b => (dir < 0
    ? Math.abs(b.z1 - z) < GAP_EPS
    : Math.abs(b.z0 - z) < GAP_EPS));
}

// slab の帯に添えた片（slab.members）の z 方向の隣: 同じ slab の中で z が接する兄弟の片（memberCut・別の member）。
// 片自身が slab.members に無い（独立の member 帯）か、兄弟がいなければ undefined（呼び元が neighborBandAt に戻す）
function siblingPieceAt(col, piece, z, dir) {
  const slab = col.bands.find(b => b.kind === 'slab' && (b.members ?? []).includes(piece));
  if (!slab) return undefined;
  return slab.members.find(p => p !== piece && p.member !== piece.member && (dir < 0
    ? Math.abs(p.z1 - z) < GAP_EPS
    : Math.abs(p.z0 - z) < GAP_EPS));
}

/**
 * その帯が、隣（z方向）との境界の見えがかり線を**描く側か**。
 * 距離が変わらなければ線は無い（1枚の連続面）。変わるときは**手前の面**がその輪郭を持つ
 * ——両方が描くと同じ位置に線種の違う線が2本出る（奥行きで線種を分けた結果、以前は同一線種
 * ゆえに`dedupeLines`が消していた重複が表面化する）。相手が何も見えていない側（アキ・床スラブ・
 * 範囲外）なら、この面の輪郭としてこちらが描く。
 * @param {object} band
 * @param {object|null|undefined} neighbor
 * @returns {boolean}
 */
function ownsBoundary(band, neighbor, cut = null) {
  // 隣が梁の見え掛かり（member。U1b B3-2）なら、手前奥は手前の面までの奥行き（壁＝材の手前の縁・梁＝nearMm）で比べる。
  // 壁のほうが手前のときだけ壁の輪郭。同じ奥行きは梁の側が引く（規則 1。emitColumns の member の枝）
  if (cut && neighbor?.kind === 'member') {
    const a = faceNearMm(cut, band), b = faceNearMm(cut, neighbor);
    return a !== null && b !== null && a < b - GAP_EPS;
  }
  // QA是正2026-09（Phase 6b-2 C-1後の実機回帰）: 隣（z方向）がhidden帯なら境界線を描かない
  // ——hiddenは「開いている（visibleDepthMm null）」のではなく「実体はあるが描かない」ため、
  // `null`と同じ「相手が何も見えていない」扱いにすると、band側が誤って「自分がこの境界の
  // 輪郭を持つ」と判定し、hiddenの手前・上下に無関係な縁線が生える（実機13.stq「6」面A/D2:
  // 同じ`cut.airRoom`/`cut.underRooms`を共有する部屋13の2a壁が非可視候補になった別の面で、
  // その壁の帯（z方向の上または下）に隣接する無関係な壁の天端/下端の縁線が誤って出ていた）。
  if (neighbor?.kind === 'hidden') return false;
  const a = visibleDepthMm(band);
  if (a === null) return false;
  const b = visibleDepthMm(neighbor);
  if (b === null) return true;
  return a < b;
}

/**
 * その列で「床断面線・天井断面線が既にある高さ」とみなすz。**FL・CHの見えがかりは描画しない**
 * （ユーザー明示指示2026-08）——床と天井はその位置に断面線（CUT・太線）を持っており、壁がそこに
 * 接する線を見えがかりとして重ねると同じ位置に2本出る（線種を奥行きで分けた結果、太線と
 * 中線・細線が重なって見える）。
 *
 * FL: 帯自身のFL（baseFloorZ）・各層のFL（floorZMm）・その列の床スラブのFL。
 * CH: **その列の天井断面（`col.ceilZ`。無ければ帯の天井 emitCtx.ceilZ／cut.zRange.hiZ）**。
 * 天井高さは層の属性ではなく部屋・区間ごとに違うため層スタックからは一意に決まらず、区間の天井を
 * 知っている呼び出し側から`cut.ceilProfile`で受け取る（sectionEngine.js）。
 * @param {import('./sectionTypes.js').SectionCut} cut
 * @param {import('./sectionTypes.js').SectionColumn} col
 * @param {number|undefined} ceilZ - emitCtx.ceilZ
 * @returns {number[]}
 */
function sectionLevelZs(cut, col, ceilZ) {
  const zs = [];
  if (Number.isFinite(cut.baseFloorZ)) zs.push(cut.baseFloorZ);
  for (const layer of cut.layers ?? []) {
    if (Number.isFinite(layer?.floorZMm)) zs.push(layer.floorZMm);
  }
  for (const band of col.bands) {
    if (band.kind === 'slab' && Number.isFinite(band.floorZ)) zs.push(band.floorZ);
  }
  const chZ = ceilZ ?? cut.zRange?.hiZ;
  if (Number.isFinite(chZ)) zs.push(chZ);
  return zs;
}

/**
 * 面自身の範囲（断面ローカルx）。`cut.line.lo/hi`（探査延長`probeExtendLo/HiMm`を**含まない**値）
 * をdirSignに関わらず昇順に直したもの。「面の端かどうか」を見る箇所の唯一の式にする。
 * @param {import('./sectionTypes.js').SectionCut} cut
 * @returns {{loX:number, hiX:number}}
 */
function faceRangeX(cut) {
  const a = localXOf(cut, cut.line.lo), b = localXOf(cut, cut.line.hi);
  return { loX: Math.min(a, b), hiX: Math.max(a, b) };
}

/**
 * SectionColumn[] → 切断壁の断面（両縁）・見えがかり壁面の輪郭／凹み側面線 のプリミティブ列
 * （§3.4役割分担表・§5.5・§5.6）。アキXはemitOpenGapMarks側（本関数はopen/slab bandを描かない
 * ——slabは非描画のまま、AMBIGUITY F）。
 * @param {import('./sectionTypes.js').SectionColumn[]} columns
 * @param {import('./sectionTypes.js').SectionCut} cut
 * @param {{ceilZ?:number, openEndLo?:boolean, openEndHi?:boolean}} [emitCtx]
 * @returns {object[]}
 */
export function emitColumns(columns, cut, emitCtx = {}) {
  const prims = [];
  const ceilZ = emitCtx.ceilZ;
  // 見えがかりの線種（直近=中線／それ以外=細線）。nearestSightlineDistMm参照。
  const nearestDistMm = nearestSightlineDistMm(columns);
  const sightRole = distMm => (Number.isFinite(distMm) && distMm <= nearestDistMm + GAP_EPS
    ? ElevationLineRole.SILHOUETTE : ElevationLineRole.DETAIL);
  // 断面として輪郭を描くスラブ（`slabEdgeCutWallJunction`の対象）。帯種別では分けず、列のデータで
  // 決まる: スラブの上面が実在の床（`slabTopIsRealFloor`）で、その上に切断壁が載り、壁の向こうが
  // 探査済みの空気——天井の手前に見えている床構造だけが残る。天井の向こうに打ち切られて隠れている
  // 床（天井の段差の低い側）は`ceilStepSlabSection`の担当で、スラブ帯自体が列から消えている。
  // **1回だけ計算して両方へ渡す**（条件式を2箇所に持つと「CUT線は出るのに中線を抑止しない」
  // 二重線が起きる）。
  const sectionSlabs = sectionSlabRunsOf(columns);
  // 梁の断面（memberCut。U1b B3-1）: 帯の縁は引かず、梁が最初に現れる列で断面の輪郭（`sectionOutline`。H形・角形鋼管を含む）を
  // 1 回だけ重ねる（建具断面と同じ方式）。描く z 範囲はその梁の帯（全列）の和——部屋帯は天井断面で切られた帯（R4）、階段帯は
  // 天井より上も含む（emitLine が細破線へ降格）。切断線の帯の中を通る梁（along）は天地を DETAIL の線にまとめて引く（下の追記）。
  const memberZ = memberZRangesOf(columns, cut);
  const outlined = new Set();
  const alongSegs = new Map();
  // 梁の見え掛かり（member。U1b B3-2）の天地の線の区間（梁 → 列ごとの区間）。同じ梁・同じ z・同じ線種の隣り合う列は 1 本にまとめて引く
  // （列の分割で線が割れない。加算の見え掛かりは梁 1 本の可視区間を 1 本の線で引いていた）。縦線は列の端で直接引く。
  const faceSegs = new Map();
  const drawRange = cutDrawRange(cut);
  // 注: 「壁のない端部で線を図の外側へ延長する」処理はここには無い。プリミティブを後から
  // 引き伸ばすのではなく、**探査範囲そのものを外へ広げる**（sectionProbe.jsの
  // probeExtendLo/HiMm。ユーザー裁定2026-08 A案）——面の外の列も実データとして生成されるため、
  // 延長ぶんの線は通常の帯の縁として自然に出る。両方やると二重に伸びるので、ここでは何もしない。
  columns.forEach((col, i) => {
    const prev = columns[i - 1] ?? null;
    const next = columns[i + 1] ?? null;
    for (const band of col.bands) {
      if (band.kind === 'cut') {
        if (band.openingPassThrough) {
          emitOpeningPassThrough(prims, { cut, col, band, prev, ceilZ });
          continue;
        }
        emitCutBand(prims, { cut, col, band, prev, next, ceilZ });
      } else if (band.kind === 'wall') {
        // 階段室越しの壁（viaStair）は面から離れた向こう側の空間の壁なので、常に細線（直近の階調に参加しない）。
        const role = band.viaStair ? ElevationLineRole.DETAIL : sightRole(band.distMm);
        emitWallHorizontals(prims, { cut, col, band, ceilZ, emitCtx, role, sectionSlabs });
        emitWallRecessEdges(prims, { cut, columns, i, col, band, prev, next, ceilZ, emitCtx, role });
      } else if (band.kind === 'cutAlong') {
        emitCutAlongBand(prims, { cut, col, band, prev, next, ceilZ, emitCtx });
      } else if (band.kind === 'member') {
        emitMemberFaceBand(prims, faceSegs, col, band, { prev, next, cut, drawRange, ceilZ });
      } else if (band.kind === 'open' && (band.farFloorZ != null || band.farCeilZ != null)) {
        emitFarOpenBand(prims, { cut, col, band, ceilZ, sightRole });
      }
      emitBandMembers(prims, {
        cut, col, band, prev, next, ceilZ, drawRange, faceSegs, alongSegs, outlined, memberZ,
      });
      // open/slabの帯自体はここでは描かない（AMBIGUITY F）。ただしslab→openの境界（＝above層の
      // 床の端）はSILHOUETTE水平線として描く（WP-E5b追加。§5.6「2FLの中線= above層の床スラブ端
      // （slabとopenの境界）→SILHOUETTE水平線」）。同一列内でz方向に隣接するslab/open帯の境界を
      // 対象にする——列をまたぐslab⇄open（x方向の境界）は凹み側面線に相当する概念が無く
      // （床の厚み方向の境界であってwallの見付面ではない）、本WPでは対象外（ASSUMED）。
      // hidden帯（展開図一般化Phase 6b-2 C-1。「描かない実体」）も、上のif/elseチェーンに
      // 該当する分岐が無いためここでは自動的に何も描かない——kind==='cut'/'wall'/'cutAlong'/
      // 'open'のどれでもないので単に読み飛ばされる（他のkindを新設したときと同じ扱い）。
    }
    emitFloorEdgeLines(prims, { cut, col, sectionSlabs, ceilZ });
  });
  prims.push(...memberAlongPrimitives(alongSegs, cut));
  prims.push(...memberFaceHorizontals(faceSegs, cut));
  prims.push(...cutWallTopEdges(columns, cut, ceilZ, emitCtx));
  prims.push(...cutWallTopBeyondSightlines(columns, cut, ceilZ));
  // 上階の床との取り合いの担当は列のデータで決まり、帯種別では分けない。スラブの帯が列の可視範囲に
  // 残っている（天井の手前に見える床構造）なら slabEdgeCutWallJunction（スラブ帯の外端を起点に
  // 反対側へ伸ばす）、天井の向こうに打ち切られて隠れている（隣り合う列の天井の段差・低い側に
  // upperFloorZ）なら ceilStepSlabSection（天井の高さが変わる境界を起点に低い天井の側へ伸ばす）。
  // 両者は列ごとに排他（天井の低い側の列はスラブ帯が消え、スラブ列は帯が z1 まで残る）。
  // 見かけだけのスラブ（上階が吹抜けで upperFloorZ が null）には slabJunctionOf の関門
  // （slabTopIsRealFloor）が小口を立てさせない。
  prims.push(...ceilStepSlabSection(columns, cut, ceilZ));
  prims.push(...slabEdgeCutWallJunction(columns, cut, ceilZ, sectionSlabs));
  return dedupeLines(prims);
}

/**
 * 梁の断面の片: memberCut の帯、または slab の帯に添えた `members`（床構造・天井懐の中の梁は slab の帯を割らない。sectionHits.js）。
 * （slab の帯に添えた梁の見え掛かりの片〔kind:'member'〕は断面ではないので除く。見え掛かりは emitMemberFaceBand が描く）
 */
function memberPiecesOf(band) {
  return band.kind === 'memberCut' ? [band] : (band.members ?? []).filter(p => p.kind !== 'member');
}

/**
 * 梁（memberCut）ごとの断面の z 範囲 { z0, z1 }（along の片は除く）。梁が最初に現れる列で断面の輪郭を 1 回だけ重ねる
 * ための範囲で、下端は候補自身の下端、上端は帯の z1 を、梁の幅に掛かる列の天井断面（col.ceilZ）の最小値で切る。
 * @returns {Map<object, {z0:number, z1:number}>}
 */
function memberZRangesOf(columns, cut) {
  const memberZ = new Map();
  for (const col of columns) {
    for (const band of col.bands) {
      for (const piece of memberPiecesOf(band)) {
        if (piece.along) continue;
        const z = memberZ.get(piece.member);
        const pz0 = piece.hz0 ?? piece.z0; // 下端は候補自身の下端（帯の z 範囲に切られない）、上端は帯の z1（天井断面・zRange で切られる）
        memberZ.set(piece.member, z ? { z0: Math.min(z.z0, pz0), z1: Math.max(z.z1, piece.z1) } : { z0: pz0, z1: piece.z1 });
      }
    }
  }
  // 輪郭の上端は、梁の幅に掛かる列の天井断面（col.ceilZ。傾いた列は低い側）の最小値で切る（R4「天井で切り詰める」。天井の段の継ぎ目に
  // 載る梁は、高い側の列の帯だけを見ると低い側の天井線より上まで描いてしまう）。最小値が梁の下端以下なら輪郭を描かない。
  // 天井断面を持たない帯（階段帯）は列の ceilZ が無いので従来どおり。
  for (const [m, z] of memberZ) {
    const xa = localXOf(cut, m.axisWorld - m.widthMm / 2), xb = localXOf(cut, m.axisWorld + m.widthMm / 2);
    const lo = Math.min(xa, xb), hi = Math.max(xa, xb);
    for (const col of columns) {
      if (col.x1 > lo + GAP_EPS && col.x0 < hi - GAP_EPS && Number.isFinite(col.ceilZ)) z.z1 = Math.min(z.z1, col.ceilZ);
    }
  }
  return memberZ;
}

/**
 * 切断壁の帯 band と b が同じ壁の表裏か（隣接列の cut 帯が同じ壁の続きか）。
 * **同じ壁のcut帯が隣接列にも続いていれば、その境界は壁の内部なので線を描かない**
 * （ユーザー実機指摘2026-08「6」D。腰壁の断面がx=-57.5..57.5の1枚なのに、列が
 * x-57.5..0/0..45/45..57.5へ分割されていたため、内部にV x0・V x45の縦線が出ていた）。
 * cutAlongの端部縦線と同じ「隣接列に同じ壁が続くか」のパターン。壁の同一性は
 * band.wall参照で見る——両側にwallが載っている場合だけ抑止し、載っていない
 * （単体テストの手書き列など）場合は従来どおり描く。
 * **壁は片面ずつのWallオブジェクト**（cutWallRuns参照。実機の袖壁1枚が2つのWallに
 * 分かれる）ため、参照一致だけで見ると1枚の袖壁の**内部**＝軸CL上にその境界の縦線が
 * 出る。**同じ軸CLに載っていて同じz範囲の切断壁は、1枚の壁の表裏**とみなす
 * ——切断線は壁を厚み方向に横切るので、同一軸CLの切断壁が隣接列で接するのは
 * 「同じ壁の反対の面」以外にありえない（別々の壁が接するなら軸CLが違う）。
 * 天端の水平線を1本にまとめている`cutWallRuns`と同じ「1枚の壁」の見方をそろえたもの。
 */
function sameWallAs(band, b) {
  return !!b && !!b.wall && !!band.wall
    && (b.wall === band.wall
      || (!!b.wall.axisCL && b.wall.axisCL === band.wall.axisCL
        && Math.abs(b.z0 - band.z0) < GAP_EPS
        // 天端が天井の斜線に沿う帯（ceilEdge）は列ごとに上端が違うが、斜線は壁厚の中でも続く。
        && (Math.abs(b.z1 - band.z1) < GAP_EPS || (!!b.ceilEdge && !!band.ceilEdge))));
}

/**
 * 建具で切れている区間（openingPassThrough）の切断壁の帯: 壁の断面の両縁は描かず、開口の上下（まぐさの下端・下枠の上端）に
 * 壁の断面の切り口としてCUTの水平線を引き、その建具の断面（枠・扉）を壁の最初の列で1回だけ重ねる。
 */
function emitOpeningPassThrough(prims, { cut, col, band, prev, ceilZ }) {
  // **建具で切れている区間は壁ではない**（sectionProbe.jsが仮想断面と建具の交差で付ける
  // `openingPassThrough`。ユーザー明示指示2026-09）——壁の断面の両縁は描かず、開口の
  // 上下（まぐさの下端・下枠の上端）に壁の断面の切り口としてCUTの水平線を引く。
  for (const z of [band.z0, band.z1]) {
    prims.push(Object.assign(
      emitLine(cut, col.x0, z, col.x1, z, ElevationLineRole.CUT, { ceilZ }),
      { __o: 'cutOpeningEdge' }));
  }
  // その建具の断面（枠・扉。openings/openingSection.js）を1回だけ重ねる。
  // 見込の基準は**この帯の壁1枚の材の範囲**——ユーザー明示指示2026-09「枠の上の壁は、
  // 当該部屋側のみで良いので、内外壁をまとめる必要はない」。列は壁厚方向に分割される
  // ことがあるため、その壁の最初の列（隣に同じ壁のcut帯が続かない側）でだけ描く。
  const mr = band.wall?.materialRange;
  if (mr && band.opening && !sameWallAs(band, matchingBand(prev, band.z0, band.z1, 'cut'))) {
    const a = localXOf(cut, mr.lo), b = localXOf(cut, mr.hi);
    prims.push(...openingSectionPrimitives(
      band.opening, Math.min(a, b) - FRAME_OVERHANG_MM, 1,
      weightForRole(ElevationLineRole.CUT), weightForRole(ElevationLineRole.SILHOUETTE),
      { wallThicknessMm: Math.abs(mr.hi - mr.lo), worldPerDirSign: cut.dirSign ?? 1,
        detailWeight: weightForRole(ElevationLineRole.DETAIL) },
    ));
  }
}

/**
 * 切断壁（cut）の帯の断面矩形の両縁（縦線）。その縁が接する側がopenならCUT、塞がれていればSILHOUETTE
 * （AMBIGUITY B）。列の外（画面端）はopen扱い。WP-E5b修正: 隣接列が「別のcut band」で
 * なければopen扱いにしていた旧実装（`|| !matchingBand(...,'cut')`）は、隣接列が
 * 'wall'（距離のある見えがかり壁）のときも「塞がれていない」と誤判定していた
 * （例: seq1で切断された往復間の壁の縁が、遠くに見える別の壁（'wall'band）に接する場合。
 * 保存意味論「seq1では切断線を横切るcutとして厚みの2縁=open側CUT/塞がれ側SILHOUETTE」
 * を満たすには、'wall'・'cutAlong'等どの種類であれ何らかの実体があれば「塞がれている」
 * とみなす必要がある——isOpenSideAtは`kind==='open'`（または開口貫通）だけをopenと
 * みなすため、そのままの結果を使えばよい）。
 */
function emitCutBand(prims, { cut, col, band, prev, next, ceilZ }) {
  // `exposedSide`（sectionEngine.jsのclipBandsToCeil）が付いた帯は、**天井の高さが変わる
  // 境界に立っていて片側からしか見えない壁**。見えるのはその側の面だけで、反対側の面は
  // 低い天井の裏に隠れている——両縁を描くと壁厚が図に出てしまう（ユーザー明示指示:
  // 実機「5」A「X2の右側が断面線なら、左側は壁の中になり、描画しないが正解」）。
  const hidden = band.exposedSide ?? null;
  // 同じ軸CLの切断壁の表裏で高さが違う（隔て壁の埋込み柱の立ち上がり）とき、隣の断面に覆われた高さの縁は
  // 壁の内部なので描かない（覆われていない高さだけ縦線を引く）。
  const edgeRanges = nbCol => (nbCol?.bands ?? [])
    .filter(b => b.kind === 'cut' && !!b.wall?.axisCL && b.wall.axisCL === band.wall?.axisCL && overlapsZ(b, band))
    .reduce((rs, b) => subtractZ(rs, b), [{ z0: band.z0, z1: band.z1 }])
    .filter(r => r.z1 - r.z0 > GAP_EPS);
  // 天端が天井の斜線に沿う帯（ceilEdge）の側縁は、その端での斜線の高さで止める（帯の z1 は高い側の値）。
  // 段違い天井の境界に立つ壁（exposedSide）の見えない側の縁も、**低い側の天井（列の打ち切り値 col.ceilZ）より下**は
  // 描く——そこは低い天井の下の空気に面した壁の断面の縁で、隠れているのは天井より上だけ
  // （ユーザー指示 2026-10-15「moku4-3 1階 階段 A: 隔て板の左側の断面線は床断面から上の天井断面線まで」）。
  const lowCeil = col.ceilZ;
  const hiddenTop = (r) => (Number.isFinite(lowCeil) ? Math.min(r.z1, lowCeil) : r.z0);
  if (!sameWallAs(band, matchingBand(prev, band.z0, band.z1, 'cut'))) {
    for (const r of edgeRanges(prev)) {
      let zTop = band.ceilEdge ? Math.min(r.z1, band.ceilEdge.zAtX0) : r.z1;
      if (hidden === 'hi') zTop = Math.min(zTop, hiddenTop(r));
      if (zTop - r.z0 <= GAP_EPS) continue;
      prims.push(Object.assign(emitLine(cut, col.x0, r.z0, col.x0, zTop, ElevationLineRole.CUT, { ceilZ }),{__o:'cutEdgeLo'}));
    }
  }
  if (!sameWallAs(band, matchingBand(next, band.z0, band.z1, 'cut'))) {
    for (const r of edgeRanges(next)) {
      let zTop = band.ceilEdge ? Math.min(r.z1, band.ceilEdge.zAtX1) : r.z1;
      if (hidden === 'lo') zTop = Math.min(zTop, hiddenTop(r));
      if (zTop - r.z0 <= GAP_EPS) continue;
      prims.push(Object.assign(emitLine(cut, col.x1, r.z0, col.x1, zTop, ElevationLineRole.CUT, { ceilZ }),{__o:'cutEdgeHi'}));
    }
  }
  // 天端の斜線は引かない: 天井に届いた壁には天端を引かず天井線は体裁が引く（平面の cutWallTopEdges と
  // 同じ規約）。finalizeBand の dedupe は端点の完全一致しか畳まないので、列ごとの短い斜線を出すと
  // 体裁の1本と二重に残る。
}

/**
 * 見えがかり壁（wall）の帯の水平線（下端・天端）と、腰壁の天端の下端の細線、階段室越しの壁の巾木。
 * 水平線は「仮想断面からの距離が変わるところ」だけに描き、FL・CHには描かない
 * （ユーザー明示指示2026-08。visibleDepthMm / sectionLevelZs 参照）。
 */
function emitWallHorizontals(prims, { cut, col, band, ceilZ, emitCtx, role, sectionSlabs }) {
  // 見えがかり壁面の輪郭（上端・下端）。水平線（縮退）はemitLineの単独判定では
  // 「ちょうどbaseFloorZ/ceilZに触れるだけ」を向こう側と見なさないため、band全体が
  // baseFloorZ以下／ceilZ以上ならforceDashで明示的に降格する（WP-E5b: sectionProbe.jsが
  // cut.baseFloorZをzBreaksに割り込ませることで生じる、内部分割されたband用の対応）。
  const beyondBand = bandFullyBeyond(cut, band, ceilZ);
  // **手前の切断壁でこの帯が切られただけの縁は描かない**（ユーザー実機指摘2026-08「6」D）。
  // 同じ列で切断壁(cut)の上端/下端とちょうど一致する縁は、見えがかり壁の実際の端ではなく
  // 「手前の腰壁に遮られてそこで見えなくなった」だけの遮蔽境界で、壁自体はその裏へ続いている
  // （実機症状: 腰壁の内側半分x0..57.5の下に、遠い壁の天端としてH z3000が出ていた）。
  // 腰壁の天端側はcut帯自身がCUT水平線として描くので、線が失われることはない。
  // **腰壁が床スラブの上に直に載っている境界は描かない**（ユーザー実機指摘2026-08「6」C
  // 「2FLの線は、左の壁断面から腰壁が終わるエッジまで不要。この腰壁の仕上げ面は、直下の
  // 2FLから1FL天井線までの面と同面のため」）。腰壁は床の端に立つので、その仕上げ面と
  // 直下の床スラブ小口は同一平面＝見た目に線は現れない。腰壁でない（`isKneeDrop`でない）
  // 遠くの壁は同面ではないので、スラブ小口の線はそのまま出る（実機の右半分がこれ）。
  const flushOnSlab = band.isKneeDrop
    && col.bands.some(b => b.kind === 'slab' && Math.abs(b.z1 - band.z0) < GAP_EPS);
  // 見えがかりの水平線は「仮想断面からの距離が変わるところ」だけに描き、FL・CHには描かない
  // （ユーザー明示指示2026-08。visibleDepthMm / sectionLevelZs 参照）。
  // 天井断面の高さは列ごとに違う（区間ごとの天井。sectionEngine.jsのceilProfile）ため、
  // その列の天井を優先して使う——帯の天井(emitCtx.ceilZ)だけを見ると、天井の低い区間で
  // 天井断面線と見えがかりの水平線が重なる。
  const sectionZs = sectionLevelZs(cut, col, col.ceilZ ?? ceilZ);
  const atSectionLevel = z => sectionZs.some(f => Math.abs(z - f) < GAP_EPS);
  if (!flushOnSlab && !hiddenByCutWall(col, band.z0) && !atSectionLevel(band.z0)
      && ownsBoundary(band, neighborBandAt(col, band.z0, -1), cut)) {
    prims.push(emitLine(cut, col.x0, band.z0, col.x1, band.z0, role, { ceilZ, forceDash: beyondBand }));
  }
  // **その空間の天井の縁は、仮想断面から最も近い面（＝主な描画対象）と同格なので中線**
  // （ユーザー明示指示2026-08「追加した1階天井見えがかり：仮想断面から最も近い壁
  // （=主な描画対象）と同じ面のエッジなので中線を選択する」）——天井は切断面のすぐ手前から
  // 奥へ広がる面で、その縁までの奥行きは0であり、見えている壁までの距離（この帯のdistMm）
  // ではない。天井懐(slab)がすぐ上に接し、その層の天井(ceilZ)がこの高さに一致することで
  // 「この境界は空間の天井である」と判定する（slab/openの境界側と同じ見方）。
  const upperBand = neighborBandAt(col, band.z1, +1);
  const atSpaceCeil = upperBand?.kind === 'slab' && Number.isFinite(upperBand.ceilZ)
    && Math.abs(upperBand.ceilZ - band.z1) < GAP_EPS;
  // 階段の裏面との取り合いの天端（junctionTop）は壁の自由な縁ではなく、連続する天井との接線＝常に細線。
  const topRole = band.junctionTop ? ElevationLineRole.DETAIL : (atSpaceCeil ? ElevationLineRole.SILHOUETTE : role);
  // 斜めの天端（band.topEdge。隔て壁）: 天端は列の両端の高さを結ぶ斜線。斜線は FL・CH の高さに
  // 端が触れても列の境界で切れているだけ（列の境界は斜面が水平線を横切る位置で割ってある）なので、
  // 水平線との重なり判定（atSectionLevel・ownedBySectionSlab）は対象外。
  const slope = band.topEdge ?? null;
  if (!hiddenByCutWall(col, band.z1) && (slope || !atSectionLevel(band.z1))
      && (slope || !ownedBySectionSlab(sectionSlabs, col, band.z1))
      && ownsBoundary(band, neighborBandAt(col, band.z1, +1), cut)) {
    prims.push(slope
      ? emitLine(cut, col.x0, slope.zAtX0, col.x1, slope.zAtX1, topRole, { ceilZ, forceDash: beyondBand })
      : emitLine(cut, col.x0, band.z1, col.x1, band.z1, topRole, { ceilZ, forceDash: beyondBand }));
    // 腰壁の天端（仕様2026-08）: 見えがかりでも天端の帯は見えるので下端を細線で足す。
    // 天端の水平線を実際に描いた場合だけ——遮蔽で消した縁の下に帯だけ残ると嘘になる。
    if (band.isKneeDrop && !band.profiledTop && band.z1 < (col.ceilZ ?? ceilZ ?? Infinity) - GAP_EPS) {
      prims.push(...kneeCapUnderline(cut, col.x0, col.x1, band.z1, band.z0, ceilZ, emitCtx, weightForRole(topRole)));
    }
  }
  // 階段室越しの壁（viaStair）の巾木（ユーザー指示2026-10-15「階段下スペースは『ホール』なので巾木が
  // 見える」）。帯の部屋（ホール）の巾木高さ emitCtx.baseboardMm を、壁の足元（下に同じ壁の帯が続かない
  // 帯の下端）から立ち上げた細線。遮蔽・降格は壁の水平線と同じ（hiddenByCutWall・beyondBand）。
  if (band.viaStair && emitCtx.baseboardMm > 0) {
    const bbZ = band.z0 + emitCtx.baseboardMm;
    const below = neighborBandAt(col, band.z0, -1);
    // 足元＝床の高さ（その列・層のFL）にある帯の下端だけ。扉の上の壁（まぐさ）など床に無い帯の下端には引かない。
    const isWallFoot = !(below?.kind === 'wall' && below.viaStair) && atSectionLevel(band.z0);
    if (isWallFoot && bbZ < band.z1 - GAP_EPS && !hiddenByCutWall(col, bbZ)) {
      prims.push(emitLine(cut, col.x0, bbZ, col.x1, bbZ, ElevationLineRole.DETAIL, { ceilZ, forceDash: beyondBand }));
    }
  }
}

/**
 * 見えがかり壁（wall）の帯の凹み側面線（隣接列で同一z区間のwallのdistMmが変化した境界のSILHOUETTE縦線。§5.5）と、
 * 腰壁の端部抑え（appendKneeCapEndFaces）。
 */
function emitWallRecessEdges(prims, { cut, columns, i, col, band, prev, next, ceilZ, emitCtx, role }) {
  // 凹み: 隣接列で同一z区間のwallのdistMmが変化した境界にSILHOUETTE縦線（§5.5）。
  // 凹み側面線。**列の外側の端（prev/nextが無い＝描画範囲の端）では、その端に壁が
  // 無ければ描かない**（ユーザー実機指摘2026-08「3500左CLにエッジはない」）——
  // 隣接列が無いことは「そこで壁が終わる」ことを意味しない。範囲外は単に未探査であり、
  // 面が「壁のない端部」だと分かっている側（emitCtx.openEndLo/openEndHi）では
  // 壁面はその先へ続いている。旧実装は`!prevWall`だけで判定していたため、
  // 先頭列・末尾列には常に縦線が出ていた（全パネルの端に出る症状）。
  // **凹みは同じ層(layerRole)の壁どうしでしか成立しない**（ユーザー実機指摘2026-08「6」D。
  // 実機症状: 左CL上のz3800..5400に縦線が出ていた——隣は上階側の遠い壁(d7250 above)、
  // こちらは設置階の壁(d2250 self)で、距離が変わるのは「1枚の壁面が凹んだ」からではなく
  // **見えている壁が別の層のものへ入れ替わった**だけ。連続面の折れ角ではないので描かない）。
  // 隣接列に見えがかり壁が無い場合は従来どおり「そこで壁が終わる」＝描く。
  // **手前の切断壁に切られてこの列だけ分割された帯の側縁は描かない**（ユーザー明示指示
  // 2026-08その17「「6」D1・B: 腰壁上のエッジは不要」）。腰壁の天端で始まる帯は、
  // その列で腰壁に遮られたぶんだけ下端が持ち上がった**同じ壁の続き**であり、隣接列では
  // 1本の大きな帯（あるいは別の見え方）になる。ここで側縁を描くと、腰壁の上に壁の切れ目が
  // 無いのに縦線が出る。
  //
  // 判定は「**帯の下端が、その列の切断壁の天端にちょうど一致する**」——それが「切断壁に
  // 切られて持ち上がった」ということの定義そのもの。以前は`hiddenByCutWall(col, band.z0)`
  // ＝「天端が帯の下端以上の切断壁がこの列にあるか」で見ていたが、これは**切断壁より下に
  // ある帯まで巻き込む**（実機「5」A: 1階の壁の帯z0..2400が、その上に立つ2階X2壁の断面
  // z2400..5400のせいで「切られた」と判定され、X2右側の壁エッジが丸ごと消えていた）。
  // 切断壁はそれ自身のz範囲でしか遮らない。
  const splitByCutWall = col.bands.some(b =>
    b.kind === 'cut' && Math.abs(b.z1 - band.z0) < GAP_EPS);
  // **ただし隣接列がアキ（open）なら、そこで壁面は本当に終わっている**——「切られて
  // 持ち上がっただけ」と言えるのは、その先で壁面が何らかの形で続いているとき。アキは
  // 「その面の平面に壁が無い」ことそのものなので、境界の縦線が要る（ユーザー実機指摘
  // 2026-08「「5」B: 2階Y1から2000と3500のCLにエッジが描画されない」）。
  // 隣接列がスラブ等の別の見え方になるだけの場合は従来どおり抑止する（その17「6」D1）。
  const endsAtGap = nb => !!nb && nb.bands.some(x => isOpenLikeBand(x) && overlapsZ(x, band));
  // **面の端でもその17は効かせない**（ユーザー実機指摘2026-09「「6」D2: 2階Y2から3500には
  // 「21」の壁エッジが左側に見える」）——その17の前提「隣接列で同じ壁が1本の帯として続く」は
  // 隣接列が無い＝探査範囲の外である面の端では成立しない。端に壁が有るかどうかの答えは
  // `emitCtx.openEndLo/Hi`（face.hasWallAtLocal0/Run）が既に持っており、それが唯一の情報源。
  // 判定に`!prev`だけを使うと不足する——探査は面の外まで延ばされることがあり（cutDrawRange
  // のprobeExtendLo/HiMm）、最終列が面の端より内側にある合成入力では従来どおり抑止したい
  // （その17の実機「6」D1）。**列の端が面の端に一致する**ことまで見る。
  const { loX: faceLoX, hiX: faceHiX } = faceRangeX(cut);
  const atFaceEndLo = !prev && Math.abs(col.x0 - faceLoX) < GAP_EPS;
  const atFaceEndHi = !next && Math.abs(col.x1 - faceHiX) < GAP_EPS;
  const wholeBand = [{ z0: band.z0, z1: band.z1 }];
  const wallExtent = wallExtentAcrossMembers(col, band); // 梁の断面で上下に分かれた壁の帯をつないだ範囲（無ければ null）
  // 面端の隅で建具断面を描く建具の開口範囲（emitCtx.cornerOpeningZLo/Hi。面図の面端の太線と
  // 同じ入力＝buildSectionFromLine の ends）では面端の凹み側面線を描かない（ユーザー指摘
  // 2026-10-13「建具上から床までは不要」）。適用は面の端の列（atFaceEndLo/Hi）だけ。
  const minusCornerOpenings = (ranges, holes) =>
    (holes ?? []).reduce((rs, h) => subtractZ(rs, h), ranges);
  const loBase = (splitByCutWall && !endsAtGap(prev) && !atFaceEndLo) ? []
    : prev ? uncoveredZRanges(prev, band, 'prev', wallExtent, cut) : (emitCtx.openEndLo ? [] : wholeBand);
  const loRanges = atFaceEndLo ? minusCornerOpenings(loBase, emitCtx.cornerOpeningZLo) : loBase;
  // 斜めの天端の帯は、端の縦線を**その端での天端の高さ**までにする（帯の上端 z1 は高い側の値）。
  for (const r of loRanges) {
    const x = wallEndXAt(columns, i, -1, r.z0, col.x0);
    const zTop = band.topEdge ? Math.min(r.z1, band.topEdge.zAtX0) : r.z1;
    if (zTop - r.z0 <= GAP_EPS) continue;
    prims.push(Object.assign(emitLine(cut, x, r.z0, x, zTop, role, { ceilZ }),{__o:'recessLo'}));
  }
  const hiBase = (splitByCutWall && !endsAtGap(next) && !atFaceEndHi) ? []
    : next ? uncoveredZRanges(next, band, 'next', wallExtent, cut) : (emitCtx.openEndHi ? [] : wholeBand);
  const hiRanges = atFaceEndHi ? minusCornerOpenings(hiBase, emitCtx.cornerOpeningZHi) : hiBase;
  for (const r of hiRanges) {
    const x = wallEndXAt(columns, i, +1, r.z0, col.x1);
    const zTop = band.topEdge ? Math.min(r.z1, band.topEdge.zAtX1) : r.z1;
    if (zTop - r.z0 <= GAP_EPS) continue;
    prims.push(Object.assign(emitLine(cut, x, r.z0, x, zTop, role, { ceilZ }),{__o:'recessHi'}));
  }
  // 腰壁の端部抑え（仕様2026-08「追加したい腰壁の仕様」）: 天端の帯は壁が終わる端でも
  // 見えるので、その端に**帯の見付ぶん内側の細線**を足す（端の中線は上の凹み側面線が
  // 既に描いている＝帯の外形2本のうち内側の1本だけがここの責務。天端の水平線と
  // その下端＝kneeCapUnderline と対になる）。
  // 描く端は「その壁がそこで実際に終わる端」だけ——隣接列が有る（＝探査範囲の内側）
  // かつ帯の全高が覆われていない端。次の2つは対象外で、どちらも条件から自然に落ちる:
  //   - 面の端（隣接列が無い）… そこは直交壁との取り合いで、腰壁は相手の壁表面まで
  //     行って終わる。その位置の縦線は端部処理が描くため二重にしない。
  //   - 同じ軸上に壁が続く端 … 連続する壁は同じ偏芯・同じ厚みで同面のため
  //     （uncoveredZRangesが空を返す）。
  appendKneeCapEndFaces(prims, cut, col, band, {
    prev, next, loRanges, hiRanges, ceilZ, scale: emitCtx.scale, lineWeightsPx: emitCtx.lineWeightsPx,
  });
}

/**
 * cutAlong（縦断された壁。WP-E5リード裁定・§6.1）の帯: 見付面自体は塗らず輪郭のみ描く。
 */
function emitCutAlongBand(prims, { cut, col, band, prev, next, ceilZ, emitCtx }) {
  // 上端エッジ（腰壁ならtopHeight位置。壁がz途中で終わる場合その上はrayが継続し別kindの
  // bandになる＝band.z1が常に「この壁のこの位置での実際の上端」）はCUT水平線
  // （band全体がbaseFloorZ以下なら降格。'wall'と同じforceDash判定）。
  prims.push(emitLine(cut, col.x0, band.z1, col.x1, band.z1, ElevationLineRole.CUT,
    { ceilZ, forceDash: bandFullyBeyond(cut, band, ceilZ) }));
  // 腰壁の天端（仕様2026-08）: 上端が天井より下で終わる＝天端が露出している帯だけ、
  // 帯の下端を細線で足す（垂れ壁は下端が露出するので z1 は天井に一致し、ここは通らない）。
  if (band.isKneeDrop && band.z1 < (col.ceilZ ?? ceilZ ?? Infinity) - GAP_EPS) {
    prims.push(...kneeCapUnderline(cut, col.x0, col.x1, band.z1, band.z0, ceilZ, emitCtx, weightForRole(ElevationLineRole.CUT)));
  }
  // 端部縦線: 壁のx方向の実際の端（隣接列に同じcutAlong壁が続かない側）にCUT縦線
  // （壁の実端の断面。§5.5の凹み側面線と同じ「隣接列と比較」パターンだが、cutAlongは
  // 塗り分けを持たないため常にCUT——壁が存在しない側=open端という区別を線種に反映する
  // 必要が無い、壁の実端そのものを示す線のため）。
  const prevAlong = matchingBand(prev, band.z0, band.z1, 'cutAlong');
  if (!prevAlong) {
    prims.push(Object.assign(emitLine(cut, col.x0, band.z0, col.x0, band.z1, ElevationLineRole.CUT, { ceilZ }),{__o:'cutEdgeLo'}));
  }
  const nextAlong = matchingBand(next, band.z0, band.z1, 'cutAlong');
  if (!nextAlong) {
    prims.push(Object.assign(emitLine(cut, col.x1, band.z0, col.x1, band.z1, ElevationLineRole.CUT, { ceilZ }),{__o:'cutEdgeHi'}));
  }
}

/**
 * 遠側の床・天井の見えがかり（farFloorZ/farCeilZ を持つ open の帯）の水平線。
 */
function emitFarOpenBand(prims, { cut, col, band, ceilZ, sightRole }) {
  // Phase4（水平面ヒットの見えがかり。裁定済み2026-09-11・既定on）: `sectionEngine.js`の
  // `splitOpenByFarFace`が深度上限内のときだけfarFloorZ/farCeilZを付与する。
  // 設計§5.5「その z に見えがかりの水平線を描く」「線種は既存規則に従い、同じ深度の壁面と
  // 同じ重み」: 重みは'wall'帯と同じ`sightRole`（深度→SILHOUETTE/DETAIL）の経路をそのまま使う。
  // **FL・CHの見えがかりは描画しない**規則（'wall'帯と同じ`sectionLevelZs`/`atSectionLevel`
  // ガード）をそのまま流用する——奥の部屋の床・天井がこの帯自身のFL・CHと同値なら（実機
  // knee-drop-test「B」面: 奥室の床0・天井3000がA自身のbaseFloorZ/ceilZと同値）既存の
  // 断面線と重なるため描かない（ユーザー受入基準の「Aの床線／天井線と重なる」＝dedupe）。
  const sectionZs = sectionLevelZs(cut, col, col.ceilZ ?? ceilZ);
  const atSectionLevel = z => sectionZs.some(f => Math.abs(z - f) < GAP_EPS);
  // QA是正2026-09（検算）: 床線・天井線は別々の実体（別々の深度）から出ることがあるため、
  // 重み（sightRole）も床・天井それぞれの深度で決める——`band.farDepthMm`（両者の最小値）を
  // 両方の線に使うと、深い側の線が浅い側の重みを借りてしまう。
  const floorRole = sightRole(band.farFloorDepthMm ?? band.farDepthMm);
  const ceilRole = sightRole(band.farCeilDepthMm ?? band.farDepthMm);
  if (band.farFloorZ != null && !atSectionLevel(band.farFloorZ) && !hiddenByCutWall(col, band.farFloorZ)) {
    prims.push(emitLine(cut, col.x0, band.farFloorZ, col.x1, band.farFloorZ, floorRole, { ceilZ }));
  }
  if (band.farCeilZ != null && !atSectionLevel(band.farCeilZ) && !hiddenByCutWall(col, band.farCeilZ)) {
    prims.push(emitLine(cut, col.x0, band.farCeilZ, col.x1, band.farCeilZ, ceilRole, { ceilZ }));
  }
}

/**
 * 帯に属する梁: slab の帯に添えた梁の見え掛かり（床構造・天井懐の中の梁。U1b B3-2）を emitMemberFaceBand で描き、
 * 梁の断面（memberCut。U1b B3-1）は along を天地の線の区間へ控え、それ以外は最初に現れる列で輪郭を 1 回だけ重ねる。
 */
function emitBandMembers(prims, {
  cut, col, band, prev, next, ceilZ, drawRange, faceSegs, alongSegs, outlined, memberZ,
}) {
  // slab の帯に添えた梁の見え掛かり（床構造・天井懐の中の梁。U1b B3-2）
  for (const piece of band.members ?? []) {
    if (piece.kind === 'member') emitMemberFaceBand(prims, faceSegs, col, piece, { prev, next, cut, drawRange, ceilZ });
  }
  for (const piece of memberPiecesOf(band)) {
    if (piece.along) {
      const segs = alongSegs.get(piece.member) ?? [];
      segs.push({ x0: col.x0, x1: col.x1, z0: piece.z0, z1: piece.z1 });
      alongSegs.set(piece.member, segs);
    } else if (!outlined.has(piece.member)) {
      outlined.add(piece.member);
      const m = piece.member, z = memberZ.get(m);
      const xa = localXOf(cut, m.axisWorld - m.widthMm / 2), xb = localXOf(cut, m.axisWorld + m.widthMm / 2);
      if (z.z1 - z.z0 <= GAP_EPS) continue; // 低い天井の下に梁の断面が残らない
      for (const p of sectionOutline(cut, Math.min(xa, xb), Math.max(xa, xb), z.z1, z.z1 - z.z0, piece.section)) {
        p[MEMBER_PRIM] = true;
        if (piece.whole) p[WHOLE_OUTLINE] = true; // 床なし区間をまたぐ輪郭は線ごとの切り直しから守る（階段帯）
        prims.push(p);
      }
    }
  }
}

/**
 * 列内でz方向に隣接する slab/open 帯の境界（above層の床の端）の SILHOUETTE 水平線（WP-E5b追加）。
 */
function emitFloorEdgeLines(prims, { cut, col, sectionSlabs, ceilZ }) {
  for (let i = 0; i + 1 < col.bands.length; i++) {
    const a = col.bands[i], b = col.bands[i + 1];
    // 梁の断面（memberCut）は後ろの帯の種類（behind）で見る——梁は床スラブ⇄アキの境界の線を変えない
    const effKind = x => ((x.kind === 'memberCut' || x.kind === 'member') ? (x.behind ?? x.kind) : x.kind);
    const aIsFloorEdge = (effKind(a) === 'slab' || effKind(a) === 'open');
    const bIsFloorEdge = (effKind(b) === 'slab' || effKind(b) === 'open');
    // 階段室の最初の壁（viaStair）は手前の空気が開いている＝床スラブの端（床の線）は壁の下でも続く。
    const viaStairOnSlab = a.kind === 'slab' && b.kind === 'wall' && b.viaStair;
    if ((aIsFloorEdge && bIsFloorEdge && effKind(a) !== effKind(b)) || viaStairOnSlab) {
      if (!hiddenByCutWall(col, a.z1) && !ownedBySectionSlab(sectionSlabs, col, a.z1)) {
        prims.push(emitLine(cut, col.x0, a.z1, col.x1, a.z1, ElevationLineRole.SILHOUETTE, { ceilZ }));
      }
    }
  }
}

// 同じ奥行きとみなす許容差（梁の nearMm と壁の材の手前の縁。浮動小数の誤差だけ吸収する）
const SAME_DEPTH_EPS_MM = 1e-3;

/**
 * 梁の見え掛かり（member。U1b B3-2）の帯の縁（z 方向の隣との境）を引く線種。引かないなら null。
 * 手前奥は手前の面までの奥行きで見る: 隣が壁なら、梁のほうが手前なら梁の線種（memberClass: facePlane→DETAIL・airborne→SILHOUETTE）、
 * 同じ奥行きは DETAIL（規則 1「同じ奥行きで実体の違う member 帯と wall 帯の境は DETAIL」。無いと壁面と同じ面の梁型の縁が消える）、
 * 壁のほうが手前なら壁の側が引く。切断壁（cut・cutAlong）が隣でも梁の線を引く（R6。切断壁は水平の縁を持たない）。
 * 断面の梁（memberCut）・描かない実体（hidden）が隣なら引かない。
 * アキ・床構造・遠側の面の向こう（farVoid）・梁の無い所が隣なら、梁の外形として引く。
 */
function memberEdgeRole(cut, band, neighbor, baseRole) {
  if (!neighbor) return baseRole;
  // 同じ梁が隣の z にも続くなら（slab の帯に添えた片と、梁が無ければ open だった帯へ分かれた片など）境の線は引かない
  if (neighbor.kind === 'slab' && (neighbor.members ?? []).some(p => p.kind === 'member' && p.member === band.member)) return null;
  switch (neighbor.kind) {
    case 'hidden': case 'memberCut': return null;
    // 切断壁（cut・cutAlong）が上下に接する境は、壁の断面の縁（その壁は縦の縁しか持たない＝水平の縁は引かない）と梁の面の境＝梁の線を引く
    // （R6: 壁の縁を描く。加算の見え掛かりも梁の天地を切断壁の上でも通していた）
    case 'cut': case 'cutAlong': return baseRole;
    // 別の梁が隣なら、手前の梁がその境の輪郭を持つ（奥の梁は引かない）。同じ奥行きは両方が引く（同じ線は dedupe で 1 本）
    case 'member': return neighbor.member === band.member ? null
      : (Number.isFinite(neighbor.distMm) && Number.isFinite(band.distMm) && neighbor.distMm < band.distMm - SAME_DEPTH_EPS_MM ? null : baseRole);
    case 'wall': {
      const w = faceNearMm(cut, neighbor);
      if (w === null || !Number.isFinite(band.distMm)) return baseRole;
      if (Math.abs(w - band.distMm) <= SAME_DEPTH_EPS_MM) return ElevationLineRole.DETAIL;
      return band.distMm < w ? baseRole : null;
    }
    default: return baseRole;
  }
}

/**
 * 梁の見え掛かり（member）の帯 1 つ分の描画。天地の線は区間として faceSegs へ貯め（`memberFaceHorizontals` が梁ごとにまとめて引く）、
 * 左右の縦線はここで引く。描くのは切断線の描画範囲の中だけ。
 *  - 天地の線: 隣（z 方向）が梁より手前の実体でなければ（`memberEdgeRole`）。
 *  - 縦線: 面の通りの梁（facePlane）だけ、梁の元の端（スパンの両端）の列の端に、同じ梁の帯が続かない高さへ DETAIL で。空中の梁（airborne）は
 *    縦線を持たない。梁の端でなくても、隣の列の壁の帯と同じ奥行きで接する高さには DETAIL の縦線（規則 1）。
 * 線には出所の印（MEMBER_PRIM）を付ける。
 */
export function emitMemberFaceBand(prims, faceSegs, col, band, { prev, next, cut, drawRange, ceilZ }) {
  // 柱（column。U1b B3-3）は梁の facePlane と同じ仕組みで、線種は中線（R1。柱型は切断面ではなく室内に出た仕上げ面の見えがかり）
  const baseRole = band.memberClass === 'airborne' || band.memberClass === 'column' ? ElevationLineRole.SILHOUETTE
    : (band.memberClass === 'facePlane' ? ElevationLineRole.DETAIL : null);
  if (!baseRole) return; // memberClass 不明は描かない
  const isColumn = band.memberClass === 'column';
  const xa = Math.max(col.x0, drawRange.lo), xb = Math.min(col.x1, drawRange.hi);
  if (xb - xa <= GAP_EPS) return;
  const segs = faceSegs.get(band.member) ?? [];
  faceSegs.set(band.member, segs);
  // 柱の天地は床・天井の断面線（FL・CH）の高さには引かない（その位置に断面線が既にある。壁の見えがかりの水平線と同じ規約）
  const levelZs = isColumn ? sectionLevelZs(cut, col, col.ceilZ ?? ceilZ) : [];
  for (const [z, dir] of [[band.z0, -1], [band.z1, 1]]) {
    if (levelZs.some(f => Math.abs(z - f) < GAP_EPS)) continue;
    const role = memberEdgeRole(cut, band, siblingPieceAt(col, band, z, dir) ?? neighborBandAt(col, z, dir), baseRole);
    if (role) segs.push({ z, role, x0: xa, x1: xb });
  }
  const m = band.member;
  const endXs = isColumn
    ? (cut.line.isVertical ? [m.yLo, m.yHi] : [m.xLo, m.xHi]).map(v => localXOf(cut, v))
    : [localXOf(cut, m.spanLo), localXOf(cut, m.spanHi)];
  for (const [nbCol, x] of [[prev, col.x0], [next, col.x1]]) {
    if (x < drawRange.lo - GAP_EPS || x > drawRange.hi + GAP_EPS) continue;
    // 同じ梁の帯が隣の列に続く高さは縦線なし
    let rest = [{ z0: band.z0, z1: band.z1 }];
    for (const nb of nbCol?.bands ?? []) {
      if (nb.kind === 'member' && nb.member === m) rest = subtractZ(rest, nb);
      for (const p of nb.members ?? []) if (p.kind === 'member' && p.member === m) rest = subtractZ(rest, p); // slab の帯に添えた片
    }
    rest = rest.filter(r => r.z1 - r.z0 > GAP_EPS);
    if (rest.length === 0) continue;
    const realEnd = (band.memberClass === 'facePlane' || isColumn) && endXs.some(e => Math.abs(e - x) <= COORD_EPS_MM);
    for (const r of rest) {
      if (realEnd) {
        // 縦線は上から下へ（加算の parallel の両端の縦線と同じ向き）。柱は同じ x の縦線を帯の分かれ目をまたいで 1 本に繋ぐ（memberFaceHorizontals）
        if (isColumn) segs.push({ v: true, x, za: r.z0, zb: r.z1, role: baseRole });
        else prims.push(Object.assign(emitLine(cut, x, r.z1, x, r.z0, baseRole), { [MEMBER_PRIM]: true }));
        continue;
      }
      // 梁の端でない境（壁が手前に立ち始める・別の帯へ替わる）: 同じ奥行きの壁の帯と接する高さだけ DETAIL（規則 1）
      for (const nb of nbCol?.bands ?? []) {
        if (nb.kind !== 'wall' || !overlapsZ(nb, r)) continue;
        const w = faceNearMm(cut, nb);
        if (w === null || Math.abs(w - band.distMm) > SAME_DEPTH_EPS_MM) continue;
        const z0 = Math.max(r.z0, nb.z0), z1 = Math.min(r.z1, nb.z1);
        prims.push(Object.assign(emitLine(cut, x, z1, x, z0, ElevationLineRole.DETAIL), { [MEMBER_PRIM]: true }));
      }
    }
  }
}

/**
 * 梁の見え掛かりの天地の線（水平）。同じ梁・同じ z・同じ線種の隣り合う列の区間を 1 本につないで引く。
 * @param {Map<object, Array<{z:number, role:string, x0:number, x1:number}>>} faceSegs
 * @param {import('./sectionTypes.js').SectionCut} cut
 * @returns {object[]}
 */
function memberFaceHorizontals(faceSegs, cut) {
  const out = [];
  const r3 = v => Math.round(v * 1000) / 1000;
  for (const allSegs of faceSegs.values()) {
    // 柱の縦線（v:true）: 同じ x の縦線は z の区間をつないで上から下へ 1 本
    const vByX = new Map();
    for (const s of allSegs.filter(q => q.v)) {
      const key = `${r3(s.x)}|${s.role}`;
      if (!vByX.has(key)) vByX.set(key, []);
      vByX.get(key).push(s);
    }
    for (const list of vByX.values()) {
      list.sort((a, b) => a.za - b.za);
      let cur = { ...list[0] };
      // 下から上へ（加算の柱型 structuralColumnPrimitivesForCut の縦線と同じ向き）
      const flushV = () => out.push(Object.assign(emitLine(cut, cur.x, cur.za, cur.x, cur.zb, cur.role), { [MEMBER_PRIM]: true }));
      for (const s of list.slice(1)) {
        if (s.za <= cur.zb + GAP_EPS) { cur.zb = Math.max(cur.zb, s.zb); continue; }
        flushV();
        cur = { ...s };
      }
      flushV();
    }
    const segs = allSegs.filter(q => !q.v);
    const byKey = new Map();
    for (const s of segs) {
      const key = `${r3(s.z)}|${s.role}`;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(s);
    }
    for (const list of byKey.values()) {
      list.sort((a, b) => a.x0 - b.x0);
      let cur = { ...list[0] };
      const flush = () => out.push(Object.assign(emitLine(cut, cur.x0, cur.z, cur.x1, cur.z, cur.role), { [MEMBER_PRIM]: true }));
      for (const s of list.slice(1)) {
        if (s.x0 <= cur.x1 + GAP_EPS) { cur.x1 = Math.max(cur.x1, s.x1); continue; }
        flush();
        cur = { ...s };
      }
      flush();
    }
  }
  return out;
}

/**
 * 切断線の帯の中を通る梁（memberCut の along）の天地の線（DETAIL）。同じ梁・同じ z の隣り合う列は 1 本にまとめて引く
 * （列の分割で線が割れない）。両端の縦線は、まとめた区間の端が**梁の元の端**（スパンの両端）に一致するときだけ（柱包み・
 * 壁の足元で途切れた端には引かない）。加算の parallel（`structuralPrimitivesForCut`）と同じ線種・同じ出し方。
 * @param {Map<object, Array<{x0:number, x1:number, z0:number, z1:number}>>} alongSegs - 梁 → 列ごとの区間
 * @param {import('./sectionTypes.js').SectionCut} cut
 * @returns {object[]}
 */
function memberAlongPrimitives(alongSegs, cut) {
  const prims = [];
  const mark = p => { p[MEMBER_PRIM] = true; return p; };
  const r3 = v => Math.round(v * 1000) / 1000;
  for (const [member, segs] of alongSegs) {
    const ends = [localXOf(cut, member.spanLo), localXOf(cut, member.spanHi)];
    const byZ = new Map();
    for (const s of segs) {
      const key = `${r3(s.z0)}|${r3(s.z1)}`;
      if (!byZ.has(key)) byZ.set(key, []);
      byZ.get(key).push(s);
    }
    for (const group of byZ.values()) {
      const sorted = [...group].sort((a, b) => a.x0 - b.x0);
      const runs = [];
      for (const s of sorted) {
        const last = runs[runs.length - 1];
        if (last && s.x0 <= last.x1 + GAP_EPS) last.x1 = Math.max(last.x1, s.x1);
        else runs.push({ ...s });
      }
      for (const r of runs) {
        prims.push(mark(emitLine(cut, r.x0, r.z1, r.x1, r.z1, ElevationLineRole.DETAIL)));
        prims.push(mark(emitLine(cut, r.x0, r.z0, r.x1, r.z0, ElevationLineRole.DETAIL)));
        for (const x of ends.filter(e => Math.abs(e - r.x0) <= GAP_EPS || Math.abs(e - r.x1) <= GAP_EPS).sort((a, b) => a - b)) {
          prims.push(mark(emitLine(cut, x, r.z1, x, r.z0, ElevationLineRole.DETAIL)));
        }
      }
    }
  }
  return prims;
}

// 完全に同一（type/x1/y1/x2/y2/weight/dash）の線プリミティブを1本にまとめる（WP-E5b追加）。
// sectionProbe.jsがcut.baseFloorZ/ceilZをzBreaksに割り込ませる（§5.6最終フィルタをband内部の
// 一部にも適用できるようにするため）副作用として、同一kindの隣接z区間が「上端／下端」を
// それぞれ独立に描く際、その内部分割の境界ちょうどで同じ水平線が2回出ることがある
// （例: wallの下側区間の上端縁と上側区間の下端縁が同じz=baseFloorZに重なる）——見た目には
// 影響しない冗長プリミティブだが、テスト側の本数アサーションを不安定にするため統合する。
// 長さゼロの線分（isZeroLengthLine）もここで捨てる（QA是正2026-09・B）。
function dedupeLines(prims) {
  const seen = new Set();
  const out = [];
  for (const p of prims) {
    if (isZeroLengthLine(p)) continue;
    const key = p.type === 'line' ? `${p.type}|${p.x1}|${p.y1}|${p.x2}|${p.y2}|${p.weight}|${p.dash ?? ''}` : null;
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    out.push(p);
  }
  return out;
}

/**
 * z-x平面の線分[a,b]（各`[x,z]`）を、`splitZ`（baseFloorZ）で**厳密に内部**を横切る場合だけ
 * 2本へ分割する（展開図一般化Phase 6b-2 C-5）。触れるだけ（両端の一方がちょうどsplitZ）や
 * またがない場合は元の1本のまま返す——ゼロ長の断片を作らないため。
 * 分割点では`a→b`の向きを保ったまま`[a, mid]`・`[mid, b]`の順で返す（呼び出し側の描画順・
 * 既存の座標対応を変えないため）。
 * @param {[number,number]} a - [x,z]
 * @param {[number,number]} b - [x,z]
 * @param {number} splitZ
 * @returns {Array<[[number,number],[number,number]]>} 1件（分割なし）または2件
 */
function splitSegmentAtZ(a, b, splitZ) {
  const [ax, az] = a, [bx, bz] = b;
  const lo = Math.min(az, bz), hi = Math.max(az, bz);
  if (!(splitZ > lo + GAP_EPS && splitZ < hi - GAP_EPS)) return [[a, b]];
  const t = (splitZ - az) / (bz - az);
  const mid = [ax + (bx - ax) * t, splitZ];
  return [[a, mid], [mid, b]];
}

/**
 * 指定のx/z範囲に食い込む**腰壁・垂れ壁**の帯を矩形（y変換済み）で返す。アキのバツのクリップに使う
 * （ユーザー実機指摘2026-08「6」C「バツが、腰壁と交差する場合、腰壁内はクリップして描画しない」）。
 * 対象を「実体の帯すべて」ではなく`isKneeDrop`（腰壁・垂れ壁指定で高さが制限された壁。
 * sectionProbe.jsが付与）に絞るのが要点——実体一般で差し引くと、開口の下の普通の壁まで
 * 対象になり、WP-E7 D1の確認済み仕様「開口が2階アキと連続すると1組の**大きな**X」が
 * 細切れになる（実際にそう作り込んで既存テストが落ちた）。
 * 斜めの天端の帯（`topEdge`。隔て壁）は天端が斜線の台形を遮蔽物にする（`poly`。帯の上端 z1 は高い側の
 * 値なので矩形で見ると斜線の下の空気を壁と誤る）。
 */
function obstructionRects(columns, x0, x1, z0, z1) {
  const rects = [];
  for (const col of columns) {
    if (col.x1 <= x0 + GAP_EPS || col.x0 >= x1 - GAP_EPS) continue;
    for (const b of col.bands) {
      // 梁の断面（memberCut）もバツの線を切り抜く矩形（アキのセルは割らない。階段帯のアキを割らない裁定 R5・部屋帯の断面も同じ）
      if (b.kind === 'memberCut') {
        if (overlapsZ(b, { z0, z1 })) rects.push({ xLo: col.x0, xHi: col.x1, yLo: zToY(b.z1), yHi: zToY(b.z0) });
        continue;
      }
      if (!(b.isKneeDrop || b.topEdge) || b.openingPassThrough) continue;
      if (!overlapsZ(b, { z0, z1 })) continue;
      const rect = { xLo: col.x0, xHi: col.x1, yLo: zToY(b.z1), yHi: zToY(b.z0) };
      if (b.topEdge) {
        rect.poly = [[col.x0, zToY(b.z0)], [col.x1, zToY(b.z0)],
          [col.x1, zToY(b.topEdge.zAtX1)], [col.x0, zToY(b.topEdge.zAtX0)]];
      }
      rects.push(rect);
    }
  }
  return rects;
}

/**
 * アキのバツ（`emitOpenGapMarks`が出す一点鎖線の対角線）のうち、**手前の実体に隠れる区間だけを
 * 破線へ落とす**（ユーザー実機指摘2026-08「6」C「但し、階段に隠れる部分は破線」）。
 * 破線の範囲は**何かの基準線の左右では決まらない**（同指摘の撤回・再指示「想定したバツに対して
 * 描画面+所定距離までレイキャストして、隠れた部分を破線にする」）——渡す矩形は手前に実体が
 * 存在する範囲そのもの（`stairFaceOccluderRects`）で、対角線とその重なりを取るだけ。
 * 対象は`dash:'center'`の斜め線だけ——既に`dashed`のもの（床断面より下のアキ）や水平・垂直線は
 * そのまま通す。区間ごとに線分を分割して積み直すため、1本のバツが複数の線分になる。
 * @param {object[]} prims - emitOpenGapMarksの出力（他のプリミティブが混ざっていてもよい）
 * @param {Array<{xLo:number, xHi:number, zLo:number, zHi:number}>} rects - 階段の見付け矩形
 * @returns {object[]}
 */
export function splitGapMarksByStair(prims, rects) {
  if (!rects?.length) return prims;
  const boxes = rects.map(r => ({
    xLo: Math.min(r.xLo, r.xHi), xHi: Math.max(r.xLo, r.xHi),
    yLo: zToY(Math.max(r.zLo, r.zHi)), yHi: zToY(Math.min(r.zLo, r.zHi)),
  }));
  const out = [];
  for (const p of prims) {
    const isDiagonal = p.type === 'line' && p.dash === ElevationDash.CENTER
      && Math.abs(p.x1 - p.x2) > GAP_EPS && Math.abs(p.y1 - p.y2) > GAP_EPS;
    if (!isDiagonal) { out.push(p); continue; }
    const hidden = mergeIntervals(boxes
      .map(b => segmentInsideRect(p.x1, p.y1, p.x2, p.y2, b))
      .filter(Boolean));
    if (hidden.length === 0) { out.push(p); continue; }
    const at = t => ({ x: p.x1 + (p.x2 - p.x1) * t, y: p.y1 + (p.y2 - p.y1) * t });
    const push = (t0, t1, dash) => {
      if (t1 - t0 <= FLOAT_EPS) return;
      const a = at(t0), b = at(t1);
      out.push({ ...p, x1: a.x, y1: a.y, x2: b.x, y2: b.y, dash });
    };
    let cursor = 0;
    for (const [h0, h1] of hidden) {
      push(cursor, h0, ElevationDash.CENTER);   // 見えている区間
      push(h0, h1, ElevationDash.DASHED);       // 階段に隠れる区間
      cursor = h1;
    }
    push(cursor, 1, ElevationDash.CENTER);
  }
  return out;
}

/**
 * 見えがかりの**水平線**のうち、手前の階段（flightの見付け矩形）に隠れる区間を破線にする
 * （ユーザー実機指摘2026-08「6」C「1FL天井線は、左壁断面から復路左のささらまで。その先は
 * 袋階段に隠れて見えなくなるが、アキ・バツのために破線で右側壁断面線まで」）。
 * 対象はSILHOUETTE（中線）の実線水平線だけ。矩形の**z範囲の内側に厳密に入る**ものに限る
 * ——ちょうど上端・下端に載る線（例: 2FL線が復路の昇り切り高さと一致する）は階段に隠れて
 * いるのではなく縁で接しているだけなので対象外。
 * @param {object[]} prims
 * @param {Array<{xLo:number, xHi:number, zLo:number, zHi:number}>} rects
 */
export function dashHorizontalsBehindStair(prims, rects) {
  if (!rects?.length) return prims;
  const out = [];
  for (const p of prims) {
    const isTarget = p.type === 'line' && p.weight === weightForRole(ElevationLineRole.SILHOUETTE)
      && !p.dash && Math.abs(p.y1 - p.y2) < GAP_EPS;
    if (!isTarget) { out.push(p); continue; }
    const z = -p.y1;
    const xLo = Math.min(p.x1, p.x2), xHi = Math.max(p.x1, p.x2);
    const hidden = mergeIntervals(rects
      .filter(r => z > Math.min(r.zLo, r.zHi) + GAP_EPS && z < Math.max(r.zLo, r.zHi) - GAP_EPS)
      .map(r => [Math.max(xLo, Math.min(r.xLo, r.xHi)), Math.min(xHi, Math.max(r.xLo, r.xHi))])
      .filter(([a, b]) => b - a > GAP_EPS));
    if (!hidden.length) { out.push(p); continue; }
    const seg = (a, b, dash) => {
      if (b - a <= GAP_EPS) return;
      out.push(dash ? { ...p, x1: a, x2: b, dash } : { ...p, x1: a, x2: b });
    };
    let cursor = xLo;
    for (const [h0, h1] of hidden) { seg(cursor, h0, null); seg(h0, h1, ElevationDash.DASHED); cursor = h1; }
    seg(cursor, xHi, null);
  }
  return out;
}

// polyline（階段の断面プロファイル）が高さzを横切るローカルxのうち、最初に見つかるもの（無ければnull）。
function profileXAtZ(points, z) {
  const y = zToY(z);
  for (let i = 0; i + 1 < points.length; i++) {
    const [x1, y1] = points[i], [x2, y2] = points[i + 1];
    const lo = Math.min(y1, y2), hi = Math.max(y1, y2);
    if (y < lo - GAP_EPS || y > hi + GAP_EPS) continue;
    if (Math.abs(y2 - y1) < GAP_EPS) return Math.min(x1, x2); // 水平区間はその始点
    return x1 + (x2 - x1) * ((y - y1) / (y2 - y1));
  }
  return null;
}

/**
 * 階段のささらの見えがかり（DETAILのpolyline）か（展開図一般化Phase 6b-2 設計(d)で単一情報源化。
 * 元は`clipStairDetailInSlabBand`内のローカル関数だったが、P2（`sectionStair.js`の
 * `stairPrimitivesForCut`が「断面内部は描かない」一般判定で同じ述語を使う）のためexportする）。
 * @param {object} p
 * @returns {boolean}
 */
export function isStringer(p) {
  return p.type === 'polyline' && p.weight === weightForRole(ElevationLineRole.DETAIL) && p.points?.length > 1;
}

/**
 * 階段の断面プロファイル（CUTのpolyline）との取り合いを作る
 * （ユーザー実機指摘2026-08「6」D2）。
 *   1. **1F天井断面線は階段断面との交点で終える**（「1F天井断面線が右に進み、天井厚と階段断面
 *      との交点で終了」）——旧はスラブ帯の切れる列境界で止まっており、階段の手前で宙に終わっていた。
 *   2. **2FLで終わっている階段断面線から2FLの床断面線を張り出す**（「2FLで終了している階段断面線を
 *      2FLはねだしまで」）——階段が上り切った先の床が、そこから外側へ続くことを示す線。
 * どちらもプロファイルの実座標から求める（面やレーンの幾何を作図側で再構成しない）。
 * @param {object[]} wallContent - emitColumns等の出力（この配列は変更せず新しい配列を返す）
 * @param {object[]} stairContent - stairPrimitivesForCutの出力
 * @param {import('./sectionTypes.js').SectionCut} cut
 * @param {{ceilLowAbs:number, floorHeight:number, drawLo:number, drawHi:number}} ref
 */
export function joinToStairProfile(wallContent, stairContent, cut, ref) {
  const profile = stairContent.find(p =>
    p.type === 'polyline' && p.weight === weightForRole(ElevationLineRole.CUT) && p.points?.length > 1);
  if (!profile) return wallContent;
  const out = wallContent.map(p => ({ ...p }));

  // 1. 1F天井断面線を階段断面との交点まで伸ばす。
  const meetX = profileXAtZ(profile.points, ref.ceilLowAbs);
  if (meetX != null) {
    for (const p of out) {
      if (p.type !== 'line' || Math.abs(p.y1 - p.y2) > GAP_EPS) continue;
      if (Math.abs(-p.y1 - ref.ceilLowAbs) > GAP_EPS) continue;
      const lo = Math.min(p.x1, p.x2), hi = Math.max(p.x1, p.x2);
      if (meetX > hi + GAP_EPS) { p.x1 = lo; p.x2 = meetX; }        // 右へ伸ばす
      else if (meetX < lo - GAP_EPS) { p.x1 = meetX; p.x2 = hi; }   // 左へ伸ばす
    }
  }

  // 2. 階段断面の上り切り（2FL）から床断面線を外側へ張り出す。
  const top = profile.points.reduce((a, b) => (-b[1] > -a[1] ? b : a));
  if (Math.abs(-top[1] - ref.floorHeight) < GAP_EPS) {
    const toLo = Math.abs(top[0] - ref.drawLo) <= Math.abs(ref.drawHi - top[0]);
    const endX = toLo ? ref.drawLo : ref.drawHi;
    if (Math.abs(endX - top[0]) > GAP_EPS) {
      out.push(emitLine(cut, top[0], ref.floorHeight, endX, ref.floorHeight,
        ElevationLineRole.SILHOUETTE, { ceilZ: cut.zRange?.hiZ }));
    }
  }
  return out;
}

// 列 [x0,x1] のアキのセルの x 区間とその下端（床の断面線 profile〔階段帯。折れ線〕から）。
// 断面線が無い・列の中で平らな区間と斜めの区間が混ざらない（全部平ら／全部斜め）ときは従来どおり列全体 1 区間で下端は列内の最大値。
// 平らな区間（踊り場）と斜めの区間（階段の段）が混ざる列は、**平らな区間だけ**を、その実の床の高さを下端とする区間にする
// （踊り場の始まり＝平らな区間の左端がセルの左端になる。隣り合う同じ高さの平らな区間は 1 つに繋ぐ）。斜めの区間は階段の本体として
// セルにしない。区間は列を割らずセルだけを割る。
function floorPiecesOf(profile, x0, x1) {
  const whole = [{ xa: x0, xb: x1, fz: drawnFloorProfileZMax(profile, x0, x1) }];
  if (!profile?.length) return whole;
  const xs = [x0, ...profile.map(p => p[0]).filter(x => x > x0 + GAP_EPS && x < x1 - GAP_EPS), x1].sort((a, b) => a - b);
  const subs = [];
  for (let i = 0; i + 1 < xs.length; i++) {
    const a = xs[i], b = xs[i + 1];
    if (b - a <= GAP_EPS) continue;
    // 区間の端は垂直の段差（蹴上）の上で値が 2 つになるので、端のわずか内側の値で平らかを見る
    const t = (b - a) * 1e-3;
    const za = drawnFloorProfileZAt(profile, a + t), zb = drawnFloorProfileZAt(profile, b - t), zc = drawnFloorProfileZAt(profile, (a + b) / 2);
    subs.push({ xa: a, xb: b, fz: zc, flat: Math.max(za, zb, zc) - Math.min(za, zb, zc) <= COORD_EPS_MM });
  }
  if (!subs.some(s => s.flat) || subs.every(s => s.flat)) return whole;
  const out = [];
  for (const s of subs) {
    if (!s.flat) continue;
    const last = out[out.length - 1];
    if (last && Math.abs(last.xb - s.xa) <= GAP_EPS && Math.abs(last.fz - s.fz) <= COORD_EPS_MM) last.xb = s.xb;
    else out.push({ xa: s.xa, xb: s.xb, fz: s.fz });
  }
  return out;
}

// x範囲 [x0,x1] を、梁（rects）の x の端で区間に分ける（梁が無い・端が範囲の外なら [[x0,x1]] のまま）。
function splitXByBeams(x0, x1, rects) {
  const cuts = rects.flatMap(r => [r.xLo, r.xHi]).filter(x => x > x0 + GAP_EPS && x < x1 - GAP_EPS)
    .sort((a, b) => a - b);
  const xs = [x0, ...cuts.filter((x, i) => i === 0 || x - cuts[i - 1] > GAP_EPS), x1];
  return xs.slice(0, -1).map((x, i) => [x, xs[i + 1]]);
}

// 区間 [xa,xb] を全幅で覆う梁の z 範囲を [z0,z1] から引いた残り（z昇順）。
function subtractBeamZ(z0, z1, xa, xb, rects) {
  const covering = rects.filter(r => r.xLo <= xa + GAP_EPS && r.xHi >= xb - GAP_EPS)
    .sort((a, b) => a.zLo - b.zLo);
  const out = [];
  let cursor = z0;
  for (const r of covering) {
    if (r.zLo - cursor > GAP_EPS) out.push([cursor, Math.min(r.zLo, z1)]);
    cursor = Math.max(cursor, r.zHi);
  }
  if (z1 - cursor > GAP_EPS) out.push([cursor, z1]);
  return out.filter(([a, b]) => b - a > GAP_EPS);
}

/**
 * SectionColumn[] → アキのX（対角線2本。AMBIGUITY E）のプリミティブ列。
 * kind==='open' の band（ただし openingPassThrough:true が付いたものは除く。下記）を
 * 「アキ扱い」とみなし、列をまたいでz範囲が重なるもの同士を連結成分としてまとめてから
 * 1組ずつXを描く。
 * @param {import('./sectionTypes.js').SectionColumn[]} columns
 * @param {import('./sectionTypes.js').SectionCut} cut
 * `cut.openGapMarks === false` の切断は標記しない（空配列。ユーザー指示2026-10-07「踊場、回転部に
 * 『アキ』は不要」——折返し階段の踊り場前縁の切断 seq1/seq3。階段の他の面・通常の面は従来どおり）。
 * これに伴い、以下の「6」C のバツに関する旧裁定（2026-08/09）のうち**階段の seq1/seq3 の面**に
 * 関するものは撤回済み（一般規則としては他の面で有効）。
 * @param {{ceilZ?:number, gapFloorProfile?:Array<[number,number]>|null}} [emitCtx]
 *   gapFloorProfile … 断面線。あればアキのセルの下限をこの輪郭へ持ち上げる（階段帯のみが渡す。
 *   2026-10-08裁定「断面が完結しており、その外側（階段下等）は描画しない」）。null・省略は下限なし。
 *   gapBeamRects … 手前に見える梁の矩形（面ローカルx×絶対z。`{xLo,xHi,zLo,zHi,split}`）。split:true（面の平面上・空中の梁）は
 *   アキのセルから抜く（梁の上下で別のアキ）、false（断面）はバツの線を切り抜くだけ。部屋帯のみが渡す。省略は梁なし。
 * @returns {object[]}
 */
export function emitOpenGapMarks(columns, cut, emitCtx = {}) {
  if (cut?.openGapMarks === false) return [];
  const ceilZ = emitCtx.ceilZ;
  // **床断面の延長端（壁のない端部のはね出し）にはアキを描かない**（ユーザー明示指示2026-08
  // 「床断面延長端に『アキ・バツ』は描画不要」）——延長は「線を図の外へ延ばす」ために探査範囲を
  // 広げたぶんで、そこは面の外。面の外に「その面に壁が無い」という標記を出す意味がない。
  // 面自身の範囲は`cut.line.lo/hi`（探査延長`probeExtendLo/HiMm`を含まない値）で決まる。
  // **実画面で「ア キ」を置けない幅の区間には、アキ標記そのものを出さない**（ユーザー実機指摘
  // 2026-08「「5」C2: 1階400の『アキ・バツ』が省略されない」）——壁2段書きの省略判定と同じ考え方。
  // scale（px/mm）未指定（単体テスト・ゴールデン）では判定せず従来どおり全て描く。
  const minGapWidthMm = emitCtx.scale ? GAP_LABEL_WIDTH_PX / emitCtx.scale : 0;
  const { loX: faceLoX, hiX: faceHiX } = faceRangeX(cut);
  const beamRects = emitCtx.gapBeamRects ?? [];  const splitRects = beamRects.filter(r => r.split);
  const cells = collectOpenGapCells(columns, { faceLoX, faceHiX, gapFloorProfile: emitCtx.gapFloorProfile, splitRects });
  const merged = mergeGapCells(cells);
  const groups = groupGapCells(merged);
  return emitGapGroups(groups, { cut, columns, ceilZ, minGapWidthMm, beamRects });
}

/**
 * アキ扱いの帯（open・開口貫通でない・切断壁の天端の上でない・階段室越しでない）を、面の範囲に収まる矩形セルへ集める。
 * 断面線（gapFloorProfile）があれば下限を持ち上げ、手前の梁（splitRects）の上下でセルを分ける。
 * @returns {object[]} cells
 */
function collectOpenGapCells(columns, { faceLoX, faceHiX, gapFloorProfile, splitRects }) {
  const cells = [];
  columns.forEach((col, colIndex) => {
    for (const b of col.bands) {
      // **切断壁（面を横切る壁）の天端の上の空気は「その面のアキ」ではない**——アキはその面の
      // 平面に壁が無い範囲の標記であって、直交する壁を越えた先の空間はこの面の穴ではない。
      // これを混ぜると、連結成分が腰壁の断面の厚みの中へ食い込み、バツの端点が壁の断面の
      // 手前の縁×天端の位置に落ちる（ユーザー実機指摘2026-08「「5」D1: 2階のバツが、
      // Y1から2000CL側、開口端部を正しく拾っていない」）。
      // **面の平面にある腰壁の天端の上（＝本当のアキ）は下が'wall'帯なので影響しない**
      // ——「6」Cの「バツ左下点は左側壁断面と腰壁上端の交点へ」はそちらの構成で、従来どおり。
      const overCutWall = col.bands.some(x => x.kind === 'cut' && Math.abs(x.z1 - b.z0) < GAP_EPS);
      // **建具の開口はアキ扱いにしない**（ユーザー明示指示2026-09「建具の姿の前に『バツ』不要」）
      // ——そこは建具の姿図が描く場所であり「アキ」ではない。開口をアキのセルに入れると、
      // 真上の上階アキと連結して1つの塊になり、その塊の対角＝バツが姿図の上を通ってしまう
      // （旧仕様「開口が2階アキと連続する場合の1つの大きなX」＝defer D1。本指示で廃止）。
      // 上階アキ自身は開口を外しても単独の連結成分として残るので、そちらのバツは従来どおり出る。
      // **抜けの先が階段室（farStair）ならアキではない**（ユーザー裁定2026-10-14「ホール C: バツはなし」）
      // ——階段室への通路であって、向こうに何も無い抜けの標記を出す場所ではない。
      if (isOpenLikeBand(b) && !b.openingPassThrough && !overCutWall && !b.farStair) {
        const x0 = Math.max(col.x0, faceLoX), x1 = Math.min(col.x1, faceHiX);
        if (x1 - x0 <= GAP_EPS) continue; // 面の外（延長ぶん）だけの列
        // **アキの下端はband自身が決める**（展開図一般化Phase 6b-2 C-2。設計
        // `.claude/elevation-redesign.md`§5.11）——旧実装はここで`cut.drawFloorProfile`
        // （断面線＝面全幅フラットの輪郭）まで強制的に持ち上げていたが、輪郭は「階段の占有形状の
        // 概算」に過ぎず、実際にどこまでが空気で（open帯）どこからが階段下部屋の壁（今はkind:
        // 'hidden'として実体を持つ）かは既にband自身（sectionHits.jsのvisibleBandsOf）が答えを
        // 持っている。二重にクランプすると、hidden実体の手前側にあるはずの本来のアキ下端
        // （階段の桁の間の隙間等）が輪郭の高さまで誤って持ち上げられる（実機「6」C）。
        // **例外（階段帯だけ。2026-10-08裁定）**: 断面線（emitCtx.gapFloorProfile）があるときは、
        // 断面線より下（階段下など断面の外側）にはアキを出さない——セルの下限を輪郭へ持ち上げる。
        // 渡されない帯（部屋帯・吹抜け帯・断面線の無い面＝鉄骨で部屋なし／seq1・seq3）は従来どおりband自身の下端。
        // 床が列の中で踊り場（平ら）と階段（斜め）に分かれるときは、平らな区間だけがそれぞれの実の床の高さでセルになる（`floorPiecesOf`）。
        // 列全体の最大値で持ち上げると、踊り場の上のアキの下端が階段の段の高さへずれ、左端も踊り場の始まりでなく列境界になる。
        for (const { xa: px0, xb: px1, fz } of floorPiecesOf(gapFloorProfile, x0, x1)) {
        const z0 = Math.max(b.z0, fz);
        if (b.z1 - z0 <= GAP_EPS) continue;
        // 直下に斜めの天端の帯（topEdge）があれば、アキの下辺は斜線（帯の上端 z0 は斜面の高い側）。
        // 下辺の両端の高さ（列の x0側・x1側）をセルに持たせ、バツの下の隅と「ア キ」の置き場を斜線に合わせる。
        const below = col.bands.find(x => x.topEdge && Math.abs(x.z1 - z0) < GAP_EPS);
        // structZ0: 一点鎖線/破線の切替（下記dash）専用のz0。`sectionEngine.js`の
        // `splitOpenByFarFace`が遠側床へ下端を伸ばした帯（`b.extendedFromZ`＝伸ばす前のz0）は、
        // 様式判定では**伸ばす前**のまま扱う——遠側（別の部屋）の低い床へ伸びただけで、
        // この帯自身が階層の下へ潜ったわけではない（実機「11'」A2）。
        // **手前を梁（面の平面上・空中）が横切る区間はアキのセルから抜く**（ユーザー裁定2026-10-23。
        // 部屋帯だけが emitCtx.gapBeamRects で渡す）——梁型の上下は別々のアキ＝バツが2つになる。
        // 梁の天端が天井に接していれば上の残りが無く、下の1つだけ。
        for (const [xa, xb] of splitXByBeams(px0, px1, splitRects)) {
          for (const [za, zb] of subtractBeamZ(z0, b.z1, xa, xb, splitRects)) {
            const raised = za > z0 + GAP_EPS;
            cells.push({
              colIndex, x0: xa, x1: xb, z0: za, z1: zb, structZ0: raised ? za : (b.extendedFromZ ?? z0),
              colX0: col.x0, colX1: col.x1,
              lo0: raised ? za : Math.max(below?.topEdge.zAtX0 ?? z0, fz),
              lo1: raised ? za : Math.max(below?.topEdge.zAtX1 ?? z0, fz),
            });
          }
        }
        }
      }
    }
  });
  return cells;
}

/**
 * 同じ列（＋x範囲）でzが接するセルを1つへ繋ぐ。
 * @returns {object[]} merged
 */
function mergeGapCells(cells) {
  // **同じ列でzが接するセルは先に1つへ繋ぐ**（ユーザー実機指摘2026-09「「6」C: 1階X3〜
  // X3から1500、バツが踊り場で上下2つに分かれているが1つが正解」）——列のz区間は
  // `cut.baseFloorZ`のような**描画都合の断点**でも割られており（sectionProbe.jsのzSet。
  // 線種の最終降格を区間ごとに効かせるための分割）、そこで連結成分が切れると1つの抜けが
  // 上下2組のバツになる。接しているセルは同じ列＝同じx範囲なので、繋いでも形は変わらない。
  const merged = [];
  // （梁で x を分けたセルは同じ列でも x 範囲が違うので、列＋x 範囲を同じ列として繋ぐ。梁が無ければ列そのもの）
  for (const [, group] of Map.groupBy(cells, c => `${c.colIndex}|${c.x0}|${c.x1}`)) {
    for (const cell of [...group].sort((a, b) => a.z0 - b.z0)) {
      const prev = merged[merged.length - 1];
      if (prev && prev.colIndex === cell.colIndex && prev.x0 === cell.x0 && prev.x1 === cell.x1
        && cell.z0 <= prev.z1 + GAP_EPS) {
        prev.z1 = Math.max(prev.z1, cell.z1);
      } else {
        merged.push({ ...cell });
      }
    }
  }
  return merged;
}

/**
 * 連結成分（列インデックスが隣接し、z範囲が重なるセル同士）にまとめる。
 * @returns {object[][]} groups
 */
function groupGapCells(merged) {
  const groups = [];
  for (const cell of merged) {
    const touching = groups.filter(g => g.some(c =>
      Math.abs(c.colIndex - cell.colIndex) <= 1 && overlapsZ(c, cell)));
    if (touching.length === 0) { groups.push([cell]); continue; }
    const [target, ...rest] = touching;
    target.push(cell);
    for (const other of rest) {
      target.push(...other);
      groups.splice(groups.indexOf(other), 1);
    }
  }
  return groups;
}

/**
 * 連結成分ごとに、アキのバツ（対角線2本。実体・梁と交差する区間はクリップ）と「ア キ」の文字をprimsへ積む。
 * 標記を置けない幅（minGapWidthMm 未満）の成分は省略する。
 * @returns {object[]}
 */
function emitGapGroups(groups, { cut, columns, ceilZ, minGapWidthMm, beamRects }) {
  const prims = [];
  for (const g of groups) {
    const x0 = Math.min(...g.map(c => c.x0));
    const x1 = Math.max(...g.map(c => c.x1));
    if (x1 - x0 < minGapWidthMm) continue; // 標記を置けない幅＝アキ・バツごと省略
    const z0 = Math.min(...g.map(c => Math.min(c.z0, c.lo0, c.lo1)));
    const z1 = Math.max(...g.map(c => c.z1));
    // セルの下辺の高さ（斜めの天端の帯の上では斜線。無ければ z0 の水平線）。
    const lowAt = (c, x) => (c.colX1 - c.colX0 > GAP_EPS
      ? c.lo0 + (c.lo1 - c.lo0) * Math.min(1, Math.max(0, (x - c.colX0) / (c.colX1 - c.colX0)))
      : c.lo0);
    // **バツの4点は空き面の実際の隅**（ユーザー実機指摘2026-08「6」C「バツの４点は、空き面の
    // 最も大きい対角を頂点とする」「2Fのアキ・バツ左下点は、左側壁断面と腰壁上端の交点へ移動」）。
    // 外接矩形の隅は、成分がL字（腰壁が食い込む等）だとアキでない場所に落ちる。左右それぞれの
    // 端にあるセルのz範囲から、その端での実際の上下を取る（矩形なら外接矩形と一致＝挙動不変）。
    const atX = x => g.filter(c => c.x0 <= x + GAP_EPS && c.x1 >= x - GAP_EPS);
    const edgeZ = (x, xEdge, fallbackLo, fallbackHi) => {
      const cs = atX(x);
      return cs.length
        ? { lo: Math.min(...cs.map(c => lowAt(c, xEdge))), hi: Math.max(...cs.map(c => c.z1)) }
        : { lo: fallbackLo, hi: fallbackHi };
    };
    const L = edgeZ(x0 + GAP_EPS, x0, z0, z1);
    const R = edgeZ(x1 - GAP_EPS, x1, z0, z1);
    // **開放スパンのアキは高低差に追従する**（ユーザー裁定2026-09「高低差」＝バツの床は遠側床に
    // 着く）——下端は遠側の床、上端は近側/遠側の天井の低い方（既存の「開放先の天井が低ければ
    // そこまで」と同じ規約）。Phase 5（設計`.claude/elevation-redesign.md`§5.5）:
    // 判定材料（遠側のFL/CH）は**もう呼び出し側からは渡さない**——`col.bands`の`'open'`帯自体が
    // 断面エンジンの探査（`sectionEngine.js`の`splitOpenByFarFace`。値の出どころは
    // `sectionHits.js`の`farFaceAnnotation`＝視線方向のヒット列）で既にfloorFace/ceilFaceの
    // z0/z1へクランプ・延長済みなので、ここで拾う`L`/`R`（`b.z0`/`b.z1`由来）がそのまま
    // アキの範囲になる。**二重クランプはしない**——値の単一情報源は探査（bands）。
    // §5.6: baseFloorZより上=一点鎖線(center)、床断面より下=破線(dashed)。連結成分がbaseFloorZを
    // またぐ（D1の「開口+上階アキ」等）場合は、床断面より下へ到達している時点でdashedを選ぶ
    // （ASSUMED: 設計書はこの併合時の様式を明記していないため、より弱い表現＝dashedを安全側の
    // 既定にした。報告に明記する）。
    // **structZ0**（`z0`ではなく`c.structZ0`の最小）で判定する——遠側床への下端延伸
    // （Phase 5・`extendedFromZ`）はこの帯自身がbaseFloorZの下へ潜ったわけではないため対象外
    // （実機「11'」A2: 遠側床線自体は図側が別に「破線」で描くが、アキの対角線・「ア キ」は
    // この帯自身の床断面（baseFloorZ）より上のままなら一点鎖線・文字ありのまま）。
    // **`exempt`**（展開図一般化Phase 6b-2 C-5。設計`.claude/elevation-redesign.md`§5.11）は
    // 「線分ごとの分割をしない（＝対角線全体をneverDowngradeのcenterで通す）」かどうかのゲート
    // ——旧実装はこの1つの真偽値で**成分全体**の様式（'center'か'dashed'か。`dash`変数）を
    // 一括決定していたが、新実装は「structZ0がbaseFloorZ以上（＝実extendedFromZの例外か、
    // そもそも全区間baseFloorZより上）」のときだけ旧どおり一括center（exempt）とし、それ以外は
    // 各対角線をbaseFloorZで分割して§5.6最終フィルタ（emitLineのbeyond判定）に降格を委ねる
    // （下記）。QA是正2026-09（C）: 「ア キ」のゲートは`dash`（成分単位の一括値）ではなく
    // `hasUpperCenterPiece`（下記）を使う——線分ごとの分割後は成分全体が'dashed'扱いでも
    // 上片はcenterのまま描かれるため、旧`dash==='center'`ゲートのままだと矩形の成分でも
    // 文字が出なくなっていた。
    const structZ0 = Math.min(...g.map(c => c.structZ0 ?? c.z0));
    const baseFloorZ = cut.baseFloorZ ?? 0;
    const exempt = structZ0 >= baseFloorZ - GAP_EPS;
    // **バツは実体（腰壁等）と交差する区間をクリップする**（ユーザー実機指摘2026-08「6」C
    // 「バツが、腰壁と交差する場合、腰壁内はクリップして描画しない」）。連結成分の外接矩形
    // いっぱいに対角線を引くため、成分に食い込む壁の上を線が通ってしまう。
    // 差し引くのは**実体の帯だけ**（wall/cut/cutAlong。ただし開口貫通は成分の一部なので除く）
    // ——「アキのセルの和」でクリップすると、開口と上階アキがL字に連結する構成で
    // 「1組の大きなX」（WP-E7 D1の確認済み仕様）が細切れになるため採らない。
    // 梁（断面を含む）の矩形もバツの線から切り抜く（断面はセルを割らず、線を抜くだけ）。
    const blockers = [...obstructionRects(columns, x0, x1,
      Math.min(z0, L.lo, R.lo), Math.max(z1, L.hi, R.hi)),
    ...beamRects.map(r => ({ xLo: r.xLo, xHi: r.xHi, yLo: zToY(r.zHi), yHi: zToY(r.zLo) }))];
    // アキ標記の「ア キ」（旧 elevationFigure.js の appendGapMark から移設）。次の2条件を
    // すべて満たす連結成分にだけ付ける（建具の開口はそもそもセルに入らない＝上記）:
    //   - 外接矩形そのもの（全セルが同じz範囲）… L字に食い込んだ成分では外接矩形の中心が
    //     アキでない場所（腰壁の上等）に落ち、文字が実体の上に乗る
    //   - 上片（center）が実在する（`hasUpperCenterPiece`。QA是正2026-09・C）… 床断面より下だけの
    //     抜けは「向こう側の断面＝細線の破線」で、そこへ実線の標記を足すのは線種の規則に反する
    //
    // **輪郭の矩形は描かない**（ユーザー明示指示「矩形をやめて」）——アキの輪郭は定義上つねに
    // 周囲の実体（壁の断面・床/天井の断面線・腰壁の天端・面端の縦線）と一致するため、矩形として
    // 独立に描くと必ず二重になる。しかも矩形は中線なので、後から重なって**断面＝太線という
    // 線種の情報を上書きしてしまう**（実機「5」A: X2通りの壁の断面（太線）の上に、アキ矩形の
    // 左辺（中線）が重なっていた）。抜けの範囲はバツと「ア キ」で足りる。
    // **矩形または台形**＝上辺が水平で下辺が1本の直線（水平なら矩形。斜めの天端の上のアキは台形）。
    // 下辺が1本の直線かは、全セルの下辺の両端が L→R の直線の上にあるかで見る。
    const lowLineAt = x => L.lo + (R.lo - L.lo) * (x - x0) / (x1 - x0);
    const isRect = g.every(c => Math.abs(c.z1 - z1) < GAP_EPS
      && Math.abs(lowAt(c, c.x0) - lowLineAt(c.x0)) < SLOPE_FIT_EPS_MM
      && Math.abs(lowAt(c, c.x1) - lowLineAt(c.x1)) < SLOPE_FIT_EPS_MM);
    // QA是正2026-09（Phase 6b-2 C-5の回帰）: 旧ゲート（`dash==='center'`＝成分単位のexempt判定）は
    // 線分ごとの分割（C-5）導入後、矩形の成分でも**上片がcenterのまま**なのに「成分全体としては
    // 非exempt（dash変数は'dashed'）」というだけの理由で「ア キ」が一切出なくなっていた。
    // 正しいゲートは「上片（center）が実在するか」——exemptならそのまま（従来どおり全体がcenter）、
    // 非exemptでも**成分の上端z1がbaseFloorZより上**なら、その部分はC-5の分割でcenterのまま
    // 描かれる（実際に文字を置ける中心がある）ので出してよい。
    const hasUpperCenterPiece = exempt || z1 > baseFloorZ + GAP_EPS;
    if (isRect && hasUpperCenterPiece) {
      // 中心は矩形の中心（クランプ後のz範囲＝バツと同じ範囲）で採る——線と文字が食い違わないため。
      const tLo = (L.lo + R.lo) / 2, tHi = Math.max(L.hi, R.hi); // 台形なら下辺の中点の高さ（矩形は L.lo===R.lo）
      prims.push(text((x0 + x1) / 2, zToY((tLo + tHi) / 2), 'ア キ', { anchor: 'middle', baseline: 'middle' }));
    }
    // **線分ごとの線種判定**（Phase 6b-2 C-5）: `exempt`（旧`structZ0>=baseFloorZ`の一括判定）
    // なら旧どおり対角線1本のまま`neverDowngrade`でcenterを強制する（`extendedFromZ`の例外は
    // ここで保たれる——`emitLine`の実z（beyond判定）に関わらず様式を固定するため）。
    // 非exemptなら対角をbaseFloorZで分割し、**両片ともdash:'center'のまま**`emitLine`へ渡す
    // ——下片（両端がbaseFloorZ以下）は`emitLine`の§5.6最終フィルタ（`beyond`判定）が
    // 自動的にDETAIL+dashedへ降格させる（`emitLine`のforceDash/neverDowngrade注記参照）。
    // 上片は降格条件に当たらないためcenterのまま残る——「下片が破線・上片が一点鎖線」という
    // ユーザー裁定（2026-09-11「6」C）はこの分割だけで成立し、成分全体を1つの値で塗る旧実装より
    // 実際の高さに忠実になる。
    for (const [a, b] of [[[x0, L.lo], [x1, R.hi]], [[x0, L.hi], [x1, R.lo]]]) {
      if (exempt) {
        const gapLine = emitLine(cut, a[0], a[1], b[0], b[1], ElevationLineRole.DETAIL,
          { dash: ElevationDash.CENTER, ceilZ, neverDowngrade: true });
        prims.push(...subtractRectsFromLine(gapLine, blockers));
        continue;
      }
      for (const [p, q] of splitSegmentAtZ(a, b, baseFloorZ)) {
        const gapLine = emitLine(cut, p[0], p[1], q[0], q[1], ElevationLineRole.DETAIL, { dash: ElevationDash.CENTER, ceilZ });
        prims.push(...subtractRectsFromLine(gapLine, blockers));
      }
    }
  }
  return prims;
}

// 隅の取り合いの許容差（finish/kneeDropWall.js の CORNER_OVERHANG_EPS_MM と同じ150mm）。
const EDGE_ON_CORNER_EPS_MM = 150;

// 列 columns の x（面ローカル）に接する全列で'open'の帯のz範囲（列の継ぎ目なら両側の列の共通部分）。
// 階段室越しの壁の帯（viaStair。階段室の最初の壁）も、手前の空気は開いているので通す（隔て板の端は
// その壁の手前に立って見える）。接する帯は1つの範囲へつなぐ。
function openZRangesAt(columns, x) {
  const touching = columns.filter(c => c.x0 - GAP_EPS <= x && x <= c.x1 + GAP_EPS);
  if (touching.length === 0) return [];
  let ranges = null;
  for (const c of touching) {
    const opens = c.bands
      // 梁の断面（memberCut）は後ろがアキだった区間なら従来どおりアキの範囲に数える（along もここでは割らない）
      .filter(b => ((b.kind === 'open' || ((b.kind === 'memberCut' || b.kind === 'member') && b.behind === 'open')) && !b.openingPassThrough)
        || (b.kind === 'wall' && b.viaStair))
      .map(b => ({ z0: b.z0, z1: b.z1 }))
      .sort((a, b) => a.z0 - b.z0)
      .reduce((acc, r) => {
        const last = acc[acc.length - 1];
        if (last && r.z0 <= last.z1 + GAP_EPS) last.z1 = Math.max(last.z1, r.z1);
        else acc.push({ ...r });
        return acc;
      }, []);
    ranges = ranges === null ? opens : ranges.flatMap(r => opens
      .map(o => ({ z0: Math.max(r.z0, o.z0), z1: Math.min(r.z1, o.z1) }))
      .filter(m => m.z1 - m.z0 > GAP_EPS));
  }
  return ranges;
}

/**
 * **開放スパンの中に見える、視線に平行な壁（面の線に端を接して奥へ延びる直交壁）の両面の縦線**
 * （ユーザー裁定2026-10-14「ホール C: X2の右910には壁がフルハイトに立っているので、左右壁厚に中線が
 * 正解」）。面の平面に壁が無い（'open'）範囲の向こうに、面の軸CLから奥へ延びる壁（階段の隔て板等）が
 * 立っていると、それは真横から見え、壁厚ぶんの2本の縦線になる。
 *
 * 対象は自階の層の壁で、(1)面に直交し (2)奥へ延びる側の端が面に接している（切断線〜面の軸CLの間。
 * `cut.face`が無ければ切断線）もの。切断壁（'cut'帯＝切断線を横切る壁）は別経路で描かれ、その位置は
 * 'open'帯ではないので重ならない。同じ軸CLで端が揃う壁（隔て板の下地壁＋仕上げ薄壁）は1枚として
 * 材の範囲の最小〜最大の外面2本だけ描く。面の端に材が届く壁（面自身の端壁）は`recessLo/Hi`が描くので除く。
 * z範囲は「その位置の'open'帯」∩「壁の存在z範囲」（`wallZRangesOf`。腰壁・天端プロファイル・上階への
 * 続きを含む。`sectionHits.js`の`edgeOnWallZRanges`）。壁の高さの外（吹抜けの上など）には引かない。
 * 階段帯（`cut.stairCut`）では呼ばない（`sectionContent.js`。階段の面は別規則）。
 * @param {import('./sectionTypes.js').SectionColumn[]} columns
 * @param {import('./sectionTypes.js').SectionCut} cut
 * @param {((layer:object, wall:object, depth:number, lateral:number)=>Array<{z0:number,z1:number}>)|null} [wallZRangesOf]
 *   省略（null）は壁の高さを制限しない（単体テスト用）。
 * @param {number} [ceilZ]
 * @param {Array<{xLo:number, xHi:number, zLo:number, zHi:number}>|null} [rectsOut] - 渡すと、縦線を引いた壁ごとの
 *   端面の矩形（面ローカルx×z）を追記する（その向こうの階段の見えがかり等を隠す遮蔽。`sectionContent.js`）。
 * @param {number} [baseboardMm] - 帯の部屋の巾木高さ。正なら、階段室越しの壁（viaStair）の手前に見える小口の
 *   足元から立ち上げた巾木の細線を足す（既定0＝引かない）。
 * @returns {object[]}
 */
export function emitOpenSpanEdgeOnWalls(columns, cut, wallZRangesOf = null, ceilZ = undefined, rectsOut = null, baseboardMm = 0) {
  const layer = (cut.layers ?? []).find(l => l?.role === 'self');
  const walls = layer?.graph ? graphList(layer.graph, 'walls') : null;
  if (!walls?.length) return [];
  const { line, viewSign } = cut;
  const refAxis = cut.face?.axisCL?.effectiveValue ?? line.axisValue;
  const { loX: faceLoX, hiX: faceHiX } = faceRangeX(cut);
  // 面の壁に接する範囲＝切断線から面の軸CLまで（切断線は仕上げ面の分だけ室内側へ下がっている）。
  const attachMaxMm = Math.max(0, (refAxis - line.axisValue) * viewSign) + PROBE_EPS_MM;
  const groups = new Map(); // 軸CL → {walls, lo, hi, depth}
  const crossing = new Set();
  for (const w of walls) {
    if (w.isVertical === line.isVertical || !w.materialRange) continue;
    const c1 = Math.min(w.coord1, w.coord2), c2 = Math.max(w.coord1, w.coord2);
    if (c2 - c1 <= PROBE_EPS_MM) continue;
    const along = viewSign > 0 ? c1 : c2; // 奥（視線方向）へ延びる壁の、手前の端
    const gapMm = (along - line.axisValue) * viewSign; // 切断線から壁の端まで（視線方向）
    const key = w.axisCL?.id ?? w.axisCL ?? w.id;
    // 切断線より手前（室内側）へ延びる壁は切断壁（面を横切る壁）——同じ軸CLの壁は組ごと対象外。
    if (gapMm < -PROBE_EPS_MM) { crossing.add(key); continue; }
    if (gapMm > attachMaxMm) continue;
    const lo = Math.min(w.materialRange.lo, w.materialRange.hi), hi = Math.max(w.materialRange.lo, w.materialRange.hi);
    const g = groups.get(key);
    if (g) { g.walls.push(w); g.lo = Math.min(g.lo, lo); g.hi = Math.max(g.hi, hi); }
    else groups.set(key, { walls: [w], lo, hi, depth: Math.min(Math.max(refAxis, c1), c2) }); // depth＝面の線での壁の位置
  }
  const prims = [];
  for (const [key, g] of groups) {
    if (crossing.has(key)) continue;
    const xs = [localXOf(cut, g.lo), localXOf(cut, g.hi)].sort((a, b) => a - b);
    if (xs[0] <= faceLoX + GAP_EPS || xs[1] >= faceHiX - GAP_EPS) continue; // 面自身の端壁
    // 面の壁の途切れ目（開口の脇）に立つ直交壁も、その壁自身の端壁（隅の取り合い）であって
    // 開放スパンの中の独立した壁ではない——両脇 EDGE_ON_CORNER_EPS_MM 以内に壁・切断壁の列があれば除く。
    if (openZRangesAt(columns, xs[0] - EDGE_ON_CORNER_EPS_MM).length === 0
      || openZRangesAt(columns, xs[1] + EDGE_ON_CORNER_EPS_MM).length === 0) continue;
    // 壁の存在z範囲（組の全壁の和）。引けない（関数なし）ときは制限しない。
    const wallZ = [];
    for (const u of (wallZRangesOf
      ? g.walls.flatMap(w => wallZRangesOf(layer, w, g.depth, w.axisCL?.effectiveValue))
      : [{ z0: -Infinity, z1: Infinity }]).sort((a, b) => a.z0 - b.z0)) {
      const last = wallZ[wallZ.length - 1];
      if (last && u.z0 <= last.z1 + GAP_EPS) last.z1 = Math.max(last.z1, u.z1);
      else wallZ.push({ z0: u.z0, z1: u.z1 });
    }
    let zLo = Infinity, zHi = -Infinity;
    for (const x of xs) {
      for (const r of openZRangesAt(columns, x)) {
        for (const u of wallZ) {
          const z0 = Math.max(r.z0, u.z0), z1 = Math.min(r.z1, u.z1);
          if (z1 - z0 <= GAP_EPS) continue;
          prims.push(emitLine(cut, x, z0, x, z1, ElevationLineRole.SILHOUETTE, { ceilZ }));
          zLo = Math.min(zLo, z0); zHi = Math.max(zHi, z1);
        }
      }
    }
    // 壁の端面（両面の間）は手前を塞ぐ実体＝その向こうの見えがかりを隠す矩形（呼び出し側が遮蔽に使う）。
    if (rectsOut && zHi > zLo) rectsOut.push({ xLo: xs[0], xHi: xs[1], zLo, zHi });
    // 階段室越しの壁（viaStair）の手前に見える隔て板の小口にも巾木を引く（ユーザー指示2026-10-15「X2+910に立つ
    // 壁小口にも巾木が見える」）。階段室の開口越しの小口だけが対象——それ以外の開放スパンの壁端は引かない。
    // 高さは viaStair 壁の巾木と同じ（baseboardMm＝帯の部屋の巾木高さ）。
    // 足元が床の高さにある端面だけ（垂れ壁など足元が床に無い端面には引かない）。
    const footCol = baseboardMm > 0
      ? columns.find(c => c.x1 > xs[0] + GAP_EPS && c.x0 < xs[1] - GAP_EPS
        && c.bands.some(b => b.kind === 'wall' && b.viaStair))
      : null;
    if (footCol && zHi > zLo && zLo + baseboardMm < zHi - GAP_EPS
      && sectionLevelZs(cut, footCol, ceilZ).some(f => Math.abs(zLo - f) < GAP_EPS)) {
      prims.push(emitLine(cut, xs[0], zLo + baseboardMm, xs[1], zLo + baseboardMm, ElevationLineRole.DETAIL, { ceilZ }));
    }
  }
  return prims;
}
