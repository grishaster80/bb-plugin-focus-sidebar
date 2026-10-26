// Focus Sidebar — frontend. Replaces bb's sidebar thread list with two tabs:
// Focus (threads active in the last few hours, plus anything running,
// waiting for you, or pinned) and Archive (everything older, grouped by day,
// newest first). A search box at the top filters both by title, project and
// branch at once, then adds full-text matches from message history. Every
// row has a close button, and the thread header gets one too.
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import {
  definePluginApp,
  experimental_ProviderIcon as ProviderIcon,
  experimental_ThreadActionsContextMenu as ThreadActionsContextMenu,
  experimental_ThreadStatusGlyph as ThreadStatusGlyph,
  experimental_useProviders as useProviders,
  experimental_useSidebarThreadSplit as useSidebarThreadSplit,
  experimental_useSidebarThreads as useSidebarThreads,
  experimental_useThreadActions as useThreadActions,
  ThreadTitle,
  useBbNavigate,
  useRealtime,
  useRpc,
  useSdk,
  useSidebarThreadDraft,
  useSidebarThreadRowStatus,
  type PluginSidebarThread,
  type PluginThreadActionTarget,
  type PluginThreadHeaderActionProps,
  type PluginThreadListProps,
} from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import {
  buildTrees,
  countTree,
  DEFAULT_FOCUS_HOURS,
  FOCUS_HOUR_CHOICES,
  formatAge,
  formatClock,
  groupByDay,
  lastActivityOf,
  normalizeQuery,
  partitionTrees,
  threadMatches,
  treeContains,
  treeHasUnread,
  type ThreadTree,
} from "@/lib/focus";
import { cn } from "@/lib/utils";
import type { FocusPrefs, rpcContract } from "./server";

const PREFS_CHANGED = "prefs-changed";
const ARCHIVE_ACTION_KEY = "bb--core/archive";
const TAB_STORAGE_KEY = "focus-sidebar:tab";
const ARCHIVE_PAGE = 150;
const SEARCH_DEBOUNCE_MS = 250;

type Tab = "focus" | "archive";
type Tree = ThreadTree<PluginSidebarThread>;

// ---------------------------------------------------------------------------
// Shared state

function usePrefs(): [FocusPrefs, (patch: Partial<FocusPrefs>) => void] {
  const rpc = useRpc<typeof rpcContract>();
  const [prefs, setPrefs] = useState<FocusPrefs>({
    focusHours: DEFAULT_FOCUS_HOURS,
    showClosed: false,
    showAutomations: false,
  });
  const refetch = useCallback(() => {
    rpc.call("prefs_get").then(setPrefs, () => undefined);
  }, [rpc]);
  useEffect(refetch, [refetch]);
  useRealtime(PREFS_CHANGED, refetch);
  const update = useCallback(
    (patch: Partial<FocusPrefs>) => {
      setPrefs((current) => ({ ...current, ...patch }));
      rpc.call("prefs_set", patch).then(setPrefs, refetch);
    },
    [rpc, refetch],
  );
  return [prefs, update];
}

/** Re-renders once a minute so ages and the focus cutoff stay current. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

function useStoredTab(): [Tab, (tab: Tab) => void] {
  const [tab, setTab] = useState<Tab>(() => {
    try {
      return window.localStorage.getItem(TAB_STORAGE_KEY) === "archive"
        ? "archive"
        : "focus";
    } catch {
      return "focus";
    }
  });
  const update = useCallback((next: Tab) => {
    setTab(next);
    try {
      window.localStorage.setItem(TAB_STORAGE_KEY, next);
    } catch {
      // Private mode: the tab just is not remembered.
    }
  }, []);
  return [tab, update];
}

function actionTarget(thread: PluginSidebarThread): PluginThreadActionTarget {
  const environmentId = thread.environment?.id ?? null;
  return {
    id: thread.id,
    projectId: thread.projectId,
    parentThreadId: thread.parentThreadId,
    archivedAt: thread.archivedAt,
    pinnedAt: thread.pinnedAt,
    sectionId: thread.sectionId,
    isUnread: thread.isUnread,
    status: thread.status,
    environment:
      environmentId === null
        ? null
        : { id: environmentId, path: thread.environment?.path ?? null },
  };
}

// ---------------------------------------------------------------------------
// Rows

/** bb's archive action for one thread; "Unarchive" for a closed thread. */
function useCloseAction(thread: PluginSidebarThread) {
  const target = useMemo(() => actionTarget(thread), [thread]);
  const [entry] = useThreadActions(target, { keys: [ARCHIVE_ACTION_KEY] });
  return entry?.action ?? null;
}

