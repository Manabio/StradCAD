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

test('【不変条件・C1b】「高い側」の欄は highSide.visible のときだけ、形状 select の直後に出す。値は highSide.value・選択肢は roofHighSideOptions()・確定は set(\'highSide\', …)', () => {
  assert.ok(roofLines.includes('{highSide.visible && <span style={formLabelStyle}>高い側</span>}'), 'ラベルの visible 結び付けが見つからない');
  assert.ok(roofLines.includes('{highSide.visible && ('), 'select の visible 結び付けが見つからない');
  assert.ok(roofLines.includes('value={highSide.value}'), 'value={highSide.value} が見つからない');
  assert.ok(roofLines.includes("onChange={e => set('highSide', e.target.value)}"), "onChange が set('highSide', …) でない");
  assert.ok(/roofHighSideOptions\(\)\.map\(/.test(groupBody), 'roofHighSideOptions().map( が見つからない');
  // 形状 select の直後（形状の選択肢の閉じタグの後、勾配ラベルの前）にある
  const shapeEnd = groupBody.indexOf('roofShapeOptions().map(');
  const highStart = groupBody.indexOf('{highSide.visible && <span');
  const slopeLabel = groupBody.indexOf('<span style={formLabelStyle}>勾配</span>');
  assert.ok(shapeEnd >= 0 && shapeEnd < highStart && highStart < slopeLabel, '形状 select → 高い側 → 勾配 の順');
  // visible の導出は呼び出し側（純関数）。下屋と主屋根がそれぞれ導いて渡す
  assert.ok(roofLines.includes('const highSide = roofHighSideViewOfRoom(room, graph);'), '下屋の高い側の導出の行が見つからない');
  assert.ok(roofLines.includes('const highSide = mainRoofHighSideView(graph, mode.project);'), '主屋根の高い側の導出の行が見つからない');
  assert.ok(!/\.highSide\s*=|setField\('highSide'/.test(roofCode), 'jsx が highSide を直接書き換えていない（確定は set 経由）');
});

test('【不変条件・C2e-1c】「棟木の向き」の欄は ridgeDirection.visible のときだけ、高い側の直後（勾配の前）に出す。値は ridgeDirection.value（自動は \'\'）・選択肢は roofRidgeDirectionOptions()・確定は set(\'ridgeDirection\', 保存値)', () => {
  assert.ok(roofLines.includes('{ridgeDirection.visible && <span style={formLabelStyle}>棟木の向き</span>}'), 'ラベルの visible 結び付けが見つからない');
  assert.ok(roofLines.includes('{ridgeDirection.visible && ('), 'select の visible 結び付けが見つからない');
  assert.ok(roofLines.includes("value={ridgeDirection.value ?? ''}"), "value={ridgeDirection.value ?? ''} が見つからない");
  assert.ok(roofLines.includes("onChange={e => set('ridgeDirection', roofRidgeDirectionFromSelect(e.target.value))}"),
    "onChange が set('ridgeDirection', roofRidgeDirectionFromSelect(…)) でない");
  assert.ok(/roofRidgeDirectionOptions\(\)\.map\(/.test(groupBody), 'roofRidgeDirectionOptions().map( が見つからない');
  const highStart = groupBody.indexOf('{highSide.visible && <span');
  const ridgeStart = groupBody.indexOf('{ridgeDirection.visible && <span');
  const slopeLabel = groupBody.indexOf('<span style={formLabelStyle}>勾配</span>');
  assert.ok(highStart >= 0 && highStart < ridgeStart && ridgeStart < slopeLabel, '高い側 → 棟木の向き → 勾配 の順');
  assert.ok(roofLines.includes('const ridgeDirection = roofRidgeDirectionViewOfRoom(room, graph);'), '下屋の棟木の向きの導出の行が見つからない');
  assert.ok(roofLines.includes('const ridgeDirection = mainRoofRidgeDirectionView(graph, mode.project);'), '主屋根の棟木の向きの導出の行が見つからない');
  assert.ok(!/\.ridgeDirection\s*=|setField\('ridgeDirection'/.test(roofCode), 'jsx が ridgeDirection を直接書き換えていない（確定は set 経由）');
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
  assert.equal((roofCode.match(/<select/g) ?? []).length, 4, 'select は形状・高い側・棟木の向き・材料（共通の materialSelect）の4か所だけ');
  assert.equal((roofCode.match(/<input/g) ?? []).length, 3, 'input は RoofTextInput・RoofNumberInput・柱貫通のチェックの3か所だけ');
});

test('【不変条件・柱貫通】「柱貫通」チェックは columnThrough.visible のときだけ、妻側の出の直後（表の前）に出す。値は columnThrough.value・確定は set(\'columnThrough\', checked)。主屋根へは出さない', () => {
  assert.ok(roofLines.includes('{columnThrough.visible && ('), 'チェックの visible 結び付けが見つからない');
  assert.ok(roofLines.includes('checked={columnThrough.value}'), 'checked={columnThrough.value} が見つからない');
  assert.ok(roofLines.includes("onChange={e => set('columnThrough', e.target.checked)}"), "onChange が set('columnThrough', e.target.checked) でない");
  assert.ok(roofLines.includes('type="checkbox"'), 'チェックボックスでない');
  const gableLabel = groupBody.indexOf('妻側の出');
  const checkStart = groupBody.indexOf('{columnThrough.visible && (');
  const tableStart = groupBody.indexOf('<table');
  assert.ok(gableLabel >= 0 && gableLabel < checkStart && checkStart < tableStart, '妻側の出 → 柱貫通 → 表 の順');
  // 表示判断は純関数（下屋は部屋と階から、主屋根は isLeanTo:false の固定）
  assert.ok(roofLines.includes('const columnThrough = roofColumnThroughViewOfRoom(room, graph, mode.project);'), '下屋の柱貫通の導出の行が見つからない');
  assert.ok(roofLines.includes('const columnThrough = roofColumnThroughView({ isLeanTo: false, columnPlacement: null, hasColumns: false, columnThrough: false });'), '主屋根の柱貫通の導出の行が見つからない');
  assert.equal((roofCode.match(/columnThrough=\{columnThrough\}/g) ?? []).length, 2, '下屋・主屋根の2か所から RoofSpecFields へ渡す');
  assert.ok(!/\.columnThrough\s*=|setField\('columnThrough'/.test(roofCode), 'jsx が columnThrough を直接書き換えていない（確定は set 経由）');
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
    'if (!isShaftFeature(room.feature) && !isRoofFeature(room.feature)) continue;'),
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
  // 行末コメントを除いた1行まるごと一致で検査する（変異「outline: 'none', // outline: selected ? ...」等を通さない）
  const frameLines = frame.split('\n').map(l => l.replace(/\s\/\/.*$/, '').trim());
  assert.ok(frameLines.includes('const frameRef = useScrollIntoViewWhenActive(selected);'), 'スクロールフックが見つからない');
  assert.ok(frameLines.includes('ref={frameRef}'), 'ref が枠に付いていない');
  assert.ok(frameLines.includes("outline: selected ? '2px solid #2563eb' : 'none',"), '選択中の強調（部屋カードと同じ青枠）が見つからない');
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

// ---- ステップB3: 主屋根（最上階の外部タブ先頭の固定の群） ----
const mainStart = roofCode.indexOf('export const MainRoofGroup');
const mainBody = roofCode.slice(mainStart, roofCode.indexOf('const RoofSpecFields', mainStart));

test('【不変条件・B3】MainRoofGroup の確定は mode.setMainRoofField(field, value) の1か所。形状は resolveMainRoofShape(graph, mode.project)。値は graph.mainRoofSpec', () => {
  assert.ok(mainStart >= 0, 'export const MainRoofGroup が見つからない');
  const lines = mainBody.split('\n').map(l => l.replace(/\s\/\/.*$/, '').trim());
  assert.ok(lines.includes('const spec = graph.mainRoofSpec;'), 'const spec = graph.mainRoofSpec; が見つからない');
  assert.ok(lines.includes('const set = (field, value) => mode.setMainRoofField(field, value);'), '確定の1行が見つからない');
  assert.ok(lines.includes('const shape = resolveMainRoofShape(graph, mode.project);'), '形状の導出の1行が見つからない');
  assert.equal((roofCode.match(/mode\.setMainRoofField\(/g) ?? []).length, 1, 'mode.setMainRoofField の呼び出しは1か所だけ');
  assert.ok(!/\.setField\(|setRoofField|setMainRoofSpec/.test(mainBody), '主屋根の群が RoofSpec を直接書き換えていない（確定は mode 経由）');
});

test('【不変条件・B3】下屋と主屋根は同じ描画部品 RoofSpecFields（spec・shape・set を引数で受ける）を使い、各1回ずつ描く', () => {
  assert.equal(roofLines.filter(l => l === 'return <RoofSpecFields spec={spec} shape={shape} highSide={highSide} ridgeDirection={ridgeDirection} columnThrough={columnThrough} set={set} mode={mode} styles={styles} />;').length, 2,
    '下屋と主屋根の2か所で同じ RoofSpecFields を同じ引数で描く');
  assert.ok(roofLines.includes('const RoofSpecFields = observer(({ spec, shape, highSide, ridgeDirection, columnThrough, set, mode, styles }) => {'), 'RoofSpecFields の宣言');
  // 下屋の形状の導出（範囲は屋根セル）は RoofGroup 側のまま
  assert.ok(roofLines.includes('const shape = resolveRoofShape(spec, { boundsList: roofRoomBounds(room, graph) });'));
});

test('【不変条件・B3】FinishTable.jsx: 主屋根の群は最上階（isTopFloorPlane）のときだけ buildExteriorGroups に含め、MainRoofGroup を描く。削除ボタン・選択の青枠・屋外部屋の部品を持たない', () => {
  assert.ok(tableLines.includes('const includeMainRoof = isTopFloorPlane(mode.project, graph.plane);'), 'includeMainRoof の1行が見つからない');
  const branch = sliceBlock(tableCode, "if (groupType === 'mainRoof') {", "if (groupType === 'roof') {");
  assert.ok(/<MainRoofGroup graph=\{graph\} mode=\{mode\} styles=\{\{ cellBase, headerCell, cellInputStyle \}\} \/>/.test(branch), 'MainRoofGroup の配線が見つからない');
  assert.ok(!/setDeleteConfirm|削除|deleteButtonStyle|<button|deleteRoom/.test(branch), '主屋根の群に削除ボタン（button・deleteRoom・setDeleteConfirm）がある');
  assert.ok(!/RoofGroupFrame|isSelectedRoofGroup|outline/.test(branch), '主屋根の群に選択の青枠がある');
  assert.ok(!/ExteriorLevelRow|ExteriorPartHeading|<RoofGroup /.test(branch), '主屋根の分岐に他の群の部品が入っている');
  assert.ok(branch.indexOf('>{part}<') >= 0, '見出しは群の part（固定「屋根」）');
});

test('【不変条件・B3】カタログ照合ダイアログは location=mainRoofSpec を「主屋根」と表示する（下屋の roofSpec＝「屋根」と区別）', () => {
  const dialog = codeOf('../../ui/CatalogResolveDialog.jsx');
  assert.ok(dialog.split('\n').map(l => l.trim()).includes("mainRoofSpec: '主屋根',"), "mainRoofSpec: '主屋根', が見つからない");
  assert.ok(dialog.split('\n').map(l => l.trim()).includes("roofSpec: '屋根',"), '下屋の表示名は不変');
});

test('【不変条件・B3】階追加の引き継ぎ: follower mainRoofCarry は INSERT のみで carryMainRoofToNewTop(ctx.project, ctx.addedPlane) を呼ぶ。階の切替より前', () => {
  const orderCode = codeOf('../../floorOrderChange.js');
  const lines = orderCode.split('\n').map(l => l.replace(/\s\/\/.*$/, '').trim());
  assert.ok(lines.includes('await carryMainRoofToNewTop(ctx.project, ctx.addedPlane);'), 'follower の呼び出し行が見つからない');
  assert.ok(lines.includes("import { carryMainRoofToNewTop } from './finish/roof/mainRoofFloorSync.js';"));
  const block = sliceBlock(orderCode, "name: 'mainRoofCarry',", "name: 'switchToAddedFloor',");
  assert.ok(/appliesTo: \[FLOOR_ORDER_KIND\.INSERT\],/.test(block), 'appliesTo は INSERT のみ');
});

test('【不変条件・B3】mainRoof.js・mainRoofFloorSync.js は store.js・snap.js・.jsx を静的 import しない（node:test から単体 import できる）', () => {
  for (const file of ['mainRoof.js', 'mainRoofFloorSync.js']) {
    const code = codeOf(file);
    assert.ok(!/from '[^']*(store|snap)\.js'/.test(code), `${file} が store.js／snap.js を import している`);
    assert.ok(!/from '[^']*\.jsx'/.test(code), `${file} が .jsx を import している`);
  }
});
