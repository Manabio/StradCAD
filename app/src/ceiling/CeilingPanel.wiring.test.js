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
  assert.equal(count(/^\s*markDirty\(\);\s*$/gm), 3, '区画の確定・解除と部屋の確定でそれぞれ markDirty（行の材の書込みは onChange 内の1行で markDirty）');
  assert.equal(count(/room\.setCeilingZones\(/g), 2, '区画の書込みは確定と解除の2か所だけで、どちらも withFinishUndo の中');
  assert.equal(count(/withFinishUndo\(/g), 4, '書込みは 区画の確定・解除・部屋の確定・行の材 の4か所の withFinishUndo だけ');
});

test('【配線】S10: 材の書込み（setOverride／clearOverride）は行の onChange の1か所だけで、withFinishUndo の中。部屋を直引きしない', () => {
  assert.equal(count(/room\.setOverride\(/g), 1);
  assert.equal(count(/room\.clearOverride\(/g), 1);
  assert.match(src, /withFinishUndo\(graph, \(\) => \(v === '' \? room\.clearOverride\(field\.key\) : room\.setOverride\(field\.key, v\)\)\)/);
  assert.equal(count(/graph\.roomMap\.get\(row\.id\)/g), 0, '行から部屋を直引きしない（書込み先は target、内訳は rowZoneDetail）');
  assert.match(src, /^\s*<RowMaterialSelect graph=\{graph\} mode=\{mode\} room=\{target\} field=\{f\} \/>\s*$/m, '書込み先は target（ceilingWriteTargetRoom）');
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
  assert.match(src, /^\s*return zone && room \? <CeilingZoneFields key=\{zone\.id\} graph=\{graph\} room=\{room\} zone=\{zone\} spanMm=\{spanMm\} \/> : null;\s*$/m);
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
  assert.match(src, /^\s*if \(!roomHasCeiling\(room\)\) return <div style=\{fieldsBoxStyle\}>天井なし<\/div>;\s*$/m);
  assert.match(src, /階段の残りは天井を持ちません。セルを再タップ／ドラッグで区画を作れます/);
});

test('【配線】S11: 群の欄は選択した部屋の展開行の中だけ（上段なし）。選択ブロック（summary が真のとき）の後に内訳が続く', () => {
  assert.equal(count(/<GroupFields /g), 1, '欄の描画は1か所だけ');
  assert.match(src, /^\s*\{summary && \(\s*$/m);
  assert.match(src, /^\s*<GroupFields graph=\{graph\} info=\{groupInfo\} \/>\s*$/m);
  assert.match(src, /^\s*const groupInfo = summary \? selectionGroupInfo\(graph, mode\.selection\) : null;\s*$/m);
  assert.ok(src.indexOf('<GroupFields ') > src.indexOf('const CeilingRow'), '欄は CeilingRow の中（上段ではない）');
  assert.ok(src.indexOf('<GroupFields ') < src.indexOf('<ZoneDetail graph'), '選択ブロックが内訳より上');
  assert.ok(!/\{mode\.selection && \(/.test(src), '上段の選択ガードが残っている');
  assert.ok(!/選択中: \{summary\.name\}/.test(src), '上段の要約が残っている');
  assert.match(src, /<CeilingRow key=\{row\.id\} graph=\{graph\} mode=\{mode\} row=\{row\} \/>/);
  assert.match(src, /^export const CeilingPanel = observer\(\(\{ graph, mode, isLandscape \}\) => \{\s*$/m, '階高は受けない（階段の傾斜の初期値は CeilingModeState.commitDrag）');
});
