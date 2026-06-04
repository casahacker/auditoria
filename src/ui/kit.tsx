/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Stack Audit — kit de UI compartilhado (IBM Carbon / Casa Hacker).
 *
 * Primitivos usados pelas três ferramentas (Auditoria, FEAC/SGPP e Diligência) e
 * pelo launcher, para que toda a suíte tenha o MESMO design: mesma barra lateral,
 * cabeçalho, botões, chips de status, cartões e modais. Tokens de cor em index.css.
 */
import React, { useEffect, useRef } from 'react';
import { Layers, LogOut, X, Search } from 'lucide-react';
import { cn } from '../lib/utils';
import { AuthUser } from '../types';

export const CASA_HACKER_LOGO = 'https://casahacker.org/wp-content/uploads/2023/07/logo_vertical-branco.svg';

// ── Botão ─────────────────────────────────────────────────────────────────────
type BtnVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
type BtnSize = 'sm' | 'md' | 'lg';

const BTN_VARIANT: Record<BtnVariant, string> = {
  primary:   'bg-primary text-white hover:bg-primary-hover',
  secondary: 'border border-line text-text-secondary hover:text-primary hover:border-primary',
  ghost:     'text-text-secondary hover:text-primary hover:bg-surface-hover',
  danger:    'border border-error/40 text-error hover:bg-error/10',
};
const BTN_SIZE: Record<BtnSize, string> = {
  sm: 'px-3 py-1.5 text-[10px]',
  md: 'px-4 py-2 text-[11px]',
  lg: 'px-5 py-3 text-[12px]',
};

export function Btn({
  variant = 'primary', size = 'md', className, children, ...rest
}: { variant?: BtnVariant; size?: BtnSize } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...rest}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded font-bold uppercase tracking-widest transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        BTN_VARIANT[variant], BTN_SIZE[size], className,
      )}
    >
      {children}
    </button>
  );
}

/** Botão só com ícone — exige aria-label (acessibilidade). */
export function IconBtn({
  label, className, children, ...rest
}: { label: string } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...rest}
      aria-label={label}
      title={rest.title ?? label}
      className={cn(
        'inline-flex items-center justify-center rounded p-1.5 text-text-secondary transition-colors',
        'hover:text-primary hover:bg-surface-hover',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1',
        'disabled:opacity-40 disabled:cursor-not-allowed', className,
      )}
    >
      {children}
    </button>
  );
}

// ── Chip de status ──────────────────────────────────────────────────────────
export type ChipTone = 'success' | 'warning' | 'error' | 'info' | 'neutral';
const CHIP_TONE: Record<ChipTone, string> = {
  success: 'bg-success/10 text-success border-success/30',
  warning: 'bg-warning/10 text-warning border-warning/40',
  error:   'bg-error/10 text-error border-error/30',
  info:    'bg-primary/10 text-primary border-primary/40',
  neutral: 'bg-surface-hover text-text-secondary border-line',
};
export function Chip({
  tone = 'neutral', icon: Icon, size = 'md', className, children,
}: { tone?: ChipTone; icon?: React.ElementType; size?: 'sm' | 'md'; className?: string; children: React.ReactNode }) {
  return (
    <span className={cn(
      'inline-flex items-center gap-1.5 rounded border font-bold uppercase tracking-wider whitespace-nowrap',
      size === 'sm' ? 'px-2 py-0.5 text-[10px] gap-1' : 'px-2.5 py-1 text-[11px]',
      CHIP_TONE[tone], className,
    )}>
      {Icon && <Icon size={size === 'sm' ? 11 : 13} aria-hidden />}
      {children}
    </span>
  );
}

// ── Cartão ────────────────────────────────────────────────────────────────────
export function Card({ className, children, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...rest} className={cn('bg-card border border-line rounded-lg', className)}>
      {children}
    </div>
  );
}

// ── Filtros: Select + busca ───────────────────────────────────────────────────
export function Select({
  value, onChange, options, label, className, ariaLabel,
}: {
  value: string; onChange: (v: string) => void;
  options: { value: string; label: string }[]; label?: string; className?: string; ariaLabel?: string;
}) {
  return (
    <label className={cn('inline-flex items-center gap-2', className)}>
      {label && <span className="text-[10px] uppercase tracking-widest text-text-secondary">{label}</span>}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={ariaLabel || label}
        className="bg-card border border-line rounded px-2.5 py-1.5 text-[12px] text-text hover:border-primary focus:border-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary cursor-pointer"
      >
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}

export function SearchInput({
  value, onChange, placeholder, className,
}: { value: string; onChange: (v: string) => void; placeholder?: string; className?: string }) {
  return (
    <div className={cn('inline-flex items-center gap-2 bg-card border border-line rounded px-2.5 py-1.5 focus-within:border-primary', className)}>
      <Search size={14} className="text-text-secondary shrink-0" aria-hidden />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder || 'Buscar'}
        className="bg-transparent text-[12px] text-text outline-none w-full min-w-[120px]"
      />
      {value && <IconBtn label="Limpar busca" className="p-0.5" onClick={() => onChange('')}><X size={13} /></IconBtn>}
    </div>
  );
}

// ── Tabela (classes canônicas) ────────────────────────────────────────────────
export const tableHeadCls = 'bg-surface-hover text-text-secondary text-left';
export const thCls = 'px-4 py-2.5 font-semibold';
export const tdCls = 'px-4 py-2.5';

