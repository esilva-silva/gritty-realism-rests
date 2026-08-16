import { REST_TYPE, SETTINGS, log, t } from "../constants.mjs";
import { setting } from "../settings.mjs";
import { mutate } from "../domain/rest-service.mjs";

/**
 * Suppression of the system's own rest flow.
 *
 * `dnd5e.preShortRest` and `dnd5e.preLongRest` are the system's documented cancellation points
 * and sit upstream of every entry route — the sheet buttons, the Token Action HUD, macros
 * calling `actor.longRest()`, and the rest-request chat messages. Blocking there means the
 * module never has to police individual user interfaces, and nothing in dnd5e is patched.
 *
 * The module's own rest is unaffected: it uses a distinct rest type and enters through
 * `_rest`, which is downstream of these hooks.
 */

/**
 * Build a blocker for one native rest type. Short and long rests are gated independently, so a
 * table can keep short rests working normally while long rests go through the module.
 * @param {string} settingKey  Setting that decides whether this rest type is suppressed.
 * @returns {(actor: Actor, config: object) => boolean|void}
 */
function blockNativeRest(settingKey) {
  return (actor, config) => {
    if ( !setting(settingKey) ) return;
    if ( config?.type === REST_TYPE ) return;

    ui.notifications.warn(t("Warning.NativeRestBlocked"));
    log.debug(`Blocked a native ${config?.type ?? "unknown"} rest for ${actor?.name}.`);
    return false;
  };
}

/**
 * Warn once if the system's own rest variant would fight the module's pacing.
 *
 * With `restVariant` set to "gritty", dnd5e multiplies day/dawn/dusk recharge formulas by
 * seven. The module already decides how often those resources come back, so leaving both
 * enabled double-counts the same houserule.
 */
function checkRestVariant() {
  try {
    if ( game.settings.get("dnd5e", "restVariant") === "normal" ) return;
    if ( !game.user.isGM ) return;
    ui.notifications.warn(t("Warning.RestVariant"), { permanent: true });
  } catch(err) {
    log.debug("Could not read the dnd5e restVariant setting.", err);
  }
}

/**
 * Bring the ledger back in line after a native rest the world chose to keep.
 *
 * A Short or Long Rest that is still enabled genuinely restores resources through the system,
 * which leaves the ledger holding entries for things that are already full. Those entries would
 * show a full resource as recovering and, worse, hand it back a second time when they matured.
 *
 * What the rest restored is read from the system's own `restTypes` configuration rather than
 * assumed, so a world that has customised those periods is followed exactly.
 *
 * @param {Actor} actor
 * @param {object} result  The dnd5e rest result.
 * @param {object} config  The rest configuration.
 */
function syncAfterNativeRest(actor, result, config) {
  const type = result?.type ?? config?.type;
  if ( !type || (type === REST_TYPE) ) return;      // our own rest keeps its own books

  // `restCompleted` fires only on the client that performed the rest, which may well be a
  // player. The mutation routes itself to the GM, so there is deliberately no authority guard
  // here — adding one would silently skip the sync whenever a player rested.
  const restConfig = CONFIG.DND5E?.restTypes?.[type];
  if ( !restConfig ) return;

  const periods = new Set(restConfig.recoverPeriods ?? []);
  if ( result?.newDay || config?.newDay ) ["day", "dawn", "dusk"].forEach(p => periods.add(p));

  // Positive means dice came back. A short rest spends them, which is an expenditure the
  // watcher already recorded, so only recovery is of interest here.
  const hitDiceRecovered = Math.max(0, result?.deltas?.hitDice ?? result?.dhd ?? 0);

  mutate(actor, "syncNativeRest", {
    type,
    periods: [...periods],
    hitDiceRecovered,
    clearDebt: !!restConfig.recoverHitPoints
  }).catch(err => log.failure(`Could not reconcile the ledger after a native rest for "${actor.name}".`, err));
}

/**
 * Attach the suppression hooks. Called once during `ready`.
 */
export function registerNativeRestBlocking() {
  Hooks.on("dnd5e.preShortRest", blockNativeRest(SETTINGS.hideShortRest));
  Hooks.on("dnd5e.preLongRest", blockNativeRest(SETTINGS.hideLongRest));
  Hooks.on("dnd5e.restCompleted", syncAfterNativeRest);
  checkRestVariant();
}
