/**
 * Standalone harness for the pure domain layer. Stubs the few Foundry globals those modules
 * touch, then runs the canonical scenarios from the specification.
 */

let seq = 0;
globalThis.foundry = {
  utils: {
    randomID: () => `id${++seq}`,
    getProperty: (obj, path) => path.split(".").reduce((o, k) => o?.[k], obj),
    mergeObject: (a, b) => ({ ...a, ...b }),
    flattenObject: o => o,
    isEmpty: o => !o || (Object.keys(o).length === 0),
    deepClone: o => structuredClone(o)
  },
  data: { fields: {} }
};

const SETTINGS_VALUES = {
  shortRestCount: 1,
  longRestCount: 7,
  dailyRestCount: 1,
  hitDiceRestCount: 14,
  hpMode: "debt",
  debtOrder: "fifo",
  autoRecoverDamage: true,
  restDuration: 480,
  logLevel: "off"
};

// Foundry adds this to Math; the domain layer is entitled to rely on it.
Math.clamp ??= (n, min, max) => Math.min(Math.max(n, min), max);

globalThis.game = {
  time: { worldTime: 0 },
  settings: { get: (_mod, key) => SETTINGS_VALUES[key] },
  i18n: { localize: k => k, format: (k, d) => `${k}:${JSON.stringify(d)}` }
};

const BASE = new URL("../scripts", import.meta.url).href;
const { blankState, makeEntry, normalizeState } = await import(`${BASE}/domain/models.mjs`);
const tracker = await import(`${BASE}/domain/recovery-tracker.mjs`);
const debt = await import(`${BASE}/domain/hp-debt.mjs`);

let failures = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n        expected ${e}\n        actual   ${a}`}`);
}

const slot3 = { kind: "spellSlot", keyPath: "system.spells.spell3.value", key: "spell3" };
const surge = { kind: "activityUses", keyPath: "system.activities.abc.uses.spent", key: "i1.abc", itemId: "i1", activityId: "abc" };

const spend = (state, resource, restCount, label, period = "lr") => makeEntry({
  resource, amount: 1, policy: { period, restCount, source: "test" },
  restIndex: state.restIndex, label
});

console.log("\n--- Spec item 42: canonical scenario ---");
{
  let state = blankState();
  state = tracker.record(state, [spend(state, surge, 1, "Action Surge")]).state;
  state = tracker.record(state, [spend(state, slot3, 7, "Fireball")]).state;

  check("Action Surge recovers at index 1", state.entries[0].recoverAtRestIndex, 1);
  check("Level 3 slot recovers at index 7", state.entries[1].recoverAtRestIndex, 7);

  let r = tracker.mature(state, 1);
  check("rest 1 recovers only Action Surge", r.recovered.map(e => e.label), ["Action Surge"]);
  check("Fireball still pending", r.pending.map(e => e.label), ["Fireball"]);
  check("Fireball shows 6 rests left", tracker.summarizePending(r.pending, 1)[0].remaining, 6);

  state = r.state;
  for (let i = 2; i <= 6; i++) {
    r = tracker.mature(state, i);
    check(`rest ${i} recovers nothing`, r.recovered.length, 0);
    state = r.state;
  }
  r = tracker.mature(state, 7);
  check("rest 7 recovers the slot", r.recovered.map(e => e.label), ["Fireball"]);
  check("ledger is empty afterwards", r.state.entries.length, 0);
}

console.log("\n--- Spec item 12: independent timers for identical resources ---");
{
  let state = blankState();
  state = { ...state, restIndex: 10 };
  state = tracker.record(state, [spend(state, surge, 1, "Action Surge")]).state;
  state = tracker.record(state, [spend(state, slot3, 7, "Slot A")]).state;
  state = { ...state, restIndex: 13 };
  state = tracker.record(state, [spend(state, slot3, 7, "Slot B")]).state;

  check("recover indices are 11, 17, 20",
    state.entries.map(e => e.recoverAtRestIndex), [11, 17, 20]);

  const lines = tracker.summarizePending(state.entries.filter(e => e.resource.key === "spell3"), 13);
  check("two separate maturity lines for the same slot level", lines.length, 2);
  check("each line carries one slot", lines.map(l => l.amount), [1, 1]);
}

