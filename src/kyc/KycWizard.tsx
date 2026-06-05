/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * KYS / KYG — Wizard PÚBLICO (sem login).
 *
 * Renderizado direto por main.tsx em /kys, /kys/<token>, /kyg, /kyg/<token>.
 * Auto-preenche e verifica em tempo real (Receita via CNPJ, CEP, bancos, checksum
 * CPF/CNPJ); ao final, cria o documento no Documenso e assina num modal embutido
 * (iframe /embed/sign/<token>) — sem o usuário sair da página.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ShieldCheck, Loader2, CheckCircle2, AlertTriangle, ChevronRight, ChevronLeft,
  Building2, UserCheck, FileSignature, Info, Check,
} from 'lucide-react';
import {
  KycType, KysData, KygData, KycAddress, emptyAddress, emptyBank,
  KYS_SECTIONS, KYS_QUESTIONS, kysObsTrigger, KYS_DECLARACOES, KYG_DECLARACOES, ASSINATURA_ACEITE,
  onlyDigits, maskCnpj, maskCpf, isValidCnpj, isValidCpf, YesNo,
} from './kycTypes';

const CASA_HACKER_LOGO = 'https://casahacker.org/wp-content/uploads/2023/07/logo_vertical-branco.svg';

const segs = () => window.location.pathname.split('/').filter(Boolean);
const PUBLIC_TYPE: KycType = segs()[0] === 'kyg' ? 'kyg' : 'kys';
const INVITE_TOKEN = segs()[1] || '';

const emptyKys = (): KysData => ({
  razaoSocial: '', cnpj: '', nomeFantasia: '', endereco: emptyAddress(), telefone: '', email: '', banco: emptyBank(),
  repNome: '', repCpf: '', repEstadoCivil: '', repProfissao: '', repEndereco: emptyAddress(), repTelefone: '', repEmail: '',
  respostas: Object.fromEntries(KYS_QUESTIONS.map((q) => [q.key, { resposta: '' as YesNo, obs: '' }])),
  observacoes: '',
});
const emptyKyg = (): KygData => ({
  tipoPessoa: 'pj', nome: '', documento: '', nomeFantasia: '', projeto: '',
  endereco: emptyAddress(), telefone: '', email: '', banco: emptyBank(),
  declaracoes: KYG_DECLARACOES.map(() => false), observacoes: '',
});

type Bank = { code: string; name: string };

// ── primitivos de UI (página pública, tema claro próprio) ───────────────────────
function Field({ label, value, onChange, placeholder, required, type = 'text', hint, status, autoComplete }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; required?: boolean;
  type?: string; hint?: React.ReactNode; status?: 'ok' | 'error' | 'loading'; autoComplete?: string;
}) {
  return (
    <label className="block">
      <span className="text-[12px] font-semibold text-text-secondary">{label}{required && <span className="text-error"> *</span>}</span>
      <div className="relative mt-1">
        <input
          type={type} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} autoComplete={autoComplete}
          className="w-full bg-card border border-line rounded px-3 py-2 text-[14px] text-text focus:border-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 pr-9"
        />
        {status === 'loading' && <Loader2 size={15} className="animate-spin text-primary absolute right-2.5 top-1/2 -translate-y-1/2" aria-hidden />}
        {status === 'ok' && <CheckCircle2 size={15} className="text-success absolute right-2.5 top-1/2 -translate-y-1/2" aria-hidden />}
        {status === 'error' && <AlertTriangle size={15} className="text-error absolute right-2.5 top-1/2 -translate-y-1/2" aria-hidden />}
      </div>
      {hint && <span className="block mt-1 text-[12px] text-text-secondary">{hint}</span>}
    </label>
  );
}

const ESTADO_CIVIL_OPCOES = ['Solteiro(a)', 'Casado(a)', 'Divorciado(a)', 'Viúvo(a)', 'União estável', 'Separado(a)'];
const isValidPhone = (s: string) => { const d = onlyDigits(s); return d.length === 10 || d.length === 11; };
const emailOk = (s: string) => /\S+@\S+\.\S+/.test(String(s || ''));
const addrComplete = (a: KycAddress) => !!(a.cep.trim() && a.logradouro.trim() && a.numero.trim() && a.bairro.trim() && a.municipio.trim() && a.uf.trim());
const bankComplete = (b: { banco: string; agencia: string; conta: string }) => !!(b.banco.trim() && b.agencia.trim() && b.conta.trim());

function SelectField({ label, value, onChange, options, required }: { label: string; value: string; onChange: (v: string) => void; options: string[]; required?: boolean }) {
  return (
    <label className="block">
      <span className="text-[12px] font-semibold text-text-secondary">{label}{required && <span className="text-error"> *</span>}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full bg-card border border-line rounded px-3 py-2 text-[14px] text-text focus:border-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 cursor-pointer">
        <option value="">Selecione…</option>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </label>
  );
}

