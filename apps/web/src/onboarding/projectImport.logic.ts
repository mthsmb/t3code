import {
  findProjectByPath,
  normalizeProjectPathForComparison,
} from "@t3tools/client-runtime/state/projects";
import type {
  AgentSessionImportResult,
  AgentSessionProjectCandidate,
  EnvironmentId,
  ProjectId,
} from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "../i18n/messages";
import type { WelcomeImportSelection } from "./welcomeState";

const RECENT_PROJECT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_SELECTION_MIN_THREADS = 3;

/** Treat candidates missing git as repositories for servers predating git scans. */
export function partitionOnboardingProjects<T extends AgentSessionProjectCandidate>(
  candidates: ReadonlyArray<T>,
  now = Date.now(),
) {
  const cutoff = now - RECENT_PROJECT_WINDOW_MS;

  return {
    available: candidates,
    recent: candidates.filter((candidate) => {
      if (candidate.git === null) return false;
      if (candidate.threadCount < DEFAULT_SELECTION_MIN_THREADS) return false;
      if (candidate.lastActiveAt === null) return false;
      const lastActiveAt = Date.parse(candidate.lastActiveAt);
      return lastActiveAt >= cutoff && lastActiveAt <= now;
    }),
  };
}

export interface OnboardingProjectGroup<T> {
  readonly key: string;
  readonly label: string;
  readonly repository: string | null;
  readonly candidates: ReadonlyArray<T>;
  readonly threadCount: number;
  readonly lastActiveAt: string | null;
}

function latestActivity(left: string | null, right: string | null): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return left > right ? left : right;
}

export function groupOnboardingProjects<
  T extends Pick<
    AgentSessionProjectCandidate,
    "path" | "title" | "git" | "threadCount" | "lastActiveAt"
  >,
>(candidates: ReadonlyArray<T>) {
  const groups = new Map<string, OnboardingProjectGroup<T> & { candidates: Array<T> }>();
  const other: Array<T> = [];

  for (const candidate of candidates) {
    if (candidate.git === null) {
      other.push(candidate);
      continue;
    }
    const git = candidate.git ?? { remoteKey: null, repository: null };
    const key = git.remoteKey === null ? `path:${candidate.path}` : `remote:${git.remoteKey}`;
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, {
        key,
        label: git.repository ?? candidate.title,
        repository: git.repository,
        candidates: [candidate],
        threadCount: candidate.threadCount,
        lastActiveAt: candidate.lastActiveAt,
      });
      continue;
    }
    existing.candidates.push(candidate);
    groups.set(key, {
      ...existing,
      threadCount: existing.threadCount + candidate.threadCount,
      lastActiveAt: latestActivity(existing.lastActiveAt, candidate.lastActiveAt),
    });
  }

  const repositories = [...groups.values()].sort((left, right) => {
    if (left.lastActiveAt === right.lastActiveAt) return left.label.localeCompare(right.label);
    if (left.lastActiveAt === null) return 1;
    if (right.lastActiveAt === null) return -1;
    return right.lastActiveAt.localeCompare(left.lastActiveAt);
  });

  return { repositories, other };
}

/** Use the server's project match before the client snapshot, which can lag behind the scan. */
export function resolveOnboardingProjectId(
  projects: ReadonlyArray<{
    readonly id: ProjectId;
    readonly environmentId: EnvironmentId;
    readonly workspaceRoot: string;
  }>,
  environmentId: EnvironmentId,
  candidate: Pick<AgentSessionProjectCandidate, "path" | "projectId">,
): ProjectId | null {
  if (candidate.projectId !== undefined) return candidate.projectId;
  const environmentProjects = projects.filter((project) => project.environmentId === environmentId);
  const currentRootMatch = findProjectByPath(environmentProjects, candidate.path);
  if (currentRootMatch !== undefined) return currentRootMatch.id;
  return null;
}

/**
 * Whether a candidate is not a project yet, by the same rules as `resolveOnboardingProjectId`.
 * It reads the project list once, so a long candidate list costs one pass, not one per candidate.
 */
