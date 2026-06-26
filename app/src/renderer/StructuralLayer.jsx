import { observer } from 'mobx-react-lite';
import { Line, Rect, Circle, Group } from 'react-konva';
import { StructuralMaterialType, LINE_WEIGHT_MM } from '../core.js';
import { cellBoundsFromKey } from '../finish/gridCells.js';
import { findSectionEntry } from '../structural/sectionCatalog.js';
import { LodLevel, resolveStrokeWidth } from '../viewport.js';
import { ColumnSymbol } from './ColumnSymbol.jsx';
import { groupPropsForStyle, dashForStyle } from '../figure/figureStyle.js';

export const COLOR_BY_MATERIAL = {
  [StructuralMaterialType.WOOD]:  '#92400e',
  [StructuralMaterialType.STEEL]: '#475569',
  [StructuralMaterialType.RC]:    '#1e293b',
};

// 柱は構造図では全LODで実寸表示する（梁・耐力壁の仮サイズLODとは非対称）。COLUMN_SIZE_MM は
// sectionDefId がカタログに無い場合のフォールバック辺長。BEAM_WIDTH_MM は梁の仮表示幅。
const COLUMN_SIZE_MM = 120; // 柱のフォールバック（カタログ未登録時）の辺長
const BEAM_WIDTH_MM  = 30;  // 梁の簡易表示の幅

// 柱の実描画サイズ(mm)。LODに依らず常にsectionDefIdのカタログ実寸（矩形等で幅・高さが異なる場合は
// 大きい方、カタログ未登録はCOLUMN_SIZE_MM）。StructuralLayer.jsx・MemberTagLayer.jsxの両方が
// これだけを参照する単一の実装。
export function columnRenderSize(column) {
  const sec = findSectionEntry(column.sectionDefId);
  return Math.max(sec?.width ?? COLUMN_SIZE_MM, sec?.height ?? COLUMN_SIZE_MM);
}

// 梁の実描画幅(mm)。beamWidth（基礎梁の算定値）が設定済みならLOD・SCHEMATICに関わらず常にそれを使う
// （フーチングと同じ「常に実寸」扱い）。未設定はSCHEMATIC=単線（戻り値null）/STANDARD=仮幅/DETAIL=カタログ実寸。
// StructuralLayer.jsx・MemberTagLayer.jsxの両方がこれだけを参照する単一の実装。
export function beamRenderWidth(beam, lod) {
  if (lod === LodLevel.SCHEMATIC && beam.beamWidth == null) return null;
  return beam.beamWidth ?? (lod === LodLevel.DETAIL ? (findSectionEntry(beam.sectionDefId)?.width ?? BEAM_WIDTH_MM) : BEAM_WIDTH_MM);
}

// 耐力壁の帯（軸±thickness/2 の平行線2本）を、開口区間を除いたセグメント単位に分割する。
// graph.wallOpenings から該当壁の開口を集め、coord1〜coord2 の範囲をその区間で間引く。
function wallSegments(wall, openings) {
  const lo = Math.min(wall.coord1, wall.coord2);
  const hi = Math.max(wall.coord1, wall.coord2);
  const gaps = openings
    .filter(o => o.wall.id === wall.id)
    .map(o => [Math.max(lo, Math.min(o.coord1, o.coord2)), Math.min(hi, Math.max(o.coord1, o.coord2))])
    .sort((a, b) => a[0] - b[0]);

  const segments = [];
  let cur = lo;
  for (const [gapLo, gapHi] of gaps) {
    if (gapLo > cur) segments.push([cur, gapLo]);
    cur = Math.max(cur, gapHi);
  }
  if (hi > cur) segments.push([cur, hi]);
  return segments;
}

