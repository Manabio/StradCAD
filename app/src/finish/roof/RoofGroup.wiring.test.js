// RoofGroup.jsx（外部タブの屋根の群）と FinishTable.jsx 側の配線不変条件。.jsx は node:test から単体 import
// できないため、ソーステキスト検査で固定する（FinishTable.wiring.test.js と同じ型。コメント行・ブロック
// コメントを除去した本体に対し、1行まるごと一致・関数本体の切り出しで検査する）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function codeOf(file) {
  const text = fs.readFileSync(path.resolve(import.meta.dirname, file), 'utf8');
  return text.replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/)
    .filter(line => !line.trim().startsWith('//'))
    .join('\n');
}

const roofCode = codeOf('RoofGroup.jsx');
const tableCode = codeOf('../FinishTable.jsx');
// 1行まるごと一致の検査用: 行末コメント（空白＋//以降）も除く（変異「onCommit(n ?? 0); // if (n !== null) onCommit(n);」を通さない）
const roofLines = roofCode.split('\n').map(l => l.replace(/\s\/\/.*$/, '').trim());

// 関数本体（export const RoofGroup = ... から末尾まで）の切り出し
const groupStart = roofCode.indexOf('export const RoofGroup');
assert.ok(groupStart >= 0, 'export const RoofGroup が見つからない');
const groupBody = roofCode.slice(groupStart);

