/**
 * 2.5D断面エンジン: 構造梁の展開図への加算寄与（WP-C。第3層＝階段幾何（sectionStair.js）と並ぶ
 * 別の寄与源。architect承認済み実装指示書§5参照）。設計意図は.claude/elevation-model.md
 * 「階をまたぐ2層帯」節参照。純モジュール（node:testから単体import可能。store.js/snap.js/
 * *.jsx/react-konva/appViewport.jsを静的importしない）。
 *
 * 加算レイヤ（構造梁はレイキャスト（sectionProbe.js）の塞ぎ判定には一切参加しない）。ただし見え掛かりの梁は
 * 壁（規則A）・柱の包み込み外形（規則B）に隠れる区間を描かない（下の「見え掛かりの梁を隠す遮蔽」参照）。
 *
 * 各層（cut.layers。自階=floorZMm:0・上階=floorZMm:floorHeight）のgraph.beamsをそのまま拾う——
 * 構造梁は「その梁が実際に立つ階のgraph」に帰属するため（structural-model.md「柱は自階の柱を
 * 自階graphに持つ」と同じ規律を梁にも適用）、伏図と同じ帰属をそのまま展開図の高さ方向へ投影する
 * だけで正しい階の梁が正しい高さに出る。role（primary/secondary/landing等）でのフィルタは
 * **基礎梁(role:'foundation')・土台(role:'sill')の除外のみ**——踊り場受け梁(landing)専用ではなく、
 * その切断が拾う全構造梁が対象、という原則は変えない（追加仕様2026-08「2.5D展開では、基礎、基礎梁の
 * 描画は不要」。土台の除外はQA裁定Minor-1・2026-09-18）。1平面に基礎伏図＋1階伏図の2スロットが乗る
 * （App.jsx）ため、1階のgraph.beamsには基礎梁・土台と1階の梁が同居する——除外しないと室内展開図の
 * 床下に基礎梁・土台が細破線で出る（階段帯はclipを通さないため床下線がそのまま見えてしまう）。
 * 基礎・柱脚（footingMap）・べた基礎（slab role:'mat_foundation'）は元々本モジュールの
 * 対象外（graph.beams/graph.columnsしか読まない）ため、追加の除外は要らない。
 */
import { findSectionEntry, beamDepthMm } from '../../structural/sectionCatalog.js';
// 柱の仕上げ包みの幾何は平面図（renderer/StructuralLayer.jsx）と共有する単一の情報源から取る
// ——同じ柱が図面ごとに違う太さで描かれないため（finish/columnWrap.js のヘッダ参照）。
import {
  bareColumnRect, isColumnInsideWall, wrapColumnWithFinish, wallConcealRange,
} from '../../finish/columnWrap.js';
import { kneeDropRecordForWallSpan, kneeDropZRangesAt, effectiveCeilingHeight } from '../../finish/kneeDropWall.js';
import { buildCellToRoom } from '../../finish/edgeClassify.js';
import { isStairPartitionWall, stairPartitionLines } from '../../finish/stair/stairPartition.js';
import { rulesFor, effectiveStructure } from '../../structural/structureRules.js';
import { ElevationLineRole, GAP_EPS_MM as GAP_EPS, SIGHTLINE_DEPTH_LIMIT_MM } from '../elevationStyle.js';
import { localXOf, worldOf, cutDrawRange, MEMBER_PRIM, WHOLE_OUTLINE } from './sectionTypes.js';
import { halfWallThicknessMm, drawnFloorProfileZMax } from './floorProfileMath.js';
import { emitLine, nearestSightlineDistMm, sectionOutline } from './sectionEmit.js';
// 同じ軸 CL 上の複数壁の材の合併（建具の拘束と共有）
import { boundaryMaterialRange } from '../../openings/openingMove.js';

// 丸ごと描くと決めた断面の輪郭の線に付ける印 WHOLE_OUTLINE の定義は sectionTypes.js（sectionEmit.js が循環 import なしに読めるように）。
// ここから再公開する（enumerable なシンボル。JSON・golden には出ない。ほかの変形でも spread で引き継がれる）。
export { WHOLE_OUTLINE };

// 出所の印 MEMBER_PRIM の定義は sectionTypes.js（sectionEmit.js が循環 import なしに読めるように）。ここから再公開する。
export { MEMBER_PRIM };

/**
 * 部材（梁）の同一性キー。梁の立体は呼び出しごとに作り直される（`structuralContribution`・帯への切り詰め `clipBeamsToBand` の
 * コピー）ため参照では比べられない——通り・スパン・天端・成・幅・層の元の天端が同じなら同じ梁。
 * @param {BeamSolid} b
 * @returns {string}
 */
export function memberKey(b) {
  if (b.xLo !== undefined) return ['c', b.xLo, b.xHi, b.yLo, b.yHi, b.baseZ].join('|'); // 柱（ColumnSolid。U1b B3-3）
  return [b.isVertical ? 'v' : 'h', b.axisWorld, b.spanLo, b.spanHi, b.widthMm, b.layerTopZ ?? b.topZ, b.layerDepthMm ?? b.depthMm].join('|');
}

// 基礎（梁=基礎梁・地中梁 / 柱=杭）を表すrole。展開図では一律に描かない（追加仕様2026-08）。
const FOUNDATION_ROLE = 'foundation';
// 梁のうち展開図に描かない役割（基礎梁に加え、土台=role:'sill'。床下の横架材で室内展開に寄与しない。
// QA裁定Minor-1・2026-09-18——階段帯はclipを通さないため、除外しないと床下の土台線がそのまま出る）。
// 小屋梁（role:'roofBeam'。小屋伏図の構造モード専用で展開図・断面に出さない。ユーザー裁定2026-10-02）も除く。
const EXCLUDED_BEAM_ROLES = new Set([FOUNDATION_ROLE, 'sill', 'roofBeam', 'partitionBeam']);

// beamDepthMm（梁の成。展開図の寄与と平面の立体モデルが共有する唯一の式）は structural/sectionCatalog.js へ
// 移した（plan 側が展開図エンジンの内部を引かないため）。既存の import 先を変えないよう再公開する。
export { beamDepthMm };

/**
 * @typedef {{isVertical:boolean, axisWorld:number, spanLo:number, spanHi:number,
 *   widthMm:number, topZ:number, depthMm:number, layerTopZ:number, layerDepthMm:number, role:string,
 *   embedding:{along:Array<[number,number]>, alongTol:Array<[number,number]>}}} BeamSolid
 *   embedding … 梁と平行な壁の足元（`beamWallEmbedding` の along／alongTol。世界座標・統合済み）。
 *   along はスパンの一部だけを覆う壁の足元区間で、見え掛かり（空中横断・平行）から引く。alongTol は along に隅の取り合いの
 *   許容を（梁のスパンの両端だけ）足した区間で、断面の可視判定（`sectionVisibleInRoom`）が使う。全スパンを壁が隙間なく覆う梁（fullyEmbedded）は
 *   寄与自体から落ちるのでここには来ない。
 */

/**
 * @typedef {{wall:object, storeyLo:number, storeyHi:number, graph:object|null}} WallEntry
 *   壁と、その壁が立つ層の床〜直上の層の床（絶対 z。直上が無ければ Infinity）・壁を持つ層の graph（`wallEntriesOfLayers`）。
 */

/**
 * @typedef {{along:Array<[number,number]>, alongTol:Array<[number,number]>, fullyEmbedded:boolean,
 *   crossBands:Array<[number,number]>, bandsAt:Array<{lo:number, hi:number, faces:number[]}>}} BeamWallEmbedding
 */

/**
 * @typedef {{xLo:number, xHi:number, yLo:number, yHi:number, baseZ:number,
 *   covers:object, trimmed:object,
 *   wallAxes:Array<{isVertical:boolean, axisValue:number}>}} ColumnSolid
 *   平面の占有矩形（軸並行。**ダイヤフラム出・仕上げ包みを含んだ外形**。`finish/columnWrap.js`）
 *   ＋足元の絶対z。covers/trimmed は4面それぞれの包み厚とトリム有無（内訳の記録。描画は矩形だけを
 *   使う）。wallAxes は接続した壁の軸CL値＝「この柱がどの面に現れるか」の索引
 *   （下記 structuralColumnPrimitivesForCut 参照）。柱は「その階の床から天井まで立つ」ものとして
 *   扱い、上端zは持たない（同関数の設計判断を参照）。
 */

// スパン方向の許容＝materialRange の幅（隠す範囲 concealRange の幅ではない。下地帯まで広げても
// 長さ方向の許容を広げる理由は無い——isColumnInsideWall と同じ裁定・QA所見2026-10-07）。梁のスパンの両端にだけ効かせる。
function wallSpanTolMm(wall) {
  const mr = wall.materialRange;
  return mr ? Math.abs(mr.hi - mr.lo) : 0;
}

/**
 * 層のスタック（cut.layers）→ 壁の一覧。各壁に、その壁が立つ層の床〜直上の層の床（絶対 z）を付ける
 * （梁の天がその壁の層にあるかの判定用。`beamWallEmbedding` が使う）。順序は層の順・層内の壁の順。
 * @param {Array<{graph:object, floorZMm:number}>|undefined} layers
 * @returns {WallEntry[]}
 */
export function wallEntriesOfLayers(layers) {
  const floors = (layers ?? []).map(l => l.floorZMm ?? 0);
  return (layers ?? []).flatMap(l => {
    const storeyLo = l.floorZMm ?? 0;
    const above = floors.filter(f => f > storeyLo + GAP_EPS);
    const storeyHi = above.length ? Math.min(...above) : Infinity;
    return (l.graph?.walls ?? []).map(wall => ({ wall, storeyLo, storeyHi, graph: l.graph ?? null }));
  });
}

// 梁の天が壁の層の中にあるか＝天が「その壁の層の床−梁成」〜直上の床の間（壁が立つ床の下の床梁まで。在来木造の横架材は
// 再計算で天端 FL−100 になる〔conformWoodBeamLevels〕ので床ちょうどでは取りこぼす——QA 指摘 2026-10-19。別の層の壁は梁に届かない
// ＝2階の床下の梁を 3階の壁が隠さない）。層の述語はここ 1 箇所。判定には元の天端・成（layerTopZ/layerDepthMm）を使う——
// 部屋帯の clipBeamsToBand が topZ/depthMm を帯の 0..CH へ書き換えた後でも同じ層で数える。
function beamTopInStorey(beam, { storeyLo, storeyHi }) {
  const topZ = beam.layerTopZ ?? beam.topZ, depthMm = beam.layerDepthMm ?? beam.depthMm;
  return topZ >= storeyLo - depthMm - GAP_EPS && topZ <= storeyHi + GAP_EPS;
}

// 壁の高さの種類: 'full'（全高）／'partition'（隔て板。梁を隠さない）／腰壁・垂れ壁の z 範囲の列（kneeDropZRangesAt。壁の層の
// 床〜直上の床の中。垂れ壁は下端が床＋天井高−bottomHeight・上端が直上の床〔最上階は無限＝下端より上の梁をすべて隠す〕）。結果は（隔て板の線の関数, 壁の組）ごとに
// 覚える（同じ切断の中で梁ごとに同じ壁を何度も問うため。切断ごとの壁の組と memo は呼び出しの間で変わらない）。
const cellToRoomMemo = new WeakMap(); // 隔て板の線の関数 → (graph → 部屋の逆引き)。wallZKind の memo と同じ寿命
function ceilingHeightOfWall(graph, wall, scope) {
  if (!graph?.rooms || !wall.axisCL) return null; // 部屋が引けない graph（単体テストの偽物）は天井高が分からない
  const found = kneeDropRecordForWallSpan(graph, wall.axisCL, Math.min(wall.coord1, wall.coord2), Math.max(wall.coord1, wall.coord2));
  if (!found) return null;
  let byGraph = cellToRoomMemo.get(scope);
  if (!byGraph) { byGraph = new Map(); cellToRoomMemo.set(scope, byGraph); }
  if (!byGraph.has(graph)) byGraph.set(graph, buildCellToRoom(graph));
  const mm = effectiveCeilingHeight(graph, found.key, byGraph.get(graph));
  return Number.isFinite(mm) ? mm : null;
}
const wallZKindMemo = new WeakMap();
function wallZKind(entry, partitionLinesOf) {
  let byEntry = wallZKindMemo.get(partitionLinesOf);
  if (!byEntry) { byEntry = new WeakMap(); wallZKindMemo.set(partitionLinesOf, byEntry); }
  let v = byEntry.get(entry);
  if (v === undefined) {
    const { wall, graph, storeyLo, storeyHi } = entry;
    if (isStairPartitionWall(wall, partitionLinesOf(graph))) v = 'partition';
    else if (isKneeOrDropWall(graph, wall)) {
      const mid = (wall.coord1 + wall.coord2) / 2;
      // 垂れ壁の下端は天井から測る（kneeDropWall.js: 床＋天井高−bottomHeight）。天井高は平面・壁描画と同じ供給源
      // （effectiveCeilingHeight）で、分からないときだけ直上の床に倒す。上端は直上の床（天井懐の梁まで壁の中）。
      const ceilH = ceilingHeightOfWall(graph, wall, partitionLinesOf);
      const ceilZ = ceilH != null ? storeyLo + ceilH : storeyHi;
      v = kneeDropZRangesAt(graph, wall, mid, storeyLo, ceilZ)
        .map(r => (r.z1 >= ceilZ - GAP_EPS ? { ...r, z1: storeyHi } : r));
    } else v = 'full';
    byEntry.set(entry, v);
  }
  return v;
}

