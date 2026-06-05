/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * KYS / KYG (Tool D) — painel interno (autenticado).
 *
 * Lista todas as conformidades preenchidas, com filtros por fornecedor/tipo/status/
 * ano fiscal; gera convites rastreáveis (links públicos pré-preenchidos); abre o
 * detalhe com a trilha de conformidade e baixa o PDF assinado do Documenso.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  BadgeCheck, BookOpen, Link2, Loader2, Search, FileDown, RefreshCw, ChevronRight,
  ShieldCheck, ShieldAlert, AlertTriangle, Copy, ExternalLink, ClipboardList,
} from 'lucide-react';
import { cn } from '../lib/utils';
import { AuthUser } from '../types';
import { Btn, Chip, Card, ToolSidebar, ToolHeader, SidebarItem, SkipLink, EmptyState, tableHeadCls, Select, SearchInput, Modal } from '../ui/kit';
import type { ChipTone } from '../ui/kit';
import {
  KycSummary, KycInvite, KycType, KycStatus, KYC_TYPE_LABEL, KYC_STATUS_LABEL,
  maskDoc, onlyDigits, KYS_SECTIONS, KYG_DECLARACOES,
} from './kycTypes';

type Section = 'base' | 'convites' | 'ajuda' | 'detalhe';

export interface KycAppProps {
  user: AuthUser;
  apiFetch: (url: string, opts?: RequestInit) => Promise<Response>;
  addToast: (kind: 'success' | 'error' | 'info', message: string) => void;
  onHome: () => void;
  navigate?: (path: string) => void;
}

const segs = () => window.location.pathname.split('/').filter(Boolean);
const kycPath = (s: Section, id?: string) => s === 'detalhe' && id ? `/conformidade/${id}` : s === 'base' ? '/conformidade' : `/conformidade/${s}`;
const HEADERS: Record<Section, [string, string]> = {
  base: ['Conformidade', 'KYS / KYG'], convites: ['Convites de', 'Preenchimento'], ajuda: ['Como', 'usar'], detalhe: ['Detalhe da', 'Conformidade'],
};

const STATUS_TONE: Record<KycStatus, ChipTone> = { rascunho: 'neutral', aguardando_assinatura: 'warning', assinado: 'success', cancelado: 'neutral' };
const VERDICT: Record<string, { tone: ChipTone; icon: React.ElementType; label: string }> = {
  NADA_CONSTA: { tone: 'success', icon: ShieldCheck, label: 'Nada consta' },
  ALERTA: { tone: 'error', icon: ShieldAlert, label: 'Alerta' },
  PENDENTE: { tone: 'warning', icon: AlertTriangle, label: 'Pendente' },
};