function CloseButton({
  thread,
  className,
}: {
  thread: PluginSidebarThread;
  className?: string;
}) {
  const action = useCloseAction(thread);
  if (action === null) return null;
  const reopen = thread.isArchived;
  const label = reopen ? "Reopen thread" : "Close thread";
  return (
    <button
      type="button"
      aria-label={`${label}: ${thread.displayTitle}`}
      title={reopen ? "Reopen (unarchive)" : "Close (archive) — reopen it any time from Archive"}
      disabled={action.disabled}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void action.run();
      }}
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground",
        "hover:bg-sidebar-border hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sidebar-ring",
        "disabled:opacity-40",
        className,
      )}
    >
      <Icon
        name={reopen ? "ArchiveRestore" : "X"}
        fallback={reopen ? "Archive" : "X"}
        className="size-3.5"
        aria-hidden
      />
    </button>
  );
}

/** The agent's small logo (Claude Code, Codex, …) in front of a title. */
function ProviderGlyph({ providerId }: { providerId: string }) {
  const { providers } = useProviders();
  const provider = providers.find((candidate) => candidate.id === providerId);
  return (
    <span
      className="flex size-4 shrink-0 items-center justify-center text-muted-foreground"
      title={provider?.displayName ?? providerId}
    >
      <ProviderIcon
        providerKind="agent"
        provider={provider ?? { id: providerId }}
        fallback="Bot"
        className="size-3"
        aria-hidden
      />
    </span>
  );
}

/** bb's status glyph (running, unread, waiting…), drawn only when there is one. */
function StatusGlyph({ thread }: { thread: PluginSidebarThread }) {
  const rowStatus = useSidebarThreadRowStatus(thread.id);
  const { hasUnsubmittedDraft } = useSidebarThreadDraft(thread.id);
  const indicator =
    thread.indicator === "none" && hasUnsubmittedDraft ? "draft" : thread.indicator;
  const archived = thread.isArchived && indicator === "none";
  if (indicator === "none" && rowStatus === null && !archived) return null;
  return (
    <span className="relative flex size-4 shrink-0 items-center justify-center">
      <ThreadStatusGlyph
        indicator={indicator}
        rowStatus={rowStatus}
        archived={archived}
        size="compact"
      />
    </span>
  );
}

interface RowProps {
  tree: Tree;
  depth: number;
  now: number;
  /** "clock" under a day header (Archive), "age" elsewhere. */
  timeStyle: "age" | "clock";
  activeThreadId: string | null;
  projectName: string | undefined;
  expanded: boolean;
  onToggle: (threadId: string) => void;
  onNavigate: () => void;
}

