/**
 * 2.5D断面エンジン: buildSectionFigure（columns→出力組み立て。WP-E4）。
 * 設計意図はarchitect承認済みの実装指示書§4参照。直進階段専用の2本目の経路——実データ13/11に
 * 直進階段が無くgoldenでゲートできないため、buildSectionFromLineへの統合はPhase 7c
 * （直進階段を含むテスト.stq）以降（ユーザー裁定2026-09-13）。buildColumns
 * （本ファイルからexport）はWP-E5bでelevationStairSequence.jsから直接呼ばれる。
 *
 * 内部フロー（§4のコメントどおり）: collectCutBreaks → probeColumn×N → mergeColumns
 * （同一分類の隣接併合）→ faceFromCut → floorSegments/ceilingProfile導出 → sectionEmit → content。
 *
 * ASSUMED（設計書に算出式の明記が無いためWP-E4完了条件の範囲で以下の解釈を採用。§9のとおり
 * 「手書きの小さなSectionCutリテラル→期待するプリミティブ」で直接検証する）:
 *   - floorSegments: このWPでは「区分（エリア）ごとの床段差」までは導出しない
 *     （階段の踊り場等、cutの向こうにある実際の段差反映はWP-E5でstairCut統合時に確定させる
 *     ——設計書はfloorSegmentsの算出式自体を明記していない）。今回は面全幅を覆う単一区間
 *     （floorDeltaMm:0・完了条件「隙間なく面全幅・hiX>loX」を満たす最小限の忠実な実装）。
 *   - ceilingProfile: cut.zRange.hiZ（この切断が見せる天井の絶対高さ）を面全幅にわたる
 *     水平線として2点（[loX,ceilAbsMm],[hiX,ceilAbsMm]）で返す（区分線形の最小形。昇順条件は
 *     loX<=hiXから自明に満たす）。
 *   - primaryWall未指定時は、columns中で最も広いx幅を占める壁（'wall'|'cut'band.wall）を
 *     「レイキャストで最も広く見えた壁」として選ぶ。
 *   - cut.stairCutは「事前計算済みのstairContribution結果」を直接指す想定（sectionEngine.js
 *     自身はfinish/stair側の詳細を知らない——第3層との結合点はこの1箇所に閉じる）。
 */
import { GAP_EPS_MM as GAP_EPS, SIGHTLINE_DEPTH_LIMIT_MM } from '../elevationStyle.js';
import { localXOf, worldOf, ceilProfileZAt } from './sectionTypes.js';
import { collectCutBreaks, probeColumn, upperFloorZAt } from './sectionProbe.js';
import { faceFromCut } from './sectionFace.js';
import { emitColumns, emitOpenGapMarks, nearestSightlineDistMm } from './sectionEmit.js';
import { stairPrimitivesForCut } from './sectionStair.js';
import { reachableAirByColumn } from './sectionVisibility.js';

// bands配列が（kind・z0/z1・wall参照・distMm・layerRole・openingPassThrough）まで完全一致するか
// （mergeColumns用）。WP-E7 D1: openingPassThroughも比較対象に含める——比較しないと、開口の
// 有無で挙動が違う隣接列（片方だけopeningPassThrough:trueの'wall'帯）が誤って1列に統合され、
// その列の実際のx範囲の一部でopeningPassThroughが取りこぼされる（emitOpenGapMarksの連結成分
// 計算に渡らない）おそれがあるため。
function bandsEqual(a, b) {
  if (a.length !== b.length) return false;
  return a.every((band, i) => {
    const other = b[i];
    return band.kind === other.kind
      && Math.abs(band.z0 - other.z0) < GAP_EPS && Math.abs(band.z1 - other.z1) < GAP_EPS
      && (band.wall ?? null) === (other.wall ?? null)
      && (band.distMm ?? null) === (other.distMm ?? null)
      && (band.layerRole ?? null) === (other.layerRole ?? null)
      && (band.openingPassThrough ?? false) === (other.openingPassThrough ?? false)
      && (band.hiddenOf ?? null) === (other.hiddenOf ?? null)
      // Phase4（水平面ヒット。裁定済み2026-09-11・既定on。far値が付かない列は両側undefined
      // ＝比較は常にtrueで従来どおり）:
      // 比較しないと「片方の列だけ深度上限内の奥の床・天井が見える」隣接列が誤って1列へ統合され、
      // その列の実際のx範囲の一部でfarFloorZ/farCeilZが取りこぼされる（openingPassThroughと同じ
      // 理由。WP-E7 D1参照）。
      && (band.farFloorZ ?? null) === (other.farFloorZ ?? null)
      && (band.farCeilZ ?? null) === (other.farCeilZ ?? null)
      && (band.farDepthMm ?? null) === (other.farDepthMm ?? null)
      // Phase5: extendedFromZ（下端をfarFloorZまで伸ばした帯の、伸ばす前のz0。emitOpenGapMarksの
      // 一点鎖線/破線切替の判定材料）も同じ理由で比較する。
      && (band.extendedFromZ ?? null) === (other.extendedFromZ ?? null);
  });
}

