// 構造部材の自動生成を「建物フットプリント（仕上げモードの部屋領域）」でゲートする純関数群。
//
// 部材の有無を外壁線位置で決めるための実装。外壁は部屋領域の外周に生成される（finish/wallGeneration.js）
// ため、外壁線の位置 ≡ 屋内フットプリントの境界。そこで Wall 実体を読まず、各階の部屋セル
// （kind === INTERIOR。吹抜け等の feature は無関係）を「建物内」フットプリントとして扱い、グリッド辺・交点が
// 建物に接するかで生成可否を取捨する（A案＝セル/部屋ベースのフットプリント判定）。
// ただし階段(STAIR)・階段吹抜け(STAIR_VOID)の属性Roomだけの階は「フットプリント未定義」として扱う
// （establishesFootprint 参照——属性Room単独では建物の囲いを定義しないため）。
//
// 「建物全体の上下階」を加味する規律＝鉛直連続性：部材は「自階かつ直下の全階で建物が連続している」位置だけ
// 残す（自階＋直下フロアのフットプリントをANDで束ねる）。直下に支えの無い位置の梁・柱（例：下階の欠け／
// 吹抜けの上に乗る上階の床梁）は、支持部材ごと省かれる——下階で消えた部材に取り付く上階梁も自動的に消える。
// 非アクティブな下階は floorSwapManager.peek で読み取り専用に覗き、各 graph 内で世界座標→セルを解決する
// （世界座標は全階共通原点のため跨ぎ比較可。figure.md「他階部材を主題階の中心線へ再解決しない」規律を保つ）。

import { RoomKind, RoomFeature, CenterLineType } from '../core.js';
import { worldToCell, worldToCellInIndex, gridIndexOf, dividerCLsBetween } from '../finish/gridCells.js';
import { buildCellToRoom } from '../finish/edgeClassify.js';
import { peekVia } from './structuralPeek.js';
import { withGraphReadScope } from '../graphReadScope.js';

// 軸線・交点から±この距離(mm)だけ離してセルをサンプリングする（finish/edgeClassify.js の ADJACENT_SAMPLE_EPS と同値）。
const SAMPLE_EPS = 10;

// 建物内（屋内）とみなす部屋か。有名屋外(EXTERIOR=中庭/バルコニー)・無名屋外(未割当)は建物外
// （feature の吹抜け・階段・未定義は無関係＝屋内なら建物内）。
const isBuildingRoom = (room) => !!room && room.kind === RoomKind.INTERIOR;

// フットプリントの「権威」を確立する部屋か。階段(STAIR)・階段吹抜け(STAIR_VOID)は
// セル指定/上階自動生成される属性Roomで、それ単独では建物の囲い（外壁線）を定義しない——
// 部屋未着手の階に階段だけを指定するとフットプリントが階段セルへ縮退し、構造部材の
// 生成ゲート・外周符号が階段まわり以外を全部落とす（再発防止）。これらしか無い階は
// 「フットプリント未定義」（ゲートなし/矩形フォールバック）として扱う——階段吹抜けのみの
// 未着手上階も従来の「部屋なし階＝ゲートなし（全グリッド生成）」と同じ挙動に戻る。
// 権威が確立された階では建物内判定（isBuildingRoom）に INTERIOR として通常どおり参加する。
// VOID（吹抜け）・UNDEFINED（未定義部屋）は権威を保つ——前者はユーザーが建物範囲として
// 明示指定した領域、後者は部屋削除後も外壁線を維持するための残置（仕様）のため。
const establishesFootprint = (room) =>
  isBuildingRoom(room)
  && room.feature !== RoomFeature.STAIR
  && room.feature !== RoomFeature.STAIR_VOID;

