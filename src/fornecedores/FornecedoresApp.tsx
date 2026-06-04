/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Cockpit de Fornecedores (Tool C+D unificada).
 *
 * Concentra, por fornecedor (CNPJ/CPF), a Diligência (Receita + listas de restrição) e
 * o KYS/KYG (cadastro verificado + assinatura) num só lugar. A diferença entre
 * fornecedores é apenas ter ou não KYS/KYG assinado. Reaproveita os componentes de
 * detalhe da Diligência (ResultadoView) e do KYS/KYG (DetailView) e a gestão de
 * convites — substituindo os dois cards antigos do lançador por um único cockpit.
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  Building2, BookOpen, Link2, Loader2, Search, RefreshCw, ChevronRight, ChevronLeft,
  ShieldCheck, ShieldAlert, AlertTriangle, Upload, FileUp, ClipboardList, BadgeCheck, History,
} from 'lucide-react';
import { cn } from '../lib/utils';
import { AuthUser } from '../types';
import { Btn, Chip, Card, ToolSidebar, ToolHeader, SidebarItem, SkipLink, EmptyState, tableHeadCls, Select, SearchInput, Modal } from '../ui/kit';
import type { ChipTone } from '../ui/kit';
import { ResultadoView } from '../diligencia/DiligenciaApp';
import { BaseView as KycListView, ConvitesView, DetailView as KycDetailView } from '../kyc/KycApp';
import { onlyDigits, maskDoc, KYC_TYPE_LABEL, KYC_STATUS_LABEL } from '../kyc/kycTypes';
import type { KycStatus } from '../kyc/kycTypes';

export interface FornecedoresAppProps {
  user: AuthUser;
  apiFetch: (url: string, opts?: RequestInit) => Promise<Response>;
  addToast: (kind: 'success' | 'error' | 'info', message: string) => void;
  onHome: () => void;
  navigate?: (path: string) => void;
  initialDoc?: string;
}

type Section = 'base' | 'kyc' | 'historico' | 'ajuda' | 'detalhe';
const segs = () => window.location.pathname.split('/').filter(Boolean);
const path = (s: Section, doc?: string) =>
  s === 'detalhe' && doc ? `/fornecedores/${doc}` : s === 'base' ? '/fornecedores' : `/fornecedores/${s}`;
const HEADERS: Record<Section, [string, string]> = {
  base: ['Cockpit de', 'Fornecedores'], kyc: ['Gestão de', 'KYS / KYG'], historico: ['Histórico de', 'Diligências'],
  ajuda: ['Como', 'usar'], detalhe: ['Ficha do', 'Fornecedor'],
};

const DIL: Record<string, { tone: ChipTone; icon: React.ElementType; label: string }> = {
  NADA_CONSTA: { tone: 'success', icon: ShieldCheck, label: 'Nada consta' },
  ALERTA: { tone: 'error', icon: ShieldAlert, label: 'Alerta' },
  PENDENTE: { tone: 'warning', icon: AlertTriangle, label: 'Pendente' },
};
const kycStatusChip = (k: any) => {
  if (!k) return <span className="text-[10px] text-text-secondary">—</span>;
  const vencido = k.status === 'assinado' && !k.valida;
  const tone: ChipTone = vencido ? 'warning' : k.status === 'assinado' ? 'success' : k.status === 'aguardando_assinatura' ? 'warning' : 'neutral';
  return <Chip tone={tone} size="sm">{vencido ? 'Vencido' : KYC_STATUS_LABEL[k.status as KycStatus]}{k.type ? ` · ${String(k.type).toUpperCase()}` : ''}</Chip>;
};