// isVertical方向、segments区間ごとに axisValue±half の境界線2本を描く（壁・耐力壁・梁の帯表現で共用）。
// 「部材の実寸幅」（2本の間隔=half*2）と「輪郭線の太さ」（strokeWidth）を分離して表現する。
function bandLines(keyPrefix, isVertical, axisValue, half, segments, stroke, strokeWidth, dash) {
  const sides = [axisValue - half, axisValue + half];
  return segments.flatMap(([segLo, segHi], i) => sides.map(side => {
    const p1 = isVertical ? { x: side, y: segLo } : { x: segLo, y: side };
    const p2 = isVertical ? { x: side, y: segHi } : { x: segHi, y: side };
    return (
      <Line
        key={`${keyPrefix}:${i}:${side}`}
        points={[p1.x, p1.y, p2.x, p2.y]}
        stroke={stroke}
        strokeWidth={strokeWidth}
        dash={dash}
        listening={false}
      />
    );
  }));
}

// 柱のみの描画。構造モードでは全LODで実断面形状（ColumnSymbol）を実寸表示する。
// STANDARDだけは塗りなし（輪郭線のみ。中実断面が重なる範囲を確認しやすくするため）。
export const ColumnsLayer = observer(({ graph, viewport }) => {
  if (!graph) return null;
  const scale   = Math.min(viewport.scaleX, viewport.scaleY);
  const outline = viewport.lodLevel === LodLevel.STANDARD;
  const outlineStrokeWidth = resolveStrokeWidth(LINE_WEIGHT_MM.medium, scale);
  return graph.columns.map(column => (
    <ColumnSymbol
      key={column.id}
      column={column}
      color={COLOR_BY_MATERIAL[column.materialType]}
      outline={outline}
      outlineStrokeWidth={outlineStrokeWidth}
    />
  ));
});

