# Undo/Redoの設計意図

スタック実装・APIは`undoManager.js`を読めば分かるため省略する。

## push制・グローバル1本（不変条件）
undoは「`undoManager.push`されたものだけ」戻せる。**graphを変える操作・モード境界処理は必ずエントリを積む**こと。履歴ナビゲーション（下記）はモード切替時の境界同期（部屋再解釈・壁生成・エッジ同期）を再実行しない——それら自体が履歴に積まれている前提のため、積み漏れた変更は「またぎundo」で欠落・二重適用として現れる。

## スナップショット方式は2種類（使い分け）
- **plain object**（`snapshotRoomsState`/`snapshotEdges`/`snapshotWall`/`finish/finishUndo.js`）: 単発操作の巻き戻し用。差分判定はJSON比較。FlatBuffers化はしない（実装方針1の「データ入替え」には該当しない）。
- **Uint8Array（serializeGraph）**: 復元先のgraphオブジェクトが生存保証されない場合（非アクティブ階・階追加）。復元はその階がアクティブなら`restoreGraph`、非アクティブなら`saveFloor`でIDBへ書き戻す——`peek`がキャッシュを持たず毎回IDBから読むことに依存する（`.claude/persistence-idb.md`）。

## モード・フロアまたぎは「先に表示を合わせてから実行」
各エントリはpush時のコンテキスト`{mode, planeId}`を持つ（`undoManager.contextProvider`、App.jsxが設定）。実行前にコンテキストが現在と違えば表示をそこへ戻してから実行する（`performUndo`/`switchHistoryContext`）。この切替は**素の切替**（境界同期なし）——履歴の再生はエントリのundo/redoだけで完結させる。構造モードのみ例外で、離脱＝図面合成バインディング停止・復帰＝図面合成再構築を伴う（自動補完は決定的・冪等で履歴を汚さない）。
フロア切替はIDBから**同一graphオブジェクト**へ復元されるため、エントリが握るgraph参照は切替後に再び有効になる（これがフロアまたぎundoの成立条件）。

## 確定が非同期な付随変更はamendで同一エントリへ合成する
階段変換→上階自動設置のように操作の後から非同期で確定する変更は、新規エントリにせず`undoManager.amend`で元エントリへ合成する（Ctrl+Z 1回で揃って戻る）。

## 「作成→ダイアログ確定」は1エントリ、キャンセルはエントリなし
仕上げモードの新規部屋はcommitDrag（作成）時点ではpushを保留し（`_pendingDialogUndo`）、applyNaming（確定）で作成＋命名を1エントリにする。キャンセル・ダイアログからの即削除は作成と相殺して差分ゼロ＝積まない。部屋統合（判定2）だけはキャンセルしても残る仕様のため即時push。

## 階追加は「全採用フロアのbefore/afterバイト列比較」で1エントリ
plane作成・新階同期・切替・全階の構造再計算が複数階へ波及するため、逆操作ではなく前後比較で記録する（`withFloorAddUndo`）。redoは**同一planeId**でplaneを再作成してbytesを書き戻す（IDが変わると以降のundo/redoサイクルとIDBキーが壊れる）。フロー内の構造再計算は個別pushを抑止する（二重記録防止。`recomputeActiveStructural(pushUndo=false)`）。

## undo対象外（意図的な割り切り）
- `ensureTopStairVoid`・`syncUpperFloorsAuto`単体（階追加経由は階追加エントリが包含）: 冪等なデータ修復・自動同期
- `syncRoofPlane`・構造モード突入時の自動補完: 建物形状が変われば作り直す冪等インフラ
- 編集可能peek（構造モードの下階柱編集）のgraphを対象にした変更: 復元先が使い捨てで履歴ナビでも復活しない

## 落とし穴
- undo/redo内のフロア切替・IDB書き込みは非同期の投げ放し。連打は`historyNavRef`で弾き、切替中に履歴が動いた場合はpeek再照合で実行を中止する。
- 自由入力フィールドはキーストロークではなくフォーカス〜ブラーで1エントリ（`beginFieldUndo`/`endFieldUndo`）。onChange単位でpushを足さないこと。