/**
 * `cut.ceilProfile`の区間境界を列の分割点へ足す（world座標・昇順）。
 * 天井の高さが変わる位置は列の境界でなければならない——境界をまたぐ1本の列は中点で1つの天井しか
 * 持てず、区間の片側が誤った天井で打ち切られる（実データでは境界にCLや壁があって偶然分かれるが、
 * それに依存してはいけない）。
 * @param {import('./sectionTypes.js').SectionCut} cut
 * @param {number[]} breaks - collectCutBreaksの結果（world昇順）
 * @returns {number[]}
 */
function withCeilProfileBreaks(cut, breaks) {
  const prof = cut.ceilProfile;
  if (!Array.isArray(prof) || prof.length === 0) return breaks;
  const lo = breaks[0], hi = breaks[breaks.length - 1];
  const values = new Set(breaks);
  for (const seg of prof) {
    for (const localX of [seg.loX, seg.hiX]) {
      const w = worldOf(cut, localX);
      if (w > lo + GAP_EPS && w < hi - GAP_EPS) values.add(w);
    }
  }
  return [...values].sort((a, b) => a - b);
}

// 切断された壁の帯（'cut'＝面を横切る壁／'cutAlong'＝縦断された壁）か。
function isCutBand(b) { return b.kind === 'cut' || b.kind === 'cutAlong'; }

/**
 * 2つの切断帯が**同じ1枚の壁**を指すか。壁は片面ずつのWallオブジェクトとして持つデータモデル
 * のため、参照一致だけで見ると1枚の壁が2枚に割れる（`sectionEmit.js`の`emitColumns`が
 * 断面の内部に縦線を出さないために使う判定と同じ見方）——切断線は壁を厚み方向に横切るので、
 * 同一軸CL・同一z範囲の切断帯が隣接列で接するのは「同じ壁の反対の面」以外にありえない。
 * @param {import('./sectionTypes.js').ZBand} a
 * @param {import('./sectionTypes.js').ZBand} b
 * @returns {boolean}
 */
function sameCutWall(a, b) {
  if (!a?.wall || !b?.wall) return false;
  if (a.wall === b.wall) return true;
  return !!a.wall.axisCL && a.wall.axisCL === b.wall.axisCL
    && Math.abs(a.z0 - b.z0) < GAP_EPS && Math.abs(a.z1 - b.z1) < GAP_EPS;
}

