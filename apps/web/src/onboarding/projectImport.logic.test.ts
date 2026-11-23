import {
  EnvironmentId,
  ProjectId,
  type AgentSessionImportResult,
  type AgentSessionProjectCandidate,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  formatImportProgress,
  groupOnboardingProjects,
  importProjectInBatches,
  isNewOnboardingProject,
  partitionOnboardingProjects,
  onboardingProjectKey,
  projectImportWarning,
  resolveImportSelection,
  resolveOnboardingLandingProject,
  resolveOnboardingProjectId,
  selectEveryProjectFound,
} from "./projectImport.logic";

const now = Date.parse("2026-08-22T12:00:00.000Z");

function candidate(
  path: string,
  overrides: Partial<AgentSessionProjectCandidate> = {},
): AgentSessionProjectCandidate {
  return {
    title: path.split("/").at(-1) ?? path,
    path,
    sources: ["codex"],
    threadCount: 3,
    lastActiveAt: "2026-08-20T12:00:00.000Z",
    alreadyImported: false,
    git: { remoteKey: null, repository: null },
    ...overrides,
  };
}

const github = (repository: string) => ({
  remoteKey: `github.com/${repository.toLowerCase()}`,
  repository,
});

describe("partitionOnboardingProjects", () => {
  it("keeps existing projects available for thread history import", () => {
    const imported = candidate("/projects/current", { alreadyImported: true });
    const available = candidate("/projects/other");

    expect(partitionOnboardingProjects([imported, available], now)).toEqual({
      available: [imported, available],
      recent: [imported, available],
    });
  });

  it("keeps projects older than 30 days out of the default selection", () => {
    const recent = candidate("/projects/recent");
    const older = candidate("/projects/older", {
      lastActiveAt: "2026-07-01T12:00:00.000Z",
    });

    expect(partitionOnboardingProjects([recent, older], now)).toEqual({
      available: [recent, older],
      recent: [recent],
    });
  });

  it("keeps non-git folders and thin histories out of the default selection", () => {
    const repo = candidate("/projects/repo");
    const folder = candidate("/projects/folder", { git: null });
    const thin = candidate("/projects/thin", { threadCount: 2 });

    expect(partitionOnboardingProjects([repo, folder, thin], now).recent).toEqual([repo]);
  });

  it("selects candidates from servers that do not report git identity", () => {
    const { git: _git, ...legacy } = candidate("/projects/legacy");

    expect(partitionOnboardingProjects([legacy], now).recent).toEqual([legacy]);
  });
});

describe("groupOnboardingProjects", () => {
  it("groups clones by origin, keeps local repos separate, and folds non-git folders away", () => {
    const main = candidate("/code/t3code", {
      git: github("pingdotgg/t3code"),
      threadCount: 79,
      lastActiveAt: "2026-08-21T12:00:00.000Z",
    });
    const clone = candidate("/code/clones/t3code-2", {
      git: github("pingdotgg/t3code"),
      threadCount: 13,
      lastActiveAt: "2026-08-10T12:00:00.000Z",
    });
    const older = candidate("/code/fleet", {
      git: github("t3dotgg/fleet"),
      threadCount: 295,
      lastActiveAt: "2026-08-22T00:00:00.000Z",
    });
    const local = candidate("/code/scratch-repo", { title: "scratch-repo" });
    const folder = candidate("/tmp/notes", { git: null });

    const grouped = groupOnboardingProjects([main, clone, older, local, folder]);

    expect(grouped.other).toEqual([folder]);
    expect(
      grouped.repositories.map((group) => ({
        label: group.label,
        paths: group.candidates.map((item) => item.path),
        threadCount: group.threadCount,
        lastActiveAt: group.lastActiveAt,
      })),
    ).toEqual([
      {
        label: "t3dotgg/fleet",
        paths: ["/code/fleet"],
        threadCount: 295,
        lastActiveAt: "2026-08-22T00:00:00.000Z",
      },
      {
        label: "pingdotgg/t3code",
        paths: ["/code/t3code", "/code/clones/t3code-2"],
        threadCount: 92,
        lastActiveAt: "2026-08-21T12:00:00.000Z",
      },
      {
        label: "scratch-repo",
        paths: ["/code/scratch-repo"],
        threadCount: 3,
        lastActiveAt: "2026-08-20T12:00:00.000Z",
      },
    ]);
  });

  // regression: #10547 project import broke on servers that predate git identity
  it("lists candidates without git identity as standalone repositories", () => {
    const { git: _git, ...legacy } = candidate("/code/legacy", { title: "legacy" });

    const grouped = groupOnboardingProjects([legacy]);

    expect(grouped.other).toEqual([]);
    expect(grouped.repositories.map((group) => [group.label, group.repository])).toEqual([
      ["legacy", null],
    ]);
  });
});

