import { MODULE_ID, log, t } from "./constants.mjs";
import { registerSettings, registerSettingsMenu } from "./settings.mjs";
import { api } from "./api.mjs";
import ConfigApp from "./ui/config-app.mjs";

import { registerStoreHandlers } from "./data/actor-store.mjs";
import { registerSocket, isAuthority } from "./data/authority.mjs";
import { migrateWorld } from "./data/migrations.mjs";
import { registerRestHandlers } from "./domain/rest-service.mjs";

import { registerRestType, supportsNativeRest } from "./adapters/dnd5e-adapter.mjs";
import { registerConsumptionWatcher } from "./adapters/consumption-watcher.mjs";
import { registerMidiAdapter } from "./adapters/midi-adapter.mjs";
import { registerSheetAdapter } from "./adapters/sheet-adapter.mjs";
import { registerNativeRestBlocking } from "./adapters/native-rests.mjs";
import { registerTokenActionHud } from "./adapters/tah-adapter.mjs";
import { registerChat } from "./ui/chat.mjs";

/**
 * Module lifecycle.
 *
 * `init`  — settings, the custom rest type, socket operations and the HUD hook, all of which
 *           must exist before any actor data is prepared or the HUD builds its layout.
 * `setup` — publish the API so other modules can reach it before the world finishes loading.
 * `ready` — attach the runtime hooks and run migrations on the authoritative client.
 */

Hooks.once("init", () => {
  registerSettings();
  registerSettingsMenu(ConfigApp);

  registerStoreHandlers();
  registerRestHandlers();

  registerTokenActionHud();

  log.debug("Initialized.");
});

// The rest type carries a localized label, and translations are only loaded once `init` has
// finished — `i18nInit` is the first point where localizing it is safe, and still long before
// anything reads `CONFIG.DND5E.restTypes`.
Hooks.once("i18nInit", () => registerRestType());

Hooks.once("setup", () => {
  const module = game.modules.get(MODULE_ID);
  if ( module ) module.api = api;
});

Hooks.once("ready", async () => {
  if ( game.system.id !== "dnd5e" ) {
    log.error(`This module requires the dnd5e system; the active system is "${game.system.id}".`);
    return;
  }

  registerSocket();

  registerConsumptionWatcher();
  registerMidiAdapter();
  registerNativeRestBlocking();
  registerSheetAdapter();
  registerChat();

  if ( !supportsNativeRest() ) {
    log.warn(t("Warning.RestFallback"));
    if ( game.user.isGM ) ui.notifications.warn(t("Warning.RestFallback"));
  }

  if ( isAuthority() ) {
    try {
      await migrateWorld();
    } catch(err) {
      log.failure("World migration failed.", err);
    }
  }

  log.debug(`Ready. dnd5e ${game.system.version}, Foundry ${game.version}.`);
});
