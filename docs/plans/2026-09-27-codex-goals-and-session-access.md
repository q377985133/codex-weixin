# Codex Goal And Session Access

## Context

The bridge already uses Codex app-server V2 for managed sessions, but WeChat can
only resume sessions created by codex-weixin. It also treats `/goal` as an
unknown local command.

Codex app-server now exposes stable `thread/goal/*` methods and a
`thread/list` search API that can enumerate local CLI, Desktop, app-server, and
exec sessions.

## Design

- Enable the app-server experimental capability so search and experimental
  fields remain available across Codex releases.
- Search all supported local session sources through `thread/list`, sorted by
  update time and filtered by title through `searchTerm`.
- Import a selected external session into a managed session only when its
  captured `cwd` is inside the configured workspace allowlist.
- Map `/goal`, `/goal <objective>`, `/goal edit`, `/goal pause`,
  `/goal resume`, `/goal clear`, and `/goal budget` to `thread/goal/*`.
- Register a goal observer before changing goal state. Active goals generate
  app-server-owned continuation turns that are not responses to a local
  `turn/start` request, so the observer routes those progress updates and final
  answers back to the originating WeChat sender.
- Keep continuation turns separate from normal user turns by tracking manual
  `turn/start` requests and their returned turn IDs.

## Safety

- External sessions remain read-only until explicitly imported.
- Imported sessions must pass the same workspace allowlist as `/bind`.
- Goal objectives are limited to 4,000 characters.
- Goal token budgets must be positive integers or explicitly removed.
- Existing approval behavior remains `approvalPolicy: "never"`.

## Verification

- Unit-test app-server session parsing, goal lifecycle methods, and automatic
  turn routing.
- Unit-test WeChat session search/import and goal command behavior.
- Probe the installed Codex app-server against the real local session index
  without starting a model turn.
