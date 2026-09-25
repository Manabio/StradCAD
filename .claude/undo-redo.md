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

## amendの落とし穴: notifyを伴うエントリはamendを使わない（段階(c)・2026-09-25、CL偏芯=段階(e)・2026-09-26）
`undoManager.amend`はredo=「元の操作→追加分」・undo=「追加分→元の操作」の順で合成するため、構造同期（`structuralSync.js`）へのnotifyのような「他の状態がすべて確定してから最後に呼びたい」処理を追加分・元側のどちらに置いても順序が崩れる——notifyを元側（先発エントリ）に入れるとredo時に他階save（追加分）より先に同期が走り、追加分（amendされた側）に入れるとundo時にstructGraph・自階の復元（元側）より先に走る。`transform/centerLineOps.js`の`promoteCenterToGridWithUndo`/`demoteGridToCenterWithUndo`（通り芯⇔中心線の変換）は、この理由で`amendFloorUndoRecords`（内部で`undoManager.amend`を呼ぶ）を使わず、他階レコードの適用（`applyFloorUndoRecords`）を`structGraph`・自階の復元と**同じundo/redoクロージャの中**に、notifyの**直前**として組み込むinline方式にする（順序: struct復元→自階復元→他階レコード適用→notify）。昇格（`recallPromotedCenterLineDuplicates`）は「push→await回収」の構造を保つため、`undoEntry`（amend用）の代わりに`undoRecords`（配列参照。クロージャ実行時点の中身を読む）を渡す——`propagateDemotedCenterLine`と同形の「beforeを常に採ってpush」規約にする。CL偏芯（`applyCLEccentricityWithUndo`）も同じ理由で`finish/eccentricityFloorSync.js`の`propagateCLEccentricities`をamend廃止・`undoRecords`配列方式へ切り替えた（下記節参照）。**ASSUMED**: IDBトランザクション順序（save呼び出しが同じクロージャ内でnotifyより前にあることに依存。readwriteの後に作られたreadonlyは完了を待つIDB仕様に依存）は実機のIndexedDBでは未確認（node:testの`storage/db.js`スタブでのみ検証済み）。

## CL偏芯は適用＋梁芯追従＋他階連動を1エントリ（inline・whenIdle先行。段階(e)・2026-09-26）
`transform/centerLineOps.js`の`applyCLEccentricityWithUndo`は、偏芯の適用（`finish/clEccentricity.js`）・自階の壁由来梁芯の追従（`followWallBeamAxes`）・他階連動（階段・吹抜け。`finish/eccentricityFloorSync.js`）を1つのundoエントリへ、上記amendの落とし穴と同じinline方式でまとめる——自階を先に変更してから他階連動をawaitする構造のため、連動が失敗した・awaitの間にアクティブ階が切り替わった場合は自階分も含めて巻き戻す（`rollbackFloorRecords`に自階の`{planeId, before}`を明示的に加える）。App.jsxの`handleEccConfirm`はUndo/構造判定を一切持たず、削除・入替えと同型で「`structuralSync.whenIdle()`を待ってから呼ぶだけ」に薄くする。

## 中心線移動は「bake＋結合連鎖＋梁芯追従」を1エントリにまとめる（段階(b)・2026-09-25）
`transform/centerLineOps.js`の`commitCLMoveOp`は、CL値の確定（`bakeCLValue`）・隣接CLとの結合（`mergeCenterLineChain`）・壁由来梁芯の追従（`followWallBeamAxes`）を、同期処理のまま1つの`undoManager.push`エントリにまとめる（`composeUndoWithMergeChain`が結合分を合成し、`followWallBeamAxes`が返す`undoFns`/`redoFns`をさらに合わせて実行する——undo時は「梁芯追従を先に戻す→CL値・結合を戻す」、redo時は逆順）。構造同期リスナー（`structuralSync.js`起動）へのnotifyは、確定・undo・redoそれぞれのクロージャの**最後**で呼ぶ——CL値・壁位置が確定してから構造再計算を起動する順序を守るため。

## 「作成→ダイアログ確定」は1エントリ、キャンセルはエントリなし
仕上げモードの新規部屋はcommitDrag（作成）時点ではpushを保留し（`_pendingDialogUndo`）、applyNaming（確定）で作成＋命名を1エントリにする。キャンセル・ダイアログからの即削除は作成と相殺して差分ゼロ＝積まない。部屋統合（判定2）だけはキャンセルしても残る仕様のため即時push。

