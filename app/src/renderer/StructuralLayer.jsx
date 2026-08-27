import { observer } from 'mobx-react-lite';
import { Line, Rect, Circle, Group } from 'react-konva';
import { StructuralMaterialType, LINE_WEIGHT_MM } from '../core.js';
import { cellBoundsFromKey } from '../finish/gridCells.js';
import { findSectionEntry, diaphragmProjection } from '../structural/sectionCatalog.js';
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

// 剛接合（鉄骨）の継手記号。位置は構造芯から RIGID_JOINT_OFFSET_MM（core側の定数）内側で、
// 梁を横断する線として描く。略図・標準は1本、詳細は実寸 RIGID_JOINT_DETAIL_GAP_MM だけ離した2本
// （母材を切って突き合わせる継手の見え方。切断幅そのものではなく作図上の離れ）。
const RIGID_JOINT_DETAIL_GAP_MM = 0.5;

// 継手記号1箇所ぶんの Konva 要素。along=梁に沿う座標、half=記号の半長（梁の見付き幅の半分）。
function jointMarkLines(keyBase, beam, along, half, color, strokeWidth, detail) {
  const offsets = detail ? [-RIGID_JOINT_DETAIL_GAP_MM / 2, RIGID_JOINT_DETAIL_GAP_MM / 2] : [0];
  return offsets.map((d, i) => {
    const a = along + d;
    const points = beam.isVertical
      ? [beam.axisValue - half, a, beam.axisValue + half, a]
      : [a, beam.axisValue - half, a, beam.axisValue + half];
    return (
      <Line key={`${keyBase}:${i}`} points={points} stroke={color} strokeWidth={strokeWidth} listening={false} />
    );
  });
}

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
  // 見付き幅＝梁幅b。算定値 beamWidth はRC基礎梁等（断面非依存）のみ実寸に使う。鋼材は軒桁等で beamWidth が
  // 立っていてもカタログ断面の幅b(width)を優先する（算定値は屋根スパン由来でカタログ断面と別物のため）。
  const rcWidth = beam.materialType === 'RC' ? beam.beamWidth : null;
  if (lod === LodLevel.SCHEMATIC && rcWidth == null) return null;
  return rcWidth ?? (lod === LodLevel.DETAIL ? (findSectionEntry(beam.sectionDefId)?.width ?? BEAM_WIDTH_MM) : BEAM_WIDTH_MM);
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

// 木造基礎伏図の「土台」「ベース」帯の振り分け寸法（問題.md）。通り芯・1階壁芯（＝基礎梁の軸）から
// 土台は±75（幅150）、ベースは±300（幅600）を振り分けて描く。土台は袋とじ（交点で重ねて閉じる）、
// ベースは角でトリム（直交する基礎梁に突き当たる端を半幅だけ控えて突合せにする）。
const SILL_HALF = 75;   // 土台 幅150 の半分
const BASE_HALF  = 300;  // ベース 幅600 の半分
const BAND_COORD_TOL = 1; // 端点一致判定の許容(mm)

// 基礎梁(role:'foundation')の軸に沿った帯1本のRect props（isVertical=軸がX方向）。lo/hi は span方向の座標。
function bandRect(beam, lo, hi, half) {
  return beam.isVertical
    ? { x: beam.axisValue - half, y: lo, width: half * 2, height: hi - lo }
    : { x: lo, y: beam.axisValue - half, width: hi - lo, height: half * 2 };
}