console.log("\n--- groupByResource: two slots of a level are one +2 write ---");
{
  let state = blankState();
  state = tracker.record(state, [spend(state, slot3, 7, "Slot A")]).state;
  state = tracker.record(state, [spend(state, slot3, 7, "Slot B")]).state;
  const groups = tracker.groupByResource(tracker.mature(state, 7).recovered);
  check("one group", groups.length, 1);
  check("amount summed to 2", groups[0].amount, 2);
}

console.log("\n--- reconcile: a refund cancels the newest expenditure ---");
{
  let state = blankState();
  state = tracker.record(state, [spend(state, slot3, 7, "Slot A")]).state;
  state = { ...state, restIndex: 3 };
  state = tracker.record(state, [spend(state, slot3, 7, "Slot B")]).state;
  const r = tracker.reconcile(state, slot3, 1);
  check("one entry removed", r.removed.length, 1);
  check("the newest one was removed", r.removed[0].label, "Slot B");
  check("the older entry survives", r.state.entries.map(e => e.label), ["Slot A"]);
}

console.log("\n--- dedupe: the same expenditure is never recorded twice ---");
{
  let state = blankState();
  const e = makeEntry({
    resource: slot3, amount: 1, policy: { period: "lr", restCount: 7, source: "t" },
    restIndex: 0, label: "Slot", dedupeKey: "token|path"
  });
  state = tracker.record(state, [e]).state;
  const second = tracker.record(state, [{ ...e, id: "other" }]);
  check("duplicate rejected", second.added.length, 0);
  check("ledger still has one entry", second.state.entries.length, 1);
}

console.log("\n--- Spec items 13/14: Recovery Debt ---");
{
  const actor = { system: { attributes: { hp: { value: 40, max: 60, effectiveMax: 60 } } } };
  let state = blankState();

  state = debt.incurDebt(state, 20);
  check("debt of 20 recorded", debt.totalDebt(state), 20);
  check("matures after 7 rests", state.debt[0].recoverAtRestIndex, 7);

  const paid = debt.payDebt(state, 10);
  check("healing 10 pays 10", paid.paid, 10);
  check("10 still owed", debt.totalDebt(paid.state), 10);

  let r = debt.processRest(actor, paid.state, 6);
  check("nothing at rest 6", r.healed, 0);
  check("debt untouched at rest 6", debt.totalDebt(r.state), 10);

  r = debt.processRest(actor, paid.state, 7);
  check("rest 7 restores 10 hp", r.healed, 10);
  check("hp update targets value", r.updateData, { "system.attributes.hp.value": 50 });
  check("debt cleared", debt.totalDebt(r.state), 0);
}

console.log("\n--- Debt is FIFO and clamps to max hp ---");
{
  const actor = { system: { attributes: { hp: { value: 55, max: 60, effectiveMax: 60 } } } };
  let state = blankState();
  state = debt.incurDebt(state, 10);
  state = { ...state, restIndex: 2 };
  state = debt.incurDebt(state, 30);

  const paid = debt.payDebt(state, 15);
  check("oldest entry cleared first", paid.state.debt.length, 1);
  check("25 remains on the newer entry", debt.totalDebt(paid.state), 25);

  const r = debt.processRest(actor, paid.state, 9);
  check("healing clamped to max", r.updateData, { "system.attributes.hp.value": 60 });
  check("healed only the 5 missing", r.healed, 5);
}

console.log("\n--- Debt order is configurable: LIFO leaves old wounds ageing ---");
{
  SETTINGS_VALUES.debtOrder = "lifo";
  let state = blankState();
  state = debt.incurDebt(state, 10);          // old wound, matures at rest 7
  state = { ...state, restIndex: 5 };
  state = debt.incurDebt(state, 30);          // fresh wound, matures at rest 12

  const paid = debt.payDebt(state, 15);
  check("healing still totals 15", paid.paid, 15);
  check("the fresh wound absorbed it", paid.state.debt.map(e => e.remaining), [10, 15]);
  check("chronological order preserved",
    paid.state.debt.map(e => e.recoverAtRestIndex), [7, 12]);

  SETTINGS_VALUES.debtOrder = "fifo";
  const fifo = debt.payDebt(state, 15);
  check("FIFO clears the old wound instead", fifo.state.debt.map(e => e.remaining), [25]);
}

