import { HP_MODES, ORIGINS, SETTINGS, log } from "../constants.mjs";
import { setting } from "../settings.mjs";
import { isInternal } from "../data/actor-store.mjs";
import { isAuthority } from "../data/authority.mjs";
import { buildEntry, recordSpend, reconcileSpend, applyHitPointChange } from "../domain/rest-service.mjs";
import { hpMode } from "../domain/hp-debt.mjs";
import { describeActorPath, describeItemPath, isExpenditure, unitsOf } from "./dnd5e-adapter.mjs";

/**
 * Consumption Watcher.
 *
 * Resources leave an actor through two entirely separate routes in dnd5e 5.2.5:
 *
 *   1. Activity usage, which is what Midi-QOL also drives. `dnd5e.postActivityConsumption`
 *      reports the exact deltas that were applied, and fires once whether or not Midi is
 *      installed, because Midi's activity mixin delegates to the system's `use()`.
 *   2. Direct document edits — clicking a spell-slot pip, editing `uses.spent`, rolling a hit
 *      die. These never reach an activity at all, so they are picked up by diffing document
 *      updates.
 *
 * Both routes see the same writes, so route 2 would double-count everything route 1 already
 * recorded. Before the activity's updates are applied, route 1 registers a short-lived
 * fingerprint for each write it is about to make; the diff watcher drops any change matching
 * one. `preUpdate*` hooks only fire on the client performing the update, so a client-local
 * fingerprint store is sufficient.
 */

/** How long a fingerprint stays valid. Generous, because the update is applied immediately. */
const FINGERPRINT_TTL_MS = 5000;

/** @type {Map<string, {count: number, expires: number}>} */
const fingerprints = new Map();

/** Ties the `activityConsumption` and `postActivityConsumption` halves of one usage together. */
const usageTokens = new WeakMap();

/** Actor paths the diff watcher considers. Deliberately narrow, so ordinary sheet edits are ignored. */
const TRACKED_ACTOR_PATHS = [/^system\.spells\.[^.]+\.value$/, /^system\.resources\.[^.]+\.value$/];

/** Item paths the diff watcher considers. */
const TRACKED_ITEM_PATHS = [/^system\.uses\.spent$/, /^system\.activities\.[^.]+\.uses\.spent$/, /^system\.hd\.spent$/];

/* -------------------------------------------- */
/*  Fingerprints                                */
/* -------------------------------------------- */

/**
 * @param {string} docUuid
 * @param {string} keyPath
 * @param {any} value  The value the document is about to be set to.
 * @returns {string}
 */
function fingerprintKey(docUuid, keyPath, value) {
  return `${docUuid}|${keyPath}|${value}`;
}

/**
 * Remember that a write is about to happen so the diff watcher ignores it.
 * @param {string} docUuid
 * @param {string} keyPath
 * @param {any} value
 */
function addFingerprint(docUuid, keyPath, value) {
  const key = fingerprintKey(docUuid, keyPath, value);
  const entry = fingerprints.get(key);
  if ( entry && (entry.expires > Date.now()) ) entry.count += 1;
  else fingerprints.set(key, { count: 1, expires: Date.now() + FINGERPRINT_TTL_MS });
}

/**
 * Claim a fingerprint if one is pending.
 * @param {string} docUuid
 * @param {string} keyPath
 * @param {any} value
 * @returns {boolean}  Whether this change was already accounted for.
 */
function claimFingerprint(docUuid, keyPath, value) {
  const key = fingerprintKey(docUuid, keyPath, value);
  const entry = fingerprints.get(key);
  if ( !entry ) return false;
  if ( entry.expires <= Date.now() ) {
    fingerprints.delete(key);
    return false;
  }
  entry.count -= 1;
  if ( entry.count <= 0 ) fingerprints.delete(key);
  return true;
}

/**
 * Drop expired fingerprints. Called opportunistically rather than on a timer.
 */
function pruneFingerprints() {
  const now = Date.now();
  for ( const [key, entry] of fingerprints ) {
    if ( entry.expires <= now ) fingerprints.delete(key);
  }
}

/* -------------------------------------------- */
/*  Route 1: activity consumption               */
/* -------------------------------------------- */

/**
 * Fires before the activity's updates are written. Register a fingerprint for every value the
 * system is about to set, so the diff watcher stays quiet for them.
 *
 * @param {object} activity
 * @param {object} usageConfig
 * @param {object} messageConfig
 * @param {object} updates  `{actor: object, item: object[], create: object[], delete: string[]}`
 */