// この壁はこの梁（天 top・下端 bottom。元の天端・成）を隠せるか。全高の壁は常に（従来どおり z を見ない）。隔て板は隠さない。
// 腰壁・垂れ壁は壁の z 範囲で決める（ユーザー裁定 2026-10-23）: 梁の天が壁の層の床以下（床梁＝壁の真下）なら、床に接する範囲を持つ壁
// （腰壁）は全高の壁と同じ＝幅が材に収まれば壁の中／床に接しない垂れ壁は隠さない。床より上の梁は、梁の z 範囲が壁の範囲に
// 収まるときだけ隠す（腰壁の天端より上の梁・垂れ壁の下端より下の梁は隠さない。垂れ壁の真上の天井懐の梁は隠す）。
function wallHidesBeam(entry, kind, top, bottom) {
  if (kind === 'full') return true;
  if (kind === 'partition') return false;
  if (top <= entry.storeyLo + GAP_EPS) return kind.some(r => r.z0 <= entry.storeyLo + GAP_EPS);
  return kind.some(r => bottom >= r.z0 - GAP_EPS && top <= r.z1 + GAP_EPS);
}

// 壁の一覧（wallEntries）ごとに 1 回だけ、判定で読む値を素の値に写す（壁の向き・軸 CL・スパン・隠せる材の範囲は MobX の
// computed／observable で、梁ごとに全壁を読むとそれだけで支配的な時間になる。finish/columnWrap.js の壁ビューと同じ手口）。
// 配列の同一性で覚える（切断ごと・寄与の組立てごとに作り直される配列。作り直されない間は壁が変わらない前提）。
// key＝壁の束ね方（graph, 軸 CL の id）。軸 CL の無い壁は束ねず単独（壁自身が鍵）。
const wallViewsMemo = new WeakMap();
function wallViewsOf(wallEntries) {
  if (!wallEntries) return [];
  let views = wallViewsMemo.get(wallEntries);
  if (!views) {
    const graphIds = new Map();
    views = wallEntries.map((entry) => {
      const { wall, graph } = entry, id = wall.axisCL?.id;
      let key = wall;
      if (id != null) {
        if (!graphIds.has(graph)) graphIds.set(graph, graphIds.size);
        key = `${graphIds.get(graph)}:${id}`;
      }
      return { entry, wall, graph, storeyLo: entry.storeyLo, storeyHi: entry.storeyHi, isVertical: !!wall.isVertical, key,
        range: wallConcealRange(wall), lo: Math.min(wall.coord1, wall.coord2), hi: Math.max(wall.coord1, wall.coord2),
        tol: wallSpanTolMm(wall) };
    });
    // 壁の層（storeyLo, storeyHi）ごとの束: 梁の天がその層にあるかは層ごとに 1 回で足りる。向きごとの（隠せる材のある）壁と、
    // 束ねごとの隠せる材の範囲の外包も先に作る（梁ごとに全壁を走査しない）
    const byStorey = new Map();
    for (const v of views) {
      const k = `${v.storeyLo}:${v.storeyHi}`;
      if (!byStorey.has(k)) byStorey.set(k, { storeyLo: v.storeyLo, storeyHi: v.storeyHi, views: [], parallel: [[], []], hulls: [new Map(), new Map()] });
      const b = byStorey.get(k);
      b.views.push(v);
      if (!v.range) continue;
      const o = v.isVertical ? 1 : 0;
      b.parallel[o].push(v);
      const h = b.hulls[o].get(v.key);
      if (!h) b.hulls[o].set(v.key, { lo: v.range.lo, hi: v.range.hi });
      else { h.lo = Math.min(h.lo, v.range.lo); h.hi = Math.max(h.hi, v.range.hi); }
    }
    views.buckets = [...byStorey.values()];
    wallViewsMemo.set(wallEntries, views);
  }
  return views;
}

/**
 * 「梁は壁の中か」の唯一の判定（梁の厚み方向の帯を、壁の隠せる材〔`wallConcealRange`〕に照らす）。
 * 隠せる材の範囲は柱と同じ`wallConcealRange`（materialRange ∪ backingRange。finish/columnWrap.js
 * が唯一の供給源——外壁は対称壁のまま materialRange が軸〜外面の片側しか返さないため、
 * materialRange だけで判定すると通り芯上の胴差・桁が「壁の外」になる。ユーザー指示2026-10-07）。厚み方向は
 * **完全に収まる**ことを要求する——壁より太い梁は一部が室内へ現れるため隠さない。層の述語は `beamTopInStorey`。
 *
 * 壁は常に**全高の壁だけ**（腰壁・垂れ壁・隔て板は除く。要 opts.partitionLinesOf、無ければ呼び出しごとに求める）で、
 * 平行な壁（梁と同じ向き）は**同じ軸 CL（同じ graph）の壁を合併して**（下地オーナー壁＋仕上げ薄壁）見る
 * （S3b-1・2026-10-23。それまでは壁 1 枚ごと・全部の壁だった）。軸 CL の無い壁は単独。各フィールドは読まれたときに求める
 * （呼び出しごとに要る値だけ計算）。
 * - along／alongTol／fullyEmbedded … 小区間ごとに、その位置を含む同じ束ねの壁の材の範囲の**和集合**の 1 区間に梁の**幅全体**が収まる区間
 *   （梁のスパンで切って統合）。壁と壁の隙間は橋渡ししない（隙間なしで連なる壁だけが 1 枚とみなされる）。along＝壁の足元そのまま
 *   （許容なし＝自由端で見える梁を隠しすぎない。見え掛かりから引く）。alongTol＝along に、梁のスパンの**両端だけ**隅の取り合い
 *   （chamferWalls が壁の端を半壁厚ほど詰める）ぶんの許容〔`wallSpanTolMm`〕を足した区間（断面の可視判定が引く）。
 *   fullyEmbedded＝alongTol がスパン全体を覆う（梁は壁に隠れて見えない＝寄与から落とす。幅 0 のスパンは 1 点で見る）。
 * - bandsAt … 切断位置 opts.at を含む壁の合併帯（`boundaryMaterialRange`）のうち、梁の**芯**が入るもの
 *   （lo/hi＝合併した帯・faces＝その帯を作る壁の面の座標）。at が数でなければ []。
 * - crossBands … 梁と直交して梁の帯をスパンで覆う壁の帯（壁と壁の取り合いで梁を隠す壁としては数えない帯。スパンが梁の芯で終わる
 *   L 字の隅は数えない＝保守側）。
 *
 * 失敗系（例外は投げず、描く側へ倒す）: 壁なし・層の外の梁・梁が帯に収まらない・非有限の座標・concealRange が null の壁は数えない
 * （＝free・fullyEmbedded false・空の配列）。幅 0 の梁は芯の 1 点で判定する。
 * @param {{isVertical:boolean, axisWorld:number, widthMm:number, spanLo:number, spanHi:number,
 *   topZ?:number, depthMm?:number, layerTopZ?:number, layerDepthMm?:number}} beam - BeamSolid（寄与の組立て中は同じキーの素の値）
 * @param {WallEntry[]} wallEntries - `wallEntriesOfLayers` の結果
 * @param {{partitionLinesOf?:(graph:object)=>any, at?:number}} [opts]
 *   at … bandsAt の切断位置（梁の長さ方向の世界座標）
 * @returns {BeamWallEmbedding}
 */