console.log("\n--- Each expenditure is its own line, even for identical resources ---");
{
  let state = blankState();
  state = tracker.record(state, [spend(state, slot3, 7, "Level 1 Spell Slot")]).state;
  state = tracker.record(state, [spend(state, slot3, 7, "Level 1 Spell Slot")]).state;
  state = tracker.record(state, [spend(state, surge, 1, "Action Surge", "sr")]).state;

  const lines = tracker.summarizePending(state.entries, 0);
  const slotLines = lines.filter(l => l.label === "Level 1 Spell Slot");
  check("two slots produce two lines, not one of amount 2", slotLines.length, 2);
  check("each line stands for a single expenditure", slotLines.map(l => l.amount), [1, 1]);
  check("every line carries its own entry id",
    lines.every(l => state.entries.some(e => e.id === l.id)), true);
  check("and the recovery period travels with it",
    lines.map(l => l.group).sort(), ["long", "long", "short"]);

  // Applying recovery still groups, or two entries would fight over one key path.
  const groups = tracker.groupByResource(state.entries.filter(e => e.resource.key === "spell3"));
  check("but recovery still writes once, for 2", [groups.length, groups[0].amount], [1, 2]);
}

console.log("\n--- shift moves maturity, never earlier than the current rest ---");
{
  let state = blankState();
  state = { ...state, restIndex: 4 };
  state = tracker.record(state, [spend(state, slot3, 7, "Slot")]).state;
  const id = state.entries[0].id;
  check("starts at 11", state.entries[0].recoverAtRestIndex, 11);

  check("+1 pushes it out", tracker.shift(state, [id], 1).entries[0].recoverAtRestIndex, 12);
  check("-1 brings it closer", tracker.shift(state, [id], -1).entries[0].recoverAtRestIndex, 10);

  // Clamping matters: an entry scheduled before the current index would never mature,
  // because maturity is evaluated against restIndex + 1 on the next rest.
  let clamped = state;
  for ( let i = 0; i < 20; i++ ) clamped = tracker.shift(clamped, [id], -1);
  check("cannot be pushed before the current index", clamped.entries[0].recoverAtRestIndex, 4);
  check("and so it matures on the very next rest", tracker.mature(clamped, 5).recovered.length, 1);
}

console.log("\n--- A poor night holds back long-rest cooldowns only ---");
{
  const FULL = new Set(["short", "long", "day", "hitDice", "other"]);
  const POOR = new Set(["short", "day", "hitDice", "other"]);   // long deliberately absent

  let state = blankState();
  state = tracker.record(state, [spend(state, surge, 1, "Action Surge", "sr")]).state;
  state = tracker.record(state, [spend(state, slot3, 7, "Fireball", "lr")]).state;

  // A good night: both advance, and the short-rest resource matures at once.
  const good = tracker.mature(tracker.holdUncredited(state, FULL).state, 1);
  check("full rest recovers the short-rest resource", good.recovered.map(e => e.label), ["Action Surge"]);
  check("full rest brings the slot to 6 away",
    tracker.summarizePending(good.pending, 1)[0].remaining, 6);

  // A poor night: the same short-rest resource still comes back, the slot does not budge.
  const bad = tracker.holdUncredited(state, POOR);
  check("one entry was held", bad.held, 1);
  const badResult = tracker.mature(bad.state, 1);
  check("poor rest still recovers the short-rest resource",
    badResult.recovered.map(e => e.label), ["Action Surge"]);
  check("but the slot is still 7 away, not 6",
    tracker.summarizePending(badResult.pending, 1)[0].remaining, 7);
}

console.log("\n--- A long-rest cooldown due tonight does not slip through a poor night ---");
{
  const POOR = new Set(["short", "day", "hitDice", "other"]);
  let state = blankState();
  state = tracker.record(state, [spend(state, slot3, 1, "Slot due next rest", "lr")]).state;
  check("it is due at index 1", state.entries[0].recoverAtRestIndex, 1);

  // Holding must happen before maturing, or the entry would qualify on the way past.
  const held = tracker.holdUncredited(state, POOR);
  const result = tracker.mature(held.state, 1);
  check("nothing recovered", result.recovered.length, 0);
  check("and it is still one rest away", tracker.summarizePending(result.pending, 1)[0].remaining, 1);
}

