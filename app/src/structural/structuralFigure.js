/**
 * 構造モードの図面定義（FigureDef）。
 *
 * 構造伏図 ＝「自階の床下材（梁・スラブ・耐力壁・基礎/柱脚）」＋「1つ下の階の柱（下階柱レイヤ）」＋
 * 「自階の柱（自階柱レイヤ。参照表示のみ）」の合成。伏図慣習（2階伏図に1階の柱を描く）を、描画層の
 * ハードコードではなくこの宣言的定義に持たせる。柱データ自体は各階が自階 graph に持つ（structural-model.md 参照）。
 * 基礎伏図（最下階）は1つ下の階が無いため下階柱レイヤが空＝下階柱の×は出ないが、自階柱レイヤ（在来木造の□）は
 * 最下階でも描かれる——「基礎伏図には柱を描かない」のは下階柱（×側）だけの話で、自階柱（□側）は対象外。
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
    // 自階柱は参照表示のみ（編集は1つ上の階の伏図で下階柱として行う）。'columnMapSelf' は描画専用の
    // 接尾辞付きカテゴリ名——同一カテゴリ('columnMap')は1レイヤしか解決できない
    // （FigureComposition.resolveCategory は最初の一致を返す）ため出自違いを別名で区別する。
    // 採番・編集系（memberCatalog.js の NUMBERED_MAPS / MEMBER_GROUPS）には現れない。
    // 描く／描かないは主構造ルール drawing.framingColumnSymbol がレンダラで決める＝非在来では何も描かない。
    {
      source: 'self',
      categories: ['columnMapSelf'],
      style: LayerStyle.SOLID,
      role: LayerRole.REFERENCE,
    },
  ],
};

registerFigure(STRUCTURAL_FIGURE_ID, STRUCTURAL_FIGURE);
