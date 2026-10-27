// 課題(k)（cl-conversion-limits.md 限界16 (k)）S0: 再現用 .stq の作成。
// 目的: 開口（吹抜け）の辺と同じ座標に、範囲の離れた／端で接する／一部だけ重なる梁芯があるとき、開口梁芯が作られるかを
//   RC・SRC・未定（・S造の対照）で見る。製品コードは変えない（kOpeningBeamProbe.mjs が構造再計算を通して測る）。
// 構成（全階共通。単位 mm、y 下向き正）: 通り芯 X=0・3500・5000・6500・8000、Y=0・8000（構造グラフの labeled 通り芯）。
//   最下階 GF（吹抜け無し・基礎伏図になる）の上に、型ごとの階を積む。
//   各階に ARCH 補助線 V2000・V5000・H2000・H5000（全長）で囲んだ中央のセル (2000..5000)^2 を吹抜け（VOID）の部屋にする。
//   吹抜けの上辺（H・y=2000・x 2000..5000）と同じ座標に、FUSE の梁芯（H・y=2000）を型ごとに足す:
//     ctl  梁芯なし（対照）
//     A    離れている  extent [6500, 8000]（辺の端 5000 から 1500 離れる。両端は通り芯 X=6500・8000 への参照）
//     B    端で接する  extent [5000, 8000]（辺の端 5000 にちょうど接する）
//     C    一部重なる  extent [3500, 8000]（辺 2000..5000 の後半 3500..5000 だけを覆う）
//     D    覆う        extent [0, 8000]（辺の全体を覆う。対照）
//   由来は wall（壁由来。壁の無い孤立した壁由来梁芯は構造再計算で撤去されない）／user（ユーザー手動）の2通り。階名＝型-由来。
//   階は 3000 ずつ積み、階ごとに独立（型どうしは干渉しない）。構造再計算は通さず、構成だけを保存する（梁・柱・開口梁芯は
//   kOpeningBeamProbe.mjs が本番の再計算で作る）。
// 引数: <rc|src|undecided|steel> <出力.stq>   出力が既存なら上書きせず終了する。
// 使い方（ローダー必須。app/ で実行）:
//   node --import ./scripts/testSetup.mjs scripts/probe/makeKOpeningRepro.mjs rc D:/tatsuya/Download/k-rc.stq
import fs from 'node:fs';
import { serializeGraph, serializeStructCLs, serializePlanes, restoreGraph, restoreStructCLs, decodePlanes } from '../../src/graphSnapshot.js';
import { buildDocumentJson, parseDocumentEnvelope } from '../../src/storage/documentFile.js';
import { Project, CenterLineType, Discipline, RoomFeature } from '../../src/core.js';
import { UNSPECIFIED_STRUCTURE } from '../../src/structural/structureRules.js';

const [kind, outPath] = process.argv.slice(2);
const STRUCTURES = { rc: 'RC造(ラーメン)', src: 'SRC造', undecided: UNSPECIFIED_STRUCTURE, steel: 'S造' };
if (!STRUCTURES[kind] || !outPath) { console.error(`usage: makeKOpeningRepro.mjs <${Object.keys(STRUCTURES).join('|')}> <out.stq>`); process.exit(1); }
if (fs.existsSync(outPath)) { console.error(`既存ファイルを上書きしません: ${outPath}`); process.exit(1); }

// ext＝梁芯の範囲の両端（通り芯の座標。梁芯は両端を通り芯への参照 extentLoRef/HiRef で持つ＝本番の壁由来梁芯と同じ形）。
const TYPES = [
  { type: 'ctl', ext: null, origins: [null] },
  { type: 'A', ext: [6500, 8000], origins: ['wall', 'user'] },
  { type: 'B', ext: [5000, 8000], origins: ['wall', 'user'] },
  { type: 'C', ext: [3500, 8000], origins: ['wall', 'user'] },
  { type: 'D', ext: [0, 8000], origins: ['wall', 'user'] },
];
// 最下階（基礎伏図になる）は対照の取り違えを避けるため吹抜けの無い基準階にする。
const floors = [{ type: 'GF', ext: null, origin: null, name: 'GF', noVoid: true },
  ...TYPES.flatMap(t => t.origins.map(origin => ({ ...t, origin, name: origin ? `${t.type}-${origin}` : t.type })))];

