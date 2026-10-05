// 仕上げ脱出の「省略の印」（無編集の階の仕上げ脱出を丸ごと省けるかの判定。純モジュール）。
//
// 【依拠する不変条件】
//  ・脱出の結果は、自階の raw バイト列・他の全平面の版・structBytes・planesBytes・catalogGen・codeSig・
//    indexSig だけで決まり、生成壁の id の付け替えには左右されない。
//  ・印は、自階の正規形（壁 id を振り直した比較用バイト列）を変えず・他の平面へ書かず・材マスタが今の
//    カタログで作られていた（fmode.materialOverlayGeneration）・直下階キャッシュ（fmode._lowerGraph）が
//    新鮮だった（突入時の peek 以降に直下階へ書込みが無い。fmode.lowerGraphGeneration）「全部行う脱出」の
//    直後にだけ記録する。
//  ・判定で不確かなことはすべて「省かない」側に倒す（例外・不安定な読込み・不明な形式）。
//  ・脱出が読む入力を増やすときは TOKEN_ITEMS とテストの表（finishExitStamp.test.js の TOKEN_MUTATIONS）を
//    同時に足す。足し忘れると、その入力が変わっても省いてしまう。
//
// 【構成】I/O（loadFloorFn・generationOf）は生成時の引数で受ける。状態は createFinishExitStamps の
// クロージャに閉じる（モジュールスコープに置かない）。react・store.js・snap.js・.jsx・modes/・storage/db.js・
// FloorSwapManager を直接は import しない（floorOps.js 経由の既存の依存は在る。node:test からの単体 import は可能）。
// 配線はこのファイルの外（finishBoundary.js runFinishExitBoundary の stamps 引数・App.jsx の finish.exit）。
import { serializeGraph, serializeGraphCanonicalWalls, canonicalizeFloorBytes, serializeStructCLs, serializePlanes } from '../graphSnapshot.js';
import { floorBytesEqual } from '../floorOps.js';
import { overlayGeneration } from '../catalog/catalogRegistry.js';
import { documentCodeTablesSignature } from '../catalog/codeNormalization.js';

/** 印の token の項目（canSkip が比べる外部入力）。テストの表と一致させる。 */
export const TOKEN_ITEMS = ['catalogGen', 'codeSig', 'structBytes', 'planesBytes', 'indexSig', 'others'];

