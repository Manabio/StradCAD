import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { Text, Group } from 'react-konva';
import { roomBounds } from '../finish/gridCells.js';
import { LodLevel } from '../viewport.js';
import { COLOR_BY_MATERIAL, columnRenderSize, beamRenderWidth } from './StructuralLayer.jsx';
import { groupPropsForStyle } from '../figure/figureStyle.js';

const FONT_SIZE_PX = 22; // スクリーン上の表示サイズ(px)。RoomLabelsLayer と同じ逆補正方式。
const TAG_GAP_MM = 30; // 部材本体の縁からタグまでの余白（実寸マージンに加算）

// 柱の実描画サイズ（StructuralLayer.jsxの単一実装を共用。描画と食い違うと結局重なるため）から
// タグをずらすマージン（半幅+余白）を求める。
function columnMargin(column) {
  return columnRenderSize(column) / 2 + TAG_GAP_MM;
}

// 独立フーチング・柱脚は LOD に関わらず常に widthX×widthY の実寸で描かれる（StructuralLayer.jsx参照）。
function footingMargin(footing) {
  return Math.max(footing.widthX, footing.widthY) / 2 + TAG_GAP_MM;
}

// 梁の実描画幅（StructuralLayer.jsxの単一実装を共用）からマージンを求める。nullは単線（幅0相当）。
function beamMargin(beam, lod) {
  return (beamRenderWidth(beam, lod) ?? 0) / 2 + TAG_GAP_MM;
}

// 耐力壁の実描画幅（StructuralLayer.jsx と同じロジック）からマージンを求める。
// SCHEMATICは単線（幅0相当）、STANDARD/DETAILは実厚みで描く（仮サイズが無い）。
function wallMargin(wall, lod) {
  if (lod === LodLevel.SCHEMATIC) return TAG_GAP_MM;
  return wall.thickness / 2 + TAG_GAP_MM;
}

// Tri-state（dimensionStatus）の文字色。'calculated'は材質別色（COLOR_BY_MATERIAL）を維持する。
const STATUS_COLOR = {
  auto:   '#9ca3af', // グレー — 構造計算の根拠のない自動算定値
  locked: '#111827', // 黒（太字） — 手動で寸法を固定
};

// タグ文字列のおおよその表示幅(px)。Text実測の代わりに文字数から近似する
// （タグは英数字主体のため、gutterPrimitives.jsx の CHAR_WIDTH_RATIO と同じ係数を流用）。
function estimateTagWidth(text, fontSize) {
  return text.length * fontSize * 0.62;
}

function isTouchDevice() {
  return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
}

// 部材タグ1件分。数字ラベル本体 + Tri-state表示（グレー/黒太字+🔒/チェックマーク）+
// hover（auto時に🔓を薄く表示）・クリック（構造パネルの構造リストタブを開き該当部材の寸法欄へフォーカス、
// onTagClick経由）・右クリック（calculatedの暫定手動トグル、onStatusMenuRequest経由）。
// ロックそのものは「構造リストタブで数値を手動編集した瞬間」に自動で掛かる（MemberListTab.jsx側）。
// x/y/offsetX/offsetY/rotationは呼び出し元（pointTags/axisTags/slabTags）の既存位置計算をそのまま渡す。
const MemberTag = observer(({ entity, mapName, x, y, offsetX, offsetY, rotation = 0, fontSize, materialColor, onTagClick, onStatusMenuRequest }) => {
  const [hover, setHover] = useState(false);
  const status = entity.dimensionStatus;
  const isAuto       = status === 'auto';
  const isLocked     = status === 'locked';
  const isCalculated = status === 'calculated';

  function handleClick() {
    onTagClick(entity, mapName);
  }

  const iconGap   = fontSize * 1.3;
  const checkPad  = fontSize * 0.15;
  const showOpenLock   = isAuto && (hover || isTouchDevice());
  const showClosedLock = isLocked;

  return (
    <>
      <Text
        x={x} y={y} offsetX={offsetX} offsetY={offsetY} rotation={rotation}
        text={entity.memberNo}
        fontSize={fontSize}
        fill={isAuto || isLocked ? STATUS_COLOR[status] : materialColor}
        fontStyle={isLocked ? 'bold' : 'normal'}
        onMouseEnter={e => { setHover(true); e.target.getStage().container().style.cursor = 'pointer'; }}
        onMouseLeave={e => { setHover(false); e.target.getStage().container().style.cursor = 'default'; }}
        onClick={handleClick}
        onTap={handleClick}
        onContextMenu={e => {
          e.evt.preventDefault();
          onStatusMenuRequest(entity, { x: e.evt.clientX, y: e.evt.clientY });
        }}
        listening
      />
      {isCalculated && (
        <Text
          x={x} y={y} offsetX={offsetX + checkPad} offsetY={offsetY + checkPad}
          rotation={rotation}
          text="✓"
          fontSize={fontSize * 0.6}
          fill="#16a34a"
          listening={false}
        />
      )}
      {(showOpenLock || showClosedLock) && (
        <Text
          x={x} y={y} offsetX={offsetX - iconGap} offsetY={offsetY}
          rotation={rotation}
          text={showClosedLock ? '🔒' : '🔓'}
          fontSize={fontSize * 0.8}
          opacity={showClosedLock ? 1 : 0.45}
          listening={false}
        />
      )}
    </>
  );
});