## 階追加は「全採用フロアのbefore/afterバイト列比較」で1エントリ
plane作成・新階同期・切替・全階の構造再計算が複数階へ波及するため、逆操作ではなく前後比較で記録する（`withFloorAddUndo`）。redoは**同一planeId**でplaneを再作成してbytesを書き戻す（IDが変わると以降のundo/redoサイクルとIDBキーが壊れる）。フロー内の構造再計算は個別pushを抑止する（二重記録防止。`recomputeActiveStructural(pushUndo=false)`）。

## undo対象外（意図的な割り切り）
- `ensureTopStairVoid`・`syncUpperFloorsAuto`単体（階追加経由は階追加エントリが包含）: 冪等なデータ修復・自動同期
- `syncRoofPlane`・構造モード突入時の自動補完: 建物形状が変われば作り直す冪等インフラ
- 編集可能peek（構造モードの下階柱編集）のgraphを対象にした変更: 復元先が使い捨てで履歴ナビでも復活しない
- 読込み時の壁再生成（`wallRefresh.js`の`refreshWallsAllFloors`。壁の再生成をFinishModeStateから独立させる計画のステップ5）: `store.js`の`bootReady`が文書読込み直後に鍵不一致の階だけ壁を作り直す自動修復。undo対象外だが、変更があれば`markDirty()`してdirtyにする（保存すれば鍵も保存され次回は走らない。鍵一致で何も変わらなければdirtyにしない）
- カタログの変換先指示UIの適用（`store.js`の`applyCatalogResolutions`。アクティブ階の往復のみ）: `markDirty()`のみでundoエントリは積まない
- カタログ保守パネルの編集・戻す・削除（ライブラリはアプリ単位で履歴の外。同梱を外す／写すときはmarkDirtyのみ）
- 構造同期（`structural/structuralSync.js`。建具の確定・undo/redo直後の自階再計算に加え、通り芯削除の直後・undo/redo直後の反映も同じ経路。2026-09-25一般化）: 決定的・冪等なため、要求元側のundo/redoで再実行されれば結果的に元へ戻る。ここで別途undoエントリを積むと、その復元手段（restoreGraph）がgraph上のインスタンス（建具のOpening等）を丸ごと差し替え、要求元側のundo/redoクロージャが握る参照が古くなる。通り芯削除では、他階への**detach伝播**（`transform/centerLineFloorSync.js` `propagateGridCenterLineDeletion`）はundo対象だが、他階の**構造反映**自体はこの規律どおりundo対象外——「壁位置の確定」と「そこから導く構造」を別の扱いにする線引き。
- 中心線削除の**壁由来梁芯の道連れ削除**（`transform/centerLineOps.js`。ユーザー承認済み例外・2026-09-25。`.claude/structural-model.md`「壁由来梁芯の道連れ削除」参照）は上記の構造同期とは別物——別ライフサイクルの後追い処理ではなく、中心線削除本体と同じ`runInAction`内でグラフを直接変更し、同じ`before`/`after`スナップショット（`serializeGraph`）に写り込む。そのため専用のundo登録は不要で、中心線削除エントリ自体のundo/redoでそのまま一緒に戻る。

## 落とし穴
- undo/redo内のフロア切替・IDB書き込みは非同期の投げ放し。連打は`historyNavRef`で弾き、切替中に履歴が動いた場合はpeek再照合で実行を中止する。
- 自由入力フィールドはキーストロークではなくフォーカス〜ブラーで1エントリ（`beginFieldUndo`/`endFieldUndo`）。onChange単位でpushを足さないこと。
- 構造同期（`structuralSync`）はfire-and-forget。active graphを丸ごと読む・差し替える処理（階切替・モード境界・履歴コンテキスト切替・階追加・保存・通り芯削除）は先に`structuralSync.whenIdle()`を待つこと。
- 他階のIDBを読み書きするCL操作（通り芯削除・中心⇔通り芯の入替え）も、開始前に`structuralSync.whenIdle()`を待つこと（実行中の反映が他階のfloorsを読み書きしている最中に競合する）。
- 通り芯を他階からpeekして参照を切り離す処理は、`project.structGraph`からその通り芯を除く**前**に行うこと——`graphSnapshot.js`の`resolveCL`は解決できない参照を黙って捨てるため、先に除いてしまうと他階の壁がpeek→復元の往復で消える（`propagateGridCenterLineDeletion`のJSDoc参照）。