describe("resolveOnboardingProjectId", () => {
  const localEnvironmentId = EnvironmentId.make("local");
  const remoteEnvironmentId = EnvironmentId.make("remote");
  const localProjectId = ProjectId.make("local-project");

  it("uses the scanned project ID when the client still has an older project at that root", () => {
    const scanned = candidate("/projects/repo", { projectId: localProjectId });
    expect(
      resolveOnboardingProjectId(
        [
          {
            id: ProjectId.make("stale-project"),
            environmentId: localEnvironmentId,
            workspaceRoot: "/projects/repo",
          },
        ],
        localEnvironmentId,
        scanned,
      ),
    ).toBe(localProjectId);
    expect(isNewOnboardingProject([])(localEnvironmentId, scanned)).toBe(false);
  });

  it("finds an existing project by normalized root in the target environment", () => {
    const projects = [
      {
        id: ProjectId.make("remote-project"),
        environmentId: remoteEnvironmentId,
        workspaceRoot: "C:\\Work\\Repo",
      },
      {
        id: localProjectId,
        environmentId: localEnvironmentId,
        workspaceRoot: "C:\\Work\\Repo\\",
      },
    ];
    expect(
      resolveOnboardingProjectId(projects, localEnvironmentId, candidate("c:/work/repo")),
    ).toBe(localProjectId);
    expect(isNewOnboardingProject(projects)(localEnvironmentId, candidate("c:/work/repo"))).toBe(
      false,
    );
  });

  it("does not reuse a project from another environment", () => {
    const projects = [
      {
        id: ProjectId.make("remote-project"),
        environmentId: remoteEnvironmentId,
        workspaceRoot: "/projects/repo",
      },
    ];
    expect(
      resolveOnboardingProjectId(projects, localEnvironmentId, candidate("/projects/repo")),
    ).toBeNull();
    expect(isNewOnboardingProject(projects)(localEnvironmentId, candidate("/projects/repo"))).toBe(
      true,
    );
  });
});

describe("resolveOnboardingLandingProject", () => {
  it("prefers a partial first import that added history", () => {
    expect(
      resolveOnboardingLandingProject(
        ["/projects/partial", "/projects/complete"],
        new Map([["/projects/partial", "partial"]]),
        new Map([["/projects/complete", "complete"]]),
      ),
    ).toBe("partial");
  });

  it("uses a completed zero-history project when no import added history", () => {
    expect(
      resolveOnboardingLandingProject(
        ["/projects/empty", "/projects/failed"],
        new Map(),
        new Map([["/projects/empty", "empty"]]),
      ),
    ).toBe("empty");
  });

  it("ignores cached successes outside the current retry selection", () => {
    expect(
      resolveOnboardingLandingProject(
        ["/projects/current"],
        new Map([["/projects/previous", "previous"]]),
        new Map([
          ["/projects/previous", "previous"],
          ["/projects/current", "current"],
        ]),
      ),
    ).toBe("current");
  });
});

