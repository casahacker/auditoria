/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * FEAC / SGPP — Processador de Prestação de Contas (Tool B).
 * Flow: upload → relatório preliminar editável → tratamento de documentos → Relatório de Prestação de Contas.
 */
import React, { useState, useRef, useMemo, useEffect } from 'react';
import {
  NotebookPen, Upload, Loader2, CheckCircle2, AlertCircle, AlertTriangle,
  Download, FileDown, Search, Building2, X, ChevronRight, Trash2, Package,
  FileCheck2, ArrowRight, ScrollText, PlusCircle, History, BookOpen, FileSpreadsheet, FileSignature, Stamp,
} from 'lucide-react';
import { cn, formatCurrency } from '../lib/utils';
import { AuthUser } from '../types';
import { FeacProcessing, FeacLancamento, FeacMatchStatus, CNPJDataLike, FeacSummary } from './feacTypes';
import {
  Btn, IconBtn, Chip, Card, Modal, ToolSidebar, ToolHeader, SidebarItem, SidebarGroupLabel, SkipLink, EmptyState, tableHeadCls,
} from '../ui/kit';
import type { ChipTone } from '../ui/kit';

type FeacSection = 'historico' | 'upload' | 'preliminar' | 'tratamento' | 'relatorio' | 'ajuda';

const pathSegs = () => window.location.pathname.split('/').filter(Boolean);
const RECORD_SECTIONS: FeacSection[] = ['preliminar', 'tratamento', 'relatorio'];
const feacPath = (s: FeacSection, id?: string) => {
  if (s === 'ajuda') return '/feac/ajuda';
  if (s === 'upload') return '/feac/nova';
  if (s === 'historico') return '/feac';
  return id ? `/feac/${id}/${s}` : '/feac';
};
const FEAC_HEADERS: Record<FeacSection, [string, string]> = {
  historico:  ['Prestações de', 'Contas'],
  upload:     ['Entrada de', 'Documentos'],
  preliminar: ['Relatório', 'Preliminar'],
  tratamento: ['Tratamento de', 'Documentos'],
  relatorio:  ['Prestação de', 'Contas — FEAC'],
  ajuda:      ['Como', 'usar'],
};

export interface FeacAppProps {
  user: AuthUser;
  apiFetch: (url: string, opts?: RequestInit) => Promise<Response>;
  addToast: (kind: 'success' | 'error' | 'info', message: string) => void;
  onHome: () => void;
  navigate?: (path: string) => void;
  initialRecordId?: string;
}

const STATUS_META: Record<FeacMatchStatus, { label: string; tone: ChipTone; icon: React.ElementType }> = {
  OK:               { label: 'Conciliado',      tone: 'success', icon: CheckCircle2 },
  SEM_NF:           { label: 'Sem NF',          tone: 'warning', icon: AlertTriangle },
  SEM_COMPROVANTE:  { label: 'Sem comprov.',    tone: 'warning', icon: AlertTriangle },
  SEM_AMBOS:        { label: 'Sem documentos',  tone: 'error',   icon: AlertCircle },
  VALOR_DIVERGENTE: { label: 'Valor divergente', tone: 'error',  icon: AlertCircle },
  DUPLICADO:        { label: 'Duplicado',       tone: 'error',   icon: AlertCircle },
};

function StatusChip({ status, size = 'md' }: { status: FeacMatchStatus; size?: 'sm' | 'md' }) {
  const m = STATUS_META[status] || STATUS_META.SEM_AMBOS;
  return <Chip tone={m.tone} icon={m.icon} size={size}>{m.label}</Chip>;
}

function Metric({ label, value, sub, tone }: { label: string; value: string | number; sub?: string; tone?: string }) {
  return (
    <Card className="p-4">
      <div className="text-[10px] uppercase tracking-widest text-text-secondary">{label}</div>
      <div className={cn('text-2xl font-bold mt-1', tone)}>{value}</div>
      {sub && <div className="text-[11px] text-text-secondary mt-0.5">{sub}</div>}
    </Card>
  );
}

function FileField({ label, hint, multiple, accept, files, onChange }: {
  label: string; hint: string; multiple?: boolean; accept: string; files: File[]; onChange: (f: File[]) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[11px] font-bold uppercase tracking-widest text-text-secondary">{label}</span>
        {files.length > 0 && <span className="text-[10px] text-success font-bold">{files.length} arquivo{files.length !== 1 ? 's' : ''}</span>}
      </div>
      <button
        onClick={() => ref.current?.click()}
        className="w-full flex items-center gap-2 px-3 py-3 border border-dashed border-line rounded text-[12px] text-text-secondary hover:border-primary hover:text-primary transition-colors"
      >
        <Upload size={15} aria-hidden /> {files.length ? 'Trocar / adicionar' : 'Selecionar'}
      </button>
      <input
        ref={ref} type="file" multiple={multiple} accept={accept} className="hidden"
        aria-label={label}
        onChange={(e) => { const fs = Array.from(e.target.files || []); if (fs.length) onChange(multiple ? [...files, ...fs] : fs); }}
      />
      {files.length > 0 ? (
        <ul className="mt-2 space-y-1 max-h-24 overflow-y-auto">
          {files.map((f, i) => (
            <li key={i} className="flex items-center justify-between text-[11px] text-text">
              <span className="truncate">{f.name}</span>
              <IconBtn label={`Remover ${f.name}`} className="ml-2 p-0.5 hover:text-error" onClick={() => onChange(files.filter((_, j) => j !== i))}><X size={12} /></IconBtn>
            </li>
          ))}
        </ul>
      ) : <p className="text-[10px] text-text-secondary mt-2">{hint}</p>}
    </Card>
  );
}

function Field({ label, value, onChange, placeholder, textarea }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; textarea?: boolean;
}) {
  return (
    <label className="block">
      <span className="text-[11px] font-bold uppercase tracking-widest text-text-secondary">{label}</span>
      {textarea ? (
        <textarea value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} rows={2}
          className="mt-1 w-full bg-card border border-line rounded px-3 py-2 text-[13px] text-text focus:border-primary focus:outline-none resize-y" />
      ) : (
        <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
          className="mt-1 w-full bg-card border border-line rounded px-3 py-2 text-[13px] text-text focus:border-primary focus:outline-none" />
      )}
    </label>
  );
}

