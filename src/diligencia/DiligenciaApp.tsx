/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Diligência de Fornecedores (Tool C) — consulta de CNPJ na Receita + listas de
 * restrição (Portal da Transparência: CEIS/CNEP/CEPIM/Leniência) com relatório
 * auditável (PDF), base de fornecedores persistente e validade de 30 dias.
 */
import React, { useState, useEffect, useRef } from 'react';
import {
  Building2, Search, Loader2, ShieldCheck, ShieldAlert, AlertTriangle,
  FileDown, RefreshCw, History, ExternalLink, ChevronRight, BookOpen, Upload, FileUp,
} from 'lucide-react';
import { cn } from '../lib/utils';
import { AuthUser } from '../types';
import { Btn, Chip, Card, Modal, ToolSidebar, ToolHeader, SidebarItem, SkipLink, EmptyState, tableHeadCls, Select, SearchInput } from '../ui/kit';
import type { ChipTone } from '../ui/kit';

type Section = 'base' | 'resultado' | 'historico' | 'ajuda';

export interface DiligenciaAppProps {
  user: AuthUser;
  apiFetch: (url: string, opts?: RequestInit) => Promise<Response>;
  addToast: (kind: 'success' | 'error' | 'info', message: string) => void;
  onHome: () => void;
  initialCnpj?: string;
  navigate?: (path: string) => void;
}

const pathSegs = () => window.location.pathname.split('/').filter(Boolean);

const VERDICT: Record<string, { label: string; tone: ChipTone; icon: React.ElementType }> = {
  NADA_CONSTA: { label: 'Nada consta', tone: 'success', icon: ShieldCheck },
  ALERTA: { label: 'Alerta', tone: 'error', icon: ShieldAlert },
  PENDENTE: { label: 'Pendente', tone: 'warning', icon: AlertTriangle },
};

function VerdictChip({ v }: { v: string }) {
  const m = VERDICT[v] || VERDICT.PENDENTE;
  return <Chip tone={m.tone} icon={m.icon}>{m.label}</Chip>;
}

const onlyDigits = (s: string) => (s || '').replace(/\D/g, '');
const maskCnpj = (d: string) => { const x = onlyDigits(d); return x.length === 14 ? `${x.slice(0, 2)}.${x.slice(2, 5)}.${x.slice(5, 8)}/${x.slice(8, 12)}-${x.slice(12)}` : d; };
const dilPath = (s: Section, cnpj?: string) => {
  if (s === 'resultado') return cnpj ? `/diligencia/${cnpj}` : '/diligencia';
  if (s === 'historico') return '/diligencia/historico';
  if (s === 'ajuda') return '/diligencia/ajuda';
  return '/diligencia';
};
const DIL_HEADERS: Record<Section, [string, string]> = {
  base:      ['Diligência de', 'Fornecedores'],
  resultado: ['Relatório de', 'Diligência'],
  historico: ['Histórico de', 'Diligências'],
  ajuda:     ['Como', 'usar'],
};

