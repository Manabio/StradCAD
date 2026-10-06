// node:test 用のテスト専用ヘルパー（ファイル名に ".test." を含めない＝テスト本体として実行されない。
// 製品コードから import しない）。階段の連動削除（stairRemoval.test.js・stairFloorSync.removal.test.js）が
// 共有する、実際の経路（applyNaming で階段を指定→syncUpperFloors で直上階へ階段吹抜けを展開）で前提を作る手順。
import { Project, CenterLineType, Discipline, RoomKind, RoomFeature } from '../../core.js';
import { worldToCell } from '../gridCells.js';
import { subtractCellsFromUndefinedRooms } from '../roomUndefined.js';
import { FinishModeState } from '../../modes/FinishModeState.js';
import { floorHeightAbove } from './stairDimensions.js';

// X:[0,1000,2000] Y:[0,1000]（全階共通の通り芯）。階数 floorCount の採用フロア（p1, p2, ...）。
export function setupProject(floorCount) {
  const project = new Project('proj', 'test');
  const grid = { labeled: true, discipline: Discipline.STRUCT };
  project.structGraph.addCenterLine(CenterLineType.VERTICAL,   0,    grid);
  project.structGraph.addCenterLine(CenterLineType.VERTICAL,   1000, grid);
  project.structGraph.addCenterLine(CenterLineType.VERTICAL,   2000, grid);
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    grid);
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 1000, grid);
  const graphs = [];
  for (let i = 0; i < floorCount; i++) {
    const { graph } = project.addPlane(i * 3000, `${i + 1}階`, `p${i + 1}`);
    graphs.push(graph);
  }
  return { project, graphs };
}

export const keyAt = (g, [x, y]) => worldToCell(x, y, g).key;

/** 全階へ per-floor 中心線 x=value を足す（階段の footprint が per-floor 中心線を含み、上の階へ展開される）。 */
export function addPerFloorV(graphs, value = 500) {
  for (const g of graphs) g.addCenterLine(CenterLineType.VERTICAL, value, { labeled: false, discipline: Discipline.ARCH });
}

/** 左半分 [0,500]x[0,1000] のセル点列（全階 x=500 を足したとき1セルになる）。 */
export const LEFT_HALF = [[250, 500]];

/**
 * ga（設置階）の pts のセルから階段を指定する（部屋を作る→applyNaming。実際の経路）。
 * @returns {{stair: object, room: object}} 指定後の階段とそのペアRoom
 */
export function placeStair(project, ga, { pts = LEFT_HALF, kind = RoomKind.INTERIOR } = {}) {
  project.activePlaneId = ga.plane.id;
  const cells = new Set(pts.map(p => keyAt(ga, p)));
  // 連動削除で未定義化した部屋の上へ再指定する場合（FinishModeState.applyNaming と同じ前例）。無ければ何もしない
  subtractCellsFromUndefinedRooms(ga, cells);
  const room = ga.addRoom(cells, 'ホール');
  room.setKind(kind);
  const payload = { name: '', kind, feature: RoomFeature.STAIR };
  const state = new FinishModeState(ga, project);
  state.prepareStairNaming(room.id, payload);
  state.applyNaming(room.id, payload, floorHeightAbove(project, project.activePlane));
  const stair = ga.stairs[ga.stairs.length - 1];
  return { stair, room: ga.roomMap.get(stair.roomId) };
}