console.log("\n--- Debt is held on a poor night too ---");
{
  const actor = { system: { attributes: { hp: { value: 30, max: 50, effectiveMax: 50 } } } };
  let state = blankState();
  state = debt.incurDebt(state, 12);
  check("due at rest 7", state.debt[0].recoverAtRestIndex, 7);

  const heldOnce = debt.holdDebt(state);
  check("a poor night pushes it to 8", heldOnce.debt[0].recoverAtRestIndex, 8);
  check("so nothing closes at rest 7", debt.processRest(actor, heldOnce, 7).healed, 0);
  check("while a good night would have closed it", debt.processRest(actor, state, 7).healed, 12);
}

console.log("\n--- Free-standing note entries mature and vanish ---");
{
  let state = blankState();
  const note = makeEntry({
    resource: { kind: "note", keyPath: "", key: "n1" },
    amount: 1,
    policy: { period: "lr", restCount: 3, source: "manual" },
    restIndex: 0,
    label: "Cracked ribs",
    description: "Disadvantage on Strength checks."
  });
  state = tracker.record(state, [note]).state;

  const line = tracker.summarizePending(state.entries, 0)[0];
  check("the description survives normalization", line.description, "Disadvantage on Strength checks.");
  check("and it is grouped as a long-rest cooldown", line.group, "long");

  check("nothing at rest 2", tracker.mature(state, 2).recovered.length, 0);
  const done = tracker.mature(state, 3);
  check("it clears at rest 3", done.recovered.map(e => e.label), ["Cracked ribs"]);
  check("and leaves the ledger empty", done.state.entries.length, 0);

  // The round trip is the part that matters: entries are normalized on every read, and a note
  // has no key path to point at. Skipping this is how a note could be written and then quietly
  // vanish the next time the state was loaded.
  const reloaded = normalizeState(JSON.parse(JSON.stringify(state)));
  check("a note survives being written and read back", reloaded.entries.length, 1);
  check("with its description intact", reloaded.entries[0].description, "Disadvantage on Strength checks.");
  check("and its maturity intact", reloaded.entries[0].recoverAtRestIndex, 3);
}

console.log("\n--- Entries that point nowhere are still discarded ---");
{
  const s = normalizeState({
    entries: [
      { resource: { kind: "itemUses", key: "i" }, amount: 1, policy: { restCount: 7 } },
      { resource: { kind: "spellSlot", keyPath: "", key: "spell1" }, amount: 1, policy: { restCount: 7 } },
      { resource: { kind: "note", key: "n" }, amount: 1, policy: { restCount: 2 }, label: "Curse" }
    ]
  });
  check("a real resource without a key path is dropped", s.entries.length, 1);
  check("only the note survives", s.entries[0].label, "Curse");
}

console.log("\n--- A group with automatic recovery off never matures ---");
{
  const ALL = new Set(["short", "long", "day", "hitDice", "other"]);
  const NO_LONG = new Set(["short", "day", "hitDice", "other"]);

  let state = blankState();
  state = tracker.record(state, [spend(state, surge, 1, "Action Surge", "sr")]).state;
  state = tracker.record(state, [spend(state, slot3, 7, "Fireball", "lr")]).state;

  // With everything automatic, rest 7 hands both back — the surge was due long ago.
  check("automatic: both recover by rest 7",
    tracker.mature(state, 7, ALL).recovered.map(e => e.label).sort(),
    ["Action Surge", "Fireball"]);

  // With long-rest recovery switched off, the slot never comes back on its own.
  const off = tracker.mature(state, 7, NO_LONG);
  check("manual: the long-rest slot is withheld", off.recovered.map(e => e.label), ["Action Surge"]);
  check("and stays in the pending list", off.pending.map(e => e.label), ["Fireball"]);
  check("even far in the future it never matures",
    tracker.mature(state, 99, NO_LONG).recovered.map(e => e.label), ["Action Surge"]);
}

