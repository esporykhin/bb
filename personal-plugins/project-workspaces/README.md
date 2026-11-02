# Project Workspaces

A BB plugin that groups projects into **workspaces** and injects each
workspace's shared context (servers, endpoints, credentials, conventions) into
only its own projects' agent threads. Projects outside the workspace receive
nothing.

## How it works

- A workspace has an `id`, `name`, `description`, free-form `instructions`, and a
  list of `projectIds`.
- On every thread start / turn submit, `bb.agents.configure` looks up the
  thread's project. If it belongs to a workspace, bb injects a short preface
  plus the workspace context (or a pointer to the `workspace_context` tool when
  the context is long). Other projects get nothing.
- Agents can read the full context on demand via the `workspace_context` tool or
  `bb workspaces context`.

## Commands

```bash
bb workspaces list
bb workspaces show <id>
bb workspaces context
bb workspaces create <id> <name> --description "..." --instructions "..."
bb workspaces set <id> --name "..." --description "..." --instructions "..."
bb workspaces projects <id> [--add <project-id>] [--remove <project-id>]
bb workspaces remove <id> --yes
```

## Manage in the app

The **Workspaces** panel in the sidebar lists workspaces and lets you create,
edit, and delete them, edit the shared context, and tick the projects that
belong to each workspace.
