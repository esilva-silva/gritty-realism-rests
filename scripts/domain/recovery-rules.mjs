import { MODULE_ID, OVERRIDE_FLAG, PASSTHROUGH_PERIODS, RESOURCE_KINDS, SETTINGS, log } from "../constants.mjs";
import { periodCosts, setting } from "../settings.mjs";

/**
 * Recovery Rules Engine.
 *
 * Decides how many Rests an expenditure costs before it comes back. Nothing here contains a
 * hardcoded list of features or spells: the answer is always derived from the dnd5e data on
 * the document, from a GM override, or from a caller-registered rule.
 *
 * Resolution order (highest priority first):
 *   1. A GM override flag on the activity, then on the item.
 *   2. A rule registered through the module API.
 *   3. The structured dnd5e recovery period on the activity/item uses.
 *   4. The intrinsic period of the resource kind (pact vs. leveled slots, hit dice).
 *   5. The configured long-rest cooldown.
 */

/**
 * @typedef {object} RuleContext
 * @property {string} kind          One of {@link RESOURCE_KINDS}.
 * @property {string} key           Short resource key (`spell3`, `pact`, `d8`, ...).
 * @property {Actor} actor
 * @property {Item} [item]
 * @property {object} [activity]    dnd5e Activity instance.
 */

/**
 * Custom rules contributed via the public API, newest first.
 * @type {Array<{id: string, fn: (context: RuleContext) => (import("./models.mjs").RecoveryPolicy|null)}>}
 */
const customRules = [];

/**
 * Register a rule that can decide the recovery policy for a resource.
 * The rule returns `null` to defer to the next resolution step.
 * @param {string} id
 * @param {(context: RuleContext) => (import("./models.mjs").RecoveryPolicy|null)} fn
 */
export function registerRule(id, fn) {
  const existing = customRules.findIndex(r => r.id === id);
  if ( existing >= 0 ) customRules.splice(existing, 1);
  customRules.unshift({ id, fn });
  log.debug(`Registered recovery rule "${id}".`);
}

/**
 * Remove a previously registered rule.
 * @param {string} id
 * @returns {boolean}  Whether a rule was removed.
 */
export function unregisterRule(id) {
  const index = customRules.findIndex(r => r.id === id);
  if ( index < 0 ) return false;
  customRules.splice(index, 1);
  return true;
}

/* -------------------------------------------- */

/**
 * Read a `{ mode, restCount }` override off a document's module flag.
 * @param {Document|object} doc
 * @returns {{mode: string, restCount?: number}|null}
 */
function readOverride(doc) {
  if ( !doc ) return null;
  const flags = (typeof doc.getFlag === "function")
    ? doc.getFlag(MODULE_ID, OVERRIDE_FLAG)
    : foundry.utils.getProperty(doc, `flags.${MODULE_ID}.${OVERRIDE_FLAG}`);
  if ( !flags?.mode || (flags.mode === "auto") ) return null;
  return flags;
}

/**
 * Turn an override flag into a policy.
 * @param {{mode: string, restCount?: number}} override
 * @param {string} period
 * @returns {import("./models.mjs").RecoveryPolicy|null}
 */
function policyFromOverride(override, period) {
  if ( override.mode === "disabled" ) return null;
  if ( override.mode === "custom" ) {
    const restCount = Math.max(0, Math.trunc(Number(override.restCount)));
    if ( Number.isFinite(restCount) ) return { period, restCount, source: "override" };
  }
  return null;
}

/**
 * The first recovery period declared on a uses block, ignoring the periods the module leaves
 * to the system (recharge, per-turn, initiative).
 * @param {object} [uses]  A dnd5e uses data model.
 * @returns {string|null}
 */
function periodFromUses(uses) {
  const recovery = uses?.recovery;
  if ( !recovery?.length ) return null;

  const costs = periodCosts();
  for ( const profile of recovery ) {
    const period = profile?.period;
    if ( !period || PASSTHROUGH_PERIODS.has(period) ) continue;
    if ( period in costs ) return period;
  }
  return null;
}

/**
 * Does this uses block recover only through a mechanism the module deliberately ignores?
 * Such resources keep their native behaviour and never enter the ledger.
 * @param {object} [uses]
 * @returns {boolean}
 */
export function isPassthrough(uses) {
  const recovery = uses?.recovery;
  if ( !recovery?.length ) return false;
  return recovery.every(profile => PASSTHROUGH_PERIODS.has(profile?.period));
}

/**
 * The period a resource falls back to when the document carries no structured recovery data.
 * @param {RuleContext} context
 * @returns {string}
 */
function intrinsicPeriod({ kind, key, actor }) {
  if ( kind === RESOURCE_KINDS.hitDice ) return "hitDice";

  if ( kind === RESOURCE_KINDS.spellSlot ) {
    // Pact magic returns on a short rest; everything else is a long-rest resource.
    const slot = actor?.system?.spells?.[key];
    return (slot?.type === "pact") ? "sr" : "lr";
  }

  if ( kind === RESOURCE_KINDS.resource ) {
    // Legacy `system.resources.*` entries carry their own sr/lr booleans.
    const resource = actor?.system?.resources?.[key];
    if ( resource?.sr ) return "sr";
    if ( resource?.lr ) return "lr";
  }

  return "lr";
}

/**
 * Number of rests a period costs.
 * @param {string} period
 * @returns {number}
 */
export function costOf(period) {
  if ( period === "hitDice" ) return setting(SETTINGS.hitDiceRestCount);
  const costs = periodCosts();
  return costs[period] ?? costs.lr;
}

/**
 * Resolve the recovery policy for a single expenditure.
 *
 * @param {RuleContext} context
 * @returns {import("./models.mjs").RecoveryPolicy|null}  `null` when the resource must not be
 *                                                        tracked at all (disabled by override,
 *                                                        or handled natively by the system).
 */
export function resolvePolicy(context) {
  const { item, activity } = context;

  // 1. Overrides, activity first so a single activity can differ from its item.
  for ( const doc of [activity, item] ) {
    const override = readOverride(doc);
    if ( !override ) continue;
    if ( override.mode === "disabled" ) {
      log.debug(`Recovery disabled by override for ${doc?.name ?? "document"}.`);
      return null;
    }
    const policy = policyFromOverride(override, "override");
    if ( policy ) return policy;
  }

  // 2. Caller-registered rules.
  for ( const rule of customRules ) {
    try {
      const policy = rule.fn(context);
      if ( policy ) return { source: "custom", ...policy };
    } catch(err) {
      log.failure(`Recovery rule "${rule.id}" threw; ignoring it.`, err);
    }
  }

  // 3. Structured dnd5e recovery data.
  const uses = activity?.uses ?? item?.system?.uses;
  if ( uses?.recovery?.length ) {
    if ( isPassthrough(uses) ) {
      log.debug(`Leaving ${item?.name ?? "resource"} to the system: only passthrough periods.`);
      return null;
    }
    const period = periodFromUses(uses);
    if ( period ) return { period, restCount: costOf(period), source: "system" };
  }

  // 4/5. Intrinsic period for the resource kind, falling back to the long-rest cooldown.
  const period = intrinsicPeriod(context);
  return { period, restCount: costOf(period), source: "default" };
}
