/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Contratos (Tool E) — gate de elegibilidade no servidor (#130, Seção 7).
 *
 * Avaliado SEMPRE no servidor (nunca confiar no frontend). Só fornecedor Elegível
 * avança. Retorna um snapshot com cada critério (fonte, data, resultado) — congelado
 * no contrato, pois a elegibilidade é temporal. Reusa os serviços já existentes:
 * cadastro da Receita + diligência (diligenciaRoutes) e os registros de KYS.
 *
 * Módulo SERVER-ONLY (lê arquivos, consulta Receita) — não importar no frontend.
 */
import path from "path";
import fs from "fs";
import { fetchReceita } from "../../diligenciaRoutes";
import type { KycRecord } from "../kyc/kycTypes";
import type { ElegibilidadeSnapshot, CriterioElegibilidade, JustificativaElegibilidade } from "./contratosTypes";
import { fmtMoeda } from "./validacoes";

const onlyDigits = (s: any): string => String(s ?? "").replace(/\D/g, "");
const DIA = 86_400_000;
const TETO_MEI_CENTAVOS = 8_100_000; // R$ 81.000,00/ano

const readJson = (p: string): any => { try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return null; } };

// Normaliza texto p/ heurística de CNAE × objeto (sem acento, minúsculo).
const norm = (s: any): string => String(s ?? "").toLowerCase()
  .replace(/[áàâãä]/g, "a").replace(/[éèêë]/g, "e").replace(/[íìîï]/g, "i")
  .replace(/[óòôõö]/g, "o").replace(/[úùûü]/g, "u").replace(/ç/g, "c");
const STOP = new Set(["de", "da", "do", "das", "dos", "e", "a", "o", "as", "os", "para", "por", "com", "em", "no", "na", "ao", "à", "the", "of", "servico", "servicos", "atividade", "atividades", "outras", "outros", "nao", "especificadas", "anteriormente"]);
const tokens = (s: any): Set<string> => new Set(norm(s).split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !STOP.has(w)));

// KYS assinado e válido no ano fiscal vigente, mais recente, para o CNPJ.
function latestKysAssinado(DATA_DIR: string, cnpjD: string): KycRecord | null {
  const dir = path.join(DATA_DIR, "kyc");
  let best: KycRecord | null = null;
  for (const f of (fs.existsSync(dir) ? fs.readdirSync(dir) : [])) {
    if (!f.endsWith(".json")) continue;
    const rec = readJson(path.join(dir, f)) as KycRecord | null;
    if (!rec || rec.type !== "kys" || rec.status !== "assinado") continue;
    if (onlyDigits(rec.kys?.cnpj) !== cnpjD) continue;
    if (!(rec.validUntil && new Date(rec.validUntil).getTime() > Date.now())) continue; // ano fiscal vigente
    if (!best || String(rec.signedAt || rec.createdAt) > String(best.signedAt || best.createdAt)) best = rec;
  }
  return best;
}

function criterioDiligencia(dil: any): CriterioElegibilidade {
  const base = { id: "diligencia", nome: "Diligência (CEIS/CNEP/CEPIM/Leniência + listas)", fonte: "Diligência — Portal da Transparência/CGU e listas de restrição" };
  if (!dil) return { ...base, resultado: "bloqueio", bloqueia: true, detalhe: "Sem diligência para o fornecedor. Rode a diligência agora." };
  const idadeDias = Math.floor((Date.now() - new Date(dil.checkedAt).getTime()) / DIA);
  if (!Number.isFinite(idadeDias) || idadeDias > 30) {
    return { ...base, data: dil.checkedAt, resultado: "bloqueio", bloqueia: true, detalhe: `Diligência vencida (${idadeDias} dias, validade 30). Rode a diligência agora.` };
  }
  if (dil.verdict === "NADA_CONSTA") return { ...base, data: dil.checkedAt, resultado: "ok", bloqueia: false, detalhe: "Nada consta (válida)." };
  if (dil.verdict === "ALERTA") return { ...base, data: dil.checkedAt, resultado: "alerta", bloqueia: true, detalhe: "Há alerta na diligência — prosseguir exige justificativa escrita e aprovador (na trilha)." };
  return { ...base, data: dil.checkedAt, resultado: "bloqueio", bloqueia: true, detalhe: "Diligência pendente/incompleta. Rode novamente." };
}

