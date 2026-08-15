import { REST_TYPE, SETTINGS, log, t } from "../constants.mjs";
import { setting } from "../settings.mjs";

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
 * Attach the suppression hooks. Called once during `ready`.
 */
export function registerNativeRestBlocking() {
  Hooks.on("dnd5e.preShortRest", blockNativeRest(SETTINGS.hideShortRest));
  Hooks.on("dnd5e.preLongRest", blockNativeRest(SETTINGS.hideLongRest));
  checkRestVariant();
}
