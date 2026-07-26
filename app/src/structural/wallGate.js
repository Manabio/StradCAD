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

import { RoomKind, RoomFeature } from '../core.js';
import { worldToCell } from '../finish/gridCells.js';
import { buildCellToRoom } from '../finish/edgeClassify.js';
import { floorSwapManager } from '../storage/FloorSwapManager.js';

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

/** あるグラフの建物フットプリント述語を作る。屋内(kind === INTERIOR)のみ建物内とみなす。
 *  @returns {{ probe: (wx:number, wy:number)=>boolean, size: number }}
 *  size=権威を確立するフットプリントセル数（0なら「フットプリント未定義」扱い。
 *  屋外部屋・階段/階段吹抜けのみの階で全部材を消さないよう、これらは数えない）。 */
function footprintProbe(graph) {
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
 *  柱(verticalCL/horizontalCL)・梁(axisCL/clStart/clEnd)が実際に立つCLの範囲＝構造グリッドの実効外形。
 *  labeled に依存しない（非labeledなテスト・仕上げ未経由でも外周を出せる）。部材ゼロなら常に false。 */
export function rectFootprintProbe(graph) {
  const xs = [];
  const ys = [];
  for (const c of graph.columns) { xs.push(c.verticalCL.value); ys.push(c.horizontalCL.value); }
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
 *  存在（鉛直連続AND）は別ビュー＝buildStructuralWallGate(async) が担う。side は主題階基準。 */
export function buildExteriorSide(graph) {
  const fp = footprintProbe(graph);
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
    /** グリッド辺の両側(±EPS)のいずれかが「下まで連続して建物内」なら true（直下に支えの無い辺は false で省く）。 */
    spanInBuilding(axisCL, isVertical, clStart, clEnd) {
      const mid = (clStart.value + clEnd.value) / 2;
      const a = axisCL.value;
      return isVertical
        ? isBuilding(a - SAMPLE_EPS, mid) || isBuilding(a + SAMPLE_EPS, mid)
        : isBuilding(mid, a - SAMPLE_EPS) || isBuilding(mid, a + SAMPLE_EPS);
    },
    /** グリッド交点まわり4象限(±EPS)のいずれかが「下まで連続して建物内」なら true（直下に支えの無い交点は false で省く）。 */
    intersectionInBuilding(verticalCL, horizontalCL) {
      const x = verticalCL.value, y = horizontalCL.value;
      return isBuilding(x - SAMPLE_EPS, y - SAMPLE_EPS) || isBuilding(x + SAMPLE_EPS, y - SAMPLE_EPS)
          || isBuilding(x - SAMPLE_EPS, y + SAMPLE_EPS) || isBuilding(x + SAMPLE_EPS, y + SAMPLE_EPS);
    },
  };
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
 *      権威を確立する部屋が無い＝階段・階段吹抜けRoomのみの階も同じ扱い。establishesFootprint 参照） */
export async function buildStructuralWallGate(plane, project, activeGraph) {
  const planes = project.planes; // elevation 昇順、屋根・検討を除く採用フロア
  const baseId = plane.isRoofPlane ? plane.roofForPlaneId : plane.id;
  const idx = planes.findIndex(p => p.id === baseId);
  if (idx === -1) return null;

  const graphFor = async (p) =>
    p.id === activeGraph.plane.id ? activeGraph : await floorSwapManager.peek(p, project.structGraph);

  // 基準階(idx)＋直下の全階(idx-1 ... 0)のANDで「下まで連続して建物がある」位置に絞る。
  const probes = [];
  for (let i = idx; i >= 0; i--) {
    const fp = footprintProbe(await graphFor(planes[i]));
    if (i === idx && fp.size === 0) return null; // 基準階に部屋が無ければゲートなし
    if (fp.size > 0) probes.push(fp.probe);
  }
  return makeWallGate(probes);
}
