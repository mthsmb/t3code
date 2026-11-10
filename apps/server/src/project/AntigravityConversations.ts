// @effect-diagnostics nodeBuiltinImport:off - SQLite names an immutable open by file URL, and workspaces are file URLs.
import * as NodeURL from "node:url";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import {
  bytesAt,
  fields,
  lenientText,
  lenientTextAt,
  nested,
  numberAt,
  timestamp,
  type Fields,
} from "../provider/Drivers/antigravityProtobuf.ts";

const STEP_TYPE_USER_INPUT = 14;
const STEP_TYPE_PLANNER_RESPONSE = 15;
const STEP_METADATA = 5;
const STEP_USER_INPUT = 19;
const STEP_PLANNER_RESPONSE = 20;
const USER_INPUT_QUERY = 1;
const USER_INPUT_TEXT = 2;
const USER_INPUT_ITEMS = 3;
const USER_INPUT_ITEM_TEXT = 1;
const PLANNER_RESPONSE_TEXT = 1;
const PLANNER_MODIFIED_RESPONSE_TEXT = 8;
const METADATA_CREATED_AT = 1;
const TRAJECTORY_WORKSPACES = 1;
const WORKSPACE_FOLDER_URI = 1;
const TRAJECTORY_CREATED_AT = 2;
const TRAJECTORY_PARENT_CONVERSATION_ID = 5;
const TRAJECTORY_WORKSPACE_URIS = 7;
const TRAJECTORY_NESTING_DEPTH = 17;

const STEP_PAGE_ROWS = 16;
const MAX_STEP_BYTES = 1024 * 1024;
const MAX_TRAJECTORY_BYTES = 64 * 1024;
const MAX_META_BYTES = 64 * 1024;
const BUSY_TIMEOUT_MS = 100;

/** Data roots each Antigravity app writes under `~/.gemini`. */
const DEFAULT_DATA_ROOTS = ["antigravity-cli", "antigravity", "antigravity-ide", "antigravity-acp"];

const MESSAGE_STEP = `step_type IN (${STEP_TYPE_USER_INPUT}, ${STEP_TYPE_PLANNER_RESPONSE})`;

/**
 * Only protobuf user input and planner rows load a payload. Tool rows, often the bulk of a
 * conversation, still count toward the record limit without being loaded, and an oversized
 * message row is only flagged.
 */
const STEP_PAGE_QUERY = `SELECT rowid AS row_id,
  CASE WHEN ${MESSAGE_STEP} AND step_format = 0
    AND length(step_payload) <= ${MAX_STEP_BYTES} THEN step_payload END AS payload,
  ${MESSAGE_STEP} AND step_format = 0 AND length(step_payload) > ${MAX_STEP_BYTES} AS oversized,
  CASE WHEN ${MESSAGE_STEP} AND length(metadata) <= ${MAX_STEP_BYTES} THEN metadata END AS metadata
  FROM steps WHERE rowid > ? ORDER BY rowid LIMIT ?`;

interface AntigravityStepMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly createdAtMs: number | null;
}

interface AntigravityTrajectoryMetadata {
  readonly workspaceUris: ReadonlyArray<string>;
  readonly parentConversationId: string;
  readonly nestingDepth: number;
  readonly createdAtMs: number | null;
}

export interface AntigravityTranscript {
  readonly messages: ReadonlyArray<AntigravityStepMessage>;
  readonly cwd: string | null;
  readonly createdAtMs: number | null;
  /** User and planner steps too large to load, which may have held visible text. */
  readonly omittedMessageCount: number;
}

interface AntigravityConversationCwd {
  readonly cwd: string | null;
  /** Trajectory and `.meta` bytes loaded to find the cwd. */
  readonly bytesRead: number;
}

/** Date rejects times past 8.64e15 ms, and a corrupt row must not throw out of the scan. */
const MAX_DATE_MS = 8.64e15;
const validTimeMs = (ms: number | null) => (ms !== null && ms <= MAX_DATE_MS ? ms : null);

