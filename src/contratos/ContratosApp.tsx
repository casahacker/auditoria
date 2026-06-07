/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Contratos (Tool E) — frontend: registro/lista (#135), wizard de geração (#134) e
 * detalhe. Só componentes do kit (IBM Carbon); a11y no padrão da suíte. O gate de
 * elegibilidade, a extração (IA) e a minuta são SEMPRE decididos no servidor.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  FileSignature, Building2, Loader2, ChevronRight, ChevronLeft, Plus, Check, AlertTriangle,
  ShieldCheck, ShieldAlert, Upload, FileText, ExternalLink, HelpCircle, ListChecks, Clock, Lock, Trash2, Pencil,
} from 'lucide-react';
import { cn } from '../lib/utils';
import { AuthUser } from '../types';
import { Btn, IconBtn, Chip, Card, ToolSidebar, ToolHeader, SidebarItem, SidebarGroupLabel, SkipLink, EmptyState, tableHeadCls } from '../ui/kit';
import type { ChipTone } from '../ui/kit';
import { onlyDigits, maskCnpj } from '../kyc/kycTypes';
import { addMeses, addDias, proporVencimentos } from './datas';
import type { Contrato, ContratoResumo, ContratoStatus, ElegibilidadeSnapshot, CriterioElegibilidade, ExtracaoIA } from './contratosTypes';

type ParcelaEdit = { numero: number; valorStr: string; vencimento: string | null; estimada?: boolean };

export interface ContratosAppProps {
  user: AuthUser;
  apiFetch: (url: string, opts?: RequestInit) => Promise<Response>;
  addToast: (kind: 'success' | 'error' | 'info', message: string) => void;
  onHome: () => void;
  navigate?: (path: string) => void;
  initialView?: string; // segmento após /contratos (novo | <id> | ajuda)
}

type Section = 'lista' | 'novo' | 'detalhe' | 'ajuda' | 'aditivo' | 'editar';
const segs = () => window.location.pathname.split('/').filter(Boolean);

// formatação local (não arrasta a lib `extenso` para o bundle do front)
const fmtMoeda = (c?: number) => { const v = Math.abs(Math.trunc(Number(c) || 0)); return `R$ ${String(Math.trunc(v / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${String(v % 100).padStart(2, '0')}`; };
const fmtData = (iso?: string | null) => { if (!iso) return '—'; const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso)); return m ? `${m[3]}/${m[2]}/${m[1]}` : String(iso); };
// "3.000,00" | "3000,00" | "3000.00" | "3000" → centavos inteiros. Vírgula = decimal pt-BR.
const reaisToCent = (s?: string) => { const t = String(s ?? '').trim(); if (!t) return 0; const norm = t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t; return Math.round((parseFloat(norm) || 0) * 100); };
const centToReais = (c?: number) => ((Math.trunc(Number(c) || 0)) / 100).toFixed(2);

const STATUS: Record<ContratoStatus, { tone: ChipTone; label: string }> = {
  rascunho: { tone: 'neutral', label: 'Rascunho' },
  em_revisao: { tone: 'info', label: 'Em revisão' },
  aprovado: { tone: 'info', label: 'Aprovado' },
  enviado_assinatura: { tone: 'warning', label: 'Enviado p/ assinatura' },
  assinado: { tone: 'success', label: 'Assinado' },
  vigente: { tone: 'success', label: 'Vigente' },
  encerrado: { tone: 'neutral', label: 'Encerrado' },
  cancelado: { tone: 'error', label: 'Cancelado' },
};
const statusChip = (s: ContratoStatus) => { const m = STATUS[s] || STATUS.rascunho; return <Chip tone={m.tone} size="sm">{m.label}</Chip>; };

const CRIT_TONE: Record<string, ChipTone> = { ok: 'success', alerta: 'warning', bloqueio: 'error' };

export default function ContratosApp({ user, apiFetch, addToast, onHome, navigate, initialView }: ContratosAppProps) {
  const seg0 = segs();
  const isAditivo = (seg0[2] || '').toLowerCase() === 'aditivo';
  const isEditar = (seg0[2] || '').toLowerCase() === 'editar';
  const initial = (initialView || seg0[1] || '').toLowerCase();
  const [section, setSection] = useState<Section>(isAditivo ? 'aditivo' : isEditar ? 'editar' : initial === 'novo' ? 'novo' : initial === 'ajuda' ? 'ajuda' : initial && initial.startsWith('ch-') ? 'detalhe' : 'lista');
  const [detalheId, setDetalheId] = useState<string>(initial.startsWith('ch-') ? initial.toUpperCase() : '');

  const go = (s: Section, id?: string) => {
    setSection(s);
    if ((s === 'detalhe' || s === 'aditivo' || s === 'editar') && id) setDetalheId(id);
    const alvo = (id || detalheId).toLowerCase();
    const path = s === 'lista' ? '/contratos' : s === 'novo' ? '/contratos/novo' : s === 'ajuda' ? '/contratos/ajuda'
      : s === 'aditivo' ? `/contratos/${alvo}/aditivo/novo` : s === 'editar' ? `/contratos/${alvo}/editar` : `/contratos/${alvo}`;
    navigate?.(path);
  };

  return (
    <div className="flex min-h-screen pt-8">
      <SkipLink />
      <ToolSidebar brand="Contratos" onHome={onHome} user={user}>
        <SidebarItem icon={ListChecks} active={section === 'lista'} onClick={() => go('lista')}>Contratos</SidebarItem>
        <SidebarItem icon={Plus} active={section === 'novo'} onClick={() => go('novo')}>Novo contrato</SidebarItem>
        <SidebarGroupLabel>Ajuda</SidebarGroupLabel>
        <SidebarItem icon={HelpCircle} active={section === 'ajuda'} onClick={() => go('ajuda')}>Como usar</SidebarItem>
      </ToolSidebar>

      <div className="flex-1 ml-[256px] flex flex-col min-h-screen">
        {section === 'lista' && <ListaView apiFetch={apiFetch} addToast={addToast} onAbrir={(id) => go('detalhe', id)} onNovo={() => go('novo')} onProrrogar={(id) => go('aditivo', id)} onEditar={(id) => go('editar', id)} />}
        {section === 'novo' && <Wizard apiFetch={apiFetch} addToast={addToast} navigate={navigate} onConcluir={(id) => go('detalhe', id)} onCancelar={() => go('lista')} />}
        {section === 'editar' && <Wizard key={detalheId} contratoIdInicial={detalheId} apiFetch={apiFetch} addToast={addToast} navigate={navigate} onConcluir={(id) => go('detalhe', id)} onCancelar={() => go('detalhe', detalheId)} />}
        {section === 'detalhe' && <DetalheView id={detalheId} apiFetch={apiFetch} addToast={addToast} navigate={navigate} onVoltar={() => go('lista')} onNovoAditivo={() => go('aditivo', detalheId)} onEditar={() => go('editar', detalheId)} />}
        {section === 'aditivo' && <AditivoWizard contratoId={detalheId} apiFetch={apiFetch} addToast={addToast} onConcluir={() => go('detalhe', detalheId)} onCancelar={() => go('detalhe', detalheId)} />}
        {section === 'ajuda' && <AjudaView />}
      </div>
    </div>
  );
}

