/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * FEAC / SGPP — Processador de Prestação de Contas (Tool B).
 * Flow: upload → relatório preliminar editável → tratamento de documentos → Relatório de Prestação de Contas.
 */
import React, { useState, useRef, useMemo, useEffect } from 'react';
import {
  NotebookPen, Layers, Upload, FileText, Loader2, CheckCircle2, AlertCircle, AlertTriangle,
  Info, Download, FileDown, Search, Building2, X, ChevronRight, Trash2, RefreshCw, Package,
  FileCheck2, ArrowRight, LogOut, ScrollText, PlusCircle, History,
} from 'lucide-react';
import { cn, formatCurrency } from '../lib/utils';
import { AuthUser } from '../types';
import { FeacProcessing, FeacLancamento, FeacMatchStatus, CNPJDataLike, FeacSummary } from './feacTypes';

type FeacSection = 'historico' | 'upload' | 'preliminar' | 'tratamento' | 'relatorio';

export interface FeacAppProps {
  user: AuthUser;
  apiFetch: (url: string, opts?: RequestInit) => Promise<Response>;
  addToast: (kind: 'success' | 'error' | 'info', message: string) => void;
  onHome: () => void;
}

const STATUS_META: Record<FeacMatchStatus, { label: string; cls: string; icon: React.ElementType }> = {
  OK:               { label: 'Conciliado',     cls: 'bg-success/10 text-success border-success/30',  icon: CheckCircle2 },
  SEM_NF:           { label: 'Sem NF',         cls: 'bg-warning/10 text-warning border-warning/40',  icon: AlertTriangle },
  SEM_COMPROVANTE:  { label: 'Sem comprov.',   cls: 'bg-warning/10 text-warning border-warning/40',  icon: AlertTriangle },
  SEM_AMBOS:        { label: 'Sem documentos', cls: 'bg-error/10 text-error border-error/30',        icon: AlertCircle },
  VALOR_DIVERGENTE: { label: 'Valor divergente', cls: 'bg-error/10 text-error border-error/30',      icon: AlertCircle },
  DUPLICADO:        { label: 'Duplicado',      cls: 'bg-error/10 text-error border-error/30',        icon: AlertCircle },
};

function StatusChip({ status }: { status: FeacMatchStatus }) {
  const m = STATUS_META[status] || STATUS_META.SEM_AMBOS;
  const Icon = m.icon;
  return (
    <span className={cn('inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[10px] font-bold uppercase tracking-wider', m.cls)}>
      <Icon size={11} /> {m.label}
    </span>
  );
}

function Metric({ label, value, sub, tone }: { label: string; value: string | number; sub?: string; tone?: string }) {
  return (
    <div className="bg-card border border-line rounded-lg p-4">
      <div className="text-[10px] uppercase tracking-widest text-text-secondary">{label}</div>
      <div className={cn('text-2xl font-bold mt-1', tone)}>{value}</div>
      {sub && <div className="text-[11px] text-text-secondary mt-0.5">{sub}</div>}
    </div>
  );
}