const ThreadRow = memo(function ThreadRow({
  tree,
  depth,
  now,
  timeStyle,
  activeThreadId,
  projectName,
  expanded,
  onToggle,
  onNavigate,
}: RowProps) {
  const { thread } = tree;
  const { splitProps } = useSidebarThreadSplit(thread.id);
  const isActive = thread.id === activeThreadId;
  const childCount = tree.children.length;
  const unread = thread.isUnread || (!expanded && tree.children.some(treeHasUnread));
  const details = [projectName, thread.environment?.branchName].filter(Boolean).join(" · ");
  return (
    <ThreadActionsContextMenu thread={actionTarget(thread)}>
      <div
        className={cn(
          "group/row relative flex h-8 items-center gap-1.5 rounded-md pr-1 text-sm",
          "text-sidebar-foreground hover:bg-sidebar-accent",
          isActive && "bg-sidebar-accent text-sidebar-accent-foreground",
          thread.isArchived && "opacity-70",
        )}
        style={{ paddingLeft: 6 + depth * 14 }}
      >
        {childCount > 0 ? (
          <button
            type="button"
            aria-label={`${expanded ? "Collapse" : "Expand"} ${childCount} child threads`}
            aria-expanded={expanded}
            onClick={() => onToggle(thread.id)}
            className="flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-sidebar-foreground"
          >
            <Icon
              name="ChevronRight"
              className={cn("size-3 transition-transform", expanded && "rotate-90")}
              aria-hidden
            />
          </button>
        ) : null}
        <ProviderGlyph providerId={thread.providerId} />
        <a
          {...splitProps}
          href={thread.href}
          draggable={false}
          data-sidebar-thread-shortcut-target=""
          data-sidebar-thread-id={thread.id}
          aria-current={isActive ? "page" : undefined}
          title={details ? `${thread.displayTitle}\n${details}` : thread.displayTitle}
          onClick={(event: MouseEvent<HTMLAnchorElement>) => {
            if (!event.defaultPrevented) onNavigate();
          }}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-1.5 self-stretch outline-none",
            "after:absolute after:inset-0 after:rounded-md focus-visible:after:ring-1 focus-visible:after:ring-sidebar-ring",
            unread && "font-semibold",
          )}
        >
          <span className="min-w-0 flex-1 truncate">
            <ThreadTitle threadId={thread.id} />
          </span>
          {!expanded && childCount > 0 ? (
            <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
              +{countTree(tree) - 1}
            </span>
          ) : null}
        </a>
        <StatusGlyph thread={thread} />
        <span className="relative shrink-0 text-[11px] tabular-nums text-muted-foreground group-hover/row:hidden group-focus-within/row:hidden [@media(hover:none)]:hidden">
          {timeStyle === "clock" ? formatClock(tree.lastActivity) : formatAge(tree.lastActivity, now)}
        </span>
        <CloseButton
          thread={thread}
          className="relative hidden group-hover/row:flex group-focus-within/row:flex [@media(hover:none)]:flex"
        />
      </div>
    </ThreadActionsContextMenu>
  );
});

