// Pure list logic for Focus Sidebar: which threads stay in Focus, how the
// Archive is grouped by day, and how a search query matches a row. No React
// and no host imports, so it runs under plain `node --test`.

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;

/** Focus window choices offered in the list header, in hours. */
export const FOCUS_HOUR_CHOICES = [2, 4, 6, 8, 12, 24] as const;
export const DEFAULT_FOCUS_HOURS = 8;

/** The fields of a sidebar thread this module reads. */
export interface FocusThread {
  id: string;
  parentThreadId: string | null;
  projectId: string;
  displayTitle: string;
  status: string;
  hasPendingInteraction: boolean;
  queuedWork: string;
  isUnread: boolean;
  isPinned: boolean;
  isArchived: boolean;
  isHidden: boolean;
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
  latestAttentionAt: number;
  environment: { branchName: string | null; name: string | null } | null;
}

/** A root thread with the children nested under it. */
export interface ThreadTree<T extends FocusThread> {
  thread: T;
  children: ThreadTree<T>[];
  /** Latest activity anywhere in the tree, epoch ms. */
  lastActivity: number;
  /** Something in the tree is running or waiting for the user. */
  isLive: boolean;
}

export interface DayGroup<T extends FocusThread> {
  key: string;
  label: string;
  trees: ThreadTree<T>[];
}

const BUSY_STATUSES = new Set(["starting", "active", "stopping", "pending"]);

export function lastActivityOf(thread: FocusThread): number {
  return Math.max(thread.updatedAt, thread.latestAttentionAt || 0);
}

/** Running, queued, or blocked on the user: never hide these from Focus. */
export function isLiveThread(thread: FocusThread): boolean {
  if (thread.isArchived) return false;
  return (
    BUSY_STATUSES.has(thread.status) ||
    thread.hasPendingInteraction ||
    thread.queuedWork !== "none"
  );
}

/**
 * Nest children under their parents. A child whose parent is not in the list
 * (archived parent, hidden parent) becomes a root of its own. Roots and
 * children are sorted newest activity first.
 */
export function buildTrees<T extends FocusThread>(
  threads: readonly T[],
): ThreadTree<T>[] {
  const visible = threads.filter((thread) => !thread.isHidden);
  const byId = new Map(visible.map((thread) => [thread.id, thread]));
  const childrenOf = new Map<string, T[]>();
  const roots: T[] = [];
  for (const thread of visible) {
    const parentId = thread.parentThreadId;
    if (parentId !== null && parentId !== thread.id && byId.has(parentId)) {
      const siblings = childrenOf.get(parentId) ?? [];
      siblings.push(thread);
      childrenOf.set(parentId, siblings);
    } else {
      roots.push(thread);
    }
  }
  const seen = new Set<string>();
  const toTree = (thread: T): ThreadTree<T> => {
    seen.add(thread.id);
    const children = (childrenOf.get(thread.id) ?? [])
      .filter((child) => !seen.has(child.id))
      .map(toTree);
    sortTrees(children);
    return {
      thread,
      children,
      lastActivity: Math.max(
        lastActivityOf(thread),
        ...children.map((child) => child.lastActivity),
      ),
      isLive: isLiveThread(thread) || children.some((child) => child.isLive),
    };
  };
  const trees = roots.map(toTree);
  sortTrees(trees);
  return trees;
}

function sortTrees<T extends FocusThread>(trees: ThreadTree<T>[]): void {
  trees.sort(
    (a, b) => b.lastActivity - a.lastActivity || a.thread.id.localeCompare(b.thread.id),
  );
}

/** True when any thread in the tree has this id. */
export function treeContains<T extends FocusThread>(
  tree: ThreadTree<T>,
  threadId: string | null,
): boolean {
  if (threadId === null) return false;
  if (tree.thread.id === threadId) return true;
  return tree.children.some((child) => treeContains(child, threadId));
}

export function countTree<T extends FocusThread>(tree: ThreadTree<T>): number {
  return 1 + tree.children.reduce((sum, child) => sum + countTree(child), 0);
}

export function treeHasUnread<T extends FocusThread>(tree: ThreadTree<T>): boolean {
  return tree.thread.isUnread || tree.children.some(treeHasUnread);
}

