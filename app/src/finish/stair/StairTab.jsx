import { observer } from 'mobx-react-lite';
import { StairType } from '@core';
import { StairEditor } from './StairPanel.jsx';

const TYPE_LABEL = {
  [StairType.STRAIGHT]:         '直進',
  [StairType.STRAIGHT_LANDING]: '踊り場付直進',
  [StairType.SWITCHBACK]:       '屈折',
  [StairType.WINDING]:          '回り',
  [StairType.L_TURN]:           '矩折',
  [StairType.FLARED]:           '曲がり',
  [StairType.OPEN_WELL]:        '中空き',
};

// 仕上げパレットの「階段」タブ — 階段一覧＋選択中の階段パラメータ編集。
export const StairTab = observer(({ graph, mode, project }) => {
  const stairs = graph.stairs;
  const selected = mode.selectedStairId ? graph.stairMap.get(mode.selectedStairId) : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {stairs.length === 0 ? (
        <div style={{ padding: 16, fontSize: 13, color: '#64748b', lineHeight: 1.6 }}>
          階段はありません。エリアをドラッグし、部屋名ダイアログで「階段」を選ぶと作成できます。
        </div>
      ) : (
        <div style={{ padding: 8, borderBottom: '1px solid #e2e8f0' }}>
          {stairs.map((s, i) => (
            <button
              key={s.id}
              onClick={() => mode.selectStair(s.id)}
              style={{
                display: 'block', width: '100%', textAlign: 'left',
                padding: '6px 10px', marginBottom: 4, borderRadius: 6, cursor: 'pointer', fontSize: 13,
                border: s.id === mode.selectedStairId ? '1px solid #2563eb' : '1px solid #e2e8f0',
                background: s.id === mode.selectedStairId ? '#eff6ff' : '#fff',
              }}
            >
              階段{i + 1}（{TYPE_LABEL[s.type] ?? s.type}）
            </button>
          ))}
        </div>
      )}
      {selected && <StairEditor stair={selected} project={project} onDelete={id => mode.deleteStair(id)} />}
    </div>
  );
});
