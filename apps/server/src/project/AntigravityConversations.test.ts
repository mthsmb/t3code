// @effect-diagnostics nodeBuiltinImport:off - workspace URIs are built the way Antigravity writes them.
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as SqlClient from "effect/sql/SqlClient";

import {
  antigravityWorkspaceUriToPath,
  decodeAntigravityStep,
  decodeAntigravityTrajectoryMetadata,
  readAntigravityConversationCwd,
  readAntigravityTranscript,
} from "./AntigravityConversations.ts";
import {
  appendSteps,
  openConversationWriter,
  plannerStep,
  protoBytes,
  protoNumber,
  protoText,
  seedConversation,
  toolStep,
  trajectoryMetadata,
  userStep,
  type SeedStep,
} from "./AntigravityConversations.testkit.ts";

const T0 = Date.parse("2026-08-20T09:00:00.000Z");
const limits = { recordLimit: 100, maxHistoryBytes: 1024 * 1024 };

const decode = (step: SeedStep) => decodeAntigravityStep(step.payload!, step.metadata);

describe("decodeAntigravityStep", () => {
  it.each([
    {
      name: "the CLI's typed text, which repeats as items",
      step: userStep(T0, { text: "  Fix the build \n" }),
      expected: { role: "user", text: "Fix the build", createdAtMs: T0 },
    },
    {
      name: "a query without typed text",
      step: userStep(T0, { query: "Fix the build" }),
      expected: { role: "user", text: "Fix the build", createdAtMs: T0 },
    },
    {
      name: "items alone, joined as one text",
      step: userStep(T0, { items: ["Fix ", "the build "] }),
      expected: { role: "user", text: "Fix the build", createdAtMs: T0 },
    },
    {
      name: "a planner reply beside its thinking and tool calls",
      step: plannerStep(T0, { reply: "Done", thinking: "Check the logs", toolCalls: ["view"] }),
      expected: { role: "assistant", text: "Done", createdAtMs: T0 },
    },
    {
      name: "a modified reply in place of the original one",
      step: plannerStep(T0, { reply: "Draft", modifiedReply: "Final" }),
      expected: { role: "assistant", text: "Final", createdAtMs: T0 },
    },
    {
      name: "text with invalid UTF-8",
      step: {
        stepType: 14,
        status: 3,
        payload: new Uint8Array(protoBytes(19, protoBytes(2, [0x68, 0xff, 0x69]))),
        metadata: null,
      },
      expected: { role: "user", text: "h\uFFFDi", createdAtMs: null },
    },
  ])("reads $name", ({ step, expected }) => {
    expect(decode(step)).toEqual(expected);
  });

  it("skips steps with no visible text and malformed bytes", () => {
    expect(decode(plannerStep(T0, { thinking: "Plan", toolCalls: ["view", "edit"] }))).toBeNull();
    expect(decode(toolStep(T0))).toBeNull();
    expect(decode(toolStep(T0, { denied: true }))).toBeNull();
    expect(decode(userStep(T0, { text: "   " }))).toBeNull();
    expect(decodeAntigravityStep(new Uint8Array([0x9a, 0x01, 0x05, 0x0a]))).toBeNull();
    expect(decodeAntigravityStep(new Uint8Array([0xff, 0xff, 0xff]))).toBeNull();
    expect(decodeAntigravityStep(new Uint8Array())).toBeNull();
  });
});

describe("decodeAntigravityTrajectoryMetadata", () => {
  it("reads workspace URIs in order, the parent conversation, nesting, and creation time", () => {
    expect(
      decodeAntigravityTrajectoryMetadata(
        trajectoryMetadata({
          createdAtMs: T0 + 250,
          workspaceUris: ["file:///work/project", "file:///work/skills"],
          parentConversationId: "parent-1",
          nestingDepth: 1,
        }),
      ),
    ).toEqual({
      workspaceUris: ["file:///work/project", "file:///work/skills"],
      parentConversationId: "parent-1",
      nestingDepth: 1,
      createdAtMs: T0 + 250,
    });
    expect(
      decodeAntigravityTrajectoryMetadata(
        new Uint8Array([...protoText(18, "project-1"), ...protoNumber(17, 0)]),
      ),
    ).toEqual({ workspaceUris: [], parentConversationId: "", nestingDepth: 0, createdAtMs: null });
    expect(
      decodeAntigravityTrajectoryMetadata(
        trajectoryMetadata({ createdAtMs: T0, workspaceFolders: ["file:///work/folder"] }),
      )?.workspaceUris,
    ).toEqual(["file:///work/folder"]);
    expect(decodeAntigravityTrajectoryMetadata(new Uint8Array([0x3a, 0x7f]))).toBeNull();
  });
});

