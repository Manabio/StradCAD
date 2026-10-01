// FinishTable.jsx（仕上げ表）の配線不変条件。.jsx は node:test から単体 import できないため、
// ソーステキスト検査で固定する（renderer/VoidLayer.wiring.test.js と同じ型。ブロックコメント・
// 行コメントを除去してから検査する——team-lessons「ソース文字列を正規表現で検査する配線テストが、
// コメント文にも一致して変異を見逃す」対応）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const filePath = path.resolve(import.meta.dirname, 'FinishTable.jsx');
const src = fs.readFileSync(filePath, 'utf8');

function stripComments(text) {
  const withoutBlockComments = text.replace(/\/\*[\s\S]*?\*\//g, '');
  return withoutBlockComments.split(/\r?\n/)
    .filter(line => !line.trim().startsWith('//'))
    .join('\n');
}

const codeOnly = stripComments(src);

test('【不変条件】昇降路 壁仕上げ材の options は shaftWallMaterialOptions(graph.shaftWallMaterial, …) を呼んで組み立てる', () => {
  assert.ok(/shaftWallMaterialOptions\(graph\.shaftWallMaterial, /.test(codeOnly),
    'shaftWallMaterialOptions(graph.shaftWallMaterial, ... の呼び出しが見つからない');
});

test('【不変条件】昇降路 壁仕上げ材・防音材の変更は withFinishUndo(graph, () => …) 経由で行う（undo対象）', () => {
  assert.ok(/withFinishUndo\(graph, \(\) => graph\.setShaftWallMaterial\(code\)\)/.test(codeOnly),
    'graph.setShaftWallMaterial(code) が withFinishUndo(graph, () => …) の直接引数になっていない');
  assert.ok(/withFinishUndo\(graph, \(\) => graph\.setShaftSoundproof\(v\)\)/.test(codeOnly),
    'graph.setShaftSoundproof(v) が withFinishUndo(graph, () => …) の直接引数になっていない');
});

test('【不変条件】InteriorTable の部屋一覧フィルタ（const rooms = graph.rooms.filter(...)）は !isShaftFeature(r.feature) を含む（昇降路は内部タブに出さない）', () => {
  const startNeedle = 'const rooms = graph.rooms.filter(';
  const startIdx = codeOnly.indexOf(startNeedle);
  assert.ok(startIdx >= 0, 'const rooms = graph.rooms.filter( が見つからない');
  const endIdx = codeOnly.indexOf(');', startIdx);
  assert.ok(endIdx >= 0, 'const rooms = graph.rooms.filter( の閉じ );  が見つからない');
  const filterBlock = codeOnly.slice(startIdx, endIdx + 2);
  assert.ok(/!isShaftFeature\(r\.feature\)/.test(filterBlock),
    'const rooms = graph.rooms.filter(...) の範囲に !isShaftFeature(r.feature) が見つからない');
});

// ---- ステップ1（部屋編集の導線変更）: RoomCard が名称入力・区分/属性セレクタ・onApplyNaming を持つ ----

test('【不変条件】RoomCard は展開時に CardNameInput（名称入力）を描画する', () => {
  assert.ok(/<CardNameInput room=\{room\} onApplyNaming=\{onApplyNaming\} \/>/.test(codeOnly),
    'RoomCard に <CardNameInput room={room} onApplyNaming={onApplyNaming} /> が見つからない');
});

test('【不変条件】CardKindFeatureRow は ROOM_KIND_OPTIONS.map( と CARD_FEATURE_OPTIONS.map( を各1回呼ぶ（昇降路の無いカード用選択肢）', () => {
  const startIdx = codeOnly.indexOf('const CardKindFeatureRow');
  assert.ok(startIdx >= 0, 'const CardKindFeatureRow が見つからない');
  const endIdx = codeOnly.indexOf('));', startIdx);
  const block = codeOnly.slice(startIdx, endIdx + 3);
  assert.equal((block.match(/ROOM_KIND_OPTIONS\.map\(/g) ?? []).length, 1,
    'CardKindFeatureRow に ROOM_KIND_OPTIONS.map( が1回見つからない');
  assert.equal((block.match(/CARD_FEATURE_OPTIONS\.map\(/g) ?? []).length, 1,
    'CardKindFeatureRow に CARD_FEATURE_OPTIONS.map( が1回見つからない');
  assert.ok(!/ROOM_FEATURE_OPTIONS\.map\(/.test(block),
    'CardKindFeatureRow が ROOM_FEATURE_OPTIONS（昇降路込み）を使っている——CARD_FEATURE_OPTIONSのはず');
});

test('【不変条件】CardKindFeatureRow の区分・属性 select の onChange は変化した場合のみ onApplyNaming を呼ぶ（無変更でundoを積まない）', () => {
  const startIdx = codeOnly.indexOf('const CardKindFeatureRow');
  const endIdx = codeOnly.indexOf('));', startIdx);
  const block = codeOnly.slice(startIdx, endIdx + 3);
  assert.ok(/if \(kind !== room\.kind\) onApplyNaming\(/.test(block),
    '区分 select の onChange が if (kind !== room.kind) onApplyNaming(... の形で見つからない');
  assert.ok(/if \(feature !== room\.feature\) onApplyNaming\(/.test(block),
    '属性 select の onChange が if (feature !== room.feature) onApplyNaming(... の形で見つからない');
});

// T3: CardNameInput の commit は trim後の値が room.name と異なる場合だけ onApplyNaming を呼ぶ。
test('【不変条件・T3】CardNameInput の commit は trimmed !== room.name のときだけ onApplyNaming(room.id, { name: trimmed, kind: room.kind, feature: room.feature }) を呼ぶ', () => {
  const startIdx = codeOnly.indexOf('const CardNameInput');
  assert.ok(startIdx >= 0, 'const CardNameInput が見つからない');
  const endIdx = codeOnly.indexOf('});', startIdx);
  const block = codeOnly.slice(startIdx, endIdx + 3);
  assert.ok(/if \(trimmed !== \(room\.name \|\| ''\)\) \{\s*onApplyNaming\(room\.id, \{ name: trimmed, kind: room\.kind, feature: room\.feature \}\);/.test(block),
    'commit が if (trimmed !== (room.name || "")) { onApplyNaming(room.id, { name: trimmed, kind: room.kind, feature: room.feature }); の形で見つからない');
  assert.equal((block.match(/onApplyNaming\(/g) ?? []).length, 1,
    'CardNameInput 内の onApplyNaming( 呼び出しは1回（ガード内のみ）のはず');
});

// T4: RoomCard は展開時にCardKindFeatureRowを描き、InteriorTable→RoomCardへonApplyNaming/stairEnabledを渡す。
test('【不変条件・T4】RoomCard は展開時に <CardKindFeatureRow room={room} onApplyNaming={onApplyNaming} stairEnabled={stairEnabled} /> を描く', () => {
  assert.ok(/<CardKindFeatureRow room=\{room\} onApplyNaming=\{onApplyNaming\} stairEnabled=\{stairEnabled\} \/>/.test(codeOnly),
    'RoomCard に <CardKindFeatureRow room={room} onApplyNaming={onApplyNaming} stairEnabled={stairEnabled} /> が見つからない');
});

test('【不変条件・T4】InteriorTable の <RoomCard ...> は onApplyNaming={onApplyNaming}・stairEnabled={stairEnabled} を渡す', () => {
  const startIdx = codeOnly.indexOf('<RoomCard');
  assert.ok(startIdx >= 0, '<RoomCard が見つからない');
  const endIdx = codeOnly.indexOf('/>', startIdx);
  const block = codeOnly.slice(startIdx, endIdx + 2);
  assert.ok(/onApplyNaming=\{onApplyNaming\}/.test(block),
    '<RoomCard ...> に onApplyNaming={onApplyNaming} が見つからない');
  assert.ok(/stairEnabled=\{stairEnabled\}/.test(block),
    '<RoomCard ...> に stairEnabled={stairEnabled} が見つからない');
});

// T5: GroupedExteriorTableは屋外・非階段の連動群の見出しにExteriorPartHeadingを使い、
// その commit は mode.renameExteriorRoom(room.id, draft) を呼ぶ。
test('【不変条件・T5】GroupedExteriorTable は showLevelRow のとき <ExteriorPartHeading room={room} mode={mode} /> を見出しに使う', () => {
  assert.ok(/\? <ExteriorPartHeading room=\{room\} mode=\{mode\} \/>/.test(codeOnly),
    'showLevelRow の三項演算子に <ExteriorPartHeading room={room} mode={mode} /> が見つからない');
});

test('【不変条件・T5】ExteriorPartHeading の commit は mode.renameExteriorRoom(room.id, draft) を呼ぶ', () => {
  const startIdx = codeOnly.indexOf('const ExteriorPartHeading');
  assert.ok(startIdx >= 0, 'const ExteriorPartHeading が見つからない');
  const endIdx = codeOnly.indexOf('});', startIdx);
  const block = codeOnly.slice(startIdx, endIdx + 3);
  assert.ok(/mode\.renameExteriorRoom\(room\.id, draft\)/.test(block),
    'ExteriorPartHeading の commit に mode.renameExteriorRoom(room.id, draft) が見つからない');
});

// ---- ステップ1補足（ユーザー裁定1）: 外部タブ「屋外部屋の群」に削除ボタン（Room連動）・区分セレクタ ----

function groupedExteriorTableBlock() {
  const startIdx = codeOnly.indexOf('const GroupedExteriorTable');
  assert.ok(startIdx >= 0, 'const GroupedExteriorTable が見つからない');
  const endIdx = codeOnly.indexOf('\nconst ExteriorCell', startIdx);
  assert.ok(endIdx >= 0, 'GroupedExteriorTable の終端（次のconst ExteriorCell）が見つからない');
  return codeOnly.slice(startIdx, endIdx);
}

test('【不変条件・W1】GroupedExteriorTable は exteriorGroups.js の buildExteriorGroups を唯一の供給源にする', () => {
  assert.ok(/import \{ buildExteriorGroups, isExteriorRoomGroupRoom \} from '\.\/exteriorGroups\.js';/.test(codeOnly),
    "import { buildExteriorGroups, isExteriorRoomGroupRoom } from './exteriorGroups.js'; が見つからない");
  const block = groupedExteriorTableBlock();
  assert.ok(/buildExteriorGroups\(\{ rows, rooms: graph\.rooms, roomOrder: graph\.roomOrder \}\)/.test(block),
    'GroupedExteriorTable本体に buildExteriorGroups({ rows, rooms: graph.rooms, roomOrder: graph.roomOrder }) の呼び出しが見つからない');
  // 旧実装（rowsから直接Mapを組む処理）が復活していないことも固定する
  assert.ok(!/const key = row\.roomId \? `room:\$\{row\.roomId\}` : `part:\$\{row\.part\}`;/.test(block),
    '群キーの手組みロジックが残っている（buildExteriorGroupsへ一本化されていないはず）');
});

test('【不変条件・W2】屋外部屋の群の削除は RoomDeleteConfirm（共通コンポーネント）へ委譲し、graph.removeExteriorRowsByRoomId は呼ばない（階段連動群・手入力群の削除は現行のまま）', () => {
  const block = groupedExteriorTableBlock();
  assert.ok(/<RoomDeleteConfirm graph=\{graph\} mode=\{mode\} deleteConfirm=\{deleteConfirm\} onClose=\{\(\) => setDeleteConfirm\(null\)\} \/>/.test(block),
    'GroupedExteriorTable に <RoomDeleteConfirm graph={graph} mode={mode} deleteConfirm={deleteConfirm} onClose={() => setDeleteConfirm(null)} /> が見つからない');
  assert.ok(/setDeleteConfirm\(\{ roomId, roomName: room\.name \}\)/.test(block),
    '屋外部屋の群の削除ボタンが setDeleteConfirm({ roomId, roomName: room.name }) を呼んでいない');
  // removeExteriorRowsByRoomId は非屋外部屋の群（階段連動群）の削除経路にちょうど1回だけ現れるはず
  // （屋外部屋の群の削除経路では呼ばれない＝直接のexteriorRows操作をRoomDeleteConfirm＝mode.deleteRoomへ委譲）
  const matches = block.match(/graph\.removeExteriorRowsByRoomId\(roomId\)/g) ?? [];
  assert.equal(matches.length, 1,
    `graph.removeExteriorRowsByRoomId(roomId) は階段連動群の削除経路の1箇所だけのはず（実際: ${matches.length}）`);
});

// ステップ1補足のQA指摘（重複解消）: 内部タブのカード・外部タブの屋外部屋の群の削除確認は
// RoomDeleteConfirm（共通コンポーネント）に一本化され、mode.deleteRoom( の呼び出しはその内部
// 1箇所だけになる。呼び出し側（InteriorTable・GroupedExteriorTable）は2箇所とも同じpropsで使う。
// 昇降機の仕様追加ステップ3（S4）: RoomDeleteConfirm 自体は finish/RoomDeleteConfirm.jsx へ
// 切り出された（機械器具タブの未登録の昇降路の削除確認からも import するため）。
// mode.deleteRoom(deleteConfirm.roomId) の呼び出しは FinishTable.jsx には無く（切り出し先の
// RoomDeleteConfirm.jsx に1箇所だけ）、<RoomDeleteConfirm .../> の JSX 使用は
// FinishTable.jsx 側に引き続き2箇所（InteriorTable・GroupedExteriorTable）。
test('【不変条件・W2b】mode.deleteRoom(deleteConfirm.roomId) の呼び出しは RoomDeleteConfirm.jsx 内の1箇所だけ（FinishTable.jsx には無い。InteriorTable・GroupedExteriorTableが共有）', () => {
  const deleteRoomMatchesInFinishTable = codeOnly.match(/mode\.deleteRoom\(deleteConfirm\.roomId\)/g) ?? [];
  assert.equal(deleteRoomMatchesInFinishTable.length, 0,
    `mode.deleteRoom(deleteConfirm.roomId) は FinishTable.jsx には無いはず（切り出し済み。実際: ${deleteRoomMatchesInFinishTable.length}）`);

  const confirmSrc = fs.readFileSync(path.resolve(import.meta.dirname, 'RoomDeleteConfirm.jsx'), 'utf8');
  const confirmCodeOnly = stripComments(confirmSrc);
  const deleteRoomMatchesInConfirm = confirmCodeOnly.match(/mode\.deleteRoom\(deleteConfirm\.roomId\)/g) ?? [];
  assert.equal(deleteRoomMatchesInConfirm.length, 1,
    `mode.deleteRoom(deleteConfirm.roomId) は RoomDeleteConfirm.jsx 内の1箇所だけのはず（実際: ${deleteRoomMatchesInConfirm.length}）`);

  const usageMatches = codeOnly.match(
    /<RoomDeleteConfirm graph=\{graph\} mode=\{mode\} deleteConfirm=\{deleteConfirm\} onClose=\{\(\) => setDeleteConfirm\(null\)\} \/>/g) ?? [];
  assert.equal(usageMatches.length, 2,
    `<RoomDeleteConfirm .../> の呼び出しはInteriorTable・GroupedExteriorTableの2箇所のはず（実際: ${usageMatches.length}）`);
});

// W5: 削除ボタンの分岐は isExteriorRoomGroup（isExteriorRoomGroupRoomの結果）で判定する。
// roomId の有無（階段連動群・手入力群かどうか）で誤判定すると、階段連動群の削除も
// mode.deleteRoom へ流れてしまう（階段連動群はroomIdを持つがisExteriorRoomGroupはfalse）。
test('【不変条件・W5】階段連動群・孤立行の群の削除は mode.deleteRoom に流れない（分岐はisExteriorRoomGroupで判定・roomIdの有無では判定しない）', () => {
  const block = groupedExteriorTableBlock();
  assert.ok(/const isExteriorRoomGroup = isExteriorRoomGroupRoom\(room\);/.test(block),
    'const isExteriorRoomGroup = isExteriorRoomGroupRoom(room); が見つからない');
  assert.ok(/\{isExteriorRoomGroup \? \(/.test(block),
    '削除ボタンの分岐が {isExteriorRoomGroup ? ( の形で見つからない');
  assert.ok(!/\{roomId \? \(/.test(block),
    '削除ボタンの分岐が {roomId ? ( になっている（isExteriorRoomGroupで判定すべき——階段連動群もroomIdを持つため誤判定になる）');
});

test('【不変条件・W3】屋外部屋の群の区分セレクタは変化時だけ onApplyNaming(room.id, { name: room.name, kind, feature: room.feature }) を呼ぶ', () => {
  const block = groupedExteriorTableBlock();
  assert.ok(/if \(kind !== room\.kind\) onApplyNaming\(room\.id, \{ name: room\.name, kind, feature: room\.feature \}\);/.test(block),
    '区分セレクタの onChange が if (kind !== room.kind) onApplyNaming(room.id, { name: room.name, kind, feature: room.feature }); の形で見つからない');
  assert.ok(/ROOM_KIND_OPTIONS\.map\(/.test(block), 'ROOM_KIND_OPTIONS.map( が見つからない');
});

test('【不変条件・W4】FinishTable は <ExteriorTable ...> へ onApplyNaming={onApplyNaming} を渡す', () => {
  const startIdx = codeOnly.indexOf('<ExteriorTable');
  assert.ok(startIdx >= 0, '<ExteriorTable が見つからない');
  const endIdx = codeOnly.indexOf('/>', startIdx);
  const block = codeOnly.slice(startIdx, endIdx + 2);
  assert.ok(/onApplyNaming=\{onApplyNaming\}/.test(block),
    '<ExteriorTable ...> に onApplyNaming={onApplyNaming} が見つからない');
});

test('【不変条件・W4b】ExteriorTable は GroupedExteriorTable へ onApplyNaming を中継する', () => {
  assert.ok(/<GroupedExteriorTable graph=\{graph\} mode=\{mode\} onApplyNaming=\{onApplyNaming\} category=\{category\} \/>/.test(codeOnly),
    '<GroupedExteriorTable graph={graph} mode={mode} onApplyNaming={onApplyNaming} category={category} /> が見つからない');
});

// ---- 昇降機の仕様追加ステップ2: 機械器具・附帯タブは空タブ専用コンポーネントへ分岐し、
// ExteriorTable（構造/外部建具/外部と同じ else 分岐）へ落ちないこと ----
test('【不変条件】TABS の id の並びが interior/stair/exterior/fittings/structure/equipment/accessory/common のとおり', () => {
  const startIdx = codeOnly.indexOf('const TABS = [');
  assert.ok(startIdx >= 0, 'const TABS = [ が見つからない');
  const endIdx = codeOnly.indexOf('];', startIdx);
  const block = codeOnly.slice(startIdx, endIdx + 2);
  const ids = [...block.matchAll(/id: '([a-z]+)'/g)].map(m => m[1]);
  assert.deepEqual(ids,
    ['interior', 'stair', 'exterior', 'fittings', 'structure', 'equipment', 'accessory', 'common']);
});

// 昇降機の仕様追加ステップ3（S4）: 機械器具タブは EmptyTabPlaceholder から EquipmentTab
// （finish/equipment/EquipmentTab.jsx）へ置き換わった。附帯タブは引き続きプレースホルダのまま。
// ステップ5でEquipmentTabへonDeleteEquipment/onChangeEquipmentUsage（全階連動の入口。App.jsx参照）
// を渡す形へ変わり複数行になったため、1行まるごとの形（mフラグ）で個別に固定する
// （旧→新: 1正規表現でのJSX全体一致 → 属性ごとの1行まるごと一致。理由: 属性が増え複数行化した
// ため単一の1行正規表現では表現できない。team-lessons「配線テストは1行まるごと一致させる」）。
// タブバー横スクロール: タブ内の文字を折返しせず、タブバー自体を横スクロール可能にする
// （コンテナに overflowX:'auto'、各タブに whiteSpace:'nowrap' を持たせる）。
test('【不変条件】タブバーのコンテナは overflowX: auto を持ち、各タブは whiteSpace: nowrap を持つ（折返しせず横スクロール）', () => {
  const startIdx = codeOnly.indexOf("borderBottom: '1px solid #e2e8f0',\n        background: '#f8fafc',");
  assert.ok(startIdx >= 0, 'タブバーのコンテナのstyleが見つからない');
  const endIdx = codeOnly.indexOf('{TABS.map(tab =>', startIdx);
  assert.ok(endIdx >= 0, 'TABS.map( が見つからない');
  const containerBlock = codeOnly.slice(startIdx, endIdx);
  assert.ok(/overflowX:\s*'auto'/.test(containerBlock),
    'タブバーのコンテナに overflowX: \'auto\' が見つからない');

  const buttonStartIdx = codeOnly.indexOf('<button', endIdx);
  const buttonEndIdx = codeOnly.indexOf('</button>', buttonStartIdx);
  const buttonBlock = codeOnly.slice(buttonStartIdx, buttonEndIdx);
  assert.ok(/whiteSpace:\s*'nowrap'/.test(buttonBlock),
    'タブの <button> に whiteSpace: \'nowrap\' が見つからない');
});

test('【不変条件】activeTab===equipmentは<EquipmentTab ...>（onDeleteEquipment/onChangeEquipmentUsage込み）へ、accessoryは<EmptyTabPlaceholder message="…" />へ分岐し、ExteriorTable（else分岐）へ落ちない', () => {
  assert.match(codeOnly, /^\s*: activeTab === 'equipment'\s*$/m, "activeTab === 'equipment' の分岐行が見つからない");
  assert.match(codeOnly, /^\s*\? <EquipmentTab\s*$/m, '? <EquipmentTab が見つからない');
  assert.match(codeOnly, /^\s*onDeleteEquipment=\{onDeleteEquipment\}\s*$/m, 'onDeleteEquipment={onDeleteEquipment} が見つからない');
  assert.match(codeOnly, /^\s*onChangeEquipmentUsage=\{onChangeEquipmentUsage\}\s*$/m, 'onChangeEquipmentUsage={onChangeEquipmentUsage} が見つからない');
  assert.ok(/activeTab === 'accessory'\s*\?\s*<EmptyTabPlaceholder message="附帯は未対応です" \/>/.test(codeOnly),
    'activeTab === \'accessory\' ? <EmptyTabPlaceholder message="附帯は未対応です" /> が見つからない');
});