describe("projectImportWarning", () => {
  it.each([
    {
      totals: { imported: 100, failed: 0, deferred: 153, requestFailed: false, stopped: false },
      warning: "Imported 100 threads. 153 threads were not imported yet.",
    },
    {
      totals: { imported: 100, failed: 3, deferred: 1, requestFailed: false, stopped: false },
      warning:
        "Imported 100 threads. 3 threads could not be imported. 1 thread was not imported yet.",
    },
    {
      totals: { imported: 100, failed: 0, deferred: 53, requestFailed: true, stopped: false },
      warning:
        "Imported 100 threads. Some thread history could not be imported. 53 threads were not imported yet.",
    },
    {
      totals: { imported: 0, failed: 2, deferred: 0, requestFailed: false, stopped: false },
      warning: "2 threads could not be imported.",
    },
    {
      totals: { imported: 5, failed: 0, deferred: 0, requestFailed: true, stopped: false },
      warning: "Imported 5 threads. Some thread history could not be imported.",
    },
    {
      totals: { imported: 0, failed: 0, deferred: 0, requestFailed: true, stopped: false },
      warning: "Could not import thread history.",
    },
    {
      totals: { imported: 4, failed: 0, deferred: 3, requestFailed: false, stopped: true },
      warning: "Import stopped. Imported 4 threads. 3 threads were not imported yet.",
    },
    {
      totals: { imported: 0, failed: 0, deferred: 0, requestFailed: false, stopped: true },
      warning: "Import stopped.",
    },
  ])("separates deferred threads from failures: $warning", ({ totals, warning }) => {
    expect(projectImportWarning(totals)).toBe(warning);
  });
});

describe("importProjectInBatches", () => {
  const batch = (
    importedCount: number,
    skippedCount: number,
    deferredCount?: number,
  ): AgentSessionImportResult =>
    deferredCount === undefined
      ? { importedCount, skippedCount }
      : { importedCount, skippedCount, deferredCount };

  it.each([
    {
      name: "continues while the deferred work shrinks and sums the imported threads",
      batches: [batch(100, 160, 153), batch(100, 60, 53), batch(50, 7, 0)],
      result: { imported: 250, failed: 7, deferred: 0, requestFailed: false, stopped: false },
      progress: [
        { imported: 100, left: 153 },
        { imported: 200, left: 53 },
        { imported: 250, left: 0 },
      ],
    },
    {
      name: "stops after a batch without progress and keeps what is left as not imported yet",
      batches: [batch(2, 6, 5), batch(0, 6, 5), batch(5, 0, 0)],
      result: { imported: 2, failed: 1, deferred: 5, requestFailed: false, stopped: false },
      progress: [
        { imported: 2, left: 5 },
        { imported: 2, left: 5 },
      ],
    },
    {
      name: "continues after a batch that finds a new failure, which the next batch skips",
      batches: [batch(1, 1, 1), batch(0, 2, 1), batch(1, 1, 0)],
      result: { imported: 2, failed: 1, deferred: 0, requestFailed: false, stopped: false },
      progress: [
        { imported: 1, left: 1 },
        { imported: 1, left: 1 },
        { imported: 2, left: 0 },
      ],
    },
    {
      name: "imports one batch from a server without deferred counts",
      batches: [batch(3, 2), batch(4, 0)],
      result: { imported: 3, failed: 2, deferred: 0, requestFailed: false, stopped: false },
      progress: [{ imported: 3, left: 0 }],
    },
    {
      name: "continues a truncated scan while batches import, then stops",
      scanTruncated: true,
      batches: [batch(2, 0, 0), batch(1, 0, 0), batch(0, 0, 0), batch(4, 0, 0)],
      result: { imported: 3, failed: 0, deferred: 0, requestFailed: false, stopped: false },
      progress: [
        { imported: 2, left: 0 },
        { imported: 3, left: 0 },
        { imported: 3, left: 0 },
      ],
    },
    {
      name: "does not retry a truncated scan after a first batch that imports nothing",
      scanTruncated: true,
      batches: [batch(0, 0, 0), batch(4, 0, 0)],
      result: { imported: 0, failed: 0, deferred: 0, requestFailed: false, stopped: false },
      progress: [{ imported: 0, left: 0 }],
    },
    {
      name: "keeps earlier imports and the last deferred count when a later batch fails",
      batches: [batch(2, 6, 5), null, batch(5, 0, 0)],
      result: { imported: 2, failed: 1, deferred: 5, requestFailed: true, stopped: false },
      progress: [{ imported: 2, left: 5 }],
    },
    {
      name: "reports a stop requested after the first batch with its deferred count",
      stopAfter: 1,
      batches: [batch(2, 5, 5), batch(4, 3, 3)],
      result: { imported: 2, failed: 0, deferred: 5, requestFailed: false, stopped: true },
      progress: [{ imported: 2, left: 5 }],
    },
  ])("$name", async ({ batches, scanTruncated = false, stopAfter, result, progress }) => {
    const pending = [...batches];
    let requested = 0;
    const reported: Array<{ readonly imported: number; readonly left: number }> = [];

    const totals = await importProjectInBatches({
      scanTruncated,
      importBatch: async () => {
        requested += 1;
        return pending.shift() ?? null;
      },
      isStopRequested: () => stopAfter !== undefined && requested >= stopAfter,
      onProgress: (next) => reported.push(next),
    });

    expect(totals).toEqual(result);
    expect(reported).toEqual(progress);
  });
});

