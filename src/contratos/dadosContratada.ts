/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Contratos (Tool E) — merge determinístico dos dados da CONTRATADA (#134, LGPD 3.6).
 *
 * Os dados cadastrais NÃO vêm da IA: são montados no servidor a partir do Cockpit
 * (cadastro da Receita persistido na diligência) + o KYS mais recente (representante
 * legal e dados bancários). Servem para preencher o contrato; o operador confere/edita.
 *
 * Módulo SERVER-ONLY (lê arquivos do DATA_DIR).
 */
import path from "path";
import fs from "fs";
import type { KycRecord } from "../kyc/kycTypes";
import type { DadosContratada } from "./contratosTypes";

const onlyDigits = (s: any): string => String(s ?? "").replace(/\D/g, "");
const readJson = (p: string): any => { try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return null; } };
const s = (v: any): string => (v == null ? "" : String(v));

function latestKys(DATA_DIR: string, cnpjD: string): KycRecord | null {
  const dir = path.join(DATA_DIR, "kyc");
  let best: KycRecord | null = null;
  for (const f of (fs.existsSync(dir) ? fs.readdirSync(dir) : [])) {
    if (!f.endsWith(".json")) continue;
    const rec = readJson(path.join(dir, f)) as KycRecord | null;
    if (!rec || rec.type !== "kys" || onlyDigits(rec.kys?.cnpj) !== cnpjD) continue;
    if (!best || s(rec.signedAt || rec.createdAt) > s(best.signedAt || best.createdAt)) best = rec;
  }
  return best;
}

/** Monta os dados da CONTRATADA (Receita + KYS). Campos ausentes ficam vazios. */
export function montarDadosContratada(DATA_DIR: string, cnpj: string): DadosContratada {
  const cnpjD = onlyDigits(cnpj);
  const dil = readJson(path.join(DATA_DIR, "diligencia", `${cnpjD}.json`));
  const r = dil?.receita || {};
  const k: any = latestKys(DATA_DIR, cnpjD)?.kys || {};
  const kEnd = k.repEndereco || {};

  const rep = k.repNome
    ? {
        nome: s(k.repNome), cpf: onlyDigits(k.repCpf), cargo: s(k.repProfissao),
        email: s(k.repEmail), estadoCivil: s(k.repEstadoCivil),
        enderecoCompleto: [kEnd.logradouro, kEnd.numero, kEnd.bairro, kEnd.municipio && kEnd.uf ? `${kEnd.municipio}/${kEnd.uf}` : "", kEnd.cep].filter(Boolean).join(", "),
        telefone: s(k.repTelefone),
      }
    : undefined;

  return {
    cnpj: cnpjD,
    razaoSocial: s(r.razao_social || k.razaoSocial),
    nomeFantasia: s(r.nome_fantasia || k.nomeFantasia),
    endereco: {
      cep: s(r.cep || k.endereco?.cep), logradouro: s(r.logradouro || k.endereco?.logradouro),
      numero: s(r.numero || k.endereco?.numero), complemento: s(r.complemento || k.endereco?.complemento),
      bairro: s(r.bairro || k.endereco?.bairro), municipio: s(r.municipio || k.endereco?.municipio),
      uf: s(r.uf || k.endereco?.uf),
    },
    representante: rep,
    cnaePrincipal: s(r.cnae_principal),
    cnaesSecundarios: Array.isArray(r.cnaes_secundarios) ? r.cnaes_secundarios : [],
    porte: s(r.porte), naturezaJuridica: s(r.natureza_juridica),
    banco: s(k.banco?.banco), agencia: s(k.banco?.agencia), conta: s(k.banco?.conta), chavePix: s(k.banco?.chavePix),
    fonte: "Cockpit (Receita Federal + KYS)",
  };
}
