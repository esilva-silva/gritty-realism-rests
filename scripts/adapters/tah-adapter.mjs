import { SETTINGS, log, t } from "../constants.mjs";
import { setting } from "../settings.mjs";
import { canRest } from "../data/actor-store.mjs";
import { promptRest } from "./sheet-adapter.mjs";

/**
 * Token Action HUD integration.
 *
 * Uses only the documented extension points that TAH Core exposes through
 * `tokenActionHudCoreApiReady` and its two extender hooks, verified against core 2.0.16:
 *
 *   - `tokenActionHudCoreAddActionHandlerExtenders` to contribute the Take Rest action
 *   - `tokenActionHudCoreAddRollHandlerExtenders` to intercept the native rest actions
 *
 * Nothing in TAH or its dnd5e module is patched. The whole integration is optional and wrapped
 * in try/catch, so a HUD version that changes shape degrades to "no HUD button" rather than
 * breaking the session.
 */

/** Action ids the dnd5e TAH module uses for the native rests. */
const NATIVE_REST_ACTIONS = new Set(["shortRest", "longRest"]);

/** Our action id. */
const TAKE_REST_ACTION = "grittyTakeRest";

/**
 * Wire up the HUD integration. Called once during `init`, because TAH fires its API hook early.
 */
export function registerTokenActionHud() {
  if ( !game.modules.get("token-action-hud-core")?.active ) {
    log.debug("Token Action HUD is not active; skipping HUD integration.");
    return;
  }

  Hooks.on("tokenActionHudCoreApiReady", coreModule => {
    if ( !setting(SETTINGS.hudIntegration) ) return;

    try {
      const { ActionHandlerExtender, PreRollHandler } = coreModule.api;

      Hooks.on("tokenActionHudCoreAddActionHandlerExtenders", actionHandler => {
        try {
          actionHandler.addActionHandlerExtender(new (buildActionExtender(ActionHandlerExtender))());
        } catch(err) {
          log.failure("Could not register the Token Action HUD action extender.", err);
        }
      });

      Hooks.on("tokenActionHudCoreAddRollHandlerExtenders", rollHandler => {
        try {
          rollHandler.addPreRollHandler(new (buildPreRollHandler(PreRollHandler))());
        } catch(err) {
          log.failure("Could not register the Token Action HUD roll handler.", err);
        }
      });

      log.debug("Token Action HUD integration registered.");
    } catch(err) {
      log.failure("Token Action HUD exposed an unexpected API; integration skipped.", err);
    }
  });
}

/* -------------------------------------------- */

/**
 * Build the action extender class against the API the running TAH exposes.
 * @param {class} ActionHandlerExtender
 * @returns {class}
 */
function buildActionExtender(ActionHandlerExtender) {
  return class GrittyActionExtender extends ActionHandlerExtender {

    /** @override */
    extendActionHandler() {
      const actors = (this.actors?.length ? this.actors : [this.actor]).filter(a => a && canRest(a));
      if ( !actors.length ) return;

      try {
        if ( setting(SETTINGS.hideNativeRests) ) this.#removeNativeRests();
        this.#addTakeRest(actors);
      } catch(err) {
        log.failure("Could not extend the Token Action HUD rest actions.", err);
      }
    }

    /**
     * Drop the system module's Short and Long Rest entries from every group that holds them.
     */
    #removeNativeRests() {
      const groups = Object.values(this.groupHandler?.groups ?? {});
      for ( const group of groups ) {
        if ( !group?.actions?.length ) continue;
        const kept = group.actions.filter(action => !NATIVE_REST_ACTIONS.has(action.system?.actionId ?? action.id));
        if ( kept.length !== group.actions.length ) group.actions = kept;
      }
    }

    /**
     * Contribute the Take Rest action.
     *
     * An `onClick` action is handled by the HUD before any roll handler runs, so the module
     * does not need to claim an action type of its own.
     *
     * @param {Actor[]} actors
     */
    #addTakeRest(actors) {
      const name = t("Rest.Label");
      this.addActions([{
        id: TAKE_REST_ACTION,
        name,
        listName: `${t("Panel.Title")}: ${name}`,
        icon1: '<i class="fa-solid fa-moon"></i>',
        tooltip: t("Rest.Tooltip"),
        onClick: () => {
          for ( const actor of actors ) promptRest(actor);
        }
      }], { id: "rests" });
    }
  };
}

/* -------------------------------------------- */

/**
 * Build the pre-roll handler that blocks the native rest actions.
 *
 * The dnd5e rest hooks already refuse a short or long rest, but intercepting here means the
 * player gets the module's explanation instead of the system's generic refusal, and the HUD
 * never opens a rest dialog that is going to be cancelled anyway.
 *
 * @param {class} PreRollHandler
 * @returns {class}
 */
function buildPreRollHandler(PreRollHandler) {
  return class GrittyPreRollHandler extends PreRollHandler {

    /** @override */
    prehandleActionEvent(event, buttonValue) {
      if ( !setting(SETTINGS.hideNativeRests) ) return false;

      const actionId = this.action?.system?.actionId ?? this.action?.id ?? buttonValue;
      if ( !NATIVE_REST_ACTIONS.has(actionId) ) return false;

      ui.notifications.warn(t("Warning.NativeRestBlocked"));
      return true;
    }
  };
}
