import { useState } from 'react';
import './SiteDialog.css';

const MAIN_USE_OPTIONS = [
  '未定', '一戸建ての住宅', '長屋', '共同住宅', '寄宿舎', '下宿', '兼用住宅',
  '店舗', '飲食店', '事務所', '工場', '倉庫', '自動車車庫', '自転車駐車場',
  '学校', '体育館', '博物館', '図書館', '公会堂', '集会場', '診療所', '病院',
  '老人ホーム', '保育所', '福祉ホーム', 'その他',
];
const WORK_TYPE_OPTIONS = ['新築', '増築', '改築', '移転', '用途変更', '大規模の修繕', '大規模の模様替'];

function createInitialForm() {
  return {
    mainUse: MAIN_USE_OPTIONS[0],
    workType: WORK_TYPE_OPTIONS[0],
  };
}

function SelectRow({ label, value, options, onChange }) {
  return (
    <label className="site-row">
      <span className="site-label">{label}</span>
      <select value={value} onChange={e => onChange(e.target.value)}>
        {options.map(opt => <option key={opt} value={opt}>{opt}</option>)}
      </select>
    </label>
  );
}

// 外部スクリプトから innerHTML 等で直接書き込むための読み取り専用プレースホルダ。
// React state を持たず id だけを公開する（自動算出ロジックは未実装、初期値は 0）。
function AutoCalcField({ id, unit }) {
  return (
    <span className="site-pair" style={{ flex: 'none' }}>
      <span id={id} className="building-info-readout">0</span>
      {unit && <span className="site-pair-unit">{unit}</span>}
    </span>
  );
}

function AutoCalcRow({ label, id, unit }) {
  return (
    <div className="site-row">
      <span className="site-label">{label}</span>
      <AutoCalcField id={id} unit={unit} />
    </div>
  );
}

// 「地上階数 / 地下階数」のような 1 行 2 項目レイアウト
function AutoCalcPairRow({ items }) {
  return (
    <div className="site-row">
      {items.map((it, i) => (
        <span key={it.id} style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1 }}>
          <span className="site-label" style={{ width: 'auto' }}>{it.label}</span>
          <AutoCalcField id={it.id} unit={it.unit} />
          {i < items.length - 1 && <span className="site-pair-sep">/</span>}
        </span>
      ))}
    </div>
  );
}

// 「建築面積（建蔽率）」のような本体＋括弧書き付帯値のレイアウト
function AutoCalcRowWithNote({ label, id, unit, note }) {
  return (
    <div className="site-row">
      <span className="site-label">{label}</span>
      <AutoCalcField id={id} unit={unit} />
      <span className="site-pair-sep">（{note.label}：</span>
      <AutoCalcField id={note.id} unit={note.unit} />
      <span className="site-pair-sep">）</span>
    </div>
  );
}

/**
 * 建築情報の入力ダイアログ。
 *
 * レイアウトフォーマットは SiteDialog（敷地情報）を継承する。
 * initial: 前回コミットしたフォーム値（project.projectInfo.buildingInfo。null=未入力）。
 * onClose(form): どの閉じ口でも現在のフォーム値を渡す（SiteDialog と同じコミット方式）。
 * 「階層・高さ」「敷地・面積情報」は図面からの自動算出項目だが、
 * 算出ロジックは未実装のため、外部から id 経由で書き込み可能な
 * 読み取り専用プレースホルダ（初期値 0）として置くのみとする（フォーム値ではないため永続化対象外）。
 */
export function BuildingInfoDialog({ initial, onClose }) {
  const [form, setForm] = useState(() => ({ ...createInitialForm(), ...(initial ?? {}) }));

  function set(key, value) {
    setForm(f => ({ ...f, [key]: value }));
  }

  function close() {
    onClose(form);
  }

  function handleKeyDown(e) {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
  }

  return (
    <div className="site-dialog-backdrop" onPointerDown={e => { if (e.target === e.currentTarget) close(); }}>
      <div className="site-dialog" onKeyDown={handleKeyDown}>
        <div className="site-dialog-header">建築情報の入力</div>

        <div className="site-dialog-body">
          {/* 1. 主要用途・工事種別 */}
          <section className="site-section">
            <div className="site-section-title">1. 主要用途・工事種別</div>
            <SelectRow label="主要用途" value={form.mainUse} options={MAIN_USE_OPTIONS}
              onChange={v => set('mainUse', v)} />
            <SelectRow label="工事種別" value={form.workType} options={WORK_TYPE_OPTIONS}
              onChange={v => set('workType', v)} />
          </section>

          {/* 2. 階層・高さ（図面から自動算出） */}
          <section className="site-section">
            <div className="site-section-title">2. 階層・高さ（図面から自動算出）</div>
            <AutoCalcPairRow items={[
              { label: '地上階数', id: 'building-info-floors-above', unit: '階' },
              { label: '地下階数', id: 'building-info-floors-below', unit: '階' },
            ]} />
            <AutoCalcPairRow items={[
              { label: '最高高さ', id: 'building-info-max-height', unit: 'mm' },
              { label: '軒高',     id: 'building-info-eaves-height', unit: 'mm' },
            ]} />
          </section>

          {/* 3. 敷地・面積情報（図面から自動算出） */}
          <section className="site-section">
            <div className="site-section-title">3. 敷地・面積情報（図面から自動算出）</div>
            <AutoCalcRow label="敷地面積" id="building-info-site-area" unit="㎡" />
            <AutoCalcRowWithNote label="建築面積" id="building-info-building-area" unit="㎡"
              note={{ label: '建蔽率', id: 'building-info-coverage-ratio', unit: '%' }} />
            <AutoCalcRowWithNote label="延床面積" id="building-info-floor-area" unit="㎡"
              note={{ label: '容積率', id: 'building-info-floor-area-ratio', unit: '%' }} />
          </section>
        </div>

        <div className="site-dialog-footer">
          <button className="site-dialog-btn" onClick={close}>閉じる</button>
        </div>
      </div>
    </div>
  );
}
