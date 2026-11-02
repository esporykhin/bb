import {
  PluginCliError,
  cliCommand,
  defineCli,
  defineRpcContract,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import { z } from "zod";

const WORKSPACE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

const workspaceIdSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(64)
  .regex(
    WORKSPACE_ID_PATTERN,
    "workspace id must use lowercase letters, digits, and single hyphens",
  );

const workspaceSchema = z
  .object({
    id: workspaceIdSchema,
    name: z.string().trim().min(1).max(120),
    description: z.string().max(2000),
    instructions: z.string().max(64000),
    projectIds: z.array(z.string().min(1).max(200)).max(500),
  })
  .strict();

type Workspace = z.infer<typeof workspaceSchema>;

const workspaceSummarySchema = z
  .object({
    id: workspaceIdSchema,
    name: z.string(),
    description: z.string(),
    projectIds: z.array(z.string()),
  })
  .strict();

const projectRefSchema = z.object({ id: z.string(), name: z.string() });

export const rpcContract = defineRpcContract({
  list: {
    input: z.null(),
    output: z.object({ workspaces: z.array(workspaceSummarySchema) }),
  },
  get: {
    input: z.object({ id: workspaceIdSchema }).strict(),
    output: z.union([workspaceSchema, z.null()]),
  },
  create: {
    input: z
      .object({
        id: workspaceIdSchema,
        name: z.string().trim().min(1).max(120),
        description: z.string().max(2000).optional(),
        instructions: z.string().max(64000).optional(),
      })
      .strict(),
    output: workspaceSchema,
  },
  update: {
    input: z
      .object({
        id: workspaceIdSchema,
        name: z.string().trim().min(1).max(120).optional(),
        description: z.string().max(2000).optional(),
        instructions: z.string().max(64000).optional(),
      })
      .strict(),
    output: workspaceSchema,
  },
  remove: {
    input: z.object({ id: workspaceIdSchema }).strict(),
    output: z.object({ removed: z.boolean() }),
  },
  setProjects: {
    input: z
      .object({
        id: workspaceIdSchema,
        projectIds: z.array(z.string().min(1).max(200)).max(500),
      })
      .strict(),
    output: workspaceSchema,
  },
  projects: {
    input: z.null(),
    output: z.object({ projects: z.array(projectRefSchema) }),
  },
});

const WORKSPACES_KEY = "workspaces";
const WORKSPACES_CHANGED = "workspaces-changed";

export default async function plugin(bb: BbPluginApi) {
  let workspaces: Workspace[] = [];

  const stored = await bb.storage.kv.get<unknown>(WORKSPACES_KEY);
  if (stored !== undefined) {
    const parsed = z.array(workspaceSchema).safeParse(stored);
    if (parsed.success) {
      workspaces = parsed.data;
    } else {
      bb.log.warn("Ignoring malformed stored workspaces");
    }
  }

  async function persist(): Promise<void> {
    await bb.storage.kv.set(WORKSPACES_KEY, workspaces);
    bb.realtime.publish(WORKSPACES_CHANGED, null);
  }

  function findWorkspace(id: string): Workspace | undefined {
    return workspaces.find((workspace) => workspace.id === id);
  }

  function requireWorkspace(id: string): Workspace {
    const found = findWorkspace(id);
    if (found === undefined) {
      throw new PluginCliError(`Unknown workspace ${JSON.stringify(id)}`, {
        code: "unknown_workspace",
        hint: 'Run `bb workspaces list` to see ids.',
      });
    }
    return found;
  }

  function workspaceOfProject(projectId: string): Workspace | undefined {
    return workspaces.find((workspace) => workspace.projectIds.includes(projectId));
  }

  function toSummary(workspace: Workspace): z.infer<typeof workspaceSummarySchema> {
    return {
      id: workspace.id,
      name: workspace.name,
      description: workspace.description,
      projectIds: workspace.projectIds,
    };
  }

  function createWorkspace(input: {
    id: string;
    name: string;
    description?: string;
    instructions?: string;
  }): Workspace {
    if (findWorkspace(input.id) !== undefined) {
      throw new PluginCliError(`Workspace ${JSON.stringify(input.id)} already exists`, {
        code: "workspace_exists",
      });
    }
    const workspace: Workspace = {
      id: input.id,
      name: input.name,
      description: input.description ?? "",
      instructions: input.instructions ?? "",
      projectIds: [],
    };
    workspaces = [...workspaces, workspace];
    void persist();
    return workspace;
  }

  function updateWorkspace(input: {
    id: string;
    name?: string;
    description?: string;
    instructions?: string;
  }): Workspace {
    const existing = requireWorkspace(input.id);
    const updated: Workspace = {
      ...existing,
      name: input.name ?? existing.name,
      description: input.description ?? existing.description,
      instructions: input.instructions ?? existing.instructions,
    };
    workspaces = workspaces.map((workspace) => (workspace.id === input.id ? updated : workspace));
    void persist();
    return updated;
  }

  function removeWorkspace(id: string): boolean {
    const next = workspaces.filter((workspace) => workspace.id !== id);
    if (next.length === workspaces.length) return false;
    workspaces = next;
    void persist();
    return true;
  }

  function setProjects(id: string, projectIds: string[]): Workspace {
    const existing = requireWorkspace(id);
    const updated: Workspace = { ...existing, projectIds };
    workspaces = workspaces.map((workspace) => (workspace.id === id ? updated : workspace));
    void persist();
    return updated;
  }

  async function listProjects(): Promise<Array<{ id: string; name: string }>> {
    const projects = await bb.sdk.projects.list();
    return projects.map((project) => ({ id: project.id, name: project.name }));
  }

  function formatWorkspaceContext(workspace: Workspace): string {
    const parts = [
      `Workspace ${workspace.name} (${workspace.id})`,
      workspace.description.length > 0 ? `Description: ${workspace.description}` : "",
      workspace.instructions.length > 0 ? `Shared context:\n${workspace.instructions}` : "",
      workspace.projectIds.length > 0
        ? `Sibling project ids: ${workspace.projectIds.join(", ")}`
        : "",
    ];
    return parts.filter((part) => part.length > 0).join("\n\n");
  }

  bb.agents.registerTool({
    name: "workspace_context",
    description:
      "Read this project's shared workspace context: servers, endpoints, credentials, conventions, and the sibling projects grouped in the same workspace.",
    parameters: z.object({}).strict(),
    async execute(_input, context) {
      const workspace = workspaceOfProject(context.projectId);
      if (workspace === undefined) {
        throw new Error("This project is not in any workspace.");
      }
      return formatWorkspaceContext(workspace);
    },
  });

  bb.agents.configure((context) => {
    const workspace = workspaceOfProject(context.project.id);
    if (workspace === undefined) {
      return { tools: [], skills: [] };
    }
    const preface = `This project belongs to the workspace ${JSON.stringify(workspace.name)} (${workspace.id}).`;
    const body = [workspace.description.trim(), workspace.instructions.trim()]
      .filter((part) => part.length > 0)
      .join("\n\n");
    if (body.length === 0) {
      return { tools: ["workspace_context"], skills: [], instructions: preface };
    }
    if (body.length <= 3500) {
      return {
        tools: ["workspace_context"],
        skills: [],
        instructions: `${preface}\n\n${body}`,
      };
    }
    return {
      tools: ["workspace_context"],
      skills: [],
      instructions: `${preface}\nThe workspace's full shared context is available through the workspace_context tool. Call it before doing environment-specific work.`,
    };
  });

  bb.rpc.register(rpcContract, {
    list: async () => ({ workspaces: workspaces.map(toSummary) }),
    get: async ({ id }) => findWorkspace(id) ?? null,
    create: async (input) => createWorkspace(input),
    update: async (input) => updateWorkspace(input),
    remove: async ({ id }) => ({ removed: removeWorkspace(id) }),
    setProjects: async (input) => setProjects(input.id, input.projectIds),
    projects: async () => ({ projects: await listProjects() }),
  });

  const jsonOption = {
    json: { type: "boolean", description: "Emit machine-readable JSON" },
  } as const;

  const jsonOrText = (
    value: unknown,
    text: string,
    json: boolean,
  ): { exitCode: number; stdout: string } => ({
    exitCode: 0,
    stdout: json ? `${JSON.stringify(value, null, 2)}\n` : text,
  });

  bb.cli.register(
    defineCli({
      name: "workspaces",
      summary: "Group projects into workspaces and manage each workspace's shared context",
      description:
        "A workspace groups projects and holds shared context (servers, endpoints, conventions) that bb injects only into those projects' threads.",
      commands: {
        list: cliCommand({
          summary: "List workspaces with their project counts",
          options: { ...jsonOption },
          async run(input) {
            if (workspaces.length === 0) {
              return jsonOrText({ workspaces: [] }, "No workspaces.", input.options.json);
            }
            const lines = workspaces.map(
              (workspace) =>
                `${workspace.id}\t${workspace.name}\t${workspace.projectIds.length} project(s)`,
            );
            return jsonOrText(
              { workspaces: workspaces.map(toSummary) },
              lines.join("\n"),
              input.options.json,
            );
          },
        }),
        show: cliCommand({
          summary: "Show one workspace: name, description, instructions, and project ids",
          positionals: [{ name: "id", description: "Workspace id", required: true }],
          options: { ...jsonOption },
          async run(input) {
            const workspace = requireWorkspace(input.positionals.id);
            const text = [
              `Name: ${workspace.name}`,
              `Id: ${workspace.id}`,
              `Projects (${workspace.projectIds.length}): ${workspace.projectIds.join(", ") || "—"}`,
              workspace.description.length > 0 ? `Description: ${workspace.description}` : "",
              workspace.instructions.length > 0
                ? `Instructions:\n${workspace.instructions}`
                : "",
            ]
              .filter((part) => part.length > 0)
              .join("\n\n");
            return jsonOrText(workspace, text, input.options.json);
          },
        }),
        create: cliCommand({
          summary: "Create a workspace",
          positionals: [
            {
              name: "id",
              description: "Workspace id (lowercase, digits, hyphens)",
              required: true,
            },
            { name: "name", description: "Human-readable name", required: true },
          ],
          options: {
            ...jsonOption,
            description: {
              type: "string",
              description: "One-line description (at most 2000 characters)",
            },
            instructions: {
              type: "string",
              description:
                "Shared context: servers, endpoints, conventions (at most 64000 characters)",
              stdin: true,
            },
          },
          async run(input) {
            const workspace = createWorkspace({
              id: input.positionals.id,
              name: input.positionals.name,
              description: input.options.description,
              instructions: input.options.instructions,
            });
            return jsonOrText(
              workspace,
              `Created workspace ${JSON.stringify(workspace.id)}`,
              input.options.json,
            );
          },
        }),
        remove: cliCommand({
          summary: "Delete a workspace (does not touch its projects)",
          positionals: [{ name: "id", description: "Workspace id", required: true }],
          options: {
            ...jsonOption,
            yes: { type: "boolean", description: "Skip the confirmation requirement" },
          },
          async run(input) {
            if (!input.options.yes) {
              throw new PluginCliError("Pass --yes to confirm deleting the workspace", {
                code: "confirmation_required",
                hint: `bb workspaces remove ${input.positionals.id} --yes`,
              });
            }
            requireWorkspace(input.positionals.id);
            removeWorkspace(input.positionals.id);
            return jsonOrText(
              { removed: true },
              `Removed workspace ${input.positionals.id}`,
              input.options.json,
            );
          },
        }),
        set: cliCommand({
          summary: "Update a workspace's name, description, or shared instructions",
          positionals: [{ name: "id", description: "Workspace id", required: true }],
          options: {
            ...jsonOption,
            name: { type: "string", description: "New human-readable name" },
            description: {
              type: "string",
              description: "New one-line description (at most 2000 characters)",
            },
            instructions: {
              type: "string",
              description: "New shared context (at most 64000 characters)",
              stdin: true,
            },
            "clear-instructions": {
              type: "boolean",
              description: "Remove the workspace's shared instructions",
            },
          },
          constraints: [
            {
              kind: "at-least-one",
              options: ["name", "description", "instructions", "clear-instructions"],
            },
          ],
          async run(input) {
            const clear = input.options["clear-instructions"];
            if (clear && input.options.instructions !== undefined) {
              throw new PluginCliError(
                "Pass either --instructions or --clear-instructions, not both",
                { code: "invalid_value" },
              );
            }
            const workspace = updateWorkspace({
              id: input.positionals.id,
              name: input.options.name,
              description: input.options.description,
              instructions: clear ? "" : input.options.instructions,
            });
            return jsonOrText(
              workspace,
              `Updated workspace ${workspace.id}`,
              input.options.json,
            );
          },
        }),
        projects: cliCommand({
          summary: "List or change the projects in a workspace",
          positionals: [{ name: "id", description: "Workspace id", required: true }],
          options: {
            ...jsonOption,
            add: {
              type: "string",
              description: "Add a project by id (proj_...); repeatable",
              repeatable: true,
            },
            remove: {
              type: "string",
              description: "Remove a project by id (proj_...); repeatable",
              repeatable: true,
            },
          },
          async run(input) {
            let workspace = requireWorkspace(input.positionals.id);
            if (input.options.add.length === 0 && input.options.remove.length === 0) {
              const projects = await listProjects();
              const byId = new Map(projects.map((project) => [project.id, project.name]));
              const text = workspace.projectIds
                .map((id) => `${id}\t${byId.get(id) ?? "(unknown project)"}`)
                .join("\n");
              return jsonOrText(
                { projectIds: workspace.projectIds },
                text || "No projects.",
                input.options.json,
              );
            }
            const nextIds = new Set(workspace.projectIds);
            for (const id of input.options.add) {
              await bb.sdk.projects.get({ projectId: id });
              nextIds.add(id);
            }
            for (const id of input.options.remove) {
              nextIds.delete(id);
            }
            workspace = setProjects(workspace.id, [...nextIds]);
            return jsonOrText(
              workspace,
              `Projects for ${workspace.id}: ${workspace.projectIds.join(", ") || "—"}`,
              input.options.json,
            );
          },
        }),
        context: cliCommand({
          summary: "Print the current project's workspace shared context (for agents)",
          options: { ...jsonOption },
          async run(input, ctx) {
            if (ctx.projectId === undefined) {
              throw new PluginCliError("No current project; run this inside a project thread", {
                code: "no_project",
                hint: "Run `bb workspaces show <id>` to read a specific workspace instead.",
              });
            }
            const workspace = workspaceOfProject(ctx.projectId);
            if (workspace === undefined) {
              throw new PluginCliError("The current project is not in any workspace", {
                code: "no_workspace",
                hint: "Run `bb workspaces list` to see available workspaces.",
              });
            }
            return jsonOrText(workspace, formatWorkspaceContext(workspace), input.options.json);
          },
        }),
      },
    }),
  );

  bb.onDispose(() => {
    bb.log.info("disposed");
  });
}