test('【不変条件】RoofGroup の確定は1か所の set（mode.setRoofField(room.id, field, value)）を通る。jsx は RoofSpec を直接書き換えない', () => {
  assert.ok(roofLines.includes('const set = (field, value) => mode.setRoofField(room.id, field, value);'),
    'const set = (field, value) => mode.setRoofField(room.id, field, value); の1行が見つからない');
  assert.ok(!/\.setField\(/.test(roofCode), 'jsx が RoofSpec.setField を直接呼んでいる（確定は mode.setRoofField 経由）');
  assert.equal((roofCode.match(/mode\.setRoofField\(/g) ?? []).length, 1, 'mode.setRoofField の呼び出しは set の1か所だけ');
});

test('【不変条件】形状 select の表示値は resolveRoofShape（自動のとき導いた形状）で、選択肢は roofShapeOptions()（「自動」は出さない）', () => {
  assert.ok(roofLines.includes('const shape = resolveRoofShape(spec, { boundsList: roofRoomBounds(room, graph) });'),
    'const shape = resolveRoofShape(spec, { boundsList: roofRoomBounds(room, graph) }); が見つからない');
  assert.ok(roofLines.includes('value={shape}'), '形状 select の value={shape} が見つからない');
  assert.ok(roofLines.includes("onChange={e => set('shape', e.target.value)}"), "形状の onChange が set('shape', …) でない");
  assert.ok(/roofShapeOptions\(\)\.map\(/.test(groupBody), 'roofShapeOptions().map( が見つからない');
  assert.ok(!/自動/.test(groupBody), '「自動」という選択肢・文言を出さない（表示は導いた形状）');
});

test('【不変条件】勾配・軒の出・妻側の出は検証の純関数（parseRoofSlopeInput／parseRoofOverhangInput）を通し、onCommit は set(各項目, n)', () => {
  assert.ok(roofLines.includes("<RoofNumberInput value={spec.slope} parse={parseRoofSlopeInput} onCommit={n => set('slope', n)}"),
    '勾配の RoofNumberInput が parseRoofSlopeInput／set(\'slope\', n) で配線されていない');
  assert.ok(roofLines.includes("<RoofNumberInput value={spec.eaveOverhangMm} parse={parseRoofOverhangInput} onCommit={n => set('eaveOverhangMm', n)}"),
    '軒の出の RoofNumberInput の配線が見つからない');
  assert.ok(roofLines.includes("<RoofNumberInput value={spec.gableOverhangMm} parse={parseRoofOverhangInput} onCommit={n => set('gableOverhangMm', n)}"),
    '妻側の出の RoofNumberInput の配線が見つからない');
  // 不正入力は確定せず（parse が null → onCommit を呼ばない）、blur で draft を捨てて元の値へ戻す
  const numStart = roofCode.indexOf('const RoofNumberInput');
  const numBody = roofCode.slice(numStart, roofCode.indexOf('const formLabelStyle'));
  assert.ok(codeOf('RoofGroup.jsx').split('\n').map(l => l.replace(/\s\/\/.*$/, '').trim()).includes('if (n !== null) onCommit(n);'),
    'if (n !== null) onCommit(n); の1行（parse が null のときは onCommit を呼ばない）が見つからない');
  assert.ok(numBody.includes('if (n !== null) onCommit(n);'), 'RoofNumberInput の本体に見つからない');
  assert.ok(/setDraft\(null\);\s*\};/.test(numBody), 'commit の最後で draft を破棄（元の値へ戻す）していない');
});

test('【不変条件】材料 select は roofMaterialOptions（候補表＋未解決コードの先頭補完）で、野地板=ROOF_SHEATHING_CODES・防水シート=ROOF_UNDERLAYMENT_CODES', () => {
  assert.ok(/roofMaterialOptions\(codes, spec\[field\], nameOf\)/.test(groupBody), 'roofMaterialOptions(codes, spec[field], nameOf) が見つからない');
  assert.ok(roofLines.includes("{materialSelect('underlaymentMaterial', ROOF_UNDERLAYMENT_CODES)}"), '防水シートの select が見つからない');
  assert.ok(roofLines.includes("{materialSelect('sheathingMaterial', ROOF_SHEATHING_CODES)}"), '野地板の select が見つからない');
  assert.ok(roofLines.includes('const nameOf = code => mode.getMaterial(code)?.name;'), '材料名の引き当て（mode.getMaterial）が見つからない');
  // 下地セル内の並びは防水シート→野地板
  assert.ok(groupBody.indexOf("materialSelect('underlaymentMaterial'") < groupBody.indexOf("materialSelect('sheathingMaterial'"),
    '下地欄は防水シート→野地板の順');
});

test('【不変条件】表は固定2行（屋根・軒裏）。行の追加・削除・部位の変更の口を持たない', () => {
  const tbodyStart = groupBody.indexOf('<tbody>');
  const tbodyEnd = groupBody.indexOf('</tbody>');
  const tbody = groupBody.slice(tbodyStart, tbodyEnd);
  assert.equal((tbody.match(/<tr[ >]/g) ?? []).length, 2, 'tbody の行は2行');
  assert.ok(/<td style=\{cellBase\}>屋根<\/td>/.test(tbody), '「屋根」行の部位セルが見つからない');
  assert.ok(/<td style=\{cellBase\}>軒裏<\/td>/.test(tbody), '「軒裏」行の部位セルが見つからない');
  assert.ok(roofLines.includes("<RoofTextInput value={spec.roofFinish} onCommit={v => set('roofFinish', v)} style={cellInputStyle} />"), '屋根仕上げの配線');
  assert.ok(roofLines.includes("<RoofTextInput value={spec.soffit} onCommit={v => set('soffit', v)} style={cellInputStyle} />"), '軒裏の配線');
  assert.ok(roofLines.includes("<RoofTextInput value={spec.note} onCommit={v => set('note', v)} style={cellInputStyle} />"), '備考の配線');
  assert.ok(!/addExteriorRow|removeExteriorRow|行を追加|削除/.test(groupBody), '行の追加・削除の口を持たない');
  assert.ok(!/<input[^>]*part/.test(groupBody), '部位を編集する入力欄を持たない');
});

test('【不変条件】入力欄は無効化・読取専用にしない（select・input に disabled／readOnly が無い）', () => {
  assert.ok(!/disabled|readOnly/.test(roofCode), 'disabled／readOnly が見つかった（屋根の項目は常に編集できる）');
  assert.equal((roofCode.match(/<select/g) ?? []).length, 2, 'select は形状と材料（共通の materialSelect）の2か所だけ');
  assert.equal((roofCode.match(/<input/g) ?? []).length, 2, 'input は RoofTextInput・RoofNumberInput の2か所だけ');
});

test('【不変条件】文字欄・数値欄は Enter（IME 変換中は除く）で preventDefault して blur＝確定する。Escape の専用処理は持たない（既存の CardNameInput・ExteriorPartHeading と同じ）', () => {
  const enterLine = "if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); e.currentTarget.blur(); }";
  assert.equal(roofLines.filter(l => l === enterLine).length, 2, '文字欄・数値欄の Enter の行（1行まるごと一致）が2つ必要');
  assert.ok(!/Escape/.test(roofCode), "'Escape' の専用処理を持たない（blur が確定するため取消にならず、全体の Escape にも届く）");
  assert.equal((roofCode.match(/onBlur=\{commit\}/g) ?? []).length, 2, '確定は onBlur={commit} の2か所（文字欄・数値欄）');
});

test('【不変条件】RoofGroup.jsx は store.js・snap.js を静的 import しない。表のスタイルは props（styles）で受ける', () => {
  assert.ok(!/from '[^']*(store|snap)\.js'/.test(roofCode), 'store.js／snap.js を import している');
  assert.ok(roofLines.includes('const { cellBase, headerCell, cellInputStyle } = styles;'), 'styles の受け取りが見つからない');
});

// ---- ステップB2b: 屋根セルのクリック選択 → 外部タブへ切替 → 選択中の群を強調・スクロール ----
const tableLines = tableCode.split('\n').map(l => l.replace(/\s\/\/.*$/, '').trim());
const stateCode = codeOf('../../modes/FinishModeState.js');
const stateLines = stateCode.split('\n').map(l => l.replace(/\s\/\/.*$/, '').trim());

function sliceBlock(code, startNeedle, endNeedle) {
  const s = code.indexOf(startNeedle);
  assert.ok(s >= 0, `${startNeedle} が見つからない`);
  const e = code.indexOf(endNeedle, s);
  assert.ok(e >= 0, `${endNeedle} が見つからない`);
  return code.slice(s, e);
}

test('【不変条件・B2b】startDrag は屋根セルの直接クリックで roofRoomAtCell → selectRoom して return する（ドラッグ開始 dragState の設定より前）', () => {
  const body = sliceBlock(stateCode, '  startDrag(wx, wy) {', '  updateDrag(wx, wy) {');
  const lines = body.split('\n').map(l => l.replace(/\s\/\/.*$/, '').trim());
  assert.ok(lines.includes('const roofHit = this.roofRoomAtCell(pointerKey);'), 'const roofHit = this.roofRoomAtCell(pointerKey); の行が見つからない');
  assert.ok(lines.includes('if (roofHit) { this.selectRoom(roofHit.id); return; }'), 'roofHit の選択と return の1行が見つからない');
  assert.ok(body.indexOf('roofRoomAtCell(pointerKey)') < body.indexOf('this.dragState = {'), '屋根の判定はドラッグ開始より前');
});

test('【不変条件・B2b】屋根セルを部屋ドラッグの除外対象に含める行（isRoofFeature）が残っている（屋根は広げない・取り込まない）', () => {
  assert.ok(stateLines.includes(
    'if (room.feature !== RoomFeature.STAIR_VOID && !isShaftFeature(room.feature) && !isRoofFeature(room.feature)) continue;'),
  '_roomExcludedStairKeys の屋根除外の行が見つからない');
});

test('【不変条件・B2b】roofRoomAtCell は isRoofFeature の部屋のうち refreshCells がセルキーを含むものだけを返す', () => {
  const body = sliceBlock(stateCode, '  roofRoomAtCell(cellKey) {', '  startDrag(wx, wy) {');
  assert.ok(/if \(isRoofFeature\(room\.feature\) && refreshCells\(room\.cells, this\.graph\)\.has\(cellKey\)\) return room;/.test(body),
    'roofRoomAtCell の判定行が見つからない');
});

test('【不変条件・B2b】屋根の選択は既存の「屋外部屋の選択→外部タブへ切替」の経路に載る（kind===EXTERIOR かつ非階段で exterior タブ）', () => {
  assert.ok(tableLines.includes('&& selectedRoom.kind === RoomKind.EXTERIOR && selectedRoom.feature !== RoomFeature.STAIR;'),
    'selectedIsExterior の判定行が見つからない（屋根を除外していない）');
  assert.ok(tableLines.includes("setActiveTab(selectedIsExterior ? 'exterior' : 'interior');"), '外部タブへの切替の行が見つからない');
});

test('【不変条件・B2b】屋根の群は RoofGroupFrame で囲み、選択中の判定は isSelectedRoofGroup（純関数）の結果を渡すだけ。枠はスクロールフックと選択の強調を持つ', () => {
  assert.ok(tableLines.includes(
    '<RoofGroupFrame key={groupKey} selected={isSelectedRoofGroup({ type: groupType, roomId }, mode.selectedRoomId)}>'),
  'RoofGroupFrame の選択中の配線の行が見つからない');
  assert.ok(tableLines.includes('</RoofGroupFrame>'), '</RoofGroupFrame> が見つからない');
  const frame = sliceBlock(tableCode, 'const RoofGroupFrame', 'const GroupedExteriorTable');
  assert.ok(/const frameRef = useScrollIntoViewWhenActive\(selected\);/.test(frame), 'スクロールフックが見つからない');
  assert.ok(/ref=\{frameRef\}/.test(frame), 'ref が枠に付いていない');
  assert.ok(/outline: selected \? '2px solid #2563eb' : 'none',/.test(frame), '選択中の強調（部屋カードと同じ青枠）が見つからない');
});

test('【不変条件】FinishTable.jsx の屋根の群（groupType===roof）は RoofGroup を描く。屋外部屋の群・部位の群の描画（ExteriorLevelRow・ExteriorPartHeading）は屋根の分岐に入らない', () => {
  assert.ok(tableCode.split('\n').map(l => l.trim()).includes(
    '{roofRoom && <RoofGroup room={roofRoom} graph={graph} mode={mode} styles={{ cellBase, headerCell, cellInputStyle }} />}'),
  'FinishTable.jsx に RoofGroup の配線の1行が見つからない');
  const roofBranchStart = tableCode.indexOf("if (groupType === 'roof') {");
  assert.ok(roofBranchStart >= 0, "if (groupType === 'roof') { が見つからない");
  const roofBranchEnd = tableCode.indexOf('const room   = roomId', roofBranchStart);
  const roofBranch = tableCode.slice(roofBranchStart, roofBranchEnd);
  assert.ok(!/ExteriorLevelRow|ExteriorPartHeading/.test(roofBranch), '屋根の分岐に屋外部屋の群の部品が入っている');
  assert.ok(/setDeleteConfirm\(\{ roomId, roomName: part \}\)/.test(roofBranch), '屋根の群の削除ボタン（見出し「屋根」）が残っている');
});