console.log("\n--- A non-recovering entry settles at 0 and is flagged manual ---");
{
  const NO_LONG = new Set(["short", "day", "hitDice", "other"]);
  let state = blankState();
  state = tracker.record(state, [spend(state, slot3, 7, "Fireball", "lr")]).state;

  const atFive = tracker.summarizePending(state.entries, 5, NO_LONG)[0];
  check("still counting down before it is due", atFive.remaining, 2);
  check("and already marked as manual", atFive.automatic, false);

  const atTwenty = tracker.summarizePending(state.entries, 20, NO_LONG)[0];
  check("settles at 0 rather than going negative", atTwenty.remaining, 0);

  // A poor night must not inflate a number nobody is waiting on.
  const held = tracker.holdUncredited(state, NO_LONG, NO_LONG);
  check("a poor night does not push it further out", held.held, 0);
  check("its maturity is untouched", held.state.entries[0].recoverAtRestIndex, 7);
}

console.log("\n--- Damage can be told never to heal on its own ---");
{
  const actor = { system: { attributes: { hp: { value: 30, max: 50, effectiveMax: 50 } } } };
  let state = blankState();
  state = debt.incurDebt(state, 12);

  // With automatic healing on, rest 7 closes the wound.
  check("automatic: the wound closes at rest 7", debt.processRest(actor, state, 7).healed, 12);

  SETTINGS_VALUES.autoRecoverDamage = false;
  check("manual: nothing closes at rest 7", debt.processRest(actor, state, 7).healed, 0);
  check("nor ever after", debt.processRest(actor, state, 999).healed, 0);
  check("and the debt is still owed", debt.totalDebt(debt.processRest(actor, state, 999).state), 12);
  check("a poor night does not inflate it",
    debt.holdDebt(state).debt[0].recoverAtRestIndex, 7);
  check("it reads as manual in the summary", debt.summarizeDebt(state)[0].automatic, false);

  // Healing still works — that is the point: only time stops mending wounds.
  check("healing still pays it down", debt.payDebt(state, 5).paid, 5);

  SETTINGS_VALUES.autoRecoverDamage = true;
  check("and Mode A full heal is gated too", (() => {
    SETTINGS_VALUES.hpMode = "gritty";
    SETTINGS_VALUES.autoRecoverDamage = false;
    const r = debt.processRest(actor, blankState(), 7).healed;
    SETTINGS_VALUES.hpMode = "debt";
    SETTINGS_VALUES.autoRecoverDamage = true;
    return r;
  })(), 0);
}

console.log("\n--- A native rest clears real resources but never a hand-made note ---");
{
  // Mirrors what syncNativeRest does: clear entries whose period the system just restored,
  // leaving free-standing notes alone because no system resource stands behind them.
  const clear = (entries, periods) => entries.filter(e =>
    (e.resource.kind === "note") || !periods.has(e.policy.period));

  let state = blankState();
  state = tracker.record(state, [spend(state, slot3, 7, "Spell Slot", "lr")]).state;
  state = tracker.record(state, [spend(state, surge, 1, "Channel Divinity", "sr")]).state;
  state = tracker.record(state, [makeEntry({
    resource: { kind: "note", keyPath: "", key: "n1" },
    amount: 1,
    policy: { period: "lr", restCount: 3, source: "manual" },
    restIndex: 0,
    label: "Cracked ribs"
  })]).state;

  const afterShort = clear(state.entries, new Set(["sr"]));
  check("a short rest clears only the short-rest resource",
    afterShort.map(e => e.label), ["Spell Slot", "Cracked ribs"]);

  const afterLong = clear(state.entries, new Set(["lr", "sr"]));
  check("a long rest clears both real resources", afterLong.map(e => e.label), ["Cracked ribs"]);
  check("but the note survives, despite sharing the long-rest period",
    afterLong[0].resource.kind, "note");
}

console.log("\n--- Period model: the period is the only clock ---");
{
  const ALL = new Set(["short", "long", "day", "hitDice", "other"]);
  const L = 3;

  // 1. The first rest opens a period and already spends one night of it.
  let p = tracker.advancePeriod(null, { length: L, advances: true });
  check("opens at length and counts the opening rest", [p.period.remaining, p.period.length], [2, 3]);
  check("and does not close on the way in", p.closed, false);

  // 2. It counts down, and only the last rest closes it.
  p = tracker.advancePeriod(p.period, { length: L, advances: true });
  check("second rest leaves 1", p.period.remaining, 1);
  check("still open", p.closed, false);

  p = tracker.advancePeriod(p.period, { length: L, advances: true });
  check("third rest closes it", p.closed, true);
  check("and the next period is already open at full length", p.period.remaining, 3);

  // 3. A poor night passes time without advancing the long rest.
  const held = tracker.advancePeriod({ remaining: 2, length: L }, { length: L, advances: false });
  check("a poor night does not count", held.period.remaining, 2);
  check("and cannot close the period", held.closed, false);

  // 4. Changing the configured length resizes an oversized stored period.
  const resized = tracker.advancePeriod({ remaining: 9, length: 9 }, { length: L, advances: false });
  check("a stored period is resized to the new setting", [resized.period.remaining, resized.period.length], [3, 3]);
}

