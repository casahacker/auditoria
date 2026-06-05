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
  Building2, UserCheck, FileSignature, Info, Check, Paperclip, X, Lock, Search, Download, FileText, Mail, Receipt,
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
function Field({ label, value, onChange, placeholder, required, type = 'text', hint, status, autoComplete, locked }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; required?: boolean;
  type?: string; hint?: React.ReactNode; status?: 'ok' | 'error' | 'loading'; autoComplete?: string; locked?: boolean;
}) {
  return (
    <label className="block">
      <span className="text-[12px] font-semibold text-text-secondary">{label}{required && <span className="text-error"> *</span>}{locked && <span className="ml-2 inline-flex items-center gap-1 text-[11px] font-normal text-text-secondary"><Lock size={11} aria-hidden /> Receita Federal</span>}</span>
      <div className="relative mt-1">
        <input
          type={type} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} autoComplete={autoComplete}
          readOnly={locked} aria-readonly={locked} tabIndex={locked ? -1 : undefined}
          className={`w-full border rounded px-3 py-2 text-[14px] focus:outline-none pr-9 ${locked ? 'bg-surface-hover border-line/70 text-text-secondary cursor-default' : 'bg-card border-line text-text focus:border-primary focus-visible:ring-2 focus-visible:ring-primary/40'}`}
        />
        {locked ? <Lock size={14} className="text-text-secondary absolute right-2.5 top-1/2 -translate-y-1/2" aria-hidden />
          : <>{status === 'loading' && <Loader2 size={15} className="animate-spin text-primary absolute right-2.5 top-1/2 -translate-y-1/2" aria-hidden />}
            {status === 'ok' && <CheckCircle2 size={15} className="text-success absolute right-2.5 top-1/2 -translate-y-1/2" aria-hidden />}
            {status === 'error' && <AlertTriangle size={15} className="text-error absolute right-2.5 top-1/2 -translate-y-1/2" aria-hidden />}</>}
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

function AddressFields({ addr, onChange, onCep, required, locked }: { addr: KycAddress; onChange: (a: KycAddress) => void; onCep: (cep: string) => Promise<boolean>; required?: boolean; locked?: boolean }) {
  const set = (k: keyof KycAddress) => (v: string) => onChange({ ...addr, [k]: v });
  const [cepStatus, setCepStatus] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle');
  const onCepChange = async (v: string) => {
    set('cep')(v);
    const d = onlyDigits(v);
    if (d.length !== 8) { setCepStatus('idle'); return; }
    setCepStatus('loading');
    setCepStatus((await onCep(v)) ? 'ok' : 'error');
  };
  // locked: campos da Receita/CEP travados; só os realmente preenchidos travam (MEI sem rua continua editável)
  const lk = (v: string) => !!(locked && v.trim());
  return (
    <div className="grid sm:grid-cols-6 gap-3">
      <div className="sm:col-span-2"><Field label="CEP" value={addr.cep} onChange={locked ? () => { } : onCepChange} placeholder="00000-000" required={required} locked={lk(addr.cep)}
        status={cepStatus === 'idle' ? undefined : cepStatus}
        hint={locked ? undefined : cepStatus === 'error' ? <span className="text-error">CEP não encontrado</span> : cepStatus === 'ok' ? <span className="text-success">Endereço preenchido automaticamente</span> : 'Preenche o endereço automaticamente'} /></div>
      <div className="sm:col-span-4"><Field label="Logradouro" value={addr.logradouro} onChange={set('logradouro')} required={required} locked={lk(addr.logradouro)} /></div>
      <div className="sm:col-span-1"><Field label="Número" value={addr.numero} onChange={set('numero')} required={required} locked={lk(addr.numero)} /></div>
      <div className="sm:col-span-3"><Field label="Complemento" value={addr.complemento} onChange={set('complemento')} locked={lk(addr.complemento)} /></div>
      <div className="sm:col-span-2"><Field label="Bairro" value={addr.bairro} onChange={set('bairro')} required={required} locked={lk(addr.bairro)} /></div>
      <div className="sm:col-span-4"><Field label="Município" value={addr.municipio} onChange={set('municipio')} required={required} locked={lk(addr.municipio)} /></div>
      <div className="sm:col-span-2"><Field label="UF" value={addr.uf} onChange={(v) => set('uf')(v.toUpperCase().slice(0, 2))} required={required} locked={lk(addr.uf)} /></div>
    </div>
  );
}

// CNPJ-first: primeira tela do bloco empresa — só o CNPJ; ao buscar, revela o cadastro pré-preenchido.
function CnpjGate({ value, onChange, status, situacao, onBuscar, label = 'CNPJ', title = 'Identificação da empresa' }: {
  value: string; onChange: (v: string) => void; status: 'idle' | 'loading' | 'ok' | 'error'; situacao: string; onBuscar: () => void; label?: string; title?: string;
}) {
  return (
    <div className="space-y-4">
      <SectionTitle icon={Building2}>{title}</SectionTitle>
      <p className="text-[14px] text-text-secondary leading-relaxed">Informe o <b className="text-text">{label}</b>. Buscamos os dados na <b className="text-text">Receita Federal</b> e pré-preenchemos o cadastro — você só completa o que faltar (contato e dados bancários).</p>
      <div className="max-w-sm">
        <Field label={label} value={value} required status={status === 'idle' ? undefined : status} onChange={onChange} placeholder="00.000.000/0000-00"
          hint={value && !isValidCnpj(value) ? <span className="text-error">CNPJ inválido</span> : status === 'error' ? <span className="text-error">Não foi possível buscar — verifique o CNPJ e tente de novo</span> : situacao ? <span className={/ATIVA/i.test(situacao) ? 'text-success' : 'text-error'}>Receita: {situacao}</span> : undefined} />
      </div>
      <button type="button" onClick={onBuscar} disabled={!isValidCnpj(value) || status === 'loading'}
        className="inline-flex items-center gap-2 px-5 py-2.5 rounded text-[13px] font-semibold bg-primary text-white hover:bg-primary-hover disabled:opacity-40">
        {status === 'loading' ? <><Loader2 size={15} className="animate-spin" /> Buscando na Receita…</> : <><Search size={15} /> Buscar na Receita e continuar</>}
      </button>
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
  const [empresaLoaded, setEmpresaLoaded] = useState(false); // CNPJ-first: revela o formulário só após puxar a Receita
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [sign, setSign] = useState<{ id: string; token: string; host: string; info: any } | null>(null);
  const [done, setDone] = useState<{ id: string; accessToken?: string; documento?: string; needsSetup: boolean } | null>(null);
  const [comprovante, setComprovante] = useState<File | null>(null); // #96 — comprovante de conta corrente (opcional)
  const [compErr, setCompErr] = useState('');

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
      setCnpjStatus('ok'); setEmpresaLoaded(true); // CNPJ-first: revela o formulário pré-preenchido
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
  // na "tela do CNPJ" (CNPJ-first, antes de puxar a Receita) o avanço é pelo botão "Buscar e continuar"
  const onCnpjGate = step === 1 && !empresaLoaded && (type === 'kys' || (type === 'kyg' && kyg.tipoPessoa === 'pj'));

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
      // #96 — anexa o comprovante bancário ao registro recém-criado (best-effort: não bloqueia a assinatura).
      if (comprovante && j.id) {
        try { const fd = new FormData(); fd.append('file', comprovante); await fetch(`/api/public/kyc/${j.id}/comprovante`, { method: 'POST', body: fd }); } catch { /* segue mesmo se o anexo falhar */ }
      }
      const info = { id: j.id, accessToken: j.accessToken, documento: j.documento, needsSetup: !!j.needsDocumensoSetup };
      if (j.documenso?.token) setSign({ id: j.id, token: j.documenso.token, host: j.documenso.host, info });
      else setDone(info);
    } catch (e: any) { setError(e.message || 'Falha de rede.'); }
    finally { setSubmitting(false); }
  };

  if (done) return <SuccessScreen info={done} type={type} />;

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

          {/* KYS — empresa (CNPJ-first: 1ª tela só o CNPJ; depois o cadastro pré-preenchido) */}
          {type === 'kys' && step === 1 && !empresaLoaded && (
            <CnpjGate value={kys.cnpj} onChange={(v) => { setKys({ ...kys, cnpj: v }); setCnpjStatus('idle'); }} status={cnpjStatus} situacao={cnpjSituacao} onBuscar={() => lookupCnpj(kys.cnpj)} />
          )}
          {type === 'kys' && step === 1 && empresaLoaded && (
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <SectionTitle icon={Building2}>Identificação da empresa</SectionTitle>
                <button type="button" onClick={() => { setEmpresaLoaded(false); setCnpjStatus('idle'); }} className="text-[12px] text-primary hover:underline inline-flex items-center gap-1"><ChevronLeft size={13} aria-hidden /> Trocar CNPJ</button>
              </div>
              <div className="grid sm:grid-cols-2 gap-3">
                <Field label="CNPJ" value={maskCnpj(kys.cnpj)} locked onChange={() => { }} />
                <Field label="Situação cadastral" value={cnpjSituacao} locked={!!cnpjSituacao} onChange={() => { }} />
              </div>
              <Field label="Razão social" value={kys.razaoSocial} required locked={!!kys.razaoSocial} onChange={(v) => setKys({ ...kys, razaoSocial: v })} />
              <Field label="Nome fantasia" value={kys.nomeFantasia} locked={!!kys.nomeFantasia} onChange={(v) => setKys({ ...kys, nomeFantasia: v })} />
              <AddressFields addr={kys.endereco} onChange={(a) => setKys({ ...kys, endereco: a })} onCep={(c) => lookupCep(c, 'empresa')} required locked />
              <p className="text-[12px] text-text-secondary -mt-1 flex items-start gap-1.5"><Lock size={12} className="text-text-secondary shrink-0 mt-0.5" aria-hidden /> Os campos marcados vêm da Receita Federal e não são editáveis. Complete abaixo o contato e os dados bancários.</p>
              <div className="grid sm:grid-cols-2 gap-3">
                <Field label="Telefone (celular/fixo)" value={kys.telefone} required onChange={(v) => setKys({ ...kys, telefone: v })} placeholder="(11) 90000-0000"
                  status={kys.telefone ? (isValidPhone(kys.telefone) ? 'ok' : 'error') : undefined}
                  hint={kys.telefone && !isValidPhone(kys.telefone) ? <span className="text-error">Telefone inválido — inclua o DDD</span> : undefined} />
                <Field label="E-mail" type="email" value={kys.email} required onChange={(v) => setKys({ ...kys, email: v })} />
              </div>
              <SectionTitle>Dados bancários</SectionTitle>
              <BankRow banks={bankOptions} value={kys.banco} onChange={(b) => setKys({ ...kys, banco: b })} required />
              <ComprovanteField file={comprovante} onPick={(f, err) => { setComprovante(f); setCompErr(err); }} error={compErr} />
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

          {/* KYG — identificação (CNPJ-first p/ PJ; PF segue editável) */}
          {type === 'kyg' && step === 1 && (
            <div className="space-y-4">
              <SectionTitle icon={Building2}>Identificação do proponente</SectionTitle>
              <div className="flex gap-2">
                {(['pj', 'pf'] as const).map((tp) => (
                  <button key={tp} type="button" onClick={() => { setKyg({ ...kyg, tipoPessoa: tp }); setEmpresaLoaded(false); setCnpjStatus('idle'); }}
                    className={`px-4 py-1.5 rounded text-[12px] font-semibold border ${kyg.tipoPessoa === tp ? 'bg-primary text-white border-primary' : 'border-line text-text-secondary hover:border-primary'}`}>
                    {tp === 'pj' ? 'Organização (CNPJ)' : 'Pessoa física (CPF)'}
                  </button>
                ))}
              </div>
              {kyg.tipoPessoa === 'pj' && !empresaLoaded ? (
                <div className="space-y-4">
                  <p className="text-[14px] text-text-secondary leading-relaxed">Informe o <b className="text-text">CNPJ</b>. Buscamos os dados na <b className="text-text">Receita Federal</b> e pré-preenchemos o cadastro — você só completa o que faltar.</p>
                  <div className="max-w-sm"><Field label="CNPJ" value={kyg.documento} required status={cnpjStatus === 'idle' ? undefined : cnpjStatus} onChange={(v) => { setKyg({ ...kyg, documento: v }); setCnpjStatus('idle'); }} placeholder="00.000.000/0000-00"
                    hint={kyg.documento && !isValidCnpj(kyg.documento) ? <span className="text-error">CNPJ inválido</span> : cnpjStatus === 'error' ? <span className="text-error">Não foi possível buscar — verifique o CNPJ</span> : cnpjSituacao ? <span className={/ATIVA/i.test(cnpjSituacao) ? 'text-success' : 'text-error'}>Receita: {cnpjSituacao}</span> : undefined} /></div>
                  <button type="button" onClick={() => lookupCnpj(kyg.documento)} disabled={!isValidCnpj(kyg.documento) || cnpjStatus === 'loading'} className="inline-flex items-center gap-2 px-5 py-2.5 rounded text-[13px] font-semibold bg-primary text-white hover:bg-primary-hover disabled:opacity-40">{cnpjStatus === 'loading' ? <><Loader2 size={15} className="animate-spin" /> Buscando na Receita…</> : <><Search size={15} /> Buscar na Receita e continuar</>}</button>
                </div>
              ) : (
                <>
                  {kyg.tipoPessoa === 'pj' && <button type="button" onClick={() => { setEmpresaLoaded(false); setCnpjStatus('idle'); }} className="text-[12px] text-primary hover:underline inline-flex items-center gap-1"><ChevronLeft size={13} aria-hidden /> Trocar CNPJ</button>}
                  <Field label={kyg.tipoPessoa === 'pj' ? 'CNPJ' : 'CPF'} value={kyg.tipoPessoa === 'pj' ? maskCnpj(kyg.documento) : kyg.documento} required={kyg.tipoPessoa !== 'pj'} locked={kyg.tipoPessoa === 'pj'} onChange={(v) => setKyg({ ...kyg, documento: v })}
                    status={kyg.tipoPessoa === 'pf' && kyg.documento ? (isValidCpf(kyg.documento) ? 'ok' : 'error') : undefined} placeholder="000.000.000-00" />
                  <Field label={kyg.tipoPessoa === 'pj' ? 'Razão social' : 'Nome completo'} value={kyg.nome} required locked={kyg.tipoPessoa === 'pj' && !!kyg.nome} onChange={(v) => setKyg({ ...kyg, nome: v })} />
                  <Field label="Nome do projeto" value={kyg.projeto} required onChange={(v) => setKyg({ ...kyg, projeto: v })} />
                  <AddressFields addr={kyg.endereco} onChange={(a) => setKyg({ ...kyg, endereco: a })} onCep={(c) => lookupCep(c, 'kyg')} locked={kyg.tipoPessoa === 'pj'} />
                  <div className="grid sm:grid-cols-2 gap-3">
                    <Field label="Telefone" value={kyg.telefone} onChange={(v) => setKyg({ ...kyg, telefone: v })} placeholder="(11) 90000-0000"
                      status={kyg.telefone ? (isValidPhone(kyg.telefone) ? 'ok' : 'error') : undefined}
                      hint={kyg.telefone && !isValidPhone(kyg.telefone) ? <span className="text-error">Telefone inválido — inclua o DDD</span> : undefined} />
                    <Field label="E-mail (receberá o documento p/ assinar)" type="email" value={kyg.email} required onChange={(v) => setKyg({ ...kyg, email: v })} />
                  </div>
                  <SectionTitle>Dados bancários (recebimento)</SectionTitle>
                  <BankRow banks={bankOptions} value={kyg.banco} onChange={(b) => setKyg({ ...kyg, banco: b })} />
                  <ComprovanteField file={comprovante} onPick={(f, err) => { setComprovante(f); setCompErr(err); }} error={compErr} />
                </>
              )}
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
              {comprovante && <div className="flex items-center gap-2 text-[12px] text-text-secondary"><Paperclip size={14} className="text-primary shrink-0" aria-hidden /> Comprovante bancário anexado: <span className="text-text font-medium truncate">{comprovante.name}</span></div>}

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
            {onCnpjGate ? <span /> : step < lastStep ? (
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

      {sign && <SignModal sign={sign} onClose={() => setSign(null)} onDone={() => { setSign(null); setDone({ ...sign.info, needsSetup: false }); }} />}
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

// #96 — anexo opcional do comprovante de conta corrente (PDF/imagem) para conferência dos dados bancários.
const COMP_MAX = 10 * 1024 * 1024; // 10 MB
const COMP_TYPES = ['application/pdf', 'image/png', 'image/jpeg'];
function ComprovanteField({ file, onPick, error }: { file: File | null; onPick: (f: File | null, err: string) => void; error: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const handle = (f?: File | null) => {
    if (!f) { onPick(null, ''); return; }
    if (!COMP_TYPES.includes(f.type)) { onPick(null, 'Formato não suportado — envie um PDF, PNG ou JPEG.'); return; }
    if (f.size > COMP_MAX) { onPick(null, 'Arquivo muito grande (máximo 10 MB).'); return; }
    onPick(f, '');
  };
  return (
    <div>
      <span className="text-[12px] font-semibold text-text-secondary">Comprovante de conta corrente <span className="font-normal text-text-secondary">(opcional — PDF ou imagem, até 10 MB)</span></span>
      <p className="text-[12px] text-text-secondary mt-0.5 mb-1.5">Anexe um comprovante bancário (cabeçalho de extrato, cartão da conta ou comprovante de PIX) para conferência dos dados informados.</p>
      {!file ? (
        <>
          <input ref={inputRef} type="file" accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg" className="hidden" onChange={(e) => handle(e.target.files?.[0])} />
          <button type="button" onClick={() => inputRef.current?.click()} className="inline-flex items-center gap-2 px-3 py-2 rounded border border-line text-[12px] font-semibold text-text hover:border-primary">
            <Paperclip size={14} aria-hidden /> Anexar comprovante
          </button>
        </>
      ) : (
        <div className="flex items-center justify-between gap-3 border border-line rounded px-3 py-2 bg-card">
          <span className="flex items-center gap-2 text-[12px] text-text min-w-0"><Paperclip size={14} className="text-primary shrink-0" aria-hidden /><span className="truncate">{file.name}</span><span className="text-text-secondary shrink-0">({(file.size / 1024).toFixed(0)} KB)</span></span>
          <button type="button" onClick={() => { handle(null); if (inputRef.current) inputRef.current.value = ''; }} className="text-text-secondary hover:text-error shrink-0" aria-label="Remover comprovante"><X size={15} /></button>
        </div>
      )}
      {error && <div className="text-[12px] text-error mt-1.5">{error}</div>}
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

function SuccessScreen({ info, type }: { info: { id: string; accessToken?: string; documento?: string; needsSetup: boolean }; type: KycType }) {
  const { id, accessToken, needsSetup } = info;
  const T = type.toUpperCase();
  const reportUrl = accessToken ? `/api/public/kyc/${id}/report.html?token=${encodeURIComponent(accessToken)}` : '';
  const docUrl = accessToken ? `/api/public/kyc/${id}/document.pdf?token=${encodeURIComponent(accessToken)}` : '';
  const now = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const KV = ({ k, v, mono }: { k: string; v: string; mono?: boolean }) => (
    <div className="flex flex-wrap gap-x-2"><span className="text-text-secondary min-w-[120px]">{k}</span><span className={`text-text font-medium break-all ${mono ? 'font-mono text-[12px]' : ''}`}>{v}</span></div>
  );
  return (
    <div className="min-h-screen bg-bg text-text flex flex-col pt-8">
      <header className="bg-sidebar border-b border-line px-5 sm:px-10 py-4 flex items-center gap-4">
        <img src={CASA_HACKER_LOGO} alt="Casa Hacker" className="h-8 w-auto object-contain invert opacity-90" />
        <div className="text-[12px] text-text-secondary">Associação Casa Hacker · conformidade de fornecedores</div>
      </header>
      <main className="flex-1 px-5 sm:px-10 py-10">
        <div className="max-w-2xl mx-auto space-y-6">
          <div className="text-center">
            <div className="w-16 h-16 rounded-full bg-success/10 flex items-center justify-center mx-auto mb-4"><CheckCircle2 size={32} className="text-success" aria-hidden /></div>
            <h1 className="text-[24px] font-light">{needsSetup ? <>Dados <b className="font-semibold text-primary">recebidos</b></> : <>Conformidade <b className="font-semibold text-primary">concluída</b></>}</h1>
            <p className="text-[14px] text-text-secondary mt-2 max-w-md mx-auto leading-relaxed">
              {needsSetup
                ? `Recebemos o seu ${T}. A assinatura eletrônica será habilitada em breve e você receberá o documento por e-mail.`
                : `Obrigado! Seu ${T} foi preenchido e assinado eletronicamente. Guarde a sua cópia abaixo — uma via também será enviada por e-mail. A validade é por ano fiscal: renove no próximo ano.`}
            </p>
          </div>

          <div className="bg-card border border-line rounded-lg p-5">
            <div className="text-[12px] font-semibold text-text-secondary mb-3 flex items-center gap-1.5"><Receipt size={14} className="text-primary" aria-hidden /> Recibo de envio</div>
            <div className="space-y-1.5 text-[13px]">
              <KV k="Protocolo" v={id} mono />
              <KV k="Formulário" v={`${T} — ${needsSetup ? 'aguardando assinatura' : 'assinado eletronicamente'}`} />
              <KV k="Recebido em" v={`${now} (BRT)`} />
            </div>
          </div>

          {accessToken && (
            <div className="bg-card border border-line rounded-lg p-5">
              <div className="text-[12px] font-semibold text-text-secondary mb-1 flex items-center gap-1.5"><Download size={14} className="text-primary" aria-hidden /> Sua cópia</div>
              <p className="text-[12px] text-text-secondary mb-4">Baixe os documentos com os dados que você forneceu e que processamos.</p>
              <div className="grid sm:grid-cols-2 gap-3">
                <a href={docUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-3 border border-line rounded-lg p-4 hover:border-primary focus-visible:ring-2 focus-visible:ring-primary outline-none transition-colors group">
                  <FileText size={22} className="text-primary shrink-0" aria-hidden />
                  <span className="min-w-0"><span className="block text-[13px] font-semibold text-text">Documento {T}</span><span className="block text-[12px] text-text-secondary">{needsSetup ? 'Cópia preenchida (PDF)' : 'PDF assinado'}</span></span>
                  <Download size={16} className="text-text-secondary ml-auto group-hover:text-primary shrink-0" aria-hidden />
                </a>
                <a href={reportUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-3 border border-line rounded-lg p-4 hover:border-primary focus-visible:ring-2 focus-visible:ring-primary outline-none transition-colors group">
                  <ShieldCheck size={22} className="text-primary shrink-0" aria-hidden />
                  <span className="min-w-0"><span className="block text-[13px] font-semibold text-text">Relatório de conformidade</span><span className="block text-[12px] text-text-secondary">Verificações e diligência (PDF)</span></span>
                  <Download size={16} className="text-text-secondary ml-auto group-hover:text-primary shrink-0" aria-hidden />
                </a>
              </div>
            </div>
          )}

          <div className="flex items-center justify-center gap-2 text-[12px] text-text-secondary"><Mail size={14} className="text-primary shrink-0" aria-hidden /> Uma cópia também será enviada ao e-mail informado.</div>
          <p className="text-[12px] text-text-secondary text-center pt-4 border-t border-line">Associação Casa Hacker · CNPJ 36.038.079/0001-97 · operacoes@casahacker.org</p>
        </div>
      </main>
    </div>
  );
}