async function downloadBlob(apiFetch: FeacAppProps['apiFetch'], url: string, fallbackName: string) {
  const res = await apiFetch(url);
  if (!res.ok) throw new Error((await res.json().catch(() => ({} as any))).error || 'Falha no download');
  const blob = await res.blob();
  const cd = res.headers.get('Content-Disposition') || '';
  const m = cd.match(/filename="([^"]+)"/);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = m ? m[1] : fallbackName;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export default function FeacApp({ user, apiFetch, addToast, onHome, navigate, initialRecordId }: FeacAppProps) {
  const [section, setSection] = useState<FeacSection>('historico');
  const [record, setRecord] = useState<FeacProcessing | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');

  // upload state
  const [notas, setNotas] = useState<File[]>([]);
  const [comprovantes, setComprovantes] = useState<File[]>([]);
  const [extrato, setExtrato] = useState<File[]>([]);
  const [fluxo, setFluxo] = useState<File[]>([]);
  const [meta, setMeta] = useState({ projeto: '', contractNumber: '', periodoInicio: '', periodoFim: '' });

  // preliminar state
  const [selected, setSelected] = useState<FeacLancamento | null>(null);
  const [cnpj, setCnpj] = useState<Record<string, CNPJDataLike | 'error' | 'loading'>>({});
  const importRef = useRef<HTMLInputElement>(null);

  const lancs = record?.lancamentos || [];
  const stats = useMemo(() => ({
    total: lancs.length,
    ok: lancs.filter(l => l.matchStatus === 'OK').length,
    pendentes: lancs.filter(l => l.matchStatus !== 'OK').length,
    rateio: lancs.filter(l => l.rateio === 'SIM').length,
  }), [lancs]);

  const canStart = fluxo.length > 0 && (notas.length > 0 || comprovantes.length > 0) && meta.projeto.trim().length > 0 && meta.contractNumber.trim().length > 0;

  // ── actions ──────────────────────────────────────────────────────────────────
  const start = async () => {
    if (!canStart) { addToast('error', 'Envie a planilha, os documentos e informe o Número do Contrato.'); return; }
    setBusy(true);
    try {
      setProgress('Enviando e mesclando documentos…');
      const fd = new FormData();
      notas.forEach(f => fd.append('notas', f));
      comprovantes.forEach(f => fd.append('comprovantes', f));
      extrato.forEach(f => fd.append('extrato', f));
      if (fluxo[0]) fd.append('fluxoCaixa', fluxo[0]);
      fd.append('meta', JSON.stringify(meta));
      const cr = await apiFetch('/api/feac', { method: 'POST', body: fd });
      if (!cr.ok) throw new Error((await cr.json().catch(() => ({} as any))).error || 'Falha no upload');
      const { id } = await cr.json();
      setProgress('Lendo a planilha e extraindo texto dos PDFs (OCR quando necessário)…');
      const pr = await apiFetch(`/api/feac/${id}/parse`, { method: 'POST' });
      if (!pr.ok) throw new Error((await pr.json().catch(() => ({} as any))).error || 'Falha ao processar a planilha');
      setProgress('Conciliando notas fiscais e comprovantes com os lançamentos…');
      const ar = await apiFetch(`/api/feac/${id}/audit`, { method: 'POST' });
      if (!ar.ok) throw new Error((await ar.json().catch(() => ({} as any))).error || 'Falha na conciliação');
      const rec: FeacProcessing = await ar.json();
      setRecord(rec);
      setSection('preliminar');
      addToast('success', `Conciliação concluída: ${rec.lancamentos.filter(l => l.matchStatus === 'OK').length}/${rec.lancamentos.length} lançamentos OK.`);
    } catch (e: any) {
      addToast('error', e.message || 'Erro ao processar');
    } finally { setBusy(false); setProgress(''); }
  };

  const patchLanc = async (lancId: string, patch: Partial<FeacLancamento>) => {
    if (!record) return;
    setRecord(r => r ? { ...r, lancamentos: r.lancamentos.map(l => l.id === lancId ? { ...l, ...patch } : l) } : r);
    setSelected(s => s && s.id === lancId ? { ...s, ...patch } : s);
    try {
      const res = await apiFetch(`/api/feac/${record.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lancamentos: [{ id: lancId, ...patch }] }),
      });
      if (res.ok) setRecord(await res.json());
    } catch { /* keep optimistic */ }
  };

  const doExport = async () => {
    if (!record) return;
    try { await downloadBlob(apiFetch, `/api/feac/${record.id}/export`, `feac_${record.id.slice(0, 8)}_preliminar.json`); }
    catch (e: any) { addToast('error', e.message); }
  };
  const doImport = async (file: File) => {
    if (!record) return;
    const fd = new FormData(); fd.append('file', file);
    const res = await apiFetch(`/api/feac/${record.id}/import`, { method: 'POST', body: fd });
    if (res.ok) { const rec = await res.json(); setRecord(rec); addToast('success', `Importado — ${rec._imported ?? 0} lançamentos atualizados (mesmo ID preservado).`); }
    else addToast('error', (await res.json().catch(() => ({} as any))).error || 'Falha na importação');
  };

  const runTreat = async () => {
    if (!record) return;
    setBusy(true); setSection('tratamento'); setProgress('Mesclando, carimbando e convertendo para PDF/A-2b…');
    try {
      const res = await apiFetch(`/api/feac/${record.id}/treat`, { method: 'POST' });
      if (!res.ok) throw new Error((await res.json().catch(() => ({} as any))).error || 'Falha no tratamento');
      const rec: FeacProcessing = await res.json();
      setRecord(rec); setSection('relatorio');
      addToast('success', 'Documentos tratados e relatório gerado.');
    } catch (e: any) { addToast('error', e.message); setSection('preliminar'); }
    finally { setBusy(false); setProgress(''); }
  };

  const lookupCnpj = async (taxId?: string) => {
    const d = (taxId || '').replace(/\D/g, '');
    if (d.length !== 14) { addToast('info', 'Consulta disponível apenas para CNPJ (14 dígitos).'); return; }
    setCnpj(c => ({ ...c, [d]: 'loading' }));
    try {
      const res = await apiFetch(`/api/cnpj/${d}`);
      const data = res.ok ? await res.json() : 'error';
      setCnpj(c => ({ ...c, [d]: data }));
    } catch { setCnpj(c => ({ ...c, [d]: 'error' })); }
  };

  // ── persistence: saved prestações ───────────────────────────────────────────
  const [history, setHistory] = useState<FeacSummary[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const loadHistory = async () => {
    setHistoryLoading(true);
    try { const r = await apiFetch('/api/feac'); if (r.ok) setHistory(await r.json()); } catch { /* */ } finally { setHistoryLoading(false); }
  };
  useEffect(() => { loadHistory(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const openRecord = async (id: string, sub?: FeacSection) => {
    try {
      const r = await apiFetch(`/api/feac/${id}`);
      if (!r.ok) { addToast('error', 'Falha ao abrir a prestação.'); return; }
      const rec: FeacProcessing = await r.json();
      setRecord(rec);
      const def: FeacSection = rec.stage === 'concluido' || rec.stage === 'tratado' ? 'relatorio' : 'preliminar';
      const sec = sub && RECORD_SECTIONS.includes(sub) ? sub : def;
      setSection(sec);
      navigate?.(feacPath(sec, id));
    } catch { addToast('error', 'Falha ao abrir a prestação.'); }
  };
  const newPrestacao = () => {
    setRecord(null); setNotas([]); setComprovantes([]); setExtrato([]); setFluxo([]);
    setMeta({ projeto: '', contractNumber: '', periodoInicio: '', periodoFim: '' });
    setSection('upload');
    navigate?.('/feac/nova');
  };
  const deleteRecord = async (id: string) => {
    const r = await apiFetch(`/api/feac/${id}`, { method: 'DELETE' });
    if (r.ok) { addToast('success', 'Prestação excluída.'); if (record?.id === id) setRecord(null); loadHistory(); }
    else addToast('error', 'Falha ao excluir.');
  };

  // navega entre seções dando a cada uma sua URL exata (compartilhável)
  const goSection = (s: FeacSection) => {
    setSection(s);
    if (s === 'historico') loadHistory();
    navigate?.(feacPath(s, record?.id));
  };

  // routing: aplica a URL atual em deep-link/reload e em back/forward
  const applyPath = () => {
    const seg = pathSegs();
    if (seg[0] !== 'feac') return;
    const a = seg[1], b = seg[2];
    if (!a) setSection('historico');
    else if (a === 'ajuda') setSection('ajuda');
    else if (a === 'nova') newPrestacao();
    else openRecord(a, b as FeacSection | undefined);
  };
  useEffect(() => { applyPath(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onPop = () => applyPath();
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── shell: step model ────────────────────────────────────────────────────────
  const STAGE_RANK: Record<string, number> = { criado: 0, extraido: 1, auditado: 2, tratado: 3, concluido: 4 };
  const rank = record ? (STAGE_RANK[record.stage] ?? 0) : -1;
  const steps: { id: FeacSection; label: string; icon: React.ElementType; doneAt: number; enabled: boolean }[] = [
    { id: 'upload', label: 'Entrada de documentos', icon: Upload, doneAt: 1, enabled: true },
    { id: 'preliminar', label: 'Relatório preliminar', icon: ScrollText, doneAt: 2, enabled: !!record },
    { id: 'tratamento', label: 'Tratamento', icon: FileCheck2, doneAt: 4, enabled: !!record && rank >= 2 },
    { id: 'relatorio', label: 'Prestação de contas', icon: NotebookPen, doneAt: 4, enabled: !!record && rank >= 3 },
  ];

  return (
    <div className="flex min-h-screen pt-8">
      <SkipLink />
      <ToolSidebar
        brand="FEAC · SGPP"
        onHome={onHome}
        user={user}
        top={
          <div className="px-3 pb-2">
            <Btn onClick={newPrestacao} className="w-full"><PlusCircle size={14} aria-hidden /> Nova prestação</Btn>
          </div>
        }
      >
        <SidebarItem icon={History} active={section === 'historico'} onClick={() => goSection('historico')}
          badge={history.length > 0 ? <span className="text-[10px] bg-line/70 text-text px-1.5 py-0.5 rounded-full">{history.length}</span> : undefined}>
          Histórico
        </SidebarItem>
        <SidebarItem icon={BookOpen} active={section === 'ajuda'} onClick={() => goSection('ajuda')}>Como usar</SidebarItem>
        <SidebarGroupLabel>Etapas {record ? '' : '· nova prestação'}</SidebarGroupLabel>
        {steps.map((s, i) => {
          const done = rank >= s.doneAt;
          const active = section === s.id;
          return (
            <SidebarItem key={s.id} disabled={!s.enabled} active={active} onClick={() => s.enabled && goSection(s.id)}
              indicator={
                <span className={cn('shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold border',
                  done ? 'bg-primary border-primary text-white' : active ? 'border-primary text-primary' : 'border-line text-text-secondary')}>
                  {done ? <CheckCircle2 size={12} /> : i + 1}
                </span>
              }>
              {s.label}
            </SidebarItem>
          );
        })}
      </ToolSidebar>

      <main id="main-content" className="ml-[216px] flex-1 min-w-[820px] flex flex-col">
        <ToolHeader
          light={FEAC_HEADERS[section][0]} accent={FEAC_HEADERS[section][1]}
          right={record ? <div className="text-[11px] text-text-secondary truncate">{record.accountability?.projeto || '—'} · Contrato {record.accountability?.contractNumber || '—'}</div> : undefined}
        />

        <div className="flex-1 overflow-y-auto px-6 sm:px-10 py-8 pb-24">
          {section === 'historico' && (
            <HistoricoView {...{ history, historyLoading, openRecord, deleteRecord, newPrestacao }} />
          )}
          {section === 'ajuda' && <AjudaFeac onNova={newPrestacao} />}
          {section === 'upload' && (
            <UploadView {...{ notas, setNotas, comprovantes, setComprovantes, extrato, setExtrato, fluxo, setFluxo, meta, setMeta, busy, progress, canStart, start }} />
          )}
          {section === 'preliminar' && record && (
            <PreliminarView {...{ record, stats, setSelected, patchLanc, doExport, importRef, doImport, runTreat, busy }} />
          )}
          {section === 'tratamento' && (
            <TratamentoView {...{ record, busy, progress }} />
          )}
          {section === 'relatorio' && record && (
            <RelatorioView {...{ record, apiFetch, addToast, setSelected }} />
          )}
        </div>
      </main>

      {selected && (
        <LancModal
          lanc={selected} record={record!} apiFetch={apiFetch} cnpj={cnpj}
          onClose={() => setSelected(null)} onPatch={patchLanc} onLookupCnpj={lookupCnpj}
          editable={section === 'preliminar'}
        />
      )}
    </div>
  );
}

// ── Upload view ─────────────────────────────────────────────────────────────
function AjudaFeac({ onNova }: { onNova: () => void }) {
  // Os 4 campos de upload da etapa 1, explicados em detalhe.
  const entradaFields = [
    { icon: ScrollText, t: 'Notas fiscais (PDF)', req: 'Obrigatório*', d: 'As NF-e / NFS-e de cada despesa do período. Pode selecionar vários PDFs de uma vez — o sistema os mescla e identifica cada nota por valor, CNPJ, data e número. *Obrigatório enviar NF e/ou comprovantes.' },
    { icon: FileSignature, t: 'Comprovantes de pagamento (PDF)', req: 'Obrigatório*', d: 'Os comprovantes de cada pagamento (Pix, TED, transferência, recibo). Vários por vez. É deles que sai o bloco Pix da Observação (origem, destino, agência/conta, chave e ID da transação).' },
    { icon: Building2, t: 'Extrato da conta corrente (PDF)', req: 'Opcional', d: 'O extrato bancário do período. Não é obrigatório, mas recomendado: ajuda a conferir os pagamentos e fica arquivado junto à prestação.' },
    { icon: FileSpreadsheet, t: 'Fluxo de caixa (.xlsx)', req: 'Obrigatório', d: 'A planilha do centro de custo, contendo a aba "Dados". É a fonte dos lançamentos: o sistema lê essa aba, filtra pelo período informado e cria uma linha para cada despesa. Mantenha o cabeçalho original.' },
  ];
  return (
    <div className="max-w-3xl space-y-6 animate-in fade-in duration-300">
      <p className="text-[13px] text-text-secondary leading-relaxed">
        O <b className="text-text">Processador FEAC / SGPP</b> transforma um conjunto de notas fiscais, comprovantes, extrato e a
        planilha de fluxo de caixa em uma <b className="text-text">prestação de contas completa</b>: concilia cada lançamento com
        seus documentos, trata os PDFs (mescla, carimbo e PDF/A-2b), gera a Declaração de Rateio e o relatório final para a Fundação FEAC.
        Cada prestação fica <b className="text-text">salva no Histórico</b> — você pode fechar e reabrir na etapa em que parou.
      </p>

      {/* fluxo em 4 passos */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {[['1', 'Entrada de documentos'], ['2', 'Relatório preliminar'], ['3', 'Tratamento'], ['4', 'Prestação de contas']].map(([n, l]) => (
          <div key={n} className="bg-surface-hover border border-line rounded p-3 text-center">
            <div className="text-primary font-extrabold text-[15px]">{n}</div>
            <div className="text-[11px] text-text-secondary leading-tight mt-0.5">{l}</div>
          </div>
        ))}
      </div>

      {/* ETAPA 1 — detalhada */}
      <Card className="p-5">
        <div className="flex items-center gap-2 mb-1"><span className="text-primary font-extrabold text-[13px]">1 · Entrada de documentos</span></div>
        <p className="text-[12px] text-text-secondary leading-relaxed mb-4">
          Clique em <b className="text-text">Nova prestação</b> e preencha os quatro campos abaixo. Cada campo aceita
          <b className="text-text"> vários arquivos</b> (exceto a planilha) — eles são mesclados automaticamente.
        </p>
        <div className="space-y-2.5">
          {entradaFields.map((f) => (
            <div key={f.t} className="flex gap-3 rounded border border-line bg-bg p-3">
              <f.icon size={18} className="text-primary shrink-0 mt-0.5" aria-hidden />
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[12px] font-bold text-text">{f.t}</span>
                  <Chip tone={f.req === 'Opcional' ? 'neutral' : 'info'} size="sm">{f.req}</Chip>
                </div>
                <p className="text-[11.5px] text-text-secondary leading-relaxed mt-0.5">{f.d}</p>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-4 pt-4 border-t border-line">
          <div className="text-[11px] font-bold uppercase tracking-widest text-text-secondary mb-2">Identificação (conforme SGPP)</div>
          <ul className="space-y-1.5 text-[11.5px] text-text-secondary">
            <li className="flex gap-2"><span className="text-primary shrink-0">▸</span><span><b className="text-text">Nome do Projeto</b> — exatamente como cadastrado no SGPP. Entra no carimbo e no relatório.</span></li>
            <li className="flex gap-2"><span className="text-primary shrink-0">▸</span><span><b className="text-text">Número do Contrato FEAC</b> — o nº do contrato no SGPP (ex.: <span className="font-mono">2025NDOES_1</span>). Entra no carimbo e no relatório.</span></li>
            <li className="flex gap-2"><span className="text-primary shrink-0">▸</span><span><b className="text-text">Período (início / fim)</b> — ex.: <span className="font-mono">01/04/2026</span> a <span className="font-mono">30/04/2026</span>. <b className="text-text">Filtra</b> os lançamentos da planilha para o mês da prestação.</span></li>
          </ul>
          <div className="mt-3 flex gap-2.5 rounded border border-dashed border-text-secondary/50 bg-bg p-3">
            <Stamp size={16} className="text-text-secondary shrink-0 mt-0.5" aria-hidden />
            <p className="text-[11.5px] text-text-secondary leading-relaxed">
              A caixa <b className="text-text">"Carimbo aplicado…"</b> mostra, em tempo real, o texto que será carimbado na margem
              de cada PDF — substituindo <span className="font-mono">{'{projeto}'}</span> e <span className="font-mono">{'{contrato}'}</span> pelos
              dados acima. <b className="text-text">Confira antes de processar.</b>
            </p>
          </div>
          <p className="text-[11.5px] text-text-secondary mt-3">
            Ao clicar em <b className="text-text">Processar e conciliar</b>, o sistema lê a planilha, extrai o texto dos PDFs
            (com OCR quando necessário) e concilia automaticamente. Em seguida você vai para o <b className="text-text">Relatório preliminar</b>.
          </p>
          <div className="mt-4"><Btn onClick={onNova}><PlusCircle size={14} aria-hidden /> Começar uma nova prestação</Btn></div>
        </div>
      </Card>

      {/* ETAPAS 2–4 */}
      <div className="space-y-3">
        <HelpStep n="2" title="Relatório preliminar — revisão">
          Revise a conciliação de cada lançamento antes de gerar os documentos finais. A coluna <b className="text-text">Situação</b> mostra
          <b className="text-text"> Conciliado</b> (NF + comprovante batem), <b className="text-text">Sem NF / Sem comprovante</b>,
          <b className="text-text"> Valor divergente</b> ou <b className="text-text">Sem documentos</b>. Você pode: marcar
          <b className="text-text"> Rateio = Sim</b> e informar os valores (recurso do projeto / recurso próprio da OSC); abrir um lançamento
          (clique na linha) para ver detalhes, <b className="text-text">consultar o CNPJ na Receita</b>, baixar a NF/comprovante e ler a
          <b className="text-text"> Observação</b>; e <b className="text-text">Exportar / Importar</b> os dados em JSON (o ID é preservado).
          Documentos que não casaram com nenhuma linha aparecem listados à parte.
        </HelpStep>
        <HelpStep n="3" title="Tratamento de documentos">
          Ao clicar em <b className="text-text">Tratar documentos</b>, cada lançamento conciliado vira um <b className="text-text">PDF único</b> —
          a <b className="text-text">nota fiscal primeiro, depois o comprovante</b> — com o <b className="text-text">carimbo</b> na margem esquerda
          de todas as páginas (preto, negrito, separado por linha pontilhada) e convertido para <b className="text-text">PDF/A-2b</b> (padrão de
          arquivamento). São gerados também a <b className="text-text">Declaração de Rateio</b> (se houver) e a planilha de fluxo de caixa atualizada.
        </HelpStep>
        <HelpStep n="4" title="Prestação de contas">
          A tela final reúne os campos da prestação e a <b className="text-text">tabela de 13 colunas</b>. Baixe: <b className="text-text">tudo em ZIP</b>;
          o <b className="text-text">Relatório (CSV)</b>; o <b className="text-text">Fluxo de caixa atualizado (.xlsx)</b> (com a aba "Prestação de Contas",
          preservando as abas originais); a <b className="text-text">Declaração de Rateio (PDF)</b>; e cada <b className="text-text">documento individual</b>,
          nomeado no padrão <span className="font-mono">ID - Nº NF - Fornecedor - Valor.pdf</span>.
        </HelpStep>
      </div>

      {/* dúvidas */}
      <div>
        <div className="text-[11px] font-bold uppercase tracking-widest text-text-secondary mb-2">Dúvidas frequentes</div>
        <div className="space-y-2">
          <FaqItem q="Posso enviar as NFs e comprovantes separados?">Sim — selecione vários no mesmo campo; o sistema mescla e concilia cada documento.</FaqItem>
          <FaqItem q="Reabri a prestação e quero mudar um rateio.">Abra-a no Histórico → volte ao Relatório preliminar → ajuste → Tratar documentos de novo. A Observação e os PDFs são regerados.</FaqItem>
          <FaqItem q="Um lançamento ficou “Valor divergente”.">O documento foi localizado, mas o valor difere da planilha. A Observação registra a diferença; confira a NF/comprovante e corrija a origem se preciso.</FaqItem>
          <FaqItem q="Um fornecedor veio sem CNPJ.">O sistema tenta completar o CNPJ pelo documento casado e busca a Razão Social oficial na API da Receita.</FaqItem>
        </div>
      </div>
    </div>
  );
}

function HelpStep({ n, title, children }: { n: string; title: string; children: React.ReactNode }) {
  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 mb-1">
        <span className="shrink-0 w-5 h-5 rounded-full bg-primary text-white flex items-center justify-center text-[10px] font-bold">{n}</span>
        <span className="text-[13px] font-bold text-text">{title}</span>
      </div>
      <p className="text-[12px] text-text-secondary leading-relaxed">{children}</p>
    </Card>
  );
}

function FaqItem({ q, children }: { q: string; children: React.ReactNode }) {
  return (
    <details className="group bg-card border border-line rounded-lg px-4 py-3">
      <summary className="flex items-center justify-between cursor-pointer text-[12px] font-semibold text-text list-none">
        {q}
        <ChevronRight size={15} className="text-text-secondary transition-transform group-open:rotate-90" aria-hidden />
      </summary>
      <p className="text-[12px] text-text-secondary leading-relaxed mt-2">{children}</p>
    </details>
  );
}

function HistoricoView({ history, historyLoading, openRecord, deleteRecord, newPrestacao }: any) {
  const STAGE_LABEL: Record<string, string> = { criado: 'Rascunho', extraido: 'Processado', auditado: 'Conciliado', tratado: 'Tratado', concluido: 'Concluído' };
  return (
    <div className="space-y-5 animate-in fade-in duration-300">
      <div className="flex items-center justify-between gap-4">
        <p className="text-[13px] text-text-secondary max-w-2xl">Prestações de contas salvas. Cada uma fica <b>persistida no servidor</b> e pode ser reaberta, editada ou tratada a qualquer momento.</p>
        <Btn onClick={newPrestacao} className="shrink-0"><PlusCircle size={14} aria-hidden /> Nova</Btn>
      </div>
      {historyLoading ? (
        <div className="flex items-center gap-2 text-text-secondary text-[13px]"><Loader2 size={16} className="animate-spin" aria-hidden /> Carregando…</div>
      ) : !history.length ? (
        <EmptyState icon={NotebookPen} title="Nenhuma prestação de contas ainda"
          description="Clique em “Nova prestação” para conciliar documentos e gerar a prestação para a FEAC."
          action={<Btn onClick={newPrestacao}><PlusCircle size={14} aria-hidden /> Nova prestação</Btn>} />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {history.map((h: FeacSummary) => (
            <Card key={h.id} className="p-4 flex flex-col gap-2 hover:border-primary transition-colors">
              <div className="flex items-start justify-between gap-2">
                <div className="font-bold text-[13px] leading-snug">{h.projeto || 'Sem projeto'}</div>
                <IconBtn label={`Excluir prestação ${h.projeto || ''}`.trim()} className="p-0.5 hover:text-error" onClick={() => deleteRecord(h.id)}><Trash2 size={13} /></IconBtn>
              </div>
              <div className="text-[11px] text-text-secondary">Contrato {h.contractNumber || '—'} · {h.competencia || '—'}</div>
              <div className="flex items-center gap-2 text-[10px]">
                <span className="px-2 py-0.5 rounded-full bg-sidebar-active text-primary font-bold uppercase tracking-wider">{STAGE_LABEL[h.stage] || h.stage}</span>
                <span className="text-text-secondary">{h.okCount}/{h.lancamentosCount} conciliados</span>
              </div>
              <div className="text-[11px] text-text-secondary">{formatCurrency(h.totalSaidas || 0)} · {new Date(h.updatedAt).toLocaleDateString('pt-BR')}</div>
              <Btn variant="secondary" size="sm" className="mt-1 w-full" onClick={() => openRecord(h.id)}><ChevronRight size={13} aria-hidden /> Abrir</Btn>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function UploadView(p: any) {
  const stampPreview = `AS DESPESAS CUSTEADAS NESTE DOCUMENTO FORAM PAGAS COM RECURSOS DO TERMO DE PARCERIA COM A FEAC PARA O PROJETO ${p.meta.projeto || '[NOME DO PROJETO]'} – CONTRATO ${p.meta.contractNumber || '[Nº DO CONTRATO]'} – ASSOCIAÇÃO CASA HACKER`.toUpperCase();
  return (
    <div className="max-w-4xl space-y-6 animate-in fade-in duration-300">
      <p className="text-[13px] text-text-secondary">
        Envie a planilha de fluxo de caixa do centro de custo, as notas fiscais, os comprovantes de pagamento e o extrato.
        Você pode selecionar vários arquivos por campo — eles serão mesclados automaticamente.
      </p>
      <div className="grid sm:grid-cols-2 gap-4">
        <FileField label="Notas fiscais" hint="PDF (uma ou várias NFs)" multiple accept="application/pdf" files={p.notas} onChange={p.setNotas} />
        <FileField label="Comprovantes de pagamento" hint="PDF (um ou vários comprovantes)" multiple accept="application/pdf" files={p.comprovantes} onChange={p.setComprovantes} />
        <FileField label="Extrato da conta corrente" hint="PDF do extrato (opcional)" multiple accept="application/pdf" files={p.extrato} onChange={p.setExtrato} />
        <FileField label="Fluxo de caixa (planilha)" hint="Arquivo .xlsx do centro de custo" accept=".xlsx,.xls" files={p.fluxo} onChange={p.setFluxo} />
      </div>
      <Card className="p-5 space-y-4">
        <div className="text-[11px] font-bold uppercase tracking-widest text-text-secondary">Identificação (conforme SGPP)</div>
        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="Nome do Projeto (conforme SGPP) *" value={p.meta.projeto} onChange={(v: string) => p.setMeta({ ...p.meta, projeto: v })} placeholder="Ex.: Hub de Cidadania Ativa Integração" />
          <Field label="Número do Contrato FEAC (conforme SGPP) *" value={p.meta.contractNumber} onChange={(v: string) => p.setMeta({ ...p.meta, contractNumber: v })} placeholder="Ex.: 2025NDOES_1" />
          <Field label="Período — início" value={p.meta.periodoInicio} onChange={(v: string) => p.setMeta({ ...p.meta, periodoInicio: v })} placeholder="01/04/2026" />
          <Field label="Período — fim" value={p.meta.periodoFim} onChange={(v: string) => p.setMeta({ ...p.meta, periodoFim: v })} placeholder="30/04/2026" />
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-widest text-text-secondary mb-1">Carimbo aplicado na margem esquerda de cada documento</div>
          <div className="rounded bg-bg px-3 py-2 border-l-2 border-dashed border-text-secondary/60">
            <p className="text-[11px] font-bold uppercase leading-snug text-text">{stampPreview}</p>
          </div>
        </div>
      </Card>

      {p.busy ? (
        <Card className="flex items-center gap-3 p-5">
          <Loader2 className="animate-spin text-primary" size={20} aria-hidden />
          <span className="text-[13px] text-text">{p.progress || 'Processando…'}</span>
        </Card>
      ) : (
        <Btn size="lg" onClick={p.start} disabled={!p.canStart}>
          Processar e conciliar <ArrowRight size={15} aria-hidden />
        </Btn>
      )}
    </div>
  );
}

// ── Preliminar view ─────────────────────────────────────────────────────────
function PreliminarView(p: any) {
  const { record, stats } = p;
  const orphans = record.orphans || [];
  return (
    <div className="space-y-6 animate-in fade-in duration-300">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Metric label="Lançamentos" value={stats.total} />
        <Metric label="Conciliados" value={stats.ok} tone="text-success" sub={`${stats.total ? Math.round(stats.ok / stats.total * 100) : 0}%`} />
        <Metric label="Pendências" value={stats.pendentes} tone={stats.pendentes ? 'text-warning' : ''} />
        <Metric label="Total saídas" value={formatCurrency(record.accountability?.totalSaidas || 0)} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Btn variant="secondary" onClick={p.doExport}><Download size={13} aria-hidden /> Exportar dados</Btn>
        <Btn variant="secondary" onClick={() => p.importRef.current?.click()}><Upload size={13} aria-hidden /> Importar dados</Btn>
        <input ref={p.importRef} type="file" accept="application/json,.json" className="hidden" aria-label="Importar dados da prestação (JSON)" onChange={(e) => { const f = e.target.files?.[0]; if (f) p.doImport(f); e.currentTarget.value = ''; }} />
        <div className="flex-1" />
        <Btn onClick={p.runTreat} disabled={p.busy}>Tratar documentos <ArrowRight size={14} aria-hidden /></Btn>
      </div>

      <Card className="overflow-hidden">
        <table className="w-full text-[12px]">
          <thead className={tableHeadCls}>
            <tr>
              <th scope="col" className="px-3 py-2.5 font-semibold">Data</th>
              <th scope="col" className="px-3 py-2.5 font-semibold">Fornecedor</th>
              <th scope="col" className="px-3 py-2.5 font-semibold text-right">Valor</th>
              <th scope="col" className="px-3 py-2.5 font-semibold text-center">NF</th>
              <th scope="col" className="px-3 py-2.5 font-semibold text-center">Comprov.</th>
              <th scope="col" className="px-3 py-2.5 font-semibold">Situação</th>
              <th scope="col" className="px-3 py-2.5 font-semibold text-center">Rateio</th>
            </tr>
          </thead>
          <tbody>
            {record.lancamentos.map((l: FeacLancamento) => (
              <tr key={l.id} onClick={() => p.setSelected(l)} className="border-t border-line hover:bg-primary/5 cursor-pointer">
                <td className="px-3 py-2.5 whitespace-nowrap">{l.dataPagamento || '—'}</td>
                <td className="px-3 py-2.5 max-w-[260px] truncate">{l.razaoSocial || l.fornecedor || '—'}<div className="text-[10px] text-text-secondary">{l.descricao}</div></td>
                <td className="px-3 py-2.5 text-right font-mono whitespace-nowrap">{formatCurrency(Math.abs(l.saida))}</td>
                <td className="px-3 py-2.5 text-center text-text-secondary">{l.nf ? `p${l.nf.pages.join(',')}` : '—'}</td>
                <td className="px-3 py-2.5 text-center text-text-secondary">{l.comprovante ? `p${l.comprovante.pages.join(',')}` : '—'}</td>
                <td className="px-3 py-2.5"><StatusChip status={l.matchStatus} size="sm" /></td>
                <td className="px-3 py-2.5 text-center" onClick={(e) => e.stopPropagation()}>
                  <button onClick={() => p.patchLanc(l.id, { rateio: l.rateio === 'SIM' ? 'NAO' : 'SIM' })}
                    aria-pressed={l.rateio === 'SIM'} aria-label={`Rateio ${l.rateio === 'SIM' ? 'ativado' : 'desativado'} para ${l.razaoSocial || l.fornecedor || 'lançamento'}`}
                    className={cn('px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider border transition-colors',
                      l.rateio === 'SIM' ? 'bg-primary/10 text-primary border-primary/40' : 'border-line text-text-secondary hover:text-text')}>
                    {l.rateio === 'SIM' ? 'Sim' : 'Não'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!record.lancamentos.length && <div className="p-8 text-center text-text-secondary text-[13px]">Nenhum lançamento de despesa encontrado no período.</div>}
      </Card>

      {orphans.length > 0 && (
        <div className="bg-warning/5 border border-warning/30 rounded-lg p-4">
          <div className="flex items-center gap-2 text-warning font-bold text-[12px] uppercase tracking-widest mb-2"><AlertTriangle size={14} aria-hidden /> Documentos sem lançamento ({orphans.length})</div>
          <ul className="text-[12px] text-text-secondary space-y-1">
            {orphans.map((o: any, i: number) => (
              <li key={i}>{o.kind === 'nf' ? 'NF' : 'Comprovante'} · {o.extractedName || 's/ nome'} · {formatCurrency(o.extractedValue || 0)} · pág. {o.pages?.join(',')}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ── Tratamento view ─────────────────────────────────────────────────────────
function TratamentoView({ record, busy, progress }: any) {
  const errors = record?.treatment?.errors || [];
  return (
    <div className="max-w-2xl animate-in fade-in duration-300">
      {busy ? (
        <Card className="flex items-center gap-3 p-6">
          <Loader2 className="animate-spin text-primary" size={22} aria-hidden />
          <div>
            <div className="text-[13px] font-bold text-text">Tratando documentos…</div>
            <div className="text-[12px] text-text-secondary">{progress}</div>
            <div className="text-[11px] text-text-secondary mt-1">Mesclagem · carimbo de margem · compressão · conversão PDF/A-2b · declaração de rateio · atualização do fluxo de caixa.</div>
          </div>
        </Card>
      ) : record?.treatment ? (
        <Card className="p-6 space-y-2">
          <div className="flex items-center gap-2 text-success font-bold text-[14px]"><CheckCircle2 size={18} aria-hidden /> Tratamento concluído</div>
          <div className="text-[12px] text-text-secondary">{record.treatment.treatedCount || 0} documento(s) mesclado(s), carimbado(s) e convertido(s) para PDF/A-2b.</div>
          {errors.length > 0 && <div className="text-[12px] text-warning">{errors.length} item(ns) com aviso — verifique no relatório.</div>}
        </Card>
      ) : (
        <div className="text-[13px] text-text-secondary">Inicie o tratamento a partir do relatório preliminar.</div>
      )}
    </div>
  );
}

// ── Relatório view ──────────────────────────────────────────────────────────
// signed value: + for entrada, − for saída
const signedValue = (l: FeacLancamento) => (l.entrada && l.entrada > 0 ? l.entrada : l.saida);

const REPORT_COLS: { h: string; get: (l: FeacLancamento) => string | number }[] = [
  { h: 'ID', get: l => l.rowNum ?? '' },
  { h: 'Categoria', get: l => l.categoria || '' },
  { h: 'Descrição', get: l => l.descricao || '' },
  { h: 'Grupo da natureza orçamentária (FEAC)', get: l => l.grupoNatureza || '' },
  { h: 'Natureza orçamentária (FEAC)', get: l => l.natureza || '' },
  { h: 'Razão Social do Fornecedor', get: l => l.razaoSocial || l.fornecedor || '' },
  { h: 'CNPJ do Fornecedor', get: l => l.taxId || '' },
  { h: 'Data Pagamento', get: l => l.dataPagamento || '' },
  { h: 'Data de Emissão do Documento Fiscal', get: l => l.nf?.extractedDate || '' },
  { h: 'Número do Documento Fiscal', get: l => l.nf?.docNumber || '' },
  { h: 'Integra Rateio', get: l => (l.rateio === 'SIM' ? 'Sim' : 'Não') },
  { h: 'Valor', get: l => signedValue(l) },
  { h: 'Observação', get: l => (l.notaExplicativa || '').replace(/\*\*/g, '') },
];

function RelatorioView({ record, apiFetch, addToast, setSelected }: any) {
  const a = record.accountability || {};
  const dl = async (url: string, name: string) => { try { await downloadBlob(apiFetch, url, name); } catch (e: any) { addToast('error', e.message); } };
  const hasRateio = (record.lancamentos || []).some((l: FeacLancamento) => l.rateio === 'SIM');
  const exportCsv = () => {
    const esc = (s: any) => `"${String(s ?? '').replace(/"/g, '""')}"`;
    const lines = [REPORT_COLS.map(c => esc(c.h)).join(';')];
    for (const l of (record.lancamentos || [])) lines.push(REPORT_COLS.map(c => esc(typeof c.get(l) === 'number' ? String(c.get(l)).replace('.', ',') : c.get(l))).join(';'));
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const el = document.createElement('a'); el.href = URL.createObjectURL(blob); el.download = `relatorio_prestacao_contas_${record.id.slice(0, 8)}.csv`;
    document.body.appendChild(el); el.click(); el.remove(); setTimeout(() => URL.revokeObjectURL(el.href), 1000);
  };
  return (
    <div className="space-y-6 animate-in fade-in duration-300">
      <Card className="p-5 grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Info2 label="Projeto" value={a.projeto || '—'} />
        <Info2 label="Nº do Contrato" value={a.contractNumber || '—'} />
        <Info2 label="Competência" value={a.competencia || '—'} />
        <Info2 label="Período" value={a.periodoInicio ? `${a.periodoInicio} – ${a.periodoFim}` : '—'} />
        <Info2 label="Total saídas" value={formatCurrency(a.totalSaidas || 0)} />
        <Info2 label="Total entradas" value={formatCurrency(a.totalEntradas || 0)} />
        <Info2 label="Lançamentos" value={String(record.lancamentos?.length || 0)} />
        <Info2 label="Conciliados" value={String((record.lancamentos || []).filter((l: FeacLancamento) => l.matchStatus === 'OK').length)} />
      </Card>

      <div className="flex flex-wrap gap-2">
        <Btn onClick={() => dl(`/api/feac/${record.id}/zip`, 'documentos.zip')}><Package size={14} aria-hidden /> Baixar tudo (ZIP)</Btn>
        <Btn variant="secondary" onClick={exportCsv}><FileDown size={14} aria-hidden /> Relatório (CSV)</Btn>
        <Btn variant="secondary" onClick={() => dl(`/api/feac/${record.id}/fluxo`, 'fluxo_atualizado.xlsx')}><FileDown size={14} aria-hidden /> Fluxo de caixa atualizado</Btn>
        {hasRateio && <Btn variant="secondary" onClick={() => dl(`/api/feac/${record.id}/rateio.pdf`, 'declaracao_rateio.pdf')}><ScrollText size={14} aria-hidden /> Declaração de rateio</Btn>}
      </div>

      <Card className="overflow-x-auto">
        <table className="w-full text-[11px] whitespace-nowrap">
          <thead className={tableHeadCls}>
            <tr>
              <th scope="col" className="px-2.5 py-2.5 font-semibold">ID</th>
              <th scope="col" className="px-2.5 py-2.5 font-semibold">Categoria</th>
              <th scope="col" className="px-2.5 py-2.5 font-semibold">Descrição</th>
              <th scope="col" className="px-2.5 py-2.5 font-semibold">Grupo nat. (FEAC)</th>
              <th scope="col" className="px-2.5 py-2.5 font-semibold">Natureza (FEAC)</th>
              <th scope="col" className="px-2.5 py-2.5 font-semibold">Razão Social (API CNPJ)</th>
              <th scope="col" className="px-2.5 py-2.5 font-semibold">CNPJ</th>
              <th scope="col" className="px-2.5 py-2.5 font-semibold">Data Pagto</th>
              <th scope="col" className="px-2.5 py-2.5 font-semibold">Emissão NF</th>
              <th scope="col" className="px-2.5 py-2.5 font-semibold">Nº Doc.</th>
              <th scope="col" className="px-2.5 py-2.5 font-semibold text-center">Rateio</th>
              <th scope="col" className="px-2.5 py-2.5 font-semibold text-right">Valor</th>
              <th scope="col" className="px-2.5 py-2.5 font-semibold">Observação</th>
              <th scope="col" className="px-2.5 py-2.5 font-semibold text-center">PDF</th>
            </tr>
          </thead>
          <tbody>
            {record.lancamentos.map((l: FeacLancamento) => {
              const v = signedValue(l);
              return (
                <tr key={l.id} className="border-t border-line hover:bg-primary/5 cursor-pointer" onClick={() => setSelected(l)}>
                  <td className="px-2.5 py-2 text-text-secondary">{l.rowNum ?? '—'}</td>
                  <td className="px-2.5 py-2 max-w-[140px] truncate" title={l.categoria}>{l.categoria || '—'}</td>
                  <td className="px-2.5 py-2 max-w-[160px] truncate" title={l.descricao}>{l.descricao || '—'}</td>
                  <td className="px-2.5 py-2 max-w-[150px] truncate" title={l.grupoNatureza}>{l.grupoNatureza || '—'}</td>
                  <td className="px-2.5 py-2 max-w-[150px] truncate" title={l.natureza}>{l.natureza || '—'}</td>
                  <td className="px-2.5 py-2 max-w-[180px] truncate font-medium" title={l.razaoSocial || l.fornecedor}>{l.razaoSocial || l.fornecedor || '—'}</td>
                  <td className="px-2.5 py-2 font-mono">{l.taxId || '—'}</td>
                  <td className="px-2.5 py-2">{l.dataPagamento || '—'}</td>
                  <td className="px-2.5 py-2">{l.nf?.extractedDate || '—'}</td>
                  <td className="px-2.5 py-2">{l.nf?.docNumber || '—'}</td>
                  <td className="px-2.5 py-2 text-center">{l.rateio === 'SIM' ? <span className="text-primary font-bold">Sim</span> : 'Não'}</td>
                  <td className={cn('px-2.5 py-2 text-right font-mono', v < 0 ? 'text-error' : 'text-success')}>{v < 0 ? '− ' : '+ '}{formatCurrency(Math.abs(v))}</td>
                  <td className="px-2.5 py-2 max-w-[220px] truncate text-text-secondary" title={(l.notaExplicativa || '').replace(/\*\*/g, '')}>{(l.notaExplicativa || '').replace(/\*\*/g, '').replace(/\n+/g, ' · ').slice(0, 70) || '—'}</td>
                  <td className="px-2.5 py-2 text-center" onClick={(e) => e.stopPropagation()}>
                    {l.treatedPdf
                      ? <IconBtn label={`Baixar PDF de ${l.razaoSocial || l.fornecedor || 'lançamento'}`} className="text-primary" onClick={() => dl(`/api/feac/${record.id}/items/${l.id}/doc`, `${l.fornecedor}.pdf`)}><FileDown size={12} /></IconBtn>
                      : <span className="text-text-secondary">—</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

function NoteText({ text }: { text: string }) {
  return (
    <div className="whitespace-pre-line text-[12px] leading-relaxed text-text">
      {text.split('\n').map((ln, i) => (
        <div key={i}>{ln.split(/(\*\*[^*]+\*\*)/g).map((p, j) => (p.startsWith('**') && p.endsWith('**') ? <strong key={j}>{p.slice(2, -2)}</strong> : <span key={j}>{p}</span>))}</div>
      ))}
    </div>
  );
}

function Info2({ label, value }: { label: string; value: string }) {
  return <div><div className="text-[10px] uppercase tracking-widest text-text-secondary">{label}</div><div className="text-[13px] font-semibold text-text mt-0.5 break-words">{value}</div></div>;
}

// ── Lançamento modal ────────────────────────────────────────────────────────
function LancModal({ lanc, record, apiFetch, cnpj, onClose, onPatch, onLookupCnpj, editable }: any) {
  const dlDoc = async (kind: 'nf' | 'comprovante') => {
    const ref = kind === 'nf' ? lanc.nf : lanc.comprovante;
    if (!ref) return;
    try { await downloadBlob(apiFetch, `/api/feac/${record.id}/items/${lanc.id}/doc?type=${kind}`, `${kind}.pdf`); } catch { /* ignore */ }
  };
  const d = (lanc.taxId || '').replace(/\D/g, '');
  const cn_ = cnpj[d];
  return (
    <Modal title={lanc.razaoSocial || lanc.fornecedor || 'Lançamento'} onClose={onClose} size="md">
      <div className="p-6 space-y-4 text-[13px]">
          <div className="grid grid-cols-2 gap-3">
            <KV label="Data de pagamento" v={lanc.dataPagamento} />
            <KV label="Valor" v={formatCurrency(Math.abs(lanc.saida))} />
            <KV label="Atividade / rubrica" v={lanc.descricao || lanc.chave} />
            <KV label="Natureza (FEAC)" v={lanc.natureza || '—'} />
            <KV label="CNPJ do Fornecedor" v={lanc.taxId || '—'} />
            <KV label="Razão Social (API CNPJ)" v={lanc.razaoSocial || '—'} />
            <KV label="Nº do Documento Fiscal" v={lanc.nf?.docNumber || '—'} />
            <KV label="Emissão do Doc. Fiscal" v={lanc.nf?.extractedDate || '—'} />
            <KV label="Categoria" v={lanc.categoria || '—'} />
            <KV label="Ref. financeira" v={lanc.finRef || '—'} />
          </div>
          <div className="flex items-center gap-2"><span className="text-[11px] uppercase tracking-widest text-text-secondary">Situação:</span> <StatusChip status={lanc.matchStatus} /></div>

          <div className="grid grid-cols-2 gap-3">
            <DocCard title="Nota fiscal" ref_={lanc.nf} onDownload={() => dlDoc('nf')} />
            <DocCard title="Comprovante" ref_={lanc.comprovante} onDownload={() => dlDoc('comprovante')} />
          </div>

          {d.length === 14 && (
            <div className="bg-bg border border-line rounded p-3">
              <div className="flex items-center justify-between">
                <span className="text-[11px] uppercase tracking-widest text-text-secondary flex items-center gap-1"><Building2 size={12} /> Receita Federal</span>
                <button onClick={() => onLookupCnpj(lanc.taxId)} className="text-[11px] text-primary hover:underline flex items-center gap-1"><Search size={12} /> Consultar CNPJ</button>
              </div>
              {cn_ === 'loading' && <div className="text-[12px] text-text-secondary mt-2 flex items-center gap-2"><Loader2 size={12} className="animate-spin" /> Consultando…</div>}
              {cn_ === 'error' && <div className="text-[12px] text-error mt-2">Não foi possível consultar.</div>}
              {cn_ && cn_ !== 'loading' && cn_ !== 'error' && (
                <div className="text-[12px] text-text mt-2 space-y-0.5">
                  <div><b>{(cn_ as any).razao_social}</b></div>
                  <div className="text-text-secondary">{(cn_ as any).situacao_cadastral} · {(cn_ as any).municipio}/{(cn_ as any).uf}</div>
                </div>
              )}
            </div>
          )}

          {lanc.notaExplicativa && (
            <div className="border-t border-line pt-3">
              <div className="text-[11px] uppercase tracking-widest text-text-secondary mb-2 flex items-center gap-1"><ScrollText size={12} /> Observação — notas explicativas</div>
              <div className="bg-bg border border-line rounded p-3"><NoteText text={lanc.notaExplicativa} /></div>
            </div>
          )}

          {editable && (
            <div className="border-t border-line pt-4 space-y-3">
              <div className="flex items-center gap-3">
                <span className="text-[11px] uppercase tracking-widest text-text-secondary">Rateio</span>
                <button onClick={() => onPatch(lanc.id, { rateio: lanc.rateio === 'SIM' ? 'NAO' : 'SIM' })}
                  className={cn('px-3 py-1 rounded text-[11px] font-bold uppercase tracking-wider border', lanc.rateio === 'SIM' ? 'bg-primary/10 text-primary border-primary/40' : 'border-line text-text-secondary')}>
                  {lanc.rateio === 'SIM' ? 'Sim' : 'Não'}
                </button>
              </div>
              {lanc.rateio === 'SIM' && (
                <div className="grid grid-cols-2 gap-3">
                  <NumField label="Valor com recurso do projeto" value={lanc.rateioValorProjeto} onChange={(v) => onPatch(lanc.id, { rateioValorProjeto: v })} />
                  <NumField label="Valor com recurso próprio da OSC" value={lanc.rateioValorProprio} onChange={(v) => onPatch(lanc.id, { rateioValorProprio: v })} />
                </div>
              )}
              <label className="block">
                <span className="text-[11px] uppercase tracking-widest text-text-secondary">Anotação do auditor</span>
                <textarea defaultValue={lanc.auditorNote || ''} onBlur={(e) => onPatch(lanc.id, { auditorNote: e.target.value })} rows={2}
                  className="mt-1 w-full bg-bg border border-line rounded px-3 py-2 text-[13px] focus:border-primary focus:outline-none resize-y" />
              </label>
            </div>
          )}
      </div>
    </Modal>
  );
}

function KV({ label, v }: { label: string; v: string }) {
  return <div><div className="text-[10px] uppercase tracking-widest text-text-secondary">{label}</div><div className="text-[13px] text-text mt-0.5">{v}</div></div>;
}
function NumField({ label, value, onChange }: { label: string; value?: number; onChange: (v: number) => void }) {
  return (
    <label className="block">
      <span className="text-[10px] uppercase tracking-widest text-text-secondary">{label}</span>
      <input type="number" step="0.01" defaultValue={value ?? ''} onBlur={(e) => onChange(parseFloat(e.target.value) || 0)}
        className="mt-1 w-full bg-bg border border-line rounded px-3 py-2 text-[13px] focus:border-primary focus:outline-none" />
    </label>
  );
}
function DocCard({ title, ref_, onDownload }: { title: string; ref_: any; onDownload: () => void }) {
  return (
    <div className={cn('border rounded p-3', ref_ ? 'border-success/30 bg-success/5' : 'border-line bg-bg')}>
      <div className="flex items-center justify-between">
        <span className="text-[11px] uppercase tracking-widest text-text-secondary">{title}</span>
        {ref_ ? <CheckCircle2 size={14} className="text-success" /> : <AlertCircle size={14} className="text-text-secondary" />}
      </div>
      {ref_ ? (
        <div className="mt-1 text-[12px] text-text">
          <div>{formatCurrency(ref_.extractedValue || 0)} · pág. {ref_.pages?.join(',')}</div>
          {ref_.docNumber && <div className="text-text-secondary">nº {ref_.docNumber}</div>}
          <button onClick={onDownload} className="mt-1 text-primary hover:underline flex items-center gap-1 text-[11px]"><FileDown size={12} /> Baixar página(s)</button>
        </div>
      ) : <div className="mt-1 text-[12px] text-text-secondary">Não localizado</div>}
    </div>
  );
}
