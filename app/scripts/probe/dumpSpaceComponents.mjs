// 検証プローブ（展開図一般化Phase 2。設計 `.claude/elevation-redesign.md` §5.5 Phase 2行）。
// .stqを読み、buildSpaceIndex(layers).componentOf を全階・全Roomへ適用して、
// 「成分id → 部屋名の集合」と「階またぎで連結した成分」をJSONと日本語1行要約で出す。
// 本番からは呼ばれない——connectivityの実データ妥当性を先に確認するための調査専用スクリプト。
//
// 使い方（appディレクトリで実行。@coreエイリアス解決フックの登録が要る）:
//   node --import ./scripts/testSetup.mjs scripts/probe/dumpSpaceComponents.mjs [<出力先.json>] [<入力.stq>]
import fs from 'node:fs';
import path from 'node:path';
import { loadDocument } from './loadDoc.mjs';
import { buildSpaceIndex } from '../../src/elevation/space/spaceModel.js';
import { withGraphReadScope } from '../../src/graphReadScope.js';

// 複数graph（全階分のlayers）をネストしたwithGraphReadScopeで包む（dumpElevFigure.mjsと同じ作法。
// QA指摘）——graphReadScope.js冒頭の説明どおり、観測者のいない一括処理はMobX computedが
// 読み出しのたびに再計算されるため、実データ規模（十数室×複数階）では素の呼び出しより遅くなる。
function withAllGraphReadScopes(graphs, fn) {
  if (graphs.length === 0) return fn();
  const [first, ...rest] = graphs;
  return withGraphReadScope(first, () => withAllGraphReadScopes(rest, fn));
}

// 既定の出力先は scripts/probe/out/ 配下（.gitignore の `scripts/probe/*/` に含まれ、
// golden/golden13 と違って追跡対象にならない）。scripts/probe/ 直下のファイルは
// ディレクトリ単位の除外パターンに掛からずコミット対象になってしまうため（QA指摘）。
const outFile = process.argv[2] ?? path.join(import.meta.dirname, 'out', 'space-components.json');
const src = process.argv[3] ?? 'D:/tatsuya/Download/13.stq';

const { project } = loadDocument(src);
const layers = project.orderedTabs
  .map(p => ({ graph: project.graphMap.get(p.id), floorZMm: p.elevation, role: 'self', planeName: p.name }))
  .filter(l => l.graph);

// 成分id → [{plane, roomName, roomId}]
const membersById = new Map();
const t0 = Date.now();
withAllGraphReadScopes(layers.map(l => l.graph), () => {
  const index = buildSpaceIndex(layers);
  for (const layer of layers) {
    for (const room of layer.graph.rooms) {
      const id = index.componentOf(layer, room);
      if (id == null) continue; // 名前なし等（componentOfの制約。spaceModel.js参照）
      if (!membersById.has(id)) membersById.set(id, []);
      membersById.get(id).push({ plane: layer.planeName, roomName: room.name || '(無名)', roomId: room.id, feature: room.feature ?? null });
    }
  }
});
const elapsedMs = Date.now() - t0;

// 階またぎで連結した成分（同一成分内に異なるplaneが混在するもの）
const crossFloor = [];
for (const [id, members] of membersById) {
  const planes = new Set(members.map(m => m.plane));
  if (planes.size > 1) crossFloor.push({ componentId: id, planes: [...planes], members });
}

const result = {
  src, elapsedMs,
  componentCount: membersById.size,
  components: [...membersById.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([id, members]) => ({ componentId: id, members })),
  crossFloor,
};

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(result, null, 2));

console.log(`[dumpSpaceComponents] ${src}`);
console.log(`  所要時間: ${elapsedMs}ms / 成分数: ${membersById.size}`);
for (const c of result.components) {
  const names = c.members.map(m => `${m.plane}:${m.roomName}`).join(', ');
  console.log(`  成分${c.componentId}: ${names}`);
}
if (crossFloor.length === 0) {
  console.log('  階またぎで連結した成分: なし');
} else {
  console.log(`  階またぎで連結した成分: ${crossFloor.length}件`);
  for (const cf of crossFloor) {
    const names = cf.members.map(m => `${m.plane}:${m.roomName}`).join(', ');
    console.log(`    成分${cf.componentId}（${cf.planes.join('/')}）: ${names}`);
  }
}
console.log(`  出力: ${outFile}`);