console.log("\n--- Period model: short and daily keep their own cadence while the period runs ---");
{
  // The shipped default: short-rest and daily resources tick as usual; long-rest ones wait.
  const TICKING = new Set(["short", "day", "other"]);

  let state = blankState();
  state = tracker.record(state, [spend(state, surge, 1, "Channel Divinity", "sr")]).state;
  state = tracker.record(state, [spend(state, slot3, 1, "Wand charge", "day")]).state;
  state = tracker.record(state, [spend(state, slot3, 7, "Spell Slot", "lr")]).state;

  // One rest into the period: the short-rest and daily resources are already back.
  const after = tracker.mature(state, 1, TICKING);
  check("a single rest returns the short-rest resource",
    after.recovered.map(e => e.label).includes("Channel Divinity"), true);
  check("and the daily one", after.recovered.map(e => e.label).includes("Wand charge"), true);
  check("while the long-rest slot waits", after.pending.map(e => e.label), ["Spell Slot"]);

  // The waiting entry is shown as not counting down on its own, which is what drives the
  // hourglass in the sheet rather than a misleading number.
  const line = tracker.summarizePending(after.pending, 1, TICKING)[0];
  check("and is flagged as not self-recovering", line.automatic, false);

  // Turning the short-rest tick off puts it back under the period's control.
  const noTick = tracker.mature(state, 1, new Set(["day", "other"]));
  check("with the tick off, the short-rest resource waits too",
    noTick.recovered.map(e => e.label), ["Wand charge"]);
}

console.log("\n--- Period model: closing hands back only what it covers ---");
{
  let state = blankState();
  state = tracker.record(state, [spend(state, slot3, 7, "Spell Slot", "lr")]).state;
  state = tracker.record(state, [spend(state, surge, 1, "Channel Divinity", "sr")]).state;
  state = tracker.record(state, [makeEntry({
    resource: { kind: "note", keyPath: "", key: "n1" },
    amount: 1, policy: { period: "lr", restCount: 3, source: "manual" },
    restIndex: 0, label: "Cracked ribs"
  })]).state;

  const everything = tracker.flushGroups(state, new Set(["short", "long", "day", "hitDice", "other"]));
  check("both real resources come back", everything.recovered.map(e => e.label).sort(),
    ["Channel Divinity", "Spell Slot"]);
  check("the hand-made note is left alone", everything.state.entries.map(e => e.label), ["Cracked ribs"]);

  // A group the period does not cover survives untouched.
  const noLong = tracker.flushGroups(state, new Set(["short", "day", "hitDice", "other"]));
  check("an uncovered group is not returned", noLong.recovered.map(e => e.label), ["Channel Divinity"]);
  check("and stays in the list", noLong.state.entries.map(e => e.label).sort(),
    ["Cracked ribs", "Spell Slot"]);

  // Timers are irrelevant here: a slot due far in the future still comes back.
  check("maturity is beside the point", everything.recovered.every(e => e.recoverAtRestIndex > 0), true);
}

console.log("\n--- Period model: closing settles every wound at once ---");
{
  const actor = { system: { attributes: { hp: { value: 12, max: 40, effectiveMax: 40 } } } };
  let state = blankState();
  state = debt.incurDebt(state, 10);
  state = { ...state, restIndex: 2 };
  state = debt.incurDebt(state, 15);

  check("two wounds are owed", debt.totalDebt(state), 25);
  const cleared = debt.clearAll(actor, state);
  check("all of it clears at once", cleared.clearedDebt, 25);
  check("hit points come back", cleared.updateData, { "system.attributes.hp.value": 37 });
  check("and nothing is left owed", debt.totalDebt(cleared.state), 0);

  // clearAll is the deliberate act of closing a period, so it ignores the "time does not heal"
  // switch that processRest honours.
  SETTINGS_VALUES.autoRecoverDamage = false;
  check("it ignores the automatic-recovery switch", debt.clearAll(actor, state).clearedDebt, 25);
  check("while processRest still refuses", debt.processRest(actor, state, 99).healed, 0);
  SETTINGS_VALUES.autoRecoverDamage = true;

  // Healing capped at max, not overshooting.
  const nearlyFull = { system: { attributes: { hp: { value: 38, max: 40, effectiveMax: 40 } } } };
  check("healing is clamped to the maximum",
    debt.clearAll(nearlyFull, state).updateData, { "system.attributes.hp.value": 40 });
}