export function beamWallEmbedding(beam, wallEntries, opts = {}) {
  const at = opts.at ?? null;
  const partitionLinesOf = opts.partitionLinesOf ?? makePartitionLinesOf();
  const lazy = (compute) => { let done = false, value; return () => { if (!done) { value = compute(); done = true; } return value; }; };
  const buckets = wallViewsOf(wallEntries).buckets ?? [];
  const inBuckets = lazy(() => buckets.filter(b => beamTopInStorey(beam, b)));
  const orient = beam.isVertical ? 1 : 0;
  // 全高かの判定（腰壁・垂れ壁・隔て板の照会）は重いので、向き・帯・スパンで絞ってから最後に見る
  const beamTop = beam.layerTopZ ?? beam.topZ, beamBottom = beamTop - (beam.layerDepthMm ?? beam.depthMm);
  const canHide = (v) => wallHidesBeam(v.entry, wallZKind(v.entry, partitionLinesOf), beamTop, beamBottom);
  const parallelAll = lazy(() => inBuckets().flatMap(b => b.parallel[orient]));
  const keyOf = (v) => v.key;
  // 束ねごとの、隠せる材の範囲の外包（絞り込み用。層ごとの外包を重ねる）
  const hulls = lazy(() => {
    const list = inBuckets();
    if (list.length === 1) return list[0].hulls[orient];
    const m = new Map();
    for (const b of list) {
      for (const [k, r] of b.hulls[orient]) {
        const h = m.get(k);
        if (!h) m.set(k, { lo: r.lo, hi: r.hi });
        else { h.lo = Math.min(h.lo, r.lo); h.hi = Math.max(h.hi, r.hi); }
      }
    }
    return m;
  });
  // 平行な全高の壁のうち、梁の [lo,hi] を覆いうる束ねの壁だけ（束ねの外包が [lo,hi] を含まなければ、全高の壁だけにしても
  // 含まない＝他の束ねの壁を調べない。結果は変わらない）。壁の順は保つ。
  const parallelForMemo = new Map();
  const parallelFor = (lo, hi) => {
    const memoKey = `${lo}:${hi}`;
    if (!parallelForMemo.has(memoKey)) {
      const m = hulls();
      parallelForMemo.set(memoKey, parallelAll().filter(e => { const h = m.get(keyOf(e)); return lo >= h.lo - GAP_EPS && hi <= h.hi + GAP_EPS && canHide(e); }));
    }
    return parallelForMemo.get(memoKey);
  };
  // 範囲の列の和集合（GAP_EPS 以内で接するものはつなぐ）のうち、[lo,hi] を含む 1 区間があるか
  const unionContains = (ranges, lo, hi) => {
    const sorted = ranges.map(r => [r.lo, r.hi]).sort((a, b) => a[0] - b[0]);
    let cur = null;
    for (const [a, b] of sorted) {
      if (cur && a <= cur[1] + GAP_EPS) cur[1] = Math.max(cur[1], b);
      else { if (cur && lo >= cur[0] - GAP_EPS && hi <= cur[1] + GAP_EPS) return true; cur = [a, b]; }
    }
    return !!cur && lo >= cur[0] - GAP_EPS && hi <= cur[1] + GAP_EPS;
  };

  // 平行な壁の足元のうち、梁の幅全体が壁の材（束ねた壁の範囲の和集合の 1 区間）に収まる区間。壁の端点で区切った小区間ごとに、
  // 中点を含む同じ束ねの壁の範囲を和集合にして判定する（壁と壁の隙間は橋渡ししない）。許容 withTol は**梁のスパンの両端だけ**
  // （壁の端が梁の端から許容以内なら梁の端まで届くとみなす。隅の取り合い）で、壁と壁の間には効かせない。
  // 長さ 0 のスパンは区間にならない（空）。fullyEmbedded だけが pointOnly で 1 点を見る。
  const embeddedSpans = (withTol, pointOnly = false) => {
    const halfW = (beam.widthMm ?? 0) / 2;
    const bLo = beam.axisWorld - halfW, bHi = beam.axisWorld + halfW;
    const { spanLo, spanHi } = beam;
    if (![bLo, bHi, spanLo, spanHi].every(Number.isFinite) || !(spanHi >= spanLo)) return [];
    const shadows = parallelFor(bLo, bHi).map((v) => {
      let { lo, hi } = v;
      if (withTol) {
        if (lo > spanLo && lo - v.tol <= spanLo + GAP_EPS) lo = spanLo;
        if (hi < spanHi && hi + v.tol >= spanHi - GAP_EPS) hi = spanHi;
      }
      return { key: v.key, range: v.range, lo, hi };
    });
    const embeddedAt = (c) => {
      const byKey = new Map();
      for (const s of shadows) {
        if (c < s.lo || c > s.hi) continue;
        if (!byKey.has(s.key)) byKey.set(s.key, []);
        byKey.get(s.key).push(s.range);
      }
      for (const ranges of byKey.values()) if (unionContains(ranges, bLo, bHi)) return true;
      return false;
    };
    if (spanHi - spanLo <= GAP_EPS) return pointOnly && embeddedAt(spanLo) ? [[spanLo, spanHi]] : [];
    const cuts = [spanLo, spanHi, ...shadows.flatMap(s => [s.lo, s.hi]).filter(x => x > spanLo + GAP_EPS && x < spanHi - GAP_EPS)]
      .sort((a, b) => a - b);
    const out = [];
    for (let i = 0; i + 1 < cuts.length; i++) {
      const [p, q] = [cuts[i], cuts[i + 1]];
      if (q - p > GAP_EPS && embeddedAt((p + q) / 2)) out.push([p, q]);
    }
    return mergeSpans(out);
  };
  const along = lazy(() => embeddedSpans(false));
  const alongTol = lazy(() => embeddedSpans(true));
  const fullyEmbedded = lazy(() => {
    const { spanLo, spanHi } = beam;
    if (!(spanHi - spanLo > GAP_EPS)) return embeddedSpans(true, true).length > 0;
    const spans = alongTol();
    return spans.length === 1 && spans[0][0] <= spanLo + GAP_EPS && spans[0][1] >= spanHi - GAP_EPS;
  });

  const bandsAt = lazy(() => {
    if (!Number.isFinite(at)) return [];
    const entries = parallelFor(beam.axisWorld, beam.axisWorld).filter(v => at >= v.lo - GAP_EPS && at <= v.hi + GAP_EPS);
    const out = [];
    const done = new Set();
    for (const hostEntry of entries) {
      const host = hostEntry.wall;
      if (done.has(host)) continue;
      const group = entries.filter(e => keyOf(e) === keyOf(hostEntry)).map(e => e.wall);
      for (const w of group) done.add(w);
      const band = boundaryMaterialRange(host, { centerCoord: at }, { walls: group }, wallConcealRange);
      if (!(beam.axisWorld >= band.lo - GAP_EPS && beam.axisWorld <= band.hi + GAP_EPS)) continue;
      const faces = group.flatMap(w => {
        const cr = wallConcealRange(w);
        return [w.materialRange?.lo, w.materialRange?.hi, cr?.lo, cr?.hi];
      }).filter(Number.isFinite);
      out.push({ lo: band.lo, hi: band.hi, faces });
    }
    return out;
  });

  const crossBands = lazy(() => {
    const halfW = beam.widthMm / 2; // 幅が無い（undefined）梁は帯が取れない＝数えない
    const bLo = beam.axisWorld - halfW, bHi = beam.axisWorld + halfW;
    const out = [];
    for (const b of inBuckets()) for (const v of b.parallel[1 - orient]) { // 梁と直交する壁
      const cr = v.range;
      if (!(bLo >= v.lo - GAP_EPS && bHi <= v.hi + GAP_EPS)) continue;
      if (!canHide(v)) continue;
      out.push([cr.lo, cr.hi]);
    }
    return out;
  });

  return {
    get along() { return along(); },
    get alongTol() { return alongTol(); },
    get fullyEmbedded() { return fullyEmbedded(); },
    get crossBands() { return crossBands(); },
    get bandsAt() { return bandsAt(); },
  };
}

// 梁の芯が帯自身の部屋の広がり（cut.bandRoomBounds。世界座標の箱）の中にあるか。
// 未設定（部屋が特定できない呼び出し）は制限しない。
export function withinBandRoom(cut, axisWorld) {
  const b = cut.bandRoomBounds;
  if (!b || !Number.isFinite(b.x1) || !Number.isFinite(b.x2)) return true;
  const [lo, hi] = cut.line.isVertical ? [b.x1, b.x2] : [b.y1, b.y2];
  return axisWorld >= lo - GAP_EPS && axisWorld <= hi + GAP_EPS;
}

/**
 * cutの層のうち、**足元がこの切断の描画z範囲の中にある層**の壁だけ（＝描かれる高さで実際に
 * 立ちはだかりうる壁）。上階の壁は帯の天井より上にしか無いので、下階の面から見た遮蔽物には
 * ならない。
 *
 * **これは「遮蔽」用の壁集合であって「埋没」用ではない**——梁の埋没（`beamWallEmbedding`）は
 * 全層の壁を「梁の天がその壁の層にあるか」（`beamTopInStorey`。床の下の床梁まで含む）で
 * 絞る別の判定で、この足元zの判定とは揃えない。2階の床梁は2階の壁に埋まることも1階の壁の上に乗ることもあり、
 * 足元zで層を落とすとその埋没判定が壊れる（＝壁の中の梁断面が室内に出る）。
 *
 * 足元zは「その層の壁が帯の描画z範囲に立っているか」の**プロキシ**（層は「床レベル」しか
 * 持たず、壁の実高さを持たないため）。`below`層（下階）をこの経路へ足す日が来たら、
 * 「足元が下」だけでは上端がz範囲に届くとは限らないので再検討すること。
 *
 * 実機「5」D1で柱の接続（`wallAxes`）を作っているのは**2階**の壁（x=-3000・y -1942.5..-57.5）
 * であり、全層で数えるとその2階の壁自身が条件4を潰して柱型が出ない（帯レベルで実測: 追加0本）。
 * 自階の壁だけで判定すると設計の期待結果（D1に柱型2本）になる。
 */
function wallsBlockingCut(cut) {
  const hiZ = cut.zRange?.hiZ ?? Infinity;
  return (cut.layers ?? []).filter(l => (l.floorZMm ?? 0) < hiZ - GAP_EPS)
    .flatMap(l => l.graph?.walls ?? []);
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
  return beamSolidsByLayer(layers).map(e => e.solid);
}

