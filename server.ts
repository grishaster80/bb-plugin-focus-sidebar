// Focus Sidebar — backend. Keeps the list's preferences (focus window and
// whether closed threads show in the Archive) in plugin storage, so the
// phone, the laptop, and every window share them, and exposes them over RPC
// and the `bb focus-sidebar` CLI command. Also tells the list which threads
// automations re-prompt on a schedule, for the Periodic tab.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { clampFocusHours, DEFAULT_FOCUS_HOURS } from "./lib/focus";

const prefsSchema = z.object({
  focusHours: z.number().int().min(1).max(168),
  showClosed: z.boolean(),
  showAutomations: z.boolean(),
});
export type FocusPrefs = z.infer<typeof prefsSchema>;

const DEFAULT_PREFS: FocusPrefs = {
  focusHours: DEFAULT_FOCUS_HOURS,
  showClosed: false,
  showAutomations: false,
};

export const rpcContract = defineRpcContract({
  prefs_get: {
    input: z.null(),
    output: prefsSchema,
  },
  prefs_set: {
    input: prefsSchema.partial(),
    output: prefsSchema,
  },
  periodic_threads: {
    input: z.object({ projectIds: z.array(z.string()).max(500) }),
    output: z.object({ threadIds: z.array(z.string()) }),
  },
});

// What we read from the automations plugin's `automations_list`.
const automationsSchema = z.array(
  z.looseObject({
    execution: z.looseObject({ targetThreadId: z.string().nullish() }),
    lastRunThreadId: z.string().nullish(),
  }),
);
const AUTOMATIONS_CACHE_MS = 60_000;

/** Realtime channel app.tsx listens on; the payload is the new prefs. */
export const PREFS_CHANGED = "prefs-changed";
const PREFS_KEY = "prefs";

export default async function plugin(bb: BbPluginApi) {
  async function readPrefs(): Promise<FocusPrefs> {
    const stored = await bb.storage.kv.get<Partial<FocusPrefs>>(PREFS_KEY);
    return {
      focusHours: clampFocusHours(stored?.focusHours ?? DEFAULT_PREFS.focusHours),
      showClosed:
        typeof stored?.showClosed === "boolean"
          ? stored.showClosed
          : DEFAULT_PREFS.showClosed,
      showAutomations:
        typeof stored?.showAutomations === "boolean"
          ? stored.showAutomations
          : DEFAULT_PREFS.showAutomations,
    };
  }

  async function writePrefs(patch: Partial<FocusPrefs>): Promise<FocusPrefs> {
    const next = { ...(await readPrefs()), ...patch };
    next.focusHours = clampFocusHours(next.focusHours);
    await bb.storage.kv.set(PREFS_KEY, next);
    bb.realtime.publish(PREFS_CHANGED, next);
    return next;
  }

  // Per project: the threads its automations run in, and when we asked.
  const automationThreads = new Map<string, { at: number; threadIds: string[] }>();

  async function periodicThreadsOf(projectId: string): Promise<string[]> {
    const cached = automationThreads.get(projectId);
    if (cached !== undefined && Date.now() - cached.at < AUTOMATIONS_CACHE_MS) {
      return cached.threadIds;
    }
    try {
      const automations = await bb.sdk.plugins.callRpc({
        pluginId: "automations",
        method: "automations_list",
        input: { projectId },
        outputSchema: automationsSchema,
      });
      const threadIds = automations.flatMap((automation) =>
        [automation.execution.targetThreadId, automation.lastRunThreadId].filter(
          (id): id is string => typeof id === "string",
        ),
      );
      automationThreads.set(projectId, { at: Date.now(), threadIds });
      return threadIds;
    } catch (error) {
      // Automations off or the call failed: keep what we knew.
      bb.log.debug(`automations_list failed for ${projectId}: ${String(error)}`);
      return cached?.threadIds ?? [];
    }
  }

  bb.rpc.register(rpcContract, {
    prefs_get: () => readPrefs(),
    prefs_set: (patch) => writePrefs(patch),
    periodic_threads: async ({ projectIds }) => {
      const lists = await Promise.all([...new Set(projectIds)].map(periodicThreadsOf));
      return { threadIds: [...new Set(lists.flat())] };
    },
  });

  const usage = [
    "Usage:",
    "  bb focus-sidebar show [--json]           Print the current settings",
    "  bb focus-sidebar hours <1-168> [--json]  Keep threads active in the last N hours in Focus",
    "  bb focus-sidebar closed <on|off> [--json] Show closed (archived) threads in the Archive tab",
    "  bb focus-sidebar automations <on|off> [--json] Mix periodic (automation) threads into Focus (on) or keep them in the Periodic tab (off)",
  ].join("\n");

  const describe = (prefs: FocusPrefs) =>
    [
      `Focus window: last ${prefs.focusHours}h`,
      `Closed threads in Archive: ${prefs.showClosed ? "shown" : "hidden"}`,
      `Periodic (automation) threads: ${prefs.showAutomations ? "mixed into Focus" : "in the Periodic tab"}`,
    ].join("\n");

  bb.cli.register({
    name: "focus-sidebar",
    summary: "Configure the Focus Sidebar thread list (focus window, closed and automation threads)",
    commands: [
      { name: "show", summary: "Print the current settings", usage: "bb focus-sidebar show [--json]" },
      {
        name: "hours",
        summary: "Set how many hours of activity keep a thread in Focus",
        usage: "bb focus-sidebar hours <1-168> [--json]",
      },
      {
        name: "closed",
        summary: "Show or hide closed (archived) threads in the Archive tab",
        usage: "bb focus-sidebar closed <on|off> [--json]",
      },
      {
        name: "automations",
        summary: "Mix periodic (automation) threads into Focus (on) or keep them in the Periodic tab (off)",
        usage: "bb focus-sidebar automations <on|off> [--json]",
      },
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const [command, value, ...rest] = argv.filter((arg) => arg !== "--json");
      const reply = (prefs: FocusPrefs) => ({
        exitCode: 0,
        stdout: json ? JSON.stringify(prefs) : describe(prefs),
      });
      switch (command) {
        case undefined:
        case "show":
          return reply(await readPrefs());
        case "help":
        case "--help":
          return { exitCode: 0, stdout: usage };
        case "hours": {
          const hours = Number(value);
          if (rest.length > 0 || !Number.isInteger(hours) || hours < 1 || hours > 168) break;
          return reply(await writePrefs({ focusHours: hours }));
        }
        case "closed": {
          if (rest.length > 0 || (value !== "on" && value !== "off")) break;
          return reply(await writePrefs({ showClosed: value === "on" }));
        }
        case "automations": {
          if (rest.length > 0 || (value !== "on" && value !== "off")) break;
          return reply(await writePrefs({ showAutomations: value === "on" }));
        }
      }
      return { exitCode: 1, stderr: usage };
    },
  });
}