// ── Lista (#135) ────────────────────────────────────────────────────────────────
function ListaView({ apiFetch, addToast, onAbrir, onNovo, onProrrogar, onEditar }: { apiFetch: ContratosAppProps['apiFetch']; addToast: ContratosAppProps['addToast']; onAbrir: (id: string) => void; onNovo: () => void; onProrrogar: (id: string) => void; onEditar: (id: string) => void }) {
  const [rows, setRows] = useState<ContratoResumo[] | null>(null);
  const [fStatus, setFStatus] = useState('');
  const [busca, setBusca] = useState('');
  const [vencendo, setVencendo] = useState<ContratoResumo[]>([]);

  useEffect(() => { (async () => {
    try { const r = await apiFetch('/api/contratos'); setRows(r.ok ? await r.json() : []); }
    catch { setRows([]); addToast('error', 'Falha ao carregar contratos.'); }
    try { const a = await apiFetch('/api/contratos/alertas/vigencia'); if (a.ok) setVencendo((await a.json()).contratos || []); } catch { /* */ }
  })(); }, []);

  const filtered = useMemo(() => (rows || []).filter((c) =>
    (!fStatus || c.status === fStatus) &&
    (!busca || [c.id, c.razaoSocial, c.objeto, c.cnpj, c.jiraIssueKey].some((v) => String(v || '').toLowerCase().includes(busca.toLowerCase())))
  ), [rows, fStatus, busca]);

  return (
    <>
      <ToolHeader light="Registro de" accent="Contratos" right={<Btn onClick={onNovo}><Plus size={16} /> Novo contrato</Btn>} />
      <main id="main-content" className="flex-1 p-6 sm:p-10 max-w-6xl w-full">
        {vencendo.length > 0 && (
          <div className="border border-warning/40 bg-warning/5 p-4 mb-5" role="region" aria-label="Contratos com vigência expirando">
            <div className="flex items-center gap-2 text-[14px] font-semibold text-warning mb-2"><Clock size={16} aria-hidden /> {vencendo.length} contrato(s) com vigência expirando em ≤45 dias</div>
            <ul className="space-y-1.5">{vencendo.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 text-[13px]">
                <button onClick={() => onAbrir(c.id)} className="text-left hover:text-primary"><span className="font-mono text-[12px]">{c.jiraIssueKey || c.id}</span> <span className="text-text-secondary">· {c.razaoSocial || maskCnpj(c.cnpj)} · vence {fmtData(c.vigenciaFim)}</span></button>
                <Btn variant="secondary" size="sm" onClick={() => onProrrogar(c.id)}>Criar aditivo de prorrogação</Btn>
              </li>))}</ul>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-3 mb-5">
          <input value={busca} onChange={(e) => setBusca(e.target.value)} aria-label="Buscar contratos" placeholder="Buscar por id, fornecedor, objeto, CNPJ ou issue…"
            className="h-10 flex-1 min-w-[260px] bg-field border border-line rounded-none px-3 text-[14px] text-text outline-none focus:border-primary focus-visible:ring-2 focus-visible:ring-primary" />
          <select value={fStatus} onChange={(e) => setFStatus(e.target.value)} aria-label="Filtrar por status"
            className="h-10 bg-field border border-line rounded-none px-3 text-[14px] text-text cursor-pointer focus:border-primary">
            <option value="">Todos os status</option>
            {Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        </div>

        {rows === null ? (
          <div className="flex items-center gap-2 text-text-secondary text-[14px] py-10"><Loader2 size={16} className="animate-spin" /> Carregando…</div>
        ) : filtered.length === 0 ? (
          <EmptyState icon={FileSignature} title="Nenhum contrato" description="Gere o primeiro contrato a partir de um fornecedor elegível." action={<Btn onClick={onNovo}><Plus size={16} /> Novo contrato</Btn>} />
        ) : (
          <Card className="overflow-hidden">
            <table className="w-full text-[14px]">
              <thead className={tableHeadCls}><tr>
                {['ID', 'Fornecedor', 'Objeto', 'Valor', 'Vigência', 'Status', 'Aditivos', ''].map((h, i) => <th key={h || `act${i}`} className="px-4 py-2.5 font-semibold text-[12px]">{h}</th>)}
              </tr></thead>
              <tbody>
                {filtered.map((c) => (
                  <tr key={c.id} className="border-t border-line hover:bg-surface-hover cursor-pointer" onClick={() => onAbrir(c.id)}>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <button onClick={(e) => { e.stopPropagation(); onAbrir(c.id); }} aria-label={`Abrir contrato ${c.jiraIssueKey || c.id}`} className="font-mono text-[12px] text-left hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{c.jiraIssueKey || c.id}</button>
                      {c.jiraIssueKey && <div className="font-mono text-[11px] text-text-secondary">{c.id}</div>}
                    </td>
                    <td className="px-4 py-3"><div className="font-medium">{c.razaoSocial || '—'}</div><div className="text-[12px] text-text-secondary">{maskCnpj(c.cnpj)}</div></td>
                    <td className="px-4 py-3 max-w-[260px] truncate text-text-secondary">{c.objeto || '—'}</td>
                    <td className="px-4 py-3 whitespace-nowrap">{c.valorTotalCentavos ? fmtMoeda(c.valorTotalCentavos) : '—'}</td>
                    <td className="px-4 py-3 whitespace-nowrap text-[12px]">{c.vigenciaFim ? `até ${fmtData(c.vigenciaFim)}` : '—'}</td>
                    <td className="px-4 py-3">{statusChip(c.status)}</td>
                    <td className="px-4 py-3 text-center">{c.qtdAditivos || 0}</td>
                    <td className="px-4 py-3 text-right">
                      {['rascunho', 'em_revisao'].includes(c.status) && <IconBtn label={`Editar contrato ${c.jiraIssueKey || c.id}`} onClick={(e) => { e.stopPropagation(); onEditar(c.id); }}><Pencil size={14} aria-hidden /></IconBtn>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </main>
    </>
  );
}

// ── Wizard de geração (#134) ─────────────────────────────────────────────────────
const PASSOS = ['Fornecedor', 'Documento', 'Conferência', 'Minuta', 'Assinatura'];

function Stepper({ step }: { step: number }) {
  return (
    <nav aria-label="Etapas do contrato" className="mb-8">
      <ol className="flex items-center gap-2 flex-wrap">
        {PASSOS.map((p, i) => {
          const n = i + 1; const done = n < step; const cur = n === step;
          return (
            <li key={p} className="flex items-center gap-2" aria-current={cur ? 'step' : undefined}>
              <span aria-hidden className={cn('w-6 h-6 inline-flex items-center justify-center text-[12px] border', cur ? 'bg-primary text-white border-primary' : done ? 'border-primary text-primary' : 'border-line text-text-secondary')}>{done ? <Check size={13} /> : n}</span>
              <span className={cn('text-[13px]', cur ? 'text-text font-semibold' : 'text-text-secondary')}>{p}</span>
              <span className="sr-only">{cur ? '— etapa atual' : done ? '— concluída' : '— pendente'}</span>
              {n < PASSOS.length && <ChevronRight size={14} className="text-text-secondary" aria-hidden />}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function Wizard({ apiFetch, addToast, navigate, onConcluir, onCancelar, contratoIdInicial }: { apiFetch: ContratosAppProps['apiFetch']; addToast: ContratosAppProps['addToast']; navigate?: (p: string) => void; onConcluir: (id: string) => void; onCancelar: () => void; contratoIdInicial?: string }) {
  const [step, setStep] = useState(1);
  const [contrato, setContrato] = useState<Contrato | null>(null);
  const [busy, setBusy] = useState(false);
  // foco no título ao trocar de passo (a11y — leitores de tela anunciam a nova etapa) (#149)
  const headingRef = useRef<HTMLHeadingElement>(null);
  const prevStep = useRef(step);
  const armedRef = useRef(false); // autosave (#155): só arma após o passo 3 ser semeado
  useEffect(() => { if (prevStep.current !== step) { prevStep.current = step; headingRef.current?.focus(); } }, [step]);

  // passo 1 — pré-preenche o CNPJ vindo da ficha do fornecedor (?cnpj=)
  const [cnpj, setCnpj] = useState(() => { try { return new URLSearchParams(window.location.search).get('cnpj') || ''; } catch { return ''; } });
  const [eleg, setEleg] = useState<ElegibilidadeSnapshot | null>(null);
  // passo 2
  const [tipoDoc, setTipoDoc] = useState<'tr' | 'proposta'>('tr');
  const [jiraKey, setJiraKey] = useState('');
  const [jiraInfo, setJiraInfo] = useState<{ ok: boolean; resumo?: string; status?: string; alertaDone?: boolean; erro?: string } | null>(null);
  const [oc, setOc] = useState('');
  const [arquivo, setArquivo] = useState<File | null>(null);
  // passo 3
  const [extr, setExtr] = useState<ExtracaoIA | null>(null);
  const [ciencias, setCiencias] = useState<Set<string>>(new Set());
  const [objeto, setObjeto] = useState('');
  const [valorReais, setValorReais] = useState('');
  const [vigInicio, setVigInicio] = useState('');
  const [durUnidade, setDurUnidade] = useState<'meses' | 'dias'>('meses');
  const [durValor, setDurValor] = useState('');
  const [vigFim, setVigFim] = useState('');
  const [parcelasEdit, setParcelasEdit] = useState<ParcelaEdit[]>([]);
  // passo 3 — demais campos extraídos, conferíveis e editáveis (#152)
  const [resumoEscopo, setResumoEscopo] = useState('');
  const [condicoesPagamento, setCondicoesPagamento] = useState('');
  const [sla, setSla] = useState('');
  const [localExecucao, setLocalExecucao] = useState('');
  const [equipamentos, setEquipamentos] = useState('');
  const [autosaveStatus, setAutosaveStatus] = useState<'idle' | 'saving' | 'saved' | 'erro'>('idle');
  // passo 4
  const [minuta, setMinuta] = useState('');
  const [validacao, setValidacao] = useState<{ ok: boolean; bloqueios: string[]; avisos: string[] } | null>(null);

  const refresh = async (id: string) => { const r = await apiFetch(`/api/contratos/${id}`); if (r.ok) setContrato(await r.json()); };

  // Retomar/editar um rascunho existente (#154): carrega o contrato + a extração salva e
  // semeia todos os campos do wizard, retomando no passo adequado (3 se já há extração).
  useEffect(() => {
    if (!contratoIdInicial) return;
    (async () => {
      setBusy(true);
      try {
        const r = await apiFetch(`/api/contratos/${contratoIdInicial}`);
        if (!r.ok) { addToast('error', 'Falha ao carregar o rascunho.'); return; }
        const c: Contrato = await r.json();
        setContrato(c);
        setCnpj(c.cnpj || '');
        setEleg(c.elegibilidadeSnapshot || null);
        setTipoDoc(c.tipoDocumentoEntrada === 'proposta' ? 'proposta' : 'tr');
        if (c.jira?.issueKey) { setJiraKey(c.jira.issueKey); setJiraInfo({ ok: true, resumo: c.jira.resumo, status: c.jira.status, alertaDone: c.jira.categoriaStatus === 'Done' }); }
        setOc(c.ordemCompra || '');
        const ex = c.extracao || null;
        setExtr(ex);
        setObjeto(c.objeto || ex?.objeto?.valor || '');
        setValorReais(c.valorTotalCentavos != null ? centToReais(c.valorTotalCentavos) : '');
        setVigInicio(c.vigenciaInicio || '');
        if (c.vigenciaDuracaoDias) { setDurUnidade('dias'); setDurValor(String(c.vigenciaDuracaoDias)); }
        else { setDurUnidade('meses'); setDurValor(c.vigenciaDuracaoMeses ? String(c.vigenciaDuracaoMeses) : (ex?.vigencia?.duracaoMeses?.valor != null ? String(ex.vigencia.duracaoMeses.valor) : '')); }
        setVigFim(c.vigenciaFim || '');
        setParcelasEdit((c.parcelas || []).map((p) => ({ numero: p.numero, valorStr: centToReais(p.valorCentavos), vencimento: p.vencimento ?? null, estimada: p.estimada ?? !p.vencimento })));
        setResumoEscopo(c.resumoEscopo || ex?.resumoEscopo?.valor || '');
        setCondicoesPagamento(c.condicoesPagamento || ex?.condicoesPagamento?.valor || '');
        setSla(c.sla || ex?.sla?.valor || '');
        setLocalExecucao(c.localExecucao || ex?.localExecucao?.valor || '');
        setEquipamentos(c.equipamentosFornecidosPelaContratante || ex?.equipamentosFornecidosPelaContratante?.valor || '');
        setCiencias(new Set());
        armedRef.current = false; setAutosaveStatus('idle');
        setStep(ex ? 3 : (c.elegibilidadeSnapshot?.elegivel ? 2 : 1));
      } catch { addToast('error', 'Falha ao carregar o rascunho.'); }
      finally { setBusy(false); }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contratoIdInicial]);

  // PASSO 1 — cria o rascunho e avalia elegibilidade
  const iniciar = async () => {
    const d = onlyDigits(cnpj);
    if (d.length !== 14) { addToast('error', 'Informe um CNPJ com 14 dígitos.'); return; }
    setBusy(true); setEleg(null);
    try {
      let id = contrato?.id;
      if (!id || contrato?.cnpj !== d) {
        const r = await apiFetch('/api/contratos', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cnpj: d }) });
        if (!r.ok) { addToast('error', (await r.json().catch(() => ({})))?.error || 'Falha ao criar rascunho.'); return; }
        const c = await r.json(); setContrato(c); id = c.id;
      }
      const re = await apiFetch(`/api/contratos/${id}/elegibilidade`);
      const snap = await re.json();
      setEleg(snap);
      await refresh(id!);
    } catch { addToast('error', 'Falha ao avaliar o fornecedor.'); } finally { setBusy(false); }
  };

  const validarJira = async () => {
    const k = jiraKey.trim().toUpperCase();
    if (!/^JUR-\d+$/.test(k)) { setJiraInfo({ ok: false, erro: 'Formato esperado JUR-<número>.' }); return; }
    try {
      const r = await apiFetch(`/api/contratos/jira/${k}`);
      const b = await r.json();
      if (r.ok && b.ok) setJiraInfo({ ok: true, resumo: b.issue?.summary, status: b.issue?.status, alertaDone: b.alertaDone });
      else setJiraInfo({ ok: false, erro: b.error || 'Issue inválida.' });
    } catch { setJiraInfo({ ok: false, erro: 'Falha ao consultar o Jira.' }); }
  };

  // PASSO 2 → 3 — salva doc/jira e roda a extração
  const avancarParaExtracao = async () => {
    if (!contrato) return;
    if (!arquivo) { addToast('error', 'Envie o TR/Proposta (PDF/DOCX).'); return; }
    setBusy(true);
    try {
      const p = await apiFetch(`/api/contratos/${contrato.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tipoDocumentoEntrada: tipoDoc, ...(oc ? { ordemCompra: oc } : {}), ...(jiraKey ? { jiraIssueKey: jiraKey.trim().toUpperCase() } : {}) }) });
      if (!p.ok) { addToast('error', (await p.json().catch(() => ({})))?.error || 'Falha ao salvar o documento/issue.'); return; }
      const fd = new FormData(); fd.append('file', arquivo); fd.append('tipoDocumento', tipoDoc);
      const e = await apiFetch(`/api/contratos/${contrato.id}/extrair`, { method: 'POST', body: fd });
      if (!e.ok) { addToast('error', (await e.json().catch(() => ({})))?.error || 'Falha na extração.'); return; }
      const ex: ExtracaoIA = await e.json();
      setExtr(ex);
      setObjeto(ex.objeto?.valor || '');
      setValorReais(ex.valorTotalCentavos?.valor != null ? (ex.valorTotalCentavos.valor / 100).toFixed(2) : '');
      setVigInicio(ex.vigencia?.dataInicio?.valor || '');
      setDurUnidade('meses');
      setDurValor(ex.vigencia?.duracaoMeses?.valor != null ? String(ex.vigencia.duracaoMeses.valor) : '');
      setVigFim(ex.vigencia?.dataFim?.valor || '');
      setParcelasEdit((ex.parcelas || []).map((p) => ({ numero: p.numero, valorStr: centToReais(p.valorCentavos), vencimento: p.vencimento ?? null, estimada: !p.vencimento })));
      setResumoEscopo(ex.resumoEscopo?.valor || '');
      setCondicoesPagamento(ex.condicoesPagamento?.valor || '');
      setSla(ex.sla?.valor || '');
      setLocalExecucao(ex.localExecucao?.valor || '');
      setEquipamentos(ex.equipamentosFornecidosPelaContratante?.valor || '');
      setCiencias(new Set());
      await refresh(contrato.id);
      armedRef.current = false; setAutosaveStatus('idle');
      setStep(3);
    } catch { addToast('error', 'Falha ao processar o documento.'); } finally { setBusy(false); }
  };

  // Validação cruzada Proposta × cadastro (Cockpit/KYS) (#159): a IA guarda o que a
  // Proposta DECLARA (extr.dadosContratadaNoDocumento); aqui comparamos com o merge
  // determinístico (contrato.dadosContratada) e sinalizamos divergências.
  const divergencias = useMemo(() => {
    const doc = extr?.dadosContratadaNoDocumento; const cad = contrato?.dadosContratada;
    if (!doc || !cad) return [] as { campo: string; doc: string; cad: string }[];
    const out: { campo: string; doc: string; cad: string }[] = [];
    const cmp = (campo: string, docVal: string | null | undefined, cadVal: string | undefined, digits = false) => {
      const dv = String(docVal ?? '').trim(); const cv = String(cadVal ?? '').trim();
      if (!dv || !cv) return;
      const a = digits ? onlyDigits(dv) : dv.toLowerCase().replace(/\s+/g, ' ');
      const b = digits ? onlyDigits(cv) : cv.toLowerCase().replace(/\s+/g, ' ');
      if (a !== b) out.push({ campo, doc: dv, cad: cv });
    };
    cmp('CNPJ', doc.cnpj?.valor, cad.cnpj, true);
    cmp('Razão social', doc.razaoSocial?.valor, cad.razaoSocial);
    cmp('Representante', doc.representante?.valor ?? doc.representanteLegal?.valor ?? doc.nomeRepresentante?.valor, cad.representante?.nome);
    cmp('CPF do representante', doc.cpf?.valor ?? doc.cpfRepresentante?.valor, cad.representante?.cpf, true);
    return out;
  }, [extr, contrato]);

  const alertasPendentes = useMemo(() => {
    if (!extr) return [];
    return [
      ...divergencias.map((d, n) => ({ key: `div-${n}`, label: `Divergência Proposta × cadastro — ${d.campo}: documento "${d.doc}" vs cadastro "${d.cad}"` })),
      ...extr.conflitosComPadrao.map((c, n) => ({ key: `conf-${n}`, label: `Conflito com o padrão: ${c.clausula}` })),
      ...extr.alertas.map((a, n) => ({ key: `al-${n}`, label: a })),
    ];
  }, [extr, divergencias]);

  // Vigência por duração (#146): a vigência começa só após a assinatura, então o operador
  // informa um prazo (dias/meses) + uma data de início estimada; o fim e os vencimentos das
  // parcelas são calculados automaticamente (estimados) e ficam editáveis.
  const recalcVigencia = (inicio: string, unidade: 'meses' | 'dias', valor: string) => {
    const n = parseInt(valor, 10) || 0;
    if (!inicio || n <= 0) return;
    setVigFim(unidade === 'meses' ? addMeses(inicio, n) : addDias(inicio, n));
    setParcelasEdit((prev) => proporVencimentos(prev, inicio));
  };
  const onInicio = (v: string) => { setVigInicio(v); recalcVigencia(v, durUnidade, durValor); };
  const onDurValor = (v: string) => { setDurValor(v); recalcVigencia(vigInicio, durUnidade, v); };
  const onDurUnidade = (u: 'meses' | 'dias') => { setDurUnidade(u); recalcVigencia(vigInicio, u, durValor); };
  const bumpDuracao = (unidade: 'meses' | 'dias', delta: number) => {
    const base = durUnidade === unidade ? (parseInt(durValor, 10) || 0) : 0;
    const novo = String(Math.max(0, base + delta));
    setDurUnidade(unidade); setDurValor(novo); recalcVigencia(vigInicio, unidade, novo);
  };
  const editarVencimento = (i: number, v: string) =>
    setParcelasEdit((prev) => prev.map((p, idx) => (idx === i ? { ...p, vencimento: v || null, estimada: false } : p)));

  // edição de parcelas (#153): valor, adicionar/remover, dividir igualmente e Σ ao vivo.
  const editarValorParcela = (i: number, v: string) =>
    setParcelasEdit((prev) => prev.map((p, idx) => (idx === i ? { ...p, valorStr: v } : p)));
  const removerParcela = (i: number) =>
    setParcelasEdit((prev) => prev.filter((_, idx) => idx !== i).map((p, idx) => ({ ...p, numero: idx + 1 })));
  const addParcela = () =>
    setParcelasEdit((prev) => {
      const numero = prev.length + 1;
      const venc = vigInicio ? addMeses(vigInicio, numero) : null;
      return [...prev, { numero, valorStr: '0,00', vencimento: venc, estimada: !!venc }];
    });
  const dividirIgualmente = () =>
    setParcelasEdit((prev) => {
      const total = reaisToCent(valorReais); const n = prev.length;
      if (!total || !n) return prev;
      const base = Math.floor(total / n);
      return prev.map((p, i) => ({ ...p, valorStr: centToReais(i === n - 1 ? total - base * (n - 1) : base) }));
    });
  const somaParcelasCent = useMemo(() => parcelasEdit.reduce((s, p) => s + reaisToCent(p.valorStr), 0), [parcelasEdit]);
  const totalCent = reaisToCent(valorReais);

  // Corpo do PATCH com os campos da conferência (passo 3) — reusado pelo "gerar minuta" e
  // pelo autosave (#155). Não dispara as validações de geração (essas ficam em /minuta).
  const payloadPasso3 = () => {
    const dMeses = durUnidade === 'meses' ? (parseInt(durValor, 10) || 0) : 0;
    const dDias = durUnidade === 'dias' ? (parseInt(durValor, 10) || 0) : 0;
    return {
      objeto, valorTotalCentavos: reaisToCent(valorReais),
      parcelas: parcelasEdit.map((p) => ({ numero: p.numero, valorCentavos: reaisToCent(p.valorStr), vencimento: p.vencimento ?? null, estimada: p.estimada ?? !p.vencimento })),
      vigenciaInicio: vigInicio || null, vigenciaFim: vigFim || null, vigenciaEstimada: !!(vigInicio || dMeses || dDias),
      vigenciaDuracaoMeses: dMeses, vigenciaDuracaoDias: dDias,
      resumoEscopo, condicoesPagamento, sla, localExecucao, equipamentosFornecidosPelaContratante: equipamentos,
      prorrogavel: !!extr?.vigencia?.prorrogavel?.valor,
    };
  };

  // PASSO 3 → 4 — grava campos finais e gera a minuta
  const avancarParaMinuta = async () => {
    if (!contrato) return;
    if (alertasPendentes.some((a) => !ciencias.has(a.key))) { addToast('error', 'Dê ciência a todos os alertas antes de avançar.'); return; }
    setBusy(true);
    try {
      const p = await apiFetch(`/api/contratos/${contrato.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payloadPasso3()) });
      if (!p.ok) { addToast('error', (await p.json().catch(() => ({})))?.error || 'Falha ao salvar os campos.'); return; }
      await carregarMinuta(contrato.id);
      setStep(4);
    } catch { addToast('error', 'Falha ao salvar.'); } finally { setBusy(false); }
  };

  // Autosave do passo 3 (#155): persiste as edições da conferência ~1,2s após a última
  // alteração (PATCH simples, sem validações de geração). Não salva na primeira passada
  // após semear (armedRef) — só quando o operador realmente edita.
  useEffect(() => {
    if (step !== 3 || !contrato || busy) return;
    if (!armedRef.current) { armedRef.current = true; return; }
    const id = contrato.id;
    const body = JSON.stringify(payloadPasso3());
    const t = setTimeout(async () => {
      setAutosaveStatus('saving');
      try {
        const p = await apiFetch(`/api/contratos/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body });
        setAutosaveStatus(p.ok ? 'saved' : 'erro');
      } catch { setAutosaveStatus('erro'); }
    }, 1200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, contrato, busy, objeto, valorReais, vigInicio, durUnidade, durValor, vigFim, parcelasEdit, resumoEscopo, condicoesPagamento, sla, localExecucao, equipamentos]);

  const carregarMinuta = async (id: string) => {
    const v = await apiFetch(`/api/contratos/${id}/validar`); setValidacao(v.ok ? await v.json() : null);
    const r = await apiFetch(`/api/contratos/${id}/minuta`);
    if (r.ok) setMinuta((await r.json()).html || '');
    else { const b = await r.json().catch(() => ({})); setMinuta(''); addToast('error', b.error || 'Não foi possível gerar a minuta.'); }
  };

  const salvarStatus = async (status: 'rascunho' | 'em_revisao') => {
    if (!contrato) return;
    setBusy(true);
    try {
      const p = await apiFetch(`/api/contratos/${contrato.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status }) });
      if (!p.ok) { addToast('error', 'Falha ao salvar.'); return; }
      addToast('success', status === 'em_revisao' ? 'Enviado para revisão.' : 'Rascunho salvo.');
      onConcluir(contrato.id);
    } finally { setBusy(false); }
  };

  // Cancelar: confirma só quando há edições não salvas na conferência (o rascunho em si já
  // está persistido no servidor desde o passo 1, então voltar entre passos não perde nada).
  const cancelar = () => {
    if (step >= 3 && !window.confirm('Sair da conferência? As edições não salvas nesta etapa serão perdidas — o rascunho permanece na lista.')) return;
    onCancelar();
  };

  return (
    <>
      <ToolHeader light="Novo" accent="contrato" right={<Btn variant="secondary" onClick={cancelar}>Cancelar</Btn>} />
      <main id="main-content" className="flex-1 p-6 sm:p-10 max-w-4xl w-full">
        <Stepper step={step} />

        {step === 1 && (
          <Card className="p-6">
            <h2 ref={headingRef} tabIndex={-1} className="text-[16px] font-semibold mb-1 outline-none">Fornecedor</h2>
            <p className="text-[13px] text-text-secondary mb-4">Informe o CNPJ. A elegibilidade é avaliada no servidor (Receita, diligência, KYS, CNAE, porte).</p>
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1"><span className="text-[12px] text-text-secondary">CNPJ</span>
                <input value={cnpj} onChange={(e) => setCnpj(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !busy) iniciar(); }} inputMode="numeric" placeholder="00.000.000/0000-00" className="h-10 w-[220px] bg-field border border-line rounded-none px-3 text-[14px] outline-none focus:border-primary focus-visible:ring-2 focus-visible:ring-primary" /></label>
              <Btn onClick={iniciar} disabled={busy} aria-busy={busy}>{busy ? <Loader2 size={16} className="animate-spin" aria-hidden /> : <ShieldCheck size={16} aria-hidden />} Avaliar elegibilidade</Btn>
            </div>

            {contrato?.dadosContratada?.razaoSocial && (
              <div className="mt-4 text-[13px]"><span className="text-text-secondary">Fornecedor:</span> <strong>{contrato.dadosContratada.razaoSocial}</strong></div>
            )}

            {eleg && (
              <div className="mt-5" aria-live="polite">
                <div className="flex items-center gap-2 mb-3">
                  {eleg.elegivel ? <Chip tone="success" icon={ShieldCheck}>Elegível</Chip> : <Chip tone="error" icon={ShieldAlert}>Inelegível</Chip>}
                </div>
                <ul className="space-y-2">
                  {eleg.criterios.map((c) => <CriterioRow key={c.id} c={c} cnpj={onlyDigits(cnpj)} contratoId={contrato?.id} apiFetch={apiFetch} addToast={addToast} onReavaliar={iniciar} navigate={navigate} />)}
                </ul>
              </div>
            )}
          </Card>
        )}

        {step === 2 && (
          <Card className="p-6 space-y-4">
            <h2 ref={headingRef} tabIndex={-1} className="text-[16px] font-semibold outline-none">Documento de entrada</h2>
            <div className="flex gap-3 items-center" role="radiogroup" aria-label="Tipo do documento de entrada">
              <span className="text-[13px] text-text-secondary" aria-hidden>Tipo:</span>
              {(['tr', 'proposta'] as const).map((t) => (
                <button key={t} type="button" role="radio" aria-checked={tipoDoc === t} onClick={() => setTipoDoc(t)} className={cn('h-9 px-3 text-[13px] border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary', tipoDoc === t ? 'border-primary text-primary' : 'border-line text-text-secondary')}>{t === 'tr' ? 'Termo de Referência' : 'Proposta Comercial'}</button>
              ))}
            </div>
            <label className="block">
              <span className="text-[12px] text-text-secondary">Arquivo (PDF ou DOCX)</span>
              <div className="mt-1 flex items-center gap-3">
                <input type="file" accept=".pdf,.docx" onChange={(e) => setArquivo(e.target.files?.[0] || null)} className="text-[13px]" />
                {arquivo && <Chip tone="info" icon={FileText} size="sm">{arquivo.name}</Chip>}
              </div>
            </label>
            <div className="flex flex-wrap gap-4">
              <label className="flex flex-col gap-1"><span className="text-[12px] text-text-secondary">Issue Jira (projeto JUR)</span>
                <div className="flex gap-2">
                  <input value={jiraKey} onChange={(e) => { setJiraKey(e.target.value); setJiraInfo(null); }} onBlur={validarJira} placeholder="JUR-123" className="h-10 w-[160px] bg-field border border-line rounded-none px-3 text-[14px] outline-none focus:border-primary focus-visible:ring-2 focus-visible:ring-primary" />
                  <Btn variant="secondary" size="sm" onClick={validarJira}>Validar</Btn>
                </div>
              </label>
              <label className="flex flex-col gap-1"><span className="text-[12px] text-text-secondary">Nº da Ordem de Compra (opcional)</span>
                <input value={oc} onChange={(e) => setOc(e.target.value)} className="h-10 w-[200px] bg-field border border-line rounded-none px-3 text-[14px] outline-none focus:border-primary focus-visible:ring-2 focus-visible:ring-primary" /></label>
            </div>
            <div aria-live="polite">{jiraInfo && (jiraInfo.ok
              ? <div className="text-[13px] text-text-secondary">✓ <strong className="text-text">{jiraKey.toUpperCase()}</strong> — {jiraInfo.resumo} <Chip tone={jiraInfo.alertaDone ? 'warning' : 'neutral'} size="sm">{jiraInfo.status}</Chip>{jiraInfo.alertaDone && <span className="text-warning ml-2">issue concluída — confirme</span>}</div>
              : <div className="text-[13px] text-error">{jiraInfo.erro}</div>)}</div>
          </Card>
        )}

        {step === 3 && extr && (
          <Card className="p-6 space-y-5">
            <h2 ref={headingRef} tabIndex={-1} className="text-[16px] font-semibold outline-none">Conferência da extração</h2>
            <div className="flex items-start justify-between gap-3">
              <p className="text-[13px] text-text-secondary">A IA apenas extraiu os dados (cada campo cita o trecho-fonte). Confira e edite o que for necessário — as edições são salvas automaticamente.</p>
              <span aria-live="polite" className="shrink-0 text-[12px] text-text-secondary mt-0.5">
                {autosaveStatus === 'saving' ? 'Salvando…' : autosaveStatus === 'saved' ? '✓ Rascunho salvo' : autosaveStatus === 'erro' ? <span className="text-error">⚠ Falha ao salvar</span> : ''}
              </span>
            </div>

            {extr.lacunas.length > 0 && (
              <div className="border border-warning/40 bg-warning/5 p-3 text-[13px]"><strong className="text-warning">Lacunas:</strong> {extr.lacunas.join('; ')}.</div>
            )}

            <div className="grid sm:grid-cols-2 gap-4">
              <Campo label="Objeto"><textarea value={objeto} onChange={(e) => setObjeto(e.target.value)} rows={2} className="w-full bg-field border border-line rounded-none px-3 py-2 text-[14px] outline-none focus:border-primary focus-visible:ring-2 focus-visible:ring-primary" /><Fonte texto={extr.objeto?.trechoFonte} /></Campo>
              <Campo label="Valor total (R$)"><input inputMode="decimal" value={valorReais} onChange={(e) => setValorReais(e.target.value)} placeholder="0,00" className="h-10 w-full bg-field border border-line rounded-none px-3 text-[14px] outline-none focus:border-primary focus-visible:ring-2 focus-visible:ring-primary" /><Fonte texto={extr.valorTotalCentavos?.trechoFonte} /></Campo>
            </div>

            {/* Vigência por duração — começa só após a assinatura; fim calculado e estimado (#146) */}
            <fieldset className="border border-line p-4 space-y-3">
              <legend className="text-[12px] text-text-secondary px-1">Vigência — conta a partir da assinatura</legend>
              <div className="grid sm:grid-cols-2 gap-4">
                <Campo label="Data de início (estimada — pós-assinatura)">
                  <input type="date" value={vigInicio} onChange={(e) => onInicio(e.target.value)} className="h-10 w-full bg-field border border-line rounded-none px-3 text-[14px] outline-none focus:border-primary focus-visible:ring-2 focus-visible:ring-primary" />
                  <Fonte texto={extr.vigencia?.dataInicio?.trechoFonte} />
                </Campo>
                <Campo label="Prazo de vigência">
                  <div className="flex items-center gap-2">
                    <input type="number" min={0} value={durValor} onChange={(e) => onDurValor(e.target.value)} placeholder="0" aria-label="Quantidade do prazo de vigência" className="h-10 w-20 bg-field border border-line rounded-none px-3 text-[14px] outline-none focus:border-primary focus-visible:ring-2 focus-visible:ring-primary" />
                    <div className="inline-flex" role="radiogroup" aria-label="Unidade do prazo de vigência">
                      {(['meses', 'dias'] as const).map((u) => (
                        <button key={u} type="button" role="radio" aria-checked={durUnidade === u} onClick={() => onDurUnidade(u)} className={cn('h-10 px-3 text-[13px] border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary', durUnidade === u ? 'border-primary text-primary' : 'border-line text-text-secondary')}>{u}</button>
                      ))}
                    </div>
                  </div>
                  <Fonte texto={extr.vigencia?.duracaoMeses?.trechoFonte} />
                </Campo>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[12px] text-text-secondary mr-1">Adicionar:</span>
                {[1, 3, 6, 12].map((m) => <button key={`m${m}`} type="button" onClick={() => bumpDuracao('meses', m)} className="h-8 px-2.5 text-[12px] border border-line text-text-secondary hover:border-primary hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">+{m} {m === 1 ? 'mês' : 'meses'}</button>)}
                {[30, 60, 90].map((d) => <button key={`d${d}`} type="button" onClick={() => bumpDuracao('dias', d)} className="h-8 px-2.5 text-[12px] border border-line text-text-secondary hover:border-primary hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">+{d} dias</button>)}
              </div>
              <Campo label="Fim da vigência (calculado — estimado, editável)">
                <input type="date" value={vigFim} onChange={(e) => setVigFim(e.target.value)} className="h-10 w-full sm:w-[220px] bg-field border border-line rounded-none px-3 text-[14px] outline-none focus:border-primary focus-visible:ring-2 focus-visible:ring-primary" />
                <Fonte texto={extr.vigencia?.dataFim?.trechoFonte} />
              </Campo>
              <p className="text-[12px] text-text-secondary">A data de fim é uma estimativa derivada do início + prazo; a vigência real começa na assinatura.</p>
            </fieldset>

            {/* Parcelas editáveis — valor, datas, add/remover, dividir igualmente e Σ ao vivo (#146/#153) */}
            <div>
              <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                <div className="text-[13px] font-medium">Parcelas ({parcelasEdit.length})</div>
                <div className="flex gap-2">
                  <Btn variant="secondary" size="sm" onClick={dividirIgualmente} disabled={!parcelasEdit.length || !totalCent}>Dividir igualmente</Btn>
                  <Btn variant="secondary" size="sm" onClick={addParcela}><Plus size={14} aria-hidden /> Parcela</Btn>
                </div>
              </div>
              {parcelasEdit.length === 0 ? (
                <p className="text-[13px] text-text-secondary">Nenhuma parcela — adicione ao menos uma.</p>
              ) : (
                <ul className="space-y-2">
                  {parcelasEdit.map((p, i) => (
                    <li key={i} className="flex flex-wrap items-center gap-3 text-[13px]">
                      <span className="w-14 text-text-secondary shrink-0">Parc. {p.numero}</span>
                      <label className="flex items-center gap-1.5">
                        <span className="text-[12px] text-text-secondary">R$</span>
                        <input inputMode="decimal" value={p.valorStr} onChange={(e) => editarValorParcela(i, e.target.value)} aria-label={`Valor da parcela ${p.numero}`} className="h-9 w-28 bg-field border border-line rounded-none px-2 text-[13px] text-right outline-none focus:border-primary focus-visible:ring-2 focus-visible:ring-primary" />
                      </label>
                      <label className="flex items-center gap-2">
                        <span className="text-[12px] text-text-secondary">vence</span>
                        <input type="date" value={p.vencimento || ''} onChange={(e) => editarVencimento(i, e.target.value)} aria-label={`Vencimento da parcela ${p.numero}`} className="h-9 bg-field border border-line rounded-none px-2 text-[13px] outline-none focus:border-primary focus-visible:ring-2 focus-visible:ring-primary" />
                      </label>
                      {p.vencimento && p.estimada && <Chip tone="neutral" size="sm">estimado</Chip>}
                      <IconBtn label={`Remover parcela ${p.numero}`} onClick={() => removerParcela(i)} className="ml-auto"><Trash2 size={14} aria-hidden /></IconBtn>
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-2 text-[12px]" aria-live="polite">
                <span className="text-text-secondary">Soma das parcelas: </span>
                <span className="font-mono">{fmtMoeda(somaParcelasCent)}</span>
                {totalCent > 0 && (somaParcelasCent === totalCent
                  ? <span className="text-success ml-2">✓ confere com o total</span>
                  : <span className="text-error ml-2">✗ difere do total ({fmtMoeda(totalCent)})</span>)}
              </div>
              <p className="text-[12px] text-text-secondary mt-1">Vencimentos propostos (mensais) a partir da data de início; edite valor e datas, adicione ou remova parcelas.</p>
            </div>

            {/* Demais campos extraídos — conferíveis e editáveis, com trecho-fonte (#152) */}
            <fieldset className="border border-line p-4 space-y-4">
              <legend className="text-[12px] text-text-secondary px-1">Escopo e condições (conferência)</legend>
              <Campo label="Resumo do escopo">
                <textarea value={resumoEscopo} onChange={(e) => setResumoEscopo(e.target.value)} rows={2} className="w-full bg-field border border-line rounded-none px-3 py-2 text-[14px] outline-none focus:border-primary focus-visible:ring-2 focus-visible:ring-primary" />
                <Fonte texto={extr.resumoEscopo?.trechoFonte} />
              </Campo>
              <Campo label="Condições de pagamento">
                <textarea value={condicoesPagamento} onChange={(e) => setCondicoesPagamento(e.target.value)} rows={2} className="w-full bg-field border border-line rounded-none px-3 py-2 text-[14px] outline-none focus:border-primary focus-visible:ring-2 focus-visible:ring-primary" />
                <Fonte texto={extr.condicoesPagamento?.trechoFonte} />
              </Campo>
              <div className="grid sm:grid-cols-2 gap-4">
                <Campo label="SLA / prazo de resposta">
                  <input value={sla} onChange={(e) => setSla(e.target.value)} className="h-10 w-full bg-field border border-line rounded-none px-3 text-[14px] outline-none focus:border-primary focus-visible:ring-2 focus-visible:ring-primary" />
                  <Fonte texto={extr.sla?.trechoFonte} />
                </Campo>
                <Campo label="Local de execução">
                  <input value={localExecucao} onChange={(e) => setLocalExecucao(e.target.value)} className="h-10 w-full bg-field border border-line rounded-none px-3 text-[14px] outline-none focus:border-primary focus-visible:ring-2 focus-visible:ring-primary" />
                  <Fonte texto={extr.localExecucao?.trechoFonte} />
                </Campo>
              </div>
              <Campo label="Equipamentos fornecidos pela contratante">
                <input value={equipamentos} onChange={(e) => setEquipamentos(e.target.value)} className="h-10 w-full bg-field border border-line rounded-none px-3 text-[14px] outline-none focus:border-primary focus-visible:ring-2 focus-visible:ring-primary" />
                <Fonte texto={extr.equipamentosFornecidosPelaContratante?.trechoFonte} />
              </Campo>
            </fieldset>

            {alertasPendentes.length > 0 && (
              <div className="border border-line p-4" role="group" aria-label="Alertas com ciência obrigatória">
                <h3 className="text-[14px] font-semibold mb-2 flex items-center gap-2"><AlertTriangle size={15} className="text-warning" aria-hidden /> Alertas — ciência obrigatória</h3>
                <ul className="space-y-2">
                  {alertasPendentes.map((a) => (
                    <li key={a.key} className="text-[13px]">
                      <label className="flex items-start gap-2 cursor-pointer">
                        <input type="checkbox" checked={ciencias.has(a.key)} onChange={(e) => { const n = new Set(ciencias); e.target.checked ? n.add(a.key) : n.delete(a.key); setCiencias(n); }} className="mt-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" />
                        <span>{a.label}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Card>
        )}

        {step === 4 && (
          <Card className="p-6 space-y-4">
            <h2 ref={headingRef} tabIndex={-1} className="text-[16px] font-semibold outline-none">Minuta</h2>
            {validacao && !validacao.ok && (
              <div role="alert" className="border border-error/40 bg-error/5 p-3 text-[13px]"><strong className="text-error">Pendências:</strong> {validacao.bloqueios.join('; ')}.</div>
            )}
            {validacao && validacao.avisos.length > 0 && (
              <div aria-live="polite" className="border border-warning/40 bg-warning/5 p-3 text-[13px]"><strong className="text-warning">Avisos:</strong> {validacao.avisos.join('; ')}.</div>
            )}
            <div role="region" aria-label="Pré-visualização da minuta" tabIndex={0} className="border border-line bg-white max-h-[480px] overflow-y-auto p-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" dangerouslySetInnerHTML={{ __html: minuta }} />
            <div className="flex flex-wrap gap-3">
              <Btn variant="secondary" onClick={() => contrato && window.open(`/api/contratos/${contrato.id}/minuta?formato=pdf`, '_blank')}><FileText size={16} aria-hidden /> Baixar PDF</Btn>
              <Btn variant="secondary" onClick={() => salvarStatus('rascunho')} disabled={busy} aria-busy={busy}>Salvar rascunho</Btn>
              <Btn onClick={() => salvarStatus('em_revisao')} disabled={busy || (validacao ? !validacao.ok : false)} aria-busy={busy}>Enviar para revisão</Btn>
            </div>
          </Card>
        )}

        {step === 5 && (
          <Card className="p-6 space-y-2"><h2 ref={headingRef} tabIndex={-1} className="flex items-center gap-2 text-[16px] font-semibold outline-none"><Lock size={16} aria-hidden /> Aprovação e assinatura</h2>
            <p className="text-[13px] text-text-secondary">Salve/Envie para revisão no passo anterior. A <strong>aprovação humana</strong> (obrigatória) e o <strong>envio ao Documenso</strong> são feitos na <strong>ficha do contrato</strong> (botões Gerar pacote → Aprovar → Enviar para assinatura), para permitir revisão por outra pessoa.</p>
          </Card>
        )}

        {/* navegação */}
        <div className="flex justify-between mt-6">
          <Btn variant="ghost" onClick={() => step > 1 ? setStep(step - 1) : cancelar()} disabled={busy}><ChevronLeft size={16} aria-hidden /> {step > 1 ? 'Voltar' : 'Cancelar'}</Btn>
          {step === 1 && <Btn onClick={() => setStep(2)} disabled={!eleg?.elegivel}>Avançar <ChevronRight size={16} aria-hidden /></Btn>}
          {step === 2 && <Btn onClick={avancarParaExtracao} disabled={busy || !arquivo} aria-busy={busy}>{busy ? <Loader2 size={16} className="animate-spin" aria-hidden /> : null} Extrair e conferir <ChevronRight size={16} aria-hidden /></Btn>}
          {step === 3 && <Btn onClick={avancarParaMinuta} disabled={busy} aria-busy={busy}>{busy ? <Loader2 size={16} className="animate-spin" aria-hidden /> : null} Gerar minuta <ChevronRight size={16} aria-hidden /></Btn>}
          {step === 4 && <Btn variant="secondary" onClick={() => setStep(5)}>Próximo <ChevronRight size={16} aria-hidden /></Btn>}
        </div>
      </main>
    </>
  );
}

function Campo({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block"><span className="text-[12px] text-text-secondary">{label}</span><div className="mt-1">{children}</div></label>;
}

// Trecho-fonte da extração: citação literal do TR/Proposta que originou o campo (#152).
// Reforça o guard-rail "a IA só extrai; o humano confere". Vazio = não citado no documento.
function Fonte({ texto }: { texto?: string | null }) {
  const t = String(texto || '').trim();
  return (
    <span className="block mt-1 text-[11px] text-text-secondary italic">
      {t ? <>Fonte: “{t}”</> : <span className="not-italic opacity-70">Sem trecho-fonte (não citado no documento)</span>}
    </span>
  );
}

function CriterioRow({ c, cnpj, contratoId, apiFetch, addToast, onReavaliar, navigate }: { c: CriterioElegibilidade; cnpj: string; contratoId?: string; apiFetch: ContratosAppProps['apiFetch']; addToast: ContratosAppProps['addToast']; onReavaliar: () => void; navigate?: (p: string) => void }) {
  const [just, setJust] = useState('');
  const [open, setOpen] = useState(false);
  const podeJustificar = c.bloqueia && c.resultado === 'alerta' && !c.justificativa;
  const justificar = async () => {
    if (!contratoId || just.trim().length < 10) { addToast('error', 'Justificativa de no mínimo 10 caracteres.'); return; }
    const r = await apiFetch(`/api/contratos/${contratoId}/elegibilidade/justificar`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ criterioId: c.id, justificativa: just.trim() }) });
    if (r.ok) { addToast('success', 'Prosseguimento justificado.'); setOpen(false); onReavaliar(); }
    else addToast('error', 'Falha ao registrar a justificativa.');
  };
  return (
    <li className="border border-line p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-[13px]"><Chip tone={CRIT_TONE[c.resultado] || 'neutral'} size="sm">{c.resultado}</Chip><strong>{c.nome}</strong></div>
        {c.id === 'diligencia' && c.bloqueia && navigate && <button onClick={() => navigate(`/fornecedores/${cnpj}`)} className="text-[12px] text-primary inline-flex items-center gap-1">Abrir ficha <ExternalLink size={12} /></button>}
      </div>
      <div className="text-[12px] text-text-secondary mt-1">{c.detalhe}{c.justificativa && <span className="text-success"> · justificado por {c.aprovador}</span>}</div>
      {podeJustificar && (open ? (
        <div className="mt-2 flex gap-2">
          <input value={just} onChange={(e) => setJust(e.target.value)} placeholder="Justificativa (mín. 10 caracteres)" className="h-9 flex-1 bg-field border border-line rounded-none px-2 text-[13px] outline-none focus:border-primary" />
          <Btn size="sm" onClick={justificar}>Registrar</Btn>
        </div>
      ) : <button onClick={() => setOpen(true)} className="mt-2 text-[12px] text-primary">Justificar prosseguimento</button>)}
    </li>
  );
}

// ── Detalhe (#135) ───────────────────────────────────────────────────────────────
function DetalheView({ id, apiFetch, addToast, navigate, onVoltar, onNovoAditivo, onEditar }: { id: string; apiFetch: ContratosAppProps['apiFetch']; addToast: ContratosAppProps['addToast']; navigate?: (p: string) => void; onVoltar: () => void; onNovoAditivo: () => void; onEditar: () => void }) {
  const [c, setC] = useState<Contrato | null>(null);
  const [erro, setErro] = useState(false);
  const [aditivos, setAditivos] = useState<any[]>([]);
  useEffect(() => { (async () => {
    try { const r = await apiFetch(`/api/contratos/${id}`); if (r.ok) setC(await r.json()); else setErro(true); }
    catch { setErro(true); }
    try { const a = await apiFetch(`/api/contratos/${id}/aditivos`); if (a.ok) setAditivos(await a.json()); } catch { /* */ }
  })(); }, [id]);

  const reload = async () => { try { const r = await apiFetch(`/api/contratos/${id}`); if (r.ok) setC(await r.json()); } catch { /* */ } };
  const acao = async (metodo: string, sub: string, okMsg: string) => {
    try {
      const r = await apiFetch(`/api/contratos/${id}/${sub}`, { method: metodo });
      const b = await r.json().catch(() => ({}));
      if (r.ok) { addToast('success', okMsg); await reload(); } else addToast('error', b.error || 'Falha na ação.');
    } catch { addToast('error', 'Falha na ação.'); }
  };

  if (erro) return <main className="p-10"><EmptyState icon={FileSignature} title="Contrato não encontrado" action={<Btn onClick={onVoltar}>Voltar</Btn>} /></main>;
  if (!c) return <main className="p-10 text-text-secondary flex items-center gap-2"><Loader2 size={16} className="animate-spin" /> Carregando…</main>;

  const jiraBase = ''; // o link absoluto é montado no backend; aqui só exibimos a key
  return (
    <>
      <ToolHeader light="Contrato" accent={c.jira?.issueKey || c.id} right={<div className="flex gap-2"><Btn variant="ghost" onClick={onVoltar}><ChevronLeft size={16} /> Voltar</Btn>{statusChip(c.status)}</div>} />
      <main id="main-content" className="flex-1 p-6 sm:p-10 max-w-4xl w-full space-y-5">
        <Card className="p-5">
          <div className="grid sm:grid-cols-2 gap-4 text-[14px]">
            <Info label="Fornecedor" value={`${c.dadosContratada?.razaoSocial || '—'} (${maskCnpj(c.cnpj)})`} />
            <Info label="Issue Jira (identificador)" value={c.jira?.issueKey ? `${c.jira.issueKey}${c.jira.status ? ` · ${c.jira.status}` : ''}` : '—'} />
            <Info label="Objeto" value={c.objeto || c.extracao?.objeto?.valor || '—'} />
            <Info label="Valor" value={c.valorTotalCentavos ? fmtMoeda(c.valorTotalCentavos) : '—'} />
            <Info label="Vigência" value={c.vigenciaFim ? `até ${fmtData(c.vigenciaFim)}` : '—'} />
            <Info label="Ordem de compra" value={c.ordemCompra || '—'} />
            <Info label="Chave interna" value={c.id} />
          </div>
          <div className="flex flex-wrap gap-2 mt-4">
            {['rascunho', 'em_revisao'].includes(c.status) && <Btn variant="secondary" onClick={onEditar}><Pencil size={16} aria-hidden /> Editar</Btn>}
            <Btn variant="secondary" onClick={() => window.open(`/api/contratos/${c.id}/minuta?formato=pdf`, '_blank')}><FileText size={16} /> Minuta (PDF)</Btn>
            {['rascunho', 'em_revisao'].includes(c.status) && <Btn variant="secondary" onClick={() => acao('POST', 'gerar-pdf', 'Pacote gerado (Contrato + TR + T&C).')}>Gerar pacote</Btn>}
            {c.anexos?.pacote && !c.aprovacao && <Btn onClick={() => { if (window.confirm('Aprovar este contrato? Sua aprovação fica registrada na trilha (HITL).')) acao('POST', 'aprovar', 'Contrato aprovado.'); }}><Check size={16} /> Aprovar (HITL)</Btn>}
            {c.status === 'aprovado' && <Btn onClick={() => { if (window.confirm('Enviar o contrato para assinatura via Documenso? Serão disparados e-mails aos aprovadores e signatários.')) acao('POST', 'enviar-assinatura', 'Enviado para assinatura.'); }}><Upload size={16} aria-hidden /> Enviar para assinatura</Btn>}
            {c.status === 'enviado_assinatura' && !c.documenso?.fallback && <Btn variant="secondary" onClick={() => acao('GET', 'assinatura/status', 'Status verificado.')}>Verificar assinatura</Btn>}
            {c.documenso?.fallback && <Btn variant="secondary" onClick={() => window.open(`/api/contratos/${c.id}/anexos/pacote.pdf`, '_blank')}><FileText size={16} /> Baixar pacote (envio manual)</Btn>}
            {c.anexos?.assinado && <Btn variant="secondary" onClick={() => window.open(`/api/contratos/${c.id}/anexos/assinado.pdf`, '_blank')}><FileText size={16} /> Baixar assinado</Btn>}
            {c.status === 'assinado' && <Btn variant="secondary" onClick={onNovoAditivo}><Plus size={16} /> Novo aditivo</Btn>}
            {c.jira?.issueKey && <Btn variant="secondary" onClick={() => acao('POST', 'jira/reenviar', 'Reenviado ao Jira.')}>Reenviar ao Jira</Btn>}
          </div>
          {c.jiraSync && c.jiraSync.length > 0 && (
            <div className="mt-3 text-[12px] text-text-secondary">
              Sincronização Jira: {c.jiraSync.map((s: any, i: number) => <span key={i} className="mr-2">{s.marco} <span className={s.ok ? 'text-success' : 'text-error'}>{s.ok ? '✓' : '✗'}</span></span>)}
            </div>
          )}
        </Card>

        {c.elegibilidadeSnapshot && (
          <Card className="p-5">
            <h3 className="text-[14px] font-semibold mb-3">Elegibilidade <span className="text-[12px] text-text-secondary font-normal">(congelada em {fmtData(c.elegibilidadeSnapshot.avaliadoEm)})</span></h3>
            <ul className="space-y-1.5 text-[13px]">{c.elegibilidadeSnapshot.criterios.map((x) => <li key={x.id} className="flex items-center gap-2"><Chip tone={CRIT_TONE[x.resultado] || 'neutral'} size="sm">{x.resultado}</Chip>{x.nome}</li>)}</ul>
          </Card>
        )}

        <Card className="p-5">
          <div className="flex items-center justify-between gap-2 mb-3">
            <h3 className="text-[14px] font-semibold flex items-center gap-2"><ListChecks size={15} /> Termos aditivos {aditivos.length > 0 && <span className="text-[12px] text-text-secondary font-normal">({aditivos.length})</span>}</h3>
            {c.status === 'assinado' && <Btn variant="secondary" size="sm" onClick={onNovoAditivo}><Plus size={14} /> Novo aditivo</Btn>}
          </div>
          {aditivos.length === 0 ? <p className="text-[13px] text-text-secondary">Nenhum aditivo.{c.status !== 'assinado' && ' Aditivos só sobre contrato assinado.'}</p>
            : <ul className="space-y-2">{aditivos.map((a: any) => (
                <li key={a.id} className="flex items-center justify-between gap-2 text-[13px] border-b border-line pb-2 last:border-0">
                  <div><span className="font-mono text-[12px]">{a.jira?.issueKey || c.jira?.issueKey || a.id}</span> <span className="text-text-secondary">· {a.numeroOrdinal}º aditivo · {a.tipo}</span>{a.variacaoPercentual != null && <span className="text-text-secondary"> · {a.variacaoPercentual > 0 ? '+' : ''}{a.variacaoPercentual}%</span>} <span className="font-mono text-[11px] text-text-secondary">({a.id})</span></div>
                  <a href={`/api/contratos/${id}/aditivos/${a.id}/minuta?formato=pdf`} target="_blank" rel="noopener noreferrer" className="text-primary inline-flex items-center gap-1 text-[12px]"><FileText size={12} /> minuta</a>
                </li>))}</ul>}
        </Card>

        <Card className="p-5">
          <h3 className="text-[14px] font-semibold mb-3 flex items-center gap-2"><Clock size={15} /> Linha do tempo</h3>
          <ol className="space-y-2">
            {(c.trilha || []).slice().reverse().map((e, i) => (
              <li key={i} className="text-[13px] flex gap-3"><span className="text-text-secondary font-mono text-[12px] whitespace-nowrap">{fmtData(e.ts)} {String(e.ts).slice(11, 16)}</span><span><strong>{e.acao}</strong>{e.resumo ? ` — ${e.resumo}` : ''} <span className="text-text-secondary">· {e.usuario}</span></span></li>
            ))}
          </ol>
        </Card>
      </main>
    </>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return <div><div className="text-[12px] text-text-secondary">{label}</div><div className="text-text">{value}</div></div>;
}

// ── Wizard de aditivo (#138) ─────────────────────────────────────────────────────
const TIPOS_ADITIVO = [
  { v: 'prorrogacao', label: 'Prorrogação de vigência' },
  { v: 'valor_parcelas', label: 'Valor / parcelas' },
  { v: 'escopo', label: 'Escopo (novo TR)' },
  { v: 'dados_cadastrais', label: 'Dados cadastrais' },
];
function AditivoWizard({ contratoId, apiFetch, addToast, onConcluir, onCancelar }: { contratoId: string; apiFetch: ContratosAppProps['apiFetch']; addToast: ContratosAppProps['addToast']; onConcluir: () => void; onCancelar: () => void }) {
  const [c, setC] = useState<Contrato | null>(null);
  const [tipo, setTipo] = useState('prorrogacao');
  const [busy, setBusy] = useState(false);
  const [vigNova, setVigNova] = useState('');
  const [valorNovo, setValorNovo] = useState('');
  const [nParcelas, setNParcelas] = useState('1');
  const [escopo, setEscopo] = useState('');
  const [arquivo, setArquivo] = useState<File | null>(null);
  const [descricao, setDescricao] = useState('');
  const [criado, setCriado] = useState<any | null>(null);
  const [minuta, setMinuta] = useState('');

  useEffect(() => { (async () => { try { const r = await apiFetch(`/api/contratos/${contratoId}`); if (r.ok) setC(await r.json()); } catch { /* */ } })(); }, [contratoId]);

  const submeter = async () => {
    setBusy(true);
    try {
      const payload: any = { tipo, ...(descricao ? { descricao } : {}) };
      if (tipo === 'prorrogacao') { if (!vigNova) { addToast('error', 'Informe a nova data de fim.'); return; } payload.vigenciaNovaFim = vigNova; }
      if (tipo === 'valor_parcelas') {
        const v = Math.round(parseFloat(valorNovo.replace(',', '.')) * 100) || 0; const n = Math.max(1, parseInt(nParcelas, 10) || 1);
        if (!v) { addToast('error', 'Informe o novo valor.'); return; }
        payload.valorNovoCentavos = v;
        const baseP = Math.floor(v / n); const resto = v - baseP * n;
        payload.parcelasNovas = Array.from({ length: n }, (_, i) => ({ numero: i + 1, valorCentavos: baseP + (i === n - 1 ? resto : 0), vencimento: null }));
      }
      if (tipo === 'escopo') { if (!escopo && !arquivo) { addToast('error', 'Informe o novo escopo ou anexe o novo TR.'); return; } payload.escopoNovo = escopo; }
      if (tipo === 'dados_cadastrais') { payload.dadosCadastraisNovos = { observacoes: descricao }; }

      let r: Response;
      if (tipo === 'escopo' && arquivo) { const fd = new FormData(); fd.append('payload', JSON.stringify(payload)); fd.append('file', arquivo); r = await apiFetch(`/api/contratos/${contratoId}/aditivos`, { method: 'POST', body: fd }); }
      else r = await apiFetch(`/api/contratos/${contratoId}/aditivos`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      if (!r.ok) { addToast('error', (await r.json().catch(() => ({})))?.error || 'Falha ao criar o aditivo.'); return; }
      const ad = await r.json(); setCriado(ad);
      const m = await apiFetch(`/api/contratos/${contratoId}/aditivos/${ad.id}/minuta`); if (m.ok) setMinuta((await m.json()).html || '');
      addToast('success', `Aditivo ${ad.id} criado.`);
    } catch { addToast('error', 'Falha ao criar o aditivo.'); } finally { setBusy(false); }
  };

  return (
    <>
      <ToolHeader light="Novo" accent="aditivo" right={<Btn variant="secondary" onClick={onCancelar}>Voltar ao contrato</Btn>} />
      <main id="main-content" className="flex-1 p-6 sm:p-10 max-w-3xl w-full space-y-5">
        {c && <div className="text-[13px] text-text-secondary">Contrato <strong className="text-text font-mono">{c.id}</strong> — {c.dadosContratada?.razaoSocial} · {STATUS[c.status]?.label}{c.status !== 'assinado' && <span className="text-warning"> (aditivos só sobre contrato assinado)</span>}</div>}
        {criado ? (
          <Card className="p-6 space-y-4">
            <div className="flex items-center gap-2 text-[14px]"><Check size={16} className="text-success" /> Aditivo <strong className="font-mono">{criado.id}</strong> criado ({criado.numeroOrdinal}º).</div>
            <div className="border border-line bg-white max-h-[440px] overflow-y-auto p-6" dangerouslySetInnerHTML={{ __html: minuta }} />
            <div className="flex gap-3">
              <Btn variant="secondary" onClick={() => window.open(`/api/contratos/${contratoId}/aditivos/${criado.id}/minuta?formato=pdf`, '_blank')}><FileText size={16} /> Baixar PDF</Btn>
              <Btn onClick={onConcluir}>Concluir</Btn>
            </div>
          </Card>
        ) : (
          <Card className="p-6 space-y-4">
            <Campo label="Tipo de aditivo">
              <div className="flex flex-wrap gap-2">{TIPOS_ADITIVO.map((t) => <button key={t.v} onClick={() => setTipo(t.v)} className={cn('h-9 px-3 text-[13px] border', tipo === t.v ? 'border-primary text-primary' : 'border-line text-text-secondary')}>{t.label}</button>)}</div>
            </Campo>
            {tipo === 'prorrogacao' && <Campo label="Nova data de fim da vigência"><input type="date" value={vigNova} onChange={(e) => setVigNova(e.target.value)} className="h-10 bg-field border border-line rounded-none px-3 text-[14px] outline-none focus:border-primary" /></Campo>}
            {tipo === 'valor_parcelas' && <div className="grid sm:grid-cols-2 gap-4">
              <Campo label="Novo valor total (R$)"><input value={valorNovo} onChange={(e) => setValorNovo(e.target.value)} placeholder="0,00" className="h-10 w-full bg-field border border-line rounded-none px-3 text-[14px] outline-none focus:border-primary" /></Campo>
              <Campo label="Nº de parcelas"><input type="number" min={1} value={nParcelas} onChange={(e) => setNParcelas(e.target.value)} className="h-10 w-full bg-field border border-line rounded-none px-3 text-[14px] outline-none focus:border-primary" /></Campo>
            </div>}
            {tipo === 'escopo' && <>
              <Campo label="Nova descrição do objeto"><textarea value={escopo} onChange={(e) => setEscopo(e.target.value)} rows={3} className="w-full bg-field border border-line rounded-none px-3 py-2 text-[14px] outline-none focus:border-primary" /></Campo>
              <Campo label="Novo Termo de Referência (PDF/DOCX) — roda a checagem estrutural"><input type="file" accept=".pdf,.docx" onChange={(e) => setArquivo(e.target.files?.[0] || null)} className="text-[13px]" /></Campo>
            </>}
            {tipo === 'dados_cadastrais' && <Campo label="Dados a atualizar"><textarea value={descricao} onChange={(e) => setDescricao(e.target.value)} rows={2} className="w-full bg-field border border-line rounded-none px-3 py-2 text-[14px] outline-none focus:border-primary" /></Campo>}
            {tipo !== 'dados_cadastrais' && <Campo label="Observações (opcional)"><input value={descricao} onChange={(e) => setDescricao(e.target.value)} className="h-10 w-full bg-field border border-line rounded-none px-3 text-[14px] outline-none focus:border-primary" /></Campo>}
            <div className="flex justify-between pt-2">
              <Btn variant="ghost" onClick={onCancelar}>Cancelar</Btn>
              <Btn onClick={submeter} disabled={busy || c?.status !== 'assinado'}>{busy ? <Loader2 size={16} className="animate-spin" /> : null} Gerar aditivo</Btn>
            </div>
          </Card>
        )}
      </main>
    </>
  );
}

function AjudaView() {
  return (
    <main id="main-content" className="flex-1 p-6 sm:p-10 max-w-3xl w-full">
      <ToolHeader light="Como" accent="usar" />
      <Card className="p-6 mt-6 text-[14px] space-y-3 leading-relaxed">
        <p>A ferramenta <strong>Contratos</strong> gera contratos de prestação de serviços (PJ) a partir de um <strong>Termo de Referência</strong> ou <strong>Proposta</strong>, em 5 passos:</p>
        <ol className="list-decimal pl-5 space-y-1 text-text-secondary">
          <li><strong className="text-text">Fornecedor</strong> — só fornecedores <em>elegíveis</em> avançam (Receita ativa, diligência válida, KYS assinado).</li>
          <li><strong className="text-text">Documento</strong> — envie o TR/Proposta e vincule a issue do Jira (projeto JUR).</li>
          <li><strong className="text-text">Conferência</strong> — a IA <em>extrai</em> os dados (nunca redige); confira, resolva as lacunas estruturais ("o que não pode faltar" no TR) e dê ciência aos alertas.</li>
          <li><strong className="text-text">Minuta</strong> — pré-visualize o contrato; as validações (soma de parcelas, datas) precisam passar.</li>
          <li><strong className="text-text">Assinatura</strong> — aprovação humana + Documenso (Fase 3).</li>
        </ol>
        <p className="text-text-secondary">Os Termos e Condições são anexados imutáveis (verificados por SHA-256) e nunca passam pela IA.</p>
      </Card>
    </main>
  );
}
