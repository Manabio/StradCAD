// 屋根（RoomFeature.ROOF）の I0（壁・境界の同値）テスト用フィクスチャ。
// 屋根セルを持つ配置と「同じセルを無割当にした配置」「同じセルを通常の屋外部屋にした配置」を
// 同じ中心線（固定id）で作る。wallGeneration.test.js・edgeClassify.test.js が共有する。
import { PlanGraph, Plane, CenterLineType, Discipline, RoomKind, RoomFeature, RoofShape } from '@core';

// 屋根の仕様（RoofSpec）の全9項目を既定値以外にした plain 値。往復・キー集合の突合テストが共有する
// （項目が増えたらここへの追加を強制する）。出幅0・勾配2.5・形状は明示（自動でない）。
export const NON_DEFAULT_ROOF_SPEC = Object.freeze({
  shape: RoofShape.HIP,
  slope: 2.5,
  sheathingMaterial: '301000000023',
  underlaymentMaterial: '302000000009',
  roofFinish: 'ガルバリウム鋼板 立てはぜ葺き',
  eaveOverhangMm: 0,
  gableOverhangMm: 300,
  soffit: '軒天ケイカル板 t=6',
  note: '下野',
});

const ARCH = { labeled: false, discipline: Discipline.ARCH };

export const ROOF_LAYOUT_SHAPES = Object.freeze(['band', 'notch']);
export const ROOF_LAYOUT_MODES = Object.freeze(['roof', 'none', 'exterior']);

/**
 * @param {'band'|'notch'} shape
 *   band : 屋内（x:0..4000, y:0..3000 の2セル）の右に、屋根セル（x:4000..8000, y:0..1500）の帯。
 *          外周が「無割当に面する辺」から「屋根セルに面する辺」へ切り替わる角が2つできる。
 *   notch: L字の屋内（3セル）の凹みを屋根セル（x:2000..4000, y:1500..3000）が埋める。入隅の角。
 * @param {'roof'|'none'|'exterior'} mode
 *   roof: 該当セルを屋根（kind=EXTERIOR・feature=ROOF）／none: 無割当／exterior: 通常の屋外部屋。
 */
export function buildRoofLayout(shape, mode) {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const xs = shape === 'band' ? [0, 4000, 8000] : [0, 2000, 4000];
  const [x0, x1, x2] = xs.map((v, i) => graph.addCenterLine(CenterLineType.VERTICAL, v, ARCH, `x${i}`));
  const [y0, y1, y2] = [0, 1500, 3000].map((v, i) => graph.addCenterLine(CenterLineType.HORIZONTAL, v, ARCH, `y${i}`));
  const cell = (l, t, r, b) => `${l.id}:${t.id}:${r.id}:${b.id}`;

  let interiorCells;
  let extraCell;
  if (shape === 'band') {
    interiorCells = [cell(x0, y0, x1, y1), cell(x0, y1, x1, y2)];
    extraCell = cell(x1, y0, x2, y1);
  } else {
    interiorCells = [cell(x0, y0, x1, y1), cell(x1, y0, x2, y1), cell(x0, y1, x1, y2)];
    extraCell = cell(x1, y1, x2, y2);
  }
  const interior = graph.addRoom(new Set(interiorCells), '居間');

  let extra = null;
  if (mode === 'roof') {
    extra = graph.addRoom(new Set([extraCell]), '屋根');
    extra.setKind(RoomKind.EXTERIOR);
    extra.setFeature(RoomFeature.ROOF);
  } else if (mode === 'exterior') {
    extra = graph.addRoom(new Set([extraCell]), 'テラス');
    extra.setKind(RoomKind.EXTERIOR);
  }
  return { graph, interior, extra, extraCell };
}
