// 下屋の平面表示（ステップ1・裁定2026-10-04「屋根の室名は隠す」）: renderer/RoomLabelsLayer.jsx が室名ラベルを出す判断を
// 純モジュール finish/roomLabel.js の showsRoomNameLabel に任せている（jsx は feature を直接見ない）ことを、
// ソーステキスト検査で固定する（.jsx は node:test から単体 import できないため。VoidLayer.wiring.test.js と同じ型）。
// コメントを除いた本体に対し、m フラグの行頭・行末アンカーで1行まるごと照合する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function stripComments(text) {
  const withoutBlockComments = text.replace(/\/\*[\s\S]*?\*\//g, '');
  return withoutBlockComments.split(/\r?\n/)
    .filter(line => !line.trim().startsWith('//'))
    .join('\n');
}
const codeOnly = stripComments(fs.readFileSync(path.resolve(import.meta.dirname, 'RoomLabelsLayer.jsx'), 'utf8'));

test('【配線】RoomLabelsLayer は室名ラベルを if (!showsRoomNameLabel(room)) return null; で出し分ける（1行まるごと・room.name 直読みの経路を残さない）', () => {
  assert.match(codeOnly, /^\s*if \(!showsRoomNameLabel\(room\)\) return null;\s*$/m, 'if (!showsRoomNameLabel(room)) return null; が1行まるごとの形で見つからない');
  assert.match(codeOnly, /^\s*import \{ showsRoomNameLabel \} from '\.\.\/finish\/roomLabel\.js';\s*$/m);
  assert.equal((codeOnly.match(/showsRoomNameLabel\(/g) || []).length, 1, '呼び出しはこの1箇所');
  assert.equal((codeOnly.match(/if \(!room\.name\)/g) || []).length, 0, 'if (!room.name) で出し分ける経路が残っていない');
  assert.equal((codeOnly.match(/\bfeature\b/g) || []).length, 0, 'jsx は feature を直接見ない（判断は純モジュール）');
});
