import { observer } from 'mobx-react-lite';
import { Layer, Group } from 'react-konva';
import { LodLevel } from '../viewport.js';
import { makeFloorLevelPrefix } from '../floorNumber.js';
import { INSET } from '../layout.js';
import { OpeningsLayer } from './OpeningsLayer.jsx';
import { ShapesLayer } from './ShapesLayer.jsx';
import { FinishModeLayer } from '../finish/FinishModeLayer.jsx';
import { StairLayer } from './StairLayer.jsx';
import { RoomLabelsLayer } from './RoomLabelsLayer.jsx';
import { StepSectionLayer } from './StepSectionLayer.jsx';
import { VoidLayer } from './VoidLayer.jsx';
import { StructuralLayer, ColumnsLayer } from './StructuralLayer.jsx';
import { MemberTagLayer } from './MemberTagLayer.jsx';
import { OpeningTagLayer } from './OpeningTagLayer.jsx';
import { PRIMARY_DIMENSION_FIELD_BY_MAP } from '../structural/memberCatalog.js';
import { IntersectionMarkers } from './CenterLinesLayer.jsx';
import { GutterLayer } from './GutterLayer.jsx';
import { SnapIndicator } from './SnapIndicator.jsx';
import { DrawPreview } from './DrawPreview.jsx';
import { CLAddPreview } from './CLAddPreview.jsx';
import { WallRefIndicator } from './WallRefIndicator.jsx';
import { SiteLinesLayer, SiteDrawPreview } from './SiteLinesLayer.jsx';
import { ElevationLayer } from './ElevationLayer.jsx';