export function isNewOnboardingProject(
  projects: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly workspaceRoot: string;
  }>,
) {
  const roots = new Set(
    projects.map(
      (project) =>
        `${project.environmentId}\u0000${normalizeProjectPathForComparison(project.workspaceRoot)}`,
    ),
  );
  return (
    environmentId: EnvironmentId,
    candidate: Pick<AgentSessionProjectCandidate, "path" | "projectId">,
  ) => {
    if (candidate.projectId !== undefined) return false;
    const path = normalizeProjectPathForComparison(candidate.path);
    return path.length === 0 || !roots.has(`${environmentId}\u0000${path}`);
  };
}

export function resolveOnboardingLandingProject<T>(
  selection: ReadonlyArray<string>,
  projectsWithImportedHistory: ReadonlyMap<string, T>,
  completedProjects: ReadonlyMap<string, T>,
): T | undefined {
  for (const path of selection) {
    const project = projectsWithImportedHistory.get(path);
    if (project !== undefined) return project;
  }
  for (const path of selection) {
    const project = completedProjects.get(path);
    if (project !== undefined) return project;
  }
  return undefined;
}

/** Projects found after the last choice get the default pick, or every one after All history. */
export function resolveImportSelection<T extends { readonly key: string }>(
  selection: WelcomeImportSelection | null,
  candidates: ReadonlyArray<T>,
  recentKeys: ReadonlySet<string>,
): ReadonlyArray<T> {
  if (selection?.optedOut) return [];
  const knownKeys = new Set(selection?.knownKeys);
  const pickedKeys = new Set(selection?.keys);
  return candidates.filter((candidate) =>
    knownKeys.has(candidate.key)
      ? pickedKeys.has(candidate.key)
      : selection?.selectsFound === true || recentKeys.has(candidate.key),
  );
}

/** An opt-out or an emptied list wins over All history, so it never checks what was unchecked. */
export function selectEveryProjectFound(
  current: WelcomeImportSelection | null,
  candidates: ReadonlyArray<{ readonly key: string }>,
  recentKeys: ReadonlySet<string>,
): WelcomeImportSelection | null {
  if (current?.optedOut) return current;
  if (candidates.length > 0 && resolveImportSelection(current, candidates, recentKeys).length === 0)
    return current;
  const keys = candidates.map((candidate) => candidate.key);
  return { knownKeys: keys, keys, optedOut: false, selectsFound: true };
}

export interface ProjectImportTotals {
  readonly imported: number;
  readonly failed: number;
  readonly deferred: number;
  readonly requestFailed: boolean;
  readonly stopped: boolean;
}

export interface ProjectImportProgress {
  readonly imported: number;
  readonly left: number;
}

const batchFailures = (result: AgentSessionImportResult) =>
  result.skippedCount - (result.deferredCount ?? 0);

/**
 * A batch moved forward when it imported something, deferred less than the one before, or found
 * a new failure, which the server remembers so the next batch does not spend its budget on it.
 * `importedCount` counts only new threads, so a batch that re-reads owned threads imports nothing.
 */
function batchProgressed(
  previous: AgentSessionImportResult | undefined,
  current: AgentSessionImportResult,
): boolean {
  return (
    previous === undefined ||
    current.importedCount > 0 ||
    (current.deferredCount ?? 0) < (previous.deferredCount ?? 0) ||
    batchFailures(current) > batchFailures(previous)
  );
}

/**
 * Imports one project until nothing is deferred or a batch stops moving forward. A truncated scan
 * can hide older transcripts until imports free its budget, so it continues with nothing deferred
 * while batches import.
 * Known failures are re-reported by every batch, so only the last batch's failures count.
 */
