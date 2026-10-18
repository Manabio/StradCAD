/**
 * 天伏パネル「外部」タブ（軒裏）の行の組み立て（純モジュール。react・store.js・snap.js・.jsx・graphDerived を引かない）。
 * 行はセル群を持たない＝選択なし。
 *  - 下屋: 天伏 N の外部タブは直上階 N+1 の下屋（feature ROOF で roofSpec のある部屋）の軒裏を表示のみで出す（editable:false。
 *    編集は仕上げモードの N+1 外部タブ）。1件なら「軒裏」、2件以上は「軒裏1」「軒裏2」…。下地の表示は上階の主構造（木造のときだけ）。
 *  - 主屋根: 最上階（とその検討案）では自階の graph.mainRoofSpec の軒裏を末尾に出す（editable:true。下地の表示は自階の主構造）。
 * 軒裏の実効値は resolveSoffitSpec（空を既定へ読み替える唯一の入口）。表示名は materialDisplay（略称）。
 */
import { isRoofFeature } from '../core/constants.js';
import { isTopFloorPlane } from '../core/project.js';
import { effectiveStructure } from '../structural/structureRules.js';
import { resolveSoffitSpec } from '../finish/roof/roofDefaults.js';
import { soffitBackingVisible } from '../finish/roof/roofInput.js';
import { materialDisplay } from './ceilingPanelRows.js';

function soffitRow({ id, kind, name, roomId, spec, structure, editable, materialMap }) {
  const s = resolveSoffitSpec(spec);
  return {
    id, kind, name, roomId, spec, editable,
    material: s.material,
    backing: s.backing,
    orientation: s.orientation,
    note: s.note,
    materialLabel: materialDisplay(materialMap, s.material),
    backingLabel: materialDisplay(materialMap, s.backing),
    backingShown: soffitBackingVisible(structure),
  };
}

/**
 * @param {{ graph: object|null, aboveGraph?: object|null, project?: object|null, materialMap?: Map<string, object>|null }} ctx
 *   graph＝自階／aboveGraph＝直上階の peek（無ければ下屋の行なし）／project＝最上階判定と主構造
 * @returns {Array<{ id: string, kind: 'leanTo'|'main', name: string, roomId: string|null, spec: object, editable: boolean,
 *   material: string, backing: string, orientation: string, note: string, materialLabel: string|null, backingLabel: string|null, backingShown: boolean }>}
 */
export function ceilingExteriorRows({ graph, aboveGraph = null, project = null, materialMap = null }) {
  const rows = [];
  const roofRooms = (aboveGraph?.rooms ?? []).filter(r => isRoofFeature(r.feature) && r.roofSpec);
  if (roofRooms.length > 0) {
    const structure = effectiveStructure(aboveGraph, project);
    roofRooms.forEach((room, i) => {
      rows.push(soffitRow({
        id: `soffit:${room.id}`, kind: 'leanTo', roomId: room.id, spec: room.roofSpec, structure, editable: false, materialMap,
        name: roofRooms.length === 1 ? '軒裏' : `軒裏${i + 1}`,
      }));
    });
  }
  if (graph?.mainRoofSpec && isTopFloorPlane(project, graph.plane)) {
    rows.push(soffitRow({
      id: 'soffit:main', kind: 'main', roomId: null, spec: graph.mainRoofSpec, structure: effectiveStructure(graph, project),
      editable: true, materialMap, name: '軒裏（主屋根）',
    }));
  }
  return rows;
}
