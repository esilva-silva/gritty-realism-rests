import { MODULE_ID, SETTINGS, HP_MODES } from "./constants.mjs";

/**
 * Registers every world/client setting. Called from the `init` hook so the values are
 * available to the rules engine before any actor data is prepared.
 */
export function registerSettings() {
  const register = (key, data) => game.settings.register(MODULE_ID, key, data);

  register(SETTINGS.shortRestCount, {
    name: "GRITTY.Settings.ShortRestCount.Name",
    hint: "GRITTY.Settings.ShortRestCount.Hint",
    scope: "world",
    config: true,
    type: new foundry.data.fields.NumberField({ min: 0, integer: true, initial: 1, nullable: false })
  });

  register(SETTINGS.longRestCount, {
    name: "GRITTY.Settings.LongRestCount.Name",
    hint: "GRITTY.Settings.LongRestCount.Hint",
    scope: "world",
    config: true,
    type: new foundry.data.fields.NumberField({ min: 0, integer: true, initial: 7, nullable: false })
  });

  register(SETTINGS.dailyRestCount, {
    name: "GRITTY.Settings.DailyRestCount.Name",
    hint: "GRITTY.Settings.DailyRestCount.Hint",
    scope: "world",
    config: true,
    type: new foundry.data.fields.NumberField({ min: 0, integer: true, initial: 1, nullable: false })
  });

  register(SETTINGS.hitDiceRestCount, {
    name: "GRITTY.Settings.HitDiceRestCount.Name",
    hint: "GRITTY.Settings.HitDiceRestCount.Hint",
    scope: "world",
    config: true,
    type: new foundry.data.fields.NumberField({ min: 0, integer: true, initial: 14, nullable: false })
  });

  register(SETTINGS.hpMode, {
    name: "GRITTY.Settings.HpMode.Name",
    hint: "GRITTY.Settings.HpMode.Hint",
    scope: "world",
    config: true,
    type: String,
    default: HP_MODES.debt,
    choices: {
      [HP_MODES.debt]: "GRITTY.Settings.HpMode.Debt",
      [HP_MODES.gritty]: "GRITTY.Settings.HpMode.Gritty"
    }
  });

  register(SETTINGS.restDuration, {
    name: "GRITTY.Settings.RestDuration.Name",
    hint: "GRITTY.Settings.RestDuration.Hint",
    scope: "world",
    config: true,
    type: new foundry.data.fields.NumberField({ min: 0, integer: true, initial: 480, nullable: false })
  });

  register(SETTINGS.allowPlayerRest, {
    name: "GRITTY.Settings.AllowPlayerRest.Name",
    hint: "GRITTY.Settings.AllowPlayerRest.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  register(SETTINGS.hideNativeRests, {
    name: "GRITTY.Settings.HideNativeRests.Name",
    hint: "GRITTY.Settings.HideNativeRests.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  register(SETTINGS.hudIntegration, {
    name: "GRITTY.Settings.HudIntegration.Name",
    hint: "GRITTY.Settings.HudIntegration.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  register(SETTINGS.chatSummary, {
    name: "GRITTY.Settings.ChatSummary.Name",
    hint: "GRITTY.Settings.ChatSummary.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  register(SETTINGS.exhaustionDelta, {
    name: "GRITTY.Settings.ExhaustionDelta.Name",
    hint: "GRITTY.Settings.ExhaustionDelta.Hint",
    scope: "world",
    config: true,
    type: new foundry.data.fields.NumberField({ integer: true, initial: 0, nullable: false })
  });

  register(SETTINGS.trackManualEdits, {
    name: "GRITTY.Settings.TrackManualEdits.Name",
    hint: "GRITTY.Settings.TrackManualEdits.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  register(SETTINGS.trackGmDirectEdits, {
    name: "GRITTY.Settings.TrackGmDirectEdits.Name",
    hint: "GRITTY.Settings.TrackGmDirectEdits.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });

  register(SETTINGS.logLevel, {
    name: "GRITTY.Settings.LogLevel.Name",
    hint: "GRITTY.Settings.LogLevel.Hint",
    scope: "client",
    config: true,
    type: String,
    default: "error",
    choices: {
      off: "GRITTY.Settings.LogLevel.Off",
      error: "GRITTY.Settings.LogLevel.Error",
      warn: "GRITTY.Settings.LogLevel.Warn",
      debug: "GRITTY.Settings.LogLevel.Debug"
    }
  });
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
 * The number of rests each recovery period costs, resolved from settings.
 * Used by the rules engine; kept here so all tunable numbers live in one place.
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