// ── Cabeçalho da ferramenta ───────────────────────────────────────────────────
export function ToolHeader({
  light, accent, right, children,
}: { light: string; accent?: string; right?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <header className="px-6 sm:px-10 py-6 border-b border-line flex justify-between items-center bg-bg shrink-0 gap-4">
      <h1 className="text-[20px] font-light shrink-0">
        {light}{accent ? <> <span className="font-bold text-primary">{accent}</span></> : null}
      </h1>
      {right ?? children}
    </header>
  );
}

// ── Barra lateral compartilhada ───────────────────────────────────────────────
export function ToolSidebar({
  brand, onHome, user, top, children,
}: {
  brand: string; onHome: () => void; user: AuthUser;
  top?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <aside className="fixed left-0 top-8 h-[calc(100vh-2rem)] w-[216px] bg-sidebar border-r border-line flex flex-col z-50">
      <div className="pt-6 pb-4 px-5">
        <img src={CASA_HACKER_LOGO} alt="Casa Hacker" className="h-9 w-auto object-contain object-left invert opacity-90 mb-3" />
        <div className="text-primary font-extrabold text-[11px] tracking-widest uppercase mb-2">{brand}</div>
        <button
          onClick={onHome}
          className="flex items-center gap-1.5 text-[10px] text-text-secondary hover:text-primary transition-colors uppercase tracking-widest focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded px-0.5"
        >
          <Layers size={12} aria-hidden /> Ferramentas
        </button>
      </div>
      {top}
      <nav className="flex-1 px-2 py-2 space-y-0.5 overflow-y-auto custom-scrollbar" aria-label={`Navegação — ${brand}`}>
        {children}
      </nav>
      <div className="px-4 py-4 border-t border-line">
        {user.photo && <img src={user.photo} alt="" className="w-7 h-7 rounded-full mb-2" />}
        <p className="text-[10px] text-text-secondary truncate" title={user.email}>{user.email}</p>
        <a
          href="/auth/logout"
          className="mt-2 inline-flex items-center gap-1.5 text-[10px] text-text-secondary hover:text-primary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded px-0.5"
        >
          <LogOut size={11} aria-hidden /> Sair
        </a>
      </div>
    </aside>
  );
}

export function SidebarGroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-3 pt-3 pb-1 mt-1 text-[9px] font-bold uppercase tracking-widest text-text-secondary/70 border-t border-line">
      {children}
    </div>
  );
}

/** Um item da barra lateral. `indicator` substitui o ícone (ex.: círculo numerado do FEAC). */
export function SidebarItem({
  icon: Icon, indicator, active, disabled, onClick, badge, children,
}: {
  icon?: React.ElementType; indicator?: React.ReactNode;
  active?: boolean; disabled?: boolean; onClick?: () => void;
  badge?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'w-full flex items-center gap-2.5 pl-3 pr-2 py-2 rounded text-[12px] text-left transition-colors',
        'border-l-2 border-transparent',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary',
        active ? 'bg-sidebar-active text-primary border-l-primary font-semibold'
               : 'text-text-secondary hover:text-text hover:bg-surface-hover',
        disabled && 'opacity-40 cursor-not-allowed hover:bg-transparent hover:text-text-secondary',
      )}
    >
      {indicator ?? (Icon && <Icon size={15} className="shrink-0" aria-hidden />)}
      <span className="leading-tight flex-1">{children}</span>
      {badge}
    </button>
  );
}

// ── Modal acessível (focus trap + Esc + aria) ────────────────────────────────
export function Modal({
  title, onClose, size = 'md', children,
}: { title: React.ReactNode; onClose: () => void; size?: 'md' | 'lg'; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const prevFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    prevFocus.current = document.activeElement as HTMLElement;
    const focusables = () => ref.current?.querySelectorAll<HTMLElement>(
      'a[href],button:not([disabled]),textarea,input,select,[tabindex]:not([tabindex="-1"])',
    );
    focusables()?.[0]?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { onClose(); return; }
      if (e.key !== 'Tab') return;
      const f = focusables(); if (!f || f.length === 0) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); prevFocus.current?.focus(); };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center p-4 bg-black/55 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        className={cn('bg-card border border-line rounded-lg shadow-2xl w-full max-h-[88vh] overflow-y-auto custom-scrollbar',
          size === 'lg' ? 'max-w-4xl' : 'max-w-2xl')}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-line sticky top-0 bg-card z-10">
          <h2 className="text-[15px] font-bold text-text pr-4">{title}</h2>
          <IconBtn label="Fechar" onClick={onClose}><X size={18} /></IconBtn>
        </div>
        {children}
      </div>
    </div>
  );
}

// ── Link "pular para o conteúdo" (acessibilidade) ────────────────────────────
export function SkipLink() {
  return (
    <a
      href="#main-content"
      className="sr-only focus:not-sr-only focus:fixed focus:top-10 focus:left-2 focus:z-[200] focus:bg-primary focus:text-white focus:px-4 focus:py-2 focus:rounded focus:text-xs focus:font-bold focus:uppercase focus:tracking-widest focus:outline-none"
    >
      Ir para o conteúdo principal
    </a>
  );
}

// ── Estado vazio ──────────────────────────────────────────────────────────────
export function EmptyState({
  icon: Icon, title, description, action,
}: { icon: React.ElementType; title: string; description?: string; action?: React.ReactNode }) {
  return (
    <Card className="p-10 text-center">
      <div className="w-12 h-12 rounded-full bg-surface-hover flex items-center justify-center mx-auto mb-4">
        <Icon size={22} className="text-text-secondary" aria-hidden />
      </div>
      <p className="text-sm font-semibold text-text mb-1">{title}</p>
      {description && <p className="text-xs text-text-secondary max-w-sm mx-auto">{description}</p>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </Card>
  );
}