/**
 * 列iに立つ切断壁の帯が、**自分の天井断面より上でも見えるか**——見えるのは
 * 「その帯のz範囲を覆う空気が、**隣の列に到達可能な形で**在る」側だけ。
 *
 * 天井断面の高さが変わる境界は必ず壁が受けている。その壁の断面は「天井の向こう」ではなく
 * **天井が終わっている面そのもの**で、天井の高い側から実際に見える——列自身の天井で打ち切ると
 * 壁ごと消える（実機「5」A: X2通りの2階壁が断面抽出から丸ごと漏れていた根本原因）。
 * 逆に見えない側の面まで描くと壁厚が図に出てしまう（同「5」A面左3200・C1面右400。
 * ユーザー明示指示「X2の右側が断面線なら、左側は壁の中になり、描画しないが正解」）。
 *
 * **壁が占める列の連なりの外側**を見るのが要点——壁は片面ずつのWallオブジェクトなので壁厚が
 * 複数列に割れており、隣接1列だけを見ると片側だけが生き残る。判定に使うのは隣の列の
 * **天井の高さ**ではなく**到達可能な空気**（`sectionVisibility.js`）——その列にも別の切断壁が
 * 立っていれば、天井が高くてもその高さに空気は無いため。
 * @param {object[]} columns - x0昇順。bandsは未クリップ
 * @param {Array<Array<{z0:number,z1:number}>>} air - 列ごとの到達可能な空気区間
 * @param {number} i
 * @param {import('./sectionTypes.js').ZBand} band
 * @returns {{side:'lo'|'hi'|null, topZ:number}} side===null なら天井より上は見えない
 */
function exposedAboveCeil(columns, air, i, band) {
  const col = columns[i];
  const ceilZ = col.ceilZ;
  let best = { side: null, topZ: ceilZ };
  const cuts = col.bands.filter(b => isCutBand(b) && b.wall);
  if (cuts.length === 0) return best;
  const shares = j => !!columns[j]?.bands.some(b => isCutBand(b) && cuts.some(a => sameCutWall(a, b)));
  let lo = i; while (shares(lo - 1)) lo--;
  let hi = i; while (shares(hi + 1)) hi++;
  for (const [j, side] of [[lo - 1, 'lo'], [hi + 1, 'hi']]) {
    for (const iv of air[j] ?? []) {
      if (iv.z1 <= ceilZ + GAP_EPS) continue;                                 // 自分の天井より上を覆うか
      if (iv.z1 <= band.z0 + GAP_EPS || iv.z0 >= band.z1 - GAP_EPS) continue; // 帯のz範囲と重なるか
      if (!Number.isFinite(best.topZ) || iv.z1 > best.topZ) best = { side, topZ: iv.z1 };
    }
  }
  return best;
}

/**
 * 列iの帯を**見えている範囲**だけに切る（「展開図では断面の中は描画しない」）。
 *
 * 基本はその列の天井断面（`col.ceilZ`）で打ち切る。例外は1つだけ——**天井より上でも、隣の列の
 * 到達可能な空気に面している切断壁**は、その空気の上端まで描く（`exposedAboveCeil`）。
 * 段違い天井の境界に立つ壁も、吹抜けに面した腰壁の天端も、この1つの規則から出る
 * （かつては「段違い天井の壁」「腰壁・垂れ壁」の2つの例外に分かれており、後者は隣に空気が
 * あるかを見ずに無条件で残していた＝吹抜けに面していない腰壁まで天井の裏に描いていた）。
 *
 * 帯のz範囲は**壁の実体のまま**にする（低い天井まで下ろさない）——1階天井〜上階FLの区間は
 * 壁ではなく上階の床構造で、その断面は`sectionEmit.js`の`ceilStepSlabSection`が境界の小口として
 * 描く。ここで引き伸ばすと壁の**向こう側の面**まで下りて「断面の中」に線が入る。
 * **見える側の面だけを描く**ため`exposedSide`を付ける（`sectionEmit.js`のemitColumns）。ただし
 * 腰壁・垂れ壁（`isKneeDrop`）は天端／下端が露出していて壁厚ぶんの見付が実際に見えるので両縁を
 * 描く（片面だけにすると天端の線が宙で終わる）。
 * **見えがかり（'wall'）には例外を適用しない**——腰壁でも、天井の向こうにあれば見えない。
 * @param {object[]} columns - bandsは未クリップ（この関数は破壊しない）
 * @param {Array<Array<{z0:number,z1:number}>>} air
 * @param {number} i
 * @returns {import('./sectionTypes.js').ZBand[]}
 */
