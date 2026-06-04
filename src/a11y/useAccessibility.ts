// Hook central: state + persist + apply (vendorizado de casahacker/barra-acessibilidade).
// Adaptações para a Auditoria:
//  - Tamanho de fonte usa ZOOM no <html> (a UI é em px absolutos — escala Carbon —,
//    então mudar só o font-size do root não ampliaria nada). zoom amplia tudo de fato.
//  - Alto contraste: a classe `ch-a11y-high-contrast` reaproveita os tokens de
//    high-contrast já definidos em index.css (seletor `.high-contrast, .ch-a11y-high-contrast`).

import { useEffect, useRef, useState } from "react";
import type { AccessibilityBarOptions, BooleanKey, State, Theme, FontSize } from "./types";

const DEFAULT_DYSLEXIA_FONT =
  "https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible:wght@400;700&display=swap";

const STATE_DEFAULT: State = {
  theme: "light",
  contrast: false,
  fontSize: "normal",
  dyslexia: false,
  bigCursor: false,
  focusMode: false,
  readingRuler: false,
  noMotion: false,
  highlightFocus: false,
  biggerTargets: false,
  underlineLinks: false,
};

const STATE_KEYS: Record<keyof State, string> = {
  theme: "theme",
  contrast: "contrast",
  fontSize: "font-size",
  dyslexia: "dyslexia",
  bigCursor: "big-cursor",
  focusMode: "focus-mode",
  readingRuler: "reading-ruler",
  noMotion: "no-motion",
  highlightFocus: "highlight-focus",
  biggerTargets: "bigger-targets",
  underlineLinks: "underline-links",
};

function storageKey(prefix: string, k: keyof State): string {
  return `${prefix}${STATE_KEYS[k]}`;
}

function loadInitial(storagePrefix: string): State {
  if (typeof window === "undefined") return { ...STATE_DEFAULT };
  const get = <K extends keyof State>(k: K, fallback: State[K]): State[K] => {
    const v = window.localStorage?.getItem(storageKey(storagePrefix, k));
    if (v === null || v === undefined) return fallback;
    if (typeof fallback === "boolean") return (v === "true") as State[K];
    return v as State[K];
  };
  const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
  const prefersReducedMotion =
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  return {
    theme: get("theme", (prefersDark ? "dark" : "light") as Theme),
    contrast: get("contrast", false),
    fontSize: get("fontSize", "normal" as FontSize),
    dyslexia: get("dyslexia", false),
    bigCursor: get("bigCursor", false),
    focusMode: get("focusMode", false),
    readingRuler: get("readingRuler", false),
    noMotion: get("noMotion", prefersReducedMotion),
    highlightFocus: get("highlightFocus", false),
    biggerTargets: get("biggerTargets", false),
    underlineLinks: get("underlineLinks", false),
  };
}

function persist(storagePrefix: string, s: State): void {
  if (typeof window === "undefined" || !window.localStorage) return;
  for (const k of Object.keys(STATE_KEYS) as (keyof State)[]) {
    window.localStorage.setItem(storageKey(storagePrefix, k), String(s[k]));
  }
}

function applyA11y(s: State, classPrefix: string, dyslexiaFontUrl: string): void {
  if (typeof document === "undefined") return;
  const html = document.documentElement;

  if (s.contrast) {
    html.classList.add(`${classPrefix}high-contrast`);
    html.removeAttribute("data-theme");
  } else {
    html.classList.remove(`${classPrefix}high-contrast`);
    html.setAttribute("data-theme", s.theme);
  }

  // Tamanho da fonte via zoom (a UI é px absolutos; font-size no root não escalaria).
  const zoom = s.fontSize === "small" ? "0.9" : s.fontSize === "large" ? "1.15" : "1";
  html.style.setProperty("zoom", zoom);

  const toggle = (name: string, on: boolean) => html.classList.toggle(`${classPrefix}${name}`, on);
  toggle("dyslexia", s.dyslexia);
  toggle("big-cursor", s.bigCursor);
  toggle("focus-mode", s.focusMode);
  toggle("reading-ruler", s.readingRuler);
  toggle("no-motion", s.noMotion);
  toggle("highlight-focus", s.highlightFocus);
  toggle("bigger-targets", s.biggerTargets);
  toggle("underline-links", s.underlineLinks);

  // Lazy-load Atkinson Hyperlegible quando dislexia ativa.
  if (s.dyslexia && !document.getElementById("ch-a11y-dyslexia-font")) {
    const link = document.createElement("link");
    link.id = "ch-a11y-dyslexia-font";
    link.rel = "stylesheet";
    link.href = dyslexiaFontUrl;
    document.head.appendChild(link);
  }
}

export interface UseAccessibilityReturn {
  state: State;
  toggle: (key: BooleanKey) => void;
  update: <K extends keyof State>(key: K, value: State[K]) => void;
  setTheme: (theme: Theme) => void;
  setFontSize: (size: FontSize) => void;
}

/**
 * Hook que gerencia o state da barra de acessibilidade.
 * Aplica classes CSS em `<html>` + zoom, e persiste em localStorage.
 */
export function useAccessibility(opts: AccessibilityBarOptions = {}): UseAccessibilityReturn {
  const storagePrefix = opts.storagePrefix ?? "a11y-";
  const classPrefix = opts.classPrefix ?? "ch-a11y-";
  const dyslexiaFontUrl = opts.dyslexiaFontUrl ?? DEFAULT_DYSLEXIA_FONT;

  const [state, setState] = useState<State>(STATE_DEFAULT);

  const mountedRef = useRef(false);
  useEffect(() => {
    if (mountedRef.current) return;
    mountedRef.current = true;
    const init = loadInitial(storagePrefix);
    setState(init);
    applyA11y(init, classPrefix, dyslexiaFontUrl);
  }, [storagePrefix, classPrefix, dyslexiaFontUrl]);

  useEffect(() => {
    if (!mountedRef.current) return;
    applyA11y(state, classPrefix, dyslexiaFontUrl);
    persist(storagePrefix, state);
  }, [state, storagePrefix, classPrefix, dyslexiaFontUrl]);

  return {
    state,
    toggle: (key) => setState((s) => ({ ...s, [key]: !s[key] })),
    update: (key, value) => setState((s) => ({ ...s, [key]: value })),
    setTheme: (theme) => setState((s) => ({ ...s, theme })),
    setFontSize: (fontSize) => setState((s) => ({ ...s, fontSize })),
  };
}
