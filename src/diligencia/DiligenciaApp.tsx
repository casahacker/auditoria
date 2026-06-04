/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Diligência de Fornecedores (Tool C) — consulta de CNPJ na Receita + listas de
 * restrição (Portal da Transparência: CEIS/CNEP/CEPIM/Leniência) com relatório
 * auditável (PDF), base de fornecedores persistente e validade de 30 dias.
 */
import React, { useState, useEffect } from 'react';
import {
  Building2, Search, Layers, LogOut, Loader2, ShieldCheck, ShieldAlert, AlertTriangle,
  FileDown, RefreshCw, History, ExternalLink, ChevronRight, X, BookOpen,
} from 'lucide-react';
import { cn } from '../lib/utils';
import { AuthUser } from '../types';

type Section = 'base' | 'resultado' | 'historico' | 'ajuda';

export interface DiligenciaAppProps {
  user: AuthUser;
  apiFetch: (url: string, opts?: RequestInit) => Promise<Response>;
  addToast: (kind: 'success' | 'error' | 'info', message: string) => void;
  onHome: () => void;
  initialCnpj?: string;
  navigate?: (path: string) => void;
}

const VERDICT = {
  NADA_CONSTA: { label: 'Nada consta', cls: 'bg-success/10 text-success border-success/30', icon: ShieldCheck },
  ALERTA: { label: 'Alerta', cls: 'bg-error/10 text-error border-error/30', icon: ShieldAlert },
  PENDENTE: { label: 'Pendente', cls: 'bg-warning/10 text-warning border-warning/40', icon: AlertTriangle },
} as const;

function VerdictChip({ v }: { v: string }) {
  const m = (VERDICT as any)[v] || VERDICT.PENDENTE;
  const Icon = m.icon;
  return <span className={cn('inline-flex items-center gap-1.5 px-2.5 py-1 rounded border text-[11px] font-bold uppercase tracking-wider', m.cls)}><Icon size={13} /> {m.label}</span>;
}

