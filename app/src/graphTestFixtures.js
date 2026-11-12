// テスト専用。製品コードからは import されない。複数のテストが共有する、実物の PlanGraph / Plane /
// Project を使った組み立て部品（plan/planTestFixtures.js と同じ流儀）。
// 注意: makeFirstFloorGraph（階名「1階」）と makePlanGraph（階名「<id>階」）は階名が違う。
// 互いに置き換えてはいけない（テストが見る階名が変わる）。
import { Plane, PlanGraph, Project, CenterLineType, Discipline } from '@core';
import { generateRoomWallsFromOutline } from './finish/wallGeneration.js';

const FIRST_FLOOR_NAME = '1階';
const FLOOR_SUFFIX = '階';
const START_FLOOR = 1;
const STORIES = 1;
const PROJECT_ID = 'proj';
const PROJECT_NAME = 'test';
const ARCH = { labeled: false, discipline: Discipline.ARCH };
const GRID = { labeled: true, discipline: Discipline.STRUCT };
const GRID_XS = [0, 1000, 2000];
const GRID_YS = [0, 1000];
const STORY_HEIGHT_MM = 3000;
const BACKING_WALL_PROPS = { backingOffset: 0, backingDepth: 120, wallFinish: 12.5 };

/** 階名「1階」・レベル 0 の 1 階だけのグラフ。 */
export function makeFirstFloorGraph() {
  return new PlanGraph(new Plane('p1', 0, FIRST_FLOOR_NAME, START_FLOOR, STORIES));
}

/** 階名「<id>階」のグラフ。 */
export function makePlanGraph(planeId = 'p1', elevation = 0) {
  return new PlanGraph(new Plane(planeId, elevation, `${planeId}${FLOOR_SUFFIX}`, START_FLOOR, STORIES));
}

/** 四角い 1 部屋（中心線は x0, x1, y0, y1 の順に足し、壁も生成する）。room を返す。 */
export function makeRectRoom(graph, x0v, y0v, x1v, y1v, name = 'LDK') {
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, x0v, { ...ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, x1v, { ...ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, y0v, { ...ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, y1v, { ...ARCH });
  const key = `${x0.id}:${y0.id}:${x1.id}:${y1.id}`;
  const room = graph.addRoom(new Set([key]), name);
  generateRoomWallsFromOutline(graph, room);
  return room;
}

/** 1 階（p1）だけのプロジェクト。{ project, graph } を返す。 */
export function makeSinglePlaneProject() {
  const project = new Project(PROJECT_ID, PROJECT_NAME);
  const { graph } = project.addPlane(0, FIRST_FLOOR_NAME, 'p1');
  return { project, graph };
}

/** 通り芯（X:[0,1000,2000] Y:[0,1000]）つきで floorCount 階のプロジェクト。{ project, graphs } を返す。 */
export function setupGridProject(floorCount) {
  const project = new Project(PROJECT_ID, PROJECT_NAME);
  for (const x of GRID_XS) project.structGraph.addCenterLine(CenterLineType.VERTICAL, x, { ...GRID });
  for (const y of GRID_YS) project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, y, { ...GRID });
  const graphs = [];
  for (let i = 0; i < floorCount; i++) {
    const { graph } = project.addPlane(i * STORY_HEIGHT_MM, `${i + 1}${FLOOR_SUFFIX}`, `p${i + 1}`);
    graphs.push(graph);
  }
  return { project, graphs };
}

/**
 * 下地オーナー壁を 1 本追加（backingOffset=0＝下地帯中心が axisValue）。bandOffset は既定 null
 * （帯シフト無し＝内壁相当）。外壁シナリオを模すテストだけ明示的に渡す。
 */
export function addBackingWall(graph, { axisValue, clStart, clEnd, isVertical, bandOffset = null }) {
  const axisCL = graph.addCenterLine(
    isVertical ? CenterLineType.VERTICAL : CenterLineType.HORIZONTAL, axisValue, { ...ARCH });
  return graph.addWall(axisCL, 0, isVertical, clStart, 0, clEnd, 0, { ...BACKING_WALL_PROPS, bandOffset });
}

/** 中心線を 1 本足す（ラベルなしの建築線）。 */
export function addCL(graph, type, value) {
  return graph.addCenterLine(type, value, { ...ARCH });
}
