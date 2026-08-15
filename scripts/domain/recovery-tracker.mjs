import { log, groupOfPeriod } from "../constants.mjs";
import { resourceAddress } from "./models.mjs";

/**
 * Recovery Tracker — pure operations over a {@link import("./models.mjs").RestState}.
 *
 * Every function here takes a state and returns a new state (or a report); nothing reads or
 * writes documents. That keeps the cooldown arithmetic testable in isolation and makes the
 * ordering guarantees easy to reason about.
 */

/**
 * Append expenditures to the ledger, skipping any whose `dedupeKey` is already present.
 *
 * @param {import("./models.mjs").RestState} state
 * @param {import("./models.mjs").RecoveryEntry[]} entries
 * @returns {{state: import("./models.mjs").RestState, added: import("./models.mjs").RecoveryEntry[]}}
 */
export function record(state, entries) {
  const seen = new Set(state.entries.map(e => e.dedupeKey).filter(Boolean));
  const added = [];

  for ( const entry of entries ) {
    if ( entry.dedupeKey && seen.has(entry.dedupeKey) ) {
      log.debug(`Skipping duplicate expenditure ${entry.dedupeKey}.`);
      continue;
    }
    if ( entry.dedupeKey ) seen.add(entry.dedupeKey);
    added.push(entry);
  }

  if ( !added.length ) return { state, added };
  return { state: { ...state, entries: [...state.entries, ...added] }, added };
}

/**
 * Remove ledger entries for a resource that was given back outside of a rest — a dnd5e
 * `refund()`, a Midi-QOL undo, or a GM handing the charge back by hand.
 *
 * Entries are removed newest-first: the most recent expenditure is the one being undone.
 *
 * @param {import("./models.mjs").RestState} state
 * @param {import("./models.mjs").RecoveryResource} resource
 * @param {number} amount  Units returned.
 * @returns {{state: import("./models.mjs").RestState, removed: import("./models.mjs").RecoveryEntry[]}}
 */
export function reconcile(state, resource, amount) {
  const address = resourceAddress(resource);
  let budget = amount;
  const removed = [];
  const kept = [];

  // Walk newest-first so an undo cancels the expenditure it actually corresponds to.
  for ( let i = state.entries.length - 1; i >= 0; i-- ) {
    const entry = state.entries[i];
    if ( (budget <= 0) || (resourceAddress(entry.resource) !== address) ) {
      kept.unshift(entry);
      continue;
    }

    if ( entry.amount <= budget ) {
      budget -= entry.amount;
      removed.push(entry);
    } else {
      kept.unshift({ ...entry, amount: entry.amount - budget });
      budget = 0;
    }
  }

  if ( !removed.length ) return { state, removed };
  return { state: { ...state, entries: kept }, removed };
}

/**
 * Split the ledger at a prospective rest index without mutating anything.
 *
 * Used both by the pre-rest preview and by the actual rest, so what the player is shown and
 * what happens are computed by the same code.
 *
 * @param {import("./models.mjs").RestState} state
 * @param {number} atRestIndex  Rest index to evaluate against.
 * @returns {{recovered: import("./models.mjs").RecoveryEntry[], pending: import("./models.mjs").RecoveryEntry[]}}
 */
export function split(state, atRestIndex) {
  const recovered = [];
  const pending = [];
  for ( const entry of state.entries ) {
    if ( entry.recoverAtRestIndex <= atRestIndex ) recovered.push(entry);
    else pending.push(entry);
  }
  return { recovered, pending };
}

/**
 * Advance the ledger to a new rest index, dropping everything that has matured.
 *
 * @param {import("./models.mjs").RestState} state
 * @param {number} newRestIndex
 * @returns {{
 *   state: import("./models.mjs").RestState,
 *   recovered: import("./models.mjs").RecoveryEntry[],
 *   pending: import("./models.mjs").RecoveryEntry[]
 * }}
 */
export function mature(state, newRestIndex) {
  const { recovered, pending } = split(state, newRestIndex);
  return {
    state: { ...state, restIndex: newRestIndex, entries: pending },
    recovered,
    pending
  };
}

