// Tipos da barra de acessibilidade (vendorizada de casahacker/barra-acessibilidade,
// SEM VLibras — excluído nesta integração).

export type Theme = "light" | "dark";
export type FontSize = "small" | "normal" | "large";

export interface State {
  theme: Theme;
  contrast: boolean;
  fontSize: FontSize;
  dyslexia: boolean;
  bigCursor: boolean;
  focusMode: boolean;
  readingRuler: boolean;
  noMotion: boolean;
  highlightFocus: boolean;
  biggerTargets: boolean;
  underlineLinks: boolean;
}

export type BooleanKey = {
  [K in keyof State]: State[K] extends boolean ? K : never;
}[keyof State];

/** Opções pra customizar a barra. Todas opcionais — defaults sensatos. */
export interface AccessibilityBarOptions {
  /** Prefixo das chaves no localStorage. Default `"a11y-"` (compat c/ a barra antiga). */
  storagePrefix?: string;
  /** Prefixo das classes CSS aplicadas em `<html>`. Default `"ch-a11y-"`. */
  classPrefix?: string;
  /** URL do CSS da fonte para dislexia (lazy-load quando ativada). */
  dyslexiaFontUrl?: string;
}
