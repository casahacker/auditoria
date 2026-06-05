/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Cockpit de Fornecedores (Diligência + KYS/KYG unificados).
 *
 * Uma só visão por fornecedor (CNPJ/CPF): situação de Diligência (Receita + listas de
 * restrição) e de Conformidade KYS/KYG (cadastro verificado + assinatura) lado a lado.
 * A diferença entre fornecedores é apenas ter ou não KYS/KYG assinado. O perfil traz os
 * dados consolidados (de todas as APIs) numa única tela, persistentes e editáveis, mais
 * a diligência e o KYS/KYG (reusa DetailView do KYS/KYG e os convites).
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Building2, BookOpen, Link2, Loader2, Search, RefreshCw, ChevronRight, ChevronLeft,
  ShieldCheck, ShieldAlert, AlertTriangle, Upload, FileUp, History, BadgeCheck,
  ChevronUp, ChevronDown, ArrowUpDown, X, Users, FileSignature, Pencil, Check, Printer, DownloadCloud,
} from 'lucide-react';
import { cn } from '../lib/utils';
import { AuthUser } from '../types';
import { Btn, IconBtn, Chip, Card, ToolSidebar, ToolHeader, SidebarItem, SkipLink, EmptyState, tableHeadCls, Select, SearchInput, Modal } from '../ui/kit';
import type { ChipTone } from '../ui/kit';
import { ConvitesView, DetailView as KycDetailView } from '../kyc/KycApp';
import { onlyDigits, maskDoc, KYC_STATUS_LABEL } from '../kyc/kycTypes';
import type { KycStatus } from '../kyc/kycTypes';

export interface FornecedoresAppProps {
  user: AuthUser;
  apiFetch: (url: string, opts?: RequestInit) => Promise<Response>;
  addToast: (kind: 'success' | 'error' | 'info', message: string) => void;
  onHome: () => void;
  navigate?: (path: string) => void;
  initialDoc?: string;
}

type Section = 'base' | 'historico' | 'ajuda' | 'detalhe';
const segs = () => window.location.pathname.split('/').filter(Boolean);
const toPath = (s: Section, doc?: string) => s === 'detalhe' && doc ? `/fornecedores/${doc}` : s === 'base' ? '/fornecedores' : `/fornecedores/${s}`;
const HEADERS: Record<Section, [string, string]> = {
  base: ['Cockpit de', 'Fornecedores'], historico: ['Histórico de', 'Diligências'], ajuda: ['Como', 'usar'], detalhe: ['Ficha do', 'Fornecedor'],
};

const DIL: Record<string, { tone: ChipTone; icon: React.ElementType; label: string }> = {
  NADA_CONSTA: { tone: 'success', icon: ShieldCheck, label: 'Nada consta' },
  ALERTA: { tone: 'error', icon: ShieldAlert, label: 'Alerta' },
  PENDENTE: { tone: 'warning', icon: AlertTriangle, label: 'Pendente' },
};
const dilChip = (d: any) => {
  if (!d) return <span className="text-[12px] text-text-secondary">não consultada</span>;
  const m = DIL[d.verdict];
  return <span className="inline-flex items-center gap-1.5"><Chip tone={m?.tone} icon={m?.icon} size="sm">{m?.label || d.verdict}</Chip>{!d.valida && <span className="text-[12px] text-warning">vencida</span>}</span>;
};
const kycChip = (k: any) => {
  if (!k) return <span className="text-[12px] text-text-secondary">—</span>;
  const vencido = k.status === 'assinado' && !k.valida;
  const tone: ChipTone = vencido ? 'warning' : k.status === 'assinado' ? 'success' : k.status === 'aguardando_assinatura' ? 'warning' : 'neutral';
  return <Chip tone={tone} size="sm">{vencido ? 'Vencido' : KYC_STATUS_LABEL[k.status as KycStatus]}{k.type ? ` · ${String(k.type).toUpperCase()}` : ''}</Chip>;
};
const FAIXA: Record<string, { tone: ChipTone; label: string; short: string }> = {
  inelegivel: { tone: 'error', label: 'Inelegível', short: 'Inelegível' },
  ate_2sm: { tone: 'warning', label: 'Elegível — contratos até 2 salários mínimos', short: 'Até 2 SM' },
  acima_2sm: { tone: 'success', label: 'Elegível — contratos a partir de 2 salários mínimos', short: '2 SM+' },
  pendente: { tone: 'neutral', label: 'Pendente — diligência não concluída', short: 'Pendente' },
};
const faixaChip = (f?: string, full?: boolean) => { const m = FAIXA[f || 'pendente'] || FAIXA.pendente; return <Chip tone={m.tone} size="sm" className={full ? 'whitespace-normal text-left leading-snug' : undefined}>{full ? m.label : m.short}</Chip>; };

