# IndexedDB永続化の設計意図

ストア構造・API関数シグネチャは`storage/db.js`/`storage/FloorSwapManager.js`を読めば分かるため省略する。

## openDBはPromiseをキャッシュする（結果ではなく）
複数箇所から並列にopenDBが呼ばれる。結果（`_db`）をキャッシュすると2回目呼び出し時に`_db`がまだnullで二重openが走る。Promise自体をキャッシュして共有すること。

## graph.clear()とgraph.clearFloorData()は別物——フロア切替には後者を使う
`clear()`はshapeMapごと完全初期化（restoreGraphの前処理用）。`clearFloorData()`はフロア切替専用で、`structGraph`経由の通り芯を消さない。

## auto-saveはdirtyフラグを立てるだけ、実書き込みはsaveNow経由のみ
ハンバーガーメニュー「保存」が呼ぶ`saveNow`が唯一の確定書き込み経路。autorunのdebounce保存とは役割が異なる。

## 通り芯・構造情報・タグ台帳はprojectレベルの別チャネルで永続化する
フロアと独立した建物全体データのため`floors`ストアとは別の`projects`ストアに保存する。フロア切替・スワップアウトの影響を受けない。
