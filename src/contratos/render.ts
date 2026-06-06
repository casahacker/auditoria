/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Contratos (Tool E) — renderização da minuta (#129, Seções 4 e 10).
 *
 * A mesma estrutura de blocos (templates/contratoPJ_v2026_05) vira PREVIEW HTML
 * (passo 4 do wizard) e PDF (pdf-lib) — mesmo conteúdo (16.10). RODAPÉ em TODAS as
 * páginas (inclusive a de assinaturas), em IBM Plex Mono reduzido:
 *   {{ID_CONTRATO}} · {{JIRA_ISSUE_KEY}} · Página {{N}} de {{TOTAL}}
 *
 * Corpo em Helvetica (os TTF IBM Plex Sans em assets/ estão corrompidos p/ pdf-lib —
 * mesma pegadinha do kycPdf/FEAC). Rodapé em IBM Plex Mono (assets/IBMPlexMono-Regular.ttf,
 * convertido do woff2 oficial — embute corretamente).
 */
import { PDFDocument, StandardFonts, rgb, PDFFont, PDFPage } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { Contrato } from "./contratosTypes";
import { montarBlocos, type Bloco } from "./templates/contratoPJ_v2026_05";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.join(__dirname, "..", "..", "assets");

const A4: [number, number] = [595.28, 841.89];
const M = 56;
const INK = rgb(0.09, 0.09, 0.09);
const GRAY = rgb(0.45, 0.45, 0.45);
const SOFT = rgb(0.55, 0.55, 0.55);
const LINE = rgb(0.8, 0.8, 0.8);

const rodapeTexto = (c: Contrato, n: number, total: number) =>
  `${c.id} · ${c.jira?.issueKey || "JUR-—"} · Página ${n} de ${total}`;

// ── PDF ───────────────────────────────────────────────────────────────────────
// Helvetica (WinAnsi) cobre o PT-BR; saneia só os caracteres fora do Latin-1.
const safePdf = (s: string): string => String(s ?? "")
  .replace(/[‘’‚]/g, "'").replace(/[“”„]/g, '"')
  .replace(/[—–]/g, "-").replace(/…/g, "...").replace(/[•●]/g, "-")
  .replace(/→/g, "->").replace(/≥/g, ">=").replace(/⚠/g, "(!)")
  .replace(/[^\x00-\xFF]/g, "");

function wrap(font: PDFFont, text: string, size: number, maxW: number): string[] {
  const out: string[] = [];
  for (const para of safePdf(text).split("\n")) {
    const words = para.split(/\s+/); let cur = "";
    for (const w of words) {
      const t = cur ? cur + " " + w : w;
      if (font.widthOfTextAtSize(t, size) > maxW && cur) { out.push(cur); cur = w; } else cur = t;
    }
    out.push(cur);
  }
  return out;
}

export async function renderContratoPdf(c: Contrato): Promise<Buffer> {
  const blocos = montarBlocos(c);
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit as any);
  const reg = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let mono: PDFFont;
  try { mono = await doc.embedFont(fs.readFileSync(path.join(ASSETS, "IBMPlexMono-Regular.ttf")), { subset: true }); }
  catch { mono = await doc.embedFont(StandardFonts.Courier); }

  const W = A4[0] - 2 * M;
  let page: PDFPage = doc.addPage(A4);
  let y = A4[1] - M;
  const newPage = () => { page = doc.addPage(A4); y = A4[1] - M; };
  const ensure = (h: number) => { if (y - h < M + 24) newPage(); };

  const drawLines = (lines: string[], size: number, font: PDFFont, gap: number, indent = 0) => {
    for (const ln of lines) { ensure(size + gap); page.drawText(ln, { x: M + indent, y, size, font, color: INK }); y -= size + gap; }
  };

  for (const b of blocos) {
    if (b.tipo === "titulo") {
      ensure(28);
      const t = safePdf(b.texto); const tw = bold.widthOfTextAtSize(t, 14);
      page.drawText(t, { x: (A4[0] - tw) / 2, y: y - 6, size: 14, font: bold, color: INK });
      y -= 30;
    } else if (b.tipo === "clausula") {
      ensure(26); y -= 8;
      page.drawText(safePdf(`CLÁUSULA ${b.numero} — ${b.titulo}`), { x: M, y, size: 10.5, font: bold, color: INK });
      y -= 6; page.drawLine({ start: { x: M, y }, end: { x: M + W, y }, thickness: 0.5, color: LINE }); y -= 12;
    } else if (b.tipo === "paragrafo") {
      drawLines(wrap(reg, b.texto, 10, W), 10, reg, 4); y -= 5;
    } else if (b.tipo === "item") {
      const lines = wrap(reg, b.texto, 9.5, W - 16);
      ensure(lines.length * 13 + 2);
      page.drawText("•", { x: M + 4, y, size: 9.5, font: reg, color: GRAY });
      lines.forEach((ln, i) => page.drawText(ln, { x: M + 16, y: y - i * 13, size: 9.5, font: reg, color: INK }));
      y -= lines.length * 13 + 3;
    } else if (b.tipo === "assinaturas") {
      ensure(120); y -= 40;
      const colW = (W - 40) / 2;
      const cols: Array<{ x: number; linhas: string[] }> = [
        { x: M, linhas: b.esquerda }, { x: M + colW + 40, linhas: b.direita },
      ];
      for (const col of cols) {
        page.drawLine({ start: { x: col.x, y }, end: { x: col.x + colW, y }, thickness: 0.7, color: INK });
        col.linhas.forEach((ln, i) => {
          const f = i === 0 ? bold : reg; const t = safePdf(ln);
          page.drawText(t, { x: col.x, y: y - 14 - i * 12, size: i === 0 ? 9.5 : 8.5, font: f, color: i === 0 ? INK : GRAY });
        });
      }
      y -= 14 + 3 * 12 + 10;
    } else if (b.tipo === "nota") {
      drawLines(wrap(reg, b.texto, 7.5, W), 7.5, reg, 3); y -= 4;
    }
  }

  // rodapé em TODAS as páginas (IBM Plex Mono), inclusive a de assinaturas.
  const paginas = doc.getPages(); const total = paginas.length;
  paginas.forEach((p, i) => {
    const t = rodapeTexto(c, i + 1, total);
    const size = 7;
    const tw = mono.widthOfTextAtSize(t, size);
    p.drawText(t, { x: (A4[0] - tw) / 2, y: M - 28, size, font: mono, color: SOFT });
  });

  return Buffer.from(await doc.save());
}

