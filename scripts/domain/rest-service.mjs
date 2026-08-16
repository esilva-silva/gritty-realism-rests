import {
  MODULE_ID, ORIGINS, RESOURCE_KINDS, RECOVERY_GROUPS, REST_QUALITIES, SETTINGS,
  periodOfGroup, log, t
} from "../constants.mjs";
import { setting, creditedGroups, autoRecoverGroups } from "../settings.mjs";
import { readState, writeState, queue, canRest, internalContext } from "../data/actor-store.mjs";
import { registerHandler, execute, hasAuthority } from "../data/authority.mjs";
import {
  mature, split, groupByResource, summarizePending, record, reconcile, remove, reschedule, shift,
  holdUncredited
} from "./recovery-tracker.mjs";
import { resolvePolicy, costOf } from "./recovery-rules.mjs";
import { makeEntry, blankState } from "./models.mjs";
import * as debt from "./hp-debt.mjs";
import { buildRecoveryUpdates, executeRest } from "../adapters/dnd5e-adapter.mjs";

/**
 * Rest Service — orchestrates Take Rest.
 *
 * The whole mutation runs on the authoritative client inside the per-actor queue, so a rest is
 * a single serialized read-modify-write. Clients without authority delegate the entire
 * operation rather than computing updates locally, which is what keeps two players clicking at
 * the same moment from producing two rests.
 */

const OP_TAKE_REST = "takeRest";
const OP_ADVANCE = "advanceRests";
const OP_RECORD = "recordSpend";
const OP_RECONCILE = "reconcileSpend";
const OP_MUTATE = "mutateState";

/* -------------------------------------------- */
/*  Preview                                     */
/* -------------------------------------------- */

/**
 * @typedef {object} RestPreview
 * @property {number} restIndex   Current index.
 * @property {number} nextIndex   Index after the prospective rest.
 * @property {Array<{label: string, amount: number, img?: string}>} recovering  Matures with this rest.
 * @property {Array<{label: string, remaining: number, amount: number, img?: string}>} progressing  Still waiting.
 * @property {number} debt        Hit points still owed.
 */

/**
 * What a rest would do, without changing anything.
 * @param {Actor} actor
 * @param {number} [steps=1]  How many rests ahead to look.
 * @returns {RestPreview}
 */
export function previewRest(actor, steps = 1, quality = REST_QUALITIES.full) {
  const base = readState(actor);
  const nextIndex = base.restIndex + Math.max(1, steps);
  const credited = creditedGroups(quality);
  const auto = autoRecoverGroups();

  // Evaluate against the same held-back state the rest itself will use, so switching the
  // quality in the dialog immediately shows what it costs.
  const { state } = holdUncredited(base, credited, auto);
  const { recovered, pending } = split(state, nextIndex, auto);

  return {
    restIndex: base.restIndex,
    nextIndex,
    quality,
    recovering: summarizePending(recovered, nextIndex, auto),
    progressing: summarizePending(pending, nextIndex, auto),
    held: summarizePending(state.entries, nextIndex, auto)
      .filter(l => l.automatic && !credited.has(l.group)),
    debt: debt.totalDebt(base)
  };
}

/**
 * Current ledger state in a shape suited to the sheet panel.
 * @param {Actor} actor
 * @returns {{restIndex: number, ready: object[], recovering: object[], debt: object[], debtTotal: number}}
 */
export function getRecoveryState(actor) {
  const state = readState(actor);
  const auto = autoRecoverGroups();
  const { recovered, pending } = split(state, state.restIndex, auto);

  return {
    restIndex: state.restIndex,
    ready: summarizePending(recovered, state.restIndex, auto),
    recovering: summarizePending(pending, state.restIndex, auto),
    debt: debt.summarizeDebt(state),
    debtTotal: debt.totalDebt(state)
  };
}

/**
 * Raw pending entries, for macros and other modules.
 * @param {Actor} actor
 * @returns {import("./models.mjs").RecoveryEntry[]}
 */
export function getPendingRecoveries(actor) {
  return readState(actor).entries;
}

/* -------------------------------------------- */
/*  Permissions                                 */
/* -------------------------------------------- */

/**
 * May the current user start a rest for this actor?
 * @param {Actor} actor
 * @returns {{allowed: boolean, reason?: string}}
 */
export function canTakeRest(actor) {
  if ( !canRest(actor) ) return { allowed: false, reason: t("Warning.NoPermission") };
  if ( !actor.isOwner ) return { allowed: false, reason: t("Warning.NoPermission") };
  if ( !game.user.isGM && !setting(SETTINGS.allowPlayerRest) ) {
    return { allowed: false, reason: t("Warning.PlayerRestDisabled") };
  }
  if ( !hasAuthority() ) return { allowed: false, reason: t("Warning.NoActiveGM") };
  return { allowed: true };
}

