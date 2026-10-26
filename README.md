# Focus Sidebar for bb

Keep only the threads you are working on right now in the [bb](https://getbb.app) sidebar.

Focus Sidebar replaces bb's thread list with two tabs:

- **Focus** shows the threads with activity in the last few hours (8 by default; pick 2, 4, 6, 8, 12 or 24). A thread that is running, waiting for your answer, has a queued message, or is pinned always stays in Focus, however old it is.
- Threads that bb's automations run on a schedule fold into an **Automations** group at the bottom of Focus, so a job that ticks every few minutes doesn't fill the list. Click the group to unfold it. An automation thread that waits for your answer, or that you pinned, moves up into Focus; one that went quiet goes to Archive.
- **Archive** shows everything older, grouped by day (Today, Yesterday, the weekday, then the date), newest first. Turn on **Closed** to list the threads you closed too.

Above the tabs is a **search box**. It matches thread titles, project names and branches instantly, then adds matches from message text across open and closed threads, with the matching words highlighted.

Every row has a **close button** (✕ on hover; always visible on touch screens), and the thread header gets a **Close** button. Closing uses bb's own archive, with its Undo toast, and a closed thread can be reopened from Archive → Closed. Right-click or long-press a row for bb's full thread menu.

Nothing is archived automatically. Threads move between Focus and Archive by their last activity only, so worktrees and terminals are never touched until you close a thread yourself.

## Install

In bb, open **Plugins**, search for **Focus Sidebar** and install it. Or from a terminal:

```sh
bb plugin install git:https://github.com/grishaster80/bb-plugin-focus-sidebar.git
```

bb switches the sidebar to Focus Sidebar automatically. To go back to bb's own list, pick it under **Settings → Appearance → Sidebar**, or disable the plugin.

## Settings

The focus window and the Closed switch are in the list header. They are stored on the bb server, so every device that connects to it (desktop, laptop, phone) sees the same setting. The same settings from a terminal:

```sh
bb focus-sidebar show
bb focus-sidebar hours 6        # keep the last 6 hours in Focus
bb focus-sidebar closed on      # list closed threads in Archive
bb focus-sidebar automations on # mix automation threads into Focus instead of folding them
```

## Develop

```sh
npm install
npm test             # list logic: focus window, day groups, search matching
npm run typecheck
bb plugin build      # writes dist/
bb plugin install .  # or `bb plugin dev` to rebuild on save
```

`lib/focus.ts` holds the list logic with no host imports. `app.tsx` is the sidebar UI and the header button, and `server.ts` stores the settings and registers the `bb focus-sidebar` command.

## License

MIT