/**
 * フットプリント索引（分割格子＋cellToRoom）をmemoするキャッシュを作る（ステップA・構造再計算の
 * 高速化。wallBeamAxes.js createWallSourceCacheと同じ設計）。footprintProbe は同じ graph に対し
 * 1回の再計算で何度も呼ばれる（buildStructuralWallGate・buildSelfFootprintGate・buildExteriorSide、
 * autoFillColumnAxisOffsets内のbuildExteriorSide(lowestGraph)等）うえ、返り値の probe(wx,wy) 自体も
 * 生成後に何度も呼ばれる（spanInBuilding・intersectionInBuilding等）。cache指定時は最初に索引を
 * 確定した時点（withGraphReadScope内で1回だけ buildCellToRoom・gridIndexOf を確定）で固定し、
 * 以降は同じ graph・同じ点への問い合わせを組み直さない。
 *
 * **モジュール変数・graphへのWeakMapにしない**——アクティブ階のgraphインスタンスはモードをまたいで
 * 生き続け、部屋・分割線は仕上げモードやundoのrestoreGraphで変わるため、graphに紐づく寿命では古い
 * 索引が残る。呼び出し側（structuralRecompute.js）が明示的な寿命でこのキャッシュを生成し、消費側の
 * 関数チェーンへ明示的に引数で渡す——省略時（undefined）は一切memoせず、現行どおり毎回組み直す
 * （前提: 構造再計算は部屋・分割線を変更しない。wallGate.js冒頭のJSDoc参照）。寿命は2通り:
 * (a) options.footprintCacheを省略したrecomputeStructuralForGraph単体呼び出しでは「1回のその
 * 呼び出しの間」（従来どおり）。(b) 解決コンテキスト（structuralResolveContext.js）があるときは
 * 「1回の反映処理の間」、同じ graph インスタンスに対して複数回のrecomputeStructuralForGraph呼び出しを
 * またいで使い回す（ステップB-6）——保持が世代不一致で捨てられて読み直されると別インスタンスに
 * なるので、cache（graphインスタンスをキーにしている）も自然に外れる。
 *
 * @returns {{get(graph:object):{probe:Function,size:number}|undefined, set(graph:object, entry:object):void}}
 */
export function createFootprintCache() {
  const byGraph = new Map(); // graph -> { probe, size }
  return {
    get(graph) { return byGraph.get(graph); },
    set(graph, entry) { byGraph.set(graph, entry); },
  };
}

/** あるグラフの建物フットプリント述語を作る。屋内(kind === INTERIOR)のみ建物内とみなす。
 *  @param {object} graph
 *  @param {ReturnType<typeof createFootprintCache>} [cache] - 省略時は毎回組み直す（従来どおり）。
 *  @returns {{ probe: (wx:number, wy:number)=>boolean, size: number }}
 *  size=権威を確立するフットプリントセル数（0なら「フットプリント未定義」扱い。
 *  屋外部屋・階段/階段吹抜けのみの階で全部材を消さないよう、これらは数えない）。 */
function footprintProbe(graph, cache = undefined) {
  if (!cache) {
    const cellToRoom = buildCellToRoom(graph);
    let size = 0;
    for (const room of cellToRoom.values()) if (establishesFootprint(room)) size++;
    const probe = (wx, wy) => {
      const cell = worldToCell(wx, wy, graph);
      if (!cell) return false;
      return isBuildingRoom(cellToRoom.get(cell.key));
    };
    return { probe, size };
  }
  const cached = cache.get(graph);
  if (cached) return cached;
  // 分割格子・cellToRoomをwithGraphReadScope内で1回だけ確定する（スコープ外だと点判定のたびに
  // buildGridIndexが組み直される。structural/配下はgraphReadScopeの外のため通常はこの恩恵が無い）。
  const { cellToRoom, index, size } = withGraphReadScope(graph, () => {
    const cellToRoom = buildCellToRoom(graph);
    const index = gridIndexOf(graph);
    let size = 0;
    for (const room of cellToRoom.values()) if (establishesFootprint(room)) size++;
    return { cellToRoom, index, size };
  });
  const points = new Map(); // "wx,wy" -> boolean（確定済み索引だけで解くため、点判定もこの寿命でmemo化する）
  const probe = (wx, wy) => {
    const key = `${wx},${wy}`;
    const hit = points.get(key);
    if (hit !== undefined) return hit;
    const cell = worldToCellInIndex(wx, wy, index);
    const result = cell ? isBuildingRoom(cellToRoom.get(cell.key)) : false;
    points.set(key, result);
    return result;
  };
  const entry = { probe, size };
  cache.set(graph, entry);
  return entry;
}

/** 建物フットプリント（屋内 kind === INTERIOR の部屋セル）のセルキー集合を返す。
 *  べた基礎のマットスラブ（footprint を覆う床版）の cells 算定に使う。
 *  部屋未定義（権威を確立する部屋なし＝階段/階段吹抜けのみの階を含む）なら空集合。 */
export function footprintCellKeys(graph) {
  const cellToRoom = buildCellToRoom(graph);
  const keys = new Set();
  let hasAuthority = false;
  for (const [key, room] of cellToRoom) {
    if (!isBuildingRoom(room)) continue;
    if (establishesFootprint(room)) hasAuthority = true;
    keys.add(key);
  }
  return hasAuthority ? keys : new Set();
}