// 木造基礎伏図の土台・ベース帯を基礎梁から生成する。drawBase=false（べた基礎）ならベースは描かない。
function woodFoundationBands(foundationBeams, drawBase, sillColor, baseColor, strokeWidth) {
  const spanLo = b => Math.min(b.clStart.value, b.clEnd.value);
  const spanHi = b => Math.max(b.clStart.value, b.clEnd.value);
  // 端 coord で直交する基礎梁に突き当たるか（その直交梁のスパンが自軸を含む）。ベースのトリム判定に使う。
  const meetsPerp = (b, coord) => foundationBeams.some(p =>
    p.isVertical !== b.isVertical &&
    Math.abs(p.axisValue - coord) < BAND_COORD_TOL &&
    spanLo(p) - BAND_COORD_TOL <= b.axisValue && b.axisValue <= spanHi(p) + BAND_COORD_TOL);

  const rects = [];
  // ベース（広い・下）：端が直交基礎梁に突き当たる側を半幅控えてトリム（角で突合せ）。
  if (drawBase) {
    for (const b of foundationBeams) {
      const lo = meetsPerp(b, spanLo(b)) ? spanLo(b) + BASE_HALF : spanLo(b);
      const hi = meetsPerp(b, spanHi(b)) ? spanHi(b) - BASE_HALF : spanHi(b);
      if (hi <= lo) continue;
      rects.push(<Rect key={`base:${b.id}`} {...bandRect(b, lo, hi, BASE_HALF)}
        fill={baseColor} stroke={baseColor} strokeWidth={strokeWidth} opacity={0.12} listening={false} />);
    }
  }
  // 土台（狭い・上）：常に全長（交点で重なって閉じる＝袋とじ）。
  for (const b of foundationBeams) {
    rects.push(<Rect key={`sill:${b.id}`} {...bandRect(b, spanLo(b), spanHi(b), SILL_HALF)}
      fill={sillColor} stroke={sillColor} strokeWidth={strokeWidth} opacity={0.3} listening={false} />);
  }
  return rects;
}

// 柱のダイヤフラム外形寸法(mm)。鋼管のみ（断面+e の四角）。鋼管以外・断面未登録は null。
function columnDiaphragmSize(column) {
  const sec = findSectionEntry(column.sectionDefId);
  const e = diaphragmProjection(sec);
  if (!e) return null;
  return { w: sec.width + 2 * e, h: sec.height + 2 * e };
}

// 柱のみの描画。構造モードでは全LODで実断面形状（ColumnSymbol）を実寸表示する。
// STANDARDだけは塗りなし（輪郭線のみ。中実断面が重なる範囲を確認しやすくするため）。
// diaphragm=true（構造モード×詳細描画）のとき、鋼管柱は断面の外側にダイヤフラム外形（四角）を描く。
export const ColumnsLayer = observer(({ graph, viewport, diaphragm = false }) => {
  if (!graph) return null;
  const scale   = Math.min(viewport.scaleX, viewport.scaleY);
  const outline = viewport.lodLevel === LodLevel.STANDARD;
  const outlineStrokeWidth = resolveStrokeWidth(LINE_WEIGHT_MM.medium, scale);
  const diaStrokeWidth = resolveStrokeWidth(LINE_WEIGHT_MM.thin, scale);
  return graph.columns.flatMap(column => {
    const color = COLOR_BY_MATERIAL[column.materialType];
    const els = [];
    // ダイヤフラム外形（断面の背面に四角の輪郭）。詳細描画かつ鋼管のみ。
    const d = diaphragm ? columnDiaphragmSize(column) : null;
    if (d) {
      els.push(
        <Rect
          key={`dia:${column.id}`}
          x={column.x} y={column.y}
          width={d.w} height={d.h}
          offsetX={d.w / 2} offsetY={d.h / 2}
          rotation={column.rotation}
          stroke={color} strokeWidth={diaStrokeWidth}
          listening={false}
        />
      );
    }
    els.push(
      <ColumnSymbol
        key={column.id}
        column={column}
        color={color}
        outline={outline}
        outlineStrokeWidth={outlineStrokeWidth}
      />
    );
    return els;
  });
});

