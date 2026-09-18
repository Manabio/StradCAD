import { observer } from 'mobx-react-lite';
import { Line, Rect, Circle, Group, Text } from 'react-konva';
import { StructuralMaterialType, LINE_WEIGHT_MM } from '../core.js';
import { cellBoundsFromKey } from '../finish/gridCells.js';
import { findSectionEntry, diaphragmProjection } from '../structural/sectionCatalog.js';
import { rulesFor, effectiveStructure } from '../structural/structureRules.js';
import { resolveBeamJunctionSpans } from '../structural/beamJunction.js';
import {
  framingColumnGroups, framingColor, framingColorOverride, columnSectionSize, framingColumnLineWeight,
  beamDepthMarks, pickMembersOnFigure, pickColumnsOnFigure, columnRenderSize,
} from '../structural/framingDrawing.js';
import { planColumnWraps } from './wallDrawPlan.js';
import { columnWrapRenderProps, columnWrapStrokeWidth } from '../structural/columnWrapLineJoin.js';
import { graphComputed } from './graphDerived.js';
import { LodLevel, resolveStrokeWidth } from '../viewport.js';
import { ColumnSymbol, ColumnCrossMark } from './ColumnSymbol.jsx';
import { groupPropsForStyle, dashForStyle } from '../figure/figureStyle.js';
import { DIMENSION_LINE_WEIGHT, NUM_FONT_PX, TEXT_GAP_PX } from './dimensionStyle.js';
import { memberSelectionRects, MEMBER_SELECTION_COLOR, MEMBER_SELECTION_FILL, MEMBER_SELECTION_STROKE_PX } from '../structural/memberSelection.js';

export const COLOR_BY_MATERIAL = {
  [StructuralMaterialType.WOOD]:  '#92400e',
  [StructuralMaterialType.STEEL]: '#475569',
  [StructuralMaterialType.RC]:    '#1e293b',
};

// 平面図で柱断面を「壁と同じ線」として描くときの線色（主構造ルール drawing.planColumnColor==='wall'。
// 壁の既定色 core/shapeBase.js の color '#000000' と同値）。
const PLAN_WALL_LINE_COLOR = '#000000';

// 柱は構造図では全LODで実寸表示する（梁・耐力壁の仮サイズLODとは非対称）。柱のフォールバック辺長
// （sectionDefId がカタログに無い場合）は structural/framingDrawing.js の COLUMN_FALLBACK_SIZE_MM を
// 単一の実装として使う（二重管理しない）。BEAM_WIDTH_MM は梁の仮表示幅。
const BEAM_WIDTH_MM  = 30;  // 梁の簡易表示の幅

// 伏図の梁タップ（タグの代替。structural/framingDrawing.js pickMembersOnFigure が唯一の判定先）の
// ヒット幅(px)。openings/OpeningsLayer.jsx の OPENING_HIT_PX と同じ考え方（画面上で一定の太さを保つ）。
const MEMBER_HIT_PX = 8;

// 非正角材（成≠幅）の標記は寸法線に見立てる（ユーザー裁定2026-09-16。設計意図は
// .claude/structural-model.md ステップ4第3単位③）——「幅×成」文字のフォントサイズ・平行線からの
// 離れは寸法線と同じ renderer/dimensionStyle.js（NUM_FONT_PX・TEXT_GAP_PX）を単一の真実として使う
// （このレイヤー専用のフォントサイズ定数は持たない）。

// タグ文字列のおおよその表示幅(px)。gutterPrimitives.jsx/StepSectionLayer.jsx と同じ
// CHAR_WIDTH_RATIO(0.62)をレイヤーごとにローカル定義する既存パターン（Text実測を避ける）。
const CHAR_WIDTH_RATIO = 0.62;
function estimateTextWidth(text, fontSize) {
  return text.length * fontSize * CHAR_WIDTH_RATIO;
}

// 剛接合（鉄骨）の継手記号。位置は構造芯から RIGID_JOINT_OFFSET_MM（core側の定数）内側で、
// 梁を横断する線として描く。略図・標準は1本、詳細は2本（母材を切って突き合わせる継手の見え方。
// 切断幅そのものではなく作図上の離れ）。
// 2本の離れは「画面（紙面）上の実寸1mm」——モデル空間の1mmではない。ワールド距離へは
// scaleDenominator を掛けて換算し、ズームに依らず画面px一定にする（gutterLabelHits.js の
// offsetMm「実画面で5cm」と同じ換算。モデル1mmのままだと 1/scaleDenominator 実mm＝1/60でも
// 0.06px程度にしかならず、倍率で伸縮する見えない線になる）。
const RIGID_JOINT_DETAIL_GAP_MM = 1;
function jointDetailGapWorld(viewport) { return RIGID_JOINT_DETAIL_GAP_MM * viewport.scaleDenominator; }