function AddressFields({ addr, onChange, onCep, required }: { addr: KycAddress; onChange: (a: KycAddress) => void; onCep: (cep: string) => Promise<boolean>; required?: boolean }) {
  const set = (k: keyof KycAddress) => (v: string) => onChange({ ...addr, [k]: v });
  const [cepStatus, setCepStatus] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle');
  const onCepChange = async (v: string) => {
    set('cep')(v);
    const d = onlyDigits(v);
    if (d.length !== 8) { setCepStatus('idle'); return; }
    setCepStatus('loading');
    setCepStatus((await onCep(v)) ? 'ok' : 'error');
  };
  return (
    <div className="grid sm:grid-cols-6 gap-3">
      <div className="sm:col-span-2"><Field label="CEP" value={addr.cep} onChange={onCepChange} placeholder="00000-000" required={required}
        status={cepStatus === 'idle' ? undefined : cepStatus}
        hint={cepStatus === 'error' ? <span className="text-error">CEP não encontrado</span> : cepStatus === 'ok' ? <span className="text-success">Endereço preenchido automaticamente</span> : 'Preenche o endereço automaticamente'} /></div>
      <div className="sm:col-span-4"><Field label="Logradouro" value={addr.logradouro} onChange={set('logradouro')} required={required} /></div>
      <div className="sm:col-span-1"><Field label="Número" value={addr.numero} onChange={set('numero')} required={required} /></div>
      <div className="sm:col-span-3"><Field label="Complemento" value={addr.complemento} onChange={set('complemento')} /></div>
      <div className="sm:col-span-2"><Field label="Bairro" value={addr.bairro} onChange={set('bairro')} required={required} /></div>
      <div className="sm:col-span-4"><Field label="Município" value={addr.municipio} onChange={set('municipio')} required={required} /></div>
      <div className="sm:col-span-2"><Field label="UF" value={addr.uf} onChange={(v) => set('uf')(v.toUpperCase().slice(0, 2))} required={required} /></div>
    </div>
  );
}

function YesNoField({ n, q, value, obs, onResp, onObs }: { n: number; q: { key: string; text: string; obsOn?: YesNo }; value: YesNo; obs: string; onResp: (v: YesNo) => void; onObs: (v: string) => void }) {
  const showObs = value && value === kysObsTrigger(q);
  return (
    <div className={`rounded-lg border bg-card p-4 transition-colors ${value ? 'border-line' : 'border-line hover:border-primary/30'}`}>
      <div className="flex gap-2.5">
        <span className="shrink-0 w-5 h-5 rounded-full bg-surface-hover text-text-secondary text-[12px] font-semibold flex items-center justify-center mt-0.5">{n}</span>
        <p className="text-[12px] text-text leading-relaxed">{q.text}</p>
      </div>
      <div className="mt-3 pl-7">
        <div className="inline-flex rounded-md border border-line overflow-hidden">
          {(['sim', 'nao'] as YesNo[]).map((opt) => (
            <button key={opt} type="button" onClick={() => onResp(opt)} aria-pressed={value === opt}
              className={`inline-flex items-center gap-1.5 px-5 py-1.5 text-[12px] font-semibold transition-colors ${opt === 'sim' ? 'border-r border-line' : ''} ${value === opt ? 'bg-primary text-white' : 'text-text-secondary hover:bg-surface-hover'}`}>
              {value === opt && <Check size={13} aria-hidden />}{opt === 'sim' ? 'Sim' : 'Não'}
            </button>
          ))}
        </div>
        {showObs && (
          <div className="mt-3">
            <label className="text-[12px] font-semibold text-text-secondary">Observações (obrigatório)</label>
            <textarea value={obs} onChange={(e) => onObs(e.target.value)} rows={2} placeholder="Informe os detalhes solicitados na pergunta."
              className="mt-1 w-full bg-bg border border-line rounded px-3 py-2 text-[12px] text-text focus:border-primary focus:outline-none resize-y" />
          </div>
        )}
      </div>
    </div>
  );
}

