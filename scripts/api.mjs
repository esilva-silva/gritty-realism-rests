import { MODULE_ID, REST_TYPE, SETTINGS, REST_QUALITIES, RECOVERY_GROUPS } from "./constants.mjs";
import { promptNewEntry, promptItemCooldown } from "./ui/entry-dialog.mjs";
import { setting } from "./settings.mjs";
import {
  takeRest, advanceRests, partyRest, previewRest,
  getRecoveryState, getPendingRecoveries, canTakeRest, mutate
} from "./domain/rest-service.mjs";
import { registerRule, unregisterRule, costOf } from "./domain/recovery-rules.mjs";
import { readState, clearState } from "./data/actor-store.mjs";
import { totalDebt } from "./domain/hp-debt.mjs";
import { promptRest } from "./adapters/sheet-adapter.mjs";
import { promptPartyRest } from "./ui/party-dialog.mjs";

/**
 * Public API, reachable as `game.modules.get("gritty-realism-rests").api`.
 *
 * Hooks emitted by the module, all fired with `Hooks.callAll` unless noted:
 *   - `grittyRealism.preRest(actor, preview)` — cancellable; fires on the initiating client.
 *   - `grittyRealism.restComplete(actor, report)` — fires on the client that applied the rest.
 *   - `grittyRealism.resourceSpent(actor, entry)` — once per recorded expenditure.
 *   - `grittyRealism.resourceRecovered(actor, entry)` — once per matured entry.
 */
export const api = {
  /** Module and rest-type identifiers, so macros do not have to hardcode strings. */
  MODULE_ID,
  REST_TYPE,

  /**
   * Take a rest without any prompt.
   * @param {Actor} actor
   * @param {object} [options]
   * @returns {Promise<object|null>}
   */
  takeRest,

  /**
   * Show the confirmation dialog, then rest if the user accepts.
   * @param {Actor} actor
   * @returns {Promise<void>}
   */
  promptRest,

  /**
   * Process several rests back to back.
   * @param {Actor} actor
   * @param {number} count
   * @param {object} [options]
   * @returns {Promise<object[]>}
   */
  advanceRests,

  /**
   * Rest several actors, each keeping its own ledger.
   * @param {Actor[]} actors
   * @param {object} [options]
   * @returns {Promise<object[]>}
   */
  partyRest,

  /**
   * Prompt for which owned actors should rest, then rest them.
   * @param {Actor[]} [candidates]
   * @returns {Promise<object[]>}
   */
  promptPartyRest,

  /**
   * What a rest would do, without changing anything.
   * @param {Actor} actor
   * @param {number} [steps=1]
   * @returns {object}
   */
  previewRest,

  /**
   * Current ledger summary: rest index, ready resources, pending recoveries and debt.
   * @param {Actor} actor
   * @returns {object}
   */
  getRecoveryState,

  /**
   * Every outstanding ledger entry, unaggregated.
   * @param {Actor} actor
   * @returns {object[]}
   */
  getPendingRecoveries,

  /**
   * The raw persisted state, normalized.
   * @param {Actor} actor
   * @returns {object}
   */
  getState: readState,

  /**
   * Whether the current user may rest this actor, and why not if they may not.
   * @param {Actor} actor
   * @returns {{allowed: boolean, reason?: string}}
   */
  canTakeRest,

  /**
   * Hit points still owed under Recovery Debt.
   * @param {Actor} actor
   * @returns {number}
   */
  getDebt: actor => totalDebt(readState(actor)),

  /**
   * Discard all module state for an actor.
   * @param {Actor} actor
   * @returns {Promise<void>}
   */
  resetState: clearState,

  /**
   * Apply a GM correction. Kinds: `removeEntry`, `recoverNow`, `reschedule`, `setRestIndex`,
   * `setDebt`, `removeDebt`, `hitPoints`, `reset`.
   * @param {Actor} actor
   * @param {string} kind
   * @param {object} payload
   * @returns {Promise<any>}
   */
  mutate,

  /**
   * Register a rule that decides the recovery policy for a resource. The rule receives
   * `{kind, key, actor, item, activity}` and returns `{period, restCount}` or `null` to defer.
   * @param {string} id
   * @param {Function} fn
   */
  registerRecoveryRule: registerRule,

  /**
   * Remove a previously registered rule.
   * @param {string} id
   * @returns {boolean}
   */
  unregisterRecoveryRule: unregisterRule,

  /**
   * Rests a given recovery period currently costs.
   * @param {string} period  `sr`, `lr`, `day`, `dawn`, `dusk` or `hitDice`.
   * @returns {number}
   */
  costOf,

  /**
   * Read a module setting by key.
   * @param {string} key  One of {@link SETTINGS}.
   * @returns {any}
   */
  setting,

  /** Setting keys, for use with {@link api.setting}. */
  SETTINGS,

  /** Rest qualities accepted by {@link api.takeRest}. */
  REST_QUALITIES,

  /** Cooldown groups a rest quality can credit or hold back. */
  RECOVERY_GROUPS,

  /**
   * Prompt for a free-standing cooldown — a lingering wound, a curse — and record it.
   * @param {Actor} actor
   * @returns {Promise<boolean>}
   */
  promptNewEntry,

  /**
   * Prompt to put an existing item's uses on cooldown by hand.
   * @param {Item} item
   * @returns {Promise<boolean>}
   */
  promptItemCooldown
};
