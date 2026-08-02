// node:test 用の使い捨てフィクスチャ。実際の core.js / PlanGraph（CL・ngraph・rbush等）は持ち出さず、
// memberNumbering.js / memberGroups.js の採番ロジックが読む最小限のプロパティだけを持つダックタイピングの
// 代役を使う（既存のscratchpadスモークスクリプトと同じ方針）。ファイル名に ".test." を含めない
// （node --test の既定glob対象から外し、テスト本体として実行されないようにするため）。
//
// memberNumberIndex/memberGroupLedger は実 core.js と同じ「実 MobX の observable.map()」を使う
// （plain Map ではない）——deep な observable.map() は set() に渡した plain object/Map/Set を
// 別オブジェクトへ複製して格納するため（split-brain）、plain Map では検出できないバグを実際に見逃した
// 再発済みの教訓（memberNumbering.js collectFloorGroups 参照）。
import { observable } from 'mobx';
import { NUMBERED_MAPS } from './memberCatalog.js';

function baseEntity(id, extra) {
  return {
    id, memberNo: null, numberGroupId: null,
    setMemberNo(v) { this.memberNo = v; },
    setNumberGroupId(v) { this.numberGroupId = v; },
    setField(k, v) { this[k] = v; },
    ...extra,
  };
}

export function makeWall(id, thickness, extra = {}) {
  return baseEntity(id, {
    materialType: 'RC', thickness, wallType: 'RC',
    verticalBars: { size: 'D10', pitch: 200 }, horizontalBars: { size: 'D10', pitch: 200 },
    ...extra,
  });
}

export function makeColumn(id, sectionDefId, extra = {}) {
  return baseEntity(id, {
    materialType: 'RC', sectionDefId, role: 'standard',
    mainBars: { count: 4, size: 'D19' }, hoopBars: { size: 'D10', pitch: 100 },
    ...extra,
  });
}

export function makeBeam(id, sectionDefId, extra = {}) {
  return baseEntity(id, {
    materialType: 'STEEL', sectionDefId, role: 'primary',
    beamWidth: null, beamDepth: null,
    ...extra,
  });
}

/** entities は { columnMap: [...], beamMap: [...], ... }（省略したmapは空）。 */
export function makeGraph(planeId, entities = {}, isRoofPlane = false) {
  const g = { plane: { id: planeId, isRoofPlane } };
  for (const m of NUMBERED_MAPS) g[m] = new Map((entities[m] ?? []).map(e => [e.id, e]));
  return g;
}

export function makeProject(planes) {
  return { planes, memberNumberIndex: observable.map(), memberGroupLedger: observable.map() };
}