const project = new Project('k-repro', 'k-repro');
project.structuralInfo.setField('mainStructure', STRUCTURES[kind]);
const sg = project.structGraph;
const addAxis = (type, value) => sg.addCenterLine(type, value, { labeled: true, discipline: Discipline.STRUCT });
const GX = [0, 3500, 5000, 6500, 8000].map(v => addAxis(CenterLineType.VERTICAL, v));
const GXat = (v) => GX.find(c => c.value === v);
const GX0 = GX[0], GX1 = GX[GX.length - 1];
const GY0 = addAxis(CenterLineType.HORIZONTAL, 0), GY1 = addAxis(CenterLineType.HORIZONTAL, 8000);

floors.forEach((f, i) => {
  const { graph: g } = project.addPlane(3000 * i, f.name, `p${i + 1}`, i + 1, 1);
  const arch = (type, v) => g.addCenterLine(type, v, { labeled: false, discipline: Discipline.ARCH });
  const vx0 = arch(CenterLineType.VERTICAL, 2000), vx1 = arch(CenterLineType.VERTICAL, 5000);
  const hy0 = arch(CenterLineType.HORIZONTAL, 2000), hy1 = arch(CenterLineType.HORIZONTAL, 5000);
  if (f.ext) {
    g.addCenterLine(CenterLineType.HORIZONTAL, 2000, {
      labeled: false, discipline: Discipline.FUSE, beamAxisOrigin: f.origin,
      extentLoRef: { clId: GXat(f.ext[0]).id, offset: 0 }, extentHiRef: { clId: GXat(f.ext[1]).id, offset: 0 },
    });
  }
  const xs = [GX0, vx0, vx1, GX1], ys = [GY0, hy0, hy1, GY1];
  const cells = [];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) cells.push([r, c, `${xs[c].id}:${ys[r].id}:${xs[c + 1].id}:${ys[r + 1].id}`]);
  if (!f.noVoid) {
    const room = g.addRoom(new Set([cells[4][2]]), '吹抜け');
    room.setFeature(RoomFeature.VOID);
  }
  // 吹抜けを囲む居室（8セルの1部屋。GF は9セル）。建物の外形（構造の柱・梁を生成する範囲）を決める。壁は作らない（梁芯の種類を壁源に混ぜない）。
  g.addRoom(new Set(cells.filter(([r, c]) => f.noVoid || !(r === 1 && c === 1)).map(x => x[2])), '居室');
});

// 往復検証して保存
const digest = (proj) => JSON.stringify([proj.structuralInfo.mainStructure, proj.planes.map(pl => {
  const g = proj.graphMap.get(pl.id);
  return [pl.name, g.rooms.map(r => `${r.name}:${r.feature ?? ''}:${[...r.cells].length}`),
    g.centerLines.map(c => `${c.centerLineType}:${Math.round(c.effectiveValue)}:${c.discipline}:${c.beamAxisOrigin ?? ''}:${c.extentLo ?? ''}:${c.extentHi ?? ''}`).sort()];
})]);
const fl = project.planes.map(p => ({ planeId: p.id, bytes: serializeGraph(project.graphMap.get(p.id)) }));
const struct = serializeStructCLs(project.structGraph, project.structuralInfo, project.memberGroupLedger);
const json = buildDocumentJson({ floors: fl, struct, planes: serializePlanes(project), site: null, info: null, bootPlaneId: project.planes[0].id });
const doc = parseDocumentEnvelope(JSON.parse(json));
const p2 = new Project('probe', 'probe');
restoreStructCLs(p2.structGraph, p2.structuralInfo, doc.struct, p2.memberGroupLedger);
const { planes: decoded, glBelow1FlMm } = decodePlanes(doc.planes);
for (const p of decoded) {
  p2.addPlane(p.elevation, p.name, p.id, p.startFloor, p.stories, p.isAlternative, p.referenceId, p.altIndex, p.isRoofPlane, p.roofForPlaneId, p.planCutHeightMm, p.ceilingCutHeightMm, p.topStoryHeightMm);
}
p2.setGlBelow1FlMm(glBelow1FlMm ?? 0);
for (const f of doc.floors) restoreGraph(p2.graphMap.get(f.planeId), f.bytes);
if (digest(project) !== digest(p2)) { console.error('NG: 往復不一致'); process.exit(1); }
if (p2.structuralInfo.mainStructure !== STRUCTURES[kind]) { console.error('NG: 主構造が往復で変わった'); process.exit(1); }
fs.writeFileSync(outPath, json);
console.log(`OK: 往復一致・保存 ${outPath} (${json.length} bytes) mainStructure=${p2.structuralInfo.mainStructure} 階=${floors.map(f => f.name).join(',')}`);