describe("antigravityWorkspaceUriToPath", () => {
  it.each([
    ["file:///C:/Users/dev/project", true, "C:\\Users\\dev\\project"],
    ["file:///c%3A/Users/dev/project", true, "c:\\Users\\dev\\project"],
    ["file://fileserver/share/project", true, "\\\\fileserver\\share\\project"],
    ["file:///home/dev/my%20project", false, "/home/dev/my project"],
    ["file:///home/dev/a%2Fb", false, null],
    ["vscode-remote://ssh-remote/home/dev/project", false, null],
    ["not a uri", false, null],
  ] as const)("%s (windows: %s)", (uri, windows, expected) => {
    expect(antigravityWorkspaceUriToPath(uri, windows)).toBe(expected);
  });
});

const FIRST = { role: "user", text: "First", createdAtMs: T0 + 1000 } as const;
const SECOND = { role: "assistant", text: "Second", createdAtMs: T0 + 5000 } as const;
const THIRD = { role: "assistant", text: "Third", createdAtMs: T0 + 6000 } as const;

const committedSteps = [
  userStep(FIRST.createdAtMs, { text: FIRST.text }),
  toolStep(T0 + 2000),
  toolStep(T0 + 3000, { denied: true }),
  plannerStep(T0 + 4000, { thinking: "Plan", toolCalls: ["view"] }),
  plannerStep(SECOND.createdAtMs, { reply: SECOND.text }),
];

const appendThird = (writer: SqlClient.SqlClient) =>
  appendSteps(writer, committedSteps.length, [
    plannerStep(THIRD.createdAtMs, { reply: THIRD.text }),
  ]);

/** A running ACP client: its uncheckpointed step sits in a WAL beside its -shm. */
const holdLiveWalWriter = Effect.fn("AntigravityConversations.test.holdLiveWalWriter")(function* (
  dbPath: string,
) {
  const writer = yield* openConversationWriter(dbPath);
  yield* writer.unsafe("PRAGMA wal_autocheckpoint = 0");
  yield* appendThird(writer);
});

/** A copy or sync tool can bring a WAL without the -shm a reader would need to map. */
const leaveWalWithoutShm = Effect.fn("AntigravityConversations.test.leaveWalWithoutShm")(function* (
  dbPath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const source = path.join(
    yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-antigravity-source-" }),
    path.basename(dbPath),
  );
  yield* fileSystem.copyFile(dbPath, source);
  yield* holdLiveWalWriter(source);
  yield* fileSystem.copyFile(`${source}-wal`, `${dbPath}-wal`);
});

/** The CLI mid-turn: a reserved lock and a -journal holding the original pages. */
const holdRollbackJournalWriter = Effect.fn(
  "AntigravityConversations.test.holdRollbackJournalWriter",
)(function* (dbPath: string) {
  const writer = yield* openConversationWriter(dbPath);
  yield* writer.unsafe("BEGIN IMMEDIATE");
  yield* appendThird(writer);
});

