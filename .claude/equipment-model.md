# 昇降機（EV／エスカレーター／DW）の設計意図

クラス・フィールドの一覧は`finish/equipment/`配下・`core/equipment.js`を読めば分かるため省略する。用語は`.claude/glossary.md`参照。

## 用語の階層: 昇降機が親、分類が子
昇降機は建築基準法上の総称で、その中にEV／エスカレーター／DWがある（並列の選択肢ではない）。部屋の属性（`RoomFeature.ELEVATOR_EQUIPMENT`）は1つだけ、分類（器具行の`category`）が子。属性の意味で「EV」を識別子・テスト名・コメント・文書に使わない（器具・記号としてのEVは可）。エスカレーターは分類上は昇降機だが、性質は階段に近い別物（未対応）。

## 器具行が単位、昇降路Roomは入れ物（不変条件I1）
器具＝EV等1基（`EquipmentRow`。`core/equipment.js`）。昇降路＝器具が占めるセル集合のRoom。設置階＝その器具の行が存在する最下階で、保存せず行の存在から都度導出する——階削除に特別な処理が要らない理由はこれ（下記「階追加・階削除」参照）。不変条件I1: 登録済み昇降路Roomのセルは、そのRoomを指す器具行のセルの和集合に等しく行どうしは重ならない。登録済みの昇降路は`referenceRoomIds`が常に空（部分指定にならない）。全階で成り立つ（テスト補助は`equipmentTestFixtures.js`の`assertShaftInvariant`）。

## 作れる入口は未指定セルだけ
`installEquipment`（`equipmentOps.js`）・`installOnUpperFloor`（`equipmentFloorPlan.js`）はいずれも`referenceRoomIds`を空で作る。部分指定を作る書込み箇所（部屋ドラッグ・部屋名ダイアログ・CL削除後の再解釈）は昇降路をすべて除外済み（`modes/FinishModeState.js`の`commitDrag`・`_roomExcludedStairKeys`、`finish/roomNamingOptions.js`の`featureOptionsForDialog`、`finish/roomReinterpret.js`の`isReinterpretExempt`）。壁生成（`finish/wallGeneration.js`の`isInteriorWallTarget`）の部分指定の例外は階段（`feature=STAIR`）だけで、昇降路には無い——この経路がすべて塞がったことを確認してから例外を無くした（先に消すと壁・柱を失う。team-lessons「作る導線を閉じたので経路が無くなった」参照）。昇降路の辺を担う意匠CLは削除できない（`roomReinterpret.js`）。旧データ（器具行の無い部分指定の昇降路）は「昇降路（未登録）」として機械器具タブから削除のみ可能。保存済みの壁は、その階で次に壁が再生成されるまで残る——`wallFreshnessKey`は部屋を除外条件で落とさず全部屋をそのまま鍵に写すため、この変更だけでは鍵は不一致にならず、読込み時の再生成（他階・構造脱出・文書読込みの境界）は走らない。次にその階が仕上げモードを脱出すると全削除され、部分指定の昇降路はもう対象に入らないため壁は再生成されず失う。

## 全階連動の手順
設置・削除・用途変更（`finish/equipment/equipmentFloorSync.js`の`runElevatorInstall`/`runElevatorRemoval`/`runElevatorUsageChange`）は、確定の前に全採用階を読む——中断（isStillValidの再確認に失敗・書込み世代の割込み等）なら状態を変えない。設置はダイアログの事前検証で拒否でき、拒否ならダイアログを開いたまま何も変えずに終える。削除・用途変更にはダイアログが無く（機械器具タブ・カードから直接実行）、行が無い・用途が同じ等はnoopで終える。他の階を先に保存し、アクティブ階は最後に`commitActive`で同期確定する。失敗・中断時は保存済みの階を巻き戻す（`rollbackSavedFloors`）。undoはアクティブ階のエントリへ合成する（`amend`）——上階への保存が無い延長・検討案の平面でも`project.equipmentIndex`・記号の再読込みのため合成する。書込み世代（`storage/floorWriteGeneration.js`）で他処理の割り込みを検知する。