/* -------------------------------------------- */
/*  Public operations                           */
/* -------------------------------------------- */

/**
 * Take a rest.
 *
 * @param {Actor} actor
 * @param {object} [options]
 * @param {string} [options.restId]       Supply to make a retry idempotent.
 * @param {boolean} [options.advanceTime] Advance the world clock by one rest duration.
 * @param {boolean} [options.chat]        Post the rest chat card.
 * @returns {Promise<object|null>}        A report, or `null` if the rest was prevented.
 */
export async function takeRest(actor, { restId, advanceTime = false, chat, quality = REST_QUALITIES.full } = {}) {
  const check = canTakeRest(actor);
  if ( !check.allowed ) {
    ui.notifications.warn(check.reason);
    return null;
  }

  const preview = previewRest(actor, 1, quality);

  /**
   * Fires before a rest begins, on the client that started it.
   * @param {Actor} actor
   * @param {RestPreview} preview
   * @returns {boolean}  Return `false` to cancel the rest.
   */
  if ( Hooks.call("grittyRealism.preRest", actor, preview) === false ) {
    log.debug(`Rest for ${actor.name} cancelled by a preRest listener.`);
    return null;
  }

  return execute(OP_TAKE_REST, {
    actorUuid: actor.uuid,
    restId: restId ?? foundry.utils.randomID(),
    advanceTime,
    quality,
    chat: chat ?? setting(SETTINGS.chatSummary)
  });
}

/**
 * Take several rests back to back, processing each one in sequence so cooldowns mature in the
 * right order and each rest produces its own summary.
 *
 * @param {Actor} actor
 * @param {number} count
 * @param {object} [options]
 * @param {boolean} [options.chat]
 * @param {boolean} [options.advanceTime]
 * @returns {Promise<object[]>}  One report per rest.
 */
export async function advanceRests(actor, count, { chat = false, advanceTime = false, quality = REST_QUALITIES.full } = {}) {
  const total = Math.max(1, Math.trunc(count));
  const check = canTakeRest(actor);
  if ( !check.allowed ) {
    ui.notifications.warn(check.reason);
    return [];
  }
  return execute(OP_ADVANCE, { actorUuid: actor.uuid, count: total, chat, advanceTime, quality });
}

/**
 * Rest several actors at once. Each keeps its own ledger and produces its own summary.
 * @param {Actor[]} actors
 * @param {object} [options]
 * @returns {Promise<object[]>}
 */
export async function partyRest(actors, options = {}) {
  const reports = [];
  for ( const actor of actors ) {
    try {
      const report = await takeRest(actor, options);
      if ( report ) reports.push(report);
    } catch(err) {
      log.failure(`Rest failed for "${actor.name}".`, err);
    }
  }
  return reports;
}

/**
 * Record expenditures against an actor's ledger.
 * @param {Actor} actor
 * @param {import("./models.mjs").RecoveryEntry[]} entries
 * @returns {Promise<void>}
 */
export async function recordSpend(actor, entries) {
  if ( !entries.length ) return;
  return execute(OP_RECORD, { actorUuid: actor.uuid, entries });
}

/**
 * Cancel ledger entries after a resource was handed back outside of a rest.
 * @param {Actor} actor
 * @param {Array<{resource: object, amount: number}>} refunds
 * @returns {Promise<void>}
 */
export async function reconcileSpend(actor, refunds) {
  if ( !refunds.length ) return;
  return execute(OP_RECONCILE, { actorUuid: actor.uuid, refunds });
}

/**
 * Apply an arbitrary, already-validated state transformation. Used by the GM ledger UI and by
 * the damage tracker, both of which need a serialized read-modify-write.
 * @param {Actor} actor
 * @param {string} kind      Transformation name.
 * @param {object} payload
 * @returns {Promise<any>}
 */
export async function mutate(actor, kind, payload) {
  return execute(OP_MUTATE, { actorUuid: actor.uuid, kind, payload });
}

/**
 * Build a ledger entry for an expenditure, resolving its recovery policy.
 * Returns `null` when the resource should not be tracked.
 *
 * @param {object} data
 * @param {Actor} data.actor
 * @param {import("../adapters/dnd5e-adapter.mjs").ResourceDescriptor} data.descriptor
 * @param {number} data.amount
 * @param {string} [data.origin]
 * @param {string} [data.dedupeKey]
 * @returns {import("./models.mjs").RecoveryEntry|null}
 */