it.layer(NodeServices.layer)("reading conversation databases", (it) => {
  const makeConversation = Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-antigravity-" });
    const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-workspace-" });
    const fileName = "0f6a52d2-93a0-4b0e-9d3b-6a5b8c1e2f10.db";
    return {
      directory,
      workspace,
      fileName,
      dbPath: path.join(directory, fileName),
      trajectory: trajectoryMetadata({
        createdAtMs: T0,
        workspaceUris: [NodeURL.pathToFileURL(workspace).href, "file:///skills"],
      }),
    };
  });

  it.effect.each([
    {
      name: "a rollback journal database at rest",
      journalMode: "delete",
      prepare: (_dbPath: string) => Effect.void,
      siblings: [""],
      messages: [FIRST, SECOND],
    },
    {
      name: "a WAL database at rest",
      journalMode: "wal",
      prepare: (_dbPath: string) => Effect.void,
      siblings: [""],
      messages: [FIRST, SECOND],
    },
    {
      name: "the checkpointed steps of a non-empty WAL without -shm",
      journalMode: "wal",
      prepare: leaveWalWithoutShm,
      siblings: ["", "-wal"],
      messages: [FIRST, SECOND],
    },
    {
      name: "the uncheckpointed steps of a live WAL writer holding -shm",
      journalMode: "wal",
      prepare: holdLiveWalWriter,
      siblings: ["", "-shm", "-wal"],
      messages: [FIRST, SECOND, THIRD],
    },
    {
      name: "the committed steps under an active rollback journal writer",
      journalMode: "delete",
      prepare: holdRollbackJournalWriter,
      siblings: ["", "-journal"],
      messages: [FIRST, SECOND],
    },
  ] as const)("reads $name without writing beside it", (row) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const { directory, workspace, fileName, dbPath, trajectory } = yield* makeConversation;
      yield* seedConversation(dbPath, {
        journalMode: row.journalMode,
        trajectory,
        steps: committedSteps,
      });
      yield* row.prepare(dbPath);
      const files = () =>
        fileSystem.readDirectory(directory).pipe(Effect.map((names) => names.toSorted()));
      expect(yield* files()).toEqual(row.siblings.map((suffix) => `${fileName}${suffix}`));

      expect(yield* readAntigravityTranscript(dbPath, limits)).toEqual({
        messages: row.messages,
        cwd: workspace,
        createdAtMs: T0,
        omittedMessageCount: 0,
      });
      expect((yield* readAntigravityConversationCwd(dbPath)).cwd).toBe(workspace);
      expect(yield* files()).toEqual(row.siblings.map((suffix) => `${fileName}${suffix}`));
    }),
  );

  it.effect("returns null while an exclusive writer locks a rollback journal database", () =>
    Effect.gen(function* () {
      const { dbPath, trajectory } = yield* makeConversation;
      yield* seedConversation(dbPath, { trajectory, steps: committedSteps });
      const writer = yield* openConversationWriter(dbPath);
      yield* writer.unsafe("BEGIN EXCLUSIVE");
      yield* appendThird(writer);

      expect(yield* readAntigravityTranscript(dbPath, limits)).toBeNull();
    }),
  );

  it.effect("reports the trajectory and .meta bytes a cwd read loads", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { directory, workspace, dbPath, trajectory } = yield* makeConversation;
      const metaCwd = path.join(workspace, "acp");
      const meta = JSON.stringify({ cwd: metaCwd });
      const oversizedPath = path.join(directory, "0f6a52d2-93a0-4b0e-9d3b-6a5b8c1e2f11.db");
      yield* seedConversation(dbPath, { trajectory, steps: [] });
      yield* fileSystem.writeFileString(dbPath.replace(/\.db$/, ".meta"), meta);
      yield* seedConversation(oversizedPath, {
        trajectory: trajectoryMetadata({
          createdAtMs: T0,
          workspaceUris: [
            NodeURL.pathToFileURL(workspace).href,
            `file:///${"x".repeat(64 * 1024)}`,
          ],
        }),
        steps: [],
      });

      expect(yield* readAntigravityConversationCwd(dbPath)).toEqual({
        cwd: metaCwd,
        bytesRead: trajectory.byteLength + Buffer.byteLength(meta),
      });
      expect(yield* readAntigravityConversationCwd(oversizedPath)).toEqual({
        cwd: null,
        bytesRead: 0,
      });
    }),
  );

  it.effect(
    "pages through steps, counts oversized messages as omitted, and honors the record and history limits",
    () =>
      Effect.gen(function* () {
        const { dbPath, trajectory } = yield* makeConversation;
        const exchanges = Array.from({ length: 10 }, (_, index) => [
          userStep(T0 + index * 1000, { text: `Ask ${index}` }),
          toolStep(T0 + index * 1000 + 100),
          plannerStep(T0 + index * 1000 + 200, { reply: `Answer ${index}` }),
        ]).flat();
        yield* seedConversation(dbPath, {
          trajectory,
          steps: [
            userStep(T0, { text: "x".repeat(1024 * 1024) }),
            ...exchanges,
            toolStep(T0 + 10_000, { denied: true }),
            plannerStep(T0 + 10_000, { reply: "y".repeat(1024 * 1024) }),
          ],
        });

        const transcript = yield* readAntigravityTranscript(dbPath, { ...limits, recordLimit: 33 });
        expect(transcript?.messages.map((message) => message.text)).toEqual(
          Array.from({ length: 10 }, (_, index) => [`Ask ${index}`, `Answer ${index}`]).flat(),
        );
        expect(transcript?.omittedMessageCount).toBe(2);
        expect(yield* readAntigravityTranscript(dbPath, { ...limits, recordLimit: 32 })).toBeNull();
        expect(
          yield* readAntigravityTranscript(dbPath, { ...limits, maxHistoryBytes: 8 }),
        ).toBeNull();
      }),
  );

  it.effect("returns null for files that are not conversation databases", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const { dbPath, trajectory } = yield* makeConversation;
      const withSchema = (filename: string, statements: ReadonlyArray<string>) =>
        Effect.gen(function* () {
          const sql = yield* openConversationWriter(filename);
          for (const statement of statements) yield* sql.unsafe(statement);
          yield* sql.unsafe("INSERT INTO `trajectory_metadata_blob` (`data`) VALUES (?)", [
            trajectory,
          ]);
        }).pipe(Effect.scoped);
      const blobTable = "CREATE TABLE `trajectory_metadata_blob` (`id` text,`data` blob)";
      yield* withSchema(`${dbPath}.no-steps`, [blobTable]);
      yield* withSchema(`${dbPath}.no-payload`, [
        blobTable,
        "CREATE TABLE `steps` (`idx` integer,`step_type` integer,`metadata` blob,PRIMARY KEY (`idx`))",
      ]);
      yield* fileSystem.writeFileString(dbPath, "not a database");

      for (const target of [dbPath, `${dbPath}.no-steps`, `${dbPath}.no-payload`]) {
        expect(yield* readAntigravityTranscript(target, limits)).toBeNull();
      }
      expect(yield* readAntigravityTranscript(`${dbPath}.missing`, limits)).toBeNull();
    }),
  );
});