// ── HTML (preview do passo 4) ───────────────────────────────────────────────────
const esc = (s: string) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function renderContratoHtml(c: Contrato): string {
  const blocos = montarBlocos(c);
  const corpo = blocos.map((b) => {
    switch (b.tipo) {
      case "titulo": return `<h1>${esc(b.texto)}</h1>`;
      case "clausula": return `<h2>CLÁUSULA ${esc(b.numero)} — ${esc(b.titulo)}</h2>`;
      case "paragrafo": return `<p>${esc(b.texto)}</p>`;
      case "item": return `<li>${esc(b.texto)}</li>`;
      case "nota": return `<p class="nota">${esc(b.texto)}</p>`;
      case "assinaturas":
        return `<div class="assinaturas">${[b.esquerda, b.direita].map((col) =>
          `<div class="col"><div class="linha"></div>${col.map((l, i) => `<div class="${i === 0 ? "nome" : "papel"}">${esc(l)}</div>`).join("")}</div>`).join("")}</div>`;
    }
  }).join("\n");
  // agrupa <li> soltos em <ul> de forma simples
  const html = corpo.replace(/(?:<li>.*?<\/li>\n?)+/gs, (m) => `<ul>${m}</ul>`);
  return `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><style>
    .minuta{font-family:Helvetica,Arial,sans-serif;color:#171717;max-width:720px;margin:0 auto;line-height:1.5;font-size:14px}
    .minuta h1{font-size:18px;text-align:center;margin:0 0 18px}
    .minuta h2{font-size:14px;margin:20px 0 6px;border-bottom:1px solid #ccc;padding-bottom:4px}
    .minuta p{margin:0 0 10px;text-align:justify}.minuta ul{margin:0 0 10px;padding-left:20px}.minuta li{margin:0 0 6px;text-align:justify}
    .minuta .nota{font-size:11px;color:#666}
    .minuta .assinaturas{display:flex;gap:40px;margin-top:48px}.minuta .col{flex:1;text-align:center}
    .minuta .linha{border-top:1px solid #171717;margin-bottom:8px}.minuta .nome{font-weight:600}.minuta .papel{font-size:12px;color:#555}
    .minuta .rodape{margin-top:24px;text-align:center;font-family:'IBM Plex Mono',monospace;font-size:11px;color:#888}
  </style><div class="minuta">${html}<div class="rodape">${esc(rodapeTexto(c, 1, 1).replace(/Página 1 de 1/, "Rodapé em todas as páginas do PDF"))}</div></div></html>`;
}