function onActivityConsumption(activity, usageConfig, messageConfig, updates) {
  pruneFingerprints();
  usageTokens.set(messageConfig, foundry.utils.randomID());

  const actor = activity?.actor;
  if ( !actor ) return;

  for ( const [keyPath, value] of Object.entries(foundry.utils.flattenObject(updates.actor ?? {})) ) {
    addFingerprint(actor.uuid, keyPath, value);
  }

  for ( const update of updates.item ?? [] ) {
    const item = actor.items.get(update._id);
    if ( !item ) continue;
    const { _id, ...changes } = update;
    for ( const [keyPath, value] of Object.entries(foundry.utils.flattenObject(changes)) ) {
      addFingerprint(item.uuid, keyPath, value);
    }
  }
}

/**
 * Fires after consumption has been applied. `messageConfig.data.flags.dnd5e.use.consumed` holds
 * the exact deltas, which is more reliable than re-deriving them from the update payload.
 *
 * @param {object} activity
 * @param {object} usageConfig
 * @param {object} messageConfig
 */
async function onPostActivityConsumption(activity, usageConfig, messageConfig) {
  const consumed = foundry.utils.getProperty(messageConfig, "data.flags.dnd5e.use.consumed");
  const actor = activity?.actor;
  if ( !consumed || !actor ) return;

  const token = usageTokens.get(messageConfig) ?? foundry.utils.randomID();
  const entries = [];

  for ( const { keyPath, delta } of consumed.actor ?? [] ) {
    if ( !isExpenditure(keyPath, delta) ) continue;
    const descriptor = describeActorPath(actor, keyPath);
    if ( !descriptor ) continue;
    const entry = buildEntry({
      actor,
      descriptor,
      amount: unitsOf(delta),
      origin: ORIGINS.activity,
      dedupeKey: `${token}|${keyPath}`
    });
    if ( entry ) entries.push(entry);
  }

  for ( const [itemId, deltas] of Object.entries(consumed.item ?? {}) ) {
    const item = actor.items.get(itemId);
    if ( !item ) continue;
    for ( const { keyPath, delta } of deltas ) {
      if ( !isExpenditure(keyPath, delta) ) continue;
      const descriptor = describeItemPath(actor, item, keyPath);
      if ( !descriptor ) continue;
      const entry = buildEntry({
        actor,
        descriptor,
        amount: unitsOf(delta),
        origin: ORIGINS.activity,
        dedupeKey: `${token}|${itemId}|${keyPath}`
      });
      if ( entry ) entries.push(entry);
    }
  }

  if ( !entries.length ) return;
  try {
    await recordSpend(actor, entries);
  } catch(err) {
    log.failure(`Could not record activity consumption for "${actor.name}".`, err);
  }
}

/* -------------------------------------------- */
/*  Route 2: direct document edits              */
/* -------------------------------------------- */

/**
 * Should this update be examined at all?
 * @param {object} options  Document update options.
 * @returns {boolean}
 */
function shouldDiff(options) {
  if ( isInternal(options) ) return false;
  if ( options?.isRest || options?.isAdvancement ) return false;
  return setting(SETTINGS.trackManualEdits);
}

/**
 * Should a *new expenditure* be recorded for an update from this user?
 *
 * A GM nudging a value on a sheet is normally a correction rather than a character actually
 * spending something. Refunds are never gated this way: when a resource comes back — a GM
 * handing a charge over, a dnd5e `refund()`, a Midi-QOL undo — the ledger must always be
 * reconciled, or a stale entry would restore it a second time at the next rest.
 *
 * @param {string} userId
 * @returns {boolean}
 */
function shouldRecordSpends(userId) {
  if ( setting(SETTINGS.trackGmDirectEdits) ) return true;
  return !game.users.get(userId)?.isGM;
}

/**
 * Collect the tracked changes in an update payload.
 * @param {Document} doc
 * @param {object} changed
 * @param {RegExp[]} patterns
 * @returns {Array<{keyPath: string, delta: number, value: any}>}
 */
function collectChanges(doc, changed, patterns) {
  const results = [];
  for ( const [keyPath, value] of Object.entries(foundry.utils.flattenObject(changed)) ) {
    if ( !patterns.some(p => p.test(keyPath)) ) continue;
    const next = Number(value);
    const current = Number(foundry.utils.getProperty(doc, keyPath));
    if ( !Number.isFinite(next) || !Number.isFinite(current) ) continue;
    const delta = next - current;
    if ( !delta ) continue;
    results.push({ keyPath, delta, value });
  }
  return results;
}

