import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

const varint = (value: number): number[] => {
  const bytes: number[] = [];
  let rest = value;
  do {
    const byte = rest % 128;
    rest = Math.floor(rest / 128);
    bytes.push(byte + (rest > 0 ? 128 : 0));
  } while (rest > 0);
  return bytes;
};

export const protoNumber = (field: number, value: number): number[] => [
  ...varint(field * 8),
  ...varint(value),
];

export const protoBytes = (field: number, bytes: ReadonlyArray<number>): number[] => [
  ...varint(field * 8 + 2),
  ...varint(bytes.length),
  ...bytes,
];

export const protoText = (field: number, value: string): number[] =>
  protoBytes(field, [...Buffer.from(value)]);

const protoTimestamp = (field: number, ms: number) =>
  protoBytes(field, [
    ...protoNumber(1, Math.floor(ms / 1000)),
    ...protoNumber(2, (ms % 1000) * 1e6),
  ]);

const STEP_USER_INPUT = 14;
const STEP_PLANNER_RESPONSE = 15;
const STEP_GENERIC_TOOL = 132;
const STATUS_DONE = 3;
const STATUS_ERROR = 7;

export interface SeedStep {
  readonly stepType: number;
  readonly status: number;
  readonly payload: Uint8Array | null;
  readonly metadata: Uint8Array | null;
}

/** CortexStepMetadata: created_at, a tool call when there is one, then the completed times. */
const stepMetadata = (createdAtMs: number, toolCall: ReadonlyArray<number> = []) => [
  ...protoTimestamp(1, createdAtMs),
  ...(toolCall.length === 0 ? [] : protoBytes(4, toolCall)),
  ...protoTimestamp(6, createdAtMs + 100),
  ...protoTimestamp(7, createdAtMs + 200),
  ...protoTimestamp(8, createdAtMs + 300),
];

const toolCall = (id: string, name: string, args: unknown) => [
  ...protoText(1, id),
  ...protoText(2, name),
  ...protoText(3, JSON.stringify(args)),
];

/** A Step row: type, status and metadata in the payload, as written beside the metadata column. */
const step = (
  stepType: number,
  status: number,
  createdAtMs: number,
  body: ReadonlyArray<number>,
  metadataToolCall?: ReadonlyArray<number>,
): SeedStep => {
  const metadata = stepMetadata(createdAtMs, metadataToolCall);
  return {
    stepType,
    status,
    payload: new Uint8Array([
      ...protoNumber(1, stepType),
      ...protoNumber(4, status),
      ...protoBytes(5, metadata),
      ...body,
    ]),
    metadata: new Uint8Array(metadata),
  };
};

/**
 * User input as the standalone CLI writes it: the typed text in field 2 and the same text as
 * items in field 3, with no query in field 1.
 */
export const userStep = (
  createdAtMs: number,
  input: {
    readonly text?: string;
    readonly query?: string;
    readonly items?: ReadonlyArray<string>;
  },
): SeedStep =>
  step(
    STEP_USER_INPUT,
    STATUS_DONE,
    createdAtMs,
    protoBytes(19, [
      ...(input.query === undefined ? [] : protoText(1, input.query)),
      ...(input.text === undefined ? [] : protoText(2, input.text)),
      ...(input.items ?? (input.text === undefined ? [] : [input.text])).flatMap((item) =>
        protoBytes(3, protoText(1, item)),
      ),
    ]),
  );

export const plannerStep = (
  createdAtMs: number,
  input: {
    readonly reply?: string;
    readonly modifiedReply?: string;
    readonly thinking?: string;
    readonly toolCalls?: ReadonlyArray<string>;
  },
): SeedStep =>
  step(
    STEP_PLANNER_RESPONSE,
    STATUS_DONE,
    createdAtMs,
    protoBytes(20, [
      ...(input.reply === undefined ? [] : protoText(1, input.reply)),
      ...(input.thinking === undefined ? [] : protoText(3, input.thinking)),
      ...(input.toolCalls ?? []).flatMap((name, index) =>
        protoBytes(7, toolCall(`call-${index}`, name, { path: "README.md" })),
      ),
      ...(input.modifiedReply === undefined ? [] : protoText(8, input.modifiedReply)),
    ]),
  );

/** A generic tool step carries no message text; its call sits in the metadata. */
export const toolStep = (createdAtMs: number, input: { readonly denied?: boolean } = {}) =>
  step(
    STEP_GENERIC_TOOL,
    input.denied === true ? STATUS_ERROR : STATUS_DONE,
    createdAtMs,
    [],
    toolCall("call-tool", "run_command", { command: "ls" }),
  );

