/**
 * 構造モードの図面定義（FigureDef）。
 *
 * 構造伏図 ＝「自階の床下材（梁・スラブ・耐力壁・基礎/柱脚）」＋「1つ下の階の柱」の合成。
 * 伏図慣習（2階伏図に1階の柱を描く・基礎伏図には柱を描かない）を、描画層のハードコードではなく
 * この宣言的定義に持たせる。柱データ自体は各階が自階 graph に持つ（structural-model.md 参照）。
 */

import { LayerRole, LayerStyle } from '../figure/figureTypes.js';
import { registerFigure } from '../figure/figureRegistry.js';
import { structuralPlaneBelow } from './drawingDesignation.js';

export const STRUCTURAL_FIGURE_ID = 'structural';

// 「1つ下の階」を供給階に解決する関数 source（屋根専用平面・基礎伏図の特例は structuralPlaneBelow が吸収）。
const belowSource = (subjectPlane, project) => {
  const below = structuralPlaneBelow(subjectPlane, project);
  return below ? [below] : []; // 基礎伏図（1つ下なし）は空＝柱レイヤのバインディングを持たない
};

const STRUCTURAL_FIGURE = {
  id: STRUCTURAL_FIGURE_ID,
  layers: [
    // 床下材は自階 graph から実線・主編集。
    {
      source: 'self',
      categories: ['footingMap', 'beamMap', 'slabMap', 'wallMap'],
      style: LayerStyle.SOLID,
      role: LayerRole.PRIMARY,
    },
    // 柱は1つ下の階から実線・副編集（編集可能 peek。描画対象＝編集対象）。
    {
      source: belowSource,
      categories: ['columnMap'],
      style: LayerStyle.SOLID,
      role: LayerRole.SECONDARY_EDIT,
    },
  ],
};

registerFigure(STRUCTURAL_FIGURE_ID, STRUCTURAL_FIGURE);
