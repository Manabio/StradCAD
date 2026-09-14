import { observer } from 'mobx-react-lite';
import './SiteDialog.css';

// 構造情報パネル（共通タブ）で使う選択肢・ヘルパーコンポーネント。
// パネル本体（structural/StructuralPanel.jsx）・共通タブ本体（structural/CommonInfoTab.jsx）から参照する。
// 主構造の選択肢（MAIN_STRUCTURE_OPTIONS/OTHER_STRUCTURE_OPTIONS）・基礎種別の選択肢・木造判定は
// structural/structureRules.js（主構造ごとのルールセット）が持つ——このファイルはコンポーネントと
// 主構造非依存の選択肢だけ（react-refresh の制約で関数の再exportを置かない）。
export const DESIGN_STRENGTH_OPTIONS = ['Fc21', 'Fc24', 'Fc27', 'Fc30'];
export const CONCRETE_TYPE_OPTIONS = ['普通コンクリート', '軽量コンクリート'];
export const MAIN_BAR_OPTIONS = ['SD345', 'SD390'];
export const HOOP_BAR_OPTIONS = ['SD295A', 'SD295B'];
export const SNOW_AREA_OPTIONS = ['一般区域（多雪以外）', '多雪区域'];
export const BASIC_WIND_SPEED_OPTIONS = [30, 32, 34, 36, 38, 40, 42, 44, 46];
export const SURFACE_ROUGHNESS_OPTIONS = ['I', 'II', 'III', 'IV'];
export const SEISMIC_ZONE_FACTOR_OPTIONS = ['1.0', '0.9', '0.8', '0.7'];

export const SelectRow = observer(({ label, value, options, onChange, unit, selectRef }) => (
  <label className="site-row">
    <span className="site-label">{label}</span>
    <select ref={selectRef} value={value} onChange={e => onChange(e.target.value)}>
      {options.map(opt => <option key={opt} value={opt}>{opt}</option>)}
    </select>
    {unit && <span className="site-pair-unit">{unit}</span>}
  </label>
));

export const CheckboxGroup = observer(({ label, options, selected, onToggle }) => (
  <div className="site-row" style={{ alignItems: 'flex-start' }}>
    <span className="site-label">{label}</span>
    <div className="site-checkbox-group">
      {options.map(opt => (
        <label key={opt} className="site-checkbox-row">
          <input type="checkbox" checked={selected.includes(opt)} onChange={() => onToggle(opt)} />
          {opt}
        </label>
      ))}
    </div>
  </div>
));

// 敷地情報から転写される想定の読み取り専用項目。転写ロジックは未実装のため、
// BuildingInfoDialog の AutoCalcField と同様にプレースホルダ表示のみ置く。
export const TranscribedField = observer(({ label, note, value }) => (
  <div className="site-row">
    <span className="site-label">{label}</span>
    <span className="building-info-readout" style={{ width: '100%', textAlign: 'left' }}>{value}</span>
    {note && <span className="site-pair-sep">{note}</span>}
  </div>
));