function FileField({ label, hint, multiple, accept, files, onChange }: {
  label: string; hint: string; multiple?: boolean; accept: string; files: File[]; onChange: (f: File[]) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div className="bg-card border border-line rounded-lg p-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[11px] font-bold uppercase tracking-widest text-text-secondary">{label}</span>
        {files.length > 0 && <span className="text-[10px] text-success font-bold">{files.length} arquivo{files.length !== 1 ? 's' : ''}</span>}
      </div>
      <button
        onClick={() => ref.current?.click()}
        className="w-full flex items-center gap-2 px-3 py-3 border border-dashed border-line rounded text-[12px] text-text-secondary hover:border-primary hover:text-primary transition-colors"
      >
        <Upload size={15} /> {files.length ? 'Trocar / adicionar' : 'Selecionar'}
      </button>
      <input
        ref={ref} type="file" multiple={multiple} accept={accept} className="hidden"
        onChange={(e) => { const fs = Array.from(e.target.files || []); if (fs.length) onChange(multiple ? [...files, ...fs] : fs); }}
      />
      {files.length > 0 ? (
        <ul className="mt-2 space-y-1 max-h-24 overflow-y-auto">
          {files.map((f, i) => (
            <li key={i} className="flex items-center justify-between text-[11px] text-text">
              <span className="truncate">{f.name}</span>
              <button onClick={() => onChange(files.filter((_, j) => j !== i))} className="text-text-secondary hover:text-error shrink-0 ml-2"><X size={12} /></button>
            </li>
          ))}
        </ul>
      ) : <p className="text-[10px] text-text-secondary mt-2">{hint}</p>}
    </div>
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

export default function FeacApp({ user, apiFetch, addToast, onHome }: FeacAppProps) {
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
  const openRecord = async (id: string) => {
    try {
      const r = await apiFetch(`/api/feac/${id}`);
      if (!r.ok) { addToast('error', 'Falha ao abrir a prestação.'); return; }
      const rec: FeacProcessing = await r.json();
      setRecord(rec);
      setSection(rec.stage === 'concluido' || rec.stage === 'tratado' ? 'relatorio' : (rec.lancamentos?.length ? 'preliminar' : 'upload'));
    } catch { addToast('error', 'Falha ao abrir a prestação.'); }
  };
  const newPrestacao = () => {
    setRecord(null); setNotas([]); setComprovantes([]); setExtrato([]); setFluxo([]);
    setMeta({ projeto: '', contractNumber: '', periodoInicio: '', periodoFim: '' });
    setSection('upload');
  };
  const deleteRecord = async (id: string) => {
    const r = await apiFetch(`/api/feac/${id}`, { method: 'DELETE' });
    if (r.ok) { addToast('success', 'Prestação excluída.'); if (record?.id === id) setRecord(null); loadHistory(); }
    else addToast('error', 'Falha ao excluir.');
  };

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
      <aside className="fixed left-0 top-8 h-[calc(100vh-2rem)] w-[212px] bg-sidebar border-r border-line flex flex-col z-50">
        <div className="pt-6 pb-4 px-5">
          <img src="https://casahacker.org/wp-content/uploads/2023/07/logo_vertical-branco.svg" alt="Casa Hacker" className="h-9 w-auto object-contain object-left invert opacity-90 mb-3" />
          <div className="flex items-center justify-between">
            <div className="text-primary font-extrabold text-[11px] tracking-widest uppercase">FEAC · SGPP</div>
            <button onClick={onHome} title="Voltar às ferramentas" className="text-text-secondary hover:text-primary transition-colors"><Layers size={15} /></button>
          </div>
        </div>

        <div className="px-3 pb-2">
          <button onClick={newPrestacao} className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-primary text-white rounded text-[11px] font-bold uppercase tracking-widest hover:bg-blue-700 transition-colors">
            <PlusCircle size={14} /> Nova prestação
          </button>
        </div>

        <div className="px-3 pb-1">
          <button onClick={() => { setSection('historico'); loadHistory(); }}
            className={cn('w-full flex items-center gap-2.5 px-3 py-2 rounded text-[12px] transition-colors',
              section === 'historico' ? 'bg-sidebar-active text-primary font-semibold' : 'text-text-secondary hover:text-text hover:bg-white/5')}>
            <History size={15} /> Histórico
            {history.length > 0 && <span className="ml-auto text-[10px] bg-line/70 text-text px-1.5 py-0.5 rounded-full">{history.length}</span>}
          </button>
        </div>

        <div className="px-5 pt-3 pb-1 mt-1 text-[9px] font-bold uppercase tracking-widest text-text-secondary/60 border-t border-line">Etapas {record ? '' : '· nova prestação'}</div>
        <nav className="flex-1 px-2 pt-1 space-y-0.5 overflow-y-auto">
          {steps.map((s, i) => {
            const done = rank >= s.doneAt;
            const active = section === s.id;
            return (
              <button key={s.id} disabled={!s.enabled} onClick={() => s.enabled && setSection(s.id)}
                className={cn('w-full flex items-center gap-2.5 px-3 py-2 rounded text-[12px] transition-colors text-left',
                  active ? 'bg-sidebar-active text-primary font-semibold' : 'text-text-secondary hover:text-text hover:bg-white/5',
                  !s.enabled && 'opacity-30 cursor-not-allowed')}>
                <span className={cn('shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold border',
                  done ? 'bg-primary border-primary text-white' : active ? 'border-primary text-primary' : 'border-line text-text-secondary')}>
                  {done ? <CheckCircle2 size={12} /> : i + 1}
                </span>
                <span className="leading-tight">{s.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="px-4 py-4 border-t border-line">
          {user.photo && <img src={user.photo} alt={user.name} className="w-7 h-7 rounded-full mb-2" />}
          <p className="text-[10px] text-text-secondary truncate">{user.email}</p>
          <a href="/auth/logout" className="mt-2 flex items-center gap-1.5 text-[10px] text-text-secondary hover:text-primary transition-colors"><LogOut size={11} /> Sair</a>
        </div>
      </aside>

      <main id="main-content" className="ml-[212px] flex-1 min-w-[820px] flex flex-col">
        <header className="px-10 py-6 border-b border-line flex justify-between items-center bg-bg shrink-0 gap-4">
          <h1 className="text-[20px] font-light shrink-0">
            {section === 'historico' && <>Prestações de <span className="font-bold text-primary">Contas</span></>}
            {section === 'upload' && <>Entrada de <span className="font-bold text-primary">Documentos</span></>}
            {section === 'preliminar' && <>Relatório <span className="font-bold text-primary">Preliminar</span></>}
            {section === 'tratamento' && <>Tratamento de <span className="font-bold text-primary">Documentos</span></>}
            {section === 'relatorio' && <>Prestação de <span className="font-bold text-primary">Contas — FEAC</span></>}
          </h1>
          {record && <div className="text-[11px] text-text-secondary truncate">{record.accountability?.projeto || '—'} · Contrato {record.accountability?.contractNumber || '—'}</div>}
        </header>

        <div className="flex-1 overflow-y-auto px-10 py-8 pb-24">
          {section === 'historico' && (
            <HistoricoView {...{ history, historyLoading, openRecord, deleteRecord, newPrestacao }} />
          )}
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
function HistoricoView({ history, historyLoading, openRecord, deleteRecord, newPrestacao }: any) {
  const STAGE_LABEL: Record<string, string> = { criado: 'Rascunho', extraido: 'Processado', auditado: 'Conciliado', tratado: 'Tratado', concluido: 'Concluído' };
  return (
    <div className="space-y-5 animate-in fade-in duration-300">
      <div className="flex items-center justify-between gap-4">
        <p className="text-[13px] text-text-secondary max-w-2xl">Prestações de contas salvas. Cada uma fica <b>persistida no servidor</b> e pode ser reaberta, editada ou tratada a qualquer momento.</p>
        <button onClick={newPrestacao} className="flex items-center gap-2 px-4 py-2 bg-primary text-white rounded text-[11px] uppercase tracking-widest font-bold hover:bg-blue-700 transition-colors shrink-0"><PlusCircle size={14} /> Nova</button>
      </div>
      {historyLoading ? (
        <div className="flex items-center gap-2 text-text-secondary text-[13px]"><Loader2 size={16} className="animate-spin" /> Carregando…</div>
      ) : !history.length ? (
        <div className="bg-card border border-line rounded-lg p-10 text-center">
          <NotebookPen size={28} className="mx-auto text-text-secondary mb-3" />
          <div className="text-[13px] text-text-secondary">Nenhuma prestação de contas ainda. Clique em <b>Nova</b> para começar.</div>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {history.map((h: FeacSummary) => (
            <div key={h.id} className="bg-card border border-line rounded-lg p-4 flex flex-col gap-2 hover:border-primary transition-colors">
              <div className="flex items-start justify-between gap-2">
                <div className="font-bold text-[13px] leading-snug">{h.projeto || 'Sem projeto'}</div>
                <button onClick={() => deleteRecord(h.id)} title="Excluir" className="text-text-secondary hover:text-error shrink-0"><Trash2 size={13} /></button>
              </div>
              <div className="text-[11px] text-text-secondary">Contrato {h.contractNumber || '—'} · {h.competencia || '—'}</div>
              <div className="flex items-center gap-2 text-[10px]">
                <span className="px-2 py-0.5 rounded-full bg-sidebar-active text-primary font-bold uppercase tracking-wider">{STAGE_LABEL[h.stage] || h.stage}</span>
                <span className="text-text-secondary">{h.okCount}/{h.lancamentosCount} conciliados</span>
              </div>
              <div className="text-[11px] text-text-secondary">{formatCurrency(h.totalSaidas || 0)} · {new Date(h.updatedAt).toLocaleDateString('pt-BR')}</div>
              <button onClick={() => openRecord(h.id)} className="mt-1 flex items-center justify-center gap-1.5 px-3 py-1.5 border border-line rounded text-[11px] uppercase tracking-widest text-primary hover:bg-primary/5 transition-colors"><ChevronRight size={13} /> Abrir</button>
            </div>
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
      <div className="bg-card border border-line rounded-lg p-5 space-y-4">
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
      </div>

      {p.busy ? (
        <div className="flex items-center gap-3 bg-card border border-line rounded-lg p-5">
          <Loader2 className="animate-spin text-primary" size={20} />
          <span className="text-[13px] text-text">{p.progress || 'Processando…'}</span>
        </div>
      ) : (
        <button onClick={p.start} disabled={!p.canStart}
          className={cn('flex items-center gap-2 px-5 py-3 rounded text-[12px] uppercase tracking-widest font-bold transition-colors',
            p.canStart ? 'bg-primary text-white hover:bg-blue-700' : 'bg-line text-text-secondary cursor-not-allowed')}>
          Processar e conciliar <ArrowRight size={15} />
        </button>
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
        <button onClick={p.doExport} className="flex items-center gap-1.5 px-3 py-2 border border-line rounded text-[11px] uppercase tracking-widest text-text-secondary hover:text-primary hover:border-primary transition-colors"><Download size={13} /> Exportar dados</button>
        <button onClick={() => p.importRef.current?.click()} className="flex items-center gap-1.5 px-3 py-2 border border-line rounded text-[11px] uppercase tracking-widest text-text-secondary hover:text-primary hover:border-primary transition-colors"><Upload size={13} /> Importar dados</button>
        <input ref={p.importRef} type="file" accept="application/json,.json" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) p.doImport(f); e.currentTarget.value = ''; }} />
        <div className="flex-1" />
        <button onClick={p.runTreat} disabled={p.busy}
          className="flex items-center gap-2 px-4 py-2 bg-primary text-white rounded text-[11px] uppercase tracking-widest font-bold hover:bg-blue-700 transition-colors disabled:opacity-50">
          Tratar documentos <ArrowRight size={14} />
        </button>
      </div>

      <div className="bg-card border border-line rounded-lg overflow-hidden">
        <table className="w-full text-[12px]">
          <thead className="bg-sidebar text-text-secondary">
            <tr className="text-left">
              <th className="px-3 py-2.5 font-semibold">Data</th>
              <th className="px-3 py-2.5 font-semibold">Fornecedor</th>
              <th className="px-3 py-2.5 font-semibold text-right">Valor</th>
              <th className="px-3 py-2.5 font-semibold text-center">NF</th>
              <th className="px-3 py-2.5 font-semibold text-center">Comprov.</th>
              <th className="px-3 py-2.5 font-semibold">Situação</th>
              <th className="px-3 py-2.5 font-semibold text-center">Rateio</th>
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
                <td className="px-3 py-2.5"><StatusChip status={l.matchStatus} /></td>
                <td className="px-3 py-2.5 text-center" onClick={(e) => e.stopPropagation()}>
                  <button onClick={() => p.patchLanc(l.id, { rateio: l.rateio === 'SIM' ? 'NAO' : 'SIM' })}
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
      </div>

      {orphans.length > 0 && (
        <div className="bg-warning/5 border border-warning/30 rounded-lg p-4">
          <div className="flex items-center gap-2 text-warning font-bold text-[12px] uppercase tracking-widest mb-2"><AlertTriangle size={14} /> Documentos sem lançamento ({orphans.length})</div>
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
        <div className="flex items-center gap-3 bg-card border border-line rounded-lg p-6">
          <Loader2 className="animate-spin text-primary" size={22} />
          <div>
            <div className="text-[13px] font-bold text-text">Tratando documentos…</div>
            <div className="text-[12px] text-text-secondary">{progress}</div>
            <div className="text-[11px] text-text-secondary mt-1">Mesclagem · carimbo de margem · compressão · conversão PDF/A-2b · declaração de rateio · atualização do fluxo de caixa.</div>
          </div>
        </div>
      ) : record?.treatment ? (
        <div className="bg-card border border-line rounded-lg p-6 space-y-2">
          <div className="flex items-center gap-2 text-success font-bold text-[14px]"><CheckCircle2 size={18} /> Tratamento concluído</div>
          <div className="text-[12px] text-text-secondary">{record.treatment.treatedCount || 0} documento(s) mesclado(s), carimbado(s) e convertido(s) para PDF/A-2b.</div>
          {errors.length > 0 && <div className="text-[12px] text-warning">{errors.length} item(ns) com aviso — verifique no relatório.</div>}
        </div>
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
      <div className="bg-card border border-line rounded-lg p-5 grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Info2 label="Projeto" value={a.projeto || '—'} />
        <Info2 label="Nº do Contrato" value={a.contractNumber || '—'} />
        <Info2 label="Competência" value={a.competencia || '—'} />
        <Info2 label="Período" value={a.periodoInicio ? `${a.periodoInicio} – ${a.periodoFim}` : '—'} />
        <Info2 label="Total saídas" value={formatCurrency(a.totalSaidas || 0)} />
        <Info2 label="Total entradas" value={formatCurrency(a.totalEntradas || 0)} />
        <Info2 label="Lançamentos" value={String(record.lancamentos?.length || 0)} />
        <Info2 label="Conciliados" value={String((record.lancamentos || []).filter((l: FeacLancamento) => l.matchStatus === 'OK').length)} />
      </div>

      <div className="flex flex-wrap gap-2">
        <button onClick={() => dl(`/api/feac/${record.id}/zip`, 'documentos.zip')} className="flex items-center gap-2 px-4 py-2 bg-primary text-white rounded text-[11px] uppercase tracking-widest font-bold hover:bg-blue-700 transition-colors"><Package size={14} /> Baixar tudo (ZIP)</button>
        <button onClick={exportCsv} className="flex items-center gap-2 px-4 py-2 border border-line rounded text-[11px] uppercase tracking-widest text-text-secondary hover:text-primary hover:border-primary transition-colors"><FileDown size={14} /> Relatório (CSV)</button>
        <button onClick={() => dl(`/api/feac/${record.id}/fluxo`, 'fluxo_atualizado.xlsx')} className="flex items-center gap-2 px-4 py-2 border border-line rounded text-[11px] uppercase tracking-widest text-text-secondary hover:text-primary hover:border-primary transition-colors"><FileDown size={14} /> Fluxo de caixa atualizado</button>
        {hasRateio && <button onClick={() => dl(`/api/feac/${record.id}/rateio.pdf`, 'declaracao_rateio.pdf')} className="flex items-center gap-2 px-4 py-2 border border-line rounded text-[11px] uppercase tracking-widest text-text-secondary hover:text-primary hover:border-primary transition-colors"><ScrollText size={14} /> Declaração de rateio</button>}
      </div>

      <div className="bg-card border border-line rounded-lg overflow-x-auto">
        <table className="w-full text-[11px] whitespace-nowrap">
          <thead className="bg-sidebar text-text-secondary">
            <tr className="text-left">
              <th className="px-2.5 py-2.5 font-semibold">ID</th>
              <th className="px-2.5 py-2.5 font-semibold">Categoria</th>
              <th className="px-2.5 py-2.5 font-semibold">Descrição</th>
              <th className="px-2.5 py-2.5 font-semibold">Grupo nat. (FEAC)</th>
              <th className="px-2.5 py-2.5 font-semibold">Natureza (FEAC)</th>
              <th className="px-2.5 py-2.5 font-semibold">Razão Social (API CNPJ)</th>
              <th className="px-2.5 py-2.5 font-semibold">CNPJ</th>
              <th className="px-2.5 py-2.5 font-semibold">Data Pagto</th>
              <th className="px-2.5 py-2.5 font-semibold">Emissão NF</th>
              <th className="px-2.5 py-2.5 font-semibold">Nº Doc.</th>
              <th className="px-2.5 py-2.5 font-semibold text-center">Rateio</th>
              <th className="px-2.5 py-2.5 font-semibold text-right">Valor</th>
              <th className="px-2.5 py-2.5 font-semibold">Observação</th>
              <th className="px-2.5 py-2.5 font-semibold text-center">PDF</th>
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
                      ? <button onClick={() => dl(`/api/feac/${record.id}/items/${l.id}/doc`, `${l.fornecedor}.pdf`)} className="inline-flex items-center gap-1 text-primary hover:underline"><FileDown size={12} /></button>
                      : <span className="text-text-secondary">—</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
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
    <div className="fixed inset-0 z-[120] bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-card border border-line rounded-xl max-w-2xl w-full max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-line sticky top-0 bg-card">
          <h3 className="text-[15px] font-bold">{lanc.razaoSocial || lanc.fornecedor || 'Lançamento'}</h3>
          <button onClick={onClose} className="text-text-secondary hover:text-text"><X size={18} /></button>
        </div>
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
      </div>
    </div>
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