function TreeRows({
  tree,
  depth,
  expandedIds,
  ...rest
}: Omit<RowProps, "tree" | "depth" | "expanded"> & {
  tree: Tree;
  depth: number;
  expandedIds: ReadonlySet<string>;
}) {
  // A parent opens by itself while you are in one of its children.
  const expanded =
    expandedIds.has(tree.thread.id) ||
    tree.children.some((child) => treeContains(child, rest.activeThreadId));
  return (
    <>
      <ThreadRow {...rest} tree={tree} depth={depth} expanded={expanded} />
      {expanded
        ? tree.children.map((child) => (
            <TreeRows
              key={child.thread.id}
              {...rest}
              tree={child}
              depth={depth + 1}
              expandedIds={expandedIds}
            />
          ))
        : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Search

interface MessageHit {
  threadId: string;
  projectId: string;
  providerId: string;
  title: string;
  archived: boolean;
  updatedAt: number;
  text: string;
  ranges: { start: number; end: number }[];
}

/** Full-text search over titles and messages, active and closed threads. */
function useMessageSearch(query: string): { hits: MessageHit[]; loading: boolean } {
  const sdk = useSdk();
  const [state, setState] = useState<{ query: string; hits: MessageHit[] }>({
    query: "",
    hits: [],
  });
  const trimmed = query.trim();
  useEffect(() => {
    if (trimmed.length < 2) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      sdk.threads
        .search({ query: trimmed, limitPerGroup: "25", signal: controller.signal })
        .then((result) => {
          const hits: MessageHit[] = [];
          for (const [group, archived] of [
            [result.active, false],
            [result.archived, true],
          ] as const) {
            for (const { thread, matches } of group.results) {
              if (thread.visibility === "hidden" || thread.deletedAt !== null) continue;
              const match =
                matches.find((candidate) => candidate.sourceKind.endsWith("_message")) ??
                matches[0];
              hits.push({
                threadId: thread.id,
                projectId: thread.projectId,
                providerId: thread.providerId,
                title: thread.title ?? thread.titleFallback ?? thread.id,
                archived,
                updatedAt: thread.updatedAt,
                text: match?.text ?? "",
                ranges: match?.highlightRanges ?? [],
              });
            }
          }
          hits.sort((a, b) => b.updatedAt - a.updatedAt);
          setState({ query: trimmed, hits });
        })
        .catch(() => {
          if (!controller.signal.aborted) setState({ query: trimmed, hits: [] });
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [sdk, trimmed]);
  if (trimmed.length < 2) return { hits: [], loading: false };
  return {
    hits: state.query === trimmed ? state.hits : [],
    loading: state.query !== trimmed,
  };
}

/** The matched text around the first highlight, with the hits marked. */
function Snippet({ text, ranges }: { text: string; ranges: MessageHit["ranges"] }) {
  const first = ranges[0]?.start ?? 0;
  const start = Math.max(0, first - 30);
  const end = Math.min(text.length, start + 140);
  const parts: ReactNode[] = [];
  let cursor = start;
  for (const range of ranges) {
    if (range.end <= cursor || range.start >= end) continue;
    const from = Math.max(range.start, cursor);
    const to = Math.min(range.end, end);
    if (from > cursor) parts.push(text.slice(cursor, from));
    parts.push(
      <mark key={from} className="rounded-sm bg-yellow-400/30 text-inherit">
        {text.slice(from, to)}
      </mark>,
    );
    cursor = to;
  }
  if (cursor < end) parts.push(text.slice(cursor, end));
  return (
    <>
      {start > 0 ? "…" : ""}
      {parts}
      {end < text.length ? "…" : ""}
    </>
  );
}

function MessageHitRow({
  hit,
  now,
  activeThreadId,
  projectName,
  onNavigate,
}: {
  hit: MessageHit;
  now: number;
  activeThreadId: string | null;
  projectName: string | undefined;
  onNavigate: () => void;
}) {
  const navigate = useBbNavigate();
  const isActive = hit.threadId === activeThreadId;
  return (
    <a
      href={`/projects/${hit.projectId}/threads/${hit.threadId}`}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        navigate.toThread(hit.threadId);
        onNavigate();
      }}
      className={cn(
        "relative block rounded-md py-1.5 pl-7 pr-1 text-sm text-sidebar-foreground hover:bg-sidebar-accent",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sidebar-ring",
        isActive && "bg-sidebar-accent",
      )}
    >
      <span className="flex items-center gap-1.5">
        <span className="absolute left-1.5 top-2">
          <ProviderGlyph providerId={hit.providerId} />
        </span>
        <span className="min-w-0 flex-1 truncate">{hit.title}</span>
        {hit.archived ? (
          <Icon name="Archive" className="size-3 shrink-0 text-muted-foreground" aria-label="Closed" />
        ) : null}
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
          {formatAge(hit.updatedAt, now)}
        </span>
      </span>
      {hit.text ? (
        <span className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
          <Snippet text={hit.text} ranges={hit.ranges} />
        </span>
      ) : null}
      {projectName ? (
        <span className="mt-0.5 block truncate text-[11px] text-muted-foreground/80">
          {projectName}
        </span>
      ) : null}
    </a>
  );
}

// ---------------------------------------------------------------------------
// Header

function SearchBox({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div className="relative">
      <Icon
        name="Search"
        className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
      <input
        ref={inputRef}
        type="search"
        value={value}
        placeholder="Search threads and messages"
        aria-label="Search threads and messages"
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
          if (event.key === "Escape" && value !== "") {
            event.stopPropagation();
            onChange("");
          }
        }}
        className={cn(
          "h-8 w-full rounded-md border border-sidebar-border bg-transparent pl-7 pr-7 text-sm text-sidebar-foreground",
          "placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sidebar-ring",
          "[&::-webkit-search-cancel-button]:hidden",
        )}
      />
      {value !== "" ? (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => {
            onChange("");
            inputRef.current?.focus();
          }}
          className="absolute right-1.5 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:text-sidebar-foreground"
        >
          <Icon name="X" className="size-3" aria-hidden />
        </button>
      ) : null}
    </div>
  );
}

function TabButton({
  selected,
  onClick,
  children,
  badge,
}: {
  selected: boolean;
  onClick: () => void;
  children: ReactNode;
  badge?: ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={onClick}
      className={cn(
        "flex h-6 items-center gap-1 rounded px-2 text-xs font-medium",
        selected
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "text-muted-foreground hover:text-sidebar-foreground",
      )}
    >
      {children}
      {badge}
    </button>
  );
}

function Count({ value, dot }: { value: number; dot?: boolean }) {
  return (
    <span className="flex items-center gap-1 tabular-nums opacity-70">
      {value}
      {dot ? <span className="size-1.5 rounded-full bg-blue-500" aria-label="unread" /> : null}
    </span>
  );
}

function GroupHeader({ children }: { children: ReactNode }) {
  return (
    <div className="px-2 pb-1 pt-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
      {children}
    </div>
  );
}

function EmptyNote({ children }: { children: ReactNode }) {
  return <p className="px-2 py-6 text-center text-xs text-muted-foreground">{children}</p>;
}

// ---------------------------------------------------------------------------
// The list

function FocusThreadList({ activeThreadId, onNavigate }: PluginThreadListProps) {
  const [prefs, setPrefs] = usePrefs();
  const [tab, setTab] = useStoredTab();
  const [query, setQuery] = useState("");
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(new Set());
  const [archiveLimit, setArchiveLimit] = useState(ARCHIVE_PAGE);
  const now = useNow();
  const tokens = useMemo(() => normalizeQuery(query), [query]);
  const searching = tokens.length > 0;

  const wantsClosed = prefs.showClosed && (tab === "archive" || searching);
  const lifecycles = useMemo(
    () => (wantsClosed ? (["active", "archived"] as const) : (["active"] as const)),
    [wantsClosed],
  );
  const { status, threads, projects, experimental_archived: archivedPages } =
    useSidebarThreads({ experimental_lifecycles: lifecycles });

  const projectNames = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name])),
    [projects],
  );

  const trees = useMemo(() => buildTrees(threads), [threads]);
  const { focus, archive } = useMemo(
    () =>
      partitionTrees(trees, {
        now,
        focusHours: prefs.focusHours,
        showAutomations: prefs.showAutomations,
      }),
    [trees, now, prefs.focusHours, prefs.showAutomations],
  );
  const archiveOpenCount = archive.filter((tree) => !tree.thread.isArchived).length;
  const archiveHasUnread = archive.some(treeHasUnread);

  const toggle = useCallback((threadId: string) => {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(threadId)) next.delete(threadId);
      else next.add(threadId);
      return next;
    });
  }, []);

  const localMatches = useMemo(() => {
    if (!searching) return [];
    return threads
      .filter(
        (thread) =>
          !thread.isHidden &&
          threadMatches(thread, tokens, projectNames.get(thread.projectId)),
      )
      .sort((a, b) => lastActivityOf(b) - lastActivityOf(a));
  }, [searching, threads, tokens, projectNames]);
  const { hits, loading } = useMessageSearch(searching ? query : "");
  const messageHits = useMemo(() => {
    const shown = new Set(localMatches.map((thread) => thread.id));
    return hits.filter(
      (hit) => !shown.has(hit.threadId) && (prefs.showClosed || !hit.archived),
    );
  }, [hits, localMatches, prefs.showClosed]);

  const rowProps = {
    now,
    activeThreadId,
    expandedIds,
    onToggle: toggle,
    onNavigate,
  };

  let body: ReactNode;
  if (status === "loading" && threads.length === 0) {
    body = <EmptyNote>Loading threads…</EmptyNote>;
  } else if (status === "error" && threads.length === 0) {
    body = <EmptyNote>Could not load threads.</EmptyNote>;
  } else if (searching) {
    body = (
      <>
        {localMatches.length > 0 ? <GroupHeader>Threads</GroupHeader> : null}
        {localMatches.map((thread) => (
          <ThreadRow
            key={thread.id}
            tree={{ thread, children: [], lastActivity: lastActivityOf(thread), isLive: false }}
            depth={0}
            now={now}
            timeStyle="age"
            activeThreadId={activeThreadId}
            projectName={projectNames.get(thread.projectId)}
            expanded={false}
            onToggle={toggle}
            onNavigate={onNavigate}
          />
        ))}
        {messageHits.length > 0 ? <GroupHeader>In messages</GroupHeader> : null}
        {messageHits.map((hit) => (
          <MessageHitRow
            key={hit.threadId}
            hit={hit}
            now={now}
            activeThreadId={activeThreadId}
            projectName={projectNames.get(hit.projectId)}
            onNavigate={onNavigate}
          />
        ))}
        {loading ? <EmptyNote>Searching messages…</EmptyNote> : null}
        {!loading && localMatches.length === 0 && messageHits.length === 0 ? (
          <EmptyNote>
            Nothing matches “{query.trim()}”.
            {!prefs.showClosed ? " Closed threads are not searched — turn on Closed in Archive." : ""}
          </EmptyNote>
        ) : null}
      </>
    );
  } else if (tab === "focus") {
    body =
      focus.length === 0 ? (
        <EmptyNote>
          Nothing active in the last {prefs.focusHours}h.
          {archive.length > 0 ? " Older threads are in Archive." : ""}
        </EmptyNote>
      ) : (
        focus.map((tree) => (
          <TreeRows
            key={tree.thread.id}
            {...rowProps}
            tree={tree}
            depth={0}
            timeStyle="age"
            projectName={projectNames.get(tree.thread.projectId)}
          />
        ))
      );
  } else {
    const visible = archive.slice(0, archiveLimit);
    const groups = groupByDay(visible, now);
    body = (
      <>
        {groups.length === 0 ? (
          <EmptyNote>
            {prefs.showClosed
              ? "No older or closed threads."
              : `No threads older than ${prefs.focusHours}h.`}
          </EmptyNote>
        ) : null}
        {groups.map((group) => (
          <section key={group.key} aria-label={group.label}>
            <GroupHeader>{group.label}</GroupHeader>
            {group.trees.map((tree) => (
              <TreeRows
                key={tree.thread.id}
                {...rowProps}
                tree={tree}
                depth={0}
                timeStyle="clock"
                projectName={projectNames.get(tree.thread.projectId)}
              />
            ))}
          </section>
        ))}
        {archive.length > archiveLimit ? (
          <ShowMore onClick={() => setArchiveLimit((limit) => limit + ARCHIVE_PAGE)}>
            Show {Math.min(ARCHIVE_PAGE, archive.length - archiveLimit)} more
          </ShowMore>
        ) : wantsClosed && archivedPages?.hasNextPage ? (
          <ShowMore
            disabled={archivedPages.isFetchingNextPage}
            onClick={() => void archivedPages.fetchNextPage()}
          >
            {archivedPages.isFetchingNextPage ? "Loading…" : "Show more closed threads"}
          </ShowMore>
        ) : null}
      </>
    );
  }

  return (
    <div className="flex min-h-full flex-col">
      <div className="sticky top-0 z-10 flex flex-col gap-1.5 bg-sidebar px-2 pb-1.5 pt-1">
        <SearchBox value={query} onChange={setQuery} />
        {!searching ? (
          <div className="flex items-center gap-1" role="tablist" aria-label="Thread lists">
            <TabButton
              selected={tab === "focus"}
              onClick={() => setTab("focus")}
              badge={<Count value={focus.length} />}
            >
              Focus
            </TabButton>
            <TabButton
              selected={tab === "archive"}
              onClick={() => setTab("archive")}
              badge={<Count value={archiveOpenCount} dot={archiveHasUnread} />}
            >
              Archive
            </TabButton>
            <span className="flex-1" />
            {tab === "focus" ? (
              <label
                className="flex h-6 cursor-pointer items-center gap-1 rounded px-1.5 text-xs text-muted-foreground hover:text-sidebar-foreground"
                title="Let automation threads into Focus. Off: they stay in Archive unless they wait for you"
              >
                <input
                  type="checkbox"
                  className="size-3 accent-current"
                  checked={prefs.showAutomations}
                  onChange={(event) => setPrefs({ showAutomations: event.target.checked })}
                />
                Auto
              </label>
            ) : null}
            {tab === "archive" ? (
              <label
                className="flex h-6 cursor-pointer items-center gap-1 rounded px-1.5 text-xs text-muted-foreground hover:text-sidebar-foreground"
                title="Also list threads you closed (bb's Archived)"
              >
                <input
                  type="checkbox"
                  className="size-3 accent-current"
                  checked={prefs.showClosed}
                  onChange={(event) => setPrefs({ showClosed: event.target.checked })}
                />
                Closed
              </label>
            ) : null}
            <select
              aria-label="Focus window"
              title="Threads active within this window stay in Focus"
              value={prefs.focusHours}
              onChange={(event) => setPrefs({ focusHours: Number(event.target.value) })}
              className="h-6 cursor-pointer rounded bg-transparent px-1 text-xs text-muted-foreground hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sidebar-ring"
            >
              {[...new Set<number>([...FOCUS_HOUR_CHOICES, prefs.focusHours])]
                .sort((a, b) => a - b)
                .map((hours) => (
                  <option key={hours} value={hours}>
                    {hours}h
                  </option>
                ))}
            </select>
          </div>
        ) : null}
      </div>
      <div className="flex flex-col px-1 pb-4">{body}</div>
    </div>
  );
}