// ----------------------------------------------------------------
// 外周モデル（side ビュー）— 柱芯オフセット・梁偏芯が共有する「外側方向」の単一ソース。
//
// 外壁＝フットプリント境界。その権威は仕上げモード（部屋セル）が持つ。構造トポロジーで別の外周判定を
// 持たず、ここで一本化する：仕上げフットプリントを裏付けに位置ごとの外側方向を返し、仕上げ未定義時のみ
// 「構造部材CLの外接矩形」を同じ probe に流す（別系統ではなく矩形フットプリントを与えた縮退ケース）。
// side（外側方向）は主題階のフットプリント基準で sync に解ける。存在（鉛直連続AND）は makeWallGate(async)が担う。
// ----------------------------------------------------------------

/** フットプリント probe から、軸線(通り芯)上の位置 atCross における外側方向の符号を求める。
 *  軸線を跨いで ±eps の建物内/外を見て、内側が＋方向＝+1（内側へ寄せる向き）／内側が−方向＝−1／
 *  両側内(内部) or 両側外(建物外)＝0。符号意味は autoFillColumnAxisOffsets の慣習（最小側=+1）に一致。
 *  仕上げフットプリント裏付けなら、凹形状(L字・中庭)の外壁辺も位置ごとに正しく判定できる。 */
export function outsideSignFromProbe(probe, axisValue, isVertical, atCross, eps = SAMPLE_EPS) {
  const plus  = isVertical ? probe(axisValue + eps, atCross) : probe(atCross, axisValue + eps);
  const minus = isVertical ? probe(axisValue - eps, atCross) : probe(atCross, axisValue - eps);
  if (plus && !minus) return 1;
  if (minus && !plus) return -1;
  return 0;
}

/** 仕上げフットプリント未定義時のフォールバック probe：構造部材が参照するCL値の外接矩形を「建物内」とみなす。
 *  柱(axisX/axisY)・梁(axisCL/clStart/clEnd)が実際に立つCLの範囲＝構造グリッドの実効外形。
 *  labeled に依存しない（非labeledなテスト・仕上げ未経由でも外周を出せる）。部材ゼロなら常に false。
 *  柱は`verticalCL.value/horizontalCL.value`ではなく`axisX/axisY`を読む（QA指摘・2026-09-18）——
 *  袖柱（woodJambRef）・3h-2オフセットアンカー柱（woodAxisOffset）はverticalCL/horizontalCLの一方が
 *  実位置と無関係なプレースホルダCLのため、そのままでは外接矩形が実際の建物外形より広がる／
 *  ずれる（プレースホルダの座標を取り込んでしまう）。axisX/axisYは両者とも実位置（AXIS。偏心は
 *  含まない）を返すため、外接矩形の入力として正しい。 */
export function rectFootprintProbe(graph) {
  const xs = [];
  const ys = [];
  for (const c of graph.columns) { xs.push(c.axisX); ys.push(c.axisY); }
  for (const b of graph.beams) {
    if (b.isVertical) { xs.push(b.axisCL.value); ys.push(b.clStart.value, b.clEnd.value); }
    else              { ys.push(b.axisCL.value); xs.push(b.clStart.value, b.clEnd.value); }
  }
  if (xs.length === 0 || ys.length === 0) return () => false;
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  return (wx, wy) => wx >= minX && wx <= maxX && wy >= minY && wy <= maxY;
}

/** 構造外周モデル（side ビュー・sync・常に非null）を構築する。外側方向の判定にのみ使う。
 *  権威：主題階の仕上げフットプリント（部屋セル）。部屋が無ければ構造部材CLの外接矩形をフォールバックに用いる
 *  （同一 outsideSign に矩形フットプリントを与えた縮退ケース。labeled・仕上げ非依存）。
 *  存在（鉛直連続AND）は別ビュー＝buildStructuralWallGate(async) が担う。side は主題階基準。
 *  @param {object} graph
 *  @param {ReturnType<typeof createFootprintCache>} [cache] - 省略時は毎回組み直す（従来どおり）。 */
export function buildExteriorSide(graph, cache = undefined) {
  const fp = footprintProbe(graph, cache);
  const probe = fp.size > 0 ? fp.probe : rectFootprintProbe(graph);
  return {
    outsideSign: (axisValue, isVertical, atCross) => outsideSignFromProbe(probe, axisValue, isVertical, atCross),
  };
}

