import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildTrees,
  clampFocusHours,
  dayLabel,
  formatAge,
  groupByDay,
  HOUR_MS,
  normalizeQuery,
  partitionTrees,
  threadMatches,
  type FocusThread,
} from "../lib/focus.ts";

const NOW = new Date(2026, 9, 25, 18, 0, 0).getTime();

function thread(id: string, hoursAgo: number, extra: Partial<FocusThread> = {}): FocusThread {
  const time = NOW - hoursAgo * HOUR_MS;
  return {
    id,
    parentThreadId: null,
    projectId: "proj",
    originPluginId: null,
    displayTitle: `Thread ${id}`,
    status: "idle",
    hasPendingInteraction: false,
    queuedWork: "none",
    isUnread: false,
    isPinned: false,
    isArchived: false,
    isHidden: false,
    archivedAt: null,
    createdAt: time,
    updatedAt: time,
    latestAttentionAt: time,
    environment: null,
    ...extra,
  };
}

const split = (threads: FocusThread[]) => {
  const { focus, automations, archive } = partitionTrees(buildTrees(threads), {
    now: NOW,
    focusHours: 8,
  });
  const ids = (trees: typeof focus) => trees.map((t) => t.thread.id);
  return { focus: ids(focus), automations: ids(automations), archive: ids(archive) };
};

test("recent threads stay in Focus, older ones go to Archive", () => {
  assert.deepEqual(split([thread("a", 1), thread("b", 7.9), thread("c", 9), thread("d", 50)]), {
    focus: ["a", "b"],
    automations: [],
    archive: ["c", "d"],
  });
});

test("running, waiting, queued and pinned threads stay in Focus", () => {
  const result = split(
    [
      thread("run", 30, { status: "active" }),
      thread("ask", 30, { hasPendingInteraction: true }),
      thread("queue", 30, { queuedWork: "waiting" }),
      thread("pin", 30, { isPinned: true }),
      thread("old", 30),
    ],
  );
  assert.deepEqual(result.archive, ["old"]);
  assert.equal(result.focus[0], "pin");
  assert.equal(result.focus.length, 4);
});

test("recent automation threads fold into their own group, quiet ones go to Archive", () => {
  const auto = { originPluginId: "automations" };
  const result = split([
    thread("recent", 0.1, auto),
    thread("running", 30, { ...auto, status: "active" }),
    thread("quiet", 30, auto),
    thread("asks", 0.1, { ...auto, hasPendingInteraction: true }),
    thread("pinned", 30, { ...auto, isPinned: true }),
    thread("mine", 0.1),
  ]);
  assert.deepEqual(result.focus.sort(), ["asks", "mine", "pinned"]);
  assert.deepEqual(result.automations.sort(), ["recent", "running"]);
  assert.deepEqual(result.archive, ["quiet"]);
});

test("automation threads behave like any other with showAutomations on", () => {
  const { focus, automations } = partitionTrees(
    buildTrees([thread("recent", 1, { originPluginId: "automations" })]),
    { now: NOW, focusHours: 8, showAutomations: true },
  );
  assert.deepEqual(focus.map((t) => t.thread.id), ["recent"]);
  assert.deepEqual(automations, []);
});

test("closed threads always go to Archive", () => {
  assert.deepEqual(split([thread("x", 1, { isArchived: true, archivedAt: NOW })]).archive, ["x"]);
});

test("a recent child keeps its parent tree in Focus", () => {
  const trees = buildTrees([thread("parent", 40), thread("child", 1, { parentThreadId: "parent" })]);
  assert.equal(trees.length, 1);
  assert.equal(trees[0].children[0].thread.id, "child");
  assert.deepEqual(split([thread("parent", 40), thread("child", 1, { parentThreadId: "parent" })]).focus, [
    "parent",
  ]);
});

test("orphans become roots and hidden threads drop out", () => {
  const trees = buildTrees([
    thread("orphan", 1, { parentThreadId: "missing" }),
    thread("hidden", 1, { isHidden: true }),
  ]);
  assert.deepEqual(trees.map((t) => t.thread.id), ["orphan"]);
});

test("archive groups by local day, newest first", () => {
  const groups = groupByDay(
    buildTrees([thread("a", 10), thread("b", 20), thread("c", 30), thread("d", 24 * 20)]),
    NOW,
    "en-US",
  );
  assert.deepEqual(
    groups.map((g) => [g.label, g.trees.map((t) => t.thread.id)]),
    [
      ["Today", ["a"]],
      ["Yesterday", ["b", "c"]],
      ["October 5", ["d"]],
    ],
  );
});

test("day labels use weekdays within a week", () => {
  assert.equal(dayLabel(NOW - 3 * 24 * HOUR_MS, NOW, "en-US"), "Thursday");
});

test("ages are compact", () => {
  assert.equal(formatAge(NOW - 10_000, NOW), "now");
  assert.equal(formatAge(NOW - 5 * 60_000, NOW), "5m");
  assert.equal(formatAge(NOW - 3 * HOUR_MS, NOW), "3h");
  assert.equal(formatAge(NOW - 3 * 24 * HOUR_MS, NOW, "en-US"), "Thu");
});

test("search matches every token across title, project and branch", () => {
  const t = thread("a", 1, {
    displayTitle: "Fix login crash",
    environment: { branchName: "feature/auth", name: null },
  });
  assert.ok(threadMatches(t, normalizeQuery("login AUTH"), "Drinkit"));
  assert.ok(threadMatches(t, normalizeQuery("drinkit crash"), "Drinkit"));
  assert.ok(!threadMatches(t, normalizeQuery("login payments"), "Drinkit"));
  assert.ok(threadMatches(t, [], undefined));
});

test("focus hours are clamped", () => {
  assert.equal(clampFocusHours(0), 1);
  assert.equal(clampFocusHours(500), 168);
  assert.equal(clampFocusHours("6"), 6);
  assert.equal(clampFocusHours("nope"), 8);
});