console.log("\n--- Period model: state round-trips, and old states are untouched ---");
{
  // A state written before the period model existed must normalize to "no period".
  const legacy = normalizeState({ restIndex: 4, entries: [], debt: [] });
  check("an old state has no period", legacy.period, null);

  const live = normalizeState({ restIndex: 4, entries: [], debt: [], period: { remaining: 2, length: 7 } });
  check("a period round-trips", [live.period.remaining, live.period.length], [2, 7]);

  const tampered = normalizeState({ period: { remaining: 99, length: 7 } });
  check("a hand-edited remaining is clamped to the length", tampered.period.remaining, 7);

  const negative = normalizeState({ period: { remaining: -5, length: 7 } });
  check("and never goes below zero", negative.period.remaining, 0);

  check("garbage is treated as no period", normalizeState({ period: "nope" }).period, null);
}

console.log("\n--- Switching back to the ledger model resumes the old timers ---");
{
  // Entries keep their recoverAtRestIndex while the period model runs, which is what lets a
  // world switch back without losing where every expenditure stood.
  const ALL = new Set(["short", "long", "day", "hitDice", "other"]);
  let state = blankState();
  state = tracker.record(state, [spend(state, slot3, 7, "Spell Slot", "lr")]).state;
  check("the timer was recorded at spend time", state.entries[0].recoverAtRestIndex, 7);

  // Three rests pass under the period model: nothing matures, timers untouched.
  state = { ...state, restIndex: 3, period: { remaining: 1, length: 3 } };
  check("still pending after three period rests", tracker.mature(state, 3, new Set()).recovered.length, 0);
  check("and its maturity never moved", state.entries[0].recoverAtRestIndex, 7);

  // Back on the ledger model it matures exactly when it always would have.
  check("nothing at rest 6", tracker.mature(state, 6, ALL).recovered.length, 0);
  check("and it returns at rest 7", tracker.mature(state, 7, ALL).recovered.map(e => e.label), ["Spell Slot"]);
}

console.log("\n--- normalizeState discards malformed entries ---");
{
  const s = normalizeState({
    restIndex: 4,
    entries: [
      { resource: { kind: "spellSlot", keyPath: "system.spells.spell1.value", key: "spell1" }, amount: 2, policy: { restCount: 7 }, spentAtRestIndex: 1 },
      { resource: { kind: "bogus", keyPath: "x" }, amount: 1 },
      { amount: 3 },
      { resource: { kind: "itemUses", keyPath: "system.uses.spent", key: "i" }, amount: 0 }
    ],
    debt: [{ amount: 5, remaining: 5, incurredAtRestIndex: 1, recoverAtRestIndex: 8 }, { amount: 0 }]
  });
  check("only the valid entry survives", s.entries.length, 1);
  check("recoverAtRestIndex derived", s.entries[0].recoverAtRestIndex, 8);
  check("only the valid debt survives", s.debt.length, 1);
  check("restIndex preserved", s.restIndex, 4);
}

console.log("\n--- Mode A: full heal on the long-rest interval ---");
{
  SETTINGS_VALUES.hpMode = "gritty";
  const actor = { system: { attributes: { hp: { value: 12, max: 60, effectiveMax: 60 } } } };
  const state = blankState();
  check("no heal at rest 6", debt.processRest(actor, state, 6).healed, 0);
  check("full heal at rest 7", debt.processRest(actor, state, 7).updateData, { "system.attributes.hp.value": 60 });
  check("full heal again at rest 14", debt.processRest(actor, state, 14).healed, 48);
  SETTINGS_VALUES.hpMode = "debt";
}

console.log(`\n${failures ? `${failures} FAILURE(S)` : "All checks passed."}`);
process.exit(failures ? 1 : 0);
