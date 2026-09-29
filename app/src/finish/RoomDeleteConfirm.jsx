import { observer } from 'mobx-react-lite';
import { ConfirmDialog } from '../ui/ConfirmDialog.jsx';

// 部屋削除の確認ダイアログ（内部タブのカード・外部タブの屋外部屋の群・機械器具タブの
// 未登録の昇降路（行を持たない旧データのRoom）で共通。QA指摘2026-09-29:
// 逐語複製だった確認ダイアログを1箇所へ集約。finish/FinishTable.jsx から finish/equipment/
// EquipmentTab.jsx でも使うため独立ファイルへ切り出した——react-refresh/only-export-components
// を避けるため、.jsx のローカル関数宣言のまま別ファイルからexportし直さない）。
// deleteConfirm={roomId, roomName}|null。onSelect後は確認・キャンセルどちらでも onClose() を呼ぶ
// （呼び出し側の deleteConfirm state を戻す）。
export const RoomDeleteConfirm = observer(({ graph, mode, deleteConfirm, onClose }) => {
  if (!deleteConfirm) return null;
  const childCount = graph.rooms.filter(r => r.referenceRoomIds.has(deleteConfirm.roomId)).length;
  const suffix = childCount > 0 ? `（部分指定${childCount}件も削除されます）` : '';
  return (
    <ConfirmDialog
      message={`「${deleteConfirm.roomName || '（名称未設定）'}」を削除しますか？${suffix}`}
      buttons={[
        { label: 'キャンセル', value: 'cancel' },
        { label: '削除', value: 'ok', danger: true },
      ]}
      onSelect={value => {
        if (value === 'ok') mode.deleteRoom(deleteConfirm.roomId);
        onClose();
      }}
    />
  );
});