/** 複数階のフットプリント述語をANDで束ねた WallGate を作る。世界座標が「対象の全階で建物内」＝直下まで連続して
 *  建物がある位置かを判定する（鉛直連続性）。 */
function makeWallGate(probes) {
  const isBuilding = (wx, wy) => probes.every(p => p(wx, wy));
  return {
    /** 軸線(axisCL.value)上の1点(along)の直交両側(±EPS)のいずれかが「下まで連続して建物内」なら true。
     *  spanInBuilding・footprintBreakCLs（区間の分割粒度に依らない境界検出）が共有する唯一の点判定
     *  ——判定式を二重化しない。 */
    spanPointInBuilding(axisCL, isVertical, along) {
      const a = axisCL.value;
      return isVertical
        ? isBuilding(a - SAMPLE_EPS, along) || isBuilding(a + SAMPLE_EPS, along)
        : isBuilding(along, a - SAMPLE_EPS) || isBuilding(along, a + SAMPLE_EPS);
    },
    /** グリッド辺の両側(±EPS)のいずれかが「下まで連続して建物内」なら true（直下に支えの無い辺は false で省く）。
     *  区間中点でのspanPointInBuildingを見るだけ——分割粒度が粗いと中点が偶然どちら側に転ぶかで結果が
     *  変わりうる（footprintBreakCLsで区間をあらかじめフットプリント境界で割っておくのが呼び出し側の責務）。 */
    spanInBuilding(axisCL, isVertical, clStart, clEnd) {
      const mid = (clStart.value + clEnd.value) / 2;
      return this.spanPointInBuilding(axisCL, isVertical, mid);
    },
    /** グリッド交点まわり4象限(±EPS)のいずれかが「下まで連続して建物内」なら true（直下に支えの無い交点は false で省く）。 */
    intersectionInBuilding(verticalCL, horizontalCL) {
      const x = verticalCL.value, y = horizontalCL.value;
      return isBuilding(x - SAMPLE_EPS, y - SAMPLE_EPS) || isBuilding(x + SAMPLE_EPS, y - SAMPLE_EPS)
          || isBuilding(x - SAMPLE_EPS, y + SAMPLE_EPS) || isBuilding(x + SAMPLE_EPS, y + SAMPLE_EPS);
    },
  };
}

/**
 * 区間 (lo, hi) のうち、フットプリントの帰属（建物内/外）が変わる境界のCenterLineを value 昇順で返す
 * （区間中点だけを見るspanInBuildingの粒度依存を解消するため、分割の手前で必ず呼ぶ）。
 * 候補は区間内の直交divider CL（gridCells.js dividerCLsBetween＝通り芯または実線の意匠中心線。
 * フットプリントのセル境界は必ずdivider CLで表現されるため、帰属が変わる位置は必ずこの候補集合の
 * 中にある）。隣り合う小区間の中点でspanPointInBuildingを比べ、結果が変化する境界だけを返す
 * （変化しない候補＝両側とも同じ帰属の通り芯・中心線は境界ではないため返さない）。
 * gateがnull（フットプリント未定義・呼び出し側がゲートなしで動く階）なら常に空配列。
 * @param {ReturnType<typeof makeWallGate>|null} gate
 * @param {object} graph
 * @param {{value:number}} axisCL - 軸線（法線方向の座標はaxisCL.value。spanInBuildingと同じ基準）
 * @param {boolean} isVertical
 * @param {number} lo
 * @param {number} hi
 * @returns {Array<object>} CenterLine実体の配列（value昇順）
 */
export function footprintBreakCLs(gate, graph, axisCL, isVertical, lo, hi) {
  if (!gate) return [];
  const crossType = isVertical ? CenterLineType.HORIZONTAL : CenterLineType.VERTICAL;
  const candidates = dividerCLsBetween(graph, crossType, lo, hi); // value昇順・(lo,hi)の開区間
  if (candidates.length === 0) return [];
  const bounds = [lo, ...candidates.map(cl => cl.value), hi];
  const insides = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    insides.push(gate.spanPointInBuilding(axisCL, isVertical, (bounds[i] + bounds[i + 1]) / 2));
  }
  const out = [];
  for (let i = 1; i < insides.length; i++) {
    if (insides[i] !== insides[i - 1]) out.push(candidates[i - 1]);
  }
  return out;
}

