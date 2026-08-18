# IndexedDB永続化の設計意図

ストア構造・API関数シグネチャは`storage/db.js`/`storage/FloorSwapManager.js`を読めば分かるため省略する。

## openDBはPromiseをキャッシュする（結果ではなく）
複数箇所から並列にopenDBが呼ばれる。結果（`_db`）をキャッシュすると2回目呼び出し時に`_db`がまだnullで二重openが走る。Promise自体をキャッシュして共有すること。

## graph.clear()とgraph.clearFloorData()は別物——フロア切替には後者を使う
`clear()`はshapeMapごと完全初期化（restoreGraphの前処理用）。`clearFloorData()`はフロア切替専用で、`structGraph`経由の通り芯を消さない。

## auto-saveはdirtyフラグを立てるだけ、savedFloors/projects（保存ドキュメント）への確定書き込みはsaveToIDB経由のみ
`_startAutoSave`/`_startStructAutoSave`のautorunは`markDirty`を呼ぶだけで何も書き込まない。`floors`（作業領域）へは`deactivate`等が無条件に書くが、`savedFloors`/`projects`（保存ドキュメント）への確定コピー・書き込みはハンバーガーメニュー「保存」が呼ぶ`saveToIDB`（内部で`saveNow`＋`commitFloorsToDocument`）経由のみ。

## 通り芯・構造情報・タグ台帳はprojectレベルの別チャネルで永続化する
フロアと独立した建物全体データのため`floors`ストアとは別の`projects`ストアに保存する。フロア切替・スワップアウトの影響を受けない。

## floorsは「セッション作業領域」、savedFloors+projectsは「保存ドキュメント」
`deactivate`（階切替のスワップアウト）は明示保存の有無に関わらず`floors`へ無条件で書く——`floors`単独では「未保存の編集」と「保存済みの編集」を区別できない。区別を担うのは`savedFloors`（`commitFloorsToDocument`が明示保存時のみ確定コピー）で、起動のたびに`seedFloorsFromDocument`が`savedFloors`の内容で`floors`を必ず作り直す。これにより「前回セッションで階切替を経ただけの未保存編集」は起動時に消え、「明示保存した内容だけが次回起動で復元される」という一貫した意味論になる。