export function buildEntry({ actor, descriptor, amount, origin, dedupeKey }) {
  const policy = (descriptor.resource.kind === RESOURCE_KINDS.hitDice)
    ? { period: "hitDice", restCount: costOf("hitDice"), source: "system" }
    : resolvePolicy({
      kind: descriptor.resource.kind,
      key: descriptor.resource.key,
      actor,
      item: descriptor.item,
      activity: descriptor.activity
    });

  if ( !policy ) return null;

  return makeEntry({
    resource: descriptor.resource,
    amount,
    policy,
    restIndex: readState(actor).restIndex,
    label: descriptor.label,
    img: descriptor.img,
    origin: origin ?? ORIGINS.manual,
    dedupeKey
  });
}

/* -------------------------------------------- */
/*  Authoritative handlers                      */
/* -------------------------------------------- */

/**
 * Register every operation the authoritative client performs. Called once during `init`.
 */
export function registerRestHandlers() {
  registerHandler(OP_TAKE_REST, ({ actorUuid, restId, advanceTime, chat, quality }) =>
    withActor(actorUuid, actor => performRest(actor, { restId, advanceTime, chat, quality })));

  registerHandler(OP_ADVANCE, ({ actorUuid, count, advanceTime, chat, quality }) =>
    withActor(actorUuid, async actor => {
      const reports = [];
      for ( let i = 0; i < count; i++ ) {
        reports.push(await performRest(actor, { restId: foundry.utils.randomID(), advanceTime, chat, quality }));
      }
      return reports;
    }));

  registerHandler(OP_RECORD, ({ actorUuid, entries }) =>
    withActor(actorUuid, async actor => {
      const state = readState(actor);
      const { state: next, added } = record(state, entries);
      if ( !added.length ) return { added: 0 };
      await writeState(actor, next);

      for ( const entry of added ) {
        /**
         * Fires once per recorded expenditure.
         * @param {Actor} actor
         * @param {import("./models.mjs").RecoveryEntry} entry
         */
        Hooks.callAll("grittyRealism.resourceSpent", actor, entry);
      }
      log.debug(`Recorded ${added.length} expenditure(s) for ${actor.name}.`, added);
      return { added: added.length };
    }));

  registerHandler(OP_RECONCILE, ({ actorUuid, refunds }) =>
    withActor(actorUuid, async actor => {
      let state = readState(actor);
      let removed = 0;
      for ( const { resource, amount } of refunds ) {
        const result = reconcile(state, resource, amount);
        state = result.state;
        removed += result.removed.length;
      }
      if ( !removed ) return { removed: 0 };
      await writeState(actor, state);
      log.debug(`Reconciled ${removed} entr(ies) for ${actor.name} after an out-of-rest refund.`);
      return { removed };
    }));

  registerHandler(OP_MUTATE, ({ actorUuid, kind, payload }) =>
    withActor(actorUuid, async actor => applyMutation(actor, kind, payload)));
}

/**
 * Run `fn` for an actor inside its serialization queue.
 * @template T
 * @param {string} actorUuid
 * @param {(actor: Actor) => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withActor(actorUuid, fn) {
  const actor = await fromUuid(actorUuid);
  if ( !actor ) throw new Error(`${MODULE_ID}: actor ${actorUuid} not found.`);
  return queue(actor.id, () => fn(actor));
}

/**
 * The authoritative rest. Runs on one client, inside the actor's queue.
 *
 * @param {Actor} actor
 * @param {object} options
 * @returns {Promise<object>}
 */