// 構造モード（appMode === 'structure'）専用レイヤー。
// 柱は (column.x, column.y) に断面記号、梁・耐力壁は軸CL沿いに coord1〜coord2 の帯を描画する。
// 壁（ShapesLayer.jsx）と同じ3段階LOD設計：略図=単線、標準=帯（仮サイズ）、詳細=帯（実寸 or 実断面）。
//
// 各カテゴリの供給グラフは図面合成（composition）から解決する。「柱＝1つ下の階・床下材＝自階」という
// 帰属（伏図慣習）はこのレイヤーではなく FigureDef（structuralFigure.js）が決める——レンダラは
// 「カテゴリをどう描くか」だけを知り、「どの階のどのグラフか」は composition.graphForCategory に委ねる。
// z-order は描画順（柱→基礎→梁→スラブ→耐力壁）で再現し、レイヤ宣言順には依存させない。
export const StructuralLayer = observer(({ composition, viewport }) => {
  if (!composition) return null;
  const scale  = Math.min(viewport.scaleX, viewport.scaleY);
  const lod    = viewport.lodLevel;
  const thin   = resolveStrokeWidth(LINE_WEIGHT_MM.thin, scale);
  const medium = resolveStrokeWidth(LINE_WEIGHT_MM.medium, scale);

  // 各カテゴリのレイヤを解決し graph と表示スタイルを取り出す。Group の opacity でレイヤ全体を淡くし、
  // 線・帯・輪郭には dashForStyle で破線を与える（SOLID は素通し＝現状の描画と完全一致）。
  const column  = composition.resolveCategory('columnMap');
  const footing = composition.resolveCategory('footingMap');
  const beam    = composition.resolveCategory('beamMap');
  const slab    = composition.resolveCategory('slabMap');
  const wall    = composition.resolveCategory('wallMap');
  const beamDash = dashForStyle(beam?.spec.style);
  const wallDash = dashForStyle(wall?.spec.style);
  // 梁は「その伏図に表示される柱」（構造モードでは1つ下の階の柱）の断面手前で止める。
  const displayedColumns = column?.graph?.columns ?? [];

  return (
    <>
      <Group {...groupPropsForStyle(column?.spec.style)}>
        <ColumnsLayer graph={column?.graph} viewport={viewport} />
      </Group>
      <Group {...groupPropsForStyle(footing?.spec.style)}>
        {(footing?.graph?.footings ?? []).map(f => {
          // 矩形=widthX×widthY（柱・耐力壁と同じ実寸表現）、丸（sectionShape:'round'）=widthXを直径とする円。
          // 柱脚(ColumnBase)は丸柱の直下でも常に矩形（型枠の都合上、柱脚自体を丸で作ることは無いため）。
          // 独立基礎(IndependentFooting)と区別するため点線（'baseType' in footing で判定）。固有点線が無い場合のみ style 破線。
          const isColumnBase = 'baseType' in f;
          const color = COLOR_BY_MATERIAL[f.materialType];
          const common = {
            fill: color,
            stroke: color,
            strokeWidth: medium,
            opacity: 0.2,
            dash: isColumnBase ? [8, 4] : dashForStyle(footing?.spec.style),
            listening: false,
          };
          if (!isColumnBase && f.sectionShape === 'round') {
            return <Circle key={f.id} x={f.x} y={f.y} radius={f.widthX / 2} {...common} />;
          }
          return (
            <Rect
              key={f.id}
              x={f.x} y={f.y}
              width={f.widthX} height={f.widthY}
              offsetX={f.widthX / 2} offsetY={f.widthY / 2}
              {...common}
            />
          );
        })}
      </Group>
      <Group {...groupPropsForStyle(beam?.spec.style)}>
        {(beam?.graph?.beams ?? []).flatMap(b => {
          const color = COLOR_BY_MATERIAL[b.materialType];
          const { coord1, coord2 } = b.spanForColumns(displayedColumns);
          const p1 = b.isVertical ? { x: b.axisValue, y: coord1 } : { x: coord1, y: b.axisValue };
          const p2 = b.isVertical ? { x: b.axisValue, y: coord2 } : { x: coord2, y: b.axisValue };
          const width = beamRenderWidth(b, lod);
          if (width == null) {
            return [
              <Line key={b.id} points={[p1.x, p1.y, p2.x, p2.y]} stroke={color} strokeWidth={thin} dash={beamDash} listening={false} />,
            ];
          }
          const segment = [[Math.min(coord1, coord2), Math.max(coord1, coord2)]];
          return bandLines(`beam:${b.id}`, b.isVertical, b.axisValue, width / 2, segment, color, medium, beamDash);
        })}
      </Group>
      <Group {...groupPropsForStyle(slab?.spec.style)}>
        {(slab?.graph?.slabs ?? []).flatMap(s => [...s.cells].map(key => {
          const bd = cellBoundsFromKey(key, slab.graph);
          if (!bd) return null;
          return (
            <Rect
              key={`${s.id}:${key}`}
              x={bd.x1} y={bd.y1}
              width={bd.x2 - bd.x1} height={bd.y2 - bd.y1}
              fill={COLOR_BY_MATERIAL[s.materialType]}
              stroke={COLOR_BY_MATERIAL[s.materialType]}
              strokeWidth={thin}
              opacity={0.15}
              listening={false}
            />
          );
        }))}
      </Group>
      <Group {...groupPropsForStyle(wall?.spec.style)}>
        {(wall?.graph?.structuralWalls ?? []).flatMap(w => {
          const color    = COLOR_BY_MATERIAL[w.materialType];
          const segments = wallSegments(w, wall.graph.wallOpenings);
          if (lod === LodLevel.SCHEMATIC) {
            return segments.map(([segLo, segHi], i) => {
              const p1 = w.isVertical ? { x: w.axisValue, y: segLo } : { x: segLo, y: w.axisValue };
              const p2 = w.isVertical ? { x: w.axisValue, y: segHi } : { x: segHi, y: w.axisValue };
              return (
                <Line key={`${w.id}:${i}`} points={[p1.x, p1.y, p2.x, p2.y]} stroke={color} strokeWidth={thin} dash={wallDash} listening={false} />
              );
            });
          }
          return bandLines(`wall:${w.id}`, w.isVertical, w.axisValue, w.thickness / 2, segments, color, medium, wallDash);
        })}
      </Group>
    </>
  );
});