export default function FornecedoresApp({ user, apiFetch, addToast, onHome, navigate, initialDoc }: FornecedoresAppProps) {
  const [section, setSection] = useState<Section>('base');
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [history, setHistory] = useState<any[]>([]);
  const [cnpjInput, setCnpjInput] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const [convites, setConvites] = useState<{ open: boolean; cnpj?: string }>({ open: false });
  // detalhe (perfil consolidado: cadastrais + diligência + KYS/KYG)
  const [dDoc, setDDoc] = useState(''); const [profile, setProfile] = useState<any>(null); const [dBusy, setDBusy] = useState(false);

  const loadRows = async () => { setLoading(true); try { const r = await apiFetch('/api/fornecedores'); if (r.ok) setRows(await r.json()); } catch { /* */ } finally { setLoading(false); } };
  const loadHistory = async () => { try { const r = await apiFetch('/api/diligencia'); if (r.ok) setHistory(await r.json()); } catch { /* */ } };
  useEffect(() => { loadRows(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const [queue, setQueue] = useState<any>(null); const lastDone = useRef(-1);
  useEffect(() => {
    let alive = true; let t: ReturnType<typeof setTimeout>;
    const tick = async () => {
      let q: any = null; try { const r = await apiFetch('/api/diligencia/queue'); if (r.ok) q = await r.json(); } catch { /* */ }
      if (!alive) return; setQueue(q);
      if (q && q.done !== lastDone.current) { if (lastDone.current !== -1) loadRows(); lastDone.current = q.done; }
      t = setTimeout(tick, q && (q.running || q.pending > 0) ? 4000 : 30000);
    };
    tick(); return () => { alive = false; clearTimeout(t); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // progresso da atualização em massa das APIs (Receita+CEP) — recarrega a base ao concluir
  const [mass, setMass] = useState<any>(null); const massWas = useRef(false);
  useEffect(() => {
    let alive = true; let t: ReturnType<typeof setTimeout>;
    const tick = async () => {
      let m: any = null; try { const r = await apiFetch('/api/fornecedores/refresh-all/status'); if (r.ok) m = await r.json(); } catch { /* */ }
      if (!alive) return; setMass(m);
      if (m?.running) massWas.current = true;
      else if (massWas.current) { massWas.current = false; loadRows(); addToast('success', `Atualização das APIs concluída: ${m?.done ?? 0} ok${m?.fail ? `, ${m.fail} erro(s)` : ''}.`); }
      t = setTimeout(tick, m?.running ? 5000 : 45000);
    };
    tick(); return () => { alive = false; clearTimeout(t); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const openFornecedor = async (doc: string) => {
    const d = onlyDigits(doc);
    setSection('detalhe'); setDDoc(d); setProfile(null); setDBusy(true); navigate?.(toPath('detalhe', d));
    try { const r = await apiFetch(`/api/fornecedores/${d}`); if (r.ok) setProfile(await r.json()); } catch { /* */ } finally { setDBusy(false); }
  };
  const refreshProfile = async (doc: string) => {
    const d = onlyDigits(doc); setDBusy(true);
    try { const r = await apiFetch(`/api/fornecedores/${d}/refresh`, { method: 'POST' }); if (!r.ok) throw new Error(); setProfile(await r.json()); addToast('success', 'Cadastro atualizado (Receita + CEP).'); loadRows(); }
    catch { addToast('error', 'Falha ao atualizar o cadastro.'); } finally { setDBusy(false); }
  };
  const reconsultarDiligencia = async (doc: string) => {
    const d = onlyDigits(doc); if (d.length !== 14) { addToast('error', 'A diligência aplica-se a CNPJ.'); return; }
    setDBusy(true);
    try { const r = await apiFetch(`/api/fornecedores/${d}/diligencia`, { method: 'POST' }); if (!r.ok) throw new Error((await r.json().catch(() => ({} as any))).error || ''); const p = await r.json(); setProfile(p); addToast(p.diligencia?.verdict === 'ALERTA' ? 'error' : 'success', p.diligencia?.verdict === 'ALERTA' ? 'Diligência: ALERTA — restrições encontradas.' : 'Diligência concluída.'); loadRows(); }
    catch (e: any) { addToast('error', e.message || 'Falha na diligência.'); } finally { setDBusy(false); }
  };
  const saveCadastro = async (doc: string, fields: any): Promise<boolean> => {
    try { const r = await apiFetch(`/api/fornecedores/${onlyDigits(doc)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields }) }); if (!r.ok) throw new Error(); setProfile(await r.json()); addToast('success', 'Cadastro salvo.'); loadRows(); return true; }
    catch { addToast('error', 'Falha ao salvar o cadastro.'); return false; }
  };
  const reloadProfile = async () => { if (!dDoc) return; try { const r = await apiFetch(`/api/fornecedores/${dDoc}`); if (r.ok) setProfile(await r.json()); } catch { /* */ } };
  const consultarTopo = (cnpj: string) => { const d = onlyDigits(cnpj); if (d.length !== 14) { addToast('error', 'Informe um CNPJ válido (14 dígitos).'); return; } setSection('detalhe'); setDDoc(d); setProfile(null); navigate?.(toPath('detalhe', d)); reconsultarDiligencia(d); };
  const runAll = async () => { try { const r = await apiFetch('/api/diligencia/run-all', { method: 'POST' }); const j = await r.json(); addToast(j.queued ? 'info' : 'success', j.queued ? `${j.queued} na fila de diligência.` : 'Tudo em dia.'); } catch { addToast('error', 'Falha ao iniciar.'); } };
  const runAllForce = async () => {
    if (!window.confirm('Reconsultar TODA a base ignorando o cache de 30 dias? Reconsulta todas as listas de restrição de cada fornecedor — pode levar vários minutos (roda em segundo plano).')) return;
    try { const r = await apiFetch('/api/diligencia/run-all-force', { method: 'POST' }); const j = await r.json(); addToast('info', `${j.queued || 0} fornecedores na fila de reconsulta forçada.`); } catch { addToast('error', 'Falha ao iniciar a reconsulta.'); }
  };
  const refreshAllApis = async () => {
    if (!window.confirm('Atualizar os dados cadastrais de TODOS os fornecedores a partir das APIs (Receita Federal + CEP)?\n\nRoda em segundo plano e pode levar vários minutos. Campos editados manualmente são preservados.')) return;
    try {
      const r = await apiFetch('/api/fornecedores/refresh-all', { method: 'POST' }); const j = await r.json();
      if (j.alreadyRunning) addToast('info', 'Já há uma atualização em massa em andamento.');
      else { addToast('info', `Atualização iniciada (${j.total} fornecedor[es]). Acompanhe a barra de progresso.`); massWas.current = true; }
      setMass(j);
    } catch { addToast('error', 'Falha ao iniciar a atualização.'); }
  };
  const doImport = async (text: string): Promise<boolean> => {
    try { const r = await apiFetch('/api/diligencia/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
      const j = await r.json().catch(() => ({})); if (!r.ok) { addToast('error', j.error || 'Falha ao importar.'); return false; }
      addToast('success', `Importados ${j.recebidos} CNPJ(s): ${j.adicionados} novo(s).`); loadRows(); return true;
    } catch { addToast('error', 'Falha ao importar.'); return false; }
  };

  const goSection = (s: Section) => { setSection(s); if (s === 'historico') loadHistory(); navigate?.(toPath(s)); };
  const applyPath = () => {
    const s = segs(); if (s[0] !== 'fornecedores') return; const a = s[1];
    if (!a) setSection('base'); else if (a === 'historico') { setSection('historico'); loadHistory(); } else if (a === 'ajuda') setSection('ajuda');
    else if (a === 'kyc' || a === 'convites') setSection('base'); else openFornecedor(a);
  };
  useEffect(() => { if (initialDoc) openFornecedor(initialDoc); else applyPath(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const onPop = () => applyPath(); window.addEventListener('popstate', onPop); return () => window.removeEventListener('popstate', onPop); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const navItems: { id: Section; label: string; icon: React.ElementType }[] = [
    { id: 'base', label: 'Fornecedores', icon: Building2 },
    { id: 'historico', label: 'Histórico', icon: History },
    { id: 'ajuda', label: 'Como usar', icon: BookOpen },
  ];

  return (
    <div className="flex min-h-screen pt-8">
      <SkipLink />
      <ToolSidebar brand="Fornecedores" onHome={onHome} user={user}>
        {navItems.map((it) => <SidebarItem key={it.id} icon={it.icon} active={section === it.id} onClick={() => goSection(it.id)}>{it.label}</SidebarItem>)}
      </ToolSidebar>
      <main id="main-content" className="ml-[256px] flex-1 min-w-[820px] flex flex-col">
        <ToolHeader light={HEADERS[section][0]} accent={HEADERS[section][1]} right={
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-2 bg-card border border-line px-3 h-10 focus-within:border-primary">
              <Search size={14} className="text-text-secondary" aria-hidden />
              <input value={cnpjInput} onChange={(e) => setCnpjInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && consultarTopo(cnpjInput)}
                aria-label="CNPJ a consultar" placeholder="CNPJ a consultar" className="bg-transparent text-[14px] outline-none w-[150px] sm:w-[170px]" />
            </label>
            <Btn onClick={() => consultarTopo(cnpjInput)} disabled={dBusy}>Consultar</Btn>
          </div>
        } />
        <div className="flex-1 overflow-y-auto px-6 sm:px-10 py-8 pb-24">
          {section === 'base' && <CockpitBase rows={rows} loading={loading} openFornecedor={openFornecedor} queue={queue} runAll={runAll} runAllForce={runAllForce}
            onImport={() => setImportOpen(true)} onConvites={() => setConvites({ open: true })} mass={mass} onRefreshAll={refreshAllApis} />}
          {section === 'historico' && <HistoricoView history={history} openFornecedor={openFornecedor} />}
          {section === 'ajuda' && <AjudaFornecedores />}
          {section === 'detalhe' && <FichaFornecedor doc={dDoc} profile={profile} busy={dBusy} apiFetch={apiFetch} addToast={addToast}
            onRefresh={() => refreshProfile(dDoc)} onReconsultar={() => reconsultarDiligencia(dDoc)} onSave={(fields: any) => saveCadastro(dDoc, fields)} reloadKyc={reloadProfile}
            onBack={() => goSection('base')} onInvite={() => setConvites({ open: true, cnpj: dDoc.length === 14 ? dDoc : undefined })} />}
        </div>
      </main>
      {importOpen && <ImportModal onClose={() => setImportOpen(false)} onSubmit={doImport} />}
      {convites.open && (
        <Modal title="Convites de KYS / KYG" onClose={() => setConvites({ open: false })} size="lg">
          <div className="p-6"><ConvitesView apiFetch={apiFetch} addToast={addToast} initialCnpj={convites.cnpj} /></div>
        </Modal>
      )}
    </div>
  );
}

// ── stat card (clicável) ────────────────────────────────────────────────────────
function Stat({ icon: Icon, label, value, tone, active, onClick }: { icon: React.ElementType; label: string; value: number; tone: ChipTone; active?: boolean; onClick?: () => void }) {
  const ring: Record<ChipTone, string> = { success: 'text-success', error: 'text-error', warning: 'text-warning', info: 'text-primary', neutral: 'text-text-secondary' };
  return (
    <button onClick={onClick} aria-pressed={active}
      className={cn('flex items-center gap-3 rounded-none border bg-card px-4 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
        active ? 'border-primary ring-1 ring-primary' : 'border-line hover:border-primary/50')}>
      <Icon size={18} className={ring[tone]} aria-hidden />
      <div><div className="text-[20px] font-semibold leading-none">{value}</div><div className="text-[12px] text-text-secondary mt-1">{label}</div></div>
    </button>
  );
}

type SortKey = 'nome' | 'diligencia' | 'kyc' | 'elegivel';
function SortTh({ label, k, sort, setSort, className }: { label: string; k: SortKey; sort: { k: SortKey; dir: 1 | -1 }; setSort: (s: { k: SortKey; dir: 1 | -1 }) => void; className?: string }) {
  const active = sort.k === k;
  return (
    <th scope="col" aria-sort={active ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'} className={cn('px-4 py-2.5 font-semibold', className)}>
      <button onClick={() => setSort({ k, dir: active && sort.dir === 1 ? -1 : 1 })}
        className="inline-flex items-center gap-1 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded">
        {label}{active ? (sort.dir === 1 ? <ChevronUp size={12} aria-hidden /> : <ChevronDown size={12} aria-hidden />) : <ArrowUpDown size={11} className="opacity-40" aria-hidden />}
      </button>
    </th>
  );
}

function CockpitBase({ rows, loading, openFornecedor, queue, runAll, runAllForce, onImport, onConvites, mass, onRefreshAll }: any) {
  const [q, setQ] = useState(''); const [df, setDf] = useState('all'); const [kf, setKf] = useState('all'); const [tf, setTf] = useState('all'); const [ef, setEf] = useState('all');
  const [sort, setSort] = useState<{ k: SortKey; dir: 1 | -1 }>({ k: 'nome', dir: 1 });
  const qd = onlyDigits(q);
  const clear = () => { setQ(''); setDf('all'); setKf('all'); setTf('all'); setEf('all'); };
  const hasFilter = q || df !== 'all' || kf !== 'all' || tf !== 'all' || ef !== 'all';

  const stats = useMemo(() => ({
    total: rows.length,
    acima2: rows.filter((r: any) => r.faixa === 'acima_2sm').length,
    ate2: rows.filter((r: any) => r.faixa === 'ate_2sm').length,
    inelegivel: rows.filter((r: any) => r.faixa === 'inelegivel').length,
    pendente: rows.filter((r: any) => r.faixa === 'pendente').length,
    semDilig: rows.filter((r: any) => r.doc.length === 14 && (!r.diligencia || !r.diligencia.valida)).length,
  }), [rows]);

  const filtered = useMemo(() => rows.filter((r: any) => {
    if (q) { const hay = `${r.nome || ''} ${r.docFmt || ''}`.toLowerCase(); if (!hay.includes(q.toLowerCase()) && !(qd && r.doc.includes(qd))) return false; }
    if (df !== 'all') { if (df === 'none') { if (r.diligencia) return false; } else if (df === 'vencida') { if (!(r.diligencia && !r.diligencia.valida)) return false; } else if (r.diligencia?.verdict !== df) return false; }
    if (kf !== 'all') { if (kf === 'none') { if (r.kyc) return false; } else if (kf === 'assinado') { if (!(r.kyc?.status === 'assinado' && r.kyc?.valida)) return false; } else if (kf === 'vencido') { if (!(r.kyc?.status === 'assinado' && !r.kyc?.valida)) return false; } else if (r.kyc?.status !== kf) return false; }
    if (tf !== 'all' && (tf === 'pj' ? r.doc.length !== 14 : r.doc.length !== 11)) return false;
    if (ef !== 'all' && (r.faixa || 'pendente') !== ef) return false;
    return true;
  }), [rows, q, qd, df, kf, tf, ef]);

  const sorted = useMemo(() => {
    const dRank = (r: any) => r.diligencia ? ({ ALERTA: 0, PENDENTE: 1, NADA_CONSTA: 2 } as any)[r.diligencia.verdict] ?? 3 : 4;
    const kRank = (r: any) => !r.kyc ? 4 : r.kyc.status === 'aguardando_assinatura' ? 0 : (r.kyc.status === 'assinado' && !r.kyc.valida) ? 1 : r.kyc.status === 'assinado' ? 2 : 3;
    const eRank = (r: any) => (({ inelegivel: 0, pendente: 1, ate_2sm: 2, acima_2sm: 3 } as any)[r.faixa] ?? 1);
    const val = (r: any) => sort.k === 'nome' ? (r.nome || '~').toLowerCase() : sort.k === 'diligencia' ? dRank(r) : sort.k === 'kyc' ? kRank(r) : eRank(r);
    return [...filtered].sort((a, b) => { const va = val(a), vb = val(b); return (va < vb ? -1 : va > vb ? 1 : 0) * sort.dir; });
  }, [filtered, sort]);

  const active = !!queue && (queue.running || queue.pending > 0);
  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <p className="text-[14px] text-text-secondary max-w-2xl">
          Todos os fornecedores num só lugar: <b className="text-text">Diligência</b> (Receita + listas de restrição) e
          <b className="text-text"> KYS/KYG</b> (cadastro verificado + assinatura). O KYS/KYG é exigido apenas para contratações específicas.
          Diligências de novos/vencidos rodam automaticamente.
        </p>
        <div className="flex flex-wrap items-center justify-end gap-2 shrink-0">
          <Btn variant="secondary" onClick={onConvites}><Link2 size={14} aria-hidden /> Convites</Btn>
          <Btn variant="secondary" onClick={onImport}><Upload size={14} aria-hidden /> Importar CNPJs</Btn>
          <Btn variant="secondary" onClick={runAll} disabled={stats.semDilig === 0}><RefreshCw size={14} aria-hidden /> Consultar não consultados{stats.semDilig ? ` (${stats.semDilig})` : ''}</Btn>
          <Btn variant="ghost" onClick={runAllForce}><RefreshCw size={14} aria-hidden /> Reconsultar tudo (forçado)</Btn>
          <Btn variant="secondary" onClick={onRefreshAll} disabled={!!mass?.running}><DownloadCloud size={14} aria-hidden /> Atualizar tudo das APIs</Btn>
        </div>
      </div>

      {/* dashboard de stats (clicáveis → filtram) */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <Stat icon={Users} label="Fornecedores" value={stats.total} tone="info" active={!hasFilter} onClick={clear} />
        <Stat icon={ShieldCheck} label="Elegível 2 SM+" value={stats.acima2} tone="success" active={ef === 'acima_2sm'} onClick={() => { clear(); setEf('acima_2sm'); }} />
        <Stat icon={FileSignature} label="Elegível até 2 SM" value={stats.ate2} tone="warning" active={ef === 'ate_2sm'} onClick={() => { clear(); setEf('ate_2sm'); }} />
        <Stat icon={ShieldAlert} label="Inelegíveis" value={stats.inelegivel} tone="error" active={ef === 'inelegivel'} onClick={() => { clear(); setEf('inelegivel'); }} />
        <Stat icon={AlertTriangle} label="Pendentes (diligência)" value={stats.pendente} tone="neutral" active={ef === 'pendente'} onClick={() => { clear(); setEf('pendente'); }} />
      </div>

      {active && (
        <Card role="status" aria-live="polite" className="p-3 flex items-center gap-3 border-primary/40">
          <Loader2 size={16} className="animate-spin text-primary shrink-0" aria-hidden />
          <div className="text-[12px]"><span className="font-semibold text-text">Consultando em segundo plano…</span>{' '}
            <span className="text-text-secondary">{queue.done} concluída(s) · {queue.pending} na fila{queue.failed ? ` · ${queue.failed} erro(s)` : ''} · limite {queue.ratePerMin}/min</span></div>
        </Card>
      )}

      {mass?.running && (
        <Card role="status" aria-live="polite" className="p-3 flex items-center gap-3 border-primary/40">
          <DownloadCloud size={16} className="animate-pulse text-primary shrink-0" aria-hidden />
          <div className="text-[12px] flex-1"><span className="font-semibold text-text">Atualizando cadastros das APIs (Receita + CEP)…</span>{' '}
            <span className="text-text-secondary">{mass.done}/{mass.total} concluído(s){mass.fail ? ` · ${mass.fail} erro(s)` : ''}</span>
            <div className="mt-1.5 h-1 w-full rounded-full bg-line overflow-hidden"><div className="h-full bg-primary transition-all" style={{ width: `${mass.total ? Math.round((mass.done / mass.total) * 100) : 0}%` }} /></div>
          </div>
        </Card>
      )}

      {loading ? (
        <div role="status" className="flex items-center gap-2 text-text-secondary text-[14px]"><Loader2 size={16} className="animate-spin" aria-hidden /> Carregando…</div>
      ) : !rows.length ? (
        <EmptyState icon={Building2} title="Nenhum fornecedor ainda" description="A base vem das prestações de contas (Auditoria + FEAC), da importação de CNPJs e dos KYS/KYG. Consulte um CNPJ no campo acima." />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <SearchInput value={q} onChange={setQ} placeholder="Buscar por nome ou CNPJ/CPF" className="w-full sm:w-[230px]" />
            <Select ariaLabel="Filtrar por diligência" value={df} onChange={setDf} options={[{ value: 'all', label: 'Diligência: todas' }, { value: 'ALERTA', label: 'Alerta' }, { value: 'NADA_CONSTA', label: 'Nada consta' }, { value: 'PENDENTE', label: 'Pendente' }, { value: 'vencida', label: 'Vencida' }, { value: 'none', label: 'Não consultada' }]} />
            <Select ariaLabel="Filtrar por KYS/KYG" value={kf} onChange={setKf} options={[{ value: 'all', label: 'KYS/KYG: todos' }, { value: 'assinado', label: 'Assinado (válido)' }, { value: 'aguardando_assinatura', label: 'Aguardando' }, { value: 'vencido', label: 'Vencido' }, { value: 'none', label: 'Sem KYS/KYG' }]} />
            <Select ariaLabel="Filtrar por tipo" value={tf} onChange={setTf} options={[{ value: 'all', label: 'Tipo: todos' }, { value: 'pj', label: 'PJ (CNPJ)' }, { value: 'pf', label: 'PF (CPF)' }]} />
            <Select ariaLabel="Filtrar por elegibilidade" value={ef} onChange={setEf} options={[{ value: 'all', label: 'Elegibilidade' }, { value: 'acima_2sm', label: 'Elegível 2 SM+' }, { value: 'ate_2sm', label: 'Elegível até 2 SM' }, { value: 'inelegivel', label: 'Inelegível' }, { value: 'pendente', label: 'Pendente' }]} />
            {hasFilter && <Btn variant="ghost" size="sm" onClick={clear}><X size={13} aria-hidden /> Limpar</Btn>}
            <span className="text-[12px] text-text-secondary ml-auto whitespace-nowrap">{sorted.length} de {rows.length}</span>
          </div>
          {!sorted.length ? <EmptyState icon={Search} title="Nenhum fornecedor com esses filtros" description="Ajuste a busca ou os filtros." /> : (
            <Card className="overflow-hidden">
              <table className="w-full text-[14px]">
                <caption className="sr-only">Fornecedores com situação de diligência, KYS/KYG e faixa de elegibilidade. Use o botão no fim de cada linha para abrir a ficha.</caption>
                <thead className={tableHeadCls}><tr>
                  <SortTh label="Fornecedor" k="nome" sort={sort} setSort={setSort} />
                  <th scope="col" className="px-4 py-2.5 font-semibold">CNPJ / CPF</th>
                  <SortTh label="Diligência" k="diligencia" sort={sort} setSort={setSort} />
                  <SortTh label="KYS / KYG" k="kyc" sort={sort} setSort={setSort} />
                  <SortTh label="Elegibilidade" k="elegivel" sort={sort} setSort={setSort} />
                  <th scope="col" className="px-4 py-2.5 font-semibold text-right">Ação</th>
                </tr></thead>
                <tbody>
                  {sorted.map((r: any) => (
                    <tr key={r.doc} className="border-t border-line hover:bg-primary/5 cursor-pointer" onClick={() => openFornecedor(r.doc)}>
                      <td className="px-4 py-2.5 max-w-[240px] truncate font-medium uppercase">{r.nome || '—'}</td>
                      <td className="px-4 py-2.5 font-mono whitespace-nowrap">{r.docFmt}</td>
                      <td className="px-4 py-2.5">{dilChip(r.diligencia)}</td>
                      <td className="px-4 py-2.5">{kycChip(r.kyc)}</td>
                      <td className="px-4 py-2.5">{faixaChip(r.faixa)}</td>
                      <td className="px-4 py-2.5 text-right">
                        <IconBtn label={`Abrir ficha de ${r.nome || r.docFmt}`} onClick={(e) => { e.stopPropagation(); openFornecedor(r.doc); }}><ChevronRight size={16} aria-hidden /></IconBtn>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

// ── Ficha do Fornecedor (header de status + abas acessíveis) ─────────────────────
const UFS = ['AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO'];
const isValidEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || ''));
const isValidPhone = (s: string) => { const d = onlyDigits(s); return d.length === 10 || d.length === 11; };
const CAD_GROUPS: { title: string; fields: { k: string; label: string; full?: boolean; multi?: boolean; t?: 'uf' | 'banco' | 'cep' | 'tel' | 'email' }[] }[] = [
  { title: 'Identificação', fields: [
    { k: 'razaoSocial', label: 'Razão social', full: true }, { k: 'nomeFantasia', label: 'Nome fantasia', full: true },
    { k: 'tipo', label: 'Tipo (matriz/filial)' }, { k: 'porte', label: 'Porte' },
    { k: 'situacaoCadastral', label: 'Situação cadastral' }, { k: 'dataSituacao', label: 'Situação desde' },
    { k: 'motivoSituacao', label: 'Motivo da situação', full: true },
    { k: 'naturezaJuridica', label: 'Natureza jurídica', full: true }, { k: 'abertura', label: 'Abertura' }, { k: 'capitalSocial', label: 'Capital social' },
    { k: 'cnaePrincipal', label: 'CNAE principal', full: true },
    { k: 'cnaesSecundarios', label: 'CNAEs secundários', full: true, multi: true },
  ] },
  { title: 'Endereço', fields: [
    { k: 'cep', label: 'CEP', t: 'cep' }, { k: 'logradouro', label: 'Logradouro', full: true }, { k: 'numero', label: 'Número' },
    { k: 'complemento', label: 'Complemento' }, { k: 'bairro', label: 'Bairro' }, { k: 'municipio', label: 'Município' }, { k: 'uf', label: 'UF', t: 'uf' },
  ] },
  { title: 'Contato', fields: [{ k: 'telefone', label: 'Telefone', t: 'tel' }, { k: 'email', label: 'E-mail', t: 'email' }] },
  { title: 'Dados bancários', fields: [{ k: 'banco', label: 'Banco', t: 'banco' }, { k: 'agencia', label: 'Agência' }, { k: 'conta', label: 'Conta' }, { k: 'chavePix', label: 'Chave PIX' }] },
];
const sancaoLabel = (s: any) => s.status === 'CONSTA' ? `Consta (${s.hits?.length || 0})` : s.status === 'ATENCAO' ? `Atenção (${s.hits?.length || 0})` : s.status === 'NADA_CONSTA' ? 'Nada consta' : s.status === 'ERRO' ? 'Erro' : 'Pendente';

function FichaFornecedor({ doc, profile, busy, apiFetch, addToast, onRefresh, onReconsultar, onSave, reloadKyc, onBack, onInvite }: any) {
  const [edit, setEdit] = useState(false);
  const [form, setForm] = useState<any>({});
  const [saving, setSaving] = useState(false);
  const [banks, setBanks] = useState<{ code: string; name: string }[]>([]);
  const [cepBusy, setCepBusy] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => { setEdit(false); }, [profile?.doc]); // sai do modo edição ao trocar de fornecedor
  useEffect(() => { fetch('/api/public/kyc/banks').then((r) => r.ok ? r.json() : []).then((b) => setBanks(Array.isArray(b) ? b : [])).catch(() => {}); }, []);
  // foco vai ao título ao abrir/trocar a ficha (navegação SPA acessível)
  useEffect(() => { if (profile) headingRef.current?.focus(); }, [profile?.doc]); // eslint-disable-line react-hooks/exhaustive-deps

  if (busy && !profile) return <div role="status" className="flex items-center gap-3 text-text-secondary text-[14px]"><Loader2 size={20} className="animate-spin text-primary" aria-hidden /> Carregando perfil…</div>;
  if (!profile) return <div className="text-[14px] text-text-secondary">Selecione um fornecedor na base.</div>;
  const c = profile.cadastro || {}; const dil = profile.diligencia; const kyc = profile.kyc; const manual = profile.manual || {}; const fontes = profile.fontes || {};
  const nome = c.razaoSocial || '—';
  const startEdit = () => { setForm({ ...c }); setEdit(true); };
  const save = async () => { setSaving(true); const ok = await onSave(form); setSaving(false); if (ok) setEdit(false); };
  const setF = (k: string, v: string) => setForm((p: any) => ({ ...p, [k]: v }));
  const onCepEdit = async (v: string) => {
    setF('cep', v); const d = onlyDigits(v); if (d.length !== 8) return;
    setCepBusy(true);
    try { const r = await fetch(`/api/public/kyc/cep/${d}`); if (r.ok) { const a = await r.json(); setForm((p: any) => ({ ...p, cep: a.cep || v, logradouro: a.logradouro || p.logradouro, bairro: a.bairro || p.bairro, municipio: a.municipio || p.municipio, uf: a.uf || p.uf })); } } catch { /* */ } finally { setCepBusy(false); }
  };
  const inputCls = 'mt-1 w-full bg-bg border border-line rounded px-2.5 py-1.5 text-[12px] text-text focus:border-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40';
  const editControl = (f: any) => {
    if (f.multi) return <textarea value={form[f.k] || ''} onChange={(e) => setF(f.k, e.target.value)} rows={5} className={inputCls + ' resize-y'} />;
    if (f.t === 'uf') return <select value={form[f.k] || ''} onChange={(e) => setF(f.k, e.target.value)} className={inputCls + ' cursor-pointer'}><option value="">—</option>{UFS.map((u) => <option key={u} value={u}>{u}</option>)}</select>;
    if (f.t === 'banco') return <input list="cad-banks" value={form[f.k] || ''} onChange={(e) => setF(f.k, e.target.value)} placeholder="Código - Banco" className={inputCls} />;
    if (f.t === 'cep') return <div className="relative"><input value={form[f.k] || ''} onChange={(e) => onCepEdit(e.target.value)} placeholder="00000-000" className={inputCls} />{cepBusy && <Loader2 size={13} className="animate-spin text-primary absolute right-2 top-[55%] -translate-y-1/2" aria-hidden />}</div>;
    if (f.t === 'tel') { const inv = form[f.k] && !isValidPhone(form[f.k]); return <><input value={form[f.k] || ''} onChange={(e) => setF(f.k, e.target.value)} placeholder="(11) 90000-0000" className={cn(inputCls, inv && 'border-error')} />{inv && <span className="text-[12px] text-error">Telefone inválido (com DDD)</span>}</>; }
    if (f.t === 'email') { const inv = form[f.k] && !isValidEmail(form[f.k]); return <><input type="email" value={form[f.k] || ''} onChange={(e) => setF(f.k, e.target.value)} className={cn(inputCls, inv && 'border-error')} />{inv && <span className="text-[12px] text-error">E-mail inválido</span>}</>; }
    return <input value={form[f.k] || ''} onChange={(e) => setF(f.k, e.target.value)} className={inputCls} />;
  };

  return (
    <div className="space-y-5 max-w-4xl">
      <div className="flex items-center justify-between gap-2">
        <Btn variant="ghost" size="sm" onClick={onBack}><ChevronLeft size={14} aria-hidden /> Fornecedores</Btn>
        <Btn variant="secondary" size="sm" onClick={() => window.open(`/api/fornecedores/${doc}/report.html`, '_blank')}><Printer size={13} aria-hidden /> Imprimir / PDF</Btn>
      </div>

      {/* header: identidade + status num relance */}
      <Card className="p-5">
        <h2 ref={headingRef} tabIndex={-1} className="text-[20px] font-semibold leading-tight outline-none">{nome}</h2>
        <div className="font-mono text-[14px] text-text-secondary mt-0.5">{maskDoc(doc)}</div>
        <div className="grid sm:grid-cols-3 gap-3 mt-4">
          <div className="rounded-none border border-line bg-bg/40 px-3 py-2.5"><div className="text-[12px] text-text-secondary mb-1.5">Diligência</div>{dilChip(dil)}</div>
          <div className="rounded-none border border-line bg-bg/40 px-3 py-2.5"><div className="text-[12px] text-text-secondary mb-1.5">KYS / KYG</div>{kycChip(kyc)}{kyc && <span className="block text-[12px] text-text-secondary mt-1">ano fiscal {kyc.fiscalYear}</span>}</div>
          <div className="rounded-none border border-line bg-bg/40 px-3 py-2.5"><div className="text-[12px] text-text-secondary mb-1.5">Elegibilidade</div>{faixaChip(profile.faixa, true)}</div>
        </div>
      </Card>

      {/* dados cadastrais consolidados (editável) */}
      <Card className="p-5">
        <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
          <div className="text-[14px] font-semibold flex items-center gap-1.5"><Building2 size={15} className="text-primary" aria-hidden /> Dados cadastrais</div>
          <div className="flex items-center gap-2">
            <Btn variant="secondary" size="sm" onClick={onRefresh} disabled={busy}>{busy ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <RefreshCw size={13} aria-hidden />} Atualizar das APIs</Btn>
            {edit ? (<>
              <Btn variant="ghost" size="sm" onClick={() => setEdit(false)}>Cancelar</Btn>
              <Btn size="sm" onClick={save} disabled={saving}>{saving ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <Check size={13} aria-hidden />} Salvar</Btn>
            </>) : <Btn variant="secondary" size="sm" onClick={startEdit}><Pencil size={13} aria-hidden /> Editar</Btn>}
          </div>
        </div>
        <div className="space-y-4">
          <datalist id="cad-banks">{banks.map((b) => <option key={b.code} value={`${b.code} - ${b.name}`} />)}</datalist>
          {CAD_GROUPS.map((g) => (
            <div key={g.title}>
              <div className="text-[12px] font-semibold text-text-secondary mb-2">{g.title}</div>
              <div className="grid sm:grid-cols-2 gap-x-6 gap-y-2.5">
                {g.fields.map((f) => (
                  <div key={f.k} className={f.full ? 'sm:col-span-2' : ''}>
                    {edit ? (
                      <label className="block">
                        <span className="text-[12px] text-text-secondary">{f.label}{manual[f.k] && <span className="text-primary"> · manual</span>}</span>
                        {editControl(f)}
                      </label>
                    ) : f.multi ? (
                      <div>
                        <div className="text-[12px] text-text-secondary mb-1">{f.label}{manual[f.k] && <Chip tone="info" size="sm" className="ml-1.5">manual</Chip>}</div>
                        {c[f.k] ? <ul className="space-y-0.5">{String(c[f.k]).split('\n').filter(Boolean).map((x: string, i: number) => <li key={i} className="text-[12px] text-text flex gap-1.5"><span className="text-text-secondary shrink-0">•</span><span className="break-words">{x}</span></li>)}</ul> : <span className="text-[12px] text-text-secondary">—</span>}
                      </div>
                    ) : (
                      <div className="flex gap-2 text-[12px]"><span className="text-text-secondary min-w-[120px] shrink-0">{f.label}</span>
                        <span className="font-medium break-words">{c[f.k] || '—'}{manual[f.k] && <Chip tone="info" size="sm" className="ml-1.5">manual</Chip>}</span></div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
          <div>
            <div className="text-[12px] font-semibold text-text-secondary mb-2">Observações</div>
            {edit ? <textarea value={form.observacoes || ''} onChange={(e) => setForm({ ...form, observacoes: e.target.value })} rows={3} className="w-full bg-bg border border-line rounded px-3 py-2 text-[12px] text-text focus:border-primary focus:outline-none resize-y" />
              : <div className="text-[12px] text-text">{c.observacoes || '—'}</div>}
          </div>
          {profile.qsa?.length > 0 && (
            <div><div className="text-[12px] font-semibold text-text-secondary mb-2">Quadro societário (Receita)</div>
              <div className="text-[12px] text-text-secondary">{profile.qsa.map((s: any) => `${s.nome}${s.qual ? ` (${s.qual})` : ''}`).join('; ')}</div></div>
          )}
        </div>
        {(fontes.receita || fontes.cep) && (
          <div className="mt-4 pt-3 border-t border-line text-[12px] text-text-secondary leading-relaxed">
            Fontes: {fontes.receita && <span>{fontes.receita.fonte}{fontes.receita.fetchedAt ? ` (${new Date(fontes.receita.fetchedAt).toLocaleDateString('pt-BR')})` : ''}</span>}{fontes.cep && <span> · {fontes.cep.fonte}</span>}. Campos marcados como <b>manual</b> não são sobrescritos ao atualizar das APIs.
          </div>
        )}
      </Card>

      {/* restrições / diligência */}
      <Card className="p-5">
        <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
          <div className="text-[14px] font-semibold flex items-center gap-1.5"><ShieldCheck size={15} className="text-primary" aria-hidden /> Diligência — listas de restrição</div>
          <div className="flex items-center gap-2">
            {dil && <Btn variant="ghost" size="sm" onClick={() => window.open(`/api/diligencia/${doc}/report.html`, '_blank')}>Relatório (PDF)</Btn>}
            {doc.length === 14 && <Btn variant="secondary" size="sm" onClick={onReconsultar} disabled={busy}>{busy ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <RefreshCw size={13} aria-hidden />} Reconsultar</Btn>}
          </div>
        </div>
        {dil ? (
          <div className="space-y-2.5">
            <div>{dilChip(dil)}{dil.checkedAt && <span className="text-[12px] text-text-secondary ml-2">consultada em {new Date(dil.checkedAt).toLocaleString('pt-BR')}</span>}</div>
            {(dil.sancoes || []).map((s: any, i: number) => (
              <div key={i} className="border-b border-line pb-2 last:border-0 last:pb-0">
                <div className="flex items-center justify-between gap-2"><span className="text-[12px] font-semibold">{s.fonte}</span>
                  <Chip tone={s.status === 'CONSTA' ? 'error' : s.status === 'NADA_CONSTA' ? 'success' : s.status === 'ATENCAO' ? 'warning' : 'neutral'} size="sm">{sancaoLabel(s)}</Chip></div>
                {(s.hits || []).map((h: any, j: number) => <div key={j} className="mt-1 text-[12px] bg-error/5 border border-error/20 rounded px-2 py-1.5"><div className="font-semibold text-error">{h.tipo}</div><div className="text-text-secondary">{h.orgao} · vigência {h.dataInicio || '?'}–{h.dataFim || '?'} · processo {h.processo || '—'}</div></div>)}
              </div>
            ))}
          </div>
        ) : busy ? <div role="status" className="flex items-center gap-2 text-text-secondary text-[12px]"><Loader2 size={14} className="animate-spin" aria-hidden /> Consultando…</div>
          : doc.length === 14 ? <EmptyState icon={ShieldCheck} title="Diligência ainda não realizada" description="Consulte a Receita Federal e as listas de restrição (pode levar alguns segundos)." action={<Btn onClick={onReconsultar}><RefreshCw size={14} aria-hidden /> Consultar agora</Btn>} />
          : <div className="text-[12px] text-text-secondary">A diligência (Receita + listas de restrição) aplica-se a CNPJ. Este registro é pessoa física (CPF).</div>}
      </Card>

      {/* KYS / KYG */}
      <div>
        <div className="text-[14px] font-semibold flex items-center gap-1.5 mb-3"><BadgeCheck size={15} className="text-primary" aria-hidden /> Conformidade KYS / KYG</div>
        {kyc ? <KycDetailView current={kyc} busy={false} apiFetch={apiFetch} addToast={addToast} reload={reloadKyc} />
          : <EmptyState icon={BadgeCheck} title="Sem KYS/KYG" description="Este fornecedor ainda não preencheu a ficha de conformidade (exigida para contratações específicas)." action={<Btn variant="secondary" onClick={onInvite}><Link2 size={14} aria-hidden /> Gerar convite KYS/KYG</Btn>} />}
      </div>
    </div>
  );
}

function HistoricoView({ history, openFornecedor }: any) {
  const [q, setQ] = useState(''); const qd = onlyDigits(q);
  const filtered = history.filter((h: any) => { if (!q) return true; const hay = `${h.razaoSocial || ''} ${maskDoc(h.cnpj)}`.toLowerCase(); return hay.includes(q.toLowerCase()) || (qd && onlyDigits(h.cnpj).includes(qd)); });
  return (
    <div className="space-y-4">
      {!history.length ? <EmptyState icon={History} title="Nenhuma diligência realizada" description="Consulte um fornecedor na base ou no campo do topo." /> : (
        <>
          <SearchInput value={q} onChange={setQ} placeholder="Buscar por nome ou CNPJ" className="w-full sm:w-[260px]" />
          <Card className="overflow-hidden">
            <table className="w-full text-[14px]">
              <caption className="sr-only">Histórico de diligências realizadas. Use o botão no fim de cada linha para abrir a ficha do fornecedor.</caption>
              <thead className={tableHeadCls}><tr>
                <th scope="col" className="px-4 py-2.5 font-semibold">Fornecedor</th><th scope="col" className="px-4 py-2.5 font-semibold">CNPJ</th>
                <th scope="col" className="px-4 py-2.5 font-semibold">Resultado</th><th scope="col" className="px-4 py-2.5 font-semibold">Consulta</th>
                <th scope="col" className="px-4 py-2.5 font-semibold text-right">Ação</th>
              </tr></thead>
              <tbody>
                {filtered.map((h: any) => (
                  <tr key={h.cnpj} className="border-t border-line hover:bg-primary/5 cursor-pointer" onClick={() => openFornecedor(h.cnpj)}>
                    <td className="px-4 py-2.5 max-w-[280px] truncate">{h.razaoSocial || '—'}</td>
                    <td className="px-4 py-2.5 font-mono whitespace-nowrap">{maskDoc(h.cnpj)}</td>
                    <td className="px-4 py-2.5">{h.verdict ? <Chip tone={DIL[h.verdict]?.tone} icon={DIL[h.verdict]?.icon} size="sm">{DIL[h.verdict]?.label || h.verdict}</Chip> : '—'}</td>
                    <td className="px-4 py-2.5 text-text-secondary whitespace-nowrap">{new Date(h.checkedAt).toLocaleString('pt-BR')}{h.valida ? '' : ' · vencida'}</td>
                    <td className="px-4 py-2.5 text-right">
                      <IconBtn label={`Abrir ficha de ${h.razaoSocial || maskDoc(h.cnpj)}`} onClick={(e) => { e.stopPropagation(); openFornecedor(h.cnpj); }}><ChevronRight size={16} aria-hidden /></IconBtn>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}
    </div>
  );
}

function ImportModal({ onClose, onSubmit }: { onClose: () => void; onSubmit: (text: string) => Promise<boolean> }) {
  const [text, setText] = useState(''); const [busy, setBusy] = useState(false); const fileRef = useRef<HTMLInputElement>(null);
  const count = (text.match(/\d[\d.\-/]{11,}\d/g) || []).map(onlyDigits).filter((d) => d.length === 14).length;
  const submit = async () => { setBusy(true); const ok = await onSubmit(text); setBusy(false); if (ok) onClose(); };
  return (
    <Modal title="Importar CNPJs" onClose={onClose} size="md">
      <div className="p-6 space-y-4">
        <p className="text-[12px] text-text-secondary leading-relaxed">Cole uma lista de CNPJs (um por linha ou CSV) ou envie um arquivo .csv/.txt. Eles entram na base e a diligência é gerada automaticamente.</p>
        <Btn variant="secondary" onClick={() => fileRef.current?.click()}><FileUp size={14} aria-hidden /> Selecionar arquivo (.csv / .txt)</Btn>
        <input ref={fileRef} type="file" accept=".csv,.txt,text/csv,text/plain" className="hidden" aria-label="Arquivo de CNPJs"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) { const fr = new FileReader(); fr.onload = () => setText(String(fr.result || '')); fr.readAsText(f); } e.currentTarget.value = ''; }} />
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={8} placeholder={'00.026.572/0001-40\n01724345000150\n…'}
          className="w-full bg-bg border border-line rounded px-3 py-2 text-[12px] font-mono text-text focus:border-primary focus:outline-none resize-y" />
        <div className="flex items-center justify-between gap-3">
          <span className="text-[12px] text-text-secondary">{count} CNPJ(s) válido(s)</span>
          <div className="flex gap-2"><Btn variant="ghost" onClick={onClose}>Cancelar</Btn><Btn onClick={submit} disabled={busy || count === 0}>{busy ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />} Importar</Btn></div>
        </div>
      </div>
    </Modal>
  );
}

function AjudaFornecedores() {
  const blocks = [
    { t: 'O que é o cockpit', d: 'Reúne, por fornecedor (CNPJ/CPF), a Diligência (Receita Federal + listas de restrição CEIS/CNEP/CEPIM/Leniência) e o KYS/KYG (cadastro verificado + assinatura eletrônica) numa só visão. A base lista todos os fornecedores das prestações de contas (Auditoria + FEAC), dos CNPJs importados e dos KYS/KYG preenchidos.' },
    { t: 'Painel e filtros', d: 'Os cartões no topo (Fornecedores, Elegível 2 SM+, Elegível até 2 SM, Inelegíveis, Pendentes) filtram a base com um clique. Há ainda filtros por diligência, KYS/KYG, tipo (PJ/PF), elegibilidade, busca por nome/CNPJ/CPF e ordenação clicando nos cabeçalhos. Cada linha tem um botão para abrir a ficha (acessível por teclado).' },
    { t: 'Diligência', d: 'Consulta automática por CNPJ na Receita (situação cadastral, endereço com CEP, quadro societário) e nas listas de restrição. Roda sozinha para novos e vencidos (validade 30 dias) e pode ser forçada no botão "Consultar não consultados" ou no campo do topo.' },
    { t: 'Atualizar tudo das APIs', d: 'O botão "Atualizar tudo das APIs" recarrega de uma vez os dados cadastrais (Receita Federal + CEP) de toda a base — a lista e as fichas. Roda em segundo plano, com barra de progresso, e preserva os campos editados manualmente (marcados como "manual"). É a atualização cadastral leve; as listas de restrição continuam pelo fluxo de diligência.' },
    { t: 'KYS / KYG', d: 'Fichas de conformidade preenchidas pelo próprio fornecedor numa página pública (/kys, /kyg) e assinadas via Documenso, exigidas apenas para contratações específicas. Use o botão "Convites" para gerar links rastreáveis. A elegibilidade indica quem está sem restrições + respostas adequadas + impostos/previdência em dia.' },
    { t: 'Ficha do fornecedor', d: 'Abra qualquer fornecedor para ver, numa só tela, o status no topo, os dados cadastrais consolidados e editáveis (Receita + CEP), a diligência (listas de restrição) e o KYS/KYG (respostas, trilha de conformidade e PDF assinado), com as ações Atualizar das APIs, Reconsultar, Imprimir / PDF e gerar convite.' },
  ];
  return (
    <div className="max-w-3xl space-y-5">
      <p className="text-[14px] text-text-secondary leading-relaxed">O <b className="text-text">Cockpit de Fornecedores</b> concentra a diligência e a conformidade (KYS/KYG) de todos os fornecedores num único lugar.</p>
      <div className="space-y-3">{blocks.map((b, i) => <Card key={i} className="p-4"><div className="text-[14px] font-semibold text-primary mb-1">{b.t}</div><div className="text-[12px] text-text-secondary leading-relaxed">{b.d}</div></Card>)}</div>
    </div>
  );
}