const onlyDigits = (s: string) => (s || '').replace(/\D/g, '');
const maskCnpj = (d: string) => { const x = onlyDigits(d); return x.length === 14 ? `${x.slice(0, 2)}.${x.slice(2, 5)}.${x.slice(5, 8)}/${x.slice(8, 12)}-${x.slice(12)}` : d; };

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
  useEffect(() => { if (initialCnpj && onlyDigits(initialCnpj).length === 14) openSaved(onlyDigits(initialCnpj)); }, [initialCnpj]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onPop = () => {
      const s = window.location.pathname.split('/').filter(Boolean);
      if (s[0] !== 'diligencia') return;
      if (s[1] && onlyDigits(s[1]).length === 14) openSaved(s[1]); else setSection('base');
    };
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
      <aside className="fixed left-0 top-8 h-[calc(100vh-2rem)] w-[212px] bg-sidebar border-r border-line flex flex-col z-50">
        <div className="pt-6 pb-4 px-5">
          <img src="https://casahacker.org/wp-content/uploads/2023/07/logo_vertical-branco.svg" alt="Casa Hacker" className="h-9 w-auto object-contain object-left invert opacity-90 mb-3" />
          <div className="flex items-center justify-between">
            <div className="text-primary font-extrabold text-[11px] tracking-widest uppercase">Diligência</div>
            <button onClick={onHome} title="Voltar às ferramentas" className="text-text-secondary hover:text-primary transition-colors"><Layers size={15} /></button>
          </div>
        </div>
        <nav className="flex-1 px-2 pt-2 space-y-0.5">
          {navItems.map(it => (
            <button key={it.id} onClick={() => { setSection(it.id); navigate?.('/diligencia'); }}
              className={cn('w-full flex items-center gap-2.5 px-3 py-2 rounded text-[12px] transition-colors',
                section === it.id ? 'bg-sidebar-active text-primary font-semibold' : 'text-text-secondary hover:text-text hover:bg-white/5')}>
              <it.icon size={15} /> {it.label}
            </button>
          ))}
        </nav>
        <div className="px-4 py-4 border-t border-line">
          {user.photo && <img src={user.photo} alt={user.name} className="w-7 h-7 rounded-full mb-2" />}
          <p className="text-[10px] text-text-secondary truncate">{user.email}</p>
          <a href="/auth/logout" className="mt-2 flex items-center gap-1.5 text-[10px] text-text-secondary hover:text-primary transition-colors"><LogOut size={11} /> Sair</a>
        </div>
      </aside>

      <main id="main-content" className="ml-[212px] flex-1 min-w-[820px] flex flex-col">
        <header className="px-10 py-6 border-b border-line flex justify-between items-center bg-bg shrink-0">
          <h1 className="text-[20px] font-light">
            {section === 'base' && <>Diligência de <span className="font-bold text-primary">Fornecedores</span></>}
            {section === 'resultado' && <>Relatório de <span className="font-bold text-primary">Diligência</span></>}
            {section === 'historico' && <>Histórico de <span className="font-bold text-primary">Diligências</span></>}
            {section === 'ajuda' && <>Como <span className="font-bold text-primary">usar</span></>}
          </h1>
          {/* CNPJ search — always available */}
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-2 bg-card border border-line rounded px-3 py-1.5">
              <Search size={14} className="text-text-secondary" />
              <input value={cnpjInput} onChange={e => setCnpjInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && runCheck(cnpjInput)}
                placeholder="CNPJ a consultar" className="bg-transparent text-[13px] outline-none w-[170px]" />
            </div>
            <button onClick={() => runCheck(cnpjInput)} disabled={busy} className="px-4 py-2 bg-primary text-white rounded text-[11px] uppercase tracking-widest font-bold hover:bg-blue-700 transition-colors disabled:opacity-50">Consultar</button>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto px-10 py-8 pb-24">
          {section === 'base' && <BaseView {...{ suppliers, suppliersLoading, runCheck, openSaved }} />}
          {section === 'historico' && <HistoricoView {...{ history, openSaved, loadHistory }} />}
          {section === 'ajuda' && <AjudaDilig />}
          {section === 'resultado' && <ResultadoView {...{ current, busy, apiFetch, addToast, runCheck }} />}
        </div>
      </main>
    </div>
  );
}

function ChipStatus({ s }: { s: any }) {
  const valida = s?.valida;
  if (!s) return <span className="text-[10px] text-text-secondary">não consultado</span>;
  return (
    <span className="inline-flex items-center gap-1.5">
      <VerdictChip v={s.verdict} />
      <span className={cn('text-[10px]', valida ? 'text-text-secondary' : 'text-warning')}>{valida ? `válida até ${new Date(s.validUntil).toLocaleDateString('pt-BR')}` : 'vencida'}</span>
    </span>
  );
}

