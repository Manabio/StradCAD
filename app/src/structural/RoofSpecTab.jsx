// 構造パネルの「外部」タブ——屋根の指定（主屋根・下屋の RoofSpec）を構造モードから編集する。
// 仕上げモードの外部タブの屋根の群（finish/roof/RoofGroup.jsx の RoofGroup／MainRoofGroup）をそのまま描く。出す群・編集対象の
// graph の判断は roofSpecTabModel.js（純モジュール）。屋外部屋の群・部位行は出さない（仕上げモードの削除・改名の機構に依存するため）。
// 確定は仕上げモードの withFinishUndo ではなく onStructureChanged の閉包内で spec.setField する——屋根の入力は伏図の小屋組・
// 軒の梁・柱貫通の唯一の入力なので、主構造の変更と同じ経路（recomputeStructuralComposition）で再計算し undo 1件にまとめる
// （RoofSpec は graph スナップショットに含まれるため undo で戻る）。検証・無変更判定は roofSpecFieldChanges を共用し、
// 無変更・不正な値は再計算も undo も起こさない（共通タブの patch=null と同じ規律）。
// 材料（軒裏材・下地）の選択肢は共通タブ・スラブカードと同じ useSteelSlabMaterials（未読込みは空＝現在値だけ）。
// 確定後は markDirty を明示する——自階の auto-save の autorun（storage/FloorSwapManager.js）は roofSpec・mainRoofSpec を見ないため、
// 部材が変わらない編集（屋根仕上げ・備考・軒裏）だけでは保存し忘れの警告が出ない（天伏の setMainRoofField と同じ理由。QA 指摘 2026-10-30）。
// 最上階で主屋根を変えても小屋伏図（R階）は同じ再計算では更新されず、R階へ移った突入境界で反映される（共通タブの他階と同じ）。
import { useMemo } from 'react';
import { observer } from 'mobx-react-lite';
import { isRoofFeature } from '@core';
import { ExteriorGroupType } from '../core/constants.js';
import { RoofGroup, MainRoofGroup, RoofZoneGroup } from '../finish/roof/RoofGroup.jsx';
import { roofSpecFieldChanges } from '../finish/roof/roofSpecCommit.js';
import { markDirty } from '../dirtyState.js';
import { useSteelSlabMaterials } from './useSteelSlabMaterials.js';
import { roofSpecTabGroups, ROOF_SPEC_TAB_EMPTY } from './roofSpecTabModel.js';

// 仕上げモードの外部タブ（FinishTable.jsx）の表のスタイルと同じ値（群の見た目をそろえる。RoofGroup が styles で受け取る）。
const cellInputStyle = {
  width: '100%',
  minWidth: 60,
  border: 'none',
  outline: 'none',
  background: 'transparent',
  fontSize: 12,
  padding: 0,
};
const cellBase = {
  border: '1px solid #cbd5e1',
  padding: '4px 8px',
  fontSize: 12,
  whiteSpace: 'nowrap',
  verticalAlign: 'middle',
};
const headerCell = {
  ...cellBase,
  background: '#f1f5f9',
  fontWeight: 600,
  textAlign: 'center',
  color: '#374151',
};
const ROOF_GROUP_STYLES = { cellBase, headerCell, cellInputStyle };

/**
 * RoofGroup／MainRoofGroup が要求する mode の形（project・材の参照・確定関数）を構造モード向けに組む。
 * 確定は onStructureChanged の閉包内で書く（上記ヘッダ）。戻り値は仕上げモードの setRoofField と同じ「書いたら true」。
 */
function buildRoofSpecMode({ target, project, materials, onStructureChanged }) {
  const materialMap = new Map((materials ?? []).map(m => [m.code, m]));
  const commit = (spec, field, value) => {
    if (!roofSpecFieldChanges(spec, field, value)) return false;
    onStructureChanged(() => { spec.setField(field, value); });
    markDirty();
    return true;
  };
  return {
    project,
    getMaterial: code => materialMap.get(code) ?? null,
    getMaterialsByCategory: category => (materials ?? []).filter(m => m.category === category),
    setRoofField: (roomId, field, value) => {
      const room = target?.roomMap.get(roomId);
      if (!room || !isRoofFeature(room.feature)) return false; // 仕上げモードの setRoofField と同じ判定（I1 で roofSpec も null）
      return commit(room.roofSpec, field, value);
    },
    setMainRoofField: (field, value) => commit(target?.mainRoofSpec, field, value),
    setRoofZoneField: (zoneId, field, value) => commit(target?.roofZones.find(z => z.id === zoneId)?.spec, field, value), // 不明な zoneId は spec なし＝commit が false
  };
}

export const RoofSpecTab = observer(function RoofSpecTab({ graph, composition, project, onStructureChanged }) {
  const materials = useSteelSlabMaterials();
  const belowGraph = composition?.graphForCategory('columnMap') ?? null;
  const { target, groups } = roofSpecTabGroups({ graph, belowGraph, project });
  const mode = useMemo(
    () => buildRoofSpecMode({ target, project, materials, onStructureChanged }),
    [target, project, materials, onStructureChanged],
  );

  return (
    <div style={{ overflowX: 'auto', overflowY: 'auto', flex: 1, padding: 8 }}>
      {groups.length === 0 && (
        <div style={{ ...cellBase, textAlign: 'center', color: '#94a3b8', padding: 20, border: 'none', whiteSpace: 'normal' }}>
          {ROOF_SPEC_TAB_EMPTY}
        </div>
      )}
      {groups.map(({ key, type, roomId, zoneId, part }) => {
        const roofRoom = type === ExteriorGroupType.ROOF ? target.roomMap.get(roomId) : null;
        const roofZone = type === ExteriorGroupType.ROOF_ZONE ? target.roofZones.find(z => z.id === zoneId) : null;
        return (
          <div key={key} style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#374151', marginBottom: 4 }}>{part}</div>
            {type === ExteriorGroupType.MAIN_ROOF && <MainRoofGroup graph={target} mode={mode} styles={ROOF_GROUP_STYLES} />}
            {roofZone && <RoofZoneGroup zone={roofZone} graph={target} mode={mode} styles={ROOF_GROUP_STYLES} />}
            {roofRoom && <RoofGroup room={roofRoom} graph={target} mode={mode} styles={ROOF_GROUP_STYLES} />}
          </div>
        );
      })}
    </div>
  );
});