// structuralContribution の本体。梁の立体に、それが属する層を添えて返す（探査の候補収集 `memberSolidsOfLayers` 用。
// 立体自体の形は変えない）。
function beamSolidsByLayer(layers) {
  // ユーザー実機指摘2026-08「2階床の構造材梁断面は、壁の中なら描画しない」: 壁の材厚の中に
  // 収まる梁は壁に隠れて見えないため寄与から落とす。壁は全レイヤー（自階・上階）から集める
  // ——2階床梁は1階の壁の上に乗る（自階の壁が隠す）ことも、2階の壁の中に入ることもあるため。
  // 壁ごとに、立つ層の床〜直上の層の床（梁の天がその壁の層にあるかの z 判定用。beamWallEmbedding が使う）
  const wallEntries = wallEntriesOfLayers(layers);
  const partitionLinesOf = makePartitionLinesOf();
  const result = [];
  for (const layer of layers ?? []) {
    for (const beam of layer.graph?.beams ?? []) {
      if (EXCLUDED_BEAM_ROLES.has(beam.role)) continue; // 追加仕様2026-08: 基礎梁／土台(role:'sill')は展開図に描かない
      const depthMm = beamDepthMm(beam);
      const topZ = layer.floorZMm + beam.levelOffset;
      const entry = findSectionEntry(beam.sectionDefId);
      const spanLo = Math.min(beam.coord1, beam.coord2), spanHi = Math.max(beam.coord1, beam.coord2);
      // 梁の天がその壁の層にある壁だけで判定する（3階の壁が2階の高さの途中にある梁を隠さない）。
      // 隙間なしで連なる同じ軸の壁の材がスパン全体を覆う梁（fullyEmbedded）は壁に隠れて見えないので寄与に入れない
      const emb = beamWallEmbedding(
        { isVertical: beam.isVertical, axisWorld: beam.axisValue, widthMm: beam.sectionWidth, spanLo, spanHi, layerTopZ: topZ, layerDepthMm: depthMm },
        wallEntries, { partitionLinesOf });
      if (emb.fullyEmbedded) continue;
      result.push({ layer, solid: {
        section: entry ?? null, // 断面形状（H形鋼のフランジ・ウェブ等）を作図で使う
        isVertical: beam.isVertical,
        axisWorld: beam.axisValue,
        spanLo,
        spanHi,
        widthMm: beam.sectionWidth,
        topZ,
        depthMm,
        // 層の判定用の元の天端・成（呼び出し側が topZ/depthMm を帯へ切り詰めても変わらない）
        layerTopZ: topZ,
        layerDepthMm: depthMm,
        role: beam.role,
        // 壁の足元（along＝スパンの一部だけを覆う壁の足元区間で、見え掛かりから引く。ユーザー指摘 2026-10-19 roof-test1 2階 階段 A:
        // 3階の到達辺の床梁が柱で分かれておらず往路側の壁〔3階の階段吹抜けの壁〕の足元を越えて 1 本で続くため、
        // 全スパン判定〔fullyEmbedded〕に掛からず全長が中線で出た）。alongTol＝同じ区間に隅の取り合いの許容を足したもの
        // （断面の可視判定 sectionVisibleInRoom が「室内側へ続く残り」から引く。許容が無いと、壁に埋まった梁の端の隅の詰めぶんの
        // 切れ端が「残り」と数えられる）
        // 読まれたときに求める（図に出る梁はごく一部。alongTol は fullyEmbedded の判定で求め済み）
        embedding: { get along() { return emb.along; }, get alongTol() { return emb.alongTol; } },
      } });
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
 * 鋼管柱はダイヤフラム出（`diaphragmProjection`。構造モードの平面描画・断面図・梁端の停止位置と
 * 同一実装）を外形に含める＝柱の外面はダイヤフラムの外面。
 * @param {Array<{graph:object, floorZMm:number, role:string}>} layers
 * @returns {ColumnSolid[]}
 */
export function structuralColumnContribution(layers) {
  return columnSolidsByLayer(layers).map(e => e.solid);
}

// structuralColumnContribution の本体（柱の立体に属する層を添えて返す。`beamSolidsByLayer` と対）。
function columnSolidsByLayer(layers) {
  // 梁と同じ「壁の中なら描画しない」規則を柱にも適用する（ユーザー実機指摘2026-08。
  // 通り芯の交点には自動補完で柱が立つため、外壁の中に納まる管柱まで柱型として描くと
  // 壁面の途中に実在しない縦線2本が出る＝実機の「C2のX2上のエッジ線」の正体）。
  // 壁より太い柱は室内へ出るため従来どおり柱型として描く（架構としての柱型は正しい表現）。
  //
  // 「壁の中か」は**その柱が立つ階の壁だけ**で判定する（平面図 `columnWrapSolids` の hidden と
  // 同じ入力＝同じ答え。ユーザー指示2026-10-07「平面判定で柱が大きくて壁仕上げに影響が出る時も
  // あるので、展開描画時に判別できるようにする」）。全層の壁で判定すると、1階に壁の無い大部屋の
  // 中に立つ柱が、真上の2階の間仕切り壁に「収まって」隠れる。包み（wrapColumnWithFinish）の
  // 接続索引（wallAxes）だけは従来どおり全層の壁で解く——実機「5」D1のように、面の壁が上階側に
  // しか無い柱をその面へ出す経路が wallsBlockingCut の注記のとおり実在するため。
  const walls = (layers ?? []).flatMap(l => l.graph?.walls ?? []);
  const result = [];
  for (const layer of layers ?? []) {
    // 柱包みを持たない構造（在来木造。structureRules.js drawing.columnFinishWrap）は素の断面で柱型を出す。
    const noCover = !rulesFor(effectiveStructure(layer.graph)).drawing.columnFinishWrap;
    const ownWalls = layer.graph?.walls ?? [];
    for (const column of layer.graph?.columns ?? []) {
      if (column.role === FOUNDATION_ROLE) continue; // 杭は展開図に描かない
      const bare = bareColumnRect(column, layer.floorZMm);
      if (isColumnInsideWall(bare, ownWalls)) continue;
      result.push({ layer, solid: wrapColumnWithFinish(bare, walls, { noCover }) });
    }
  }
  return result;
}

/**
 * ColumnSolid[] → 1つの切断（cut）に対するプリミティブ。その面に現れる柱を、**見付け幅の両端の
 * 縦線2本**（CUT太線）で描く（＝室内展開図の「柱型」）。
 *
 * **「その面に現れるか」は柱が干渉した壁の軸CL（`wallAxes`）と面の軸CLの照合で決める**
 * （実機フィードバック修正2026-08「平面で柱芯を動かしても展開に表れない」の根本原因）——
 * 旧実装は「柱の断面が切断線をまたぐか」で判定していたが、切断線は面の**壁芯CL**である一方、
 * 実データの壁は下地オーナー壁＋仕上げ薄壁方式のため材厚が壁芯から数十mm室内側にある
 * （実機ログ: 面の壁芯 -7000 に対し干渉壁の材厚は[-6955,-6942.5]、柱の外面は-6975）。
 * 柱芯オフセット（ラーメン系では常態）と重なると、壁を貫いて室内へ出ている柱＝まさに覆う対象が
 * 一本残らず落ちていた。**壁と干渉している柱はその壁の面に現れる**——これが柱と面を結ぶ本来の
 * 関係で、壁芯を跨ぐかどうかは実データでは成り立たない代理条件だった。
 * 柱の断面が切断線を実際にまたぐ場合（壁を持たない位置の柱・単体テストのフェイク）は従来どおり
 * 描く。どちらも成り立たない独立柱は描かない（面より手前に立つ独立柱の見えがかりは defer のまま）。
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
/**
 * far側（面の向こう側）の柱でも室内から実際に見えるか（上記 onNearSide の例外。ユーザー実機指摘
 * 2026-09「「5」D1: 1階天井見えがかりの下にY1-X2の柱型がない」）。
 *
 * **onNearSide は「そこに壁が在る」ことを前提にした除外**（「4」B: 壁を共有する2部屋のうち柱は
 * 片側にしか出っ張らない）。その前提が崩れる区間——**その面の通りに、柱のrun範囲と重なる壁が
 * 1枚も無い区間**——では柱は素通しで見えるため除外しない。実機「5」D1では、面の通り(x=-3000)の
 * y -1000..-57.5 に壁が無く（同室のセルへ抜けている。旧D2面がdropFacesSeenAsSightlineでD1へ
 * 吸収された範囲）、柱は1階天井見えがかりの下に実際に見える。
 *
 * 判定は次を全て満たすとき（保守側）:
 *  - 切断面からの奥行きが正で、見えがかりとして描く上限（SIGHTLINE_DEPTH_LIMIT_MM）未満。
 *    基準は「切断面からの**絶対**奥行き」——加算レイヤは遮蔽判定を持たない方針
 *    （nearestSightlineDistMmは使わない）を崩さない
 *  - 面の通りに、柱のrun範囲と正の幅で重なる壁が1枚も無い（`wallsBlockingCut`。**一部でも
 *    重なれば描かない**——柱型は見付け幅の両端の縦線2本で、片側が壁に隠れた柱を2本で描くと
 *    見付け寸法が嘘になる）
 *
 * 通りの比較基準は `cut.face?.axisCL?.effectiveValue ?? cut.line.axisValue`。**現在の呼び出し元
 * （`faceSectionCut`）はcutにfaceを積まないため常にfallback側が使われる**——室内側へオフセット
 * 済みのcut（`cutPlaneOffsetMm`を経た切断線）が将来この経路へ来たときのための防御。
 * 既知の限界（defer）: 向こう側の空間の天井が違っても縦線はcut.zRangeで引く／入口条件
 * （onFaceWall||straddles）に掛からない独立柱は向こう側に見えても描かない。
 * @param {import('./sectionTypes.js').SectionCut} cut
 * @param {ColumnSolid} col
 * @param {number} axis - cut.line.axisValue
 * @param {1|-1} viewSign
 * @param {number} acrossLo - 厚み方向（面に垂直）の柱の範囲
 * @param {number} acrossHi
 * @returns {boolean}
 */
function visibleAcrossWallGap(cut, col, axis, viewSign, acrossLo, acrossHi) {
  // 層そのものが無いcut（壁データを渡さない単体テスト・フェイク）は「壁の有無を判断できない」
  // ため、保守側＝従来どおり描かないへ倒す。壁が1枚も無いgraphを持つ層は「壁が無い」という
  // 情報なので対象（layers自体が空のときだけの既定）。
  if ((cut.layers ?? []).length === 0) return false;
  const nearEdge = viewSign > 0 ? acrossHi : acrossLo;
  const depthNear = (axis - nearEdge) * viewSign;
  if (!(depthNear > GAP_EPS && depthNear < SIGHTLINE_DEPTH_LIMIT_MM)) return false;
  const faceAxis = cut.face?.axisCL?.effectiveValue ?? cut.line.axisValue;
  if (!Number.isFinite(faceAxis)) return false;
  const [runLo, runHi] = cut.line.isVertical ? [col.yLo, col.yHi] : [col.xLo, col.xHi];
  return !wallsBlockingCut(cut).some(w => !!w.isVertical === !!cut.line.isVertical
    && Math.abs((w.axisCL?.effectiveValue ?? NaN) - faceAxis) <= GAP_EPS
    && rangesOverlap(Math.min(w.coord1, w.coord2), Math.max(w.coord1, w.coord2), runLo, runHi));
}

export function structuralColumnPrimitivesForCut(contribution, cut, opts = {}) {
  const prims = [];
  const loZ = cut.zRange?.loZ ?? 0;
  const hiZ = cut.zRange?.hiZ ?? 0;
  for (const col of contribution ?? []) {
    // opts.dropped（U1b B3-3）… 渡したときは、帯（memberFace の column）が持たない柱（列の端を捨てた。`droppedMemberKeysOf`）だけを従来の規則で描く
    // （帯が持つ柱は帯が描く）。省略は従来どおり全部（単体テスト・帯を持たない呼び出し）
    if (opts.dropped && !opts.dropped.has(memberKey(col))) continue;
    const z0 = Math.max(col.baseZ, loZ);
    if (z0 >= hiZ - GAP_EPS) continue; // 上階の柱等、この帯の描画範囲に掛からない
    // ①この面の壁と接続しているか（軸CLの照合。上記参照）②または断面が実際に切断線をまたぐか。
    const onFaceWall = (col.wallAxes ?? []).some(a =>
      a.isVertical === cut.line.isVertical && Math.abs(a.axisValue - cut.line.axisValue) <= GAP_EPS);
    const axis = cut.line.axisValue;
    const [acrossLo, acrossHi] = cut.line.isVertical
      ? [col.xLo, col.xHi] : [col.yLo, col.yHi];
    const straddles = axis >= acrossLo - GAP_EPS && axis <= acrossHi + GAP_EPS;
    if (!onFaceWall && !straddles) continue;
    // **柱が面の室内側（視線側）にあること**（ユーザー実機指摘2026-08「展開図「4」B：「4」の中から
    // 柱型は見えないが、エッジ線が出ている」）——同じ壁を共有する2部屋のうち、柱は壁のどちらか
    // 一方の側にしか出っ張らない。軸CLの照合だけだと壁の向こう側に立つ柱まで両室の面へ出る。
    const viewSign = cut.viewSign === -1 ? -1 : 1;
    const onNearSide = viewSign > 0 ? acrossHi > axis + GAP_EPS : acrossLo < axis - GAP_EPS;
    if (!onNearSide && !visibleAcrossWallGap(cut, col, axis, viewSign, acrossLo, acrossHi)) continue;
    // run方向（見付け方向）は覆い込み後の区間で、面の描画範囲と重なることを要求する。
    const [runLo, runHi] = cut.line.isVertical
      ? [col.yLo, col.yHi] : [col.xLo, col.xHi];
    if (!rangesOverlap(cut.line.lo, cut.line.hi, runLo, runHi)) continue;
    const xA = localXOf(cut, runLo), xB = localXOf(cut, runHi);
    // 線種は中線（SILHOUETTE。ユーザー指示2026-08「展開図の柱型は中線」）——柱型は切断面では
    // なく「室内に出っ張った仕上げ面の見えがかり」であり、床線・天井線と同じ太線では強すぎる。
    prims.push(emitLine(cut, xA, z0, xA, hiZ, ElevationLineRole.SILHOUETTE));
    prims.push(emitLine(cut, xB, z0, xB, hiZ, ElevationLineRole.SILHOUETTE));
  }
  return prims;
}

// ---- 見え掛かりの梁を隠す遮蔽（壁＝規則A・柱の包み込み外形＝規則B）----
// 構造梁レイヤは元々遮蔽を持たない加算レイヤだが、**壁・柱に隠れる区間**だけは描かない。判定は固定mmの
// 閾値でなく構造上の述語（壁が切断線と梁の間に立つか／梁の帯が柱の外形に収まるか）で行う。
// 経緯: 13.stq「7」C に、2階graphに生まれた踊り場受け梁（LG。読込み時の構造再計算で到達階に生成される）が
// 柱包みの中の32.5mmだけ見え掛かりとして出た。保存データの golden では LG が無く検出できなかった。

// 区間 [lo,hi] の集合を昇順に統合する。
function mergeSpans(spans) {
  const sorted = spans.filter(([lo, hi]) => Number.isFinite(lo) && Number.isFinite(hi) && hi > lo)
    .sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [lo, hi] of sorted) {
    const last = out[out.length - 1];
    if (last && lo <= last[1] + GAP_EPS) last[1] = Math.max(last[1], hi);
    else out.push([lo, hi]);
  }
  return out;
}

// [lo,hi] から hidden（mergeSpans 済み）を引いた残りの区間。
function subtractSpans(lo, hi, hidden) {
  const out = [];
  let cur = lo;
  for (const [hLo, hHi] of hidden) {
    if (hHi <= cur + GAP_EPS) continue;
    if (hLo >= hi - GAP_EPS) break;
    if (hLo > cur + GAP_EPS) out.push([cur, hLo]);
    cur = Math.max(cur, hHi);
  }
  if (hi > cur + GAP_EPS) out.push([cur, hi]);
  return out;
}

// 区間を述語の値で分けるときの粗いサンプル間隔と、境界を詰める二分の回数（50mm を 2^12 で割る＝約 0.01mm）。
// 述語（その位置の天井より梁が上か）は区間に沿って区分的に一定（セル・レーンの境で変わる）で、変わる所は数か所しか無い前提。
const PREDICATE_SAMPLE_STEP_MM = 50;
const PREDICATE_BISECT_ITERS = 12;

/**
 * 区間 [lo, hi] のうち述語 hidden(x) が偽の部分（見える部分）を区間列で返す。粗いサンプル（各小区間の中央）で状態を取り、
 * 隣り合うサンプルで状態が変わる所は二分で境界を詰める。サンプル間隔より狭い変化は拾えない（受容）。
 * @param {number} lo
 * @param {number} hi
 * @param {(x:number)=>boolean} hidden
 * @returns {Array<[number, number]>}
 */
function splitRangeByPredicate(lo, hi, hidden) {
  const n = Math.max(3, Math.ceil((hi - lo) / PREDICATE_SAMPLE_STEP_MM));
  const step = (hi - lo) / n;
  const xs = Array.from({ length: n }, (_, i) => lo + step * (i + 0.5));
  const states = xs.map(hidden);
  const boundary = (a, b, sa) => { // sa＝a 側の状態。a と b の間で状態が変わる位置
    let p = a, q = b;
    for (let i = 0; i < PREDICATE_BISECT_ITERS; i++) {
      const m = (p + q) / 2;
      if (hidden(m) === sa) p = m; else q = m;
    }
    return Math.round((p + q) / 2 * 1000) / 1000; // 二分の端数（≈0.01mm）を 1/1000mm に丸める（golden の座標を安定させる）
  };
  const out = [];
  let start = states[0] ? null : lo;
  for (let i = 1; i < n; i++) {
    if (states[i] === states[i - 1]) continue;
    const x = boundary(xs[i - 1], xs[i], states[i - 1]);
    if (states[i]) { if (start != null && x - start > GAP_EPS) out.push([start, x]); start = null; } else start = x;
  }
  if (start != null && hi - start > GAP_EPS) out.push([start, hi]);
  return out;
}

// 層の graph → 隔て板の線（stairPartitionLines）の memo 付き関数。切断ごとに 1 つ作る。
function makePartitionLinesOf() {
  const memo = new Map();
  return (graph) => {
    if (!memo.has(graph)) memo.set(graph, stairPartitionLines(graph));
    return memo.get(graph);
  };
}

// 腰壁・垂れ壁（全高でない壁）か。遮蔽には使わない（保守側＝梁を描く）。
// 供給源は断面エンジン・平面と同じ finish/kneeDropWall.js（key解読の唯一の窓口）。
function isKneeOrDropWall(graph, wall) {
  if (!graph?.kneeDropWalls || !wall?.axisCL) return false;
  const found = kneeDropRecordForWallSpan(graph, wall.axisCL,
    Math.min(wall.coord1, wall.coord2), Math.max(wall.coord1, wall.coord2));
  return !!(found && (found.rec?.knee || found.rec?.drop));
}

/**
 * 梁を遮蔽に使える壁（梁の z 範囲 [天−成, 天] を**完全に覆う**全高の壁）。壁の z 範囲＝その層の床〜直上の層の床
 * （無ければ無限。columnCoveredSpans と同じ求め方）。はみ出す梁は保守側＝隠さない（2 層帯で別の層の壁が梁を隠さない）。
 * 腰壁・垂れ壁・隔て板（天端が斜め）は全高とみなさず除く。壁の向き・位置の絞り込みは呼び出し側。
 * partitionLinesOf は層の graph → stairPartitionLines の結果（切断ごとに 1 回求めて memo したもの）。
 * @returns {object[]}
 */
function fullHeightWallsCovering(cut, beam, partitionLinesOf) {
  const layers = cut.layers ?? [];
  const floors = layers.map(l => l.floorZMm ?? 0);
  const bottom = beam.topZ - beam.depthMm;
  const out = [];
  for (const layer of layers) {
    const lo = layer.floorZMm ?? 0;
    const above = floors.filter(fl => fl > lo + GAP_EPS);
    const hi = above.length ? Math.min(...above) : Infinity;
    if (!(bottom >= lo - GAP_EPS && beam.topZ <= hi + GAP_EPS)) continue;
    const walls = layer.graph?.walls ?? [];
    if (walls.length === 0) continue;
    const partitionLines = partitionLinesOf(layer.graph);
    for (const wall of walls) {
      if (isKneeOrDropWall(layer.graph, wall) || isStairPartitionWall(wall, partitionLines)) continue;
      out.push(wall);
    }
  }
  return out;
}

/**
 * 規則A: 切断線と梁の間（室内側。airborne と同じ向き）に立つ、梁と同じ向きの全高の壁が覆うスパン区間。
 * 壁は fullHeightWallsCovering（梁の z 範囲を完全に覆う全高の壁）。壁の位置（wallConcealRange）が切断線と
 * 梁の手前の縁の間に完全にあるものだけ。面自身の壁（芯が切断線上）は梁の手前ではないので数えない。
 * @returns {Array<[number, number]>} 世界座標のスパン区間
 */
export function wallCoveredSpans(cut, beam, halfW, partitionLinesOf) {
  const sign = cut.viewSign ?? 1;
  const axis = cut.line.axisValue;
  const dNear = (beam.axisWorld - axis) * sign - halfW;
  const spans = [];
  for (const wall of fullHeightWallsCovering(cut, beam, partitionLinesOf)) {
    if (!!wall.isVertical !== !!beam.isVertical) continue;
    const cr = wallConcealRange(wall);
    if (!cr) continue;
    const d1 = (cr.lo - axis) * sign, d2 = (cr.hi - axis) * sign;
    const dLo = Math.min(d1, d2), dHi = Math.max(d1, d2);
    const dCenter = ((wall.axisValue ?? (cr.lo + cr.hi) / 2) - axis) * sign;
    if (!(dCenter > GAP_EPS && dLo >= -GAP_EPS && dHi <= dNear + GAP_EPS)) continue;
    spans.push([Math.min(wall.coord1, wall.coord2), Math.max(wall.coord1, wall.coord2)]);
  }
  return spans;
}

/**
 * 規則B: 梁の厚み方向の帯が柱の包み込み外形（仕上げが端を隠す）に完全に収まり、z が重なる柱の
 * スパン範囲。柱の上限は、その柱の層の直上の層の床（無ければ無限）。
 * @returns {Array<[number, number]>} 世界座標のスパン区間
 */
export function columnCoveredSpans(columnSolids, layers, beam, halfW) {
  const bLo = beam.axisWorld - halfW, bHi = beam.axisWorld + halfW;
  const bottom = beam.topZ - beam.depthMm;
  const floors = (layers ?? []).map(l => l.floorZMm).filter(Number.isFinite);
  const spans = [];
  for (const col of columnSolids ?? []) {
    const [aLo, aHi] = beam.isVertical ? [col.xLo, col.xHi] : [col.yLo, col.yHi];
    const [sLo, sHi] = beam.isVertical ? [col.yLo, col.yHi] : [col.xLo, col.xHi];
    if (!(bLo >= aLo - GAP_EPS && bHi <= aHi + GAP_EPS)) continue;
    const above = floors.filter(f => f > col.baseZ + GAP_EPS);
    const ceilZ = above.length ? Math.min(...above) : Infinity;
    if (!(beam.topZ > col.baseZ && bottom < ceilZ)) continue;
    spans.push([sLo, sHi]);
  }
  return spans;
}

// 切断ごとの壁の文脈: 層の壁の一覧（beamWallEmbedding の入力）と、層の graph → 隔て板の線の memo。
function makeWallContext(cut, partitionLinesOf) {
  return { wallEntries: wallEntriesOfLayers(cut.layers), partitionLinesOf };
}

// 梁と直交して梁の帯を覆う全高の壁の帯（beamWallEmbedding の crossBands）。断面の埋没判定（isBeamEmbeddedAtCut）と
// 可視判定（sectionVisibleInRoom）が共有する。
function crossWallBands(beam, wc) {
  return beamWallEmbedding(beam, wc.wallEntries, { partitionLinesOf: wc.partitionLinesOf }).crossBands;
}

// 切断位置で梁を内に持つ壁の合併帯（beamWallEmbedding の bandsAt）。
function parallelWallBandsAt(cut, beam, wc) {
  return beamWallEmbedding(beam, wc.wallEntries,
    { partitionLinesOf: wc.partitionLinesOf, at: cut.line.axisValue }).bandsAt;
}

/**
 * 切断位置で梁が壁に埋まっているか（旧 isBeamInWallAt の一般化）。
 * 梁と平行な壁の足元（`beam.embedding.along`。層判定あり・tol なし）から、「梁と直交する壁」の帯（`crossBands`。
 * 壁と壁の取り合いで、梁を隠す壁としては数えない。切断位置を含まない帯を引いても
 * 切断位置の内外は変わらないので、切断位置を含む帯への絞り込みはしない）を除き、残った区間の**内部**に切断位置があれば埋まっている。
 * 直交壁のスパンが梁の帯を覆わない（梁の芯で終わる L 字の隅）なら帯を除かない＝埋まっている扱い（保守側）。
 * 区間の端は内部に含めない（eps = GAP_EPS_MM。壁の端は通り芯由来の座標でサブミクロンの誤差しか持たないので、
 * 端ちょうどの判定を安定させるだけの小さな値）。
 * 面の向こう側の同じ通りの壁は、切断位置の直交壁の帯の中で尽きるので数えない（A2）。
 * 平行な壁の途中で切る（階段帯）なら直交壁が無く、除かれないので埋まっている。
 */
function isBeamEmbeddedAtCut(cut, beam, wc) {
  const at = cut.line.axisValue;
  const merged = mergeSpans(crossWallBands(beam, wc));
  for (const [lo, hi] of beam.embedding?.along ?? []) {
    for (const [a, b] of subtractSpans(lo, hi, merged)) {
      if (at > a + GAP_EPS && at < b - GAP_EPS) return true;
    }
  }
  return false;
}

/**
 * 探査の候補収集（`sectionHits.js addMemberHits`。展開図リファクタ U1b）が使う、層の梁・柱の立体。
 * 立体は `structuralContribution`／`structuralColumnContribution` と同じ（壁に埋まりきった梁・壁の中の柱は含まない）。
 * 各要素に属する層（`layer`）を添える。`isEmbeddedAtCut` は「切断位置でその梁が壁に埋まっているか」
 * （`isBeamEmbeddedAtCut`。梁と平行な壁の足元に切断位置の区間が入るか。壁の一覧は渡した layers のもの）。
 * @param {Array<{graph:object, floorZMm:number, role:string}>} layers
 * @returns {{beams:Array<{layer:object, solid:BeamSolid}>, columns:Array<{layer:object, solid:ColumnSolid}>,
 *   isEmbeddedAtCut:(cut:import('./sectionTypes.js').SectionCut, beam:BeamSolid)=>boolean}}
 */
export function memberSolidsOfLayers(layers) {
  const wc = { wallEntries: wallEntriesOfLayers(layers), partitionLinesOf: makePartitionLinesOf() };
  const columns = columnSolidsByLayer(layers);
  const columnSolids = columns.map(e => e.solid);
  return {
    beams: beamSolidsByLayer(layers),
    columns,
    isEmbeddedAtCut: (cut, beam) => isBeamEmbeddedAtCut(cut, beam, wc),
    // 断面・見え掛かりを描くかの共通判定（`beamSectionShown`・`beamBelowProfile`・`memberOutlineFloorState`。visibleBeamPieces と共有）
    // が使う、渡した層の壁の文脈と柱（規則B）。
    wc, columnSolids, layers,
  };
}

/**
 * 梁の断面が見えるか＝切断位置 at から**室内側へ梁が実際に続き、その続きが壁の材厚・柱包みに隠れずに残る**か。
 * 室内側の区間（viewSign>0 なら [at, spanHi]・<0 なら [spanLo, at]）から、(1) 梁と直交する全高の壁の材厚
 * （梁の帯を壁のスパンが覆うもの。`crossBands`）と (2) 柱包みのスパン範囲を引いて、
 * 残りが無ければ断面は壁・柱の中で終わっていて見えない。切断線が壁の中に無い（階段帯の室内側オフセット済み）
 * ときは壁の控除は掛からず、柱包みだけが効く。
 *
 * (3) 梁と平行な壁の足元（`beam.embedding.alongTol`。梁の帯が壁の材厚に完全に収まり、梁の天がその壁の層にある壁）も引く。
 * 切断位置が壁のスパンの中でも、梁がその壁の先（室内側）へ続けば断面は見える（面の向こう側の同じ通りの壁が断面を消さない）。
 * 梁が壁の中に収まって室内側に残りが無ければ描かない（旧: 切断位置の1点だけで見る isBeamInWallAt。2026-10-22 に一般化して削除）。
 */
function sectionVisibleInRoom(cut, beam, colSpans, wc, fromRoomSide = false) {
  const at = cut.line.axisValue;
  const wallSpans = crossWallBands(beam, wc);
  // fromRoomSide … 部屋帯の面の切断（壁を見る向き = viewSign は室内から壁へ向かう）では、室内側は viewSign の逆
  const sign = (cut.viewSign ?? 1) * (fromRoomSide ? -1 : 1);
  const [rLo, rHi] = sign > 0 ? [at, beam.spanHi] : [beam.spanLo, at];
  if (!(rHi - rLo > GAP_EPS)) return false;
  // 室内側の区間から壁の材厚と柱包みを引く（仕上げ薄壁・下地オーナー壁など隣り合う壁は統合で連なる。
  // 室内側の遠方の壁が梁の途中を隠しても、手前に残りがあれば断面は見える）
  const hidden = mergeSpans([...wallSpans, ...colSpans, ...(beam.embedding?.alongTol ?? [])]);
  return subtractSpans(rLo, rHi, hidden).some(([lo, hi]) => hi - lo > GAP_EPS);
}

/**
 * 梁の天が断面線（階段帯の `gapFloorProfile`）より梁成以上下に離れて浮いているか（階段下に浮く設置階 FL の梁）。
 * 踊り場受け梁（role:'landing'）は対象外。floorProfile が無い（null）なら false。
 * `visibleBeamPieces` と探査の候補収集（sectionHits.js）が共有する。
 */
export function beamBelowProfile(floorProfile, beam, xa, xb) {
  return beam.role !== 'landing'
    && beam.topZ + beam.depthMm < drawnFloorProfileZMax(floorProfile, xa, xb) - GAP_EPS;
}

/**
 * 切断と直交する梁の断面を描くか（`visibleBeamPieces` の 'section' 判定と、探査の候補収集 `addMemberHits` が共有する唯一の実装）。
 * - **梁の位置が切断線の描画範囲内であること**（面のはるか外——実機「6」では x=-6882.5 や x=-3325、面は 0..2885／-285..3442.5——にある
 *   別スパンの梁の断面まで描いていた。ユーザー実機指摘2026-08「壁の中にある2階床梁の断面描画不要」）。梁が室境界の壁芯（CL）に
 *   乗る場合を取りこぼさないよう、梁の半幅ぶんのはみ出しは許容する。壁のない端部の探査延長も範囲に含める。
 * - 断面線（floorProfile）より下に浮いていない。
 * - 切断位置で梁が壁に埋まっていない（壁の断面の中に梁断面を重ねない）。
 * - 切断位置から室内側へ梁が続き、続きが壁の材厚・柱包みに隠れない（`sectionVisibleInRoom`）。
 * @param {import('./sectionTypes.js').SectionCut} cut
 * @param {BeamSolid} beam
 * @param {{wc:{wallEntries:object[], partitionLinesOf:Function}, colSpans?:Array<[number,number]>,
 *   columnSolids?:ColumnSolid[]|null, layers?:object[], floorProfile?:Array<[number,number]>|null, fromRoomSide?:boolean}} ctx
 *   colSpans（規則Bの柱包みのスパン）を省略したときは columnSolids＋layers から求める。
 * @returns {boolean}
 */
export function beamSectionShown(cut, beam, ctx) {
  const halfW = beam.widthMm / 2;
  const x = localXOf(cut, beam.axisWorld);
  if (!withinCutDrawRange(cut, x, halfW)) return false;
  if (beamBelowProfile(ctx.floorProfile ?? null, beam, x - halfW, x + halfW)) return false;
  if (isBeamEmbeddedAtCut(cut, beam, ctx.wc)) return false;
  const colSpans = ctx.colSpans ?? (ctx.columnSolids ? columnCoveredSpans(ctx.columnSolids, ctx.layers, beam, halfW) : []);
  return sectionVisibleInRoom(cut, beam, colSpans, ctx.wc, !!ctx.fromRoomSide);
}

/**
 * 切断線の帯の中を通る梁（along）を描くか（`visibleBeamPieces` の non-facePlane parallel の入口判定と共有）:
 * 梁のスパンが切断線の範囲に掛かり、断面線より下に浮いていない。
 */
export function beamAlongShown(cut, beam, floorProfile = null) {
  if (!rangesOverlap(cut.line.lo, cut.line.hi, beam.spanLo, beam.spanHi)) return false;
  const xa = localXOf(cut, beam.spanLo), xb = localXOf(cut, beam.spanHi);
  return !beamBelowProfile(floorProfile, beam, Math.min(xa, xb), Math.max(xa, xb));
}

/**
 * 自階の床（スラブ）の遮蔽（`occludeByFloor`）が、梁の断面の輪郭 1 つをどう扱うか。階段帯の探査の候補収集が、部材ごとに 1 回だけ問う
 * （`occludeByFloor` の輪郭の単位の判定と同じ式。判定は梁の幅の x 範囲だけで決まるので全列同じ答え）。
 *  'clip' … 床なし区間と重ならない → 線ごとに（列の床で）切る／'whole' … 床なし区間の中、または境界をまたぐが階段側の壁が
 *  断面を覆わない → 丸ごと描く／'drop' … 境界をまたぎ階段側の壁が覆う（壁の中）→ 丸ごと描かない。
 * @param {import('./sectionTypes.js').SectionCut} cut
 * @param {BeamSolid} beam
 * @param {Array<{lo:number, hi:number}>} floorlessRanges
 * @param {{wallEntries:object[], partitionLinesOf:Function}} wc
 * @returns {'clip'|'whole'|'drop'}
 */
export function memberOutlineFloorState(cut, beam, floorlessRanges, wc) {
  const halfW = beam.widthMm / 2, x = localXOf(cut, beam.axisWorld);
  const gLo = x - halfW, gHi = x + halfW;
  const overlapping = (floorlessRanges ?? []).filter(r => r.lo < gHi - GAP_EPS && r.hi > gLo + GAP_EPS);
  if (overlapping.length === 0) return 'clip';
  const dirs = overlapping.flatMap(r => [
    ...(r.lo > gLo + GAP_EPS && r.lo < gHi - GAP_EPS ? [1] : []),
    ...(r.hi > gLo + GAP_EPS && r.hi < gHi - GAP_EPS ? [-1] : []),
  ]);
  return dirs.every(d => !stairSideWallCovers(cut, beam, halfW, x, d, wc)) ? 'whole' : 'drop';
}

// [aLo,aHi]と[bLo,bHi]が正の幅で重なるか（sectionStair.jsのrangesOverlapと同じ規約。section/内で
// 独立実装にする——sectionStair.jsへ依存すると階段固有の関数群(landing/flight向け)に構造梁の
// 関心事が紛れ込み、第3層同士が互いに依存する構成になるため）。
function rangesOverlap(aLo, aHi, bLo, bHi) {
  return aLo < bHi - GAP_EPS && aHi > bLo + GAP_EPS;
}

// 断面の輪郭（`sectionOutline`。矩形・H形・角形鋼管）は sectionEmit.js へ移した（断面エンジンの memberCut の描画と加算レイヤが
// 同じ輪郭を使う。sectionEmit.js が sectionStructure.js を import すると循環になるため、輪郭は emitLine の側に置く）。

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
 * @param {Array<[number,number]>|null} [floorProfile] - 断面線（階段帯。2026-10-08裁定「断面の外側は
 *   描かない」）。あれば、**梁の天が輪郭より梁成以上下に離れている**梁（＝階段寄与の anchor に接して
 *   いない。階段下に浮く設置階FLの梁）の断面・平行見えがかりを丸ごと落とす。踊り場受け梁（role:'landing'。
 *   天は踊り場より梁成ぶん＋α下がる）と、上階FL・踊り場に天が梁成以内で届く梁は残す。省略・null は従来どおり。
 * @param {{ceilZAtWorld?:Function, columnSolids?:ColumnSolid[]|null, floorOcclusion?:{floorZ:number, floorlessRanges?:Array<{lo:number, hi:number}>},
 *   wallLineCuts?:Array<{xLo:number, xHi:number, zLo:number, zHi:number, xs:number[]}>, facePlane?:boolean, fromRoomSide?:boolean}} [opts]
 *   facePlane は面の通りの梁（面の軸 cut.face.axisCL が梁の幅の帯の中）を parallel（細線）とする。cut が face を持てば既定 true（false で無効）。
 *   fromRoomSide は断面の続きを室内側（viewSign の逆）で見る。部屋帯だけ true（既定 false。階段帯は従来どおり）。
 *   memberCuts（U1b B3-1）… `{dropped:Set<string>, only?:boolean}`。梁の断面（section）と切断線の帯の中を通る梁（along。面の通りの梁でない parallel）は
 *   探査の選択（memberCut の帯。sectionHits.js）が描く——渡した呼び出しはそれらを返さない。dropped（`memberKey` の集合）は帯が持たない部材
 *   （列の端を捨てた・z 範囲に掛からない・探査の範囲の外。`droppedMemberKeysOf`）で、これだけ従来どおり返す。only:true は dropped の部材
 *   （断面・along・見え掛かり）だけを返す。省略は従来どおり全部返す（単体テスト・帯を持たない呼び出し）。
 *   memberFacesByBand（U1b B3-2）… true なら空中の梁・面の通りの梁の見え掛かりも帯（memberFace）が描くので、dropped でない部材は返さない
 *   （dropped の部材は従来どおり返す）。gapBeamRects の矩形用（`beamBlockerRectsForFace`）は only:true で dropped だけ（U1b B4）。
 *   columnSolids は規則B（柱の包み込み外形に隠れる区間）用。undefined は cut.layers から求め、null は規則Bを使わない（対照用）。
 *   floorOcclusion は自階の床（スラブ）の遮蔽（`occludeByFloor`。出来た全プリミティブに掛かる）。省略は遮蔽なし。
 *   wallLineCuts は出力用の配列: 描いた断面のうち、壁内の梁が壁の面から出ている（部屋側から見える）ものの、壁の断面線を分ける矩形
 *   （`wallLineCutRect`。`xs`＝その壁の面の x。呼び出し側が `removeLinesInsideRects` で壁の線へ適用する）。省略は報告しない。
 * @returns {object[]}
 */
export function structuralPrimitivesForCut(contribution, cut, columns, floorProfile = null, opts = {}) {
  const prims = [];
  const outlines = []; // 断面の閉じた輪郭（床の遮蔽を輪郭の単位で判定する）: {prims, covered(dir)}
  // 層の graph ごとの隔て板の線（切断ごとに 1 回だけ求める。可視区間の判定にも同じものを渡す）
  const wc = makeWallContext(cut, makePartitionLinesOf());
  for (const piece of visibleBeamPieces(contribution, cut, columns, floorProfile, { ...opts, partitionLinesOf: wc.partitionLinesOf, wallEntries: wc.wallEntries })) {
    const { beam, kind, xLo, xHi, zHi, zLo } = piece;
    if (kind === 'section') {
      const halfW = beam.widthMm / 2, x = piece.x;
      const outline = sectionOutline(cut, xLo, xHi, zHi, beam.depthMm, beam.section);
      prims.push(...outline);
      // 断面は閉じた輪郭 1 つの単位で床の遮蔽を判定する（穴の縁で半分だけ開いた形で残さない）。階段側の壁が断面を覆うかは遅延評価
      outlines.push({ prims: outline, covered: (dir) => stairSideWallCovers(cut, beam, halfW, x, dir, wc),
        cutRect: opts.wallLineCuts ? wallLineCutRect(cut, beam, halfW, x, wc) : null });
    } else if (kind === 'airborne') {
      prims.push(emitLine(cut, xLo, zHi, xHi, zHi, ElevationLineRole.SILHOUETTE));
      prims.push(emitLine(cut, xLo, zLo, xHi, zLo, ElevationLineRole.SILHOUETTE));
    } else { // parallel
      prims.push(emitLine(cut, xLo, zHi, xHi, zHi, ElevationLineRole.DETAIL));
      prims.push(emitLine(cut, xLo, zLo, xHi, zLo, ElevationLineRole.DETAIL));
      for (const x of piece.ends) prims.push(emitLine(cut, x, zHi, x, zLo, ElevationLineRole.DETAIL));
    }
  }
  const result = opts.floorOcclusion ? occludeByFloor(prims, opts.floorOcclusion, outlines) : prims;
  if (opts.wallLineCuts) { // 描かれた断面のうち、壁内の梁が壁の面から出ているものの、壁の線を分ける矩形（呼び出し側が壁の断面線へ適用する）
    const drawn = new Set(result);
    for (const g of outlines) if (g.cutRect && g.prims.some(p => drawn.has(p))) opts.wallLineCuts.push(g.cutRect);
  }
  return result;
}

/**
 * 面の平面上の梁か＝切断が面を持ち（cut.face）、その面の軸（壁芯 CL）が梁の幅の帯の中にある。
 * 切断線は室内側へ下がる（section/sectionCutPlane.js）ので、壁の面に載る梁は切断線の帯の外になり、
 * 判定を切断線だけで行うと空中を横切る梁（中線）に変わってしまう（ユーザー裁定 2026-10-23「B1 の梁は細線のまま」）。
 * 部屋帯・階段帯とも cut.face を持てば適用する（`opts.facePlane` 既定 true。S3b-2。以前は部屋帯だけで、階段帯は面の通りの梁を
 * 空中の中線にしていた）。
 */
export function faceAxisInBeam(cut, beam, halfW) {
  const axis = cut.face?.axisCL?.effectiveValue;
  return Number.isFinite(axis) && !!cut.face.isVertical === !!beam.isVertical
    && axis >= beam.axisWorld - halfW - GAP_EPS && axis <= beam.axisWorld + halfW + GAP_EPS;
}

/**
 * 梁ごとに「どの種類（断面・空中の見えがかり・平行の見えがかり）で、どの x 範囲・z 範囲が見えるか」を決める（可視区間の唯一の判定）。
 * 線への写像（`structuralPrimitivesForCut`）・床の遮蔽・輪郭の単位・壁の断面線の分断は含まない。座標は断面ローカル x・絶対 z。
 * 引数は `structuralPrimitivesForCut` と同じ（`opts.partitionLinesOf` を渡すと隔て板の線の計算を呼び出し側と共有する）。
 * @returns {Array<{beam:BeamSolid, kind:'section'|'airborne'|'parallel', xLo:number, xHi:number, zLo:number, zHi:number,
 *   x?:number, ends?:number[]}>}
 *   section … 断面（xLo..xHi＝梁の見付け幅・zHi＝天・zLo＝下端。x＝梁の芯のローカル x）／
 *   airborne … 空中を横切る梁の天地の中線 1 区間（天井・壁・柱に隠れる区間を除いた残り）／
 *   parallel … 切断線の帯の中を通る梁、または面の通りの梁（opts.facePlane）の天地の細線 1 区間（ends＝その区間が梁の元の端である側の縦線の x。昇順）。
 */
export function visibleBeamPieces(contribution, cut, columns, floorProfile = null, opts = {}) {
  const pieces = [];
  // 空中を横断する梁の見えがかりは、その位置の天井（opts.ceilZAtWorld(x, y)。階段帯なら自階の層の cellAt＝裏面）より梁の下端が上なら
  // 天井裏＝描かない（ユーザー指示 2026-10-15「2FL にある横架材見え掛かりは、天井仕上げ面より上〔=天井裏〕につき描画不要」）。
  // 区間の 3 点で見て、どこかで天井より下に出ていれば描く。天井が取れない点は「見える」側に倒す。
  const ceilZAtWorld = typeof opts.ceilZAtWorld === 'function' ? opts.ceilZAtWorld : null;
  // 区間 [loX, hiX] のうち天井より下に出て見える部分（天井は位置ごとに違う＝階段室の裏面は復路レーンの上だけ平らな床構造の中、
  // 往路レーンの上は段の上の空気）。区間全体の全か無かで決めると、両レーンにまたがる 1 本の梁は復路レーンの上の
  // 床構造の中まで全長が描かれる（ユーザー指摘 2026-10-19 roof-test1 2階 階段 A）。
  const visibleBelowCeiling = (beam, loX, hiX) => {
    if (!ceilZAtWorld) return [[loX, hiX]];
    const bottom = beam.topZ - beam.depthMm;
    // 評価点は梁の芯から切断線側へ 1mm 寄せる（梁が部屋の境界の通り芯に乗るとき、境界ちょうどの点が隣室のセルに落ちないように）
    const depth = beam.axisWorld - (cut.viewSign ?? 1);
    const hiddenAt = (x) => {
      const across = worldOf(cut, x);
      const z = cut.line.isVertical ? ceilZAtWorld(depth, across) : ceilZAtWorld(across, depth);
      return Number.isFinite(z) && bottom >= z - GAP_EPS; // 天井が取れない点は見える側
    };
    return splitRangeByPredicate(loX, hiX, hiddenAt);
  };
  // 梁の天地の線を引く区間 [loX, hiX]（断面ローカル x）を、切断線の描画範囲へ切り詰め、天井裏の部分を除いた残り区間にする
  // （airborne と面の通りの parallel が共有。空の配列は描かない）
  const drawnRanges = (beam, loX, hiX) => {
    const { lo: drawLo, hi: drawHi } = cutDrawRange(cut);
    const lo = Math.max(drawLo, loX), hi = Math.min(drawHi, hiX);
    return hi - lo > GAP_EPS ? visibleBelowCeiling(beam, lo, hi) : [];
  };
  const belowProfile = (xa, xb, beam) => beamBelowProfile(floorProfile, beam, xa, xb);
  // 断面（直交する梁）と切断線の帯の中を通る梁（along）は、探査の選択（memberCut の帯。sectionHits.js）が担う。
  // opts.memberCuts を渡した呼び出し側は、帯が持たない部材（列の端を捨てた部材＝nearMembersOf の edgeDropped）の
  // キー集合 dropped だけを加算で描く。省略は従来どおり全部描く（単体テスト・帯を持たない呼び出し）。
  const memberCutsByBand = !!opts.memberCuts;
  const droppedKeys = opts.memberCuts?.dropped ?? new Set();
  // only … 帯が持たない部材（dropped）の断面・along だけを返す（空中・面の通りの見え掛かりは返さない）
  const onlyDropped = !!opts.memberCuts?.only;
  // 見えがかりの奥行き判定は壁と共通（ユーザー明示指示2026-08「既存の構造材見えがかり処理経路も
  // 含める」）——その切断で最も手前の壁面から上限以上奥にある材は、別の空間のものなので描かない。
  const nearestMm = nearestSightlineDistMm(columns);
  const withinSightDepth = (depthMm) => !Number.isFinite(nearestMm)
    || depthMm - nearestMm < SIGHTLINE_DEPTH_LIMIT_MM;
  // 規則B（柱の包み込み外形に隠れる区間）の柱。undefined は cut.layers から求める・null は規則Bを使わない
  // （対照用。明示と省略を区別する）。梁が無ければ求めない。
  let columnSolids = opts.columnSolids;
  if (columnSolids === undefined && (contribution ?? []).length > 0) {
    columnSolids = structuralColumnContribution(cut.layers);
  }
  // 層の graph ごとの隔て板の線（切断ごとに 1 回だけ求める）
  const partitionLinesOf = opts.partitionLinesOf ?? makePartitionLinesOf();
  const wc = { wallEntries: opts.wallEntries ?? wallEntriesOfLayers(cut.layers), partitionLinesOf };
  for (const beam of contribution ?? []) {
    const halfW = beam.widthMm / 2;
    const colSpans = columnSolids ? columnCoveredSpans(columnSolids, cut.layers, beam, halfW) : [];
    // crosses（直交）: sectionStair.jsのcrossesFlightと同じ規約——cut.line自身の描画範囲
    // (lo/hi)は見ず、cut.lineの位置(axisValue)が梁のスパン内かどうかだけで判定する
    // （crossesFlightがflight.runLo/runHiだけを見てcut.line.lo/hiを見ないのと同じ理由：
    // 梁は室境界の壁芯（CL）に乗ることがあり、cut.lineの描画範囲は壁面基準でわずかに
    // 内側へ詰まっている——lo/hiまで要求すると壁芯上の梁を取りこぼす）。
    const crosses = cut.line.isVertical !== beam.isVertical &&
      cut.line.axisValue >= beam.spanLo - GAP_EPS && cut.line.axisValue <= beam.spanHi + GAP_EPS;
    if (crosses) {
      const x = localXOf(cut, beam.axisWorld);
      // 断面は帯（memberCut）が担う。帯が持たない部材（列の端を捨てた部材＝`edgeDropped`）だけ従来どおり加算で描く
      // （帯が描く部材は可視判定を二重に計算しないよう先に外す）
      if (memberCutsByBand && !droppedKeys.has(memberKey(beam))) continue;
      // 断面を描くかの判定（描画範囲内・断面線より下に浮いていない・壁に埋まっていない・室内側の続きが見える）は
      // 探査の候補収集（sectionHits.js addMemberHits）と共有する `beamSectionShown`（唯一の実装）。
      if (!beamSectionShown(cut, beam, { wc, colSpans, floorProfile, fromRoomSide: !!opts.fromRoomSide })) continue;
      pieces.push({ beam, kind: 'section', x, xLo: x - halfW, xHi: x + halfW, zLo: beam.topZ - beam.depthMm, zHi: beam.topZ });
      continue;
    }
    // **室内を空中で横断する梁の見えがかり**（ユーザー実機指摘2026-08「6」A「材が空中に
    // 横断しているので、『A』に中線で鋼材の天地に線を描画」）。切断線と平行だが芯が離れている梁は
    // 旧`parallel`判定（切断線が梁の幅の帯を通ることを要求）に入らず、一切描かれなかった
    // ——実機の梁はY2の通り芯から225mm室内側にあり、面Aから見ると空中を横切って見える。
    // 天地（上端・下端）の2本だけをSILHOUETTE（中線）で描く（輪郭の縦線は持たせない——
    // 梁は面の端から端まで通っており、視界の中で端部が見えるわけではない）。
    // 面の平面上の梁（面の軸が梁の幅の帯の中。切断線が室内側へ下がっていても梁は壁の面に見える）は parallel が担当する
    const onFacePlane = (opts.facePlane ?? true) && faceAxisInBeam(cut, beam, halfW);
    const airborne = cut.line.isVertical === beam.isVertical
      && (beam.axisWorld - cut.line.axisValue) * (cut.viewSign ?? 1) > GAP_EPS
      && withinBandRoom(cut, beam.axisWorld)
      && withinSightDepth((beam.axisWorld - cut.line.axisValue) * (cut.viewSign ?? 1) - halfW)
      && rangesOverlap(cut.line.lo, cut.line.hi, beam.spanLo, beam.spanHi)
      && !onFacePlane
      && !(cut.line.axisValue >= beam.axisWorld - halfW - GAP_EPS
        && cut.line.axisValue <= beam.axisWorld + halfW + GAP_EPS); // 芯上は下のparallelが担当
    // 見え掛かり（空中・面の通り）は、帯（memberFace。U1b B3-2）が持つ部材なら帯が描く。加算で描くのは帯が持たない部材（dropped）だけ
    // （opts.memberFacesByBand）。only は dropped の部材だけを返す呼び出し。どちらも指定が無ければ従来どおり全部（単体テスト）
    const faceHeldByBand = (opts.memberFacesByBand === true || onlyDropped) && !droppedKeys.has(memberKey(beam));
    if (airborne) {
      if (faceHeldByBand) continue;
      // 壁（規則A）・柱（規則B）に隠れるスパン区間を引き、残る区間ごとに天地を描く
      // 壁の足元（beam.embedding.along。スパンの一部だけを覆う壁）も引く——柱で分かれた梁と 1 本で続く梁で描画を変えない
      const hidden = mergeSpans([...wallCoveredSpans(cut, beam, halfW, partitionLinesOf), ...colSpans, ...(beam.embedding?.along ?? [])]);
      for (const [segLo, segHi] of subtractSpans(beam.spanLo, beam.spanHi, hidden)) {
        const xa = localXOf(cut, segLo), xb = localXOf(cut, segHi);
        for (const [vLo, vHi] of drawnRanges(beam, Math.min(xa, xb), Math.max(xa, xb))) {
          pieces.push({ beam, kind: 'airborne', xLo: vLo, xHi: vHi, zLo: beam.topZ - beam.depthMm, zHi: beam.topZ });
        }
      }
      continue;
    }
    const parallel = cut.line.isVertical === beam.isVertical &&
      ((cut.line.axisValue >= beam.axisWorld - halfW - GAP_EPS && cut.line.axisValue <= beam.axisWorld + halfW + GAP_EPS) || onFacePlane) &&
      rangesOverlap(cut.line.lo, cut.line.hi, beam.spanLo, beam.spanHi);
    if (!parallel) continue;
    if (onFacePlane && faceHeldByBand) continue; // 面の通りの梁（見え掛かり）も帯（memberFace）が持つ部材は帯が描く
    const xLo = localXOf(cut, beam.spanLo), xHi = localXOf(cut, beam.spanHi);
    if (belowProfile(Math.min(xLo, xHi), Math.max(xLo, xHi), beam)) continue;
    const zTop = beam.topZ, zBot = beam.topZ - beam.depthMm;
    // 柱（規則B）・壁の足元（beam.embedding.along）に中断される梁は区間ごとに天地を描く。両端の縦線は元の梁の端が残っている区間だけ
    // 面の通りの梁は airborne と同じく壁（規則A）にも隠れる（切断線と梁の間の全高の壁）。切断線の帯の中を通る梁は従来どおり掛けない
    const ruleA = onFacePlane ? wallCoveredSpans(cut, beam, halfW, partitionLinesOf) : [];
    for (const [segLo, segHi] of subtractSpans(beam.spanLo, beam.spanHi, mergeSpans([...ruleA, ...colSpans, ...(beam.embedding?.along ?? [])]))) {
      const xa = localXOf(cut, segLo), xb = localXOf(cut, segHi);
      const loX = Math.min(xa, xb), hiX = Math.max(xa, xb);
      const ends = [];
      if (Math.abs(segLo - beam.spanLo) <= GAP_EPS) ends.push(localXOf(cut, beam.spanLo));
      if (Math.abs(segHi - beam.spanHi) <= GAP_EPS) ends.push(localXOf(cut, beam.spanHi));
      if (!onFacePlane) { // 切断線の帯の中を通る梁は従来どおり（描画範囲・天井裏では切らない）。帯（memberCut along）が持つ部材は帯が描く
        if (memberCutsByBand && !droppedKeys.has(memberKey(beam))) continue;
        pieces.push({ beam, kind: 'parallel', xLo: loX, xHi: hiX, zLo: zBot, zHi: zTop, ends: ends.sort((p, q) => p - q) });
        continue;
      }
      // 面の通りの梁は airborne と同じく描画範囲へ切り詰め、天井裏を除く。縦線は梁の元の端が区間の端に残るときだけ
      for (const [vLo, vHi] of drawnRanges(beam, loX, hiX)) {
        const e = ends.filter(x => Math.abs(x - vLo) <= GAP_EPS || Math.abs(x - vHi) <= GAP_EPS);
        pieces.push({ beam, kind: 'parallel', xLo: vLo, xHi: vHi, zLo: zBot, zHi: zTop, ends: e.sort((p, q) => p - q) });
      }
    }
  }
  return pieces;
}

/**
 * 穴の縁をまたぐ断面を「丸ごと描く」かの判定: 梁の断面の端（階段側）が、階段側の壁の仕上げ面より外にはみ出していれば壁は断面を覆わない。
 * 断面の中心から階段側（`dir`＝面ローカル x の向き。穴は中心から dir 側）の壁の面までの距離 ≦ 中心から断面の端までの距離（半幅）→
 * 覆っていない。壁の面が半幅より遠ければ、断面は壁の中に納まる＝覆っている。等号は覆っていない（描く）。
 * 壁は、梁と平行で梁の芯が材の範囲（`wallConcealRange`）に入り、そのスパンが切断位置を含むもの（層は梁の天がその層にある壁）。
 * 壁が無ければ覆っていない。
 */
function stairSideWallCovers(cut, beam, halfW, xCenter, dir, wc) {
  for (const band of parallelWallBandsAt(cut, beam, wc)) {
    const la = localXOf(cut, band.lo), lb = localXOf(cut, band.hi);
    const face = dir > 0 ? Math.max(la, lb) : Math.min(la, lb); // 階段側の面（合併した帯の外側の面）
    if ((face - xCenter) * dir > halfW + GAP_EPS) return true;
  }
  return false;
}

/**
 * 壁内の梁が、壁の面から断面でのぞく（部屋側から見える）ときの、壁の断面線を分ける矩形（断面ローカル x・絶対 z）。
 * 切断位置で梁を内に持つ壁（`bandsAt`）の面のうち、梁の断面の x 範囲の厳密な内側に入るもの（＝梁が壁の面から出ている。
 * 壁が断面を覆う＝面が半幅より遠いなら入らない）。`xs` はその壁の面の x だけ——矩形が切るのはその面に立つ縦線だけで、床線など
 * ほかの線は切らない。無ければ null（ユーザー裁定 2026-10-23「壁内の梁が部屋側から見える場合だけ分断する」）。
 */
function wallLineCutRect(cut, beam, halfW, x, wc) {
  const xs = [];
  for (const band of parallelWallBandsAt(cut, beam, wc)) {
    for (const f of band.faces) {
      const lx = localXOf(cut, f);
      if (lx > x - halfW + GAP_EPS && lx < x + halfW - GAP_EPS && !xs.some(v => Math.abs(v - lx) <= GAP_EPS)) xs.push(lx);
    }
  }
  if (xs.length === 0) return null;
  return { xLo: x - halfW, xHi: x + halfW, zLo: beam.topZ - beam.depthMm, zHi: beam.topZ, xs };
}

/**
 * 自階の床（スラブ）が構造部材の見え方を隠す一般の遮蔽（ユーザー裁定 2026-10-23「床梁を隠す。展開面の姿も断面も。
 * 常に一般解として」）。床がある列（面ローカル x）では、自階の FL 以下（天端が FL ちょうどの部材も含む）の部分を描かない。
 * 部材の種類（梁・将来の部材）・描き方（見え掛かり・断面）は問わない——線分の z だけで切る。FL をまたぐ線は FL より上だけ残す。
 * 床が無い列（`floorlessRanges`＝階段の穴・下階の階段の吹抜け。`lowerStairVoidRanges` の lo/hi＝切断壁の吹抜け側の面。`floorlessRangesOfCut`）は切らない。
 * 切断位置の x が区間の境界ちょうどの縦線は床の側（隠す側）に倒す（区間の内部だけが床なし）。
 * 部屋帯の `clipBeamsToBand`（梁の z を 0..CH へ切り、断面形状も切った成で作り直す）は「全列に床がある」場合にあたるが、
 * 作り直す形が違うので統一していない。
 * これは線分ごとの切り方（`clipByFloor`）。閉じた輪郭（断面）の単位の判定は `occludeByFloor`。
 * @param {object[]} prims 線分（type:'line'。ほかの型はそのまま）
 * @param {{floorZ:number, floorlessRanges?:Array<{lo:number, hi:number}>}} occlusion
 * @returns {object[]}
 */
function clipByFloor(prims, { floorZ, floorlessRanges = [] }) {
  if (!Number.isFinite(floorZ)) return prims;
  const inHole = (x) => floorlessRanges.some(r => x > r.lo + GAP_EPS && x < r.hi - GAP_EPS);
  const out = [];
  for (const p of prims) {
    if (p.type !== 'line') { out.push(p); continue; }
    const lo = Math.min(p.x1, p.x2), hi = Math.max(p.x1, p.x2);
    if (hi - lo <= GAP_EPS) { // 縦線
      if (inHole(p.x1)) { out.push(p); continue; }
      const z1 = -p.y1, z2 = -p.y2;
      if (Math.max(z1, z2) <= floorZ + GAP_EPS) continue;
      if (Math.min(z1, z2) >= floorZ - GAP_EPS) { out.push(p); continue; }
      out.push(z1 < z2 ? { ...p, y1: -floorZ || 0 } : { ...p, y2: -floorZ || 0 });
      continue;
    }
    // 床なし区間の境界で分け、床の側の片だけ FL 以下を切る（切らない線は分けない）
    const bounds = floorlessRanges.flatMap(r => [r.lo, r.hi]).filter(b => b > lo + GAP_EPS && b < hi - GAP_EPS);
    const dir = Math.sign(p.x2 - p.x1);
    const xs = [p.x1, ...bounds.sort((a, b) => (a - b) * dir), p.x2];
    const yAt = x => p.y1 + ((x - p.x1) / (p.x2 - p.x1)) * (p.y2 - p.y1);
    const pieces = [];
    let changed = false;
    for (let i = 0; i + 1 < xs.length; i++) {
      const a = xs[i], b = xs[i + 1];
      const piece = { ...p, x1: a, y1: yAt(a), x2: b, y2: yAt(b) };
      if (inHole((a + b) / 2)) { pieces.push(piece); continue; }
      const za = -piece.y1, zb = -piece.y2;
      if (Math.max(za, zb) <= floorZ + GAP_EPS) { changed = true; continue; }
      if (Math.min(za, zb) >= floorZ - GAP_EPS) { pieces.push(piece); continue; }
      changed = true; // FL をまたぐ斜めの線: FL より上だけ
      const t = (floorZ - za) / (zb - za); // za→zb で FL に達する割合
      const xc = a + (b - a) * t;
      pieces.push(za < zb ? { ...piece, x1: xc, y1: -floorZ || 0 } : { ...piece, x2: xc, y2: -floorZ || 0 });
    }
    if (!changed) { out.push(p); continue; } // 切っても変わらない線は分けない
    // 床なし区間の境界で分けたまま残った隣り合う同じ線の片はつなぎ直す（破線のパターンが境界で途切れない）
    const merged = [];
    for (const piece of pieces) {
      const last = merged[merged.length - 1];
      const joins = last && Math.abs(last.x2 - piece.x1) <= GAP_EPS && Math.abs(last.y2 - piece.y1) <= GAP_EPS
        && Math.abs((last.y2 - last.y1) * (piece.x2 - piece.x1) - (piece.y2 - piece.y1) * (last.x2 - last.x1)) <= GAP_EPS; // 同じ傾き
      if (joins) { last.x2 = piece.x2; last.y2 = piece.y2; } else merged.push({ ...piece });
    }
    out.push(...merged);
  }
  return out;
}

/**
 * 床の遮蔽（上の説明）を構造のプリミティブへ掛ける。断面の閉じた輪郭（`outlines`: {prims, covered(dir)}）は輪郭 1 つの単位で判定し、
 * 開いた半分を残さない（ユーザー裁定 2026-10-23）:
 *  - 輪郭の x 範囲が床なし区間の中に収まる → 丸ごと描く。
 *  - 床なし区間と重ならない → 線ごとに切る（床の列では FL 以下を描かない）。
 *  - 境界をまたぐ → 階段側の壁が断面を覆っていなければ丸ごと描く（鉄骨梁を見せる設計）。覆っていれば穴の側の半分も含めて丸ごと描かない（壁の中）。
 * 丸ごと描く輪郭の線には `WHOLE_OUTLINE` の印を付ける（以後の線ごとの切り直しから守る。階段帯の `clipContentBelowProfileInRanges` など）。
 * 壁の断面線の分断は別（`wallLineCutRect`・`opts.wallLineCuts`。壁内の梁が壁の面から出ている全ての断面に共通で、穴の縁に限らない）。
 * 輪郭に含まれない線（見え掛かり）は線ごとに切ってよい。
 * @param {object[]} prims
 * @param {{floorZ:number, floorlessRanges?:Array<{lo:number, hi:number}>}} occlusion
 * @param {Array<{prims:object[], covered:(dir:number)=>boolean}>} [outlines]
 * @returns {object[]}
 */
export function occludeByFloor(prims, occlusion, outlines = []) {
  const { floorZ, floorlessRanges = [] } = occlusion;
  if (!Number.isFinite(floorZ)) return prims;
  if (outlines.length === 0) return clipByFloor(prims, occlusion);
  const keepWhole = new Set();
  const dropped = new Set();
  for (const g of outlines) {
    const lines = g.prims.filter(p => p.type === 'line');
    if (lines.length === 0) continue;
    const gLo = Math.min(...lines.flatMap(p => [p.x1, p.x2])), gHi = Math.max(...lines.flatMap(p => [p.x1, p.x2]));
    // 床なし区間と重ならなければ線ごとに切る（whole=false のまま）。重なれば、区間の境界が輪郭の内側にあるか（＝境界をまたぐか）で分ける。
    // 境界が輪郭の内側に無ければ輪郭は区間の中に収まる（外面が縁ちょうども含む）＝丸ごと描く。
    const overlapping = floorlessRanges.filter(r => r.lo < gHi - GAP_EPS && r.hi > gLo + GAP_EPS);
    if (overlapping.length === 0) continue;
    const dirs = overlapping.flatMap(r => [
      ...(r.lo > gLo + GAP_EPS && r.lo < gHi - GAP_EPS ? [1] : []), // 穴は境界 r.lo の +x 側
      ...(r.hi > gLo + GAP_EPS && r.hi < gHi - GAP_EPS ? [-1] : []), // 穴は境界 r.hi の -x 側
    ]);
    const whole = dirs.every(d => !g.covered(d));
    if (!whole) { for (const p of g.prims) dropped.add(p); continue; } // 壁の中なので丸ごと描かない（穴の側の半分も残さない）
    for (const p of g.prims) { keepWhole.add(p); p[WHOLE_OUTLINE] = true; } // 丸ごと描く輪郭（以後の線ごとの切り直しから守る印）
  }
  // 輪郭の線は丸ごと残すか線ごとに切るか。それ以外は線ごとに切る。元の順序を保つ
  const out = [];
  let pending = [];
  const flush = () => { if (pending.length) { out.push(...clipByFloor(pending, occlusion)); pending = []; } };
  for (const p of prims) {
    if (dropped.has(p)) continue;
    if (keepWhole.has(p)) { flush(); out.push(p); } else pending.push(p);
  }
  flush();
  return out;
}
