// 昇降機の仕様追加 ステップ4・S4（QA指摘W5）: finish/equipment/EquipmentTab.jsx が
// buildEquipmentTabEntries へ渡す spanLabelOf を mode.equipmentSpanLabel(id) から作っている
// ことをソーステキスト検査で固定する（.jsx は node:test から単体 import できないため。
// renderer/PlanSolidsLayer.wiring.test.js と同じ型。1行まるごとの m フラグ・行頭行末アンカーで照合する
// ——team-lessons「行末コメントに元の式を残す変異・条件式を定数に差し替える変異」対応）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const filePath = path.resolve(import.meta.dirname, 'EquipmentTab.jsx');
const src = fs.readFileSync(filePath, 'utf8');

test('【配線・強化・W5】EquipmentTab.jsx は spanLabelOf: id => mode.equipmentSpanLabel(id), を1行まるごとの形でbuildEquipmentTabEntriesへ渡す', () => {
  assert.match(src, /^\s*spanLabelOf: id => mode\.equipmentSpanLabel\(id\), currentFloorLabel: floorName \?\? '',\s*$/m,
    "spanLabelOf: id => mode.equipmentSpanLabel(id), currentFloorLabel: floorName ?? '', が1行まるごとの形で見つからない");
});