const createdAtOf = (metadata: Uint8Array | null | undefined) => {
  if (metadata === null || metadata === undefined) return null;
  try {
    return validTimeMs(timestamp(nested(fields(metadata), METADATA_CREATED_AT)));
  } catch {
    return null;
  }
};

/**
 * Antigravity replays a user turn from its user response (field 2), which the CLI writes without
 * a query (field 1). Items hold the input in chunks, so they are joined as written.
 */
function userInputText(input: Fields): string {
  const text = lenientTextAt(input, USER_INPUT_TEXT) || lenientTextAt(input, USER_INPUT_QUERY);
  if (text.length > 0) return text;
  return (input.get(USER_INPUT_ITEMS) ?? [])
    .map((item) => {
      const chunk =
        item instanceof Uint8Array ? bytesAt(fields(item), USER_INPUT_ITEM_TEXT) : undefined;
      return chunk === undefined ? "" : lenientText(chunk);
    })
    .join("")
    .trim();
}

/** A planner's modified response replaces its original one, as Antigravity shows it. */
const plannerResponseText = (response: Fields) =>
  lenientTextAt(response, PLANNER_MODIFIED_RESPONSE_TEXT) ||
  lenientTextAt(response, PLANNER_RESPONSE_TEXT);

/** One step's visible message; null for tool steps, thinking or tool-only replies, and bad bytes. */
export function decodeAntigravityStep(
  payload: Uint8Array,
  metadata: Uint8Array | null = null,
): AntigravityStepMessage | null {
  try {
    const step = fields(payload);
    const userInput = bytesAt(step, STEP_USER_INPUT);
    const plannerResponse = bytesAt(step, STEP_PLANNER_RESPONSE);
    const text =
      userInput !== undefined
        ? userInputText(fields(userInput))
        : plannerResponse !== undefined
          ? plannerResponseText(fields(plannerResponse))
          : "";
    if (text.length === 0) return null;
    return {
      role: userInput === undefined ? "assistant" : "user",
      text,
      createdAtMs: createdAtOf(metadata) ?? createdAtOf(bytesAt(step, STEP_METADATA)),
    };
  } catch {
    return null;
  }
}

const textsAt = (message: Fields, field: number) =>
  (message.get(field) ?? []).map((value) =>
    value instanceof Uint8Array ? lenientText(value).trim() : "",
  );

/** Workspace URIs list the cwd first; older trajectories may only name workspace folders. */
export function decodeAntigravityTrajectoryMetadata(
  bytes: Uint8Array,
): AntigravityTrajectoryMetadata | null {
  try {
    const root = fields(bytes);
    return {
      workspaceUris: root.has(TRAJECTORY_WORKSPACE_URIS)
        ? textsAt(root, TRAJECTORY_WORKSPACE_URIS)
        : (root.get(TRAJECTORY_WORKSPACES) ?? []).map((workspace) =>
            workspace instanceof Uint8Array
              ? lenientTextAt(fields(workspace), WORKSPACE_FOLDER_URI)
              : "",
          ),
      parentConversationId: lenientTextAt(root, TRAJECTORY_PARENT_CONVERSATION_ID),
      nestingDepth: numberAt(root, TRAJECTORY_NESTING_DEPTH),
      createdAtMs: validTimeMs(timestamp(nested(root, TRAJECTORY_CREATED_AT))),
    };
  } catch {
    return null;
  }
}

/** Windows workspace URIs look like `file:///C:/...` or `file:///c%3A/...`. */
export function antigravityWorkspaceUriToPath(uri: string, windows: boolean): string | null {
  if (!uri.startsWith("file:")) return null;
  try {
    return NodeURL.fileURLToPath(uri, { windows });
  } catch {
    return null;
  }
}

/**
 * Conversation directories for one instance's environment. `ANTIGRAVITY_DATA_DIR` lists roots
 * separated by commas, and a configured root may itself be the conversations directory.
 */
