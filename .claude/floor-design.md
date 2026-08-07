# 階・Plane設計の意図

Planeのフィールド一覧・floorNumber.jsの関数シグネチャは`core/plane.js`/`floorNumber.js`を読めば分かるため省略する。

## データ帰属の境界線
通り芯（labeled struct CL）のみ全階共通（`projects` IDBストア）。中心線・補助線・寸法線・壁・図形・部屋は階固有（`floors` IDBストア）。Planeメタデータ（startFloor/stories/name/isRoofPlane等）自体はIDB非永続——セッション内メモリのみで、リロード後は初期1階のみ復元される。

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
