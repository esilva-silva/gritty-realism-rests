import { MODULE_ID, SETTINGS, HP_MODES, DEBT_ORDERS, SHEET_PLACEMENTS } from "./constants.mjs";

/**
 * Settings Manager.
 *
 * Every setting is registered with `config: false` and surfaced through the module's own
 * configuration screen instead. One screen that groups the cooldowns, the hit point rules and
 * the integrations — with room to explain what each one actually does — reads far better than
 * fourteen loose rows in Foundry's global list.
 */

/**
 * Declarative description of every setting, consumed both by {@link registerSettings} and by
 * the configuration application so the two can never drift apart.
 * @type {Array<{key: string, group: string, type: any, default: any, choices?: object, range?: object}>}
 */
export const SETTING_DEFINITIONS = [
  { key: SETTINGS.shortRestCount, group: "cooldowns", type: Number, default: 1, range: { min: 0, max: 60 } },
  { key: SETTINGS.longRestCount, group: "cooldowns", type: Number, default: 7, range: { min: 0, max: 60 } },
  { key: SETTINGS.dailyRestCount, group: "cooldowns", type: Number, default: 1, range: { min: 0, max: 60 } },
  { key: SETTINGS.hitDiceRestCount, group: "cooldowns", type: Number, default: 14, range: { min: 0, max: 60 } },

  {
    key: SETTINGS.hpMode, group: "hitPoints", type: String, default: HP_MODES.debt,
    choices: {
      [HP_MODES.debt]: "GRITTY.Settings.HpMode.Debt",
      [HP_MODES.gritty]: "GRITTY.Settings.HpMode.Gritty"
    }
  },
  {
    key: SETTINGS.debtOrder, group: "hitPoints", type: String, default: DEBT_ORDERS.fifo,
    choices: {
      [DEBT_ORDERS.fifo]: "GRITTY.Settings.DebtOrder.Fifo",
      [DEBT_ORDERS.lifo]: "GRITTY.Settings.DebtOrder.Lifo"
    }
  },

  { key: SETTINGS.restDuration, group: "rest", type: Number, default: 480, range: { min: 0, max: 10080 } },
  { key: SETTINGS.exhaustionDelta, group: "rest", type: Number, default: 0, range: { min: -6, max: 6 } },
  { key: SETTINGS.allowPlayerRest, group: "rest", type: Boolean, default: true },
  { key: SETTINGS.chatSummary, group: "rest", type: Boolean, default: true },

  { key: SETTINGS.trackManualEdits, group: "tracking", type: Boolean, default: true },
  // Defaults to on. The two failure modes are not symmetric: switched off, a GM who also plays
  // loses expenditures silently and has no way to notice; switched on, the worst case is a
  // spurious ledger entry, which is visible on the sheet and removable in one click.
  { key: SETTINGS.trackGmDirectEdits, group: "tracking", type: Boolean, default: true },

  { key: SETTINGS.hideShortRest, group: "integration", type: Boolean, default: true },
  { key: SETTINGS.hideLongRest, group: "integration", type: Boolean, default: true },
  { key: SETTINGS.hudIntegration, group: "integration", type: Boolean, default: true },
  {
    key: SETTINGS.sheetPlacement, group: "integration", type: String, default: SHEET_PLACEMENTS.tab,
    choices: {
      [SHEET_PLACEMENTS.tab]: "GRITTY.Settings.SheetPlacement.Tab",
      [SHEET_PLACEMENTS.panel]: "GRITTY.Settings.SheetPlacement.Panel",
      [SHEET_PLACEMENTS.hidden]: "GRITTY.Settings.SheetPlacement.Hidden"
    }
  },

  {
    key: SETTINGS.logLevel, group: "advanced", type: String, default: "error", scope: "client",
    choices: {
      off: "GRITTY.Settings.LogLevel.Off",
      error: "GRITTY.Settings.LogLevel.Error",
      warn: "GRITTY.Settings.LogLevel.Warn",
      debug: "GRITTY.Settings.LogLevel.Debug"
    }
  }
];

/** Order the groups appear in on the configuration screen. */
export const SETTING_GROUPS = ["cooldowns", "hitPoints", "rest", "tracking", "integration", "advanced"];

/**
 * Register every setting. Called from `init`.
 *
 * The menu that opens the configuration screen is registered separately, from the module entry
 * point, so that this file stays free of any dependency on the UI layer — the domain modules
 * import it for `setting()`, and dragging an ApplicationV2 subclass in behind them would both
 * invert the layering and make the domain untestable outside Foundry.
 */
export function registerSettings() {
  for ( const definition of SETTING_DEFINITIONS ) {
    game.settings.register(MODULE_ID, definition.key, {
      name: `GRITTY.Settings.${capitalize(definition.key)}.Name`,
      hint: `GRITTY.Settings.${capitalize(definition.key)}.Hint`,
      scope: definition.scope ?? "world",
      config: false,
      type: definition.type,
      default: definition.default,
      ...(definition.choices ? { choices: definition.choices } : {})
    });
  }
}

/**
 * Register the settings menu entry.
 * @param {typeof foundry.applications.api.ApplicationV2} application  The configuration screen.
 */
export function registerSettingsMenu(application) {
  game.settings.registerMenu(MODULE_ID, "configuration", {
    name: "GRITTY.Config.MenuName",
    label: "GRITTY.Config.MenuLabel",
    hint: "GRITTY.Config.MenuHint",
    icon: "fa-solid fa-moon",
    type: application,
    restricted: true
  });
}

/**
 * `shortRestCount` -> `ShortRestCount`, for building localization keys.
 * @param {string} key
 * @returns {string}
 */
function capitalize(key) {
  return key.charAt(0).toUpperCase() + key.slice(1);
}

/**
 * Read a module setting.
 * @param {string} key  One of {@link SETTINGS}.
 * @returns {any}
 */
export function setting(key) {
  return game.settings.get(MODULE_ID, key);
}

/**
 * Write a module setting.
 * @param {string} key
 * @param {any} value
 * @returns {Promise<any>}
 */
export function setSetting(key, value) {
  return game.settings.set(MODULE_ID, key, value);
}

/**
 * The number of rests each recovery period costs, resolved from settings.
 * @returns {Record<string, number>}
 */
export function periodCosts() {
  const daily = setting(SETTINGS.dailyRestCount);
  return {
    sr: setting(SETTINGS.shortRestCount),
    lr: setting(SETTINGS.longRestCount),
    day: daily,
    dawn: daily,
    dusk: daily
  };
}