function clipBandsToVisible(columns, air, i) {
  const col = columns[i];
  const ceilZ = col.ceilZ;
  if (!Number.isFinite(ceilZ)) return col.bands;
  const out = [];
  for (const band of col.bands) {
    if (isCutBand(band) && band.z1 > ceilZ + GAP_EPS) {
      const exposed = exposedAboveCeil(columns, air, i, band);
      if (exposed.side) {
        out.push({ ...band, z1: Math.min(band.z1, exposed.topZ),
          exposedSide: band.isKneeDrop === true ? null : exposed.side });
        continue;
      }
    }
    if (band.z0 >= ceilZ - GAP_EPS) continue;
    out.push(band.z1 > ceilZ ? { ...band, z1: ceilZ } : band);
  }
  return out;
}
/**
 * 隣接する列のbandsが完全一致すれば1列へ統合する（§4「同一分類の隣接併合」）。
 * @param {import('./sectionTypes.js').SectionColumn[]} columns - x0昇順
 * @returns {import('./sectionTypes.js').SectionColumn[]}
 */
export function mergeColumns(columns) {
  const merged = [];
  for (const col of columns) {
    const last = merged[merged.length - 1];
    // ceilZ（列ごとの天井断面高さ）が違う列は統合しない——天井の高さが変わる境界そのものだから。
    const sameCeil = (last?.ceilZ ?? null) === (col.ceilZ ?? null);
    if (last && sameCeil && Math.abs(last.x1 - col.x0) < GAP_EPS && bandsEqual(last.bands, col.bands)) {
      last.x1 = col.x1;
      // WP-E5b修正: dirSign<0のcutではbuildColumnsがraw列をworld昇順で作った後、local x昇順へ
      // 並べ替える（このmergeColumnsへの入力順はlocal x昇順）ため、world順はlocal順と逆転する。
      // 「last.worldHi = col.worldHi」だけの単純代入だと、統合を重ねるたびに直前列のworldHiで
      // 上書きされ続け、最終的な統合列のworldLo/worldHiが実際の世界範囲と無関係な値になる
      // （観測: 複数列にまたがる統合でworldLo===worldHiという退化した値になった）。
      // Math.min/maxで両列の4値から実際の範囲を再計算する（dirSignの符号に関わらず正しい）。
      const lo = Math.min(last.worldLo, last.worldHi, col.worldLo, col.worldHi);
      const hi = Math.max(last.worldLo, last.worldHi, col.worldLo, col.worldHi);
      last.worldLo = lo;
      last.worldHi = hi;
    } else {
      merged.push({ ...col });
    }
  }
  return merged;
}

// columns中で最も広いx幅を占める壁（'wall'|'cut' band.wall）を返す（列内は重複カウントしない）。
function findPrimaryWall(columns) {
  const widthByWall = new Map();
  for (const col of columns) {
    const width = col.x1 - col.x0;
    const wallsInCol = new Set();
    for (const band of col.bands) {
      if ((band.kind === 'wall' || band.kind === 'cut') && band.wall) wallsInCol.add(band.wall);
    }
    for (const wall of wallsInCol) widthByWall.set(wall, (widthByWall.get(wall) ?? 0) + width);
  }
  let best = null, bestWidth = -Infinity;
  for (const [wall, width] of widthByWall) {
    if (width > bestWidth) { bestWidth = width; best = wall; }
  }
  return best;
}

function floorSegmentsFromColumns(columns, face) {
  const run = face?.run ?? 0;
  if (columns.length === 0) return [{ loX: 0, hiX: run, floorDeltaMm: 0, chMm: null, loCLId: null, hiCLId: null }];
  const loX = Math.min(...columns.map(c => c.x0));
  const hiX = Math.max(...columns.map(c => c.x1));
  return [{ loX, hiX, floorDeltaMm: 0, chMm: null, loCLId: face?.startCLId ?? null, hiCLId: face?.endCLId ?? null }];
}

