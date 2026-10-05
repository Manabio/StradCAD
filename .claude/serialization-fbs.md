# FlatBuffersシリアライズの境界線

正確なフィールド一覧は`schema/graphFbs.js`が単一の正（読めば分かる）。ここには変更時に必ず守るべき境界線のみ記す。

## フィールドindexは位置的な契約——既存indexの再利用・並び替え禁止
新しいフィールドは必ず末尾に追加する。既存indexを別の意味に転用したり欠番を詰めたりすると、保存済みデータ（IndexedDB・エクスポート済みファイル）の復元が壊れる。

## GraphSnapshotは1つのルートテーブルをper-floor/project-levelで共有する
フィールド集合は互いに重複しない前提（per-floor用フィールドはproject blobで常に空、逆も同様）。新しいproject全体データを追加する場合もこの使い分けを維持する。

## サブタイプ別フィールドはJSON.stringify/parseを使わずkeys[]/vals[]のペア配列で表現する
`structural/fieldPacking.js`の`packExtraFields`/`unpackExtraFields`が規約。1段ネストはドット記法キーでフラット化する。

## restoreGraphは復元順序に依存する箇所がある
CL→壁→開口→部屋→境界エッジ等の順で解決する。新しいテーブルを追加する際は`applySnapshot`の既存ステップ順と参照関係を確認すること。

## decode入力はUint8Array/ArrayBuffer/plain object（旧JSON、後方互換）の3形態を受理する
ファイル先頭バイトが`0x7B`('{')ならJSONテキストとして扱う。新規コードでJSON経路を追加しない。

## 列挙フィールドを利用者の拡張に開くときは列挙を広げず文字列フィールドを足す
列挙に無い値のときだけ末尾に追加した文字列フィールドへ書く（例`OP.FIXTURE_TYPE_STR`）。既存バイトは不変（既知の値は省略）、読むときは文字列優先、旧ビルドは既定値に落ちる。

## Roomの屋根の仕様（`RM.ROOF_SPEC`→`RS`テーブル）はfeature=roofの部屋だけが持つ
屋根でない部屋はフィールド自体を書かない（屋根の無い文書のバイト列は不変）。`RS`の項目集合は`core/roofSpec.js`の`ROOF_SPEC_KEYS`が唯一の定義で、読み書きは plain の`toData()`形をそのまま通す。`HIGH_SIDE=9`（片流れの高い側）・末尾の`RIDGE_DIRECTION=10`（切妻の棟木の向き）は文字列で、null（自動）のとき文字列もフィールドも書かず、読みは無ければnull（旧データ・使わない文書のバイト列は不変）。`COLUMN_THROUGH=11`（柱貫通）はint8でtrueのときだけ書き、無ければ読みはfalse（同じくバイト列は不変）。形状null（自動）は空文字、出幅0は正当な値なのでHASフラグを持たず読み側で既定へ読み替えない（正規化は復元側の`RoofSpec.fromData`）。

## 主屋根（`GS.MAIN_ROOF_SPEC=53`→同じ`RS`テーブル）は既定値のとき書かない
最上階の階ごと設定（`PlanGraph.mainRoofSpec`）。`graphSnapshot.buildSnapshot`が`isDefaultRoofSpec`で既定値なら`null`にし、`encode`は`null`のとき何も書かない（フィールド自体を省く）ので、主屋根を編集していない文書のバイト列は1バイトも変わらない（読み側は無ければ`restoreGraph`の`clear()`の既定値）。`RS`の読み書きは下屋と共用（`writeRoofSpec`/`readRoofSpec`）。