describe("formatImportProgress", () => {
  it.each([
    { title: "web", position: 1, total: 1, progress: null, line: "Importing web…" },
    { title: "web", position: 2, total: 3, progress: null, line: "Importing web (2 of 3)…" },
    {
      title: "web",
      position: 2,
      total: 3,
      progress: { imported: 100, left: 153 },
      line: "Importing web (2 of 3)… 100 threads imported, 153 left",
    },
    {
      title: "web",
      position: 2,
      total: 3,
      progress: { imported: 1, left: 0 },
      line: "Importing web (2 of 3)… 1 thread imported",
    },
  ])("$line", ({ line, ...input }) => {
    expect(formatImportProgress(input)).toBe(line);
  });
});

describe("welcome import selection", () => {
  const listed = [{ key: "repo" }, { key: "clone" }, { key: "folder" }];
  const recentKeys = new Set(["repo"]);

  it("All history checks every project found while the import box is on", () => {
    const everyListed = selectEveryProjectFound(null, listed, recentKeys);
    expect(everyListed).toEqual({
      knownKeys: ["repo", "clone", "folder"],
      keys: ["repo", "clone", "folder"],
      optedOut: false,
      selectsFound: true,
    });
    const rescanned = [...listed, { key: "archive" }];
    expect(resolveImportSelection(everyListed, rescanned, recentKeys)).toEqual(rescanned);

    const onlyOlder = selectEveryProjectFound(null, [], new Set());
    expect(onlyOlder).toEqual({ knownKeys: [], keys: [], optedOut: false, selectsFound: true });
    expect(resolveImportSelection(onlyOlder, listed, new Set())).toEqual(listed);
  });

  it("All history leaves an opted-out or emptied selection alone", () => {
    const optedOut = { knownKeys: [], keys: [], optedOut: true };
    const emptied = { knownKeys: ["repo", "clone", "folder"], keys: [], optedOut: false };

    expect(selectEveryProjectFound(optedOut, listed, recentKeys)).toBe(optedOut);
    expect(selectEveryProjectFound(emptied, listed, recentKeys)).toBe(emptied);
  });
});

describe("projects on multiple computers", () => {
  it("keeps identical paths independent when selecting a landing project after partial imports", () => {
    const first = onboardingProjectKey(EnvironmentId.make("first"), "/code/app");
    const second = onboardingProjectKey(EnvironmentId.make("second"), "/code/app");
    const completed = new Map([[first, "first-project"]]);
    expect(completed.has(second)).toBe(false);
    expect(resolveOnboardingLandingProject([second], completed, completed)).toBeUndefined();
    completed.set(second, "second-project");
    expect(resolveOnboardingLandingProject([second, first], completed, completed)).toBe(
      "second-project",
    );
  });

  // regression: #10465 multi-computer onboarding mixed up which computer a project came from
  it("preserves computer identity when choosing recent projects", () => {
    const first = { ...candidate("/code/app"), environmentId: "first" };
    const second = { ...candidate("/code/app"), environmentId: "second" };
    expect(partitionOnboardingProjects([first, second], now).recent).toEqual([first, second]);
  });
});