/**
 * Group entries that address the same underlying number, summing their amounts.
 * Recovery has to be applied per address — two spent level-3 slots are one `+2` write, not
 * two conflicting `+1` writes to the same key path.
 *
 * @param {import("./models.mjs").RecoveryEntry[]} entries
 * @returns {Array<{resource: import("./models.mjs").RecoveryResource, amount: number, entries: import("./models.mjs").RecoveryEntry[], label: string}>}
 */
export function groupByResource(entries) {
  /** @type {Map<string, {resource: object, amount: number, entries: object[], label: string}>} */
  const groups = new Map();

  for ( const entry of entries ) {
    const address = resourceAddress(entry.resource);
    const group = groups.get(address);
    if ( group ) {
      group.amount += entry.amount;
      group.entries.push(entry);
    } else {
      groups.set(address, {
        resource: entry.resource,
        amount: entry.amount,
        entries: [entry],
        label: entry.label
      });
    }
  }

  return Array.from(groups.values());
}

/**
 * List what is recovering, one line per expenditure.
 *
 * Deliberately not aggregated: two level-1 slots spent at different moments are two separate
 * obligations with their own timers, and collapsing them into "Level 1 Slot ×2" hides exactly
 * the thing this module exists to track. Recovery is still applied in groups — see
 * {@link groupByResource} — because that is a question about writes, not about display.
 *
 * @param {import("./models.mjs").RecoveryEntry[]} entries
 * @param {number} restIndex  Current rest index.
 * @returns {Array<{
 *   id: string, label: string, description?: string, remaining: number, amount: number,
 *   img?: string, period: string, group: string
 * }>}
 */
export function summarizePending(entries, restIndex) {
  return entries
    .map(entry => ({
      id: entry.id,
      label: entry.label,
      description: entry.description,
      remaining: Math.max(0, entry.recoverAtRestIndex - restIndex),
      amount: entry.amount,
      img: entry.img,
      period: entry.policy.period,
      group: groupOfPeriod(entry.policy.period)
    }))
    .sort((a, b) => (a.remaining - b.remaining) || a.label.localeCompare(b.label));
}

/**
 * Hold back the entries a rest of this quality does not credit.
 *
 * A poor night still advances the rest index — time passed — but the cooldowns it fails to
 * credit must not creep closer. Pushing their maturity out by one keeps them exactly where they
 * were relative to the character, without needing a separate counter per recovery period.
 *
 * @param {import("./models.mjs").RestState} state
 * @param {Set<string>} creditedGroups  Groups this rest advances, from {@link RECOVERY_GROUPS}.
 * @returns {{state: import("./models.mjs").RestState, held: number}}
 */
export function holdUncredited(state, creditedGroups) {
  let held = 0;

  const entries = state.entries.map(entry => {
    if ( creditedGroups.has(groupOfPeriod(entry.policy.period)) ) return entry;
    held += 1;
    return { ...entry, recoverAtRestIndex: entry.recoverAtRestIndex + 1 };
  });

  return { state: { ...state, entries }, held };
}

/**
 * Move a set of entries' maturity by a number of rests, never earlier than the current index.
 * @param {import("./models.mjs").RestState} state
 * @param {string[]} entryIds
 * @param {number} delta  Rests to add; negative brings recovery closer.
 * @returns {import("./models.mjs").RestState}
 */
export function shift(state, entryIds, delta) {
  const ids = new Set(entryIds);
  return {
    ...state,
    entries: state.entries.map(entry => ids.has(entry.id)
      ? { ...entry, recoverAtRestIndex: Math.max(state.restIndex, entry.recoverAtRestIndex + delta) }
      : entry)
  };
}

/**
 * Shift every entry's maturity so the caller can hand a charge back early or push it out.
 * @param {import("./models.mjs").RestState} state
 * @param {string} entryId
 * @param {number} recoverAtRestIndex
 * @returns {import("./models.mjs").RestState}
 */
export function reschedule(state, entryId, recoverAtRestIndex) {
  return {
    ...state,
    entries: state.entries.map(e => (e.id === entryId) ? { ...e, recoverAtRestIndex } : e)
  };
}

/**
 * Drop a single entry without recovering it.
 * @param {import("./models.mjs").RestState} state
 * @param {string} entryId
 * @returns {import("./models.mjs").RestState}
 */
export function remove(state, entryId) {
  return { ...state, entries: state.entries.filter(e => e.id !== entryId) };
}
