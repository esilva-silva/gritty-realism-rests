# Gritty Realism Rests

A Foundry VTT module for **D&D 5e** that replaces the Short Rest / Long Rest pair with a single
**Take Rest** action and a per-expenditure recovery ledger.

There is no choice between a short and a long rest. There is only rest: eight hours of it. What
separates a cantrip-adjacent class feature from a fireball is no longer *which* rest you take,
but *how many* rests have passed since you spent it.

- **1 Rest = 8 hours.**
- Short-rest resources return after **1 Rest**.
- Long-rest resources return after **7 Rests**.
- Every individual expenditure carries its own timer. Two level-3 slots spent three rests apart
  come back three rests apart.

| Requires | Version |
| --- | --- |
| Foundry VTT | 13 (verified against build 351) |
| D&D 5e system | 5.2.x (verified against 5.2.5) |
| Midi-QOL | optional |
| Token Action HUD | optional |

---

## Installation

Paste the manifest URL into Foundry's **Add-on Modules → Install Module** dialog:

```
https://github.com/esilva-silva/gritty-realism-rests/releases/latest/download/module.json
```

This needs at least one published release to exist. Note that the URL must be the manifest
itself — a `github.com/.../blob/...` link serves an HTML page, and Foundry will reject it with
`Unexpected token '<'`.

### From source

Copy this folder into your Foundry data directory as `Data/modules/gritty-realism-rests` and
restart. Foundry reads `module.json` off disk, so no manifest, release or zip is involved. This
is the quicker loop while developing.

### Cutting a release

Tag and push; the workflow in [`.github/workflows/release.yml`](.github/workflows/release.yml)
stamps the version into the manifest, runs the domain tests, and publishes `module.json` and a
`module.zip` whose root holds the manifest:

```bash
git tag v1.0.0 && git push origin v1.0.0
```

After enabling the module, set the system's own **Rest Variant** to **Normal**
(*Configure Settings → D&D 5e → Rest Variant*). The module controls rest pacing itself, and
dnd5e's own gritty variant multiplies daily recharge formulas by seven — leaving both on applies
the houserule twice. The module warns you once if it spots this.

---

## How it works

### Taking a rest

The Short and Long Rest buttons are gone. In their place, a single moon button sits in the sheet
header. Clicking it opens a preview:

```
Rest Index: 12                          After this rest: 13

Will recover
  + Action Surge

Will progress
  Level 3 Spell Slot        2 → 1 rests
  Rage                      5 → 4 rests
```

You may spend hit dice from the same dialog before committing. Confirming advances the rest
index by one, restores everything that has matured, and posts the system's own rest card with
the module's summary attached.

### The ledger

Each expenditure becomes an independent record. Nothing is aggregated, because aggregation is
exactly what destroys the timers:

```
Rest 10  →  Action Surge     →  recovers at 11
Rest 10  →  Spell Slot L3    →  recovers at 17
Rest 13  →  Spell Slot L3    →  recovers at 20
```

The sheet panel and the GM ledger both show these separately.

### Hit points

Two modes, selectable in settings.

**Recovery Debt** (default). Damage becomes debt. Healing pays it down oldest-first, and
whatever is still owed when its cooldown elapses is handed back at the next rest:

```
HP 60/60  →  take 20 damage  →  debt 20, matures in 7 rests
             heal 10         →  debt 10
             7 rests later   →  10 hit points restored
```

Temporary hit points never create debt and never pay it off.

**Gritty Standard.** No debt is tracked. Hit points come back from hit dice, plus a full heal
every 7 rests.

### Recovery periods

| dnd5e period | Rests | Setting |
| --- | --- | --- |
| Short Rest (`sr`) | 1 | Short Rest cooldown |
| Long Rest (`lr`) | 7 | Long Rest cooldown |
| Day / Dawn / Dusk | 1 | Daily cooldown |
| Hit Dice | 14 | Hit Dice cooldown |

Recharge rolls and the per-turn periods (`turn`, `turnStart`, `turnEnd`, `initiative`) are left
entirely to the system — they are already short-lived, and intercepting them would be wrong.

Nothing is hardcoded to a feature name. Whether something is a short- or long-rest resource is
read from the item's own recovery data, so homebrew, third-party content and future system
features work without a module update. Spell slots are classified by their type, so pact magic
is a short-rest resource and everything else is a long-rest one.

---

## Configuration