/**
 * @param {Actor} actor
 * @param {object} changed
 * @param {object} options
 * @param {string} userId
 */
function onPreUpdateActor(actor, changed, options, userId) {
  if ( !shouldDiff(options) ) return;
  const recordSpends = shouldRecordSpends(userId);

  const spends = [];
  const refunds = [];

  for ( const { keyPath, delta, value } of collectChanges(actor, changed, TRACKED_ACTOR_PATHS) ) {
    if ( claimFingerprint(actor.uuid, keyPath, value) ) continue;
    const descriptor = describeActorPath(actor, keyPath);
    if ( !descriptor ) continue;

    if ( isExpenditure(keyPath, delta) ) {
      if ( !recordSpends ) continue;
      const entry = buildEntry({ actor, descriptor, amount: unitsOf(delta), origin: ORIGINS.manual });
      if ( entry ) spends.push(entry);
    } else {
      refunds.push({ resource: descriptor.resource, amount: unitsOf(delta) });
    }
  }

  dispatch(actor, spends, refunds);
}

/**
 * @param {Item} item
 * @param {object} changed
 * @param {object} options
 * @param {string} userId
 */
function onPreUpdateItem(item, changed, options, userId) {
  const actor = item.actor;
  if ( !actor || !shouldDiff(options) ) return;
  const recordSpends = shouldRecordSpends(userId);

  const spends = [];
  const refunds = [];

  for ( const { keyPath, delta, value } of collectChanges(item, changed, TRACKED_ITEM_PATHS) ) {
    if ( claimFingerprint(item.uuid, keyPath, value) ) continue;
    const descriptor = describeItemPath(actor, item, keyPath);
    if ( !descriptor ) continue;

    if ( isExpenditure(keyPath, delta) ) {
      if ( !recordSpends ) continue;
      const entry = buildEntry({ actor, descriptor, amount: unitsOf(delta), origin: ORIGINS.manual });
      if ( entry ) spends.push(entry);
    } else {
      refunds.push({ resource: descriptor.resource, amount: unitsOf(delta) });
    }
  }

  dispatch(actor, spends, refunds);
}

/**
 * Ship whatever the diff turned up. Deliberately not awaited: `preUpdate` hooks must stay
 * synchronous so they do not delay the write they are observing.
 * @param {Actor} actor
 * @param {object[]} spends
 * @param {object[]} refunds
 */
function dispatch(actor, spends, refunds) {
  if ( spends.length ) {
    recordSpend(actor, spends).catch(err => log.failure(`Could not record a manual expenditure for "${actor.name}".`, err));
  }
  if ( refunds.length ) {
    reconcileSpend(actor, refunds).catch(err => log.failure(`Could not reconcile a refund for "${actor.name}".`, err));
  }
}

/* -------------------------------------------- */
/*  Hit points                                  */
/* -------------------------------------------- */

/**
 * Damage and healing both arrive through dnd5e's own hook, which usefully separates real hit
 * points from temporary ones and skips anything applied as part of a rest. It fires on every
 * connected client, so only the authoritative one may write.
 *
 * @param {Actor} actor
 * @param {{hp: number, temp: number, total: number}} changes
 */
function onHitPointChange(actor, changes) {
  if ( hpMode() !== HP_MODES.debt ) return;
  if ( !isAuthority() ) return;

  // `changes.temp` is ignored outright: temporary hit points never create or clear debt.
  const delta = Math.trunc(changes.hp ?? 0);
  if ( !delta ) return;

  applyHitPointChange(actor, delta)
    .catch(err => log.failure(`Could not update hit point debt for "${actor.name}".`, err));
}

/* -------------------------------------------- */

/**
 * Attach every detection hook. Called once during `ready`.
 */
export function registerConsumptionWatcher() {
  Hooks.on("dnd5e.activityConsumption", onActivityConsumption);
  Hooks.on("dnd5e.postActivityConsumption", onPostActivityConsumption);

  Hooks.on("preUpdateActor", onPreUpdateActor);
  Hooks.on("preUpdateItem", onPreUpdateItem);

  Hooks.on("dnd5e.damageActor", (actor, changes) => onHitPointChange(actor, changes));
  Hooks.on("dnd5e.healActor", (actor, changes) => onHitPointChange(actor, changes));

  log.debug("Consumption watcher attached.");
}
