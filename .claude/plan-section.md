# 平面の断面解決（立体＋水平切断）

平面図を「立体を高さ範囲つきで持ち、水平切断で分類する」考え方で描く移行計画。段階 S1〜S7。

## S1: 階の属性「平面の切断高」
- 切断高は **Plane の属性**（`planCutHeightMm`、FL+mm、既定 1500）。建物一律の定数ではなく階ごとに持つ（ユーザー裁定 2026-10-08 (b)）。既定値は従来の `finish/kneeDropWall.js PLAN_CUT_HEIGHT` と同値で、S1 は動作変化なし。
- 読み口は **`planCutHeightMmOf(plane)` 唯一**。0・負・非数・欠落は既定へ倒す。新規コードは Plane のフィールドを直接読まず、`PLAN_CUT_HEIGHT` も使わない（後者は既定値の別名として残すだけ）。
- 旧データ（FBS にフィールドが無い）は既定値。FBS は 0 を「未設定」として省略するので、読み側の `|| 既定` と対になる。
- 階追加時は**複製**する（途中階挿入・下階追加は表示中の階、検討案の作成・案コピーは複製元の平面の値。屋根専用平面は構造モード専用で切断高を読まないため既定のまま）。
- 変更は階チップのメニュー「切断高」から。undo は Plane メタの書き戻し（`floorOps.setPlanCutHeightMm` → `applyPlaneMetas`）で、`planCutHeightMm` が undefined のメタは値を触らない。Plane メタは自動 dirty 追跡の対象外なので変更時に `markDirty()` を明示する。
- 腰壁・垂れ壁の天板輪郭の判定（`resolveKneeDropOverlays`）は階の値を読む。graphComputed 経由でも Plane は observable のため再計算される。

## 注意
- 切断面に関わる他の箇所は、S2 以降で立体モデルへ寄せる際に階の値（`planCutHeightMmOf`）を読む形へ揃える。