function AjudaDilig() {
  const blocks = [
    { t: 'O que é verificado', d: 'Situação cadastral na Receita Federal (Ativa/Baixada/Inapta/Suspensa, natureza, porte, CNAE, sócios) e as listas de restrição do Portal da Transparência/CGU: CEIS (inidôneas e suspensas), CNEP (Lei Anticorrupção), CEPIM (entidades impedidas) e Acordos de Leniência.' },
    { t: 'Como consultar', d: 'Em "Base de fornecedores", consulte qualquer fornecedor das prestações já realizadas, ou digite um CNPJ novo no campo do topo e clique em Consultar. O resultado sai em segundos.' },
    { t: 'Lendo o resultado', d: 'O veredito é "Nada consta" (verde), "Alerta" (vermelho — há sanção ou cadastro não-ativo) ou "Pendente". Veja os detalhes da Receita, o status de cada lista e, quando "Consta", o tipo de sanção, órgão, vigência e processo.' },
    { t: 'Validade e auditoria', d: 'Cada diligência vale 30 dias e fica registrada com data-hora, IP e solicitante. Baixe o relatório em PDF auditável e guarde junto à prestação de contas. Use "Reconsultar" para atualizar antes do vencimento.' },
    { t: 'Fontes complementares', d: 'Lista Suja do Trabalho Escravo (MTE), IBAMA (embargos) e TCU/CNJ aparecem no relatório com link para verificação manual — o download automatizado é bloqueado pelos órgãos. Verifique-as quando o risco exigir (ex.: IBAMA para serviços ambientais).' },
  ];
  return (
    <div className="max-w-3xl space-y-5 animate-in fade-in duration-300">
      <p className="text-[13px] text-text-secondary">A Diligência verifica um fornecedor por CNPJ em fontes oficiais e gera um relatório auditável e exportável. Faça a diligência antes de contratar e antes de pagar fornecedores relevantes.</p>
      <div className="space-y-3">
        {blocks.map((b, i) => (
          <div key={i} className="bg-card border border-line rounded-lg p-4">
            <div className="text-[13px] font-bold text-primary mb-1">{b.t}</div>
            <div className="text-[12px] text-text-secondary leading-relaxed">{b.d}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function BaseView({ suppliers, suppliersLoading, runCheck, openSaved }: any) {
  return (
    <div className="space-y-5 animate-in fade-in duration-300">
      <p className="text-[13px] text-text-secondary max-w-3xl">
        Fornecedores extraídos de todas as prestações de contas já realizadas (Auditoria + FEAC). Consulte qualquer um
        deles ou digite um novo CNPJ no campo acima. A diligência verifica a situação na Receita Federal e as listas de
        restrição (CEIS, CNEP, CEPIM e Acordos de Leniência) e vale por 30 dias.
      </p>
      {suppliersLoading ? (
        <div className="flex items-center gap-2 text-text-secondary text-[13px]"><Loader2 size={16} className="animate-spin" /> Carregando base…</div>
      ) : !suppliers.length ? (
        <div className="bg-card border border-line rounded-lg p-10 text-center text-[13px] text-text-secondary">
          <Building2 size={28} className="mx-auto mb-3 opacity-60" />
          Nenhum fornecedor com CNPJ na base ainda. Digite um CNPJ no campo acima para consultar.
        </div>
      ) : (
        <div className="bg-card border border-line rounded-lg overflow-hidden">
          <table className="w-full text-[12px]">
            <thead className="bg-sidebar text-text-secondary"><tr className="text-left">
              <th className="px-4 py-2.5 font-semibold">Fornecedor</th>
              <th className="px-4 py-2.5 font-semibold">CNPJ</th>
              <th className="px-4 py-2.5 font-semibold">Origem</th>
              <th className="px-4 py-2.5 font-semibold">Diligência</th>
              <th className="px-4 py-2.5 font-semibold text-right">Ação</th>
            </tr></thead>
            <tbody>
              {suppliers.map((s: any) => (
                <tr key={s.cnpj} className="border-t border-line hover:bg-primary/5">
                  <td className="px-4 py-2.5 max-w-[280px] truncate">{s.nome || '—'}</td>
                  <td className="px-4 py-2.5 font-mono whitespace-nowrap">{s.cnpjFormatado}</td>
                  <td className="px-4 py-2.5 text-text-secondary">{(s.origens || []).join(', ')}</td>
                  <td className="px-4 py-2.5"><ChipStatus s={s.diligencia} /></td>
                  <td className="px-4 py-2.5 text-right whitespace-nowrap">
                    {s.diligencia?.valida && <button onClick={() => openSaved(s.cnpj)} className="text-primary hover:underline mr-3">Ver</button>}
                    <button onClick={() => runCheck(s.cnpj, !!s.diligencia?.valida)} className="text-primary hover:underline">{s.diligencia ? 'Reconsultar' : 'Consultar'}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function HistoricoView({ history, openSaved }: any) {
  return (
    <div className="space-y-4 animate-in fade-in duration-300">
      {!history.length ? (
        <div className="bg-card border border-line rounded-lg p-10 text-center text-[13px] text-text-secondary">Nenhuma diligência realizada ainda.</div>
      ) : (
        <div className="bg-card border border-line rounded-lg overflow-hidden">
          <table className="w-full text-[12px]">
            <thead className="bg-sidebar text-text-secondary"><tr className="text-left">
              <th className="px-4 py-2.5 font-semibold">Fornecedor</th><th className="px-4 py-2.5 font-semibold">CNPJ</th>
              <th className="px-4 py-2.5 font-semibold">Resultado</th><th className="px-4 py-2.5 font-semibold">Consulta</th>
              <th className="px-4 py-2.5 font-semibold text-right">Ação</th>
            </tr></thead>
            <tbody>
              {history.map((h: any) => (
                <tr key={h.cnpj} className="border-t border-line hover:bg-primary/5 cursor-pointer" onClick={() => openSaved(h.cnpj)}>
                  <td className="px-4 py-2.5 max-w-[280px] truncate">{h.razaoSocial || '—'}</td>
                  <td className="px-4 py-2.5 font-mono whitespace-nowrap">{maskCnpj(h.cnpj)}</td>
                  <td className="px-4 py-2.5"><VerdictChip v={h.verdict} /></td>
                  <td className="px-4 py-2.5 text-text-secondary whitespace-nowrap">{new Date(h.checkedAt).toLocaleString('pt-BR')} {h.valida ? '' : '· vencida'}</td>
                  <td className="px-4 py-2.5 text-right"><ChevronRight size={14} className="inline text-text-secondary" /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ResultadoView({ current, busy, apiFetch, addToast, runCheck }: any) {
  if (busy && !current) return <div className="flex items-center gap-3 text-text-secondary text-[14px]"><Loader2 size={20} className="animate-spin text-primary" /> Consultando Receita Federal e listas de restrição…</div>;
  if (!current) return <div className="text-[13px] text-text-secondary">Selecione um fornecedor ou informe um CNPJ.</div>;
  const r = current;
  const rf = r.receita;
  const download = async () => { try { await dl(apiFetch, `/api/diligencia/${r.cnpj}/pdf`, `diligencia_${r.cnpj}.pdf`); } catch (e: any) { addToast('error', e.message); } };
  return (
    <div className="space-y-5 animate-in fade-in duration-300 max-w-4xl">
      <div className="bg-card border border-line rounded-lg p-5">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <div className="text-[16px] font-bold">{r.razaoSocial || '—'}</div>
            <div className="text-[12px] text-text-secondary font-mono">{maskCnpj(r.cnpj)}</div>
          </div>
          <VerdictChip v={r.verdict} />
        </div>
        <div className="mt-3 grid sm:grid-cols-2 lg:grid-cols-4 gap-x-6 gap-y-1 text-[11px] text-text-secondary">
          <div>Consulta: <b className="text-text">{new Date(r.checkedAt).toLocaleString('pt-BR')}</b></div>
          <div>Validade: <b className={r.valida ? 'text-text' : 'text-warning'}>{new Date(r.validUntil).toLocaleDateString('pt-BR')}{r.valida ? '' : ' (vencida)'}</b></div>
          <div>Solicitante: <b className="text-text">{r.checkedBy}</b></div>
          <div>IP: <b className="text-text">{r.ip}</b></div>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <button onClick={download} className="flex items-center gap-2 px-4 py-2 bg-primary text-white rounded text-[11px] uppercase tracking-widest font-bold hover:bg-blue-700 transition-colors"><FileDown size={14} /> Baixar relatório (PDF)</button>
          <button onClick={() => runCheck(r.cnpj, true)} disabled={busy} className="flex items-center gap-2 px-4 py-2 border border-line rounded text-[11px] uppercase tracking-widest text-text-secondary hover:text-primary hover:border-primary transition-colors disabled:opacity-50"><RefreshCw size={14} /> Reconsultar</button>
        </div>
      </div>

      {/* Receita */}
      <div className="bg-card border border-line rounded-lg p-5">
        <div className="text-[11px] font-bold uppercase tracking-widest text-text-secondary mb-2 flex items-center gap-1.5"><Building2 size={13} /> Receita Federal</div>
        {rf ? (
          <div className="grid sm:grid-cols-2 gap-x-6 gap-y-1 text-[12px]">
            <div>Situação cadastral: <b className={/ATIVA/i.test(rf.situacao_cadastral || '') ? 'text-success' : 'text-error'}>{rf.situacao_cadastral || '—'}</b></div>
            <div>Natureza: <b>{rf.natureza_juridica || '—'}</b></div>
            <div>Porte: <b>{rf.porte || '—'}</b></div>
            <div>Abertura: <b>{rf.abertura || '—'}</b></div>
            <div className="sm:col-span-2">CNAE: <b>{rf.cnae_principal || '—'}</b></div>
            <div className="sm:col-span-2">Município: <b>{rf.municipio || '—'}/{rf.uf || '—'}</b></div>
            {rf.qsa?.length > 0 && <div className="sm:col-span-2 text-text-secondary">Sócios: {rf.qsa.map((s: any) => `${s.nome} (${s.qual})`).join('; ')}</div>}
            <div className="sm:col-span-2 text-[10px] text-text-secondary mt-1">Fonte: {rf.fonte} · {new Date(rf.fetchedAt).toLocaleString('pt-BR')}</div>
          </div>
        ) : <div className="text-[12px] text-error">Não foi possível obter os dados cadastrais.</div>}
      </div>

      {/* Sanções */}
      <div className="bg-card border border-line rounded-lg p-5">
        <div className="text-[11px] font-bold uppercase tracking-widest text-text-secondary mb-3 flex items-center gap-1.5"><ShieldAlert size={13} /> Listas de restrição — Portal da Transparência (CGU)</div>
        <div className="space-y-3">
          {(r.sancoes || []).map((s: any, i: number) => (
            <div key={i} className="border-b border-line pb-3 last:border-0 last:pb-0">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[12px] font-semibold">{s.fonte}</span>
                <span className={cn('text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded border',
                  s.status === 'CONSTA' ? 'bg-error/10 text-error border-error/30' : s.status === 'NADA_CONSTA' ? 'bg-success/10 text-success border-success/30' : 'bg-warning/10 text-warning border-warning/40')}>
                  {s.status === 'CONSTA' ? `Consta (${s.hits.length})` : s.status === 'NADA_CONSTA' ? 'Nada consta' : s.status}
                </span>
              </div>
              {(s.hits || []).map((h: any, j: number) => (
                <div key={j} className="mt-1.5 text-[11px] bg-error/5 border border-error/20 rounded px-2 py-1.5">
                  <div className="font-semibold text-error">{h.tipo}</div>
                  <div className="text-text-secondary">{h.orgao} · vigência {h.dataInicio || '?'}–{h.dataFim || '?'} · processo {h.processo || '—'}</div>
                  {h.fundamentacao && <div className="text-text-secondary mt-0.5">{h.fundamentacao}</div>}
                </div>
              ))}
              {s.url && <a href={s.url} target="_blank" rel="noopener noreferrer" className="text-[10px] text-primary hover:underline inline-flex items-center gap-1 mt-1"><ExternalLink size={10} /> consulta pública</a>}
            </div>
          ))}
        </div>
      </div>

      {/* Fontes complementares */}
      <div className="bg-card border border-line rounded-lg p-5">
        <div className="text-[11px] font-bold uppercase tracking-widest text-text-secondary mb-2">Fontes complementares (verificação manual)</div>
        <ul className="space-y-1.5 text-[11px]">
          {(r.fontesComplementares || []).map((f: any, i: number) => (
            <li key={i}>
              <a href={f.url} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline inline-flex items-center gap-1"><ExternalLink size={10} /> {f.fonte}</a>
              <span className="text-text-secondary"> — {f.obs}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="text-[10px] text-text-secondary">APIs/fontes: {(r.metadata?.apis || []).join('  ·  ')}</div>
    </div>
  );
}
