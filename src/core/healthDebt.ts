import path from "node:path";
import { pathExists, readJsonFile, writeJsonFile } from "./files.js";
import type { CompareReport, HealthDebtEntry, HealthDebtLedger, LoadedConfig } from "../types.js";

export interface HealthDebtUpdateReport {
  ledgerPath: string;
  ledger: HealthDebtLedger;
  newCount: number;
  acceptedCount: number;
  expiredCount: number;
  recoveredCount: number;
  strictPassed: boolean;
}

export async function updateHealthDebtLedger(loaded: LoadedConfig, compare: CompareReport): Promise<HealthDebtUpdateReport> {
  const ledgerPath = healthDebtLedgerPath(loaded);
  const now = new Date().toISOString();
  const ledger = await loadHealthDebtLedger(loaded);
  const current = new Map((compare.checkHealth?.results ?? [])
    .filter((result) => result.classification === "inherited-failure" && result.fingerprint)
    .map((result) => [result.fingerprint!, result]));
  const existingByFingerprint = new Map(ledger.entries.map((entry) => [entry.fingerprint, entry]));
  const entries: HealthDebtEntry[] = [];
  for (const [fingerprint, result] of current) {
    const existing = existingByFingerprint.get(fingerprint);
    const expired = Boolean(existing?.expiresAt && Date.parse(existing.expiresAt) <= Date.parse(now));
    entries.push(existing ? {
      ...existing,
      checkName: result.name,
      lastSeenAt: now,
      status: expired ? "expired" : existing.status === "accepted" ? "accepted" : "new"
    } : {
      fingerprint,
      checkName: result.name,
      status: "new",
      firstSeenAt: now,
      lastSeenAt: now
    });
  }
  for (const existing of ledger.entries) {
    if (current.has(existing.fingerprint)) continue;
    entries.push(existing.status === "recovered" ? existing : { ...existing, status: "recovered", recoveredAt: now, lastSeenAt: now });
  }
  const updated: HealthDebtLedger = { version: 1, updatedAt: now, entries: entries.sort((a, b) => a.checkName.localeCompare(b.checkName)) };
  await writeJsonFile(ledgerPath, updated);
  return summarize(ledgerPath, updated);
}

export async function acceptHealthDebt(loaded: LoadedConfig, fingerprint: string, options: { owner?: string; reason: string; expiresAt?: string }): Promise<HealthDebtLedger> {
  const ledger = await loadHealthDebtLedger(loaded);
  const entry = ledger.entries.find((candidate) => candidate.fingerprint === fingerprint);
  if (!entry) throw new Error(`Health debt fingerprint not found: ${fingerprint}`);
  const now = new Date().toISOString();
  Object.assign(entry, { status: "accepted", acceptedAt: now, owner: options.owner, reason: options.reason, expiresAt: options.expiresAt });
  ledger.updatedAt = now;
  await writeJsonFile(healthDebtLedgerPath(loaded), ledger);
  return ledger;
}

export async function loadHealthDebtLedger(loaded: LoadedConfig): Promise<HealthDebtLedger> {
  const ledgerPath = healthDebtLedgerPath(loaded);
  if (!await pathExists(ledgerPath)) return { version: 1, updatedAt: new Date(0).toISOString(), entries: [] };
  const ledger = await readJsonFile<HealthDebtLedger>(ledgerPath);
  if (ledger.version !== 1) throw new Error(`Unsupported health debt ledger version: ${String(ledger.version)}`);
  return ledger;
}

export function healthDebtLedgerPath(loaded: LoadedConfig): string { return path.join(loaded.artifactsDir, "health-debt", "ledger.json"); }

function summarize(ledgerPath: string, ledger: HealthDebtLedger): HealthDebtUpdateReport {
  const newCount = ledger.entries.filter((entry) => entry.status === "new").length;
  const expiredCount = ledger.entries.filter((entry) => entry.status === "expired").length;
  return { ledgerPath, ledger, newCount, acceptedCount: ledger.entries.filter((entry) => entry.status === "accepted").length, expiredCount, recoveredCount: ledger.entries.filter((entry) => entry.status === "recovered").length, strictPassed: newCount === 0 && expiredCount === 0 };
}