function criterioCnae(receita: any, objeto?: string): CriterioElegibilidade {
  const base = { id: "cnae_objeto", nome: "Aderência do CNAE ao objeto", fonte: "Receita Federal (CNAE) + heurística" };
  const cnaes = [receita?.cnae_principal, ...(Array.isArray(receita?.cnaes_secundarios) ? receita.cnaes_secundarios : [])].filter(Boolean);
  if (!objeto || !cnaes.length) return { ...base, resultado: "alerta", bloqueia: false, detalhe: "Confirme manualmente a aderência do CNAE ao objeto (a IA confirma no passo 3)." };
  const objToks = tokens(objeto);
  const cnaeToks = new Set<string>();
  for (const c of cnaes) for (const t of tokens(c)) cnaeToks.add(t);
  const comuns = [...objToks].filter((w) => cnaeToks.has(w));
  if (comuns.length) return { ...base, resultado: "ok", bloqueia: false, detalhe: `CNAE compatível com o objeto (termos: ${comuns.slice(0, 5).join(", ")}).` };
  return { ...base, resultado: "alerta", bloqueia: false, detalhe: "O CNAE pode não cobrir o objeto — confirme (a IA confirma no passo 3)." };
}

function criterioMei(receita: any, valorTotalCentavos?: number): CriterioElegibilidade {
  const base = { id: "porte_mei", nome: "Porte do fornecedor (MEI)", fonte: "Receita Federal (porte)" };
  const porte = String(receita?.porte || "");
  if (!/MEI|MICROEMPREENDEDOR/i.test(porte)) {
    return { ...base, resultado: "ok", bloqueia: false, detalhe: porte ? `Porte: ${porte}.` : "Porte não informado." };
  }
  const acimaTeto = !!valorTotalCentavos && valorTotalCentavos > TETO_MEI_CENTAVOS;
  const detalhe = acimaTeto
    ? `Fornecedor MEI com valor (${fmtMoeda(valorTotalCentavos!)}) acima do teto anual de R$ 81.000,00 — risco de desenquadramento. Ciência obrigatória.`
    : "Fornecedor MEI — confirme a compatibilidade do objeto e o teto anual de R$ 81.000,00. Ciência obrigatória.";
  return { ...base, resultado: "alerta", bloqueia: false, detalhe };
}

/** Aplica prosseguimentos justificados (critério Alerta) ao snapshot. */
export function aplicarJustificativas(snap: ElegibilidadeSnapshot, justificativas?: JustificativaElegibilidade[]): ElegibilidadeSnapshot {
  for (const c of snap.criterios) {
    const j = (justificativas || []).find((x) => x.criterioId === c.id);
    if (j && c.bloqueia) { c.justificativa = j.justificativa; c.aprovador = j.aprovador; }
  }
  snap.elegivel = snap.criterios.every((c) => !c.bloqueia || !!c.justificativa);
  return snap;
}

/**
 * Avalia os 5 critérios da Seção 7 e devolve o snapshot. `objeto` (do contrato) e
 * `valorTotalCentavos` afinam os critérios 4 (CNAE) e 5 (MEI).
 */
export async function avaliarElegibilidade(
  DATA_DIR: string, cnpj: string, objeto?: string, valorTotalCentavos?: number,
): Promise<ElegibilidadeSnapshot> {
  const cnpjD = onlyDigits(cnpj);
  const dil = readJson(path.join(DATA_DIR, "diligencia", `${cnpjD}.json`));
  const receita = dil?.receita || (await fetchReceita(cnpjD).catch(() => null));

  const criterios: CriterioElegibilidade[] = [];

  // Critério 1 — Situação cadastral na Receita = ATIVA (bloqueio duro)
  const sit = receita?.situacao_cadastral || "";
  const ativa = /ATIVA/i.test(sit);
  criterios.push({
    id: "receita_ativa", nome: "Situação cadastral na Receita Federal",
    fonte: receita?.fonte || "Receita Federal", data: receita?.fetchedAt || dil?.checkedAt,
    resultado: ativa ? "ok" : "bloqueio", bloqueia: !ativa,
    detalhe: sit ? `Situação: ${sit}${receita?.data_situacao ? ` (desde ${receita.data_situacao})` : ""}.` : "Não foi possível consultar a situação cadastral.",
  });

  // Critério 2 — Diligência válida (≤30 dias) e Nada consta
  criterios.push(criterioDiligencia(dil));

  // Critério 3 — KYS preenchido e assinado, ano fiscal vigente (bloqueio duro)
  const kys = latestKysAssinado(DATA_DIR, cnpjD);
  criterios.push({
    id: "kys_assinado", nome: "KYS preenchido e assinado (Documenso)", fonte: "KYS / Documenso",
    data: kys?.signedAt, resultado: kys ? "ok" : "bloqueio", bloqueia: !kys,
    detalhe: kys ? `Assinado em ${String(kys.signedAt || "").slice(0, 10)}, válido até ${String(kys.validUntil || "").slice(0, 10)}.` : "Sem KYS assinado e válido no ano fiscal vigente. Solicite a regularização.",
  });

  // Critério 4 — CNAE × objeto (alerta, não bloqueia)
  criterios.push(criterioCnae(receita, objeto));

  // Critério 5 — Porte MEI (alerta com ciência)
  criterios.push(criterioMei(receita, valorTotalCentavos));

  const elegivel = criterios.every((c) => !c.bloqueia);
  return { avaliadoEm: new Date().toISOString(), elegivel, criterios };
}
