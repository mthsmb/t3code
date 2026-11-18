import { DEFAULT_SERVER_SETTINGS, type AgentSessionImportSettings } from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "../../i18n/messages";
import type { SettingsSearchItemId } from "./settingsSearch";

export type ImportLimitKey = keyof AgentSessionImportSettings;

export const IMPORT_LIMIT_DEFAULTS = DEFAULT_SERVER_SETTINGS.agentSessionImport;

export interface ImportLimit {
  readonly key: ImportLimitKey;
  readonly searchId: SettingsSearchItemId;
  readonly title: string;
  readonly description: string;
  readonly unit: string;
  readonly step?: number;
  /** Labels the switch whose ON state lifts the limit. */
  readonly offLabel?: string;
}

export const IMPORT_LIMITS: ReadonlyArray<ImportLimit> = [
  {
    key: "windowDays",
    searchId: "agent-session-import-window",
    title: msg("Time window"),
    description: msg("Only conversations active within this many days are imported."),
    unit: msg("days", { $context: "import time window unit" }),
    offLabel: msg("All history"),
  },
  {
    key: "messagesPerThread",
    searchId: "agent-session-import-messages",
    title: msg("Messages per thread"),
    description: msg(
      "Keeps the first prompt plus the latest messages. Threads already imported are not changed.",
    ),
    unit: msg("messages", { $context: "import messages per thread unit" }),
    offLabel: msg("Full history"),
  },
  {
    key: "conversationsPerRun",
    searchId: "agent-session-import-conversations",
    title: msg("Conversations per run"),
    description: msg("Most conversations imported per project each time you import."),
    unit: msg("conversations", { $context: "import conversations per run unit" }),
  },
  {
    key: "recordsPerConversation",
    searchId: "agent-session-import-records",
    title: msg("Records per conversation"),
    description: msg(
      "Lines read from one Codex or Pi conversation, including tool activity. Longer ones are skipped.",
    ),
    unit: msg("records", { $context: "import records per conversation unit" }),
    step: 1000,
  },
  {
    key: "scanBudgetMiB",
    searchId: "agent-session-import-scan-budget",
    title: msg("Scan budget"),
    description: msg(
      "History data read from each agent to find where conversations ran. Raise it when projects are missing.",
    ),
    unit: msg("MiB", { $context: "import scan budget unit" }),
  },
];

export function importLimit(key: ImportLimitKey): ImportLimit {
  return IMPORT_LIMITS.find((limit) => limit.key === key)!;
}

export function isImportLimitRaised(limits: AgentSessionImportSettings): boolean {
  return IMPORT_LIMITS.some(({ key }) => {
    const value = limits[key];
    const fallback = IMPORT_LIMIT_DEFAULTS[key];
    return value === null || (fallback !== null && value > fallback);
  });
}

export function isImportLimitCustom(limits: AgentSessionImportSettings): boolean {
  return IMPORT_LIMITS.some(({ key }) => limits[key] !== IMPORT_LIMIT_DEFAULTS[key]);
}

export function importWindowLabel(windowDays: number | null, resolve: MessageResolver = m): string {
  if (windowDays === null) return resolve(importLimit("windowDays").offLabel ?? "");
  return resolve(msg("{count, plural, =1 {Last day} other {Last {count} days}}"), {
    count: windowDays,
  });
}

/** Locked keys stay out because the server rejects a whole patch that touches a locked path. */
export function importLimitsResetPatch(
  limits: AgentSessionImportSettings,
  isLocked: (key: ImportLimitKey) => boolean,
): Partial<AgentSessionImportSettings> {
  return Object.fromEntries(
    IMPORT_LIMITS.flatMap(({ key }) =>
      limits[key] !== IMPORT_LIMIT_DEFAULTS[key] && !isLocked(key)
        ? [[key, IMPORT_LIMIT_DEFAULTS[key]]]
        : [],
    ),
  );
}
