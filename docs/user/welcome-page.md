# Welcome page

T3 Code shows a Welcome page when you open a new installation. Existing
workspaces skip it. It shows what T3 Code found on the computer you are using,
on one page: your agents, projects from your Claude Code, Codex, and Pi history,
and the phone app. Only an agent is needed to start chatting.

To see the page again, go to **Settings → About → Welcome page** and select
**Open**. Direct links, such as Settings, open normally before setup is done.

The hosted app at app.t3.codes does not open the page. With no computer connected,
it asks you to sign in to T3 Connect, then to install T3 Code and run
`t3 connect` on your computer. From home, it adds compatible computers linked to your account and
opens the app. To add more computers later, use **Settings → Environments**.

If T3 Code cannot confirm the workspace during startup, it shows
**Still connecting** instead of opening the app. Select **Reload** to try again.

If T3 Code cannot read your saved settings, it shows **Could not read settings**.
Select **Retry** after storage becomes available. Setup does not replace
unreadable settings with defaults.

## Agents

T3 Code lists the agents it found on the computer first, ready ones on top.
**Add more agents** lists every other agent T3 Code supports, A to Z. When no agent
is found, it reads **Set up an agent** and opens by itself:

- **Turn on** enables an agent that is off on this computer, including one only
  some projects use. T3 Code then checks whether it is installed and signed in.
- For Claude Code, **Install** or **Sign in** opens a terminal with the correct
  command ready to run. Install uses the vendor's own installer, which keeps
  **Update now** working in Settings.
- For Codex, **Set up** offers sign-in with your ChatGPT account or your own
  Codex CLI. **Use existing CLI** opens the terminal to install or sign in, and
  **Continue with ChatGPT** stays available until Codex is signed in.
- When T3 Code knows an installed version does not work with it, **Update** opens
  the agent in **Settings → Providers**, which shows the version to use and updates it
  when it can.
- Other agents, and agents that could not load, open their page in
  **Settings → Providers**.
- **Browse** opens the ACP Registry for more agents.

On the desktop app, when the folder of the `t3` command is not on your `PATH`,
**Add to PATH** adds one line to your shell's startup file.

The setup terminal uses the home directory and environment configured for the
provider instance. Sensitive values remain redacted in Settings and
terminal metadata while the terminal process can use them.

**Start** waits for one ready agent. Select **Start without an agent** to finish
without one. Checked projects are still imported.

## Phone

Select **Set up** and scan the code with your phone. It opens the App Store on an
iPhone and Google Play on Android. Then select **Sign in to T3 Connect** and allow
this computer when T3 Code asks, so the app can reach it. Sign in to the app with
the same account. If you are signed in but this computer is not shared yet, select
**Set up T3 Connect**. If T3 Connect is on but the app cannot reach this computer,
select **Check T3 Connect** to see why. The page leaves the phone out on builds
without T3 Connect, or when your organization turns it off. You can still pair the
app with a code from **Settings → Sharing & access**.

## Projects

T3 Code finds directories that Claude Code, Codex or Pi has used within the
import time window, the last 30 days by default. Git repositories are listed first, newest activity on top. When the remote
is on GitHub, the group shows the repository as `owner/name`. Clones with the
same remote share one group. Directories that are not git repositories sit under
"Other folders".

The page offers git repositories with at least three conversations in that time,
already checked. Projects already in T3 Code are not checked
again. Uncheck the box to start without them, or
select **Review all** to pick from everything found, with "Select all" and
"Select none". Linked worktrees of bare repositories
can be offered as separate projects. Conversations in other linked git worktrees
count toward their main checkout, so a repository is offered even if you only
worked in its worktrees. Codex scratch directories under `Documents/Codex`, and
anything under `Downloads` are not offered.

A large or malformed history can reach the scan limit. T3 Code keeps the
projects it found and warns when projects or conversations may be missing.

To import older history, select **Review all**, then the button labelled with the
time window, such as **Last 30 days**. Turn on **All history** to import
conversations of any age, and **Full history** to keep every message of each
conversation. Changing the time window or the scan budget checks your projects
again, and **Start** waits for that check. While the import box is checked,
turning on **All history** checks every project the new check finds, including
those under "Other folders". When every project found has only older
conversations, the page says how many and shows the same button.

Imported projects include Claude, Codex and Pi conversations active within the
time window. You can continue those conversations in T3 Code. Pi is off by default:
open **Add more agents** and select **Turn on** next to Pi, and the page looks for
its sessions too. Pi sessions
are read from each enabled Pi provider's session directory, which follows
`PI_CODING_AGENT_SESSION_DIR` and `PI_CODING_AGENT_DIR` in its environment. A
Pi conversation imports its active branch, the one Pi reopens.

Conversation import is best effort. T3 Code keeps the first user prompt and the
newest remaining visible user and assistant messages, up to 200 by default.
It omits tool activity and attachments. For Codex, it omits generated setup
context only when a canonical user event and a valid shared turn ID identify the
same user turn. Ambiguous legacy or response-only context stays in the imported
conversation so T3 Code does not remove user text. For Claude, slash commands
and `!` shell commands appear as you typed them; their output, background task
notifications and interruption markers are left out, and a conversation that
only ran commands such as `/clear`, with no reply, is skipped. It reads one
conversation at a time and skips files larger than 4 GiB. It also skips a conversation when the
message text and metadata it keeps need more than 32 MiB of memory. Tool output
does not count toward that limit. It skips a Codex or Pi conversation with more
records than the records limit (100,000 by default). Opening the page again does not
import it unless you raise the limit. It ignores
malformed records and conversations with no messages, such as a session opened
in an editor but never used. It skips unreadable or unparseable conversations.

Each project imports in batches of up to 100 conversations by default (the
conversations per run limit) and 4 GiB. Conversations with no messages count
toward the 4 GiB but not the 100. The page starts the next batch while each
batch makes progress, and a line under the import box shows the project, how
many threads were imported and how many are left. If a batch makes no progress,
the page stops importing that project and counts the rest as conversations
that could not be imported. Completed conversations are not imported again. A
computer running an older T3 Code version imports one batch each time you select
**Start**.

Select **Stop importing** to finish after the current batch, without starting
the next project. The summary counts conversations that could not be imported
separately from those not imported yet. After a stop, or when conversations are
not imported yet, select **Continue import** on the summary to open the Welcome
page again with the unfinished projects checked. They also stay checked when you
open the page from **Settings → About**. You can continue without the remaining history.

You can start without importing. While an import runs, T3 Code stays on the
Welcome page. If you quit, open the Welcome page again from **Settings → About**; the
projects you started stay checked.

### Import limits

To change the import limits, go to **Settings → Threads → Session import**, or
use the time window button on the Welcome page. They apply to the computer you
are setting up, to conversations that are not imported yet.

| Limit                    | Default | Range                               |
| ------------------------ | ------- | ----------------------------------- |
| Time window              | 30 days | 1 to 3,650 days, or **All history** |
| Messages per thread      | 200     | 2 to 10,000, or **Full history**    |
| Conversations per run    | 100     | 1 to 5,000                          |
| Records per conversation | 100,000 | 1,000 to 1,000,000                  |
| Scan budget              | 64 MiB  | 1 to 1,024 MiB                      |

The records limit applies to Codex and Pi conversations. Raise the scan budget
when projects are missing. Higher limits make imports slower and use more
memory, and a conversation still needs to fit in 32 MiB. An organization can
lock a limit with a [managed policy](./managed-policy.md); a locked limit says
who manages it and cannot be changed.