export async function importProjectInBatches(input: {
  readonly importBatch: () => Promise<AgentSessionImportResult | null>;
  readonly scanTruncated: boolean;
  readonly isStopRequested: () => boolean;
  readonly onProgress?: (progress: ProjectImportProgress) => void;
}): Promise<ProjectImportTotals> {
  let imported = 0;
  let previous: AgentSessionImportResult | undefined;
  while (true) {
    const current = await input.importBatch();
    if (current === null) {
      return {
        imported,
        failed: previous === undefined ? 0 : previous.skippedCount - (previous.deferredCount ?? 0),
        deferred: previous?.deferredCount ?? 0,
        requestFailed: true,
        stopped: false,
      };
    }
    imported += current.importedCount;
    const deferred = current.deferredCount ?? 0;
    input.onProgress?.({ imported, left: deferred });
    const progressed = batchProgressed(previous, current);
    previous = current;
    const settled = {
      imported,
      failed: current.skippedCount - deferred,
      deferred,
      requestFailed: false,
    };
    const hasMore =
      progressed &&
      current.deferredCount !== undefined &&
      (deferred > 0 || (input.scanTruncated && current.importedCount > 0));
    if (!hasMore) return { ...settled, stopped: false };
    if (input.isStopRequested()) return { ...settled, stopped: true };
  }
}

/** The summary for an import that left threads behind or was stopped. */
export function projectImportWarning(
  totals: ProjectImportTotals,
  resolve: MessageResolver = m,
): string {
  const { imported, failed, deferred, requestFailed, stopped } = totals;
  if (!stopped && failed === 0 && deferred === 0) {
    return imported > 0
      ? resolve(
          msg(
            "{count, plural, one {Imported {count} thread. Some thread history could not be imported.} other {Imported {count} threads. Some thread history could not be imported.}}",
            { count: imported },
          ),
        )
      : resolve(msg("Could not import thread history."));
  }
  const sentences: Array<string> = [];
  if (stopped) sentences.push(resolve(msg("Import stopped.")));
  if (imported > 0) {
    sentences.push(
      resolve(
        msg("{count, plural, one {Imported {count} thread.} other {Imported {count} threads.}}", {
          count: imported,
        }),
      ),
    );
  }
  if (failed > 0) {
    sentences.push(
      resolve(
        msg(
          "{count, plural, one {{count} thread could not be imported.} other {{count} threads could not be imported.}}",
          { count: failed },
        ),
      ),
    );
  } else if (requestFailed) {
    sentences.push(resolve(msg("Some thread history could not be imported.")));
  }
  if (deferred > 0) {
    sentences.push(
      resolve(
        msg(
          "{count, plural, one {{count} thread was not imported yet.} other {{count} threads were not imported yet.}}",
          { count: deferred },
        ),
      ),
    );
  }
  return sentences.join(" ");
}

export function formatImportProgress(
  input: {
    readonly title: string;
    readonly position: number;
    readonly total: number;
    readonly progress: ProjectImportProgress | null;
  },
  resolve: MessageResolver = m,
): string {
  const { title, position, total, progress } = input;
  const label =
    total > 1
      ? resolve(msg("Importing {title} ({position} of {total})…", { title, position, total }))
      : resolve(msg("Importing {title}…", { title }));
  if (progress === null) return label;
  const detail =
    progress.left > 0
      ? resolve(
          msg(
            "{count, plural, one {{count} thread imported, {left} left} other {{count} threads imported, {left} left}}",
            { count: progress.imported, left: progress.left },
          ),
        )
      : resolve(
          msg("{count, plural, one {{count} thread imported} other {{count} threads imported}}", {
            count: progress.imported,
          }),
        );
  return `${label} ${detail}`;
}

export function splitOnboardingProjectPath(path: string): {
  readonly name: string;
  readonly parent: string;
} {
  if (/^[A-Za-z]:[\\/]+$/.test(path) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+[\\/]*$/.test(path)) {
    return { name: path, parent: "" };
  }
  const trimmed = path.replace(/[\\/]+$/, "");
  const separatorIndex = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (trimmed.length === 0) return { name: path, parent: "" };
  if (separatorIndex < 0) return { name: trimmed, parent: "" };
  return { name: trimmed.slice(separatorIndex + 1), parent: trimmed.slice(0, separatorIndex + 1) };
}

export function onboardingProjectKey(environmentId: EnvironmentId, path: string): string {
  return JSON.stringify([environmentId, path]);
}