export default function FornecedoresApp({ user, apiFetch, addToast, onHome, navigate, initialDoc }: FornecedoresAppProps) {
  const [section, setSection] = useState<Section>('base');
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [kycRecords, setKycRecords] = useState<any[]>([]);
  const [history, setHistory] = useState<any[]>([]);
  const [cnpjInput, setCnpjInput] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  // detalhe
  const [dDoc, setDDoc] = useState('');
  const [dDil, setDDil] = useState<any>(null);
  const [dKyc, setDKyc] = useState<any>(null);
  const [dBusy, setDBusy] = useState(false);

  const loadRows = async () => { setLoading(true); try { const r = await apiFetch('/api/fornecedores'); if (r.ok) setRows(await r.json()); } catch { /* */ } finally { setLoading(false); } };
  const loadKyc = async () => { try { const r = await apiFetch('/api/kyc'); if (r.ok) setKycRecords(await r.json()); } catch { /* */ } };
  const loadHistory = async () => { try { const r = await apiFetch('/api/diligencia'); if (r.ok) setHistory(await r.json()); } catch { /* */ } };
  useEffect(() => { loadRows(); loadKyc(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // progresso da fila de diligência automática
  const [queue, setQueue] = useState<any>(null);
  const lastDone = useRef(-1);
  useEffect(() => {
    let alive = true; let t: ReturnType<typeof setTimeout>;
    const tick = async () => {
      let q: any = null;
      try { const r = await apiFetch('/api/diligencia/queue'); if (r.ok) q = await r.json(); } catch { /* */ }
      if (!alive) return;
      setQueue(q);
      if (q && q.done !== lastDone.current) { if (lastDone.current !== -1) loadRows(); lastDone.current = q.done; }
      t = setTimeout(tick, q && (q.running || q.pending > 0) ? 4000 : 30000);
    };
    tick();
    return () => { alive = false; clearTimeout(t); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const openFornecedor = async (doc: string, kycId?: string) => {
    const d = onlyDigits(doc);
    setSection('detalhe'); setDDoc(d); setDDil(null); setDKyc(null); setDBusy(true);
    navigate?.(path('detalhe', d));
    try {
      const row = rows.find((r) => r.doc === d);
      const kid = kycId || row?.kyc?.id;
      const tasks: Promise<void>[] = [];
      if (d.length === 14) tasks.push(apiFetch(`/api/diligencia/${d}`).then(async (r) => { if (r.ok) setDDil(await r.json()); }).catch(() => {}));
      if (kid) tasks.push(apiFetch(`/api/kyc/${kid}`).then(async (r) => { if (r.ok) setDKyc(await r.json()); }).catch(() => {}));
      await Promise.all(tasks);
    } finally { setDBusy(false); }
  };
  const openByKycId = async (id: string) => {
    try { const r = await apiFetch(`/api/kyc/${id}`); if (!r.ok) return; const rec = await r.json(); const doc = onlyDigits(rec.kys?.cnpj || rec.kyg?.documento); openFornecedor(doc, id); }
    catch { addToast('error', 'Falha ao abrir.'); }
  };

  const runCheck = async (cnpj: string, force = false) => {
    const d = onlyDigits(cnpj);
    if (d.length !== 14) { addToast('error', 'Informe um CNPJ válido (14 dígitos).'); return; }
    if (section !== 'detalhe') { setSection('detalhe'); setDDoc(d); setDDil(null); setDKyc(null); navigate?.(path('detalhe', d)); }
    setDBusy(true);
    try {
      const r = await apiFetch(`/api/diligencia/${d}/check${force ? '?force=1' : ''}`, { method: 'POST' });
      if (!r.ok) throw new Error((await r.json().catch(() => ({} as any))).error || 'Falha na diligência');
      const rec = await r.json(); setDDil(rec);
      addToast(rec.verdict === 'ALERTA' ? 'error' : 'success', rec.verdict === 'ALERTA' ? 'Diligência concluída — ALERTA.' : 'Diligência concluída — nada consta.');
      loadRows();
    } catch (e: any) { addToast('error', e.message); } finally { setDBusy(false); }
  };

  const runAll = async () => {
    try { const r = await apiFetch('/api/diligencia/run-all', { method: 'POST' }); const j = await r.json();
      addToast(j.queued ? 'info' : 'success', j.queued ? `${j.queued} fornecedor(es) na fila de diligência.` : 'Tudo em dia.');
    } catch { addToast('error', 'Falha ao iniciar.'); }
  };
  const doImport = async (text: string): Promise<boolean> => {
    try { const r = await apiFetch('/api/diligencia/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
      const j = await r.json().catch(() => ({})); if (!r.ok) { addToast('error', j.error || 'Falha ao importar.'); return false; }
      addToast('success', `Importados ${j.recebidos} CNPJ(s): ${j.adicionados} novo(s).`); loadRows(); return true;
    } catch { addToast('error', 'Falha ao importar.'); return false; }
  };

  const goSection = (s: Section) => { setSection(s); if (s === 'historico') loadHistory(); if (s === 'kyc') loadKyc(); navigate?.(path(s)); };
  const applyPath = () => {
    const s = segs(); if (s[0] !== 'fornecedores') return; const a = s[1];
    if (!a) setSection('base'); else if (a === 'kyc') { setSection('kyc'); loadKyc(); } else if (a === 'historico') { setSection('historico'); loadHistory(); }
    else if (a === 'ajuda') setSection('ajuda'); else openFornecedor(a);
  };
  useEffect(() => { if (initialDoc) openFornecedor(initialDoc); else applyPath(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const onPop = () => applyPath(); window.addEventListener('popstate', onPop); return () => window.removeEventListener('popstate', onPop); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const navItems: { id: Section; label: string; icon: React.ElementType }[] = [
    { id: 'base', label: 'Fornecedores', icon: Building2 },
    { id: 'kyc', label: 'KYS / KYG', icon: BadgeCheck },
    { id: 'historico', label: 'Histórico', icon: History },
    { id: 'ajuda', label: 'Como usar', icon: BookOpen },
  ];

  return (
    <div className="flex min-h-screen pt-8">
      <SkipLink />
      <ToolSidebar brand="Fornecedores" onHome={onHome} user={user}>
        {navItems.map((it) => <SidebarItem key={it.id} icon={it.icon} active={section === it.id} onClick={() => goSection(it.id)}>{it.label}</SidebarItem>)}
      </ToolSidebar>

      <main id="main-content" className="ml-[216px] flex-1 min-w-[820px] flex flex-col">
        <ToolHeader light={HEADERS[section][0]} accent={HEADERS[section][1]} right={
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-2 bg-card border border-line rounded px-3 py-1.5 focus-within:border-primary">
              <Search size={14} className="text-text-secondary" aria-hidden />
              <input value={cnpjInput} onChange={(e) => setCnpjInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && runCheck(cnpjInput)}
                aria-label="CNPJ a consultar" placeholder="CNPJ a consultar" className="bg-transparent text-[13px] outline-none w-[150px] sm:w-[170px]" />
            </label>
            <Btn onClick={() => runCheck(cnpjInput)} disabled={dBusy}>Consultar</Btn>
          </div>
        } />

        <div className="flex-1 overflow-y-auto px-6 sm:px-10 py-8 pb-24">
          {section === 'base' && <CockpitBase rows={rows} loading={loading} openFornecedor={openFornecedor} queue={queue} runAll={runAll} onImport={() => setImportOpen(true)} />}
          {section === 'kyc' && <KycSection records={kycRecords} apiFetch={apiFetch} addToast={addToast} openByKycId={openByKycId} reload={loadKyc} />}
          {section === 'historico' && <HistoricoView history={history} openFornecedor={openFornecedor} />}
          {section === 'ajuda' && <AjudaFornecedores />}
          {section === 'detalhe' && (
            <FichaFornecedor doc={dDoc} dil={dDil} kyc={dKyc} busy={dBusy} apiFetch={apiFetch} addToast={addToast}
              runCheck={runCheck} reloadKyc={() => dKyc && apiFetch(`/api/kyc/${dKyc.id}`).then((r) => r.ok && r.json().then(setDKyc))}
              onBack={() => goSection('base')} onInvite={() => goSection('kyc')} />
          )}
        </div>
      </main>
      {importOpen && <ImportModal onClose={() => setImportOpen(false)} onSubmit={doImport} />}
    </div>
  );
}

function CockpitBase({ rows, loading, openFornecedor, queue, runAll, onImport }: any) {
  const [q, setQ] = useState(''); const [df, setDf] = useState('all'); const [kf, setKf] = useState('all'); const [ef, setEf] = useState('all'); const [origem, setOrigem] = useState('all');
  const qd = onlyDigits(q);
  const origens: string[] = (Array.from(new Set(rows.flatMap((r: any) => r.origens || []))) as string[]).sort();
  const unconsulted = rows.filter((r: any) => r.doc.length === 14 && (!r.diligencia || !r.diligencia.valida)).length;
  const filtered = rows.filter((r: any) => {
    if (q) { const hay = `${r.nome || ''} ${r.docFmt || ''}`.toLowerCase(); if (!hay.includes(q.toLowerCase()) && !(qd && r.doc.includes(qd))) return false; }
    if (df !== 'all') { if (df === 'none') { if (r.diligencia) return false; } else if (r.diligencia?.verdict !== df) return false; }
    if (kf !== 'all') { if (kf === 'none') { if (r.kyc) return false; } else if (kf === 'assinado') { if (!(r.kyc?.status === 'assinado' && r.kyc?.valida)) return false; } else if (r.kyc?.status !== kf) return false; }
    if (ef !== 'all') { const e = r.kyc?.elegivel === true ? 'sim' : r.kyc?.elegivel === false ? 'nao' : 'na'; if (e !== ef) return false; }
    if (origem !== 'all' && !(r.origens || []).includes(origem)) return false;
    return true;
  });
  const active = !!queue && (queue.running || queue.pending > 0);
  return (
    <div className="space-y-5 animate-in fade-in duration-300">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <p className="text-[13px] text-text-secondary max-w-2xl">
          Todos os fornecedores num só lugar: a <b className="text-text">Diligência</b> (Receita + listas de restrição) e o
          <b className="text-text"> KYS/KYG</b> (cadastro verificado + assinatura). O KYS/KYG é exigido apenas para contratações
          específicas — aqui você vê quem já tem assinado e gere os pendentes. Diligências de novos/vencidos rodam automaticamente.
        </p>
        <div className="flex items-center gap-2 shrink-0">
          <Btn variant="secondary" onClick={onImport}><Upload size={14} aria-hidden /> Importar CNPJs</Btn>
          <Btn variant="secondary" onClick={runAll} disabled={unconsulted === 0}><RefreshCw size={14} aria-hidden /> Consultar não consultados{unconsulted ? ` (${unconsulted})` : ''}</Btn>
        </div>
      </div>

      {active && (
        <Card className="p-3 flex items-center gap-3 border-primary/40">
          <Loader2 size={16} className="animate-spin text-primary shrink-0" aria-hidden />
          <div className="text-[12px]"><span className="font-semibold text-text">Consultando em segundo plano…</span>{' '}
            <span className="text-text-secondary">{queue.done} concluída(s) · {queue.pending} na fila{queue.failed ? ` · ${queue.failed} erro(s)` : ''} · limite {queue.ratePerMin}/min</span></div>
        </Card>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-text-secondary text-[13px]"><Loader2 size={16} className="animate-spin" aria-hidden /> Carregando…</div>
      ) : !rows.length ? (
        <EmptyState icon={Building2} title="Nenhum fornecedor ainda" description="A base é montada das prestações de contas (Auditoria + FEAC), importação de CNPJs e dos KYS/KYG. Consulte um CNPJ no campo acima." />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <SearchInput value={q} onChange={setQ} placeholder="Buscar por nome ou CNPJ/CPF" className="w-full sm:w-[240px]" />
            <Select value={df} onChange={setDf} options={[{ value: 'all', label: 'Diligência: todas' }, { value: 'ALERTA', label: 'Alerta' }, { value: 'NADA_CONSTA', label: 'Nada consta' }, { value: 'PENDENTE', label: 'Pendente' }, { value: 'none', label: 'Não consultada' }]} />
            <Select value={kf} onChange={setKf} options={[{ value: 'all', label: 'KYS/KYG: todos' }, { value: 'assinado', label: 'Assinado (válido)' }, { value: 'aguardando_assinatura', label: 'Aguardando' }, { value: 'none', label: 'Sem KYS/KYG' }]} />
            <Select value={ef} onChange={setEf} options={[{ value: 'all', label: 'Elegibilidade' }, { value: 'sim', label: 'Elegível' }, { value: 'nao', label: 'Inelegível' }]} />
            {origens.length > 1 && <Select value={origem} onChange={setOrigem} options={[{ value: 'all', label: 'Todas as origens' }, ...origens.map((o) => ({ value: o, label: o }))]} />}
            {(q || df !== 'all' || kf !== 'all' || ef !== 'all' || origem !== 'all') && <Btn variant="ghost" size="sm" onClick={() => { setQ(''); setDf('all'); setKf('all'); setEf('all'); setOrigem('all'); }}>Limpar</Btn>}
            <span className="text-[11px] text-text-secondary ml-auto whitespace-nowrap">{filtered.length} de {rows.length}</span>
          </div>
          {!filtered.length ? <EmptyState icon={Search} title="Nenhum fornecedor com esses filtros" description="Ajuste a busca ou os filtros." /> : (
            <Card className="overflow-hidden">
              <table className="w-full text-[12px]">
                <thead className={tableHeadCls}><tr>
                  <th scope="col" className="px-4 py-2.5 font-semibold">Fornecedor</th>
                  <th scope="col" className="px-4 py-2.5 font-semibold">CNPJ / CPF</th>
                  <th scope="col" className="px-4 py-2.5 font-semibold">Origem</th>
                  <th scope="col" className="px-4 py-2.5 font-semibold">Diligência</th>
                  <th scope="col" className="px-4 py-2.5 font-semibold">KYS / KYG</th>
                  <th scope="col" className="px-4 py-2.5 font-semibold">Elegível</th>
                  <th scope="col" className="px-4 py-2.5 font-semibold text-right">Ação</th>
                </tr></thead>
                <tbody>
                  {filtered.map((r: any) => (
                    <tr key={r.doc} className="border-t border-line hover:bg-primary/5 cursor-pointer" onClick={() => openFornecedor(r.doc)}>
                      <td className="px-4 py-2.5 max-w-[240px] truncate">{r.nome || '—'}</td>
                      <td className="px-4 py-2.5 font-mono whitespace-nowrap">{r.docFmt}</td>
                      <td className="px-4 py-2.5 text-text-secondary">{(r.origens || []).join(', ')}</td>
                      <td className="px-4 py-2.5">{r.diligencia ? <Chip tone={DIL[r.diligencia.verdict]?.tone} icon={DIL[r.diligencia.verdict]?.icon} size="sm">{DIL[r.diligencia.verdict]?.label || r.diligencia.verdict}</Chip> : <span className="text-[10px] text-text-secondary">não consultada</span>}</td>
                      <td className="px-4 py-2.5">{kycStatusChip(r.kyc)}</td>
                      <td className="px-4 py-2.5">{r.kyc?.elegivel === true ? <Chip tone="success" size="sm">Elegível</Chip> : r.kyc?.elegivel === false ? <Chip tone="error" size="sm">Inelegível</Chip> : <span className="text-text-secondary">—</span>}</td>
                      <td className="px-4 py-2.5 text-right"><ChevronRight size={14} className="inline text-text-secondary" aria-hidden /></td>
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

function FichaFornecedor({ doc, dil, kyc, busy, apiFetch, addToast, runCheck, reloadKyc, onBack, onInvite }: any) {
  const nome = dil?.razaoSocial || kyc?.kys?.razaoSocial || kyc?.kyg?.nome || '—';
  return (
    <div className="space-y-6 animate-in fade-in duration-300 max-w-4xl">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <button onClick={onBack} className="inline-flex items-center gap-1 text-[11px] text-text-secondary hover:text-primary uppercase tracking-wider mb-1"><ChevronLeft size={13} /> Fornecedores</button>
          <div className="text-[18px] font-bold leading-tight">{nome}</div>
          <div className="text-[12px] text-text-secondary font-mono">{maskDoc(doc)}</div>
        </div>
      </div>

      <section>
        <div className="text-[12px] font-bold uppercase tracking-widest text-text-secondary mb-3 flex items-center gap-1.5"><ShieldCheck size={14} className="text-primary" /> Diligência</div>
        {dil ? (
          <ResultadoView current={dil} busy={busy} apiFetch={apiFetch} addToast={addToast} runCheck={runCheck} />
        ) : busy ? (
          <div className="flex items-center gap-2 text-text-secondary text-[13px]"><Loader2 size={16} className="animate-spin" aria-hidden /> Consultando…</div>
        ) : doc.length === 14 ? (
          <EmptyState icon={ShieldCheck} title="Diligência ainda não realizada" description="Rode a consulta à Receita Federal e às listas de restrição." action={<Btn onClick={() => runCheck(doc)}><RefreshCw size={14} /> Consultar agora</Btn>} />
        ) : (
          <Card className="p-4 text-[12px] text-text-secondary">A diligência automática (Receita + listas) aplica-se a CNPJ. Este registro é pessoa física (CPF).</Card>
        )}
      </section>

      <section>
        <div className="text-[12px] font-bold uppercase tracking-widest text-text-secondary mb-3 flex items-center gap-1.5"><BadgeCheck size={14} className="text-primary" /> KYS / KYG</div>
        {kyc ? (
          <KycDetailView current={kyc} busy={false} apiFetch={apiFetch} addToast={addToast} reload={reloadKyc} />
        ) : (
          <EmptyState icon={BadgeCheck} title="Sem KYS/KYG" description="Este fornecedor ainda não preencheu a ficha de conformidade. O KYS/KYG é exigido para contratações específicas." action={<Btn variant="secondary" onClick={onInvite}><Link2 size={14} /> Gerar convite KYS/KYG</Btn>} />
        )}
      </section>
    </div>
  );
}

function KycSection({ records, apiFetch, addToast, openByKycId, reload }: any) {
  const [tab, setTab] = useState<'lista' | 'convites'>('lista');
  return (
    <div className="space-y-5 animate-in fade-in duration-300">
      <div className="flex items-center gap-2">
        <Btn variant={tab === 'lista' ? 'primary' : 'secondary'} size="sm" onClick={() => { setTab('lista'); reload(); }}><ClipboardList size={13} /> Conformidades</Btn>
        <Btn variant={tab === 'convites' ? 'primary' : 'secondary'} size="sm" onClick={() => setTab('convites')}><Link2 size={13} /> Convites</Btn>
      </div>
      {tab === 'lista' ? <KycListView records={records} loading={false} openDetail={openByKycId} /> : <ConvitesView apiFetch={apiFetch} addToast={addToast} />}
    </div>
  );
}

function HistoricoView({ history, openFornecedor }: any) {
  const [q, setQ] = useState('');
  const qd = onlyDigits(q);
  const filtered = history.filter((h: any) => { if (!q) return true; const hay = `${h.razaoSocial || ''} ${maskDoc(h.cnpj)}`.toLowerCase(); return hay.includes(q.toLowerCase()) || (qd && onlyDigits(h.cnpj).includes(qd)); });
  return (
    <div className="space-y-4 animate-in fade-in duration-300">
      {!history.length ? <EmptyState icon={History} title="Nenhuma diligência realizada" description="Consulte um fornecedor na base ou no campo do topo." /> : (
        <>
          <SearchInput value={q} onChange={setQ} placeholder="Buscar por nome ou CNPJ" className="w-full sm:w-[260px]" />
          <Card className="overflow-hidden">
            <table className="w-full text-[12px]">
              <thead className={tableHeadCls}><tr>
                <th scope="col" className="px-4 py-2.5 font-semibold">Fornecedor</th><th scope="col" className="px-4 py-2.5 font-semibold">CNPJ</th>
                <th scope="col" className="px-4 py-2.5 font-semibold">Resultado</th><th scope="col" className="px-4 py-2.5 font-semibold">Consulta</th>
              </tr></thead>
              <tbody>
                {filtered.map((h: any) => (
                  <tr key={h.cnpj} className="border-t border-line hover:bg-primary/5 cursor-pointer" onClick={() => openFornecedor(h.cnpj)}>
                    <td className="px-4 py-2.5 max-w-[280px] truncate">{h.razaoSocial || '—'}</td>
                    <td className="px-4 py-2.5 font-mono whitespace-nowrap">{maskDoc(h.cnpj)}</td>
                    <td className="px-4 py-2.5">{h.verdict ? <Chip tone={DIL[h.verdict]?.tone} icon={DIL[h.verdict]?.icon} size="sm">{DIL[h.verdict]?.label || h.verdict}</Chip> : '—'}</td>
                    <td className="px-4 py-2.5 text-text-secondary whitespace-nowrap">{new Date(h.checkedAt).toLocaleString('pt-BR')}{h.valida ? '' : ' · vencida'}</td>
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
          <span className="text-[11px] text-text-secondary">{count} CNPJ(s) válido(s)</span>
          <div className="flex gap-2"><Btn variant="ghost" onClick={onClose}>Cancelar</Btn><Btn onClick={submit} disabled={busy || count === 0}>{busy ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />} Importar</Btn></div>
        </div>
      </div>
    </Modal>
  );
}

function AjudaFornecedores() {
  const blocks = [
    { t: 'O que é o cockpit', d: 'Reúne, por fornecedor (CNPJ/CPF), a Diligência (Receita Federal + listas de restrição CEIS/CNEP/CEPIM/Leniência) e o KYS/KYG (cadastro verificado + assinatura eletrônica). A base lista todos os fornecedores das prestações de contas (Auditoria + FEAC), dos CNPJs importados e dos KYS/KYG preenchidos.' },
    { t: 'Diligência', d: 'Consulta automática por CNPJ na Receita (situação cadastral, endereço com CEP, quadro societário) e nas listas de restrição. Roda sozinha para novos e vencidos (validade 30 dias) e pode ser forçada no botão "Consultar não consultados" ou no campo do topo. Veredito Nada consta / Alerta / Pendente.' },
    { t: 'KYS / KYG', d: 'O KYS (fornecedores) e o KYG (organizações/lideranças) são fichas de conformidade preenchidas pelo próprio fornecedor numa página pública (/kys, /kyg) e assinadas via Documenso. São exigidos apenas para contratações específicas. Na aba KYS/KYG você acompanha as conformidades e gera convites rastreáveis.' },
    { t: 'Elegibilidade', d: 'Quando há KYS/KYG, o sistema indica se o fornecedor é Elegível: sem restrições + respostas de risco "Não" + impostos/previdência em dia. Use os filtros para encontrar pendências.' },
    { t: 'Ficha do fornecedor', d: 'Abra qualquer fornecedor para ver tudo num lugar: o cadastro da Receita, as listas de restrição e o KYS/KYG (status, respostas, trilha de conformidade e PDF assinado), além das ações de reconsultar e gerar convite.' },
  ];
  return (
    <div className="max-w-3xl space-y-5 animate-in fade-in duration-300">
      <p className="text-[13px] text-text-secondary leading-relaxed">O <b className="text-text">Cockpit de Fornecedores</b> concentra a diligência e a conformidade (KYS/KYG) de todos os fornecedores num único lugar.</p>
      <div className="space-y-3">{blocks.map((b, i) => <Card key={i} className="p-4"><div className="text-[13px] font-bold text-primary mb-1">{b.t}</div><div className="text-[12px] text-text-secondary leading-relaxed">{b.d}</div></Card>)}</div>
    </div>
  );
}
