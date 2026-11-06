import { RegistryContext } from "@effect/atom-react";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentId,
  ProjectId,
  type AgentSessionProjectCandidate,
  type AuthSessionState,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render } from "../../../test/render";

type SessionResult = AsyncResult.AsyncResult<AuthSessionState, Error>;
type Project = { id: ProjectId; environmentId: EnvironmentId; workspaceRoot: string };
const state = vi.hoisted(() => ({
  session: null as unknown,
  projects: null as unknown,
  candidates: [] as AgentSessionProjectCandidate[],
  createProject: vi.fn(),
  importThreads: vi.fn(),
  refreshScan: vi.fn(),
  waitForProject: vi.fn(),
  addToast: vi.fn(),
  onOpenChange: vi.fn(),
}));

vi.mock(import("@t3tools/client-runtime/state/session"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    createEnvironmentSessionAtoms: ((runtime: never) => ({
      ...actual.createEnvironmentSessionAtoms(runtime),
      sessionStateAtom: () => state.session,
    })) as never,
  };
});
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({ environments: [] })) as never,
}));
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  readProjects: (() => appAtomRegistry.get(state.projects as Atom.Atom<Project[]>)) as never,
  waitForProject: ((ref: unknown) => state.waitForProject(ref)) as never,
}));
vi.mock(import("../../state/projects"), async (original) => ({
  ...(await original()),
  projectEnvironment: { create: "createProject" } as never,
}));
vi.mock(import("../../state/agentSessions"), async (original) => ({
  ...(await original()),
  agentSessionImport: "importThreads" as never,
}));
vi.mock(import("../../onboarding/useProjectScans"), async (original) => ({
  ...(await original()),
  useProjectScans: (ids: readonly EnvironmentId[]) =>
    ids.map((environmentId) => ({
      environmentId,
      data: { candidates: state.candidates, truncated: false } as never,
      isPending: false,
      error: null,
      refresh: state.refreshScan,
    })),
}));
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: "createProject" | "importThreads") => state[command]) as never,
}));
vi.mock(import("../ui/toast"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    toastManager: { ...actual.toastManager, add: state.addToast } as never,
  };
});

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { AgentSessionImportDialog } from "./AgentSessionImportDialog";

const primaryId = EnvironmentId.make("primary");
const existingProjectId = ProjectId.make("existing");

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function button(label: string) {
  const found = [...document.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === label,
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

async function mountDialog() {
  await using stack = new AsyncDisposableStack();
  const screen = stack.use(
    await render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <AgentSessionImportDialog
          open
          onOpenChange={state.onOpenChange}
          environmentIds={[primaryId]}
        />
      </RegistryContext.Provider>,
    ),
  );
  expect(document.body.textContent).toContain("Import your projects");
  stack.move();
  return screen;
}

// The mocked modules read `state`, so every test starts by replacing all of it.
function setup() {
  const session: AuthSessionState = {
    authenticated: true,
    scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
    auth: {
      policy: "remote-reachable",
      bootstrapMethods: ["one-time-token"],
      sessionMethods: ["bearer-access-token"],
      sessionCookieName: "t3_session",
    },
  };
  state.session = Atom.make<SessionResult>(AsyncResult.success(session)).pipe(Atom.keepAlive);
  state.projects = Atom.make<ReadonlyArray<Project>>([
    { id: existingProjectId, environmentId: primaryId, workspaceRoot: "/projects/existing" },
  ]).pipe(Atom.keepAlive);
  // After onboarding the scan reports projects T3 Code already has, with their IDs.
  state.candidates = [
    {
      path: "/projects/existing",
      title: "existing",
      projectId: existingProjectId,
      sources: ["claudeAgent", "codex"],
      threadCount: 12,
      lastActiveAt: "2026-01-01T00:00:00.000Z",
      alreadyImported: true,
    },
  ];
  state.createProject.mockReset();
  state.importThreads
    .mockReset()
    .mockResolvedValue(AsyncResult.success({ importedCount: 2, skippedCount: 0 }));
  state.refreshScan.mockReset();
  state.waitForProject.mockReset().mockResolvedValue(undefined);
  state.addToast.mockReset();
  state.onOpenChange.mockReset();
}

it("imports new history into a project that already exists", async () => {
  setup();
  await using _screen = await mountDialog();
  await act(async () => button("Select all").click());
  await act(async () => button("Import 1 project").click());

  expect(state.createProject).not.toHaveBeenCalled();
  expect(state.importThreads).toHaveBeenCalledExactlyOnceWith({
    environmentId: primaryId,
    input: { projectId: existingProjectId, expectedWorkspaceRoot: "/projects/existing" },
  });
  expect(state.waitForProject).not.toHaveBeenCalled();
  expect(state.onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
  expect(state.addToast).toHaveBeenCalledExactlyOnceWith({
    type: "success",
    title: "2 threads are in T3 Code",
  });
});

it("stays open until a running import finishes", async () => {
  setup();
  const imported = deferred<{ importedCount: number; skippedCount: number }>();
  state.importThreads.mockImplementationOnce(async () =>
    AsyncResult.success(await imported.promise),
  );
  await using _screen = await mountDialog();
  await act(async () => button("Select all").click());
  await act(async () => button("Import 1 project").click());
  await userEvent.keyboard("{Escape}");
  expect(state.onOpenChange).not.toHaveBeenCalled();

  await act(async () => {
    imported.resolve({ importedCount: 0, skippedCount: 0 });
    await imported.promise;
  });
  expect(state.onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
  expect(state.addToast).not.toHaveBeenCalled();
});

it("rescans when it opens with a result from an earlier scan", async () => {
  setup();
  await using _screen = await mountDialog();
  expect(state.refreshScan).toHaveBeenCalledOnce();
});