// 構造モード専用。entity.memberNo（部材タグ）を描画する。
// 柱・基礎/柱脚（点定義）はシンボルの左上、梁・耐力壁（軸定義）は画面に対して横方向に配置
// された部材なら線の上、縦方向に配置された部材なら線の左に文字の上を向けて（rotation=-90）
// 配置する。スラブ（面定義）は領域の重心。
// いずれも offsetX/offsetY で「線・点に最も近い辺の中心」をローカルの基準点に取ることで、
// rotation の有無に関わらずその基準点が指定した (x, y) に来るようにしている。
// 各カテゴリの供給グラフは図面合成（composition）から解決する（StructuralLayer.jsx の本体描画と
// 対象を一致させる）。柱＝1つ下の階・床下材＝自階の帰属は FigureDef が決め、ここは委ねるだけ。
export const MemberTagLayer = observer(({ composition, viewport, onTagClick, onStatusMenuRequest }) => {
  if (!composition) return null;
  const fontSize = FONT_SIZE_PX / viewport.scaleX;
  const lod = viewport.lodLevel;

  const columnGraph  = composition.graphForCategory('columnMap');
  const footingGraph = composition.graphForCategory('footingMap');
  const beamGraph    = composition.graphForCategory('beamMap');
  const slabGraph    = composition.graphForCategory('slabMap');
  const wallGraph    = composition.graphForCategory('wallMap');

  const pointTags = (entities, mapName, marginFor) => entities
    .filter(e => e.memberNo)
    .map(e => {
      const margin = marginFor(e);
      return (
        <MemberTag
          key={e.id}
          entity={e}
          mapName={mapName}
          x={e.x - margin}
          y={e.y - margin}
          offsetX={estimateTagWidth(e.memberNo, fontSize)}
          offsetY={fontSize}
          fontSize={fontSize}
          materialColor={COLOR_BY_MATERIAL[e.materialType]}
          onTagClick={onTagClick}
          onStatusMenuRequest={onStatusMenuRequest}
        />
      );
    });

  const axisTags = (entities, mapName, marginFor) => entities
    .filter(e => e.memberNo)
    .map(e => {
      const margin = marginFor(e);
      const mid = (e.coord1 + e.coord2) / 2;
      const x = e.isVertical ? e.axisValue - margin : mid;
      const y = e.isVertical ? mid : e.axisValue - margin;
      return (
        <MemberTag
          key={e.id}
          entity={e}
          mapName={mapName}
          x={x}
          y={y}
          offsetX={estimateTagWidth(e.memberNo, fontSize) / 2}
          offsetY={fontSize}
          rotation={e.isVertical ? -90 : 0}
          fontSize={fontSize}
          materialColor={COLOR_BY_MATERIAL[e.materialType]}
          onTagClick={onTagClick}
          onStatusMenuRequest={onStatusMenuRequest}
        />
      );
    });

  const slabTags = (entities, mapName) => entities
    .filter(e => e.memberNo)
    .map(e => {
      const b = roomBounds(e.cells, slabGraph);
      if (!b || b.x1 === Infinity) return null;
      return (
        <MemberTag
          key={e.id}
          entity={e}
          mapName={mapName}
          x={(b.x1 + b.x2) / 2}
          y={(b.y1 + b.y2) / 2}
          offsetX={estimateTagWidth(e.memberNo, fontSize) / 2}
          offsetY={fontSize / 2}
          fontSize={fontSize}
          materialColor={COLOR_BY_MATERIAL[e.materialType]}
          onTagClick={onTagClick}
          onStatusMenuRequest={onStatusMenuRequest}
        />
      );
    });

  return (
    <>
      <Group {...groupPropsForStyle(composition.styleForCategory('columnMap'))}>
        {pointTags(columnGraph?.columns ?? [], 'columnMap', c => columnMargin(c))}
      </Group>
      <Group {...groupPropsForStyle(composition.styleForCategory('footingMap'))}>
        {pointTags(footingGraph?.footings ?? [], 'footingMap', footingMargin)}
      </Group>
      <Group {...groupPropsForStyle(composition.styleForCategory('beamMap'))}>
        {axisTags(beamGraph?.beams ?? [], 'beamMap', b => beamMargin(b, lod))}
      </Group>
      <Group {...groupPropsForStyle(composition.styleForCategory('wallMap'))}>
        {axisTags(wallGraph?.structuralWalls ?? [], 'wallMap', w => wallMargin(w, lod))}
      </Group>
      <Group {...groupPropsForStyle(composition.styleForCategory('slabMap'))}>
        {slabTags(slabGraph?.slabs ?? [], 'slabMap')}
      </Group>
    </>
  );
});