async function performRest(actor, { restId, advanceTime, chat, quality = REST_QUALITIES.full }) {
  const state = readState(actor);

  // Idempotency: a retried socket request, or a second click that arrived while the first was
  // still in flight, resolves to the rest that already happened.
  if ( restId && (state.lastRestId === restId) ) {
    log.debug(`Rest ${restId} for ${actor.name} already applied; ignoring the repeat.`);
    return { actorUuid: actor.uuid, restIndex: state.restIndex, repeated: true, recovered: [], pending: [] };
  }

  const newIndex = state.restIndex + 1;

  // Hold back what this rest does not credit *before* maturing, so a long-rest cooldown that
  // was due tonight does not slip through on a badly slept night.
  const credited = creditedGroups(quality);
  const auto = autoRecoverGroups();
  const { state: withHeld, held } = holdUncredited(state, credited, auto);
  const { state: advanced, recovered, pending } = mature(withHeld, newIndex, auto);

  const groups = groupByResource(recovered);
  const { updateData, updateItems, applied } = buildRecoveryUpdates(actor, groups);

  // Hit point debt follows the long-rest schedule, so a rest that does not credit long-rest
  // cooldowns does not let wounds close either.
  const beforeHp = credited.has(RECOVERY_GROUPS.long) ? advanced : debt.holdDebt(advanced);
  const hp = debt.processRest(actor, beforeHp, newIndex);
  Object.assign(updateData, hp.updateData);

  const nextState = { ...hp.state, restIndex: newIndex, lastRestId: restId ?? null };

  // Persist the ledger first, in the same queue slot, so the rest can never be applied twice
  // even if the document updates below fail partway through.
  await writeState(actor, nextState);

  let result = null;
  try {
    result = await executeRest(actor, { updateData, updateItems, chat, advanceTime });
  } catch(err) {
    log.failure(`The rest for "${actor.name}" was recorded but its updates could not be applied.`, err);
  }

  const report = {
    actorUuid: actor.uuid,
    actorName: actor.name,
    restIndex: newIndex,
    quality,
    held,
    recovered: applied,
    pending: summarizePending(pending, newIndex, auto),
    healed: hp.healed,
    clearedDebt: hp.clearedDebt,
    repeated: false
  };

  if ( chat ) await postSummary(actor, report, result);

  for ( const entry of recovered ) {
    /**
     * Fires once per ledger entry that matured during this rest.
     * @param {Actor} actor
     * @param {import("./models.mjs").RecoveryEntry} entry
     */
    Hooks.callAll("grittyRealism.resourceRecovered", actor, entry);
  }

  /**
   * Fires after a rest has been fully applied.
   * @param {Actor} actor
   * @param {object} report
   */
  Hooks.callAll("grittyRealism.restComplete", actor, report);

  log.debug(`${actor.name} completed rest ${newIndex}.`, report);
  return report;
}

/**
 * Attach the module summary to the rest chat card, or post a standalone card when the system
 * did not create one.
 * @param {Actor} actor
 * @param {object} report
 * @param {object|null} result  The dnd5e rest result, if the system produced one.
 * @returns {Promise<void>}
 */
async function postSummary(actor, report, result) {
  const { renderSummary } = await import("../ui/chat.mjs");
  await renderSummary(actor, report, result);
}

/**
 * GM-only ledger corrections.
 * @param {Actor} actor
 * @param {string} kind
 * @param {object} payload
 * @returns {Promise<object>}
 */
