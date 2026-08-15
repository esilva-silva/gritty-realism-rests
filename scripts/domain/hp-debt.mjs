import { HP_MODES, SETTINGS, t } from "../constants.mjs";
import { setting } from "../settings.mjs";
import { makeDebt } from "./models.mjs";

/**
 * Hit point recovery.
 *
 * Mode B — Recovery Debt (default): every instance of damage becomes a debt entry with its own
 * maturity. Healing pays debt off oldest-first, and whatever is still owed when its cooldown
 * elapses is handed back at the next rest. Temporary hit points never create debt, because the
 * dnd5e damage hook reports them separately from real hit points.
 *
 * Mode A — Gritty Standard: no debt is tracked. Hit points come back only from hit dice and
 * from a full heal that lands every `longRestCount` rests, mirroring a long rest stretched
 * across the gritty schedule.
 */

/**
 * The configured mode.
 * @returns {string}
 */
export function hpMode() {
  return setting(SETTINGS.hpMode);
}

/**
 * Record damage as debt.
 *
 * @param {import("./models.mjs").RestState} state
 * @param {number} hitPoints  Real hit points lost, a positive number.
 * @returns {import("./models.mjs").RestState}
 */
export function incurDebt(state, hitPoints) {
  const amount = Math.trunc(hitPoints);
  if ( amount <= 0 ) return state;

  const entry = makeDebt({
    amount,
    restIndex: state.restIndex,
    restCount: setting(SETTINGS.longRestCount),
    label: t("Resource.HitPointDebt")
  });

  return { ...state, debt: [...state.debt, entry] };
}

/**
 * Apply healing against outstanding debt, oldest entry first.
 *
 * The hit points themselves have already been applied by the system; this only clears the
 * corresponding obligation so the same hit points are not handed back a second time at rest.
 *
 * @param {import("./models.mjs").RestState} state
 * @param {number} hitPoints  Real hit points healed, a positive number.
 * @returns {{state: import("./models.mjs").RestState, paid: number}}
 */
export function payDebt(state, hitPoints) {
  let budget = Math.trunc(hitPoints);
  if ( (budget <= 0) || !state.debt.length ) return { state, paid: 0 };

  const debt = [];
  let paid = 0;

  // Oldest first: FIFO, so the longest-standing wound closes before a fresh one.
  for ( const entry of state.debt ) {
    if ( budget <= 0 ) {
      debt.push(entry);
      continue;
    }
    const applied = Math.min(entry.remaining, budget);
    budget -= applied;
    paid += applied;
    const remaining = entry.remaining - applied;
    if ( remaining > 0 ) debt.push({ ...entry, remaining });
  }

  if ( !paid ) return { state, paid: 0 };
  return { state: { ...state, debt }, paid };
}

/**
 * Total hit points still owed.
 * @param {import("./models.mjs").RestState} state
 * @returns {number}
 */
export function totalDebt(state) {
  return state.debt.reduce((sum, entry) => sum + entry.remaining, 0);
}

/**
 * Work out the hit point change a rest produces.
 *
 * @param {Actor} actor
 * @param {import("./models.mjs").RestState} state
 * @param {number} newRestIndex
 * @returns {{
 *   state: import("./models.mjs").RestState,
 *   updateData: object,
 *   healed: number,
 *   clearedDebt: number
 * }}
 */
export function processRest(actor, state, newRestIndex) {
  const hp = actor.system?.attributes?.hp;
  if ( !hp ) return { state, updateData: {}, healed: 0, clearedDebt: 0 };

  const max = Math.max(0, hp.effectiveMax ?? hp.max ?? 0);
  const current = hp.value ?? 0;

  if ( hpMode() === HP_MODES.gritty ) {
    const period = Math.max(1, setting(SETTINGS.longRestCount));
    // A full heal lands whenever the rest index completes another long-rest interval.
    const fullHeal = (newRestIndex > 0) && ((newRestIndex % period) === 0);
    if ( !fullHeal || (current >= max) ) return { state, updateData: {}, healed: 0, clearedDebt: 0 };
    return {
      state,
      updateData: { "system.attributes.hp.value": max },
      healed: max - current,
      clearedDebt: 0
    };
  }

  // Mode B: hand back whatever debt has matured.
  const matured = state.debt.filter(entry => entry.recoverAtRestIndex <= newRestIndex);
  const outstanding = state.debt.filter(entry => entry.recoverAtRestIndex > newRestIndex);
  if ( !matured.length ) return { state, updateData: {}, healed: 0, clearedDebt: 0 };

  const clearedDebt = matured.reduce((sum, entry) => sum + entry.remaining, 0);
  const restored = Math.min(max, current + clearedDebt);
  const healed = restored - current;

  const nextState = { ...state, debt: outstanding };
  if ( healed <= 0 ) return { state: nextState, updateData: {}, healed: 0, clearedDebt };

  return {
    state: nextState,
    updateData: { "system.attributes.hp.value": restored },
    healed,
    clearedDebt
  };
}

/**
 * Debt lines for the sheet panel and the GM ledger, soonest to mature first.
 * @param {import("./models.mjs").RestState} state
 * @returns {Array<{id: string, remaining: number, rests: number}>}
 */
export function summarizeDebt(state) {
  return state.debt
    .map(entry => ({
      id: entry.id,
      remaining: entry.remaining,
      rests: Math.max(0, entry.recoverAtRestIndex - state.restIndex)
    }))
    .sort((a, b) => a.rests - b.rests);
}