## 階追加・階削除
階追加時（`App.jsx`の`syncNewFloorFromSource`）は、階段同期の後・外壁内側の部屋の自動追加の前に、直下の採用階の器具行を全行、id・分類・番号・用途そのまま複製する（`copyElevatorsToNewFloor`/`copyElevatorRowsToGraph`。採番し直さない）。衝突・区画できない行はその基だけスキップしてトーストで知らせる。新規undoエントリは積まない——階追加のundoエントリ（`withFloorAddUndo`）が新階のバイト列を丸ごと記録するため自然に含まれる。階削除（`App.jsx`の`runDeleteFloor`）は、削除する階の器具行idを削除前に読み（アクティブならメモリ上・非アクティブならpeek）、`removeFloor`の後は直下階の階段削除・階番号振り直しという既存の後始末をすべて終えてから、最後に全階から消えた器具があれば建物全体で番号を詰め直す（`renumberEquipmentAfterFloorRemoval`）——再採番が失敗しても既存の後始末は完了済みにするための順序。undoエントリは積まない（現行の階削除の扱いに従う）。

## 採番と記号
採用階の建物全体で分類ごとに番号を振る（`finish/equipment/equipmentNumbering.js`）。記号は分類内の順位から決まる（1基なら接頭辞のみ、複数なら接頭辞+順位）。他階の器具の一覧（`project.equipmentIndex`）は保存しないキャッシュで、undo・redo・階の増減の後に読み直す。

## ×と直下階の破線
直下階に描く上階の吹抜け・昇降路の破線（`finish/voidGeometry.js`の`visibleUpperVoidCrosses`）は、自階に同位置の吹抜け・昇降路が無いときだけ出す——昇降路は設置階〜最上階に同じシャフトが続くので、どの階にも破線が出ない（2026-10-01裁定。判定は自階の吹抜け・昇降路が占める全セルの矩形の和集合＝`ownVoidCellRects`と、セル境界CLの値どうしで行い、壁の有無・厚みに左右されない）。「昇降路にはラベルを付けない」（`showsUpperVoidLabel`）は従来どおり別ルールとして存続する。

## 上階への書込みの共通手順（階段と共有）
不足CLの追加・セルの対応付けは`finish/floorCLMap.js`（`collectNeededCLs`/`addMissingCLs`/`translateCellSet`）を階段（`finish/stair/stairFloorSync.js`）と共用する。昇降機だけ、不足CLの相手を「区画を割る線」（`isFinishCellDivider`）に絞る——上階の同じ座標に梁芯しか無い場合はそれを対応先とせず新しい中心線を足す（階段は種別を問わない）。上階へ足した中心線は設置階の線の範囲どおりで、器具を削除しても残る。

## 検討案の平面
`project.planes`（採用階）に含まれない自階だけが対象。設置・削除・用途変更・階削除時の再採番のいずれも、検討案がアクティブなときは採用階の処理の対象にせず、検討案の中での操作はその階だけで完結する（`renumberEquipmentAfterFloorRemoval`は`project.planes`に含まれるかどうかで判定し、検討案の行はカタログにも含めず番号も変えない）。複製すると同じidの行ができる。検討案を採用へ入れ替えると番号が食い違いうる（未対応）。

## 保存形式
`Room.feature`の書き出しは`elevatorEquipment`（9）固定。旧5〜8（属性に分類を並べていた頃のev/dw/freightEv/vehicleEv）は読込み時に昇降機へ読み替え、番号は再利用しない（`schema/graphFbs.js`の`ROOM_FEATURE_ENC`/`ROOM_FEATURE_DEC`）。器具行（`EquipmentRow`）は保存データの末尾に追加した。undoの方式は仕上げモードの他の操作と同じ2種類（`.claude/undo-redo.md`「スナップショット方式は2種類」参照）。

## 上階自動設置は部屋と中心線だけを書く（壁・梁芯は次の境界のsweepが担う）
`installOnUpperFloor`等の上階自動設置は部屋（昇降路Room）と中心線を書くだけで、壁・梁芯はその場では生成しない——`wallRefresh.js`の`hasNeverBuiltWalls`（sweep対象外ガード）が「部屋も壁も鍵も無い階」だけを対象外にするため、部屋がある限り次の境界（仕上げ脱出の他階・構造脱出・文書読込み等）の`refreshWallsAllFloors`で壁が立つ（2026-09-30再裁定。`.claude/data-model.md`「再生成の起動条件」参照）。構造未定でも開口由来梁芯（規則O）は出す（`structureRules.js`の`UNSPECIFIED_RULES.openingBeamAxes`。柱・梁は生成しない）。
EVが唯一の部屋である階で梁芯の幅が2000→2190に見えるのは不良ではなく、周壁が外壁になり、開口由来梁芯が外壁の下地帯中心（外壁面は通り芯±60固定。`.claude/structural-model.md`「外壁の面は通り芯±60に固定する」）へ寄るため——全階が壁を持てば全階同位置になる（Node実測: S造 ±95、構造未定 ±97.5）。