function ceilingProfileFromColumns(columns, cut, face) {
  const ceilAbsMm = cut.zRange?.hiZ ?? 0;
  if (columns.length === 0) return [[0, ceilAbsMm], [face?.run ?? 0, ceilAbsMm]];
  const loX = Math.min(...columns.map(c => c.x0));
  const hiX = Math.max(...columns.map(c => c.x1));
  return [[loX, ceilAbsMm], [hiX, ceilAbsMm]];
}

/**
 * SectionCut → SectionFigure（現行StairFaceEntryと同型。§3.3）。
 * @param {import('./sectionTypes.js').SectionCut} cut
 * @param {ReturnType<typeof import('./sectionProbe.js').makeProbeContext>} probeCtx
 * @param {{wallFaces?:object[], primaryWall?:object|null, ceilZ?:number, floorSpanX?:object}} [opts]
 * @returns {{seqNo:string, face:object, floorSegments:object[], ceilingProfile:Array<[number,number]>,
 *   chDimSplitAbsYs:number[]|undefined, content:object[], skipBaseboard:true, skipWallLabel:true,
 *   floorSpanX:object|undefined}}
 */
/**
 * `open`帯の付帯情報（`sectionHits.js`の`farFaceAnnotation`）へ深度上限を適用し、アキの範囲を
 * floorFace/ceilFaceのzまで縮める（Phase4。設計§5.5・§5.6意図的差分1・2）。
 *
 * **床と天井の深度上限判定は独立に行う**（QA是正2026-09: 実機「11'」A2の検算で発見。全高壁の
 * 向こうにある別室の天井《深度1057.5・上限超え》が、手前で開いている別室の床《深度57.5・
 * 上限内》と`farDepthMm`（両者の最小値）を共有していたため、本来上限外で採用されないはずの
 * 天井が上限判定をすり抜けて採用されていた）。`farFloorDepthMm`/`farCeilDepthMm`
 * （`sectionHits.js`の`farFaceAnnotation`が別々に返す）で個別に判定し、上限超えの側は
 * `farFloorZ`/`farCeilZ`をnullへ落として使わない——**帯の元々の`farDepthMm`（最小値）はもう
 * ここでの分割判定には使わない**（`sightRole`の重み判定など他の消費者向けにそのまま引き継ぐだけ）。
 *
 * 上限**以上**なら水平面は無かったことにする（付帯情報を落として従来どおり全域アキ。意図的差分2
 * 「既定は壁と同じ800を掛ける」）。上限内なら区間を最大3分割する:
 * `[非描画(farVoid)?, open(floorZ..ceilZ), 非描画(farVoid)?]`——floorZ/ceilZが区間の内部に
 * 無ければ（境界に一致・またはそもそも無い）その側は分割しない。`farVoid`は**非描画**
 * （`emitColumns`・`emitOpenGapMarks`のどちらも`'open'`しか見ないため、このkindは自動的に
 * 「線も描かずアキにもしない」——floorFace/ceilFaceより向こう側《天井懐・床構造》の意味）。
 *
 * **floorZが区間の外（`z0`より下）でも、下端をそこまで伸ばす**（Phase 5。設計
 * `.claude/elevation-redesign.md`§5.5「残る非対称」の解消——実機「11'」A2型。`farVoid`は
 * 作らない: `z0`と`farFloorZ`の間は「実体が無い」からこそ伸ばす対象で、隠すものが無い）。
 * `lo`は「区間の内部で縮める（floorZ>z0）」「区間の外まで伸ばす（floorZ<z0）」を同じ式で
 * 扱う——`lo>z0`ならfarVoidで隠し、`lo<=z0`ならfarVoidを作らず素通し、という下のif文自体は
 * 変更していない（`lo`の計算だけを緩めた）。ceilZ側（`hi`）は対称ケースが無いため区間内部の
 * ときだけ（従来どおり）。
 * @param {import('./sectionTypes.js').ZBand} band
 * @param {number} nearestMm - この切断で最も手前の壁面までの距離（壁の深度上限と同じ基準点）
 * @returns {import('./sectionTypes.js').ZBand[]}
 */