| Setting | Default | Notes |
| --- | --- | --- |
| Short / Long / Daily / Hit Dice cooldown | 1 / 7 / 1 / 14 | Rests per recovery period. |
| Hit point mode | Recovery Debt | Or Gritty Standard. |
| Rest duration | 480 minutes | Used when advancing the world clock. |
| Players may take rests | on | When off, only a GM can start one. |
| Hide native rests | on | Removes the buttons and blocks the system flow. |
| Token Action HUD integration | on | Adds Take Rest, suppresses the native rest actions. |
| Rest summary in chat | on | |
| Exhaustion change per rest | 0 | Set `-1` to mirror long-rest behaviour. |
| Track manual expenditures | on | Catches sheet pips and direct edits. |
| Track GM direct edits | off | When off, a GM editing a sheet is a correction, not a spend. |
| Log level | Error | Console verbosity. |

### Per-item overrides

Set `flags.gritty-realism-rests.recovery` on an item or an activity to override its cooldown:

```js
await item.setFlag("gritty-realism-rests", "recovery", { mode: "custom", restCount: 3 });
await item.setFlag("gritty-realism-rests", "recovery", { mode: "disabled" });
```

An activity-level override beats an item-level one.

---

## Integration

### Midi-QOL

**Nothing to configure.** Midi-QOL's activity mixin delegates to the system's own
`ActivityMixin#use`, which fires `dnd5e.postActivityConsumption` exactly once per usage — with
or without Midi installed. The module reads that single hook, so automated attacks and spells
are tracked identically to sheet clicks, and no expenditure is counted twice.

Midi's undo restores resources through ordinary document updates, which the module reconciles
against the ledger automatically. No Midi internals are touched.

### Token Action HUD

Take Rest is added to the HUD's rest group and the native Short/Long Rest actions are removed.
Only TAH's documented extension points are used (`tokenActionHudCoreApiReady` and the two
extender hooks); nothing in TAH or its dnd5e module is patched. If the HUD is absent or its API
changes shape, the integration silently disables itself.

---

## API

```js
const api = game.modules.get("gritty-realism-rests").api;

await api.takeRest(actor);                  // rest, no prompt
await api.promptRest(actor);                // preview dialog, then rest
await api.advanceRests(actor, 4);           // four rests, processed in sequence
await api.partyRest([a, b, c]);             // each keeps its own ledger
await api.promptPartyRest();                // pick from owned actors

api.previewRest(actor);                     // what a rest would do
api.getRecoveryState(actor);                // index, ready, recovering, debt
api.getPendingRecoveries(actor);            // raw ledger entries
api.getDebt(actor);                         // hit points still owed
api.canTakeRest(actor);                     // { allowed, reason? }

await api.mutate(actor, "setRestIndex", { restIndex: 20 });
await api.resetState(actor);
```

Contribute a custom rule when derived data is not enough. Return `null` to defer to the normal
resolution order:

```js
api.registerRecoveryRule("my-module.chef-feat", ({ item }) => {
  if ( item?.name !== "Chef" ) return null;
  return { period: "sr", restCount: 2 };
});
```

### Hooks

| Hook | Arguments | Notes |
| --- | --- | --- |
| `grittyRealism.preRest` | `(actor, preview)` | Return `false` to cancel. |
| `grittyRealism.restComplete` | `(actor, report)` | |
| `grittyRealism.resourceSpent` | `(actor, entry)` | Once per expenditure. |
| `grittyRealism.resourceRecovered` | `(actor, entry)` | Once per matured entry. |

`dnd5e.restCompleted` also fires for every Take Rest, so modules that already listen for rests
keep working.

---

## Troubleshooting

**A resource never comes back.** Open the GM ledger (the scroll icon in the sheet panel) and
check whether an entry exists for it. If the entry is there but the maturity index looks wrong,
the item probably declares an unexpected recovery period; set a per-item override.

**A resource comes back too early, or twice.** Check whether another module also restores it.
The module clamps every recovery to the actor's maximum, so a double-restore cannot push a value
above its cap, but the ledger entry will look consumed either way.

**Spending a resource records nothing.** Confirm *Track manual expenditures* is on. If you are
the GM, note that *Track GM direct edits* is off by default — a GM editing a sheet is treated as
a correction. Set it on if your GM plays a character too.

**The Take Rest button is missing.** It only appears for actors you own, and never on vehicles
or groups.

**"No GM is connected."** Ledger writes are performed by the active GM so that concurrent
clients cannot race. A player cannot rest while no GM is online.

**Rests seem to advance twice.** They cannot: each rest carries an id, and a repeat of the same
id resolves to the rest that already happened. If the index really did jump, check whether a
macro is calling `advanceRests`.

Set the log level to **Debug** for a running commentary prefixed with `[Gritty Realism]`.

---

## Development

The domain layer — the ledger arithmetic, the debt model, state normalization — is pure and runs
outside Foundry:

```bash
node test/domain.test.mjs
```

Layering is deliberate: `domain/` and `data/` never import from `ui/` or `adapters/`. Everything
that knows a dnd5e key path lives in `adapters/dnd5e-adapter.mjs`.

## License

MIT. See [LICENSE](LICENSE).
