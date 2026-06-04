// Barra de acessibilidade — UI principal (vendorizada de casahacker/barra-acessibilidade).
// VLibras EXCLUÍDO desta integração (sem botão Libras, sem lazy-load do widget gov.br).

import React, { useEffect, useRef, useState } from "react";
import type { AccessibilityBarOptions, BooleanKey, FontSize, Theme } from "./types";
import { useAccessibility } from "./useAccessibility";
import {
  IconAccessibility,
  IconBookOpen,
  IconContrast,
  IconCursor,
  IconFocus,
  IconHand,
  IconMoon,
  IconMore,
  IconPause,
  IconRuler,
  IconSun,
  IconUnderline,
} from "./icons";
import "./bar.css";

export interface AccessibilityBarProps {
  options?: AccessibilityBarOptions;
}

export function AccessibilityBar({ options = {} }: AccessibilityBarProps) {
  const { state, toggle, update } = useAccessibility(options);
  const [moreOpen, setMoreOpen] = useState(false);

  // Régua de leitura — segue o cursor via RAF.
  const rulerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!state.readingRuler) return;
    let raf = 0;
    const onMove = (e: MouseEvent) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (rulerRef.current) rulerRef.current.style.top = `${e.clientY}px`;
      });
    };
    window.addEventListener("mousemove", onMove);
    return () => {
      window.removeEventListener("mousemove", onMove);
      cancelAnimationFrame(raf);
    };
  }, [state.readingRuler]);

  const toggleBtn = (key: BooleanKey, icon: React.ReactNode, label: string) => {
    const active = !!state[key];
    return (
      <button
        type="button"
        onClick={() => toggle(key)}
        className={`ch-a11y-btn${active ? " ch-a11y-btn--active" : ""}`}
        aria-pressed={active}
        title={label}
      >
        {icon}
        <span className="ch-a11y-btn__label">{label}</span>
      </button>
    );
  };

  return (
    <>
      {state.readingRuler && (
        <div ref={rulerRef} aria-hidden="true" className="ch-a11y-ruler" style={{ top: 0 }} />
      )}

      <div role="toolbar" aria-orientation="horizontal" aria-label="Barra de acessibilidade" className="ch-a11y-bar">
        <span className="ch-a11y-brand">
          <IconAccessibility width={14} height={14} />
          Acessibilidade
        </span>
        <span className="ch-a11y-divider" />

        {/* Tema */}
        <div role="group" aria-label="Tema" className="ch-a11y-group">
          <span className="ch-a11y-section-label">Tema</span>
          <button
            type="button"
            onClick={() => update("theme", "light" as Theme)}
            className={`ch-a11y-btn${!state.contrast && state.theme === "light" ? " ch-a11y-btn--active" : ""}`}
            aria-pressed={!state.contrast && state.theme === "light"}
            title="Tema claro"
          >
            <IconSun />
            <span className="ch-a11y-btn__label ch-a11y-btn__label--md">Claro</span>
          </button>
          <button
            type="button"
            onClick={() => update("theme", "dark" as Theme)}
            className={`ch-a11y-btn${!state.contrast && state.theme === "dark" ? " ch-a11y-btn--active" : ""}`}
            aria-pressed={!state.contrast && state.theme === "dark"}
            title="Tema escuro"
          >
            <IconMoon />
            <span className="ch-a11y-btn__label ch-a11y-btn__label--md">Escuro</span>
          </button>
          <button
            type="button"
            onClick={() => toggle("contrast")}
            className={`ch-a11y-btn${state.contrast ? " ch-a11y-btn--active" : ""}`}
            aria-pressed={state.contrast}
            title="Alto contraste"
          >
            <IconContrast />
            <span className="ch-a11y-btn__label ch-a11y-btn__label--md">Alto Contraste</span>
          </button>
        </div>

        <span className="ch-a11y-divider" />

        {/* Fonte */}
        <div role="group" aria-label="Tamanho da fonte" className="ch-a11y-group">
          <span className="ch-a11y-section-label">Fonte</span>
          {(
            [
              ["small", "A−"],
              ["normal", "A"],
              ["large", "A+"],
            ] as const
          ).map(([size, label]) => (
            <button
              key={size}
              type="button"
              onClick={() => update("fontSize", size as FontSize)}
              className={`ch-a11y-btn ch-a11y-btn--font-${size}${state.fontSize === size ? " ch-a11y-btn--active" : ""}`}
              aria-pressed={state.fontSize === size}
              title={`Fonte ${size === "small" ? "pequena" : size === "large" ? "grande" : "normal"}`}
            >
              {label}
            </button>
          ))}
        </div>

        <span className="ch-a11y-divider" />

        {/* Toggles principais */}
        {toggleBtn("dyslexia", <IconBookOpen />, "Dislexia")}
        {toggleBtn("readingRuler", <IconRuler />, "Régua")}
        {toggleBtn("focusMode", <IconFocus />, "Foco")}
        {toggleBtn("bigCursor", <IconCursor />, "Cursor +")}

        {/* Painel "Mais" */}
        <button
          type="button"
          onClick={() => setMoreOpen((o) => !o)}
          aria-expanded={moreOpen}
          className="ch-a11y-btn"
          title="Mais opções"
        >
          <IconMore />
          <span className="ch-a11y-btn__label ch-a11y-btn__label--md">Mais</span>
        </button>

        {moreOpen && (
          <>
            {toggleBtn("noMotion", <IconPause />, "Sem animação")}
            {toggleBtn("highlightFocus", <IconFocus />, "Foco realçado")}
            {toggleBtn("biggerTargets", <IconHand />, "Cliques +")}
            {toggleBtn("underlineLinks", <IconUnderline />, "Sublinhar links")}
          </>
        )}
      </div>
    </>
  );
}

export default AccessibilityBar;