export function splitOpenByFarFace(band, nearestMm) {
  if (band.kind !== 'open' || !Number.isFinite(band.farDepthMm)) return [band];
  const { z0, z1, farFloorZ, farCeilZ, farDepthMm, farFloorDepthMm, farCeilDepthMm } = band;
  const floorDepthMm = farFloorDepthMm ?? farDepthMm;
  const ceilDepthMm = farCeilDepthMm ?? farDepthMm;
  const okF = Number.isFinite(floorDepthMm) && floorDepthMm - nearestMm < SIGHTLINE_DEPTH_LIMIT_MM;
  const okC = Number.isFinite(ceilDepthMm) && ceilDepthMm - nearestMm < SIGHTLINE_DEPTH_LIMIT_MM;
  if (!okF && !okC) {
    return [{ kind: 'open', z0: band.z0, z1: band.z1 }]; // 両方上限以上: 水平面は描かず従来どおり全域アキ
  }
  const effFarFloorZ = okF ? farFloorZ : null;
  const effFarCeilZ = okC ? farCeilZ : null;
  const lo = (effFarFloorZ != null && effFarFloorZ < z1 - GAP_EPS) ? effFarFloorZ : z0;
  const hi = (effFarCeilZ != null && effFarCeilZ > z0 + GAP_EPS && effFarCeilZ < z1 - GAP_EPS) ? effFarCeilZ : z1;
  const parts = [];
  if (lo > z0 + GAP_EPS) parts.push({ kind: 'farVoid', z0, z1: lo });
  // **伸ばした側（lo<z0）は`extendedFromZ`に伸ばす前のz0を残す**——`emitOpenGapMarks`の
  // 一点鎖線/破線の切替（baseFloorZより下か）はこの帯**自身**が下の階層へ潜っているかの判定で、
  // 遠側（別の部屋）の低い床へ伸びただけの区間は対象外（実機「11'」A2: 遠側床線自体は図側が
  // 別途「破線」で描くが、アキの対角線・「ア キ」は近側z0が床断面より上のままなら一点鎖線・
  // 文字ありのまま——伸びた区間があるという理由だけで様式を変えない）。
  const extendedFromZ = lo < z0 - GAP_EPS ? z0 : undefined;
  // farFloorDepthMm/farCeilDepthMmは**入力に有ったときだけ**引き継ぐ（`undefined`のプロパティを
  // 常に足すと、値を持たないテスト用の帯リテラルとの`deepEqual`比較が値の有無だけで壊れる）。
  parts.push({ kind: 'open', z0: lo, z1: hi, farFloorZ: effFarFloorZ, farCeilZ: effFarCeilZ, farDepthMm,
    ...(farFloorDepthMm !== undefined ? { farFloorDepthMm } : {}),
    ...(farCeilDepthMm !== undefined ? { farCeilDepthMm } : {}),
    ...(extendedFromZ !== undefined ? { extendedFromZ } : {}) });
  if (hi < z1 - GAP_EPS) parts.push({ kind: 'farVoid', z0: hi, z1 });
  return parts;
}

/**
 * cut → SectionColumn[]（collectCutBreaks→probeColumn×N→mergeColumns。§4「内部フロー」の
 * 前半部分）。buildSectionFigureの内部処理を切り出したもの——face/floorSegments/ceilingProfile
 * を必要とせずcontentだけを組み立てたい呼び出し側（elevationStairSequence.js等）が
 * 直接使うためexportする（WP-E5b）。
 * @param {import('./sectionTypes.js').SectionCut} cut
 * @param {ReturnType<typeof import('./sectionProbe.js').makeProbeContext>} probeCtx
 * @returns {import('./sectionTypes.js').SectionColumn[]}
 */