/** 自階単独のフットプリント（部屋領域）だけを見るWallGateを構築する（sync・鉛直連続性ANDは取らない）。
 *  在来木造の壁線上の通し梁・頭つなぎ・受梁（woodAutoFill.js autoFillWoodWallBeams）が使う——壁線上の
 *  梁は自階の床を支える部材であり、下階の連続性（ポーチ・吹抜け等）は柱・直交梁の支持で吸収されるため、
 *  buildStructuralWallGate（自階＋直下全階AND）をそのまま使うと過剰にゲートしてしまう（QA実測:
 *  下階柱の両端支持による免除で通過していた19区間中15区間が自階に部屋の無い位置＝床も屋根も無い
 *  ところに梁を通そうとしていた。指摘A修正で判明・2026-09-18）。
 *  自階に部屋（フットプリントの権威）が無ければ null（呼び出し側はゲートなし=全生成で動く）——
 *  この「部屋が無ければゲートなし」は`buildStructuralWallGate`と同一条件（QA第2巡・Major5裁定
 *  2026-09-18: 現状維持=案(a)）。階段吹抜け(STAIR_VOID)だけの階（例: moku1/moku2/2026模試の
 *  3階）は`establishesFootprint`が権威を確立しないため`fp.size===0`→null になり、下階由来の壁線
 *  runがゲートなしで全生成される——旧`wallGate`（自階＋直下全階AND）も同じ階では基準階側の
 *  `fp.size===0`判定でnullを返していたため、これは回帰ではなく仕上げモード未着手階を保全する
 *  既存の規律（他のautoFillXxxと同じ「部屋が無い階は保全」裁定）をそのまま引き継いだ挙動である。
 *  @param {object} graph
 *  @param {ReturnType<typeof createFootprintCache>} [cache] - 省略時は毎回組み直す（従来どおり）。 */
export function buildSelfFootprintGate(graph, cache = undefined) {
  const fp = footprintProbe(graph, cache);
  if (fp.size === 0) return null;
  return makeWallGate([fp.probe]);
}

/** 構造モードの生成対象階(plane)について、基準階＋直下の全階のフットプリントをANDで束ねた WallGate を構築する
 *  （鉛直連続性ゲート＝下まで建物が連続している位置だけ部材を残す）。
 *  基準階：実体平面なら自階。屋根専用平面（自前の部屋を持たない）なら直下の最上実体階（roofForPlaneId）——
 *  軒桁は直下階のフットプリント（外壁線）に従う。
 *  非アクティブな階は floorSwapManager.peek で覗く（アクティブ階は activeGraph をそのまま使う）。
 *  フットプリント未定義(部屋なし)の下階は AND から除外する（仕上げモード未着手の階で全部材を消さないため）。
 *  以下の場合は null を返し、呼び出し側はゲートなし(全グリッド生成＝従来挙動)で動く：
 *    - 基準階が採用フロアでない
 *    - 基準階に部屋(フットプリント)が未定義（仕上げモード未使用の従来プロジェクトを壊さないため。
 *      権威を確立する部屋が無い＝階段・階段吹抜けRoomのみの階も同じ扱い。establishesFootprint 参照）
 *  @param {ReturnType<typeof createFootprintCache>} [cache] - 省略時は毎回組み直す（従来どおり）。
 *  @param {ReturnType<typeof import('./structuralResolveContext.js').createStructuralResolveContext>} [ctx] -
 *    解決コンテキスト（省略時は floorSwapManager.peek 直呼び。反映処理（structuralOrchestration.js
 *    の境界処理）からは解決コンテキストが渡る）。 */
export async function buildStructuralWallGate(plane, project, activeGraph, cache = undefined, ctx = undefined) {
  const planes = project.planes; // elevation 昇順、屋根・検討を除く採用フロア
  const baseId = plane.isRoofPlane ? plane.roofForPlaneId : plane.id;
  const idx = planes.findIndex(p => p.id === baseId);
  if (idx === -1) return null;

  // 規律5: 主題階(activeGraph)はそのまま・他はpeek経由（ctx指定時はコンテキスト経由）——この分岐は
  // ctxの有無に関わらず変えない。
  const graphFor = async (p) =>
    p.id === activeGraph.plane.id ? activeGraph : await peekVia(ctx, p, project.structGraph);

  // 基準階(idx)＋直下の全階(idx-1 ... 0)のANDで「下まで連続して建物がある」位置に絞る。
  const probes = [];
  for (let i = idx; i >= 0; i--) {
    const fp = footprintProbe(await graphFor(planes[i]), cache);
    if (i === idx && fp.size === 0) return null; // 基準階に部屋が無ければゲートなし
    if (fp.size > 0) probes.push(fp.probe);
  }
  return makeWallGate(probes);
}
