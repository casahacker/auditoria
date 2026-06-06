/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Contratos (Tool E) — Termos e Condições imutáveis (#128).
 *
 * Guard-rail jurídico nº 1 (épico #126): os T&C são anexados BYTE A BYTE a partir do
 * PDF oficial. A integridade é conferida por SHA-256 no boot e antes de montar qualquer
 * pacote (fail-safe). O conteúdo dos T&C NUNCA passa pela IA nem é regenerado.
 *
 * Trocar o PDF ou o hash sem uma nova versão dos T&C é PROIBIDO. Para publicar uma
 * versão nova: substitua o asset, atualize VERSAO_TC e HASH_TC_ESPERADO juntos (o hash
 * é a fonte da verdade — calcule com `sha256sum`).
 */
import path from "path";
import fs from "fs";
import crypto from "node:crypto";
import { fileURLToPath } from "url";

export const VERSAO_TC = "2026-05";
export const TC_FILENAME = "termos-e-condicoes-pj-v2026-05.pdf";
// SHA-256 do PDF oficial dos T&C (Casa Hacker, export Google Docs, 10 págs A4).
export const HASH_TC_ESPERADO = "1e2f1745309efad3c127f00f2c3e9f6577d90ed3fc81d23731d9e04bd371a488";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Em runtime: /app/src/contratos → /app/assets/contratos/<pdf>. assets/ é COPY'd inteira.
export const TC_PATH = path.resolve(__dirname, "..", "..", "assets", "contratos", TC_FILENAME);

export interface TcStatus {
  versao: string;
  arquivo: string;
  esperado: string;
  encontrado: string | null;
  ok: boolean;
  erro?: string;
}

let _status: TcStatus | null = null;

/** Recalcula o hash do asset e memoiza o resultado. */
export function verificarTc(): TcStatus {
  try {
    const buf = fs.readFileSync(TC_PATH);
    const hash = crypto.createHash("sha256").update(buf).digest("hex");
    const ok = hash === HASH_TC_ESPERADO;
    _status = {
      versao: VERSAO_TC, arquivo: TC_PATH, esperado: HASH_TC_ESPERADO, encontrado: hash, ok,
      ...(ok ? {} : { erro: "Hash do PDF dos T&C diverge do esperado" }),
    };
  } catch (e: any) {
    _status = {
      versao: VERSAO_TC, arquivo: TC_PATH, esperado: HASH_TC_ESPERADO, encontrado: null, ok: false,
      erro: `PDF dos T&C ausente ou ilegível: ${e?.message || e}`,
    };
  }
  return _status;
}

/** Status memoizado (verifica na 1ª chamada). */
export function tcStatus(): TcStatus {
  return _status || verificarTc();
}

/** Fail-safe: lança se os T&C não conferem — chamar antes de montar qualquer pacote. */
export function assertTcOk(): void {
  const s = tcStatus();
  if (!s.ok) {
    const enc = s.encontrado ? s.encontrado.slice(0, 12) + "…" : "—";
    throw new Error(`${s.erro || "T&C inválidos"} (esperado ${s.esperado.slice(0, 12)}…, encontrado ${enc}).`);
  }
}

/** Snapshot p/ congelar no contrato/aditivo gerado (#128). */
export function tcSnapshot(): { versaoTC: string; hashTC: string } {
  return { versaoTC: VERSAO_TC, hashTC: HASH_TC_ESPERADO };
}