export function buildColumns(cut, probeCtx) {
  const breaks = withCeilProfileBreaks(cut, collectCutBreaks(cut, probeCtx));
  const rawColumns = [];
  for (let i = 0; i + 1 < breaks.length; i++) {
    const worldLo = breaks[i], worldHi = breaks[i + 1];
    if (worldHi - worldLo < GAP_EPS) continue;
    const worldMid = (worldLo + worldHi) / 2;
    const localA = localXOf(cut, worldLo), localB = localXOf(cut, worldHi);
    // **展開図では断面の中は描画しない**（ユーザー明示指示2026-08）: 描けるのは床断面線と
    // 天井断面線に挟まれた範囲だけで、天井の向こう（天井裏・上階の躯体）には何も描かない。
    // 天井断面の高さは区間ごとに違う（吹抜けの区間だけ上階天井まで上がる）ため、**天井断面線を
    // 実際に引いている値そのもの**を`cut.ceilProfile`で受け取り、その高さで帯を打ち切る
    // ——エンジン側で天井の有無を推測すると階段帯の見え方まで変わるため、区間の天井を知っている
    // 呼び出し側（elevationVoid.js）から渡す。probeColumn自体はzRange全域を返す契約のまま
    // （不変条件テストが依存）で、描画対象の切り出しはここで行う。
    const ceilZ = ceilProfileZAt(cut.ceilProfile, Math.min(localA, localB), Math.max(localA, localB));
    rawColumns.push({
      x0: Math.min(localA, localB), x1: Math.max(localA, localB), worldLo, worldHi, ceilZ,
      bands: probeColumn(cut, worldMid, probeCtx),
    });
  }
  rawColumns.sort((a, b) => a.x0 - b.x0); // dirSign<0だとworld昇順とlocal昇順が逆転するため並べ替える
  // **見えがかりの奥行き判定**（ユーザー明示指示2026-08。elevationStyle.jsのSIGHTLINE_DEPTH_LIMIT_MM）:
  // その切断で最も手前の壁面（＝主な描画対象）から測って上限以上奥にある壁面は、同じ壁面の凹みでは
  // なく**別の空間**なので、見えがかりにせずアキ（open）にする。旧実装の上限は`withinViewRoom`
  // （帯の部屋の包絡矩形）だけで、部屋の中でありさえすれば何m先の壁でも細線で描いていた
  // （実機「5」D1: 面の平面から3200奥の壁が見えがかりになり、アキが出ていなかった）。
  const nearestMm = nearestSightlineDistMm(rawColumns);
  if (Number.isFinite(nearestMm)) {
    for (const col of rawColumns) {
      // QA是正（Phase4・A）: `wall`→`open`への作り替えでも、`sectionHits.js`が`wall`帯へ
      // 既に載せていたfarFloorZ/farCeilZ/farDepthMm（区間内部にある最も近いfloorFace/ceilFace）を
      // 引き継ぐ——ここで`{kind:'open',z0,z1}`だけを新規生成すると、奥室のCHが自室と異なる図面で
      // 「手前の壁は深度上限超え・でもその向こうの床天井は上限内」という構成の線・アキ縮小が
      // 丸ごと消える（この帯はそのままだと`splitOpenByFarFace`の対象外になってしまうため）。
      // QA是正2026-09（検算）: farFloorDepthMm/farCeilDepthMmも同じ理由で引き継ぐ——引き継がないと
      // `splitOpenByFarFace`が`farDepthMm`（床天井の深度の最小値）へフォールバックし、床・天井を
      // 独立に上限判定する意味が無くなる（実機「10」D1で旧・共有深度の値へ戻る回帰になる）。
      col.bands = col.bands.map(b => (b.kind === 'wall' && Number.isFinite(b.distMm)
        && b.distMm - nearestMm >= SIGHTLINE_DEPTH_LIMIT_MM)
        ? { kind: 'open', z0: b.z0, z1: b.z1, farFloorZ: b.farFloorZ, farCeilZ: b.farCeilZ,
            farDepthMm: b.farDepthMm, farFloorDepthMm: b.farFloorDepthMm, farCeilDepthMm: b.farCeilDepthMm }
        : b);
    }
  }
  // Phase4（水平面ヒットの深度上限適用。`.claude/elevation-redesign.md`§5.5・ユーザー裁定
  // 2026-09-11「2」）: 壁と**同じ場所・同じ基準**（nearestMm・SIGHTLINE_DEPTH_LIMIT_MM）で
  // floorFace/ceilFaceの深度上限を掛ける。
  // QA是正（Phase4・C）: nearestMmが非有限（この切断にwall帯が1枚も無い＝上限の基準点が
  // そもそも無い）ときは、壁の深度上限適用自体が丸ごとスキップされる（上のif）のに、
  // ここだけ素通しすると`emitColumns`がfarFloorZ/farCeilZだけを見て無条件に水平線を描いて
  // しまう——「基準が無いので上限を掛けられない」は「上限を超えている」と同じ扱いにする
  // のが安全側（壁と対称）。`splitOpenByFarFace`へ`-Infinity`を渡すと、有限なfarDepthMmは
  // 必ず`farDepthMm-(-Infinity)=+Infinity>=上限`になり「上限以上」分岐（付帯情報を落として
  // 従来どおり全域アキ）へ入る——新しい特別扱いを増やさずに済む。
  const limitBasisMm = Number.isFinite(nearestMm) ? nearestMm : -Infinity;
  for (const col of rawColumns) {
    col.bands = col.bands.flatMap(b => splitOpenByFarFace(b, limitBasisMm));
  }
  // 可視領域の判定・打ち切りは**全列を揃えてから**行い、判定は必ず**打ち切り前の実体**で行う
  // ——打ち切りながら進めると、既に打ち切った隣の列のz範囲が変わっていて同じ壁と認識できず、
  // 壁厚が2列に割れている壁の片側だけが処理から漏れる（実機「5」D1: 腰壁の手前半分だけ
  // 1F天井まで下り、残り半分が2FLのままで内部に縦線が出た）。
  // `air` は列ごとの到達可能な空気区間（床断面〜天井断面のうち切断壁が占めない範囲の連結成分。
  // sectionVisibility.js）＝「断面の中は描画しない」の判定の一次情報。列へは持たせない
  // ——打ち切り後のbandsとは対応しない中間値で、外へ出すと「どちらが正か」が二重管理になる。
  const air = reachableAirByColumn(rawColumns,
    { loZ: cut.zRange?.loZ ?? 0, ceilOf: c => c.ceilZ ?? cut.zRange?.hiZ ?? 0 });
  // 天井より上に**上階の床が実在するか**を層スタックから直接引いておく（sectionEmit.jsの
  // ceilStepSlabSectionが「上階の床の断面」を描いてよいかの判定に使う）。
  for (const col of rawColumns) {
    col.upperFloorZ = upperFloorZAt(cut, (col.worldLo + col.worldHi) / 2, probeCtx);
  }
  const clipped = rawColumns.map((_, i) => clipBandsToVisible(rawColumns, air, i));
  rawColumns.forEach((col, i) => { col.bands = clipped[i]; });
  return mergeColumns(rawColumns);
}

export function buildSectionFigure(cut, probeCtx, opts = {}) {
  const columns = buildColumns(cut, probeCtx);

  const wallFaces = opts.wallFaces ?? [];
  const primaryWall = opts.primaryWall !== undefined ? opts.primaryWall : findPrimaryWall(columns);
  const face = faceFromCut(cut, wallFaces, primaryWall);

  const floorSegments = floorSegmentsFromColumns(columns, face);
  const ceilingProfile = ceilingProfileFromColumns(columns, cut, face);

  const emitCtx = { ceilZ: opts.ceilZ };
  const content = [
    ...emitColumns(columns, cut, emitCtx),
    ...emitOpenGapMarks(columns, cut, emitCtx),
    ...stairPrimitivesForCut(cut.stairCut ?? null, cut, columns),
  ];

  return {
    seqNo: cut.seqNo, face, floorSegments, ceilingProfile,
    chDimSplitAbsYs: cut.chDimSplitAbsYs, content, skipBaseboard: true, skipWallLabel: true,
    floorSpanX: opts.floorSpanX,
  };
}
