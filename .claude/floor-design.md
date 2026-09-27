# 階・Plane設計の意図

Planeのフィールド一覧・floorNumber.jsの関数シグネチャは`core/plane.js`/`floorNumber.js`を読めば分かるため省略する。

## データ帰属の境界線
通り芯（labeled struct CL）のみ全階共通（`projects` IDBストア）。中心線・補助線・寸法線・壁・図形・部屋は階固有（`floors`/`savedFloors` IDBストア）。Planeメタデータ（startFloor/stories/name/isRoofPlane等）一覧は`projects`ストアの別レコード（`graphSnapshot.js`のserializePlanes/decodePlanes）として明示保存（保存メニュー）時のみ永続化され、起動時に`floorOps.js`のreconcilePlanesで復元される——保存していないplaneの追加・削除・改名はリロードで失われる。

## elevation昇順 = startFloor昇順は不変条件
採用フロアは常にこの対応が成立するよう、追加・削除・並び替え・階変更のたびに連鎖再計算する。崩れるとFloorTabsの表示順と階数表記が食い違う。

## 屋根専用平面（isRoofPlane）はproject.planes/orderedTabsから除外される
構造モード専用の合成平面で、`project.roofPlane`から個別にアクセスする。フロアプラン・仕上げモードのタブには現れない。最上階が変わるとデータは作り直しになる（古い屋根平面は削除される）。

## 構造モード中のフロア切替はappModeをリセットしない
通常の`handleFloorSwitch`は`appMode`を`'floorplan'`に戻すが、構造モード中にフロアタブ（屋根タブ含む）をクリックした場合は`handleStructuralFloorSwitch`を使い`appMode==='structure'`を維持する。`FloorTabs`の`onSwitch`はappModeで両ハンドラを切り替える。

## フロア切替後はproject.activeGraphを直接読み直す
`switchFloor`はIDBスワップを伴うasync処理。完了直後にイベントハンドラのローカル変数`graph`（render時点のクロージャ）を使うと古いフロアを指してしまう。

## 構造モードの図面呼称はフロアタブのラベル自体を書き換える
別枠のタイトル表示は持たない。`computeStructuralDesignation`の判定木は自階基準（タブ番号と図面呼称の番号を一致させるため）。最下階は視点に関わらず常に基礎伏図。

## 切替の関門と先読み＋同期確定（2026-09-27）
これは入力の関門（`uiBusy.js`）の1利用例——階切替・モード切替・undo/redo（App.jsxの5経路）に加え、CL削除・入替え・偏芯・出幅編集・移動準備（`FloorplanModeState.startMove`内）も同じ関門に入る（入力規制ステップ3・2026-09-28）。以後保存・階操作も同じ関門に入る予定。各経路は`uiBusy.js`の`runBusy`という共通の関門を必ず通る——本体を丸ごと包み、`isUiBusy()`が真の間はポインタ・キー入力を塞いで同フレーム連打を防ぐ。関門自体は排他制御（mutex）を持たない薄い深さカウンタで、入れ子（undo内の`switchHistoryContext`が`switchFloor`を呼ぶ等）は深さで自然に処理する。関門に入る直前の中断（`resetGestureRefs`）は長押しタイマー（`useLongPress`の`abort()`）の停止を含む——ref を戻すだけでは setTimeout が関門の中で発火してしまう（入力規制ステップ4・2026-09-28）。

`store.js`の`switchFloor`は関門の中で`FloorSwapManager.swap`を呼ぶ。`swap`の不変条件は3つ:
- **中間状態を観測者に見せない**——次階の復元・現階のクリア・アクティブ切替を1つの`runInAction`で同期確定する。「アクティブ階だけ切り替わって中身がまだ空」「中身は復元済みだがアクティブ階が古いまま」のどちらも一度も観測されてはならない（崩れると`renderer/gutterLabelHits.js`のようにフロア切替中の一瞬だけ空データを描画する箇所が事故る）。
- **失敗時は現階を巻き込まない**——保存・読込みの失敗／安定しない／復元先の壊れたバイト列のいずれも、現階を元の内容のまま・アクティブも変えずauto-saveを再開してrethrowする。
- **次階への横からの書込みを世代で検知する**——`floorWriteGeneration`で次階の読込み内容が最新かどうかを確認し、割り込みがあれば読み直す。