// ================================================================
// Stage 内の描画レイヤ束（world / overlay / ui の3 Layer）。
// App.jsx から JSX をそのまま移設したもの（挙動変更ゼロ・派生値の計算はApp側に残す）。
// graph.*/project.*/mode.*/viewport.* の observable を読むため observer で包む。
// ================================================================
export const SceneLayers = observer(({
  graph, project, appMode, mode, modeRef, viewport, size, columnAxisMode,
  isStairMode, installEntries, upperEntries, stairLaneGapMm, stairBreakOverhangMm, stairUnderClips,
  structComposition, upperVoidCrosses,
  snapPoint, cursorWorld, clPreview, clDialog, wallDialog, menu,
  setShowStructuralInfoDialog, setMemberFocusRequest, setStatusMenu,
  onOpeningTagClick,
}) => {
  // 展開モードは平面・通り芯・寸法を一切出さない専用画面（描画エリア＋ガター全域）。
  // 既存レイヤ群（INSETクリップ・viewport Group等）は一切通らない。
  if (appMode === 'elevation') {
    return <Layer name="elevation"><ElevationLayer mode={mode} size={size} /></Layer>;
  }

  return (
    <>
      <Layer name="world">
        {/* ガーターレイヤー（通り芯本体・丸ラベル・通り芯寸法）— window全体・クリップなし・描画エリアと同倍率 */}
        <Group
          x={viewport.offsetX}
          y={viewport.offsetY}
          scaleX={viewport.scaleX}
          scaleY={viewport.scaleY}
        >
          {appMode !== 'site' && <GutterLayer
            graph={graph}
            viewport={viewport}
            width={size.width}
            height={size.height}
            columnAxisMode={columnAxisMode}
            appMode={appMode}
          />}
        </Group>

        {/* 描画域を通り芯表示エリアの内側にクリップ（上端はツールバー＋上ガター分だけ下げる） */}
        <Group
          clipX={INSET.left}
          clipY={INSET.top}
          clipWidth={size.width  - INSET.left - INSET.right}
          clipHeight={size.height - INSET.top - INSET.bottom}
        >
          <Group
            x={viewport.offsetX}
            y={viewport.offsetY}
            scaleX={viewport.scaleX}
            scaleY={viewport.scaleY}
          >
            {appMode === 'finish' && mode && (
              <FinishModeLayer
                graph={graph}
                viewport={viewport}
                selectedRoomId={mode.selectedRoomId}
                previewCells={mode.previewCells}
              />
            )}
            {isStairMode && (
              <StairLayer
                entries={[...installEntries, ...upperEntries]}
                viewport={viewport}
                detail={viewport.lodLevel === LodLevel.DETAIL}
                laneGapMm={stairLaneGapMm}
                breakOverhangMm={stairBreakOverhangMm}
                selectedStairId={appMode === 'finish' ? mode?.selectedStairId : null}
                onSelectStair={appMode === 'finish' ? (id => modeRef.current?.selectStair(id)) : null}
              />
            )}
            {appMode === 'site' && mode && (
              <SiteLinesLayer
                site={project.site}
                viewport={viewport}
                selectedLineId={mode.selectedLineId}
                onSelectLine={id => modeRef.current?.selectLine(id)}
              />
            )}
            {appMode === 'site' && <SiteDrawPreview mode={mode} />}
            {/* 構造モードでは平面図（壁・建具）を描画しない。通り芯と構造部材のみ表示する。 */}
            {appMode !== 'structure' && <ShapesLayer graph={graph} viewport={viewport} stairUnderClips={stairUnderClips} />}
            {appMode !== 'structure' && <OpeningsLayer graph={graph} viewport={viewport} selectedId={appMode === 'opening' ? mode?.selectedOpeningId : null} />}
            {/* 平面モードでは自階の柱（構造モードで生成・保存済み）を表示する。構造モードの伏図と違い
                1つ下の階ではなく自階graphの柱を描く（その階の平面に立つ柱はその階のもの）。 */}
            {appMode === 'floorplan' && <ColumnsLayer graph={graph} viewport={viewport} />}
            {appMode === 'structure' && <StructuralLayer composition={structComposition} viewport={viewport} project={project} />}
            {appMode === 'structure' && (
              <MemberTagLayer
                composition={structComposition}
                viewport={viewport}
                onTagClick={(entity, mapName) => {
                  setShowStructuralInfoDialog(true);
                  setMemberFocusRequest({ mapName, tag: entity.memberNo, fieldKey: PRIMARY_DIMENSION_FIELD_BY_MAP[mapName] ?? null, entityId: entity.id });
                }}
                onStatusMenuRequest={(entity, pos) => setStatusMenu({ entity, pos })}
              />
            )}
            {appMode === 'floorplan' && (
              <RoomLabelsLayer
                graph={graph}
                viewport={viewport}
                floorPrefix={makeFloorLevelPrefix(project.activePlane?.startFloor ?? 1)}
              />
            )}
            {/* 段差断面: 段差線は全LOD（略図＝細線 / 標準・詳細＝中線）、ハッチ・寸法は詳細のみ
                ——レイヤー内部でLOD分岐する */}
            {appMode === 'floorplan' && <StepSectionLayer graph={graph} viewport={viewport} />}
            {(appMode === 'floorplan' || appMode === 'finish') && (
              <VoidLayer graph={graph} viewport={viewport} upperCrosses={upperVoidCrosses} />
            )}
            {/* 表示可否は shouldShowOpeningTags(appMode, lodLevel) が唯一の判定
                （floorplan×DETAIL / opening×STANDARD・DETAILのみ。レイヤー内部でnullを返す） */}
            <OpeningTagLayer
              graph={graph}
              project={project}
              viewport={viewport}
              appMode={appMode}
              onSelectOpening={onOpeningTagClick}
            />
            {appMode !== 'site' && <IntersectionMarkers graph={graph} viewport={viewport} />}
            <DrawPreview
              drawState={mode?.drawState ?? null}
              snapPoint={snapPoint}
              cursorWorld={cursorWorld}
            />
            <CLAddPreview value={clPreview} type={clDialog?.type} />
          </Group>
        </Group>
      </Layer>

      <Layer name="overlay">
        {!menu && <SnapIndicator snap={snapPoint} viewport={viewport} />}
        {wallDialog && wallDialog.nearbyCLs?.length > 0 && (
          <WallRefIndicator
            nearbyCLs={wallDialog.nearbyCLs}
            worldPos={wallDialog.worldPos}
            viewport={viewport}
          />
        )}
        {clDialog && clDialog.nearbyCLs?.length > 0 && (
          <WallRefIndicator
            nearbyCLs={clDialog.nearbyCLs}
            worldPos={clDialog.worldPos}
            viewport={viewport}
          />
        )}
      </Layer>

      <Layer name="ui" />
    </>
  );
});
