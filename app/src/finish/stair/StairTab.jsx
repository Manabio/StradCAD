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

const rowStyle   = { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 };
const labelStyle = { fontSize: 12, color: '#475569', width: 64, flexShrink: 0 };
const valueStyle = { fontSize: 13, color: '#0f172a' };

// 仕上げパレットの「階段」タブ — 階段一覧＋選択中の階段パラメータ編集。
// 直下階の階段（見下げ）も一覧に含め、選択時は読み取り専用で表示する。
export const StairTab = observer(({ graph, mode, project }) => {
  const stairs = graph.stairs;
  const lowerStairs = mode.lowerStairs ?? [];
  const selectedId = mode.selectedStairId;
  const selectedSelf = selectedId ? graph.stairMap.get(selectedId) : null;
  const selectedLower = !selectedSelf && selectedId
    ? lowerStairs.find(e => e.stair.id === selectedId)?.stair ?? null
    : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {stairs.length === 0 && lowerStairs.length === 0 ? (
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
                border: s.id === selectedId ? '1px solid #2563eb' : '1px solid #e2e8f0',
                background: s.id === selectedId ? '#eff6ff' : '#fff',
              }}
            >
              階段{i + 1}（{TYPE_LABEL[s.type] ?? s.type}）
            </button>
          ))}
          {lowerStairs.map(({ stair: s }, i) => (
            <button
              key={s.id}
              onClick={() => mode.selectStair(s.id)}
              style={{
                display: 'block', width: '100%', textAlign: 'left',
                padding: '6px 10px', marginBottom: 4, borderRadius: 6, cursor: 'pointer', fontSize: 13,
                border: s.id === selectedId ? '1px solid #2563eb' : '1px solid #e2e8f0',
                background: s.id === selectedId ? '#eff6ff' : '#f8fafc',
                color: '#64748b',
              }}
            >
              階段{stairs.length + i + 1}（{TYPE_LABEL[s.type] ?? s.type}）・下階設置
            </button>
          ))}
        </div>
      )}
      {selectedSelf && <StairEditor stair={selectedSelf} graph={graph} project={project} onDelete={id => mode.deleteStair(id)} />}
      {selectedLower && (
        // 下階に設置された階段の読み取り専用表示（編集は設置階の仕上げモードで行う）。
        <div style={{ padding: 16 }}>
          <div style={{ fontSize: 12, color: '#64748b', marginBottom: 12 }}>
            下階に設置された階段です（見下げ表示）。編集は設置階の仕上げモードで行ってください。
          </div>
          <div style={rowStyle}><span style={labelStyle}>タイプ</span><span style={valueStyle}>{TYPE_LABEL[selectedLower.type] ?? selectedLower.type}</span></div>
          <div style={rowStyle}><span style={labelStyle}>段数</span><span style={valueStyle}>{selectedLower.totalSteps}</span></div>
          <div style={rowStyle}><span style={labelStyle}>蹴上(mm)</span><span style={valueStyle}>{selectedLower.riser != null ? Math.round(selectedLower.riser) : '自動'}</span></div>
          <div style={rowStyle}><span style={labelStyle}>蹴込(mm)</span><span style={valueStyle}>{selectedLower.nosing}</span></div>
          <div style={rowStyle}><span style={labelStyle}>幅(mm)</span><span style={valueStyle}>{selectedLower.width}</span></div>
        </div>
      )}
    </div>
  );
});