async function dl(apiFetch: DiligenciaAppProps['apiFetch'], url: string, name: string) {
  const res = await apiFetch(url);
  if (!res.ok) throw new Error((await res.json().catch(() => ({} as any))).error || 'Falha no download');
  const blob = await res.blob();
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export default function DiligenciaApp({ user, apiFetch, addToast, onHome, initialCnpj, navigate }: DiligenciaAppProps) {
  const [section, setSection] = useState<Section>('base');
  const [suppliers, setSuppliers] = useState<any[]>([]);
  const [suppliersLoading, setSuppliersLoading] = useState(false);
  const [history, setHistory] = useState<any[]>([]);
  const [cnpjInput, setCnpjInput] = useState('');
  const [current, setCurrent] = useState<any | null>(null);
  const [busy, setBusy] = useState(false);

  const loadSuppliers = async () => {
    setSuppliersLoading(true);
    try { const r = await apiFetch('/api/diligencia/suppliers'); if (r.ok) setSuppliers(await r.json()); } catch { /* */ } finally { setSuppliersLoading(false); }
  };
  const loadHistory = async () => { try { const r = await apiFetch('/api/diligencia'); if (r.ok) setHistory(await r.json()); } catch { /* */ } };
  useEffect(() => { loadSuppliers(); loadHistory(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── progresso da fila de diligências (automática + "consultar todos") ────────
  const [queue, setQueue] = useState<any>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastDoneRef = useRef(-1);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      let q: any = null;
      try { const r = await apiFetch('/api/diligencia/queue'); if (r.ok) q = await r.json(); } catch { /* */ }
      if (!alive) return;
      setQueue(q);
      if (q && q.done !== lastDoneRef.current) {
        if (lastDoneRef.current !== -1) { loadSuppliers(); loadHistory(); } // alguma diligência concluiu
        lastDoneRef.current = q.done;
      }
      const active = !!q && (q.running || q.pending > 0);
      pollRef.current = setTimeout(tick, active ? 4000 : 30000);
    };
    tick();
    return () => { alive = false; if (pollRef.current) clearTimeout(pollRef.current); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const runAll = async () => {
    try {
      const r = await apiFetch('/api/diligencia/run-all', { method: 'POST' });
      if (!r.ok) throw new Error();
      const j = await r.json();
      addToast(j.queued ? 'info' : 'success', j.queued ? `${j.queued} fornecedor(es) enviados para a fila de diligência.` : 'Tudo em dia — nenhuma diligência pendente.');
      try { const q = await apiFetch('/api/diligencia/queue'); if (q.ok) setQueue(await q.json()); } catch { /* */ }
    } catch { addToast('error', 'Falha ao iniciar as consultas.'); }
  };

  const [importOpen, setImportOpen] = useState(false);
  const doImport = async (text: string): Promise<boolean> => {
    try {
      const r = await apiFetch('/api/diligencia/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { addToast('error', j.error || 'Falha ao importar.'); return false; }
      addToast('success', `Importados ${j.recebidos} CNPJ(s): ${j.adicionados} novo(s) na base, ${j.naFila} na fila${j.jaValidos ? `, ${j.jaValidos} já com diligência válida` : ''}.`);
      loadSuppliers(); loadHistory();
      try { const q = await apiFetch('/api/diligencia/queue'); if (q.ok) setQueue(await q.json()); } catch { /* */ }
      return true;
    } catch { addToast('error', 'Falha ao importar.'); return false; }
  };

  // navega entre seções dando a cada uma sua URL exata (compartilhável)
  const goSection = (s: Section) => { setSection(s); if (s === 'historico') loadHistory(); navigate?.(dilPath(s)); };

  // routing: aplica a URL atual em deep-link/reload e em back/forward
  const applyPath = () => {
    const seg = pathSegs();
    if (seg[0] !== 'diligencia') return;
    const a = seg[1];
    if (!a) setSection('base');
    else if (a === 'historico') setSection('historico');
    else if (a === 'ajuda') setSection('ajuda');
    else if (onlyDigits(a).length === 14) openSaved(a);
    else setSection('base');
  };
  useEffect(() => { applyPath(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onPop = () => applyPath();
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const runCheck = async (cnpj: string, force = false) => {
    const d = onlyDigits(cnpj);
    if (d.length !== 14) { addToast('error', 'Informe um CNPJ válido (14 dígitos).'); return; }
    setBusy(true); setSection('resultado'); setCurrent(null);
    try {
      const r = await apiFetch(`/api/diligencia/${d}/check${force ? '?force=1' : ''}`, { method: 'POST' });
      if (!r.ok) throw new Error((await r.json().catch(() => ({} as any))).error || 'Falha na diligência');
      const rec = await r.json();
      setCurrent(rec);
      navigate?.(`/diligencia/${d}`);
      addToast(rec.verdict === 'ALERTA' ? 'error' : 'success', rec.verdict === 'ALERTA' ? 'Diligência concluída — ALERTA: restrições encontradas.' : 'Diligência concluída — nada consta.');
      loadSuppliers(); loadHistory();
    } catch (e: any) { addToast('error', e.message); setSection('base'); }
    finally { setBusy(false); }
  };
  const openSaved = async (cnpj: string) => {
    setBusy(true); setSection('resultado'); setCurrent(null);
    try { const r = await apiFetch(`/api/diligencia/${onlyDigits(cnpj)}`); if (r.ok) { setCurrent(await r.json()); navigate?.(`/diligencia/${onlyDigits(cnpj)}`); } else { addToast('error', 'Diligência não encontrada — execute uma nova.'); setSection('base'); } }
    catch { addToast('error', 'Falha ao abrir.'); setSection('base'); } finally { setBusy(false); }
  };

  const navItems: { id: Section; label: string; icon: React.ElementType }[] = [
    { id: 'base', label: 'Base de fornecedores', icon: Building2 },
    { id: 'historico', label: 'Histórico', icon: History },
    { id: 'ajuda', label: 'Como usar', icon: BookOpen },
  ];

  return (
    <div className="flex min-h-screen pt-8">
      <SkipLink />
      <ToolSidebar brand="Diligência" onHome={onHome} user={user}>
        {navItems.map(it => (
          <SidebarItem key={it.id} icon={it.icon} active={section === it.id} onClick={() => goSection(it.id)}>{it.label}</SidebarItem>
        ))}
      </ToolSidebar>

      <main id="main-content" className="ml-[256px] flex-1 min-w-[820px] flex flex-col">
        <ToolHeader
          light={DIL_HEADERS[section][0]} accent={DIL_HEADERS[section][1]}
          right={
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-2 bg-card border border-line rounded px-3 py-1.5 focus-within:border-primary">
                <Search size={14} className="text-text-secondary" aria-hidden />
                <input value={cnpjInput} onChange={e => setCnpjInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && runCheck(cnpjInput)}
                  aria-label="CNPJ a consultar" placeholder="CNPJ a consultar" className="bg-transparent text-[14px] outline-none w-[150px] sm:w-[170px]" />
              </label>
              <Btn onClick={() => runCheck(cnpjInput)} disabled={busy}>Consultar</Btn>
            </div>
          }
        />

        <div className="flex-1 overflow-y-auto px-6 sm:px-10 py-8 pb-24">
          {section === 'base' && <BaseView {...{ suppliers, suppliersLoading, runCheck, openSaved, queue, runAll, onImport: () => setImportOpen(true) }} />}
          {section === 'historico' && <HistoricoView {...{ history, openSaved, loadHistory }} />}
          {section === 'ajuda' && <AjudaDilig />}
          {section === 'resultado' && <ResultadoView {...{ current, busy, apiFetch, addToast, runCheck }} />}
        </div>
      </main>
      {importOpen && <ImportModal onClose={() => setImportOpen(false)} onSubmit={doImport} />}
    </div>
  );
}

function ImportModal({ onClose, onSubmit }: { onClose: () => void; onSubmit: (text: string) => Promise<boolean> }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const count = (text.match(/\d[\d.\-/]{11,}\d/g) || []).map(onlyDigits).filter((d) => d.length === 14).length;
  const loadFile = (f: File) => { const fr = new FileReader(); fr.onload = () => setText(String(fr.result || '')); fr.readAsText(f); };
  const submit = async () => { setBusy(true); const ok = await onSubmit(text); setBusy(false); if (ok) onClose(); };
  return (
    <Modal title="Importar CNPJs" onClose={onClose} size="md">
      <div className="p-6 space-y-4">
        <p className="text-[12px] text-text-secondary leading-relaxed">
          Cole uma lista de CNPJs (um por linha, ou um CSV — o sistema extrai os de 14 dígitos) ou selecione um arquivo
          <span className="font-mono"> .csv</span>/<span className="font-mono">.txt</span>. Os CNPJs entram na base de fornecedores e a diligência é gerada
          automaticamente (novos e vencidos), no limite de chamadas por minuto.
        </p>
        <Btn variant="secondary" onClick={() => fileRef.current?.click()}><FileUp size={14} aria-hidden /> Selecionar arquivo (.csv / .txt)</Btn>
        <input ref={fileRef} type="file" accept=".csv,.txt,text/csv,text/plain" className="hidden" aria-label="Arquivo de CNPJs"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) loadFile(f); e.currentTarget.value = ''; }} />
        <label className="block">
          <span className="text-[12px] text-text-secondary">CNPJs</span>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={8} placeholder={'00.026.572/0001-40\n01724345000150\n…'}
            className="mt-1 w-full bg-bg border border-line rounded px-3 py-2 text-[12px] font-mono text-text focus:border-primary focus:outline-none resize-y" />
        </label>
        <div className="flex items-center justify-between gap-3">
          <span className="text-[12px] text-text-secondary">{count} CNPJ(s) válido(s) detectado(s)</span>
          <div className="flex gap-2">
            <Btn variant="ghost" onClick={onClose}>Cancelar</Btn>
            <Btn onClick={submit} disabled={busy || count === 0}>{busy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Upload size={14} aria-hidden />} Importar e consultar</Btn>
          </div>
        </div>
      </div>
    </Modal>
  );
}

function ChipStatus({ s }: { s: any }) {
  const valida = s?.valida;
  if (!s) return <span className="text-[12px] text-text-secondary">não consultado</span>;
  return (
    <span className="inline-flex items-center gap-1.5">
      <VerdictChip v={s.verdict} />
      <span className={cn('text-[12px]', valida ? 'text-text-secondary' : 'text-warning')}>{valida ? `válida até ${new Date(s.validUntil).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })}` : 'vencida'}</span>
    </span>
  );
}

function AjudaDilig() {
  const blocks = [
    { t: 'O que é verificado', d: 'Situação cadastral na Receita Federal (Ativa/Baixada/Inapta/Suspensa, natureza jurídica, porte, capital, CNAE principal e secundários, endereço e quadro societário) e as listas de restrição do Portal da Transparência/CGU: CEIS (inidôneas e suspensas), CNEP (Lei Anticorrupção), CEPIM (entidades sem fins lucrativos impedidas) e Acordos de Leniência.' },
    { t: 'Como consultar', d: 'Em "Base de fornecedores", consulte qualquer fornecedor das prestações já realizadas (Auditoria + FEAC); ou digite um CNPJ novo no campo do topo (em qualquer tela) e clique em Consultar. O resultado sai em segundos e ganha uma URL própria (/diligencia/CNPJ) que pode ser compartilhada.' },
    { t: 'Geração automática', d: 'O sistema gera as diligências sozinho, em segundo plano: sempre que surgem fornecedores novos (de novas prestações) e sempre que uma diligência vence (30 dias), eles entram numa fila e são consultados respeitando um limite de chamadas por minuto às APIs oficiais. O botão "Consultar todos os não consultados" na Base força essa fila imediatamente; o andamento aparece numa faixa de progresso.' },
    { t: 'Importar uma lista de CNPJs', d: 'Na Base, o botão "Importar CNPJs" abre uma janela onde você cola uma lista (um por linha) ou envia um arquivo .csv/.txt — o sistema extrai os CNPJs de 14 dígitos, adiciona à base de fornecedores e gera a diligência de cada um automaticamente (e os renova quando vencerem).' },
    { t: 'Lendo o resultado', d: 'O veredito é "Nada consta" (verde), "Alerta" (vermelho — há sanção em alguma lista OU o cadastro não está Ativo) ou "Pendente" (não foi possível concluir as verificações). Veja os dados completos da Receita, o status de cada lista e, quando "Consta", o tipo de sanção, órgão, vigência, processo e fundamentação.' },
    { t: 'Como filtramos por CNPJ', d: 'O filtro por CNPJ da API do Portal da Transparência é inoperante (devolve a lista inteira). Por isso consultamos cada lista pela razão social do fornecedor (obtida na Receita) e filtramos os resultados pelo CNPJ exato — varrendo todas as páginas da resposta, para não perder uma sanção que esteja além da primeira página. Na prática, a verificação combina nome + CNPJ.' },
    { t: 'Validade e auditoria', d: 'Cada diligência vale 30 dias e fica registrada com data-hora, IP e solicitante. Exporte o relatório em PDF (documento monocromático, pronto para arquivo) ou os dados em TXT e guarde junto à prestação de contas. Use "Reconsultar" para forçar uma nova consulta antes do vencimento.' },
    { t: 'Fontes complementares', d: 'Lista Suja do Trabalho Escravo (MTE), IBAMA (embargos) e TCU/CNJ têm o download automatizado bloqueado pelos órgãos — verifique-as manualmente quando o risco exigir (ex.: IBAMA para serviços ambientais).' },
  ];
  return (
    <div className="max-w-3xl space-y-5">
      <p className="text-[14px] text-text-secondary leading-relaxed">A <b className="text-text">Diligência de Fornecedores</b> verifica um fornecedor por CNPJ em fontes oficiais e gera um relatório auditável e exportável. Faça a diligência <b className="text-text">antes de contratar</b> e <b className="text-text">antes de pagar</b> fornecedores relevantes.</p>
      <div className="space-y-3">
        {blocks.map((b, i) => (
          <Card key={i} className="p-4">
            <div className="text-[14px] font-semibold text-primary mb-1">{b.t}</div>
            <div className="text-[12px] text-text-secondary leading-relaxed">{b.d}</div>
          </Card>
        ))}
      </div>
    </div>
  );
}

function BaseView({ suppliers, suppliersLoading, runCheck, openSaved, queue, runAll, onImport }: any) {
  const pendingSet = new Set<string>(((queue?.pendingCnpjs as string[]) || []).map(onlyDigits));
  const processingCnpj = onlyDigits(queue?.processing || '');
  const active = !!queue && (queue.running || queue.pending > 0);
  const unconsulted = suppliers.filter((s: any) => !s.diligencia || !s.diligencia.valida).length;

  // filtros
  const [q, setQ] = useState('');
  const [vf, setVf] = useState('all');
  const [origem, setOrigem] = useState('all');
  const qd = onlyDigits(q);
  const origens: string[] = (Array.from(new Set(suppliers.flatMap((s: any) => s.origens || []))) as string[]).sort();
  const filtered = suppliers.filter((s: any) => {
    if (q) { const hay = `${s.nome || ''} ${s.cnpjFormatado || ''}`.toLowerCase(); if (!hay.includes(q.toLowerCase()) && !(qd && onlyDigits(s.cnpj).includes(qd))) return false; }
    if (vf !== 'all') { if (vf === 'none') { if (s.diligencia) return false; } else if (s.diligencia?.verdict !== vf) return false; }
    if (origem !== 'all' && !(s.origens || []).includes(origem)) return false;
    return true;
  });
  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <p className="text-[14px] text-text-secondary max-w-2xl">
          Fornecedores extraídos de todas as prestações de contas já realizadas (Auditoria + FEAC). As diligências de
          fornecedores <b className="text-text">novos</b> e <b className="text-text">vencidos</b> são geradas
          automaticamente em segundo plano (no limite de {queue?.ratePerMin || 100} consultas/min). Você também pode
          forçar agora, ou consultar um CNPJ avulso no campo do topo. Cada diligência vale 30 dias.
        </p>
        <div className="flex items-center gap-2 shrink-0">
          <Btn variant="secondary" onClick={onImport}><Upload size={14} aria-hidden /> Importar CNPJs</Btn>
          <Btn variant="secondary" onClick={runAll} disabled={unconsulted === 0}>
            <RefreshCw size={14} aria-hidden /> Consultar todos os não consultados{unconsulted ? ` (${unconsulted})` : ''}
          </Btn>
        </div>
      </div>

      {active && (
        <Card className="p-3 flex items-center gap-3 border-primary/40">
          <Loader2 size={16} className="animate-spin text-primary shrink-0" aria-hidden />
          <div className="text-[12px]">
            <span className="font-semibold text-text">Consultando fornecedores em segundo plano…</span>{' '}
            <span className="text-text-secondary">
              {queue.done} concluída(s) · {queue.pending} na fila
              {queue.processing ? ` · agora: ${maskCnpj(queue.processing)}` : ''}
              {queue.failed ? ` · ${queue.failed} com erro` : ''} · limite {queue.ratePerMin}/min
            </span>
          </div>
        </Card>
      )}

      {suppliersLoading ? (
        <div className="flex items-center gap-2 text-text-secondary text-[14px]"><Loader2 size={16} className="animate-spin" aria-hidden /> Carregando base…</div>
      ) : !suppliers.length ? (
        <EmptyState icon={Building2} title="Nenhum fornecedor com CNPJ na base ainda"
          description="A base é montada a partir das prestações de contas. Digite um CNPJ no campo acima para consultar um fornecedor novo." />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <SearchInput value={q} onChange={setQ} placeholder="Buscar por nome ou CNPJ" className="w-full sm:w-[260px]" />
            <Select value={vf} onChange={setVf} options={[
              { value: 'all', label: 'Todos os resultados' },
              { value: 'ALERTA', label: 'Alerta' },
              { value: 'NADA_CONSTA', label: 'Nada consta' },
              { value: 'PENDENTE', label: 'Pendente' },
              { value: 'none', label: 'Não consultado' },
            ]} />
            {origens.length > 1 && <Select value={origem} onChange={setOrigem} options={[{ value: 'all', label: 'Todas as origens' }, ...origens.map((o) => ({ value: o, label: o }))]} />}
            {(q || vf !== 'all' || origem !== 'all') && <Btn variant="ghost" size="sm" onClick={() => { setQ(''); setVf('all'); setOrigem('all'); }}>Limpar</Btn>}
            <span className="text-[12px] text-text-secondary ml-auto whitespace-nowrap">{filtered.length} de {suppliers.length}</span>
          </div>

          {!filtered.length ? (
            <EmptyState icon={Search} title="Nenhum fornecedor com esses filtros" description="Ajuste a busca ou os filtros acima." />
          ) : (
            <Card className="overflow-hidden">
              <table className="w-full text-[12px]">
                <thead className={tableHeadCls}><tr>
                  <th scope="col" className="px-4 py-2.5 font-semibold">Fornecedor</th>
                  <th scope="col" className="px-4 py-2.5 font-semibold">CNPJ</th>
                  <th scope="col" className="px-4 py-2.5 font-semibold">Origem</th>
                  <th scope="col" className="px-4 py-2.5 font-semibold">Diligência</th>
                  <th scope="col" className="px-4 py-2.5 font-semibold text-right">Ação</th>
                </tr></thead>
                <tbody>
                  {filtered.map((s: any) => {
                    const d = onlyDigits(s.cnpj);
                    return (
                    <tr key={s.cnpj} className="border-t border-line hover:bg-primary/5">
                      <td className="px-4 py-2.5 max-w-[280px] truncate">{s.nome || '—'}</td>
                      <td className="px-4 py-2.5 font-mono whitespace-nowrap">{s.cnpjFormatado}</td>
                      <td className="px-4 py-2.5 text-text-secondary">{(s.origens || []).join(', ')}</td>
                      <td className="px-4 py-2.5"><ChipStatus s={s.diligencia} /></td>
                      <td className="px-4 py-2.5 text-right whitespace-nowrap">
                        {processingCnpj === d ? (
                          <span className="inline-flex items-center gap-1 text-primary text-[12px]"><Loader2 size={12} className="animate-spin" aria-hidden /> consultando…</span>
                        ) : pendingSet.has(d) ? (
                          <span className="text-text-secondary text-[12px]">na fila…</span>
                        ) : (<>
                          {s.diligencia?.valida && <button onClick={() => openSaved(s.cnpj)} className="text-primary hover:underline mr-3 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">Ver</button>}
                          <button onClick={() => runCheck(s.cnpj, !!s.diligencia?.valida)} className="text-primary hover:underline rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{s.diligencia ? 'Reconsultar' : 'Consultar'}</button>
                        </>)}
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

function HistoricoView({ history, openSaved }: any) {
  const [q, setQ] = useState('');
  const [vf, setVf] = useState('all');
  const [val, setVal] = useState('all');
  const qd = onlyDigits(q);
  const filtered = history.filter((h: any) => {
    if (q) { const hay = `${h.razaoSocial || ''} ${maskCnpj(h.cnpj)}`.toLowerCase(); if (!hay.includes(q.toLowerCase()) && !(qd && onlyDigits(h.cnpj).includes(qd))) return false; }
    if (vf !== 'all' && h.verdict !== vf) return false;
    if (val === 'valida' && !h.valida) return false;
    if (val === 'vencida' && h.valida) return false;
    return true;
  });
  return (
    <div className="space-y-4">
      {!history.length ? (
        <EmptyState icon={History} title="Nenhuma diligência realizada ainda" description="Consulte um fornecedor na Base ou digite um CNPJ no campo do topo." />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <SearchInput value={q} onChange={setQ} placeholder="Buscar por nome ou CNPJ" className="w-full sm:w-[260px]" />
            <Select value={vf} onChange={setVf} options={[
              { value: 'all', label: 'Todos os resultados' },
              { value: 'ALERTA', label: 'Alerta' },
              { value: 'NADA_CONSTA', label: 'Nada consta' },
              { value: 'PENDENTE', label: 'Pendente' },
            ]} />
            <Select value={val} onChange={setVal} options={[
              { value: 'all', label: 'Todas as validades' },
              { value: 'valida', label: 'Válidas' },
              { value: 'vencida', label: 'Vencidas' },
            ]} />
            {(q || vf !== 'all' || val !== 'all') && <Btn variant="ghost" size="sm" onClick={() => { setQ(''); setVf('all'); setVal('all'); }}>Limpar</Btn>}
            <span className="text-[12px] text-text-secondary ml-auto whitespace-nowrap">{filtered.length} de {history.length}</span>
          </div>
          {!filtered.length ? (
            <EmptyState icon={Search} title="Nenhuma diligência com esses filtros" description="Ajuste a busca ou os filtros acima." />
          ) : (
            <Card className="overflow-hidden">
              <table className="w-full text-[12px]">
                <thead className={tableHeadCls}><tr>
                  <th scope="col" className="px-4 py-2.5 font-semibold">Fornecedor</th><th scope="col" className="px-4 py-2.5 font-semibold">CNPJ</th>
                  <th scope="col" className="px-4 py-2.5 font-semibold">Resultado</th><th scope="col" className="px-4 py-2.5 font-semibold">Consulta</th>
                  <th scope="col" className="px-4 py-2.5 font-semibold text-right">Ação</th>
                </tr></thead>
                <tbody>
                  {filtered.map((h: any) => (
                    <tr key={h.cnpj} className="border-t border-line hover:bg-primary/5 cursor-pointer" onClick={() => openSaved(h.cnpj)}>
                      <td className="px-4 py-2.5 max-w-[280px] truncate">{h.razaoSocial || '—'}</td>
                      <td className="px-4 py-2.5 font-mono whitespace-nowrap">{maskCnpj(h.cnpj)}</td>
                      <td className="px-4 py-2.5"><VerdictChip v={h.verdict} /></td>
                      <td className="px-4 py-2.5 text-text-secondary whitespace-nowrap">{new Date(h.checkedAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })} {h.valida ? '' : '· vencida'}</td>
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

const ST_LABEL = (s: any) => s.status === 'CONSTA' ? `Consta (${s.hits?.length || 0})` : s.status === 'NADA_CONSTA' ? 'Nada consta' : s.status === 'ERRO' ? 'Erro' : 'Pendente';
// #103 — sub-linha técnica de proveniência (espelha provTech do backend; a URL já aparece como link na linha principal).
const provTechLine = (s: any): string => {
  const out = [s.metodo || 'GET'];
  if (s.http != null) out.push(`HTTP ${s.http}`);
  if (s.cache) { const a = s.cacheAge != null ? (s.cacheAge < 172800000 ? `${Math.round(s.cacheAge / 3600000)} h` : `${Math.round(s.cacheAge / 86400000)} d`) : '?'; const up = s.sourceUpdatedAt ? new Date(s.sourceUpdatedAt).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : ''; out.push(`cache${s.stale ? ' (vencido)' : ''} (idade ${a}${up ? ` · cópia de ${up}` : ''})`); }
  else if (s.http != null || s.ms != null) out.push(`ao vivo${s.ms != null ? ` · ${s.ms} ms` : ''}`);
  if (s.erro) out.push(`erro: ${s.erro}`);
  return out.join(' · ');
};
const KVr = ({ k, v, cls }: { k: string; v: any; cls?: string }) => (
  <div className="flex gap-2 text-[12px]"><span className="text-text-secondary min-w-[120px] shrink-0">{k}</span><span className={cn('font-medium break-words', cls)}>{v || '—'}</span></div>
);

export function ResultadoView({ current, busy, apiFetch, addToast, runCheck }: any) {
  if (busy && !current) return <div className="flex items-center gap-3 text-text-secondary text-[14px]"><Loader2 size={20} className="animate-spin text-primary" aria-hidden /> Consultando Receita Federal e listas de restrição…</div>;
  if (!current) return <div className="text-[14px] text-text-secondary">Selecione um fornecedor ou informe um CNPJ.</div>;
  const r = current;
  const rf = r.receita || {};
  const ender = [rf.logradouro, rf.numero, rf.complemento, rf.bairro].filter(Boolean).join(', ');
  const openReport = () => window.open(`/api/diligencia/${r.cnpj}/report.html`, '_blank');
  const downloadTxt = async () => { try { await dl(apiFetch, `/api/diligencia/${r.cnpj}/txt`, `diligencia_${r.cnpj}.txt`); } catch (e: any) { addToast('error', e.message); } };
  return (
    <div className="space-y-5 max-w-4xl">
      <Card className="p-5">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <div className="text-[16px] font-semibold">{r.razaoSocial || '—'}</div>
            <div className="text-[12px] text-text-secondary font-mono">{maskCnpj(r.cnpj)}{rf.nome_fantasia ? ` · ${rf.nome_fantasia}` : ''}</div>
          </div>
          <VerdictChip v={r.verdict} />
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <Btn onClick={openReport}><FileDown size={14} aria-hidden /> Exportar PDF</Btn>
          <Btn variant="secondary" onClick={downloadTxt}><FileDown size={14} aria-hidden /> Baixar dados (TXT)</Btn>
          <Btn variant="secondary" onClick={() => runCheck(r.cnpj, true)} disabled={busy}><RefreshCw size={14} aria-hidden /> Reconsultar</Btn>
        </div>
      </Card>

      {/* Dados da consulta (auditável) */}
      <Card className="p-5">
        <div className="text-[12px] font-semibold text-text-secondary mb-3">Dados da consulta (auditável)</div>
        <div className="grid sm:grid-cols-2 gap-x-6 gap-y-1">
          <KVr k="Data/hora" v={new Date(r.checkedAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })} />
          <KVr k="Validade" v={`${new Date(r.validUntil).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })}${r.valida ? '' : ' (vencida)'}`} cls={r.valida ? '' : 'text-warning'} />
          <KVr k="Solicitante" v={r.checkedBy} />
          <KVr k="IP de origem" v={r.ip} />
        </div>
        <div className="mt-3 pt-3 border-t border-line space-y-1">
          <div className="text-[12px] text-text-secondary mb-1">Memória do processo — fontes consultadas</div>
          {(r.fontesCount || r.diligenciaId) && <div className="text-[12px] text-text-secondary mb-1 break-all">{r.fontesCount ? `${r.fontesCount} fontes${r.fontesVersao ? ` (conjunto v${r.fontesVersao})` : ''}` : ''}{r.diligenciaId ? ` · ID ${r.diligenciaId}` : ''}{r.tempoTotalMs != null ? ` · tempo ${(r.tempoTotalMs / 1000).toFixed(1)} s` : ''}{r.integridadeHash ? ` · SHA-256 ${String(r.integridadeHash).slice(0, 16)}…` : ''}</div>}
          {rf.fonte && <div className="text-[12px] flex flex-wrap gap-x-2"><span className="text-text-secondary">{rf.fonte}:</span> <span>{rf.fetchedAt ? new Date(rf.fetchedAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '—'}</span>{rf.apiUrl && <a href={rf.apiUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline break-all">{rf.apiUrl}</a>}</div>}
          {rf.cepFonte && <div className="text-[12px] flex flex-wrap gap-x-2"><span className="text-text-secondary">{rf.cepFonte}:</span> <span>{rf.cepFetchedAt ? new Date(rf.cepFetchedAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '—'}</span>{rf.cepApiUrl && <a href={rf.cepApiUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline break-all">{rf.cepApiUrl}</a>}</div>}
          {(r.sancoes || []).map((s: any, i: number) => (
            <div key={i}>
              <div className="text-[12px] flex flex-wrap gap-x-2">
                <span className="text-text-secondary">{s.fonte}:</span>
                <span className={s.status === 'CONSTA' ? 'text-error font-semibold' : s.status === 'NADA_CONSTA' ? 'text-success' : 'text-warning'}>{ST_LABEL(s)}</span>
                <span className="text-text-secondary">{s.fetchedAt ? new Date(s.fetchedAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : ''}</span>
                {s.apiUrl && <a href={s.apiUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline break-all">{s.apiUrl}</a>}
              </div>
              {(s.metodo || s.http != null || s.cache) && <div className="text-[12px] text-text-secondary pl-3 break-all">↳ {provTechLine(s)}</div>}
            </div>
          ))}
        </div>
      </Card>

      {/* Receita Federal — completo */}
      <Card className="p-5">
        <div className="text-[12px] font-semibold text-text-secondary mb-3 flex items-center gap-1.5"><Building2 size={13} aria-hidden /> Receita Federal — cadastro</div>
        {r.receita ? (
          <div className="grid sm:grid-cols-2 gap-x-6 gap-y-1">
            <KVr k="Situação" v={`${rf.situacao_cadastral || '—'}${rf.data_situacao ? ` (desde ${rf.data_situacao})` : ''}`} cls={/ATIVA/i.test(rf.situacao_cadastral || '') ? 'text-success' : 'text-error'} />
            {rf.motivo_situacao && <KVr k="Motivo" v={rf.motivo_situacao} />}
            <KVr k="Natureza" v={rf.natureza_juridica} />
            <KVr k="Porte" v={rf.porte} />
            <KVr k="Abertura" v={rf.abertura} />
            <KVr k="Capital social" v={rf.capital_social} />
            <div className="sm:col-span-2"><KVr k="CNAE principal" v={rf.cnae_principal} /></div>
            {rf.cnaes_secundarios?.length > 0 && <div className="sm:col-span-2"><KVr k="CNAEs secundários" v={rf.cnaes_secundarios.join(' · ')} /></div>}
            <div className="sm:col-span-2"><KVr k="Endereço" v={ender} /></div>
            <KVr k="Município / UF" v={`${rf.municipio || '—'} / ${rf.uf || '—'}`} />
            <KVr k="CEP" v={rf.cep} />
            <KVr k="Telefone" v={rf.telefone} />
            <KVr k="E-mail" v={rf.email} />
            {rf.qsa?.length > 0 && <div className="sm:col-span-2"><KVr k="Quadro societário" v={rf.qsa.map((s: any) => `${s.nome}${s.qual ? ` (${s.qual})` : ''}`).join('; ')} /></div>}
          </div>
        ) : <div className="text-[12px] text-error">Não foi possível obter os dados cadastrais.</div>}
      </Card>

      {/* Listas de restrição */}
      <Card className="p-5">
        <div className="text-[12px] font-semibold text-text-secondary mb-3 flex items-center gap-1.5"><ShieldAlert size={13} aria-hidden /> Listas de restrição — Portal da Transparência (CGU)</div>
        <div className="space-y-3">
          {(r.sancoes || []).map((s: any, i: number) => (
            <div key={i} className="border-b border-line pb-3 last:border-0 last:pb-0">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[12px] font-semibold">{s.fonte}</span>
                <span className={cn('text-[12px] font-semibold px-2 py-0.5 rounded border',
                  s.status === 'CONSTA' ? 'bg-error/10 text-error border-error/30' : s.status === 'NADA_CONSTA' ? 'bg-success/10 text-success border-success/30' : 'bg-warning/10 text-warning border-warning/40')}>{ST_LABEL(s)}</span>
              </div>
              {(s.hits || []).map((h: any, j: number) => (
                <div key={j} className="mt-1.5 text-[12px] bg-error/5 border border-error/20 rounded px-2 py-1.5">
                  <div className="font-semibold text-error">{h.tipo}</div>
                  <div className="text-text-secondary">{h.orgao} · vigência {h.dataInicio || '?'}–{h.dataFim || '?'} · processo {h.processo || '—'}</div>
                  {h.fundamentacao && <div className="text-text-secondary mt-0.5">{h.fundamentacao}</div>}
                </div>
              ))}
              {s.url && <a href={s.url} target="_blank" rel="noopener noreferrer" className="text-[12px] text-primary hover:underline inline-flex items-center gap-1 mt-1"><ExternalLink size={10} aria-hidden /> consulta pública</a>}
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