export const trajectoryMetadata = (input: {
  readonly createdAtMs: number;
  readonly workspaceUris?: ReadonlyArray<string>;
  readonly workspaceFolders?: ReadonlyArray<string>;
  readonly parentConversationId?: string;
  readonly nestingDepth?: number;
}) =>
  new Uint8Array([
    ...(input.workspaceFolders ?? []).flatMap((uri) => protoBytes(1, protoText(1, uri))),
    ...protoTimestamp(2, input.createdAtMs),
    ...(input.parentConversationId === undefined ? [] : protoText(5, input.parentConversationId)),
    ...(input.workspaceUris ?? []).flatMap((uri) => protoText(7, uri)),
    ...(input.nestingDepth === undefined ? [] : protoNumber(17, input.nestingDepth)),
    ...protoText(18, "project-1"),
  ]);

/** The gorm schema of a conversation database, verbatim. */
const CONVERSATION_SCHEMA = [
  "CREATE TABLE `steps` (`idx` integer,`step_type` integer NOT NULL DEFAULT 0,`status` integer NOT NULL DEFAULT 0,`has_subtrajectory` numeric NOT NULL DEFAULT false,`metadata` blob,`error_details` blob,`permissions` blob,`task_details` blob,`render_info` blob,`step_payload` blob,`step_format` integer NOT NULL DEFAULT 0,PRIMARY KEY (`idx`))",
  "CREATE INDEX `idx_steps_status` ON `steps`(`status`)",
  "CREATE INDEX `idx_steps_step_type` ON `steps`(`step_type`)",
  'CREATE TABLE `trajectory_metadata_blob` (`id` text DEFAULT "main",`data` blob,PRIMARY KEY (`id`))',
  "CREATE TABLE `trajectory_meta` (`trajectory_id` text,`cascade_id` text,`trajectory_type` integer,`source` integer,PRIMARY KEY (`trajectory_id`))",
  "CREATE TABLE `gen_metadata` (`idx` integer,`data` blob,`size` integer NOT NULL DEFAULT 0,PRIMARY KEY (`idx`))",
  "CREATE TABLE `executor_metadata` (`idx` integer,`data` blob,PRIMARY KEY (`idx`))",
  "CREATE TABLE `parent_references` (`idx` integer,`data` blob,PRIMARY KEY (`idx`))",
  "CREATE TABLE `battle_mode_infos` (`idx` integer,`data` blob,PRIMARY KEY (`idx`))",
];

/** A writer connection that stays open for the caller's scope, like a running Antigravity client. */
export const openConversationWriter = (filename: string) =>
  Layer.build(NodeSqliteClient.layer({ filename })).pipe(
    Effect.map((context) => Context.get(context, SqlClient.SqlClient)),
  );

export const appendSteps = Effect.fn("AntigravityConversations.testkit.appendSteps")(function* (
  sql: SqlClient.SqlClient,
  firstIdx: number,
  steps: ReadonlyArray<SeedStep>,
) {
  for (const [offset, seeded] of steps.entries()) {
    yield* sql.unsafe(
      "INSERT INTO `steps` (`idx`, `step_type`, `status`, `metadata`, `step_payload`, `step_format`) VALUES (?, ?, ?, ?, ?, 0)",
      [firstIdx + offset, seeded.stepType, seeded.status, seeded.metadata, seeded.payload],
    );
  }
});

/** The CLI leaves its file in rollback journal mode; ACP clients may use WAL. */
export const seedConversation = Effect.fn("AntigravityConversations.testkit.seedConversation")(
  function* (
    filename: string,
    input: {
      readonly steps: ReadonlyArray<SeedStep>;
      readonly trajectory?: Uint8Array;
      readonly journalMode?: "delete" | "wal";
    },
  ) {
    const sql = yield* openConversationWriter(filename);
    yield* sql.unsafe(`PRAGMA journal_mode = ${input.journalMode ?? "delete"}`);
    for (const statement of CONVERSATION_SCHEMA) yield* sql.unsafe(statement);
    if (input.trajectory !== undefined) {
      yield* sql.unsafe("INSERT INTO `trajectory_metadata_blob` (`data`) VALUES (?)", [
        input.trajectory,
      ]);
    }
    yield* appendSteps(sql, 0, input.steps);
  },
  Effect.scoped,
);