export default function KycWizard() {
  const type = PUBLIC_TYPE;
  const [step, setStep] = useState(0);
  const [kys, setKys] = useState<KysData>(emptyKys);
  const [kyg, setKyg] = useState<KygData>(emptyKyg);
  const [requester, setRequester] = useState({ nome: '', email: '' });
  const [atestacao, setAtestacao] = useState(false);
  const [aceiteAssinatura, setAceiteAssinatura] = useState(false);
  const [banks, setBanks] = useState<Bank[]>([]);
  const [cnpjStatus, setCnpjStatus] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle');
  const [cnpjSituacao, setCnpjSituacao] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [sign, setSign] = useState<{ id: string; token: string; host: string } | null>(null);
  const [done, setDone] = useState<{ id: string; needsSetup: boolean } | null>(null);

  // carrega bancos + prefill de convite
  useEffect(() => {
    fetch('/api/public/kyc/banks').then((r) => r.ok ? r.json() : []).then((b) => setBanks(Array.isArray(b) ? b : [])).catch(() => {});
    if (INVITE_TOKEN) {
      fetch(`/api/public/kyc/invite/${INVITE_TOKEN}`).then((r) => r.ok ? r.json() : null).then((inv) => {
        if (!inv) return;
        if (inv.requester) setRequester({ nome: inv.requester.nome || '', email: inv.requester.email || '' });
        if (inv.cnpj) { if (type === 'kys') setKys((k) => ({ ...k, cnpj: inv.cnpj })); else setKyg((g) => ({ ...g, documento: inv.cnpj })); }
      }).catch(() => {});
    }
  }, [type]);

  // ── auto-fill por CNPJ (Receita) ─────────────────────────────────────────────
  const lookupCnpj = async (cnpjRaw: string) => {
    const d = onlyDigits(cnpjRaw);
    if (d.length !== 14 || !isValidCnpj(d)) { setCnpjStatus('error'); return; }
    setCnpjStatus('loading');
    try {
      const r = await fetch(`/api/public/kyc/cnpj/${d}`);
      if (!r.ok) { setCnpjStatus('error'); return; }
      const rf = await r.json();
      setCnpjSituacao(rf.situacao_cadastral || '');
      const end: KycAddress = { cep: rf.cep || '', logradouro: rf.logradouro || '', numero: rf.numero || '', complemento: rf.complemento || '', bairro: rf.bairro || '', municipio: rf.municipio || '', uf: rf.uf || '' };
      if (type === 'kys') setKys((k) => ({ ...k, razaoSocial: rf.razao_social || k.razaoSocial, nomeFantasia: rf.nome_fantasia || k.nomeFantasia, endereco: { ...end }, telefone: rf.telefone || k.telefone, email: rf.email || k.email }));
      else setKyg((g) => ({ ...g, nome: rf.razao_social || g.nome, nomeFantasia: rf.nome_fantasia || g.nomeFantasia, endereco: { ...end }, telefone: rf.telefone || g.telefone, email: rf.email || g.email }));
      setCnpjStatus('ok');
    } catch { setCnpjStatus('error'); }
  };

  const lookupCep = async (cep: string, target: 'empresa' | 'rep' | 'kyg'): Promise<boolean> => {
    try {
      const r = await fetch(`/api/public/kyc/cep/${onlyDigits(cep)}`);
      if (!r.ok) return false;
      const a = await r.json();
      const patch = (prev: KycAddress): KycAddress => ({ ...prev, cep: a.cep || prev.cep, logradouro: a.logradouro || prev.logradouro, bairro: a.bairro || prev.bairro, municipio: a.municipio || prev.municipio, uf: a.uf || prev.uf });
      if (target === 'empresa') setKys((k) => ({ ...k, endereco: patch(k.endereco) }));
      else if (target === 'rep') setKys((k) => ({ ...k, repEndereco: patch(k.repEndereco) }));
      else setKyg((g) => ({ ...g, endereco: patch(g.endereco) }));
      return true;
    } catch { return false; }
  };

  const bankOptions = useMemo(() => banks.map((b) => ({ value: `${b.code} - ${b.name}`, label: `${b.code} — ${b.name}` })), [banks]);

  // ── etapas ───────────────────────────────────────────────────────────────────
  const kysSteps = ['Início', 'Empresa', 'Representante legal', ...KYS_SECTIONS.map((s) => s.title), 'Observações', 'Revisão e assinatura'];
  const kygSteps = ['Início', 'Identificação', 'Declarações', 'Observações', 'Revisão e assinatura'];
  const steps = type === 'kys' ? kysSteps : kygSteps;
  const lastStep = steps.length - 1;

  const canNext = (): boolean => {
    if (step === 0) return atestacao;
    if (type === 'kys') {
      if (step === 1) return isValidCnpj(kys.cnpj) && !!kys.razaoSocial.trim() && addrComplete(kys.endereco) && isValidPhone(kys.telefone) && emailOk(kys.email) && bankComplete(kys.banco);
      if (step === 2) return !!kys.repNome.trim() && isValidCpf(kys.repCpf) && !!kys.repEstadoCivil.trim() && !!kys.repProfissao.trim() && addrComplete(kys.repEndereco) && isValidPhone(kys.repTelefone) && emailOk(kys.repEmail);
      const secIdx = step - 3;
      if (secIdx >= 0 && secIdx < KYS_SECTIONS.length) {
        return KYS_SECTIONS[secIdx].questions.every((q) => {
          const a = kys.respostas[q.key];
          if (!a?.resposta) return false;
          if (a.resposta === kysObsTrigger(q)) return !!a.obs.trim();
          return true;
        });
      }
      return true;
    } else {
      if (step === 1) { const ok = kyg.tipoPessoa === 'pf' ? isValidCpf(kyg.documento) : isValidCnpj(kyg.documento); return ok && !!kyg.nome.trim() && !!kyg.projeto.trim() && /\S+@\S+\.\S+/.test(kyg.email); }
      if (step === 2) return kyg.declaracoes.every(Boolean);
      return true;
    }
  };

  const submit = async () => {
    setError(''); setSubmitting(true);
    try {
      const payload: any = { type, atestacao, aceiteAssinatura, inviteToken: INVITE_TOKEN || undefined, requester: (requester.nome || requester.email) ? requester : undefined };
      if (type === 'kys') payload.kys = kys; else payload.kyg = kyg;
      const r = await fetch('/api/public/kyc/submit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const j = await r.json();
      if (!r.ok) { setError(j.error || 'Falha ao enviar.'); setSubmitting(false); return; }
      if (j.documenso?.token) setSign({ id: j.id, token: j.documenso.token, host: j.documenso.host });
      else setDone({ id: j.id, needsSetup: !!j.needsDocumensoSetup });
    } catch (e: any) { setError(e.message || 'Falha de rede.'); }
    finally { setSubmitting(false); }
  };

  if (done) return <SuccessScreen needsSetup={done.needsSetup} type={type} />;

  return (
    <div className="min-h-screen bg-bg text-text flex flex-col pt-8">
      <header className="bg-sidebar border-b border-line px-5 sm:px-10 py-4 flex items-center gap-4">
        <img src={CASA_HACKER_LOGO} alt="Casa Hacker" className="h-8 w-auto object-contain invert opacity-90" />
        <div>
          <div className="text-primary font-semibold text-[12px]">{type === 'kys' ? 'Formulário de Conformidade — Fornecedores (KYS)' : 'Declaração de Conformidade (KYG)'}</div>
          <div className="text-[12px] text-text-secondary">Associação Casa Hacker · preenchimento seguro e verificado</div>
        </div>
      </header>

      {/* progresso */}
      <div className="px-5 sm:px-10 pt-5">
        <div className="max-w-3xl mx-auto">
          <div className="flex items-center justify-between text-[12px] text-text-secondary mb-1.5">
            <span className="font-semibold text-primary">{steps[step]}</span>
            <span>Etapa {step + 1} de {steps.length}</span>
          </div>
          <div className="h-1.5 bg-surface-hover rounded-full overflow-hidden">
            <div className="h-full bg-primary transition-all duration-300" style={{ width: `${((step + 1) / steps.length) * 100}%` }} />
          </div>
        </div>
      </div>

      <main className="flex-1 px-5 sm:px-10 py-8">
        <div className="max-w-3xl mx-auto space-y-6">
          {error && <div className="bg-error/10 border border-error/30 text-error rounded-lg px-4 py-3 text-[12px]">{error}</div>}

          {/* Etapa 0 — início/atestação */}
          {step === 0 && (
            <div className="space-y-5">
              <div className="flex items-start gap-3 bg-primary/5 border border-primary/20 rounded-lg p-4">
                <ShieldCheck size={20} className="text-primary shrink-0 mt-0.5" aria-hidden />
                <div className="text-[14px] text-text-secondary leading-relaxed">
                  Este formulário coleta dados cadastrais e de conformidade {type === 'kys' ? 'da sua empresa' : 'da sua organização/liderança'} e deve ser preenchido e assinado <b className="text-text">pelo representante legal ou pessoa autorizada</b>. Vários campos são <b className="text-text">verificados automaticamente</b> em fontes oficiais (Receita Federal, listas de restrição). A validade é por <b className="text-text">ano fiscal</b> — deve ser renovado anualmente.
                </div>
              </div>
              <label className="flex items-start gap-3 cursor-pointer">
                <input type="checkbox" checked={atestacao} onChange={(e) => setAtestacao(e.target.checked)} className="mt-1 w-4 h-4 accent-[color:var(--color-primary)]" />
                <span className="text-[14px] text-text">Declaro que sou o <b>representante legal</b> {type === 'kys' ? 'da empresa' : 'da organização/projeto'} ou pessoa devidamente autorizada a prestar estas informações e assinar este documento.</span>
              </label>
            </div>
          )}

          {/* KYS — empresa */}
          {type === 'kys' && step === 1 && (
            <div className="space-y-4">
              <SectionTitle icon={Building2}>Identificação da empresa</SectionTitle>
              <div className="grid sm:grid-cols-2 gap-3">
                <Field label="CNPJ" value={kys.cnpj} required status={cnpjStatus === 'idle' ? undefined : cnpjStatus}
                  onChange={(v) => { setKys({ ...kys, cnpj: v }); setCnpjStatus('idle'); }} placeholder="00.000.000/0000-00"
                  hint={kys.cnpj && !isValidCnpj(kys.cnpj) ? <span className="text-error">CNPJ inválido</span> : cnpjSituacao ? <span className={/ATIVA/i.test(cnpjSituacao) ? 'text-success' : 'text-error'}>Receita: {cnpjSituacao}</span> : 'Ao informar, buscamos os dados na Receita Federal.'} />
                <div className="flex items-end"><button type="button" onClick={() => lookupCnpj(kys.cnpj)} disabled={!isValidCnpj(kys.cnpj) || cnpjStatus === 'loading'} className="px-4 py-2 rounded text-[12px] font-semibold bg-primary text-white hover:bg-primary-hover disabled:opacity-40">Buscar na Receita</button></div>
              </div>
              <Field label="Razão social" value={kys.razaoSocial} required onChange={(v) => setKys({ ...kys, razaoSocial: v })} />
              <Field label="Nome fantasia" value={kys.nomeFantasia} onChange={(v) => setKys({ ...kys, nomeFantasia: v })} />
              <AddressFields addr={kys.endereco} onChange={(a) => setKys({ ...kys, endereco: a })} onCep={(c) => lookupCep(c, 'empresa')} required />
              <div className="grid sm:grid-cols-2 gap-3">
                <Field label="Telefone (celular/fixo)" value={kys.telefone} required onChange={(v) => setKys({ ...kys, telefone: v })} placeholder="(11) 90000-0000"
                  status={kys.telefone ? (isValidPhone(kys.telefone) ? 'ok' : 'error') : undefined}
                  hint={kys.telefone && !isValidPhone(kys.telefone) ? <span className="text-error">Telefone inválido — inclua o DDD</span> : undefined} />
                <Field label="E-mail" type="email" value={kys.email} required onChange={(v) => setKys({ ...kys, email: v })} />
              </div>
              <SectionTitle>Dados bancários</SectionTitle>
              <BankRow banks={bankOptions} value={kys.banco} onChange={(b) => setKys({ ...kys, banco: b })} required />
            </div>
          )}

          {/* KYS — representante legal */}
          {type === 'kys' && step === 2 && (
            <div className="space-y-4">
              <SectionTitle icon={UserCheck}>Identificação do representante legal</SectionTitle>
              <div className="grid sm:grid-cols-2 gap-3">
                <Field label="Nome completo" value={kys.repNome} required onChange={(v) => setKys({ ...kys, repNome: v })} />
                <Field label="CPF" value={kys.repCpf} required onChange={(v) => setKys({ ...kys, repCpf: v })} placeholder="000.000.000-00"
                  status={kys.repCpf ? (isValidCpf(kys.repCpf) ? 'ok' : 'error') : undefined} hint={kys.repCpf && !isValidCpf(kys.repCpf) ? <span className="text-error">CPF inválido</span> : undefined} />
                <SelectField label="Estado civil" value={kys.repEstadoCivil} onChange={(v) => setKys({ ...kys, repEstadoCivil: v })} options={ESTADO_CIVIL_OPCOES} required />
                <Field label="Profissão" value={kys.repProfissao} required onChange={(v) => setKys({ ...kys, repProfissao: v })} />
              </div>
              <AddressFields addr={kys.repEndereco} onChange={(a) => setKys({ ...kys, repEndereco: a })} onCep={(c) => lookupCep(c, 'rep')} required />
              <div className="grid sm:grid-cols-2 gap-3">
                <Field label="Telefone (celular/fixo)" value={kys.repTelefone} required onChange={(v) => setKys({ ...kys, repTelefone: v })} placeholder="(11) 90000-0000"
                  status={kys.repTelefone ? (isValidPhone(kys.repTelefone) ? 'ok' : 'error') : undefined}
                  hint={kys.repTelefone && !isValidPhone(kys.repTelefone) ? <span className="text-error">Telefone inválido — inclua o DDD (10 ou 11 dígitos)</span> : undefined} />
                <Field label="E-mail (receberá o documento p/ assinar)" type="email" value={kys.repEmail} required onChange={(v) => setKys({ ...kys, repEmail: v })} />
              </div>
            </div>
          )}

          {/* KYS — seções de perguntas */}
          {type === 'kys' && step >= 3 && step < 3 + KYS_SECTIONS.length && (() => {
            const sec = KYS_SECTIONS[step - 3];
            return (
              <div className="space-y-3">
                <SectionTitle>{sec.title}</SectionTitle>
                {sec.questions.map((q, qi) => (
                  <YesNoField key={q.key} n={qi + 1} q={q} value={kys.respostas[q.key]?.resposta || ''} obs={kys.respostas[q.key]?.obs || ''}
                    onResp={(v) => setKys({ ...kys, respostas: { ...kys.respostas, [q.key]: { ...kys.respostas[q.key], resposta: v } } })}
                    onObs={(v) => setKys({ ...kys, respostas: { ...kys.respostas, [q.key]: { ...kys.respostas[q.key], obs: v } } })} />
                ))}
              </div>
            );
          })()}

          {/* KYS — observações */}
          {type === 'kys' && step === 3 + KYS_SECTIONS.length && (
            <div className="space-y-4">
              <SectionTitle>Observações gerais</SectionTitle>
              <textarea value={kys.observacoes} onChange={(e) => setKys({ ...kys, observacoes: e.target.value })} rows={5} placeholder="Espaço livre para observações adicionais (opcional)."
                className="w-full bg-card border border-line rounded px-3 py-2 text-[14px] text-text focus:border-primary focus:outline-none resize-y" />
              <RequesterBlock requester={requester} setRequester={setRequester} />
            </div>
          )}

          {/* KYG — identificação */}
          {type === 'kyg' && step === 1 && (
            <div className="space-y-4">
              <SectionTitle icon={Building2}>Identificação do proponente</SectionTitle>
              <div className="flex gap-2">
                {(['pj', 'pf'] as const).map((tp) => (
                  <button key={tp} type="button" onClick={() => setKyg({ ...kyg, tipoPessoa: tp })}
                    className={`px-4 py-1.5 rounded text-[12px] font-semibold border ${kyg.tipoPessoa === tp ? 'bg-primary text-white border-primary' : 'border-line text-text-secondary hover:border-primary'}`}>
                    {tp === 'pj' ? 'Organização (CNPJ)' : 'Pessoa física (CPF)'}
                  </button>
                ))}
              </div>
              <div className="grid sm:grid-cols-2 gap-3">
                <Field label={kyg.tipoPessoa === 'pj' ? 'CNPJ' : 'CPF'} value={kyg.documento} required onChange={(v) => { setKyg({ ...kyg, documento: v }); setCnpjStatus('idle'); }}
                  status={kyg.documento ? ((kyg.tipoPessoa === 'pj' ? isValidCnpj(kyg.documento) : isValidCpf(kyg.documento)) ? 'ok' : 'error') : undefined} />
                {kyg.tipoPessoa === 'pj' && <div className="flex items-end"><button type="button" onClick={() => lookupCnpj(kyg.documento)} disabled={!isValidCnpj(kyg.documento) || cnpjStatus === 'loading'} className="px-4 py-2 rounded text-[12px] font-semibold bg-primary text-white hover:bg-primary-hover disabled:opacity-40">{cnpjStatus === 'loading' ? <Loader2 size={14} className="animate-spin" /> : 'Buscar na Receita'}</button></div>}
              </div>
              <Field label={kyg.tipoPessoa === 'pj' ? 'Razão social' : 'Nome completo'} value={kyg.nome} required onChange={(v) => setKyg({ ...kyg, nome: v })} />
              <Field label="Nome do projeto" value={kyg.projeto} required onChange={(v) => setKyg({ ...kyg, projeto: v })} />
              <AddressFields addr={kyg.endereco} onChange={(a) => setKyg({ ...kyg, endereco: a })} onCep={(c) => lookupCep(c, 'kyg')} />
              <div className="grid sm:grid-cols-2 gap-3">
                <Field label="Telefone" value={kyg.telefone} onChange={(v) => setKyg({ ...kyg, telefone: v })} placeholder="(11) 90000-0000"
                  status={kyg.telefone ? (isValidPhone(kyg.telefone) ? 'ok' : 'error') : undefined}
                  hint={kyg.telefone && !isValidPhone(kyg.telefone) ? <span className="text-error">Telefone inválido — inclua o DDD</span> : undefined} />
                <Field label="E-mail (receberá o documento p/ assinar)" type="email" value={kyg.email} required onChange={(v) => setKyg({ ...kyg, email: v })} />
              </div>
              <SectionTitle>Dados bancários (recebimento)</SectionTitle>
              <BankRow banks={bankOptions} value={kyg.banco} onChange={(b) => setKyg({ ...kyg, banco: b })} />
            </div>
          )}

          {/* KYG — declarações */}
          {type === 'kyg' && step === 2 && (
            <div className="space-y-3">
              <SectionTitle>Declarações (sob as penas da lei)</SectionTitle>
              {KYG_DECLARACOES.map((d, i) => (
                <label key={i} className="flex items-start gap-3 cursor-pointer border border-line rounded-lg p-3.5 bg-card hover:border-primary/40">
                  <input type="checkbox" checked={kyg.declaracoes[i]} onChange={(e) => { const arr = [...kyg.declaracoes]; arr[i] = e.target.checked; setKyg({ ...kyg, declaracoes: arr }); }} className="mt-1 w-4 h-4 accent-[color:var(--color-primary)] shrink-0" />
                  <span className="text-[12px] text-text leading-relaxed">{d}</span>
                </label>
              ))}
            </div>
          )}

          {/* KYG — observações */}
          {type === 'kyg' && step === 3 && (
            <div className="space-y-4">
              <SectionTitle>Observações gerais</SectionTitle>
              <textarea value={kyg.observacoes} onChange={(e) => setKyg({ ...kyg, observacoes: e.target.value })} rows={5} placeholder="Espaço livre para observações adicionais (opcional)."
                className="w-full bg-card border border-line rounded px-3 py-2 text-[14px] text-text focus:border-primary focus:outline-none resize-y" />
              <RequesterBlock requester={requester} setRequester={setRequester} />
            </div>
          )}

          {/* Revisão e assinatura (último step) */}
          {step === lastStep && (
            <div className="space-y-5">
              <SectionTitle icon={FileSignature}>Revisão e assinatura</SectionTitle>
              <ReviewSummary type={type} kys={kys} kyg={kyg} requester={requester} />

              {type === 'kys' && (
                <div className="bg-card border border-line rounded-lg overflow-hidden">
                  <div className="px-4 py-2.5 border-b border-line bg-surface-hover text-[12px] font-semibold text-text-secondary">Declarações da empresa</div>
                  <ul className="p-4 space-y-2.5 max-h-60 overflow-y-auto custom-scrollbar">
                    {KYS_DECLARACOES.map((d, i) => (
                      <li key={i} className="flex gap-2.5 text-[12px] text-text-secondary leading-relaxed">
                        <CheckCircle2 size={15} className="text-primary shrink-0 mt-0.5" aria-hidden />
                        <span>{d}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="rounded-lg border border-line bg-surface-hover/40 p-4">
                <div className="text-[12px] font-semibold text-text-secondary mb-1.5 flex items-center gap-1.5"><FileSignature size={13} className="text-primary" aria-hidden /> Assinatura eletrônica</div>
                <p className="text-[12px] text-text-secondary leading-relaxed">{ASSINATURA_ACEITE}</p>
              </div>

              <label className={`flex items-start gap-3 cursor-pointer rounded-lg border p-4 transition-colors ${aceiteAssinatura ? 'border-primary bg-primary/5' : 'border-line hover:border-primary/50'}`}>
                <input type="checkbox" checked={aceiteAssinatura} onChange={(e) => setAceiteAssinatura(e.target.checked)} className="mt-0.5 w-4 h-4 accent-[color:var(--color-primary)]" />
                <span className="text-[14px] text-text">Li e concordo com as declarações e com o processo de <b>assinatura eletrônica</b>, e confirmo que as informações prestadas são <b>verdadeiras</b>.</span>
              </label>
            </div>
          )}

          {/* navegação */}
          <div className="flex items-center justify-between pt-2">
            <button type="button" onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded text-[12px] font-semibold text-text-secondary hover:text-primary disabled:opacity-30">
              <ChevronLeft size={15} /> Voltar
            </button>
            {step < lastStep ? (
              <button type="button" onClick={() => canNext() && setStep((s) => s + 1)} disabled={!canNext()}
                className="inline-flex items-center gap-1.5 px-5 py-2 rounded text-[12px] font-semibold bg-primary text-white hover:bg-primary-hover disabled:opacity-40">
                Continuar <ChevronRight size={15} />
              </button>
            ) : (
              <button type="button" onClick={submit} disabled={!aceiteAssinatura || submitting}
                className="inline-flex items-center gap-1.5 px-6 py-2.5 rounded text-[12px] font-semibold bg-primary text-white hover:bg-primary-hover disabled:opacity-40">
                {submitting ? <><Loader2 size={15} className="animate-spin" /> Preparando…</> : <><FileSignature size={15} /> Verificar e assinar</>}
              </button>
            )}
          </div>
        </div>
      </main>

      {sign && <SignModal sign={sign} onClose={() => setSign(null)} onDone={() => { setSign(null); setDone({ id: sign.id, needsSetup: false }); }} />}
    </div>
  );
}

function SectionTitle({ icon: Icon, children }: { icon?: React.ElementType; children: React.ReactNode }) {
  return <h2 className="text-[14px] font-semibold text-text flex items-center gap-2 border-b border-line pb-2">{Icon && <Icon size={16} className="text-primary" aria-hidden />}{children}</h2>;
}

function BankRow({ banks, value, onChange, required }: { banks: { value: string; label: string }[]; value: { banco: string; agencia: string; conta: string; chavePix: string }; onChange: (v: any) => void; required?: boolean }) {
  return (
    <div className="grid sm:grid-cols-2 gap-3">
      <label className="block">
        <span className="text-[12px] font-semibold text-text-secondary">Banco / Instituição de pagamento{required && <span className="text-error"> *</span>}</span>
        <input list="kyc-banks" value={value.banco} onChange={(e) => onChange({ ...value, banco: e.target.value })} placeholder="Digite ou selecione"
          className="mt-1 w-full bg-card border border-line rounded px-3 py-2 text-[14px] text-text focus:border-primary focus:outline-none" />
        <datalist id="kyc-banks">{banks.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}</datalist>
      </label>
      <Field label="Agência" value={value.agencia} onChange={(v) => onChange({ ...value, agencia: v })} required={required} />
      <Field label="Conta-corrente" value={value.conta} onChange={(v) => onChange({ ...value, conta: v })} required={required} />
      <Field label="Chave PIX" value={value.chavePix} onChange={(v) => onChange({ ...value, chavePix: v })} />
    </div>
  );
}

function RequesterBlock({ requester, setRequester }: { requester: { nome: string; email: string }; setRequester: (v: any) => void }) {
  return (
    <div className="bg-primary/5 border border-primary/20 rounded-lg p-4 space-y-3">
      <div className="flex items-start gap-2 text-[12px] text-text-secondary"><Info size={15} className="text-primary shrink-0 mt-0.5" aria-hidden /> Opcional: informe quem da Casa Hacker solicitou este preenchimento — essa pessoa receberá uma cópia do documento assinado.</div>
      <div className="grid sm:grid-cols-2 gap-3">
        <Field label="Nome do solicitante (Casa Hacker)" value={requester.nome} onChange={(v) => setRequester({ ...requester, nome: v })} />
        <Field label="E-mail do solicitante (Casa Hacker)" type="email" value={requester.email} onChange={(v) => setRequester({ ...requester, email: v })} />
      </div>
    </div>
  );
}

function ReviewSummary({ type, kys, kyg, requester }: { type: KycType; kys: KysData; kyg: KygData; requester: { nome: string; email: string } }) {
  const row = (k: string, v: string) => v ? <div className="flex gap-2 text-[12px]"><span className="text-text-secondary min-w-[160px]">{k}</span><span className="text-text font-medium break-words">{v}</span></div> : null;
  return (
    <div className="bg-card border border-line rounded-lg p-4 space-y-1.5">
      {type === 'kys' ? <>
        {row('Razão social', kys.razaoSocial)}{row('CNPJ', maskCnpj(kys.cnpj))}{row('Representante', kys.repNome)}{row('CPF', maskCpf(kys.repCpf))}{row('E-mail p/ assinatura', kys.repEmail)}
      </> : <>
        {row('Proponente', kyg.nome)}{row(kyg.tipoPessoa === 'pj' ? 'CNPJ' : 'CPF', kyg.tipoPessoa === 'pj' ? maskCnpj(kyg.documento) : maskCpf(kyg.documento))}{row('Projeto', kyg.projeto)}{row('E-mail p/ assinatura', kyg.email)}
      </>}
      {(requester.nome || requester.email) && row('Solicitante Casa Hacker', [requester.nome, requester.email].filter(Boolean).join(' · '))}
      <div className="text-[12px] text-text-secondary pt-2 border-t border-line mt-2">Ao continuar, rodamos a verificação de conformidade (Receita + listas de restrição) e preparamos o documento para assinatura eletrônica.</div>
    </div>
  );
}

function SignModal({ sign, onClose, onDone }: { sign: { id: string; token: string; host: string }; onClose: () => void; onDone: () => void }) {
  const [confirming, setConfirming] = useState(false);
  // Documenso embed posta mensagens ao concluir; também oferecemos botão manual.
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      try {
        if (sign.host && !String(e.origin).startsWith(new URL(sign.host).origin)) return;
        const t = typeof e.data === 'string' ? e.data : e.data?.type || e.data?.action || '';
        if (/complete|signed|document-completed|finish/i.test(String(t))) finish();
      } catch { /* */ }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const finish = async () => {
    setConfirming(true);
    try { await fetch(`/api/public/kyc/${sign.id}/completed`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: sign.token }) }); } catch { /* */ }
    onDone();
  };
  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center p-3 bg-black/60 backdrop-blur-sm" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-card border border-line rounded-lg shadow-2xl w-full max-w-4xl h-[88vh] flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3 border-b border-line">
          <h2 className="text-[14px] font-semibold text-text flex items-center gap-2"><FileSignature size={16} className="text-primary" /> Assinatura eletrônica</h2>
          <button onClick={onClose} className="text-text-secondary hover:text-primary text-[12px]">Fechar</button>
        </div>
        <iframe title="Assinatura Documenso" src={`${sign.host}/embed/sign/${sign.token}`} className="flex-1 w-full border-0" allow="camera; microphone" />
        <div className="px-5 py-3 border-t border-line flex items-center justify-between gap-3">
          <span className="text-[12px] text-text-secondary">Assine no quadro acima. Se concluiu e a tela não avançar, clique ao lado.</span>
          <button onClick={finish} disabled={confirming} className="inline-flex items-center gap-1.5 px-4 py-2 rounded text-[12px] font-semibold bg-primary text-white hover:bg-primary-hover disabled:opacity-40">
            {confirming ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />} Concluí a assinatura
          </button>
        </div>
      </div>
    </div>
  );
}

function SuccessScreen({ needsSetup, type }: { needsSetup: boolean; type: KycType }) {
  return (
    <div className="min-h-screen bg-bg text-text flex flex-col items-center justify-center px-6 text-center pt-8">
      <div className="w-16 h-16 rounded-full bg-success/10 flex items-center justify-center mb-5"><CheckCircle2 size={32} className="text-success" /></div>
      <h1 className="text-[20px] font-light">{needsSetup ? <>Dados <b className="font-semibold text-primary">recebidos</b></> : <>Conformidade <b className="font-semibold text-primary">concluída</b></>}</h1>
      <p className="text-[14px] text-text-secondary mt-3 max-w-md leading-relaxed">
        {needsSetup
          ? `Recebemos o seu ${type.toUpperCase()}. A etapa de assinatura eletrônica será habilitada em breve e você receberá o documento por e-mail.`
          : `Obrigado! Seu ${type.toUpperCase()} foi preenchido e assinado eletronicamente. Uma cópia será enviada por e-mail. A validade é por ano fiscal — renove no próximo ano.`}
      </p>
      <p className="text-[12px] text-text-secondary mt-8">Associação Casa Hacker · CNPJ 36.038.079/0001-97</p>
    </div>
  );
}