/**
 * Split open threads into Focus and Archive. A tree stays in Focus when it
 * had activity inside the window, is pinned, or is running or waiting for
 * the user. Closed (bb-archived) trees always go to the Archive. Opening a
 * thread does not move it: only new activity brings it back to Focus.
 */
export function partitionTrees<T extends FocusThread>(
  trees: readonly ThreadTree<T>[],
  options: { now: number; focusHours: number },
): { focus: ThreadTree<T>[]; archive: ThreadTree<T>[] } {
  const cutoff = options.now - options.focusHours * HOUR_MS;
  const focus: ThreadTree<T>[] = [];
  const archive: ThreadTree<T>[] = [];
  for (const tree of trees) {
    const keep =
      !tree.thread.isArchived &&
      (tree.lastActivity >= cutoff ||
        tree.thread.isPinned ||
        tree.isLive);
    (keep ? focus : archive).push(tree);
  }
  // Pinned threads lead Focus, then newest first.
  focus.sort(
    (a, b) =>
      Number(b.thread.isPinned) - Number(a.thread.isPinned) ||
      b.lastActivity - a.lastActivity,
  );
  return { focus, archive };
}

function startOfLocalDay(time: number): number {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function dayKey(time: number): string {
  const date = new Date(time);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

/** "Today", "Yesterday", a weekday within the past week, else a date. */
export function dayLabel(time: number, now: number, locale?: string): string {
  const today = startOfLocalDay(now);
  const day = startOfLocalDay(time);
  const daysAgo = Math.round((today - day) / DAY_MS);
  if (daysAgo <= 0) return "Today";
  if (daysAgo === 1) return "Yesterday";
  const date = new Date(time);
  if (daysAgo < 7) return date.toLocaleDateString(locale, { weekday: "long" });
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(locale, {
    month: "long",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/** Group trees by the local day of their last activity, newest day first. */
export function groupByDay<T extends FocusThread>(
  trees: readonly ThreadTree<T>[],
  now: number,
  locale?: string,
): DayGroup<T>[] {
  const groups = new Map<string, DayGroup<T> & { time: number }>();
  for (const tree of trees) {
    const key = dayKey(tree.lastActivity);
    let group = groups.get(key);
    if (group === undefined) {
      group = {
        key,
        label: dayLabel(tree.lastActivity, now, locale),
        trees: [],
        time: startOfLocalDay(tree.lastActivity),
      };
      groups.set(key, group);
    }
    group.trees.push(tree);
  }
  return [...groups.values()]
    .sort((a, b) => b.time - a.time)
    .map(({ key, label, trees: groupTrees }) => ({
      key,
      label,
      trees: [...groupTrees].sort((a, b) => b.lastActivity - a.lastActivity),
    }));
}

/** Local clock time for a row under a day header: "14:05" or "2:05 PM". */
export function formatClock(time: number, locale?: string): string {
  return new Date(time).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
}

/** Compact age for a row: "now", "12m", "5h", "Yesterday", "Mon", "Oct 3". */
export function formatAge(time: number, now: number, locale?: string): string {
  const diff = Math.max(0, now - time);
  if (diff < 60_000) return "now";
  if (diff < HOUR_MS) return `${Math.floor(diff / 60_000)}m`;
  if (diff < DAY_MS) return `${Math.floor(diff / HOUR_MS)}h`;
  const date = new Date(time);
  if (diff < 7 * DAY_MS) return date.toLocaleDateString(locale, { weekday: "short" });
  return date.toLocaleDateString(locale, { month: "short", day: "numeric" });
}

export function normalizeQuery(query: string): string[] {
  return query
    .toLocaleLowerCase()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

/** Every token appears in the title, project name, branch, or environment. */
export function threadMatches(
  thread: FocusThread,
  tokens: readonly string[],
  projectName: string | undefined,
): boolean {
  if (tokens.length === 0) return true;
  const haystack = [
    thread.displayTitle,
    projectName ?? "",
    thread.environment?.branchName ?? "",
    thread.environment?.name ?? "",
    thread.id,
  ]
    .join("\n")
    .toLocaleLowerCase();
  return tokens.every((token) => haystack.includes(token));
}

export function clampFocusHours(value: unknown): number {
  const hours = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(hours)) return DEFAULT_FOCUS_HOURS;
  return Math.min(168, Math.max(1, Math.round(hours)));
}
