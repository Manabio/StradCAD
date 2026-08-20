# IndexedDB永続化の設計意図

ストア構造・API関数シグネチャは`storage/db.js`/`storage/FloorSwapManager.js`を読めば分かるため省略する。

## openDBはPromiseをキャッシュする（結果ではなく）
複数箇所から並列にopenDBが呼ばれる。結果（`_db`）をキャッシュすると2回目呼び出し時に`_db`がまだnullで二重openが走る。Promise自体をキャッシュして共有すること。

## graph.clear()とgraph.clearFloorData()は別物——フロア切替には後者を使う
`clear()`はshapeMapごと完全初期化（restoreGraphの前処理用）。`clearFloorData()`はフロア切替専用で、`structGraph`経由の通り芯を消さない。

## auto-saveはdirtyフラグを立てるだけ、savedFloors/projects（保存ドキュメント）への確定書き込みはsaveToIDBと importDocument の2経路のみ
`_startAutoSave`/`_startStructAutoSave`のautorunは`markDirty`を呼ぶだけで何も書き込まない。`floors`（作業領域）へは`deactivate`等が無条件に書くが、`savedFloors`/`projects`（保存ドキュメント）への確定コピー・書き込みは、ハンバーガーメニュー「保存」が呼ぶ`saveToIDB`（内部で`saveNow`＋`commitFloorsToDocument`）と、文書ファイルの読み込み（`importDocument`＝全ストア消去後の丸ごと置換）の2経路のみ。敷地（`project.site`）も同様——`startSiteDirtyTracking`のautorunは`markDirty`するだけで、`projects`ストアへの確定書き込みは`saveToIDB`（`saveSiteData`）経由のみ。

## 通り芯・構造情報・タグ台帳はprojectレベルの別チャネルで永続化する
フロアと独立した建物全体データのため`floors`ストアとは別の`projects`ストアに保存する。フロア切替・スワップアウトの影響を受けない。

## projectsストアの同居レコード規約
`projects`ストアはkeyPath:projectIdの通り芯レコード本体に加え、`${projectId}:planes`（plane一覧）・`${projectId}:site`（敷地）・`${projectId}:info`（調査・計画情報＝敷地情報/建築情報ダイアログの入力値。FBSでなくUTF-8 JSON、`storage/projectInfo.js`参照）を別レコードとして同居させる。フロアと独立した建物全体データを新たに永続化する際は、新規ストアを作らずこの規約（`${projectId}:<種別名>`キー）に従う。

## floorsは「セッション作業領域」、savedFloors+projectsは「保存ドキュメント」
`deactivate`（階切替のスワップアウト）は明示保存の有無に関わらず`floors`へ無条件で書く——`floors`単独では「未保存の編集」と「保存済みの編集」を区別できない。区別を担うのは`savedFloors`（`commitFloorsToDocument`が明示保存時のみ確定コピー）で、起動のたびに`seedFloorsFromDocument`が`savedFloors`の内容で`floors`を必ず作り直す。これにより「前回セッションで階切替を経ただけの未保存編集」は起動時に消え、「明示保存した内容だけが次回起動で復元される」という一貫した意味論になる。

## 文書ファイル（.stq）＝保存ドキュメントの読み戻しを包んだもの
「保存」の`exportDocument`は、まず`saveToIDB`で保存ドキュメントを確定してから、その確定内容（savedFloors全件＋projectsの通り芯/plane一覧/敷地/調査・計画情報）をIDBから読み戻してJSONエンベロープ（`format:'stq-document'`、バイト列はbase64。調査・計画情報`info`のみ元がJSONのためオブジェクトのまま）に包む——**ファイルの中身＝次回起動で復元される内容**を常に一致させるための順序で、in-memoryから直接シリアライズしてはならない（非アクティブ階はスワップアウト済みでメモリに実体がない）。読み込み（`importDocument`）は検証を通してから全ストアを消去して書き込み、in-memoryへは反映せず`location.reload()`で通常のブート復元経路を再利用する（`resetAll`と同じ理由）。projectIdはファイルに保存せず現行タブのものを使い続ける。エンベロープをJSONにしたのは「開く」の先頭バイト判別（`{`=JSON）を変えずに旧形式（単一グラフFlatBuffers・旧JSONスナップショット→アクティブ階のみ復元）と共存させるため。構築・パースは純モジュール`storage/documentFile.js`（node:testから単体import可能に保つ）。

## セッションロック（storage/sessionLock.js）— 単一ライター、自動昇格なし
`openDB()`は冒頭で`isSessionOwner()===false`ならthrowし、以降の全読み書き（全公開関数がopenDB経由）をこの1箇所で塞ぐ。read-only編集・別タブ間の同期・マージは提供しない——マージ機構を持たないこのアプリでは、2つ目以降のタブに「別文書として振る舞う余地」を与えるより「1タブだけで編集」を強制する方が競合破損を避けられるという判断。ロック保持タブが閉じてロックが空いても、既存の非オーナータブが自動でロックを奪いに行くことはない（自動昇格なし）——再取得はユーザーの明示的なリロードのみ。Web Locks API非対応環境はフォールバックし、排他されない（現行動作を維持）。
