// 構造部材の自動生成を「建物フットプリント（仕上げモードの部屋領域）」でゲートする純関数群。
//
// 部材の有無を外壁線位置で決めるための実装。外壁は部屋領域の外周に生成される（finish/wallGeneration.js）
// ため、外壁線の位置 ≡ 屋内/吹抜けフットプリントの境界。そこで Wall 実体を読まず、各階の部屋セル
// （屋内 INTERIOR / 吹抜け VOID）を「建物内」フットプリントとして扱い、グリッド辺・交点が建物に接するかで
// 生成可否を取捨する（A案＝セル/部屋ベースのフットプリント判定）。
//
// 「建物全体の上下階」を加味する規律＝鉛直連続性：部材は「自階かつ直下の全階で建物が連続している」位置だけ
// 残す（自階＋直下フロアのフットプリントをANDで束ねる）。直下に支えの無い位置の梁・柱（例：下階の欠け／
// 吹抜けの上に乗る上階の床梁）は、支持部材ごと省かれる——下階で消えた部材に取り付く上階梁も自動的に消える。
// 非アクティブな下階は floorSwapManager.peek で読み取り専用に覗き、各 graph 内で世界座標→セルを解決する
// （世界座標は全階共通原点のため跨ぎ比較可。figure.md「他階部材を主題階の中心線へ再解決しない」規律を保つ）。

import { RoomKind } from '../core.js';
import { worldToCell } from '../finish/gridCells.js';
import { buildCellToRoom } from '../finish/edgeClassify.js';
import { floorSwapManager } from '../storage/FloorSwapManager.js';

// 軸線・交点から±この距離(mm)だけ離してセルをサンプリングする（finish/edgeClassify.js の ADJACENT_SAMPLE_EPS と同値）。
const SAMPLE_EPS = 10;

/** あるグラフの建物フットプリント述語を作る。屋内(INTERIOR)・吹抜け(VOID)のみ建物内とみなし、
 *  有名屋外(EXTERIOR=中庭/バルコニー)・無名屋外(未割当)は建物外とする。
 *  @returns {{ probe: (wx:number, wy:number)=>boolean, size: number }} size=フットプリントのセル数 */
function footprintProbe(graph) {
  const cellToRoom = buildCellToRoom(graph);
  const isBuildingRoom = (room) => !!room && (room.kind === RoomKind.INTERIOR || room.kind === RoomKind.VOID);
  let size = 0; // 建物内（屋内/吹抜け）セル数。屋外部屋しか無い階で全部材を消さないよう屋外は数えない。
  for (const room of cellToRoom.values()) if (isBuildingRoom(room)) size++;
  const probe = (wx, wy) => {
    const cell = worldToCell(wx, wy, graph);
    if (!cell) return false;
    return isBuildingRoom(cellToRoom.get(cell.key));
  };
  return { probe, size };
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
 *    - 基準階に部屋(フットプリント)が未定義（仕上げモード未使用の従来プロジェクトを壊さないため） */
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