async function applyMutation(actor, kind, payload) {
  let state = readState(actor);

  switch ( kind ) {
    case "removeEntry":
      state = remove(state, payload.entryId);
      break;

    case "recoverNow": {
      // Hand the resources back immediately rather than waiting for the next rest, then drop
      // the entries so the coming rest does not restore them a second time.
      const ids = payload.entryIds ?? [payload.entryId];
      const entries = state.entries.filter(e => ids.includes(e.id));
      if ( !entries.length ) break;

      const { updateData, updateItems } = buildRecoveryUpdates(actor, groupByResource(entries));
      if ( !foundry.utils.isEmpty(updateData) ) await actor.update(updateData, internalContext());
      if ( updateItems.length ) await actor.updateEmbeddedDocuments("Item", updateItems, internalContext());

      for ( const entry of entries ) {
        state = remove(state, entry.id);
        Hooks.callAll("grittyRealism.resourceRecovered", actor, entry);
      }
      break;
    }

    case "shiftEntries":
      state = shift(state, payload.entryIds ?? [payload.entryId], Math.trunc(payload.delta) || 0);
      break;

    case "addEntry": {
      // A free-standing cooldown with no document behind it: a lingering wound, a curse, a
      // debt of honour. It restores nothing when it matures — it simply stops being true.
      const group = payload.group ?? RECOVERY_GROUPS.long;
      const restCount = Math.max(0, Math.trunc(payload.restCount) || 0);
      const entry = makeEntry({
        resource: { kind: RESOURCE_KINDS.note, keyPath: "", key: foundry.utils.randomID() },
        amount: 1,
        policy: { period: periodOfGroup(group), restCount, source: "manual" },
        restIndex: state.restIndex,
        label: String(payload.label || t("Ledger.UntitledEntry")),
        description: payload.description ? String(payload.description) : undefined,
        origin: ORIGINS.gm
      });
      state = { ...state, entries: [...state.entries, entry] };
      Hooks.callAll("grittyRealism.resourceSpent", actor, entry);
      break;
    }

    case "addItemCooldown": {
      // Put an existing item's uses on cooldown by hand, for the small corrections that come up
      // mid-session — a charge spent off-screen, a feature the GM rules as expended.
      const item = actor.items.get(payload.itemId);
      if ( !item ) break;
      const group = payload.group ?? RECOVERY_GROUPS.long;
      const restCount = Math.max(0, Math.trunc(payload.restCount) || 0);
      const amount = Math.max(1, Math.trunc(payload.amount) || 1);

      // Optionally mark the use as spent too, so the sheet agrees with the ledger. The write
      // carries the module's own context so the watcher does not read it back as a second
      // expenditure and file a duplicate entry.
      if ( payload.consume && item.system?.uses?.max ) {
        const spent = Math.clamp((item.system.uses.spent ?? 0) + amount, 0, item.system.uses.max);
        await item.update({ "system.uses.spent": spent }, internalContext());
      }

      const entry = makeEntry({
        resource: {
          kind: RESOURCE_KINDS.itemUses,
          keyPath: "system.uses.spent",
          key: item.id,
          itemId: item.id
        },
        amount,
        policy: { period: periodOfGroup(group), restCount, source: "manual" },
        restIndex: state.restIndex,
        label: item.name,
        img: item.img,
        origin: ORIGINS.gm
      });
      state = { ...state, entries: [...state.entries, entry] };
      Hooks.callAll("grittyRealism.resourceSpent", actor, entry);
      break;
    }

    case "reschedule":
      state = reschedule(state, payload.entryId, Math.max(0, Math.trunc(payload.recoverAtRestIndex)));
      break;

    case "setRestIndex":
      state = { ...state, restIndex: Math.max(0, Math.trunc(payload.restIndex)) };
      break;

    case "setDebt": {
      const amount = Math.max(0, Math.trunc(payload.amount));
      const remaining = state.debt.reduce((sum, e) => sum + e.remaining, 0);
      if ( amount === remaining ) break;
      if ( amount === 0 ) {
        state = { ...state, debt: [] };
      } else if ( amount < remaining ) {
        state = debt.payDebt(state, remaining - amount).state;
      } else {
        state = debt.incurDebt(state, amount - remaining);
      }
      break;
    }

    case "removeDebt":
      state = { ...state, debt: state.debt.filter(e => e.id !== payload.debtId) };
      break;

    case "hitPoints": {
      // Damage and healing arrive here from the actor update hook, which fires on every client;
      // routing them through the queue is what keeps concurrent clients from racing.
      const change = Math.trunc(payload.hitPoints);
      if ( !change ) return { ok: true };
      state = (change < 0) ? debt.incurDebt(state, -change) : debt.payDebt(state, change).state;
      break;
    }

    case "syncNativeRest": {
      // A Short or Long Rest that the world left enabled really did restore things through the
      // system. Ledger entries for those periods are now stale: leaving them would show a full
      // resource as still recovering, and would hand it back a second time later.
      const periods = new Set(payload.periods ?? []);
      const kept = [];
      const cleared = [];

      for ( const entry of state.entries ) {
        if ( periods.has(entry.policy.period) ) cleared.push(entry);
        else kept.push(entry);
      }

      // Hit dice come back by the handful rather than all at once, so only drop as many entries
      // as the system actually returned, oldest first.
      let dice = Math.max(0, Math.trunc(payload.hitDiceRecovered) || 0);
      const afterDice = [];
      for ( const entry of kept ) {
        if ( (dice > 0) && (entry.resource.kind === RESOURCE_KINDS.hitDice) ) {
          dice -= entry.amount;
          cleared.push(entry);
          continue;
        }
        afterDice.push(entry);
      }

      state = { ...state, entries: afterDice };
      if ( payload.clearDebt ) state = { ...state, debt: [] };

      if ( !cleared.length && !payload.clearDebt ) return { cleared: 0 };
      for ( const entry of cleared ) Hooks.callAll("grittyRealism.resourceRecovered", actor, entry);
      log.debug(`Native ${payload.type} rest cleared ${cleared.length} ledger entr(ies) for ${actor.name}.`);
      break;
    }

    case "reset":
      state = blankState();
      break;

    default:
      throw new Error(`${MODULE_ID}: unknown mutation "${kind}".`);
  }

  await writeState(actor, state);
  return { ok: true };
}

/**
 * Damage and healing bookkeeping, funnelled through the same queue as everything else.
 * @param {Actor} actor
 * @param {number} hitPoints  Positive to heal debt, negative to incur it.
 * @returns {Promise<void>}
 */
export async function applyHitPointChange(actor, hitPoints) {
  return execute(OP_MUTATE, { actorUuid: actor.uuid, kind: "hitPoints", payload: { hitPoints } });
}