// 継手記号1箇所ぶんの Konva 要素。along=梁に沿う座標、half=記号の半長（梁の見付き幅の半分）、
// gap=2本線の離れ（ワールドmm。0なら1本）。
function jointMarkLines(keyBase, beam, along, half, color, strokeWidth, gap) {
  const offsets = gap > 0 ? [-gap / 2, gap / 2] : [0];
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

// 柱の実描画サイズ(mm)。実装は structural/framingDrawing.js の columnRenderSize（react-konvaを持たない
// 純モジュール側。QA指摘・ステップ4: node:testから直接importして失敗系を検証できるようにするため
// こちら側では二重定義せず re-export のみにした）。MemberTagLayer.jsx はこの再エクスポートを
// './StructuralLayer.jsx' から import しており、そちらの import 文は変更していない。
export { columnRenderSize };

// pick=false時（下階柱×・非在来の柱・onMemberClick未指定など）の柱ヒット域props。モジュールスコープ
// 定数にして毎レンダー新規オブジェクトを渡さない——ColumnSymbolはobserver（mobx-react-liteが内部で
// React.memoを使う）で包まれているため、参照の変わるpropsを渡すと浅い比較が毎回falseになりmemoが
// 効かなくなる（pick=falseの経路＝ほぼ全ての柱で常時発生する回帰。QA指摘・ステップ4）。
const COLUMN_HIT_PROPS_NONE = { listening: false };

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
// extraProps（既定{}）は各Lineへ素通しで追加するprops——伏図の梁タップ（pickMembersOnFigure）が
// listening/fillEnabled/hitStrokeWidthを2本線に重ねるためだけに使う（他の呼び出し元は影響なし）。
function bandLines(keyPrefix, isVertical, axisValue, half, segments, stroke, strokeWidth, dash, extraProps = {}) {
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
        {...extraProps}
      />
    );
  }));
}

// 帯のキャップ線（軸直交1本）。在来木造の梁の交点処理（structural/beamJunction.js
// resolveBeamJunctionSpans。B-3・2026-09-17裁定「通しが勝つ」）で、出隅（L字）の勝者側を敗者の
// 半幅ぶん控えたとき（ends[i].capped）、控えた端を閉じるための線——開いたままだと切りっぱなしに
// 見える（bandLinesの2本線は端を閉じない。従来どおり）。extraProps はbandLinesと同じくpickShapeProps
// を素通しするためだけに使う。
function bandCapLine(key, isVertical, axisValue, half, coord, stroke, strokeWidth, dash, extraProps = {}) {
  const p1 = isVertical ? { x: axisValue - half, y: coord } : { x: coord, y: axisValue - half };
  const p2 = isVertical ? { x: axisValue + half, y: coord } : { x: coord, y: axisValue + half };
  return (
    <Line key={key} points={[p1.x, p1.y, p2.x, p2.y]} stroke={stroke} strokeWidth={strokeWidth} dash={dash} listening={false} {...extraProps} />
  );
}

// 木造基礎伏図の「ベース」帯の寸法（問題.md）。1階壁芯（＝基礎梁の軸）から幅600
// （foundation.sectionDefaults.baseWidth）を振り分けて描く。角でトリム（直交する基礎梁に突き当たる端を
// 半幅だけ控えて突合せにする）。土台（幅150の中線）は role:'sill' の実体梁として一般の梁帯描画
// （bandLines）に乗るため、ここでは描かない（2026-09-18裁定。structural/woodAutoFill.js
// autoFillWoodSillBeams参照）。
const BAND_COORD_TOL = 1; // 端点一致判定の許容(mm)

// 基礎梁(role:'foundation')の軸に沿った帯1本のRect props（isVertical=軸がX方向）。lo/hi は span方向の座標。
function bandRect(beam, lo, hi, half) {
  return beam.isVertical
    ? { x: beam.axisValue - half, y: lo, width: half * 2, height: hi - lo }
    : { x: lo, y: beam.axisValue - half, width: hi - lo, height: half * 2 };
}

