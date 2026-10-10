// CeilingPanel.jsx の配線（ソーステキスト走査。.jsx は react を静的に引くため node:test から直接 import できない）。
// 区画の形状・寸法の欄（S5 の高さ欄を S6a で拡張）: 確定・解除が withFinishUndo で包まれ markDirty される／検証は parseCeilingZoneDraft／
// 部屋の無い階段は disabled（階段は対の部屋へ書く。S6b）／円弧・ドームも選べる／keydown は伝播させない。1行まるごと一致（m フラグ）で判定する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { stripCommentLines } from '../uiBusySourceScan.js';

const src = stripCommentLines(fs.readFileSync(path.resolve(import.meta.dirname, 'CeilingPanel.jsx'), 'utf8'));
const count = (re) => (src.match(re) ?? []).length;

test('【配線】区画の確定は withFinishUndo で room.setCeilingZones(assignZoneShape(...)) を包み、markDirty する', () => {
  assert.match(src, /^\s*withFinishUndo\(graph, \(\) => room\.setCeilingZones\(assignZoneShape\(graph, room, selection\.cellKeys, result\.value\)\)\);\s*$/m);
  assert.equal(count(/assignZoneShape\(/g), 1, '区画を書くのは確定の1か所だけ');
  assert.equal(count(/assignZoneHeight\(/g), 0, '旧 API は使わない');
});

test('【配線】区画の解除は withFinishUndo で room.setCeilingZones(clearZoneCells(...)) を包み、markDirty する', () => {
  assert.match(src, /^\s*withFinishUndo\(graph, \(\) => room\.setCeilingZones\(clearZoneCells\(graph, room, selection\.cellKeys\)\)\);\s*$/m);
  assert.equal(count(/^\s*markDirty\(\);\s*$/gm), 2, '確定と解除でそれぞれ markDirty');
  assert.equal(count(/room\.setCeilingZones\(/g), 2, '区画の書込みは確定と解除の2か所だけで、どちらも withFinishUndo の中');
});

test('【配線】入力の検証は parseCeilingZoneDraft（失敗は欄の下の1行へ）。Enter で確定、keydown は伝播させない', () => {
  assert.match(src, /^\s*const result = parseCeilingZoneDraft\(draft, \{ spanMm: selectionSpanMm\(graph, selection\) \}\);\s*$/m);
  assert.match(src, /^\s*if \(!result\.ok\) \{ setError\(result\.error\); return; \}\s*$/m);
  assert.match(src, /^\s*\{error && <div style=\{\{ color: '#dc2626' \}\}>\{error\}<\/div>\}\s*$/m);
  assert.match(src, /^\s*const stop = e => \{ e\.stopPropagation\(\); if \(e\.key === 'Enter' && !disabled\) commit\(\); \};\s*$/m);
  assert.equal(count(/onKeyDown=\{stop\}/g), 2, '基準高と寸法の数値欄');
});

test('【配線】形状 select は CEILING_SHAPE_OPTIONS から作り、どの option も disabled にしない（円弧・ドームも S6b で選べる）', () => {
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

test('【配線】書込み先は ceilingZoneTargetRoom（部屋、階段は対の部屋）。無ければ（部屋の無い階段）入力・確定が disabled', () => {
  assert.match(src, /^\s*const room = ceilingZoneTargetRoom\(graph, selection\);\s*$/m);
  assert.match(src, /^\s*const disabled = !room;\s*$/m);
  assert.match(src, /^\s*disabled=\{disabled\}\s*$/m);
  assert.match(src, /^\s*<button onClick=\{commit\} disabled=\{disabled\} title=\{title\} style=\{\{ fontSize: 12 \}\}>確定<\/button>\s*$/m);
  assert.match(src, /^\s*disabled=\{disabled \|\| !f\}\s*$/m, '使わない寸法欄は disabled');
});

test('【配線】区画の欄は選択があるときだけ出す', () => {
  assert.match(src, /^\s*\{mode\.selection && \(\s*$/m);
  assert.match(src, /^\s*<CeilingZoneFields key=\{zoneFieldKey\(mode\.selection\)\} graph=\{graph\} selection=\{mode\.selection\} zone=\{summary\?\.zone \?\? null\} floorHeight=\{floorHeight \?\? null\} \/>\s*$/m, '階高を区画の欄へ渡す');
  assert.match(src, /^const zoneFieldKey = selection => `\$\{selection\.owner\.kind\}:\$\{selection\.owner\.id\}:\$\{\[\.\.\.selection\.cellKeys\]\.sort\(\)\.join\(','\)\}`;\s*$/m, '選択が変わったら欄を作り直す（入力途中の下書きを持ち越さない）');
  assert.match(src, /^\s*const \[draft, setDraft\] = useState\(\(\) => \{\s*$/m, '下書きは useState（MobX に入れない）');
});

test('【配線】階段所属の初期値: 階段のときだけ stairCeilingSlopeDefaults(graph, stair, selection.cellKeys, floorHeight) を initialDraft へ渡す。CeilingPanel は floorHeight を prop で受ける', () => {
  assert.match(src, /^\s*const stair = selection\.owner\.kind === 'stair' \? graph\.stairMap\.get\(selection\.owner\.id\) : null;\s*$/m);
  assert.match(src, /^\s*return initialDraft\(zone, stair \? stairCeilingSlopeDefaults\(graph, stair, selection\.cellKeys, floorHeight\) : null\);\s*$/m);
  assert.equal(count(/stairCeilingSlopeDefaults\(/g), 1, '呼び出しは初期値の1か所だけ');
  assert.match(src, /^const CeilingZoneFields = observer\(\(\{ graph, selection, zone, floorHeight \}\) => \{\s*$/m);
  assert.match(src, /^export const CeilingPanel = observer\(\(\{ graph, mode, isLandscape, floorHeight \}\) => \{\s*$/m);
});
