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
  restDuration: 480,
  logLevel: "off"
};

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

const spend = (state, resource, restCount, label) => makeEntry({
  resource, amount: 1, policy: { period: "x", restCount, source: "test" },
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
