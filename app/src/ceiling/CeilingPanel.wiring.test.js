// CeilingPanel.jsx の配線（ソーステキスト走査。.jsx は react を静的に引くため node:test から直接 import できない）。
// 区画の欄は区画単位（S12b）: 確定が updateZoneSpec・解除が removeZone で、どちらも withFinishUndo で包まれ markDirty される／
// 検証は parseCeilingZoneDraft／部屋の残りの欄 RoomCeilingFields／円弧・ドームも選べる／keydown は伝播させない。1行まるごと一致（m フラグ）で判定する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { stripCommentLines } from '../uiBusySourceScan.js';

const src = stripCommentLines(fs.readFileSync(path.resolve(import.meta.dirname, 'CeilingPanel.jsx'), 'utf8'));
const count = (re) => (src.match(re) ?? []).length;

test('【配線】区画の確定は withFinishUndo で room.setCeilingZones(updateZoneSpec(...)) を包み、markDirty する', () => {
  assert.match(src, /^\s*withFinishUndo\(graph, \(\) => room\.setCeilingZones\(updateZoneSpec\(graph, room, zone\.id, result\.value\)\)\);\s*$/m);
  assert.equal(count(/updateZoneSpec\(/g), 1, '区画を書くのは確定の1か所だけ');
  assert.equal(count(/assignZoneShape\(|assignZoneHeight\(|clearZoneCells\(|createZone\(/g), 0, '旧 API・作成はパネルから呼ばない（作成はキャンバスの再タップ。CeilingModeState）');
});

test('【配線】区画の解除は withFinishUndo で room.setCeilingZones(removeZone(...)) を包み、markDirty する。区画の書込みは withFinishUndo の中だけ', () => {
  assert.match(src, /^\s*withFinishUndo\(graph, \(\) => room\.setCeilingZones\(removeZone\(graph, room, zone\.id\)\)\);\s*$/m);
  assert.equal(count(/^\s*markDirty\(\);\s*$/gm), 4, '区画の確定・解除と部屋の確定と屋外の天井チェックでそれぞれ markDirty（行の材の書込み・階段裏の仕上げは onChange 内の1行で markDirty）');
  assert.equal(count(/room\.setCeilingZones\(/g), 2, '区画の書込みは確定と解除の2か所だけで、どちらも withFinishUndo の中');
  assert.equal(count(/withFinishUndo\(/g), 5, '書込みは 区画の確定・解除・部屋の確定・行の材・屋外の天井チェック の5か所の withFinishUndo だけ');
});

test('【配線】S10: 材の書込み（setOverride／clearOverride）は行の onChange の1か所だけで、withFinishUndo の中。部屋を直引きしない', () => {
  assert.equal(count(/room\.setOverride\(/g), 1);
  assert.equal(count(/room\.clearOverride\(/g), 1);
  assert.match(src, /withFinishUndo\(graph, \(\) => \(v === '' \? room\.clearOverride\(field\.key\) : room\.setOverride\(field\.key, v\)\)\)/);
  assert.equal(count(/graph\.roomMap\.get\(/g), 0, 'パネルは部屋を直引きしない（書込み先は木のノードの room）');
  assert.match(src, /^\s*<RowMaterialSelect graph=\{graph\} mode=\{mode\} room=\{node\.room\} field=\{f\} \/>\s*$/m, '書込み先はノードの room');
});

test('【配線】入力の検証は parseCeilingZoneDraft（失敗は欄の下の1行へ）。区画は requireFlatHeight。Enter で確定、keydown は伝播させない', () => {
  assert.match(src, /^\s*const result = parseCeilingZoneDraft\(draft, \{ spanMm, requireFlatHeight: true \}\);\s*$/m, '区画: 平面で天井高が空欄は弾く');
  assert.match(src, /^\s*if \(!result\.ok\) \{ setError\(result\.error\); return; \}\s*$/m);
  assert.match(src, /^\s*\{error && <div style=\{\{ color: '#dc2626' \}\}>\{error\}<\/div>\}\s*$/m);
  assert.match(src, /^\s*const stop = e => \{ e\.stopPropagation\(\); if \(e\.key === 'Enter' && !disabled\) onEnter\(\); \};\s*$/m);
  assert.equal(count(/onKeyDown=\{stop\}/g), 2, '基準高と寸法の数値欄（区画と部屋で共用の ShapeFieldRows 1か所）');
});

test('【配線】形状 select は CEILING_SHAPE_OPTIONS から作り、どの option も disabled にしない（円弧・ドームも選べる）', () => {
  assert.match(src, /^\s*\{CEILING_SHAPE_OPTIONS\.map\(o => \(\s*$/m);
  assert.match(src, /^\s*<option key=\{o\.value\} value=\{o\.value\}>\{o\.label\}<\/option>\s*$/m);
  assert.ok(!/o\.disabled/.test(src), '形状の option に disabled が残っている');
  assert.match(src, /^\s*onChange=\{e => patch\(\{ shape: e\.target\.value, dims: defaultDims\(e\.target\.value\) \}\)\}\s*$/m, '形状を変えたら寸法の下書きを作り直す');
  assert.match(src, /^\s*<span style=\{\{ fontWeight: 700 \}\}>\{CEILING_BASE_LABEL\[draft\.shape\]\}：<\/span>\s*$/m, '基準高のラベルは形状ごと');
});

test('【配線】円弧・ドームの確定ガード（未対応エラー）は無く、エラー時は数値欄が赤枠になる', () => {
  assert.ok(!/この形状は未対応です/.test(src), '未対応の確定ガードが残っている');
  assert.equal(count(/borderColor: error \? '#dc2626' : undefined/g), 2, '基準高と寸法の数値欄');
});

test('【配線】S12b: 区画の欄は区画単位（key={zone.id}・props は graph/room/zone/spanMm）。選択（selection）を渡さない', () => {
  assert.equal(count(/<CeilingZoneFields /g), 1, '欄の描画は1か所だけ');
  assert.match(src, /^const CeilingZoneFields = observer\(\(\{ graph, room, zone, spanMm \}\) => \{\s*$/m);
  assert.match(src, /^\s*const \[draft, setDraft\] = useState\(\(\) => zoneDraft\(zone\)\);\s*$/m, '下書きは useState（MobX に入れない）。初期値は区画の値');
  assert.ok(!/selection=\{/.test(src), '欄へ選択を渡している');
  assert.ok(!/ceilingZoneTargetRoom|stairCeilingSlopeDefaults/.test(src), '旧の選択単位の書込み先・階段の初期値がパネルに残っている（作成は CeilingModeState）');
});

test('【配線】S12b: 部屋の残りの欄 RoomCeilingFields は 天井高→形状の順に withFinishUndo の中で書き、受理されたときだけ形状を書く', () => {
  assert.equal(count(/<RoomCeilingFields /g), 1);
  assert.match(src, /^\s*accepted = applyRoomCeilingHeightDraft\(room, draft\.height, original\);\s*$/m);
  assert.match(src, /^\s*if \(accepted\) setRoomCeilingShape\(room, result\.value\);\s*$/m);
  assert.match(src, /^\s*const result = parseCeilingZoneDraft\(\{ \.\.\.draft, height: '' \}, \{ spanMm \}\);/m, '形状・寸法だけ検証し、天井高は CH の規則で判定');
  assert.ok(src.indexOf('applyRoomCeilingHeightDraft(room') > src.indexOf('withFinishUndo(graph, () => {'), '書込みは withFinishUndo の中');
  assert.match(src, /^\s*if \(!roomHasCeiling\(room\)\) return <div style=\{fieldsBoxStyle\}>天井なし<\/div>;\s*$/m, '欄は roomHasCeiling 条件（偽なら天井なし。木の側でも roomFields は天井を持つ部屋だけ）');
});

test('【配線】S12c: 欄は木の行の種類で描く。部屋の欄 RoomCeilingFields は roomFields の行だけ（key は部屋の値で作り直す）、区画の欄は zoneFields の行だけ（key={node.zone.id}）。上段・選択ブロックは無い', () => {
  assert.equal(count(/<RoomCeilingFields /g), 1);
  assert.equal(count(/<CeilingZoneFields /g), 1);
  assert.match(src, /^\s*if \(line\.type === 'roomFields'\) \{\s*$/m);
  assert.match(src, /^\s*if \(line\.type === 'zoneFields'\) \{\s*$/m);
  assert.match(src, /^\s*<CeilingZoneFields key=\{node\.zone\.id\} graph=\{graph\} room=\{node\.room\} zone=\{node\.zone\} spanMm=\{selectionSpanMm\(graph, \{ cellKeys: node\.cells \}\)\} \/>\s*$/m);
  assert.match(src, /^\s*<RoomCeilingFields key=\{key\} graph=\{graph\} room=\{node\.room\} spanMm=\{selectionSpanMm\(graph, \{ cellKeys: node\.cells \}\)\} \/>\s*$/m);
  assert.match(src, /^\s*if \(line\.type === 'note'\) return /m, '天井なし・区画なしは注記の1行');
  assert.ok(!/GroupFields|ZoneDetail|summary\.cellCount|選択中: /.test(src), '旧の選択ブロック・内訳が残っている');
  assert.ok(!/\{mode\.selection && \(/.test(src), '上段の選択ガードが残っている');
  assert.match(src, /^export const CeilingPanel = observer\(\(\{ graph, mode, project, isLandscape \}\) => \{\s*$/m, '階高は受けない（階段の傾斜の初期値は CeilingModeState.commitDrag）');
});

test('【配線】S12c: 区画の行は天井材・仕上げの2列を colSpan=2 の1セルにまとめる。部屋・階段の行だけが材の select を持つ', () => {
  assert.match(src, /^\s*\{node\.type === 'zone' \? \(\s*$/m);
  assert.match(src, /^\s*<td colSpan=\{2\} style=\{\{ \.\.\.cellStyle, overflow: 'hidden', textOverflow: 'ellipsis' \}\}>\{node\.summary\}<\/td>\s*$/m);
  assert.equal(count(/<RowMaterialSelect /g), 1);
});

test('【配線】外部タブ（軒裏）: TABS に exterior、行は ceilingExteriorRows、表示のみの行は select を持たない。編集は editable 行だけで mode.setMainRoofField(graph, …)', () => {
  assert.match(src, /^\s*\{ id: 'exterior', label: '外部' \},\s*$/m);
  assert.equal(count(/ceilingExteriorRows\(/g), 1);
  assert.match(src, /^\s*if \(!row\.editable\) \{\s*$/m, '表示のみの行を先に返す');
  const readonlyStart = src.indexOf('if (!row.editable) {');
  const editableStart = src.indexOf('const selectStyle', readonlyStart);
  assert.ok(readonlyStart >= 0 && editableStart > readonlyStart);
  const readonlyBlock = src.slice(readonlyStart, editableStart);
  assert.ok(!/<select|MaterialSelect|RoofTextInput|mode\.setMainRoofField|\bset\(/.test(readonlyBlock), '表示のみの行は入力部品も書込みも持たない');
  assert.match(src, /^\s*const set = \(field, value\) => mode\.setMainRoofField\(graph, field, value\);\s*$/m);
  assert.equal(count(/set\('soffit(Material|Backing|Orientation|Note)'/g), 4, '編集は軒裏の4項目だけ');
  assert.equal(count(/mode\.setMainRoofField\(/g), 1, '書込みの入口は1か所');
  assert.match(src, /^\s*\{row\.backingShown && \(\s*$/m, '編集行の下地は木造のときだけ');
  assert.match(src, /軒裏はありません。/);
  assert.match(src, /^\s*export const CeilingPanel = observer\(\(\{ graph, mode, project, isLandscape \}\) => \{\s*$/m);
});

test('【配線】屋外 S2: 外部タブは木（PanelLine の表）と軒裏の ExteriorTable の両方。天井チェックは屋外部屋の room ノードだけで withFinishUndo＋markDirty、行へ伝播させない', () => {
  assert.match(src, /^\s*\{isExterior && \(\s*$/m, '軒裏の表は木の下段');
  assert.equal(count(/<ExteriorTable /g), 1);
  assert.equal(count(/<PanelLine /g), 1, '木の行は内部・階段・外部タブ共通の1か所');
  assert.match(src, /屋外部屋はありません。/);
  assert.match(src, /^\s*\{node\.type === 'room' && isExteriorCeilingRoom\(node\.room\) && \(\s*$/m, 'チェックは屋外部屋の room ノードだけ');
  assert.match(src, /^\s*checked=\{exteriorCeilingEnabled\(node\.room\)\}\s*$/m);
  assert.match(src, /^\s*withFinishUndo\(graph, \(\) => setExteriorCeilingEnabled\(node\.room, on\)\);\s*$/m);
  assert.equal(count(/setExteriorCeilingEnabled\(/g), 1, '書込みの入口は1か所');
  assert.match(src, /^\s*if \(!on\) mode\.clearSelectionOfRoom\(node\.room\.id\);/m, '天井を外したら選択中の群の強調も消す');
  const at = src.indexOf('type="checkbox"');
  assert.ok(at >= 0 && /onClick=\{e => e\.stopPropagation\(\)\}/.test(src.slice(at, at + 300)), 'チェックのクリックは行へ伝播させない');
  assert.equal(count(/type="checkbox"/g), 1, 'チェックは天井の1種類だけ（内部・階段の行には出ない）');
});

test('【配線】S8-4-4: 階段裏の仕上げは stairFields の行だけで、書込みは writeStairSoffitFinish（withFinishUndo）＋markDirty の1か所。階段を直接書かない', () => {
  assert.match(src, /^\s*if \(line\.type === 'stairFields'\) \{\s*$/m);
  assert.equal(count(/<StairSoffitFields /g), 1);
  assert.match(src, /^\s*onChange=\{e => \{ writeStairSoffitFinish\(graph, stair, e\.target\.value\); markDirty\(\); \}\}\s*$/m);
  assert.equal(count(/writeStairSoffitFinish\(/g), 1, '書込みの入口は1か所');
  assert.equal(count(/setSoffitFinish\(|setField\(/g), 0, 'パネルは階段へ直接書かない（writeStairSoffitFinish 経由）');
  assert.match(src, /^\s*const current = stairSoffitChoice\(stair\);\s*$/m, '未設定（null）の表示は stairSoffitChoice（鉄骨はあらわし）');
});

test('【配線】外部タブの主屋根行の材 select は共通部品 RoofMaterialSelect（「（未選択）」なし）。ExteriorRow の中に MaterialSelect は無い。下屋の階は mode.aboveRoofGraphOf で引く', () => {
  const start = src.indexOf('const ExteriorRow = observer(');
  const end = src.indexOf('const ExteriorTable = observer(');
  assert.ok(start >= 0 && end > start);
  const block = src.slice(start, end);
  assert.ok(!/\bMaterialSelect\b/.test(block.replace(/RoofMaterialSelect/g, '')), 'ExteriorRow に MaterialSelect が残っている');
  assert.equal((block.match(/<RoofMaterialSelect /g) ?? []).length, 2, '仕上げ（panel）と下地（backing）の2か所');
  assert.match(src, /^import \{ RoofTextInput, RoofMaterialSelect \} from '\.\.\/finish\/roof\/RoofGroup\.jsx';\s*$/m);
  assert.equal(count(/aboveGraph: mode\.aboveRoofGraphOf\(graph\)/g), 1);
  assert.equal(count(/aboveRoofContext/g), 0, 'パネルは ctx を直接読まない');
});