// 木造基礎伏図のベース帯を基礎梁から生成する。drawBase=false（べた基礎）なら何も描かない。
function woodFoundationBands(foundationBeams, drawBase, { baseColor, baseStrokeWidth }, foundationRules) {
  if (!drawBase) return [];
  const BASE_HALF = foundationRules.sectionDefaults.baseWidth / 2;
  const spanLo = b => Math.min(b.clStart.value, b.clEnd.value);
  const spanHi = b => Math.max(b.clStart.value, b.clEnd.value);
  // 端 coord で直交する基礎梁に突き当たるか（その直交梁のスパンが自軸を含む）。ベースのトリム判定に使う。
  const meetsPerp = (b, coord) => foundationBeams.some(p =>
    p.isVertical !== b.isVertical &&
    Math.abs(p.axisValue - coord) < BAND_COORD_TOL &&
    spanLo(p) - BAND_COORD_TOL <= b.axisValue && b.axisValue <= spanHi(p) + BAND_COORD_TOL);

  const rects = [];
  // ベース：端が直交基礎梁に突き当たる側を半幅控えてトリム（角で突合せ）。
  for (const b of foundationBeams) {
    const lo = meetsPerp(b, spanLo(b)) ? spanLo(b) + BASE_HALF : spanLo(b);
    const hi = meetsPerp(b, spanHi(b)) ? spanHi(b) - BASE_HALF : spanHi(b);
    if (hi <= lo) continue;
    rects.push(<Rect key={`base:${b.id}`} {...bandRect(b, lo, hi, BASE_HALF)}
      fill={baseColor} stroke={baseColor} strokeWidth={baseStrokeWidth} opacity={0.12} listening={false} />);
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
// finishWrap=true（平面モード）のとき、柱断面を太線で描き（ユーザー指示2026-08「平面では、柱断面を
// 太線」）、仕上げ包み（柱壁）の下地材・仕上げ材を細線で重ねる——包み厚の算出は展開図の柱型と同じ
// finish/columnWrap.js（単一の情報源）。構造モードには渡さない：伏図は躯体の図なので仕上げは載せない。
// framingSymbol（伏図専用。null|'section'|'box'|'boxCross'）は柱記号の選択のみに使う——'boxCross' の
// ときだけ対角線2本（ColumnCrossMark）を断面の後に重ねる。輪郭線を強制するかどうかは呼び出し側
// （StructuralLayer.jsx が structural/framingDrawing.js の framingColumnGroups から得た値）が
// outline props で明示する（既定false＝非在来・平面図経路は完全不変。ここで framingSymbol の有無から
// 輪郭を判断すると、非在来の下階柱にも 'section' という非null値が渡るだけで輪郭が強制される回帰になる
// ——実機QA指摘2026-09-15）。colorOverride は伏図の全黒指定（framingColor 'mono'）用。
// outlineWeight（伏図専用。LINE_WEIGHT_MM のキーまたはnull）は柱記号の輪郭線幅を呼び出し側が明示する
// props——**この柱の graph（下階柱は非アクティブな1つ下の平面）から rulesFor で自前に引いてはならない**
// （QA指摘2026-09-16: 下階柱グループの graph が権威になり、階ごとに主構造が異なる建物で下階柱だけ
// 線幅が割れる回帰。色・記号・輪郭と同じく、主題階（自階）の figureRules から
// StructuralLayer.jsx が framingColumnLineWeight(figureRules.drawing, lod) を解決して渡す）。
// 既定null＝'medium'（非伏図・平面図経路は渡さないため完全不変）。
export const ColumnsLayer = observer(({
  graph, viewport, diaphragm = false, finishWrap = false, framingSymbol = null, colorOverride = null,
  outline: outlineProp = false, outlineWeight = null, pick = false,
}) => {
  if (!graph) return null;
  const scale   = Math.min(viewport.scaleX, viewport.scaleY);
  // 平面では柱断面を太線の輪郭で描く（塗りではなく断面線で示す）。構造モードは従来どおり。
  // 主構造ルール（structureRules.js drawing）: 在来木造は包みを持たず、平面の柱断面は壁と同じ黒で描き
  // （ユーザー指示2026-09-14。材種色の断面に黒の包み線が重なって二重に見えていた）、輪郭は極太線にする
  // （壁厚＝柱寸法のとき柱の輪郭が壁の下地帯の線と重なり、壁と同じ太線では見分けられないため）。
  const drawing = rulesFor(effectiveStructure(graph)).drawing;
  const outline = finishWrap || viewport.lodLevel === LodLevel.STANDARD || outlineProp;
  const outlineStrokeWidth = resolveStrokeWidth(
    LINE_WEIGHT_MM[finishWrap ? drawing.planColumnLineWeight : (outlineWeight ?? 'medium')], scale,
    viewport.lineWeightsPx, viewport.pxPerMmX);
  const diaStrokeWidth = resolveStrokeWidth(
    LINE_WEIGHT_MM.thin, scale, viewport.lineWeightsPx, viewport.pxPerMmX);
  // 柱壁（仕上げ包み）の線は**壁と同じ太さ**にする（ユーザー指示2026-08）——太さの判断自体は
  // structural/columnWrapLineJoin.js の columnWrapStrokeWidth（壁の太さ決定と同じ関数・同じ
  // 引数系）に集約し、ここは呼ぶだけにする。
  const wrapStrokeWidth = columnWrapStrokeWidth(
    viewport.scaleX, viewport.scaleY, viewport.lodLevel === LodLevel.DETAIL, viewport.lineWeightsPx);
  // 壁に完全に埋まる柱は包みを持たない（columnWrap.js参照）。
  // 包みの解決は柱×壁の総当たり。graph が変わらない限り同じ結果なので graph 単位に
  // キャッシュする（graphDerived.js。パン・ズームの再レンダーで引き直さない）。
  // 包みの解決結果は壁の領域（renderer/wallDrawPlan.js の planColumnWraps）と共有する——同じ柱壁が
  // 壁側の覆い判定と柱側の描画で食い違わないための単一の入口（二重計算もしない）。
  const wrapByColumnId = finishWrap && drawing.columnFinishWrap
    ? graphComputed(graph, 'columnWrapByColumnId',
      () => new Map(planColumnWraps(graph).map(w => [w.column.id, w.wrapped])))
    : null;
  return graph.columns.flatMap(column => {
    const color = colorOverride ?? (finishWrap && drawing.planColumnColor === 'wall'
      ? PLAN_WALL_LINE_COLOR
      : COLOR_BY_MATERIAL[column.materialType]);
    const els = [];
    // 仕上げ包み（柱壁）。軸並行なので rotation は持たない——包みは向き合う壁の向きで決まる。
    // 実線同士のL字の角の外角を閉じる（structural/columnWrapLineJoin.js。第4弾）。柱単位で解決
    // するため、他の柱の包みとは1本ずつ別呼び出しにする（columnWrapRenderProps自体は複数件を
    // 受け取れるが、ここでは呼び出し単位=柱単位に揃えている）。
    const wrap = wrapByColumnId?.get(column.id);
    if (wrap) {
      const detail = viewport.lodLevel === LodLevel.DETAIL;
      // 包みの線は**壁の線**として描く（色は取り合う壁から継ぐ。finish/columnWrap.js の wallColor）
      // ——柱の材種色のままだと、同じ1本に見える仕上げ線が柱のところだけ色違いになる。
      els.push(...columnWrapRenderProps(
        [{ column, wrap, color: wrap.wallColor ?? color, strokeWidth: wrapStrokeWidth, detail }], viewport,
      ).map(p => (
        <Line key={p.key} points={p.points} stroke={p.color} strokeWidth={p.strokeWidth} listening={false} />
      )));
    }
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
    // 柱タップ（pick時のみ。自階柱□をタップして構造リストの共通カードを開く。ステップ4「柱は共通と
    // 個別指定の2層」）のヒット域。梁タップ（pickBeams）と同じ流儀——既存の描画図形（ColumnSymbol）に
    // 重ねる（openings/OpeningsLayer.jsx と同じく透明な当たり判定専用図形は新設しない）。
    // fillEnabled:false は必須（中実断面の塗り部分だけでなく外形の外まで当たり判定が広がるのを防ぐ）。
    // 辺長は columnRenderSize（このファイル冒頭。MemberTagLayer.jsxと共有する単一の実装）で解決する。
    const hitProps = pick
      ? { listening: true, fillEnabled: false, hitStrokeWidth: Math.max(MEMBER_HIT_PX / scale, columnRenderSize(column)) }
      : COLUMN_HIT_PROPS_NONE;
    // 伏図の下階柱記号 'cross'（在来木造）は×だけを描き、断面□は描かない——梁が下階柱の上に乗るため
    // 断面外形は見えず、描くと通しの梁の帯の中に柱寸の四角が残る（structural/framingDrawing.js
    // framingColumnGroups のコメント参照）。他の記号（null/'section'/'box'）は従来どおり断面を描く。
    if (framingSymbol !== 'cross') {
      els.push(
        <ColumnSymbol
          key={column.id}
          column={column}
          color={color}
          outline={outline}
          outlineStrokeWidth={outlineStrokeWidth}
          hitProps={hitProps}
        />
      );
    }
    // 伏図の下階柱記号（×）。対角線2本（断面□からはみ出す長さ）を描く（在来木造 framingColumnSymbol:'crossBox' の
    // 下階柱グループ＝symbol 'cross' のみ）。
    if (framingSymbol === 'cross') {
      els.push(
        <ColumnCrossMark
          key={`cross:${column.id}`}
          column={column}
          color={color}
          strokeWidth={outlineStrokeWidth}
        />
      );
    }
    // pick時だけ<Group name="column-symbol" columnId={column.id}>で包む。クリックの実行はここでは
    // 行わない——梁タップ（QA指摘F4）と同じ理由でKonvaのonclick/onTapは使わず、実際のタップ判定は
    // interaction/usePointerInteraction.jsのpointerUpがcolumnAtKonvaTargetで解決してonMemberClickを呼ぶ。
    return pick
      ? [
          <Group
            key={`pick:${column.id}`}
            name="column-symbol"
            columnId={column.id}
            onMouseEnter={e => { e.target.getStage().container().style.cursor = 'pointer'; }}
            onMouseLeave={e => { e.target.getStage().container().style.cursor = 'default'; }}
          >
            {els}
          </Group>,
        ]
      : els;
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
// selectedMemberIds（Set<string>|null。構造リストで展開中のカードの部材id集合＝StructuralModeState.selectedMemberIds）
// を渡すと、該当部材の実形状に半透明の青矩形（structural/memberSelection.js）を最前面に重ねて選択状態を示す。
export const StructuralLayer = observer(({ composition, viewport, project, onMemberClick = null, selectedMemberIds = null }) => {
  if (!composition) return null;
  const scale  = Math.min(viewport.scaleX, viewport.scaleY);
  const lod    = viewport.lodLevel;
  const thin   = resolveStrokeWidth(LINE_WEIGHT_MM.thin, scale, viewport.lineWeightsPx, viewport.pxPerMmX);
  const medium = resolveStrokeWidth(LINE_WEIGHT_MM.medium, scale, viewport.lineWeightsPx, viewport.pxPerMmX);

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

  // 伏図の部材線色・柱記号は主題階（自階＝床下材レイヤの供給階）の主構造ルールで決める
  // （structural/structureRules.js drawing.framingPlanColor / framingColumnSymbol）。在来木造だけ
  // 全黒（colorOf が恒等写像でなくなる）・下階柱に×／自階柱に□が乗る。他の主構造は colorOf が
  // COLOR_BY_MATERIAL の恒等写像のまま＝完全不変。
  const figureGraph = composition.graphForCategory('beamMap'); // 主題階（自階）
  const figureRules = rulesFor(effectiveStructure(figureGraph, project));
  const colorOf = m => framingColor(figureRules.drawing, COLOR_BY_MATERIAL[m]);

  // 梁タップ（タグの代替。structural/framingDrawing.js pickMembersOnFigure が唯一の判定先）を
  // 有効にするか。onMemberClick が渡されない呼び出し元（省略時null）では常に無効＝Reactツリー不変。
  const pickBeams = onMemberClick && pickMembersOnFigure(figureRules.drawing);
  // 柱タップ（自階柱□。ステップ4「柱は共通と個別指定の2層」）を有効にするか。onMemberClick未指定・
  // 非在来（pickColumnsOnFigureの判定はstructural/framingDrawing.js）では常に無効＝Reactツリー不変。
  const pickColumns = onMemberClick && pickColumnsOnFigure(figureRules.drawing);

  // 木造基礎伏図の土台・ベース帯（問題.md）。基礎梁(role:'foundation')がある＝基礎伏図、かつ実効主構造が木造のときのみ。
  // ベースの有無は基礎種別（べた基礎はベースなし＝土台のみ）。実効主構造は基礎伏図グラフ（=自階）の上書きを優先。
  // 帯の有無・ベース（独立フーチング）の有無は主構造ルール（structureRules.js foundation.drawsBands / hasBase）。
  const foundationBeams = (beam?.graph?.beams ?? []).filter(b => b.role === 'foundation');
  const foundationRules = figureRules.foundation;
  const woodFoundation = foundationBeams.length > 0 && foundationRules.drawsBands;
  const drawBase = woodFoundation && foundationRules.hasBase(project?.structuralInfo?.foundationType);

  // 梁の描画スパン（柱手前でトリム済み）を1箇所で解決する——梁本体の帯・継手記号と、非正角材の標記
  // （beamDepthMarks）が同じスパンを読むようにするため（二重計算・食い違いの防止）。
  const baseSpans = (beam?.graph?.beams ?? []).map(b => {
    const { coord1, coord2 } = b.spanForColumns(displayedColumns, { diaphragm: lod === LodLevel.DETAIL });
    return { beam: b, coord1, coord2 };
  });
  // 在来木造の梁の交点処理（B-3・2026-09-17裁定「通しが勝つ」）。実体スパン（上のbaseSpans。
  // 下階柱面での止め）はここでは書き換えず、描画専用の追加トリム（勝者面での止め・L字の角閉じ）だけを
  // structural/beamJunction.js resolveBeamJunctionSpans が解決する——drawing.beamJunction!=='throughWins'
  // （在来木造以外）は常に空Mapを返すため、非在来は完全不変（beamDrawSpansがbaseSpansとそのまま同じ）。
  const junctions = resolveBeamJunctionSpans(figureRules.drawing, baseSpans.map(({ beam: b, coord1, coord2 }) => ({
    id: b.id, role: b.role, isVertical: b.isVertical, axisValue: b.axisValue,
    end1: b.clStart.effectiveValue, end2: b.clEnd.effectiveValue,
    base1: coord1, base2: coord2,
    halfWidth: (beamRenderWidth(b, lod) ?? 0) / 2,
    sectionKey: b.sectionDefId,
  })));
  const beamDrawSpans = baseSpans.map(s => {
    const j = junctions.get(s.beam.id);
    return j ? { beam: s.beam, coord1: j.coord1, coord2: j.coord2, ends: j.ends } : s;
  });

  // 非正角材（成≠幅）の梁の標記（在来木造のみ。structural/framingDrawing.js beamDepthMarks が
  // 対象選定・幾何を丸ごと決める）。標記は寸法線に見立てる（ユーザー裁定2026-09-16）——文字サイズ・
  // 平行線からの離れは寸法線と同じ dimensionStyle.js の値を使う（逆補正方式はMemberTagLayer.jsxと同じ）。
  const beamDepthMarkList = beamDepthMarks(figureRules.drawing, lod, beamDrawSpans.map(({ beam: b, coord1, coord2 }) => ({
    id: b.id, isVertical: b.isVertical, axisValue: b.axisValue, coord1, coord2,
    sectionDefId: b.sectionDefId, role: b.role, materialType: b.materialType,
  })));
  const beamDepthLabelFontSize = NUM_FONT_PX / viewport.scaleX;
  const beamDepthLabelGap = TEXT_GAP_PX / viewport.scaleX;
  const beamDepthMarkStrokeWidth = resolveStrokeWidth(
    LINE_WEIGHT_MM[DIMENSION_LINE_WEIGHT], scale, viewport.lineWeightsPx, viewport.pxPerMmX);

  // 柱グループ（z-order: 配列順＝下階柱→自階柱）は structural/framingDrawing.js の
  // framingColumnGroups が「どのカテゴリを・どの記号で・輪郭を強制するか」を丸ごと決める
  // ——レンダラはこの配列を resolveCategory して map するだけ（非在来は要素1個＝columnMap のみ、
  // 輪郭強制なし＝平面図と同じ判断のまま。ここに判断を持たせない）。diaphragm は「配列の先頭」
  // という位置ではなく category === 'columnMap'（下階柱）で判定する——自階柱グループの並び順が
  // 変わっても意味を保つため（QA指摘F7）。自階柱にダイヤフラムは無い（従来どおり）。
  const columnColorOverride = framingColorOverride(figureRules.drawing);
  const columnGroups = framingColumnGroups(figureRules.drawing);
  // 1グループぶんの<Group><ColumnsLayer/></Group>。QA指摘4（2026-09-17）のz-order修正で描画位置が
  // 2箇所（後述backColumnGroups/frontColumnGroups）に分かれたため関数化し、二重実装を避ける。
  const renderColumnGroup = g => {
    const resolved = composition.resolveCategory(g.category);
    return (
      <Group key={g.category} {...groupPropsForStyle(resolved?.spec.style)}>
        <ColumnsLayer
          graph={resolved?.graph}
          viewport={viewport}
          diaphragm={g.category === 'columnMap' && lod === LodLevel.DETAIL}
          framingSymbol={g.symbol}
          colorOverride={columnColorOverride}
          outline={g.outline}
          outlineWeight={framingColumnLineWeight(figureRules.drawing, lod)}
          pick={pickColumns && g.category === 'columnMapSelf'}
        />
      </Group>
    );
  };
  // 柱タップ対象（columnMapSelf かつ pickColumns。在来木造の自階柱□のみ）だけ梁本体（beamDrawSpans）
  // より後（前面）に描く——梁が柱より後に描かれる既存z-order（画面上は梁が上、当たり判定も梁が勝つ）
  // のままだと、梁上に乗る管柱の中心タップが梁カードを開いてしまう（QA指摘4・実機観測）。非pickの
  // グループ（下階柱×・非在来の柱）は従来どおり最初（footings・梁より前）に描く——出力・z-orderとも
  // 完全不変。pickColumnsが偽（非在来・onMemberClick未指定）ならfrontColumnGroupsは常に空配列で
  // Reactツリーも不変。
  const backColumnGroups  = columnGroups.filter(g => !(pickColumns && g.category === 'columnMapSelf'));
  const frontColumnGroups = columnGroups.filter(g => pickColumns && g.category === 'columnMapSelf');

  return (
    <>
      {backColumnGroups.map(renderColumnGroup)}
      {woodFoundation && (
        <Group {...groupPropsForStyle(footing?.spec.style)}>
          {woodFoundationBands(foundationBeams, drawBase, {
            baseColor: colorOf(StructuralMaterialType.RC),
            baseStrokeWidth: thin,
          }, foundationRules)}
        </Group>
      )}
      <Group {...groupPropsForStyle(footing?.spec.style)}>
        {(footing?.graph?.footings ?? []).map(f => {
          // 矩形=widthX×widthY（柱・耐力壁と同じ実寸表現）、丸（sectionShape:'round'）=widthXを直径とする円。
          // 柱脚(ColumnBase)は丸柱の直下でも常に矩形（型枠の都合上、柱脚自体を丸で作ることは無いため）。
          // 独立基礎(IndependentFooting)と区別するため点線（'baseType' in footing で判定）。固有点線が無い場合のみ style 破線。
          const isColumnBase = 'baseType' in f;
          const color = colorOf(f.materialType);
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
        {beamDrawSpans.flatMap(({ beam: b, coord1, coord2, ends }) => {
          const color = colorOf(b.materialType);
          // 詳細描画では梁を柱断面ではなくダイヤフラム端まで（鋼管柱のみ e 分だけ手前で止まる）。
          // スパン(coord1/coord2)は上でbeamDrawSpansとして解決済み——非正角材の標記（beamDepthMarks）と
          // 同じスパンを読む（二重計算・食い違いの防止）。
          const p1 = b.isVertical ? { x: b.axisValue, y: coord1 } : { x: coord1, y: b.axisValue };
          const p2 = b.isVertical ? { x: b.axisValue, y: coord2 } : { x: coord2, y: b.axisValue };
          const width = beamRenderWidth(b, lod);
          // 剛接合（鉄骨）の継手記号。記号の長さはLODに依らず常に実断面幅（sectionWidth）にする——
          // 描画中の帯幅（beamRenderWidth）に合わせると、標準LODだけ仮幅30mmの半分＝画面0.8px程度に
          // 潰れて「省略では見えるのに一般では見えない」非対称になる（実機指摘）。LODで変えるのは
          // 本数（省略・一般=1本／詳細=2本）だけに揃える。
          const jointGap = lod === LodLevel.DETAIL ? jointDetailGapWorld(viewport) : 0;
          const jointMarks = b.rigidJointCoords(displayedColumns, { diaphragm: lod === LodLevel.DETAIL })
            .flatMap((along, i) => jointMarkLines(`joint:${b.id}:${i}`, b, along, b.sectionWidth / 2,
              color, medium, jointGap));
          // 梁タップのヒット域（pickBeams時のみ）。既存の描画図形（帯2本線／ピン閉矩形／単線）に重ねる
          // ——透明な当たり判定専用図形は新設しない（openings/OpeningsLayer.jsx と同じ流儀）。
          // fillEnabled:false は必須（Rect・閉矩形の内部までヒット域が広がるのを防ぐ）。
          const pickShapeProps = pickBeams
            ? { listening: true, fillEnabled: false, hitStrokeWidth: Math.max(MEMBER_HIT_PX / scale, width ?? 0) }
            : { listening: false };
          // pickBeams時だけ要素群を<Group name="beam-symbol" beamId={b.id}>で包む。クリックの実行は
          // ここでは行わない——Konvaのonclick/onTapは移動閾値・長押し状態を見ないため、梁上でパンを
          // 終える／長押しメニュー成立後のpointerupでもカードが開いてしまう（QA指摘F4）。openings/
          // OpeningsLayer.jsxのopening-symbol（openingId属性）と同じ流儀に揃え、実際のクリック判定は
          // interaction/usePointerInteraction.jsのpointerUpが「パン未開始かつ長押し未成立」のときだけ
          // beamId属性からエンティティを解決してonMemberClickを呼ぶ（App.jsxのopenMemberCard）。
          // 偽なら現状の配列をそのまま返す（非在来はReactツリーも不変）。
          const wrapPick = els => (pickBeams
            ? [
                <Group
                  key={b.id}
                  name="beam-symbol"
                  beamId={b.id}
                  onMouseEnter={e => { e.target.getStage().container().style.cursor = 'pointer'; }}
                  onMouseLeave={e => { e.target.getStage().container().style.cursor = 'default'; }}
                >
                  {els}
                </Group>,
              ]
            : els);
          if (width == null) {
            return wrapPick([
              <Line key={b.id} points={[p1.x, p1.y, p2.x, p2.y]} stroke={color} strokeWidth={thin} dash={beamDash} {...pickShapeProps} />,
              ...jointMarks,
            ]);
          }
          const lo = Math.min(coord1, coord2), hi = Math.max(coord1, coord2);
          // ピン接合の梁（小梁、およびピン指定した鉄骨の大梁）は端部が母材の縁+クリアランスで止まる
          // （通しで描く剛接合の梁・基礎梁・軒桁とは異なり端が構造物に突き当たらない）ため、開いた2本線の
          // ままだと切りっぱなしに見える。端を横断する線分で閉じ、閉矩形（口の字）で描く
          // （bandRect は foundation の帯と共通の実装）。
          if (b.isPinJoint) {
            return wrapPick([
              <Rect key={b.id} {...bandRect(b, lo, hi, width / 2)}
                stroke={color} strokeWidth={medium} dash={beamDash} {...pickShapeProps} />,
            ]);
          }
          // 在来木造の梁の交点処理（B-3。structural/beamJunction.js resolveBeamJunctionSpans）で
          // 出隅の勝者側が敗者半幅ぶん控えられた端（ends[i].capped）だけ、控えた端を閉じるキャップ線を
          // 追加する——単線LOD（width==null。上で早期returnする分岐）は対象外。非在来・非L字端は
          // ends が無い/capped=falseのため常に空（Reactツリー不変）。
          const capLines = (ends ?? []).flatMap((e, i) => (e?.capped
            ? [bandCapLine(`cap:${b.id}:${i}`, b.isVertical, b.axisValue, width / 2, i === 0 ? coord1 : coord2, color, medium, beamDash, pickShapeProps)]
            : []));
          return wrapPick([
            ...bandLines(`beam:${b.id}`, b.isVertical, b.axisValue, width / 2, [[lo, hi]], color, medium, beamDash, pickShapeProps),
            ...capLines,
            ...jointMarks,
          ]);
        })}
      </Group>
      {frontColumnGroups.map(renderColumnGroup)}
      <Group {...groupPropsForStyle(beam?.spec.style)}>
        {beamDepthMarkList.flatMap(mark => {
          const color = colorOf(mark.materialType);
          return [
            <Line key={`depthPar:${mark.id}`} points={mark.parallel} stroke={color} strokeWidth={beamDepthMarkStrokeWidth} listening={false} />,
            <Line key={`depthS0:${mark.id}`} points={mark.slopes[0]} stroke={color} strokeWidth={beamDepthMarkStrokeWidth} listening={false} />,
            <Line key={`depthS1:${mark.id}`} points={mark.slopes[1]} stroke={color} strokeWidth={beamDepthMarkStrokeWidth} listening={false} />,
            <Text
              key={`depthLabel:${mark.id}`}
              x={mark.label.x} y={mark.label.y}
              offsetX={estimateTextWidth(mark.label.text, beamDepthLabelFontSize) / 2}
              offsetY={beamDepthLabelFontSize + beamDepthLabelGap}
              rotation={mark.label.rotation}
              text={mark.label.text}
              fontSize={beamDepthLabelFontSize}
              fill={color}
              listening={false}
            />,
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
              fill={colorOf(s.materialType)}
              stroke={colorOf(s.materialType)}
              strokeWidth={thin}
              opacity={0.15}
              listening={false}
            />
          );
        }))}
      </Group>
      <Group {...groupPropsForStyle(wall?.spec.style)}>
        {(wall?.graph?.structuralWalls ?? []).flatMap(w => {
          const color    = colorOf(w.materialType);
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
      {/* 構造リストで展開中のカードの部材（selectedMemberIds）を選択状態として最前面に示す。
          どの部材をどんな矩形で示すかは structural/memberSelection.js が決め、ここは描画に使ったのと同じ
          解決済み幾何（表示中の柱集合・トリム済みの梁スパン・帯幅）を渡して Konva へ写すだけ。
          全黒の伏図（在来）でも見分けられるよう線色ではなく半透明の青塗り＋青枠で重ねる。listening:false。 */}
      {selectedMemberIds?.size > 0 && (() => {
        const selfColumns = composition.resolveCategory('columnMapSelf')?.graph?.columns ?? [];
        const toColumn = c => ({ id: c.id, x: c.x, y: c.y, rotation: c.rotation, ...columnSectionSize(c) });
        const rects = memberSelectionRects({
          columns:  [...displayedColumns, ...selfColumns].map(toColumn),
          beams:    beamDrawSpans.map(({ beam: b, coord1, coord2 }) => {
            const w = beamRenderWidth(b, lod);
            return { id: b.id, isVertical: b.isVertical, axisValue: b.axisValue, coord1, coord2, halfWidth: w == null ? null : w / 2 };
          }),
          footings: (footing?.graph?.footings ?? []).map(f => ({ id: f.id, x: f.x, y: f.y, widthX: f.widthX, widthY: f.widthY ?? f.widthX })),
          walls:    (wall?.graph?.structuralWalls ?? []).map(w => ({
            id: w.id, isVertical: w.isVertical, axisValue: w.axisValue, coord1: w.coord1, coord2: w.coord2, half: w.thickness / 2,
          })),
          slabs:    (slab?.graph?.slabs ?? []).map(s => ({
            id: s.id, cells: [...s.cells].map(key => cellBoundsFromKey(key, slab.graph)).filter(Boolean),
          })),
        }, selectedMemberIds, 1 / scale);
        return (
          <Group name="member-selection">
            {rects.map(({ key, ...r }) => (
              <Rect key={key} {...r} fill={MEMBER_SELECTION_FILL} stroke={MEMBER_SELECTION_COLOR}
                strokeWidth={MEMBER_SELECTION_STROKE_PX / scale} listening={false} />
            ))}
          </Group>
        );
      })()}
    </>
  );
});