export const antigravityConversationDirectories = Effect.fn(
  "AntigravityConversations.conversationDirectories",
)(function* (environment: NodeJS.ProcessEnv, homeDir: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configured = (environment["ANTIGRAVITY_DATA_DIR"] ?? "")
    .split(",")
    .map((root) => root.trim())
    .filter((root) => root.length > 0);
  const candidates =
    configured.length > 0
      ? configured.map((root) => {
          const resolved = path.resolve(expandHomePath(root, homeDir));
          return [path.join(resolved, "conversations"), resolved];
        })
      : DEFAULT_DATA_ROOTS.map((name) => [path.join(homeDir, ".gemini", name, "conversations")]);
  const directories: Array<string> = [];
  for (const choices of candidates) {
    for (const directory of choices) {
      const stats = yield* fileSystem.stat(directory).pipe(Effect.option);
      if (Option.isSome(stats) && stats.value.type === "Directory") {
        directories.push(directory);
        break;
      }
    }
  }
  return directories;
});

const decodeMeta = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ cwd: Schema.optional(Schema.String) })),
);

/**
 * ACP clients record the session's cwd in a `<id>.meta` file beside the database. Untraced, like
 * the helpers below, because it runs inside a read's span once per conversation.
 */
const readMetaCwd = Effect.fnUntraced(function* (dbPath: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const metaPath = path.join(path.dirname(dbPath), `${path.basename(dbPath, ".db")}.meta`);
  const contents = yield* fileSystem.stat(metaPath).pipe(
    Effect.flatMap((info) =>
      Number(info.size) > MAX_META_BYTES
        ? Effect.succeed(null)
        : fileSystem.readFileString(metaPath),
    ),
    Effect.orElseSucceed(() => null),
  );
  const cwd =
    contents === null ? undefined : Option.getOrUndefined(decodeMeta(contents))?.cwd?.trim();
  return {
    cwd: cwd === undefined || cwd.length === 0 ? null : cwd,
    bytesRead: contents === null ? 0 : Buffer.byteLength(contents),
  } satisfies AntigravityConversationCwd;
});

/**
 * Subagent conversations belong to their parent. The first workspace URI is the cwd; later ones
 * are extra directories such as skill roots, and a conversation run without a workspace has none.
 */
const conversationCwd = Effect.fnUntraced(function* (
  dbPath: string,
  trajectory: AntigravityTrajectoryMetadata | null,
) {
  if (
    trajectory !== null &&
    (trajectory.parentConversationId.length > 0 || trajectory.nestingDepth > 0)
  ) {
    return { cwd: null, bytesRead: 0 } satisfies AntigravityConversationCwd;
  }
  const meta = yield* readMetaCwd(dbPath);
  const workspaceUri = trajectory?.workspaceUris[0];
  if (meta.cwd !== null || workspaceUri === undefined) return meta;
  return {
    cwd: antigravityWorkspaceUriToPath(workspaceUri, (yield* HostProcess.Platform) === "win32"),
    bytesRead: meta.bytesRead,
  } satisfies AntigravityConversationCwd;
});

/**
 * A plain read-only open creates -wal and -shm beside a WAL database, so files at rest open
 * immutable. A live WAL writer's -shm is mapped read-only and a rollback journal is read through
 * its locks, since an active writer could tear an immutable read. A writer closing between this
 * check and the open can still leave an empty -wal, which holds no steps.
 */
const databaseFilename = Effect.fnUntraced(function* (dbPath: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const exists = (file: string) => fileSystem.exists(file).pipe(Effect.orElseSucceed(() => false));
  const walBytes = yield* fileSystem.stat(`${dbPath}-wal`).pipe(
    Effect.map((info) => Number(info.size)),
    Effect.orElseSucceed(() => 0),
  );
  const url = NodeURL.pathToFileURL(dbPath).href;
  if (walBytes > 0 && (yield* exists(`${dbPath}-shm`))) return `${url}?mode=ro&readonly_shm=1`;
  if (yield* exists(`${dbPath}-journal`)) return dbPath;
  return `${url}?immutable=1`;
});