// 構造モード（appMode === 'structure'）専用レイヤー。
// 柱は (column.x, column.y) に断面記号、梁・耐力壁は軸CL沿いに coord1〜coord2 の帯を描画する。
// 壁（ShapesLayer.jsx）と同じ3段階LOD設計：略図=単線、標準=帯（仮サイズ）、詳細=帯（実寸 or 実断面）。
//
// 各カテゴリの供給グラフは図面合成（composition）から解決する。「柱＝1つ下の階・床下材＝自階」という
// 帰属（伏図慣習）はこのレイヤーではなく FigureDef（structuralFigure.js）が決める——レンダラは
// 「カテゴリをどう描くか」だけを知り、「どの階のどのグラフか」は composition.graphForCategory に委ねる。
// z-order は描画順（柱→基礎→梁→スラブ→耐力壁）で再現し、レイヤ宣言順には依存させない。
export const StructuralLayer = observer(({ composition, viewport, project }) => {
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

  // 木造基礎伏図の土台・ベース帯（問題.md）。基礎梁(role:'foundation')がある＝基礎伏図、かつ実効主構造が木造のときのみ。
  // ベースの有無は基礎種別（べた基礎はベースなし＝土台のみ）。実効主構造は基礎伏図グラフ（=自階）の上書きを優先。
  const foundationBeams = (beam?.graph?.beams ?? []).filter(b => b.role === 'foundation');
  const effStructure = beam?.graph?.structureOverride ?? project?.structuralInfo?.mainStructure;
  const woodFoundation = foundationBeams.length > 0 && typeof effStructure === 'string' && effStructure.startsWith('木造');
  const drawBase = woodFoundation && project?.structuralInfo?.foundationType !== 'ベタ基礎';

  return (
    <>
      <Group {...groupPropsForStyle(column?.spec.style)}>
        <ColumnsLayer graph={column?.graph} viewport={viewport} diaphragm={lod === LodLevel.DETAIL} />
      </Group>
      {woodFoundation && (
        <Group {...groupPropsForStyle(footing?.spec.style)}>
          {woodFoundationBands(foundationBeams, drawBase,
            COLOR_BY_MATERIAL[StructuralMaterialType.WOOD], COLOR_BY_MATERIAL[StructuralMaterialType.RC], thin)}
        </Group>
      )}
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
          // 詳細描画では梁を柱断面ではなくダイヤフラム端まで（鋼管柱のみ e 分だけ手前で止まる）。
          const { coord1, coord2 } = b.spanForColumns(displayedColumns, { diaphragm: lod === LodLevel.DETAIL });
          const p1 = b.isVertical ? { x: b.axisValue, y: coord1 } : { x: coord1, y: b.axisValue };
          const p2 = b.isVertical ? { x: b.axisValue, y: coord2 } : { x: coord2, y: b.axisValue };
          const width = beamRenderWidth(b, lod);
          // 剛接合（鉄骨）の継手記号。記号の長さは描画中の帯幅に合わせる（単線LODは実断面幅を使う）。
          const jointMarks = b.rigidJointCoords(displayedColumns, { diaphragm: lod === LodLevel.DETAIL })
            .flatMap((along, i) => jointMarkLines(`joint:${b.id}:${i}`, b, along, (width ?? b.sectionWidth) / 2,
              color, medium, lod === LodLevel.DETAIL));
          if (width == null) {
            return [
              <Line key={b.id} points={[p1.x, p1.y, p2.x, p2.y]} stroke={color} strokeWidth={thin} dash={beamDash} listening={false} />,
              ...jointMarks,
            ];
          }
          const lo = Math.min(coord1, coord2), hi = Math.max(coord1, coord2);
          // ピン接合の梁（小梁、およびピン指定した鉄骨の大梁）は端部が母材の縁+クリアランスで止まる
          // （通しで描く剛接合の梁・基礎梁・軒桁とは異なり端が構造物に突き当たらない）ため、開いた2本線の
          // ままだと切りっぱなしに見える。端を横断する線分で閉じ、閉矩形（口の字）で描く
          // （bandRect は foundation の帯と共通の実装）。
          if (b.isPinJoint) {
            return [
              <Rect key={b.id} {...bandRect(b, lo, hi, width / 2)}
                stroke={color} strokeWidth={medium} dash={beamDash} listening={false} />,
            ];
          }
          return [
            ...bandLines(`beam:${b.id}`, b.isVertical, b.axisValue, width / 2, [[lo, hi]], color, medium, beamDash),
            ...jointMarks,
          ];
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