// 値を決定的な文字列にする（オブジェクトのキー・Map・Set は並べ替える。MobX の observable も duck typing で扱う）。
function stable(v) {
  if (v == null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (typeof v.entries === 'function' && typeof v.get === 'function') {
    return `M{${[...v.entries()].map(([k, x]) => `${stable(k)}=>${stable(x)}`).sort().join(',')}}`;
  }
  if (typeof v.has === 'function' && typeof v.values === 'function') {
    return `S{${[...v.values()].map(stable).sort().join(',')}}`;
  }
  return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
}

/**
 * project.memberNumberIndex（部材採番の非永続キャッシュ）の決定的な署名。Map の挿入順・グループ内の
 * Set/Map の挿入順・オブジェクトのキー順に左右されない（内容が同じなら同じ文字列）。
 * 採番は下の階の寄与を前回の状態のまま持ち越すため、脱出の結果に効きうる入力として一致条件に入れる。
 */
export function memberNumberIndexSignature(index) {
  return stable(index);
}

const isEmptyBytes = (b) => b == null || (b.length === 0);
const isBytes = (b) => b instanceof Uint8Array;

function requireFn(name, f) {
  if (typeof f !== 'function') throw new Error(`createFinishExitStamps: ${name} は関数で指定してください`);
}

function sameOthers(a, b) {
  if (a === null || b === null || a.size !== b.size) return false;
  for (const [id, v] of a) if (!b.has(id) || b.get(id) !== v) return false;
  return true;
}

/**
 * 印の保管庫を作る。
 * @param {{ loadFloorFn: (planeId:string) => Promise<Uint8Array|null>, generationOf: (planeId:string) => string }} deps
 *   loadFloorFn: 階のバイト列の読み手（本番は storage/db.js loadFloor）／generationOf: 書込み世代
 *   （本番は storage/floorWriteGeneration.js floorWriteGeneration）。どちらも必須。
 * @returns {{ canSkip: Function, beginFullExit: Function, endFullExit: Function, clear: Function }}
 */
export function createFinishExitStamps({ loadFloorFn, generationOf } = {}) {
  requireFn('loadFloorFn', loadFloorFn);
  requireFn('generationOf', generationOf);

  const stamps = new Map(); // planeId -> { raw: Uint8Array, token }
  const floors = new Map(); // planeId -> { gen, raw, canon, version }（他の平面の版の記憶）

  // 他の平面の「版」（内容の同一性）。壁 id の付け替えだけの違いは同じ版。null＝不安定（判定できない）。
  async function versionOf(planeId) {
    const g0 = generationOf(planeId);
    const entry = floors.get(planeId);
    if (entry && entry.gen === g0) return entry.version;
    const bytes = await loadFloorFn(planeId);
    const g1 = generationOf(planeId);
    if (g1 !== g0) return null; // 読んでいる間に書かれた。キャッシュしない
    if (entry && ((isBytes(entry.raw) && isBytes(bytes) && floorBytesEqual(entry.raw, bytes))
      || (isEmptyBytes(entry.raw) && isEmptyBytes(bytes)))) {
      entry.gen = g0;
      return entry.version;
    }
    const canon = canonicalizeFloorBytes(bytes);
    const same = entry && canon !== null && entry.canon !== null && floorBytesEqual(canon, entry.canon);
    const version = entry ? (same ? entry.version : entry.version + 1) : 0;
    floors.set(planeId, { gen: g0, raw: bytes, canon, version });
    return version;
  }

  // 自階以外の全平面（屋根専用平面・検討案を含む planeMap）の版。1つでも判定できなければ null。
  async function othersOf(project, selfId) {
    const out = new Map();
    for (const id of project.planeMap.keys()) {
      if (id === selfId) continue;
      const v = await versionOf(id);
      if (v === null) return null;
      out.set(id, v);
    }
    return out;
  }

  const projectToken = (project) => ({
    catalogGen: overlayGeneration(),
    codeSig: documentCodeTablesSignature(),
    structBytes: serializeStructCLs(project.structGraph, project.structuralInfo, project.memberGroupLedger),
    planesBytes: serializePlanes(project),
    indexSig: memberNumberIndexSignature(project.memberNumberIndex),
  });

  const otherGens = (project, selfId) => {
    const m = new Map();
    for (const id of project.planeMap.keys()) if (id !== selfId) m.set(id, generationOf(id));
    return m;
  };

  /** 脱出を省いてよいか。{ skip, reason }。例外はすべて { skip:false, reason:'error' }。 */
  async function canSkip(graph, project) {
    try {
      if (graph.plane.isRoofPlane) return { skip: false, reason: 'roofPlane' };
      const selfId = graph.plane.id;
      const stamp = stamps.get(selfId);
      if (!stamp) return { skip: false, reason: 'noStamp' };
      if (!floorBytesEqual(serializeGraph(graph), stamp.raw)) return { skip: false, reason: 'selfChanged' };
      const cur = projectToken(project);
      const t = stamp.token;
      if (cur.catalogGen !== t.catalogGen) return { skip: false, reason: 'catalog' };
      if (cur.codeSig !== t.codeSig) return { skip: false, reason: 'codeTable' };
      if (!floorBytesEqual(cur.structBytes, t.structBytes)) return { skip: false, reason: 'struct' };
      if (!floorBytesEqual(cur.planesBytes, t.planesBytes)) return { skip: false, reason: 'planes' };
      if (cur.indexSig !== t.indexSig) return { skip: false, reason: 'memberIndex' };
      const others = await othersOf(project, selfId);
      if (others === null) return { skip: false, reason: 'unstable' };
      if (!sameOthers(others, t.others)) return { skip: false, reason: 'otherFloor' };
      return { skip: true, reason: 'match' };
    } catch (e) {
      console.error('finishExitStamp.canSkip', e);
      return { skip: false, reason: 'error' };
    }
  }

  /**
   * 全部行う脱出の直前に呼ぶ。この階の印を（以後どこで失敗しても無いように）最初に消し、脱出前の
   * 状態（正規形・token・他の平面の版と世代）を控えた probe を返す。例外は握って { ok:false }。
   */
  async function beginFullExit(graph, project, fmode) {
    const selfId = graph.plane.id;
    stamps.delete(selfId);
    try {
      const canonPre = serializeGraphCanonicalWalls(graph);
      const tokPre = projectToken(project);
      // 世代は版の読込みより先に控える（読込み中に世代が進んでも end の比較で必ず検出する）
      const gens = otherGens(project, selfId);
      // 版は begin の時点（脱出が他の平面へ書く前）のもの。end で他の平面の世代が変わらなかったときだけ印へ入れる
      const others = await othersOf(project, selfId);
      // 直下階キャッシュ（fmode._lowerGraph。全部行う脱出は peek の代わりにこれを使う）が新鮮か。書込み世代が
      // 突入時の peek 時点から変わっていなければ新鮮。キャッシュが無いとき（脱出が実 peek する）は新鮮扱い。
      const lower = fmode?._lowerGraph;
      const lowerFresh = !lower
        || (fmode.lowerGraphGeneration != null && generationOf(lower.plane.id) === fmode.lowerGraphGeneration);
      return { ok: true, canonPre, tokPre, others, gens, fmodeCatalogGen: fmode?.materialOverlayGeneration ?? null, lowerFresh };
    } catch (e) {
      console.error('finishExitStamp.beginFullExit', e);
      return { ok: false };
    }
  }

  /** 全部行う脱出の直後に呼ぶ。条件が全部成り立つときだけ印を記録する。 */
  function endFullExit(graph, project, probe, { regenerated } = {}) {
    try {
      if (probe?.ok !== true) return;
      if (probe.others === null) return;
      if (regenerated !== true) return;
      if (probe.lowerFresh !== true) return; // 直下階キャッシュが古い（突入後に直下階が書き換わった）
      if (graph.plane.isRoofPlane) return;
      const selfId = graph.plane.id;
      const nowCatalogGen = overlayGeneration();
      if (probe.fmodeCatalogGen !== probe.tokPre.catalogGen || probe.fmodeCatalogGen !== nowCatalogGen) return;
      if (!floorBytesEqual(serializeGraphCanonicalWalls(graph), probe.canonPre)) return;
      const gensNow = otherGens(project, selfId);
      if (gensNow.size !== probe.gens.size) return;
      for (const [id, g] of gensNow) if (!probe.gens.has(id) || probe.gens.get(id) !== g) return;
      const tok = projectToken(project);
      const pre = probe.tokPre;
      if (tok.catalogGen !== pre.catalogGen || tok.codeSig !== pre.codeSig) return;
      if (!floorBytesEqual(tok.structBytes, pre.structBytes) || !floorBytesEqual(tok.planesBytes, pre.planesBytes)) return;
      stamps.set(selfId, { raw: serializeGraph(graph), token: { ...tok, others: probe.others } });
    } catch (e) {
      console.error('finishExitStamp.endFullExit', e);
    }
  }

  function clear() {
    stamps.clear();
    floors.clear();
  }

  return { canSkip, beginFullExit, endFullExit, clear };
}