const withDatabase = Effect.fnUntraced(function* <A, E, R>(
  dbPath: string,
  read: Effect.Effect<A, E, R>,
) {
  const filename = yield* databaseFilename(dbPath);
  return yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    return yield* read;
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename, readonly: true })));
});

const readTrajectoryBlob = Effect.fnUntraced(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql
    .unsafe<{ readonly data: unknown }>(
      `SELECT CASE WHEN length(data) <= ${MAX_TRAJECTORY_BYTES} THEN data END AS data FROM trajectory_metadata_blob LIMIT 1`,
    )
    .pipe(Effect.orElseSucceed(() => []));
  const data = rows[0]?.data;
  return data instanceof Uint8Array ? data : null;
});

const decodeTrajectory = (blob: Uint8Array | null) =>
  blob === null ? null : decodeAntigravityTrajectoryMetadata(blob);

/** Never fails: an unreadable database falls back to the `.meta` cwd, if any. */
export const readAntigravityConversationCwd = Effect.fn("AntigravityConversations.readCwd")(
  function* (dbPath: string) {
    const blob = yield* withDatabase(dbPath, readTrajectoryBlob()).pipe(
      Effect.orElseSucceed(() => null),
    );
    const found = yield* conversationCwd(dbPath, decodeTrajectory(blob));
    return {
      cwd: found.cwd,
      bytesRead: (blob?.byteLength ?? 0) + found.bytesRead,
    } satisfies AntigravityConversationCwd;
  },
);

/**
 * Null on any SQLite or decode failure, or past a limit. Each page is its own statement, so a
 * rollback journal writer is never locked out for the whole read.
 */
export const readAntigravityTranscript = Effect.fn("AntigravityConversations.readTranscript")(
  function* (
    dbPath: string,
    limits: { readonly recordLimit: number; readonly maxHistoryBytes: number },
  ) {
    return yield* withDatabase(
      dbPath,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const trajectory = decodeTrajectory(yield* readTrajectoryBlob());
        const messages: Array<AntigravityStepMessage> = [];
        let omittedMessageCount = 0;
        let recordCount = 0;
        let historyBytes = 0;
        let after = Number.MIN_SAFE_INTEGER;
        while (true) {
          const rows = yield* sql
            .unsafe<{
              readonly row_id: unknown;
              readonly payload: unknown;
              readonly oversized: unknown;
              readonly metadata: unknown;
            }>(STEP_PAGE_QUERY, [after, STEP_PAGE_ROWS])
            .pipe(Effect.withTracerEnabled(false));
          for (const row of rows) {
            recordCount += 1;
            if (recordCount > limits.recordLimit) return null;
            if (row.oversized === 1) omittedMessageCount += 1;
            if (!(row.payload instanceof Uint8Array)) continue;
            const message = decodeAntigravityStep(
              row.payload,
              row.metadata instanceof Uint8Array ? row.metadata : null,
            );
            if (message === null) continue;
            historyBytes += Buffer.byteLength(message.text);
            if (historyBytes > limits.maxHistoryBytes) return null;
            messages.push(message);
          }
          if (rows.length < STEP_PAGE_ROWS) break;
          const last = rows.at(-1)?.row_id;
          if (typeof last !== "number") return null;
          after = last;
          yield* Effect.yieldNow;
        }
        return {
          messages,
          cwd: (yield* conversationCwd(dbPath, trajectory)).cwd,
          createdAtMs: trajectory?.createdAtMs ?? null,
          omittedMessageCount,
        } satisfies AntigravityTranscript;
      }),
    ).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not read Antigravity conversation", { dbPath, cause }).pipe(
          Effect.as(null),
        ),
      ),
    );
  },
);
