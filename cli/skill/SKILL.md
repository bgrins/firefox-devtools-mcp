---
name: firefox-cli
description: Automate Firefox from the terminal - navigate pages, inspect snapshots, click and fill elements, run JS, and check console/network activity.
allowed-tools: Bash(firefox-cli:*)
---

# Browser automation with firefox-cli

Every command is a one-shot process; browser state (tabs, snapshots, console,
network) persists in the running instance between commands.

## Quick start

```bash
firefox-cli launch --headless      # once; prints instance id + endpoint
firefox-cli open https://example.com
firefox-cli find "Sign in"         # locate elements cheaply (preferred)
firefox-cli click 1_4              # uids come from find/snapshot output
firefox-cli eval "() => document.title"
firefox-cli stop                   # when done
```

## Finding and interacting with elements

Prefer `find` over `snapshot` — it returns only matching lines with context:

```bash
firefox-cli find "Add to cart"
firefox-cli find --regex "/sign (in|up)/i"
firefox-cli find "Price" --context 4
# full tree when you really need it (can be large):
firefox-cli snapshot
firefox-cli snapshot --selector "#main-form"
```

Interact using the `N_M` uids shown in find/snapshot output:

```bash
firefox-cli click 2_7
firefox-cli hover 2_7
firefox-cli fill 2_9 "user@example.com"
firefox-cli eval "(el) => el.getAttribute('data-testid')" 2_7
```

Each `find`/`snapshot` takes a fresh snapshot and invalidates all earlier
uids — always use uids from your most recent `find`/`snapshot` output.

## Navigation and tabs

```bash
firefox-cli goto https://example.com/checkout
firefox-cli back
firefox-cli forward
firefox-cli pages            # list tabs; > marks the selected one
firefox-cli open <url>       # new tab
firefox-cli tab-select 0
firefox-cli tab-close 1
```

## Inspecting the page

```bash
firefox-cli eval "() => document.title"
firefox-cli console          # console messages
firefox-cli requests         # network requests since page load
firefox-cli screenshot       # saves a png, prints the path
```

## Anything else

The full MCP tool surface is reachable without a dedicated subcommand:

```bash
firefox-cli tools                                  # list all tools
firefox-cli call resize_viewport '{"width":1280,"height":720}'
```

## Instances

`launch` starts a managed Firefox; most commands auto-select the single
running instance. With several running, pass `--instance <id>`.

```bash
firefox-cli servers          # list instances and status
firefox-cli logs --lines 50  # runner log for debugging
firefox-cli stop
```

Failed commands exit 1 with the error on stdout/stderr. Add `--json` for the
raw MCP result payload.