function ShowMore({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="mx-1 mt-2 h-7 rounded-md text-xs text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground disabled:opacity-50"
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Thread header: one-click close

function HeaderCloseButton({ threadId }: PluginThreadHeaderActionProps) {
  const { threads } = useSidebarThreads();
  const thread = threads.find((candidate) => candidate.id === threadId);
  if (thread === undefined || thread.isArchived) return null;
  return <HeaderCloseButtonFor thread={thread} />;
}

function HeaderCloseButtonFor({ thread }: { thread: PluginSidebarThread }) {
  const action = useCloseAction(thread);
  if (action === null) return null;
  return (
    <button
      type="button"
      aria-label="Close thread"
      title="Close thread (archive) — reopen it any time from Archive"
      disabled={action.disabled}
      onClick={() => void action.run()}
      className="flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-40"
    >
      <Icon name="Archive" className="size-3.5" aria-hidden />
      <span className="max-sm:hidden">Close</span>
    </button>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_threadList({
    id: "focus",
    title: "Focus",
    description:
      "Recent threads in Focus, older ones in a dated Archive, with search and one-click close.",
    component: FocusThreadList,
  });
  app.slots.experimental_threadHeaderAction({
    id: "close",
    title: "Close thread",
    component: HeaderCloseButton,
  });
});