async function dl(apiFetch: KycAppProps['apiFetch'], url: string, name: string) {
  const res = await apiFetch(url);
  if (!res.ok) throw new Error((await res.json().catch(() => ({} as any))).error || 'Falha no download');
  const blob = await res.blob();
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export default function KycApp({ user, apiFetch, addToast, onHome, navigate }: KycAppProps) {
  const [section, setSection] = useState<Section>('base');
  const [records, setRecords] = useState<KycSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [current, setCurrent] = useState<any | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setLoading(true);
    try { const r = await apiFetch('/api/kyc'); if (r.ok) setRecords(await r.json()); } catch { /* */ } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const openDetail = async (id: string) => {
    setBusy(true); setSection('detalhe'); setCurrent(null);
    try { const r = await apiFetch(`/api/kyc/${id}`); if (r.ok) { setCurrent(await r.json()); navigate?.(kycPath('detalhe', id)); } else { addToast('error', 'Registro não encontrado.'); setSection('base'); } }
    catch { addToast('error', 'Falha ao abrir.'); setSection('base'); } finally { setBusy(false); }
  };

  const goSection = (s: Section) => { setSection(s); navigate?.(kycPath(s)); };

  const applyPath = () => {
    const s = segs();
    if (s[0] !== 'conformidade') return;
    const a = s[1];
    if (!a) setSection('base');
    else if (a === 'convites') setSection('convites');
    else if (a === 'ajuda') setSection('ajuda');
    else openDetail(a);
  };
  useEffect(() => { applyPath(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const onPop = () => applyPath(); window.addEventListener('popstate', onPop); return () => window.removeEventListener('popstate', onPop); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const navItems: { id: Section; label: string; icon: React.ElementType }[] = [
    { id: 'base', label: 'Conformidades', icon: ClipboardList },
    { id: 'convites', label: 'Convites', icon: Link2 },
    { id: 'ajuda', label: 'Como usar', icon: BookOpen },
  ];

  return (
    <div className="flex min-h-screen pt-8">
      <SkipLink />
      <ToolSidebar brand="Conformidade" onHome={onHome} user={user}>
        {navItems.map((it) => <SidebarItem key={it.id} icon={it.icon} active={section === it.id} onClick={() => goSection(it.id)}>{it.label}</SidebarItem>)}
      </ToolSidebar>

      <main id="main-content" className="ml-[256px] flex-1 min-w-[820px] flex flex-col">
        <ToolHeader light={HEADERS[section][0]} accent={HEADERS[section][1]} />
        <div className="flex-1 overflow-y-auto px-6 sm:px-10 py-8 pb-24">
          {section === 'base' && <BaseView records={records} loading={loading} openDetail={openDetail} />}
          {section === 'convites' && <ConvitesView apiFetch={apiFetch} addToast={addToast} />}
          {section === 'ajuda' && <AjudaKyc />}
          {section === 'detalhe' && <DetailView current={current} busy={busy} apiFetch={apiFetch} addToast={addToast} reload={load} />}
        </div>
      </main>
    </div>
  );
}

export function BaseView({ records, loading, openDetail }: { records: KycSummary[]; loading: boolean; openDetail: (id: string) => void }) {
  const [q, setQ] = useState('');
  const [tf, setTf] = useState('all');
  const [sf, setSf] = useState('all');
  const [yf, setYf] = useState('all');
  const [ef, setEf] = useState('all');
  const qd = onlyDigits(q);
  const years = Array.from(new Set(records.map((r) => r.fiscalYear))).sort((a, b) => b - a);
  const filtered = records.filter((r) => {
    if (q) { const hay = `${r.nome} ${r.documentoFmt}`.toLowerCase(); if (!hay.includes(q.toLowerCase()) && !(qd && r.documento.includes(qd))) return false; }
    if (tf !== 'all' && r.type !== tf) return false;
    if (sf !== 'all') { if (sf === 'vencido') { if (!(r.status === 'assinado' && !r.valida)) return false; } else if (r.status !== sf) return false; }
    if (yf !== 'all' && String(r.fiscalYear) !== yf) return false;
    if (ef !== 'all') { const e = r.elegivel === true ? 'sim' : r.elegivel === false ? 'nao' : 'na'; if (e !== ef) return false; }
    return true;
  });

  return (
    <div className="space-y-5">
      <p className="text-[14px] text-text-secondary max-w-3xl">
        Fichas de conformidade <b className="text-text">KYS</b> (fornecedores) e <b className="text-text">KYG</b> (organizações/lideranças) preenchidas na página pública,
        verificadas por APIs oficiais e assinadas via Documenso. A validade é por <b className="text-text">ano fiscal</b> — registros vencidos precisam ser renovados.
        Links públicos: <span className="font-mono">/kys</span> e <span className="font-mono">/kyg</span> (ou gere convites rastreáveis na aba Convites).
      </p>

      {loading ? (
        <div className="flex items-center gap-2 text-text-secondary text-[14px]"><Loader2 size={16} className="animate-spin" aria-hidden /> Carregando…</div>
      ) : !records.length ? (
        <EmptyState icon={BadgeCheck} title="Nenhuma conformidade ainda" description="Compartilhe o link público (/kys ou /kyg) ou gere um convite na aba Convites." />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <SearchInput value={q} onChange={setQ} placeholder="Buscar por nome ou CNPJ/CPF" className="w-full sm:w-[260px]" />
            <Select value={tf} onChange={setTf} options={[{ value: 'all', label: 'Todos os tipos' }, { value: 'kys', label: 'KYS' }, { value: 'kyg', label: 'KYG' }]} />
            <Select value={sf} onChange={setSf} options={[
              { value: 'all', label: 'Todos os status' }, { value: 'assinado', label: 'Assinado' },
              { value: 'aguardando_assinatura', label: 'Aguardando assinatura' }, { value: 'vencido', label: 'Vencido (renovar)' }, { value: 'rascunho', label: 'Rascunho' },
            ]} />
            {years.length > 1 && <Select value={yf} onChange={setYf} options={[{ value: 'all', label: 'Todos os anos' }, ...years.map((y) => ({ value: String(y), label: `Ano fiscal ${y}` }))]} />}
            <Select value={ef} onChange={setEf} options={[{ value: 'all', label: 'Elegibilidade' }, { value: 'sim', label: 'Elegível' }, { value: 'nao', label: 'Inelegível' }]} />
            {(q || tf !== 'all' || sf !== 'all' || yf !== 'all' || ef !== 'all') && <Btn variant="ghost" size="sm" onClick={() => { setQ(''); setTf('all'); setSf('all'); setYf('all'); setEf('all'); }}>Limpar</Btn>}
            <span className="text-[12px] text-text-secondary ml-auto whitespace-nowrap">{filtered.length} de {records.length}</span>
          </div>
          {!filtered.length ? (
            <EmptyState icon={Search} title="Nenhum registro com esses filtros" description="Ajuste a busca ou os filtros acima." />
          ) : (
            <Card className="overflow-hidden">
              <table className="w-full text-[14px]">
                <thead className={tableHeadCls}><tr>
                  <th scope="col" className="px-4 py-2.5 font-semibold">Fornecedor / Proponente</th>
                  <th scope="col" className="px-4 py-2.5 font-semibold">Tipo</th>
                  <th scope="col" className="px-4 py-2.5 font-semibold">CNPJ / CPF</th>
                  <th scope="col" className="px-4 py-2.5 font-semibold">Conformidade</th>
                  <th scope="col" className="px-4 py-2.5 font-semibold">Elegível</th>
                  <th scope="col" className="px-4 py-2.5 font-semibold">Status</th>
                  <th scope="col" className="px-4 py-2.5 font-semibold">Ano fiscal</th>
                  <th scope="col" className="px-4 py-2.5 font-semibold text-right">Ação</th>
                </tr></thead>
                <tbody>
                  {filtered.map((r) => (
                    <tr key={r.id} className="border-t border-line hover:bg-primary/5 cursor-pointer" onClick={() => openDetail(r.id)}>
                      <td className="px-4 py-2.5 max-w-[260px] truncate">{r.nome}</td>
                      <td className="px-4 py-2.5"><span className="text-[12px] font-semibold uppercase text-primary">{r.type}</span></td>
                      <td className="px-4 py-2.5 font-mono whitespace-nowrap">{r.documentoFmt}</td>
                      <td className="px-4 py-2.5">{r.verdict ? <Chip tone={VERDICT[r.verdict]?.tone} icon={VERDICT[r.verdict]?.icon} size="sm">{VERDICT[r.verdict]?.label}</Chip> : '—'}</td>
                      <td className="px-4 py-2.5">{r.elegivel === true ? <Chip tone="success" size="sm">Elegível</Chip> : r.elegivel === false ? <Chip tone="error" size="sm">Inelegível</Chip> : <span className="text-text-secondary">—</span>}</td>
                      <td className="px-4 py-2.5">
                        <Chip tone={r.status === 'assinado' && !r.valida ? 'warning' : STATUS_TONE[r.status]} size="sm">
                          {r.status === 'assinado' && !r.valida ? 'Vencido' : KYC_STATUS_LABEL[r.status]}
                        </Chip>
                      </td>
                      <td className="px-4 py-2.5 text-text-secondary">{r.fiscalYear}</td>
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

export function ConvitesView({ apiFetch, addToast, initialCnpj }: { apiFetch: KycAppProps['apiFetch']; addToast: KycAppProps['addToast']; initialCnpj?: string }) {
  const [invites, setInvites] = useState<(KycInvite & { url?: string })[]>([]);
  const [type, setType] = useState<KycType>('kys');
  const [cnpj, setCnpj] = useState(initialCnpj || '');
  const [creating, setCreating] = useState(false);
  const load = async () => { try { const r = await apiFetch('/api/kyc/invites'); if (r.ok) setInvites(await r.json()); } catch { /* */ } };
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const base = window.location.origin;
  const create = async () => {
    setCreating(true);
    try {
      const r = await apiFetch('/api/kyc/invite', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type, cnpj: onlyDigits(cnpj) || undefined }) });
      const j = await r.json();
      if (!r.ok) { addToast('error', j.error || 'Falha ao gerar convite.'); return; }
      addToast('success', 'Convite gerado.'); setCnpj(''); load();
      try { await navigator.clipboard.writeText(j.url); addToast('info', 'Link copiado para a área de transferência.'); } catch { /* */ }
    } catch { addToast('error', 'Falha ao gerar convite.'); } finally { setCreating(false); }
  };
  const copy = async (url: string) => { try { await navigator.clipboard.writeText(url); addToast('info', 'Link copiado.'); } catch { /* */ } };

  return (
    <div className="space-y-5 max-w-4xl">
      <Card className="p-5 space-y-4">
        <div className="text-[14px] font-semibold text-text">Gerar convite de preenchimento</div>
        <p className="text-[12px] text-text-secondary">O convite gera um link único e rastreável, pré-preenchido com o tipo, o CNPJ (opcional) e você como solicitante (recebe cópia do assinado). Você também pode simplesmente divulgar os links públicos genéricos <span className="font-mono">/kys</span> e <span className="font-mono">/kyg</span>.</p>
        <div className="flex flex-wrap items-end gap-3">
          <Select label="Tipo" value={type} onChange={(v) => setType(v as KycType)} options={[{ value: 'kys', label: 'KYS — Fornecedor' }, { value: 'kyg', label: 'KYG — Organização/Liderança' }]} />
          <label className="block">
            <span className="text-[12px] text-text-secondary">CNPJ (opcional)</span>
            <input value={cnpj} onChange={(e) => setCnpj(e.target.value)} placeholder="00.000.000/0000-00" className="mt-1 block bg-card border border-line rounded px-3 py-1.5 text-[12px] font-mono text-text focus:border-primary focus:outline-none" />
          </label>
          <Btn onClick={create} disabled={creating}>{creating ? <Loader2 size={14} className="animate-spin" /> : <Link2 size={14} />} Gerar link</Btn>
        </div>
      </Card>

      {!invites.length ? (
        <EmptyState icon={Link2} title="Nenhum convite gerado" description="Gere um convite acima ou use os links públicos genéricos." />
      ) : (
        <Card className="overflow-hidden">
          <table className="w-full text-[14px]">
            <thead className={tableHeadCls}><tr>
              <th scope="col" className="px-4 py-2.5 font-semibold">Tipo</th><th scope="col" className="px-4 py-2.5 font-semibold">CNPJ</th>
              <th scope="col" className="px-4 py-2.5 font-semibold">Criado em</th><th scope="col" className="px-4 py-2.5 font-semibold">Situação</th>
              <th scope="col" className="px-4 py-2.5 font-semibold text-right">Link</th>
            </tr></thead>
            <tbody>
              {invites.map((i) => {
                const url = i.url || `${base}/${i.type}/${i.token}`;
                return (
                  <tr key={i.token} className="border-t border-line hover:bg-primary/5">
                    <td className="px-4 py-2.5"><span className="text-[12px] font-semibold uppercase text-primary">{i.type}</span></td>
                    <td className="px-4 py-2.5 font-mono">{i.cnpj ? maskDoc(i.cnpj) : '—'}</td>
                    <td className="px-4 py-2.5 text-text-secondary whitespace-nowrap">{new Date(i.createdAt).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })}</td>
                    <td className="px-4 py-2.5">{i.usedByRecordId ? <Chip tone="success" size="sm">Utilizado</Chip> : <Chip tone="info" size="sm">Pendente</Chip>}</td>
                    <td className="px-4 py-2.5 text-right whitespace-nowrap">
                      <button onClick={() => copy(url)} className="text-primary hover:underline mr-3 inline-flex items-center gap-1"><Copy size={12} /> Copiar</button>
                      <a href={url} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline inline-flex items-center gap-1"><ExternalLink size={12} /> Abrir</a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

const TRAIL_TONE: Record<string, string> = { ok: 'text-success', alerta: 'text-error', erro: 'text-error', pendente: 'text-warning' };

export function DetailView({ current, busy, apiFetch, addToast, reload, embedded }: { current: any; busy: boolean; apiFetch: KycAppProps['apiFetch']; addToast: KycAppProps['addToast']; reload: () => void; embedded?: boolean }) {
  const [showData, setShowData] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // #86 — enquanto a assinatura estiver pendente, verifica o status no Documenso a cada 15s e
  // recarrega quando ela é concluída — sem o usuário precisar clicar em "Atualizar".
  useEffect(() => {
    const id = current?.id, docId = current?.documensoDocumentId, status = current?.status;
    if (!id || !docId || status === 'assinado') return;
    let alive = true;
    const t = setInterval(async () => {
      try { const res = await apiFetch(`/api/kyc/${id}/signature-status`); const j = await res.json(); if (alive && j.status === 'assinado') { clearInterval(t); reload(); } } catch { /* tenta no próximo ciclo */ }
    }, 15000);
    return () => { alive = false; clearInterval(t); };
  }, [current?.id, current?.documensoDocumentId, current?.status]); // eslint-disable-line react-hooks/exhaustive-deps
  if (busy && !current) return <div className="flex items-center gap-3 text-text-secondary text-[14px]"><Loader2 size={20} className="animate-spin text-primary" aria-hidden /> Carregando…</div>;
  if (!current) return <div className="text-[14px] text-text-secondary">Selecione um registro na lista.</div>;
  const r = current;
  const isKys = r.type === 'kys';
  const data = isKys ? r.kys : r.kyg;
  const nome = isKys ? r.kys?.razaoSocial : r.kyg?.nome;
  const doc = onlyDigits(isKys ? r.kys?.cnpj : r.kyg?.documento);

  const refreshStatus = async () => {
    setRefreshing(true);
    try { const res = await apiFetch(`/api/kyc/${r.id}/signature-status`); const j = await res.json(); addToast('info', `Status: ${j.status}${j.documensoStatus ? ` (Documenso: ${j.documensoStatus})` : ''}`); reload(); } catch { addToast('error', 'Falha ao atualizar.'); } finally { setRefreshing(false); }
  };
  const downloadSigned = async () => { try { await dl(apiFetch, `/api/kyc/${r.id}/signed.pdf`, `${r.type}_${doc}_${r.fiscalYear}.pdf`); } catch (e: any) { addToast('error', e.message); } };

  return (
    <div className="space-y-5 max-w-4xl">
      <Card className="p-5">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <div className="flex items-center gap-2"><span className="text-[12px] font-semibold text-primary">{KYC_TYPE_LABEL[r.type as KycType]}</span>{r.origin && <Chip tone="neutral" size="sm">{r.origin === 'self' ? 'Autocadastro' : r.origin === 'legado' ? 'Legado (Documenso)' : 'Via convite'}</Chip>}</div>
            <div className="text-[16px] font-semibold mt-0.5">{nome || '—'}</div>
            <div className="text-[12px] text-text-secondary font-mono">{maskDoc(doc)}</div>
          </div>
          <div className="flex flex-col items-end gap-2">
            {r.verdict && <Chip tone={VERDICT[r.verdict]?.tone} icon={VERDICT[r.verdict]?.icon}>{VERDICT[r.verdict]?.label}</Chip>}
            <Chip tone={r.status === 'assinado' && !r.valida ? 'warning' : STATUS_TONE[r.status as KycStatus]}>{r.status === 'assinado' && !r.valida ? 'Vencido' : KYC_STATUS_LABEL[r.status as KycStatus]}</Chip>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          {r.status === 'assinado' && <Btn onClick={downloadSigned}><FileDown size={14} /> Baixar PDF assinado</Btn>}
          {r.documensoDocumentId && r.status !== 'assinado' && <Btn variant="secondary" onClick={refreshStatus} disabled={refreshing}>{refreshing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} Atualizar status</Btn>}
          <Btn variant="secondary" onClick={() => setShowData(true)}><ClipboardList size={14} /> Ver respostas</Btn>
        </div>
      </Card>

      <Card className="p-5">
        <div className="grid sm:grid-cols-2 gap-x-6 gap-y-1.5 text-[12px]">
          <KV k="Ano fiscal / validade" v={`${r.fiscalYear} · até ${new Date(r.validUntil).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })}${r.valida ? '' : ' (vencido)'}`} />
          <KV k="Criado em" v={new Date(r.createdAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })} />
          {r.signedAt && <KV k="Assinado em" v={new Date(r.signedAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })} />}
          {r.requester?.email && <KV k="Solicitante (Casa Hacker)" v={[r.requester.nome, r.requester.email].filter(Boolean).join(' · ')} />}
          {r.ip && <KV k="IP de origem" v={r.ip} />}
        </div>
      </Card>

      {r.elegibilidade && (
        <Card className={cn('p-5 border-2', r.elegibilidade.elegivel ? 'border-success/40' : 'border-error/40')}>
          <div className="flex items-center gap-2 mb-1.5">
            {r.elegibilidade.elegivel ? <ShieldCheck size={16} className="text-success" /> : <ShieldAlert size={16} className="text-error" />}
            <span className="text-[14px] font-semibold">{r.elegibilidade.elegivel ? 'Elegível' : 'Inelegível'}</span>
          </div>
          <p className="text-[12px] text-text-secondary mb-2">Critério: não constar em listas de restrição + respostas adequadas (risco = "Não") + obrigações de impostos/previdência cumpridas.</p>
          {!r.elegibilidade.elegivel && (
            <ul className="text-[12px] text-error list-disc pl-5 space-y-0.5">
              {r.elegibilidade.motivos.map((m: string, i: number) => <li key={i}>{m}</li>)}
            </ul>
          )}
        </Card>
      )}

      {/* #87 — no cockpit (embedded) a trilha de restrições é a seção "Diligência" da ficha (fonte única).
          Aqui mostramos a trilha só no painel standalone para não duplicar a mesma lista. */}
      {!embedded && (
      <Card className="p-5">
        <div className="text-[12px] font-semibold text-text-secondary mb-3">Trilha de conformidade (verificada por APIs)</div>
        <div className="space-y-2">
          {(r.verificationTrail || []).map((t: any, i: number) => (
            <div key={i} className="flex items-start justify-between gap-3 border-b border-line pb-2 last:border-0 last:pb-0">
              <div>
                <div className="text-[12px] font-semibold text-text">{t.tipo}</div>
                <div className="text-[12px] text-text-secondary">{t.fonte} · {t.checkedAt ? new Date(t.checkedAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : ''}{t.apiUrl ? ' · ' : ''}{t.apiUrl && <a href={t.apiUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline break-all">consulta</a>}</div>
              </div>
              <span className={cn('text-[12px] font-semibold shrink-0', TRAIL_TONE[t.status] || 'text-text-secondary')}>{t.resultado}</span>
            </div>
          ))}
          {!(r.verificationTrail || []).length && <div className="text-[12px] text-text-secondary">Sem verificações registradas.</div>}
        </div>
      </Card>
      )}

      {showData && <DataModal r={r} data={data} onClose={() => setShowData(false)} />}
    </div>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  return <div className="flex gap-2"><span className="text-text-secondary min-w-[150px] shrink-0">{k}</span><span className="text-text font-medium break-words">{v || '—'}</span></div>;
}

function DataModal({ r, data, onClose }: { r: any; data: any; onClose: () => void }) {
  const addr = (a: any) => !a ? '—' : [[a.logradouro, a.numero].filter(Boolean).join(', '), a.bairro, [a.municipio, a.uf].filter(Boolean).join('/'), a.cep].filter(Boolean).join(' · ');
  return (
    <Modal title="Respostas do formulário" onClose={onClose} size="lg">
      <div className="p-6 space-y-4 text-[12px]">
        {r.type === 'kys' && data ? (
          <>
            <Block title="Empresa">
              <KV k="Razão social" v={data.razaoSocial} /><KV k="Nome fantasia" v={data.nomeFantasia} />
              <KV k="Endereço" v={addr(data.endereco)} /><KV k="Telefone" v={data.telefone} /><KV k="E-mail" v={data.email} />
              <KV k="Banco" v={`${data.banco?.banco || '—'} · Ag ${data.banco?.agencia || '—'} · CC ${data.banco?.conta || '—'} · PIX ${data.banco?.chavePix || '—'}`} />
            </Block>
            <Block title="Representante legal">
              <KV k="Nome" v={data.repNome} /><KV k="CPF" v={data.repCpf} /><KV k="Estado civil" v={data.repEstadoCivil} /><KV k="Profissão" v={data.repProfissao} />
              <KV k="Endereço" v={addr(data.repEndereco)} /><KV k="Telefone" v={data.repTelefone} /><KV k="E-mail" v={data.repEmail} />
            </Block>
            {KYS_SECTIONS.map((sec) => (
              <Block key={sec.id} title={sec.title}>
                {sec.questions.map((q) => { const a = data.respostas?.[q.key]; return (
                  <div key={q.key} className="py-1 border-b border-line/50 last:border-0">
                    <div className="text-text-secondary leading-snug">{q.text}</div>
                    <div className="text-text font-semibold mt-0.5">{a?.resposta === 'sim' ? 'SIM' : a?.resposta === 'nao' ? 'NÃO' : '—'}{a?.obs ? ` — ${a.obs}` : ''}</div>
                  </div>
                ); })}
              </Block>
            ))}
            {data.observacoes && <Block title="Observações"><div className="text-text">{data.observacoes}</div></Block>}
          </>
        ) : data ? (
          <>
            <Block title="Proponente">
              <KV k="Nome" v={data.nome} /><KV k="Documento" v={maskDoc(onlyDigits(data.documento))} /><KV k="Projeto" v={data.projeto} />
              <KV k="Endereço" v={addr(data.endereco)} /><KV k="Telefone" v={data.telefone} /><KV k="E-mail" v={data.email} />
              <KV k="Banco" v={`${data.banco?.banco || '—'} · Ag ${data.banco?.agencia || '—'} · CC ${data.banco?.conta || '—'} · PIX ${data.banco?.chavePix || '—'}`} />
            </Block>
            <Block title="Declarações aceitas">
              {KYG_DECLARACOES.map((d, i) => <div key={i} className="py-1 border-b border-line/50 last:border-0"><span className={data.declaracoes?.[i] ? 'text-success font-semibold' : 'text-error font-semibold'}>{data.declaracoes?.[i] ? '✓' : '✗'}</span> <span className="text-text-secondary">{d}</span></div>)}
            </Block>
            {data.observacoes && <Block title="Observações"><div className="text-text">{data.observacoes}</div></Block>}
          </>
        ) : <div className="text-text-secondary">Sem dados.</div>}
      </div>
    </Modal>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return <div><div className="text-[12px] font-semibold text-primary mb-1.5">{title}</div><div className="space-y-1">{children}</div></div>;
}

function AjudaKyc() {
  const blocks = [
    { t: 'O que é o KYS e o KYG', d: 'O KYS (Know Your Supplier) é a ficha de conformidade de fornecedores e prestadores de serviço (pessoa jurídica). O KYG (Know Your Grantee) é a declaração de conformidade de organizações sem fins lucrativos e lideranças pessoas físicas que recebem doação com encargos. Ambos coletam dados cadastrais verificados e exigem assinatura eletrônica do representante legal.' },
    { t: 'Como o fornecedor preenche', d: 'O preenchimento é feito numa página pública, em formato de wizard, sem necessidade de login. Compartilhe os links genéricos /kys e /kyg, ou gere um convite rastreável (aba Convites) com o CNPJ e você como solicitante já preenchidos. Apenas o representante legal ou pessoa autorizada deve preencher e assinar.' },
    { t: 'Verificação em tempo real', d: 'Ao informar o CNPJ, os dados são buscados na Receita Federal (razão social, endereço, situação cadastral) e o endereço é complementado por uma API de CEP quando a Receita não traz o logradouro (comum em MEIs). O CEP também preenche o endereço; a lista de bancos vem da BrasilAPI; CPF e CNPJ são validados pelos dígitos verificadores. No envio, roda a régua de conformidade (CEIS, CNEP, CEPIM e Acordos de Leniência do Portal da Transparência), registrando uma trilha auditável.' },
    { t: 'Elegibilidade', d: 'A ferramenta calcula automaticamente se o fornecedor/organização/liderança é ELEGÍVEL. Só é elegível quem: (1) NÃO consta em listas de restrição e tem cadastro ATIVO na Receita; (2) respondeu adequadamente às perguntas de risco (todas "Não"); e (3) cumpriu as obrigações de impostos/previdência. Quem não atende aparece como "Inelegível", com os motivos. Há filtro de elegibilidade na lista e o status fica visível no detalhe.' },
    { t: 'Assinatura via Documenso', d: 'Após a revisão, o documento é criado no Documenso (documenso.casahacker.org) e assinado num modal embutido — a pessoa não sai da página. O solicitante da Casa Hacker (se informado) recebe uma cópia do documento assinado. A assinatura tem validade jurídica (MP 2.200-2/2001 e Lei 14.063/2020).' },
    { t: 'Validade e renovação', d: 'Cada conformidade vale por ano fiscal (ano civil). Registros assinados em anos anteriores aparecem como "Vencido" e devem ser renovados com um novo preenchimento.' },
    { t: 'Painel e filtros', d: 'Esta tela lista todas as conformidades com filtros por fornecedor/CNPJ, tipo (KYS/KYG), status (assinado, aguardando, vencido, rascunho) e ano fiscal. Abra um registro para ver a trilha de conformidade, as respostas e baixar o PDF assinado.' },
  ];
  return (
    <div className="max-w-3xl space-y-5">
      <p className="text-[14px] text-text-secondary leading-relaxed">A ferramenta de <b className="text-text">Conformidade KYS/KYG</b> coleta e verifica os dados cadastrais de fornecedores e organizações e formaliza a conformidade com assinatura eletrônica.</p>
      <div className="space-y-3">{blocks.map((b, i) => <Card key={i} className="p-4"><div className="text-[14px] font-semibold text-primary mb-1">{b.t}</div><div className="text-[12px] text-text-secondary leading-relaxed">{b.d}</div></Card>)}</div>
    </div>
  );
}
