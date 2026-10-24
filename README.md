# ClaudeMods

Mods for [Claude Code](https://claude.com/claude-code). Each folder is one mod, and this repository is a marketplace that lists them all.

## Mods

| Mod | What it does |
| --- | --- |
| [cache-timer](./cache-timer) | Counts down the prompt cache's one-hour window in the status line and warns before a large conversation goes cold, so you know when `/clear` saves tokens. |

## Installing a mod

At the prompt of a Claude Code terminal session:

```
/plugin install <mod> --marketplace dcpurnell/ClaudeMods
```

For example, `/plugin install cache-timer --marketplace dcpurnell/ClaudeMods`. Answer `y` to add the marketplace, then pick a scope (user is first; press Enter).

From a shell:

```
claude plugin install <mod> --marketplace dcpurnell/ClaudeMods
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `dcpurnell/ClaudeMods`, then Add plugin.

## cache-timer

The prompt cache keeps your conversation for an hour after the last request, and every request starts that hour over. Once it lapses, your next message pays to re-cache the whole conversation, so that's the cheapest moment to `/clear` or `/compact`.

- **Status line:** `cache: warm · 42m left · ctx 85k`, or `cache: COLD · ctx 85k · /clear saves a re-cache`.
- **Toasts** at 10 minutes left and when the cache goes cold.
- **Cold-submit guard:** the first prompt you type onto a cold cache is held back with the re-cache size. Send it again within 2 minutes to go ahead.
- **`/cache`** prints the current state.

Warnings only fire when the conversation holds 50k tokens or more. Subagent requests don't reset the timer, and `/clear` or `/compact` resets it. The one-hour window is assumed; accounts in usage overage get a 5-minute cache, which the timer doesn't detect. Thresholds are constants at the top of `cache-timer/hooks/register.ts`.

## Adding a mod

Put it in its own folder (with `.claude-plugin/plugin.json`) and add an entry to `.claude-plugin/marketplace.json` with `"source": "./<folder>"`.
