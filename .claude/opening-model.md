# 建具モードの設計意図

建具・窓の追加・編集は専用モード（`appMode==='opening'`）＋右パネルで行う。フィールド一覧・関数シグネチャはソース（`openings/*.js`）を読めば分かるため省略する。

## 建具記号はfixtureTypeの意味拡張——別フィールドを作らない
`Opening.fixtureType`は元々「窓の材質記号」（`AW`/`JW`）だったが、「建具記号（材質×種別）」へ意味を拡張して`AD`/`SD`/`WD`/`SW`を追加した。既存FBS enum値（`AW=1`/`JW=2`）は温存し追記のみで拡張している（`.claude/serialization-fbs.md`の末尾追加ルール）。新規フィールドを増やさないことで、モデル層に「建具記号」概念を二重に持たない。

## 番号は導出のみ・永続化しない——境界にundoが不要な理由
`project.openingNumberIndex`は建物状態から毎回導出される非永続キャッシュ（`memberNumberIndex`と同格）。entityへ番号を書き戻さないため、モード境界（`opening`の`enter`）はgraphを一切変更しない。`.claude/undo-redo.md`の不変条件「graphを変える境界処理は必ずundoエントリを積む」に抵触せず、FBSスロット追加・他階書き戻し・モード境界のundo問題がすべて生じない。

## countsはplaneIdキー——階削除時にindexを丸ごと捨てる不変条件
採番グループの`counts: Map<planeId, number>`は生存階のplaneIdのみを鍵に持つ。階削除でそのplaneIdの寄与が残るとゴーストグループが消えず番号が欠番のまま固定化するため、`store.js`の`removeFloor`は`clearMemberNumberIndex`と並べて`clearOpeningNumberIndex`を呼ぶ（次のモード境界の反映パスで正しく再収集される）。

## 階プレフィックスを付けない——AW-1 vs C1の書式差
構造部材の採番（`structural/memberNumbering.js`）は出現階が記号内で不揃いなら`2F-C1`のように階プレフィックスを付ける。建具はその逆で、採番は常に全階統一（`記号-連番`のみ）——同じ`AW-1`はどの階にあっても同一仕様を指す（建具表の慣習）。手動タグ台帳（構造の`memberGroupLedger`相当）も持たない。同一仕様（`openingSignature`）の判定は幅・高さ・窓台高さ・種別・記号のみで行い、階は無関係。

## height<=0（null/0/負値）は不正値としてカタログ既定にフォールバックする
`Opening.height`は物理的に0mm以下があり得ない（窓台高さ`sillHeight`と違い、0mmが正当な値になるケースが無い）。FBS（`graphFbs.js` OP.HEIGHT）は「0=未設定」を既存の規約として持つため、この規約を負値にも広げてモデル層全体に一本化する——`openings/openingNumbering.js`の`effectiveHeight`は`h>0`を明示チェックし、UIを経由しない経路（復元データ・直接代入）からの負値混入でも姿図（rectの高さ）が壊れないよう防御する。入力側（`OpeningEditor.jsx`の幅・高さ・位置・図上dim編集）は数値入力を絶対値化して確定する（`openingCatalog.js`の`parseSillHeight`と同じ変換規約に統一。窓台高さ0mm=掃き出し窓とは異なりheightの0/負値は常に無効）。
