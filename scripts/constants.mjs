/**
 * Module-wide identifiers and the logger.
 * This file must not import anything else from the module so it can be pulled in from any layer.
 */

/** @type {string} */
export const MODULE_ID = "gritty-realism-rests";

/** Socket channel used for GM-authority operations. */
export const SOCKET = `module.${MODULE_ID}`;

/** Key of the actor flag holding the whole persisted state. */
export const STATE_FLAG = "state";

/** Full path to the persisted state, for use with `foundry.utils.getProperty`. */
export const STATE_PATH = `flags.${MODULE_ID}.${STATE_FLAG}`;

/** Key of the item/activity flag holding a GM recovery override. */
export const OVERRIDE_FLAG = "recovery";

/** The rest type registered into `CONFIG.DND5E.restTypes`. */
export const REST_TYPE = "gritty";

/** Current schema version of the persisted state. Bump alongside a migration. */
export const SCHEMA_VERSION = 1;

/**
 * Settings keys, collected so typos surface as import errors rather than silent `undefined`.
 * @enum {string}
 */
export const SETTINGS = {
  shortRestCount: "shortRestCount",
  longRestCount: "longRestCount",
  dailyRestCount: "dailyRestCount",
  hitDiceRestCount: "hitDiceRestCount",
  hpMode: "hpMode",
  debtOrder: "debtOrder",
  restDuration: "restDuration",
  allowPlayerRest: "allowPlayerRest",
  hudIntegration: "hudIntegration",
  chatSummary: "chatSummary",
  exhaustionDelta: "exhaustionDelta",
  trackManualEdits: "trackManualEdits",
  trackGmDirectEdits: "trackGmDirectEdits",
  hideShortRest: "hideShortRest",
  hideLongRest: "hideLongRest",
  sheetPlacement: "sheetPlacement",
  contextMenu: "contextMenu",
  poorRestShort: "poorRestShort",
  poorRestLong: "poorRestLong",
  poorRestDay: "poorRestDay",
  poorRestHitDice: "poorRestHitDice",
  autoRecoverShort: "autoRecoverShort",
  autoRecoverLong: "autoRecoverLong",
  autoRecoverDay: "autoRecoverDay",
  autoRecoverHitDice: "autoRecoverHitDice",
  logLevel: "logLevel"
};

/**
 * Order in which healing is applied to outstanding hit point debt.
 * @enum {string}
 */
export const DEBT_ORDERS = {
  /** Oldest wound closes first. */
  fifo: "fifo",
  /** Most recent wound closes first, so old debt lingers. */
  lifo: "lifo"
};

/**
 * Where the recovery display lives on the character sheet.
 * @enum {string}
 */
export const SHEET_PLACEMENTS = {
  /** Its own entry in the sheet's tab strip. */
  tab: "tab",
  /** Inline at the top of the details tab. */
  panel: "panel",
  /** Not shown at all. */
  hidden: "hidden"
};

/**
 * HP handling modes.
 * @enum {string}
 */
export const HP_MODES = {
  /** Mode A: no automatic full heal; hit dice are the healing vector between rests. */
  gritty: "gritty",
  /** Mode B: damage becomes debt that matures after the long-rest cooldown. */
  debt: "debt"
};

/**
 * Where a ledger entry came from. Purely informational, but surfaced in the GM ledger.
 * @enum {string}
 */
export const ORIGINS = {
  activity: "activity",
  manual: "manual",
  gm: "gm",
  api: "api"
};

/**
 * Kinds of recoverable resource the module understands. New kinds only need an address
 * resolver in the dnd5e adapter; nothing else is hardcoded against this list.
 * @enum {string}
 */
export const RESOURCE_KINDS = {
  spellSlot: "spellSlot",
  itemUses: "itemUses",
  activityUses: "activityUses",
  attribute: "attribute",
  resource: "resource",
  hitDice: "hitDice",
  /** A free-standing entry with no document behind it — a lingering wound, a curse, a favour owed. */
  note: "note"
};

/**
 * Recovery periods collapsed into the groups the rest quality reasons about.
 * @enum {string}
 */
export const RECOVERY_GROUPS = {
  short: "short",
  long: "long",
  day: "day",
  hitDice: "hitDice",
  other: "other"
};

/**
 * The group a dnd5e recovery period belongs to.
 * @param {string} period
 * @returns {string}  One of {@link RECOVERY_GROUPS}.
 */
export function groupOfPeriod(period) {
  switch ( period ) {
    case "sr": return RECOVERY_GROUPS.short;
    case "lr": return RECOVERY_GROUPS.long;
    case "day":
    case "dawn":
    case "dusk": return RECOVERY_GROUPS.day;
    case "hitDice": return RECOVERY_GROUPS.hitDice;
    default: return RECOVERY_GROUPS.other;
  }
}

/**
 * The canonical period to store for a group chosen by hand.
 * @param {string} group
 * @returns {string}
 */
export function periodOfGroup(group) {
  switch ( group ) {
    case RECOVERY_GROUPS.short: return "sr";
    case RECOVERY_GROUPS.long: return "lr";
    case RECOVERY_GROUPS.day: return "day";
    case RECOVERY_GROUPS.hitDice: return "hitDice";
    default: return "custom";
  }
}

/**
 * How well the night went. A poor rest still passes time, but does not credit every kind of
 * cooldown — by default the long-rest ones stand still, so a week of broken sleep never
 * restores a spell slot.
 * @enum {string}
 */
export const REST_QUALITIES = {
  full: "full",
  poor: "poor"
};

/**
 * dnd5e recovery periods the module deliberately leaves alone. Recharge and the combat
 * periods are already short-lived and self-managing, so intercepting them would be wrong.
 * @type {Set<string>}
 */
export const PASSTHROUGH_PERIODS = new Set(["recharge", "turn", "turnStart", "turnEnd", "initiative"]);

/* -------------------------------------------- */
/*  Logging                                     */
/* -------------------------------------------- */

const LEVELS = { off: 0, error: 1, warn: 2, debug: 3 };
const PREFIX = "[Gritty Realism]";

/**
 * Read the configured log level without throwing before settings are registered.
 * @returns {number}
 */
function threshold() {
  try {
    return LEVELS[game.settings.get(MODULE_ID, SETTINGS.logLevel)] ?? LEVELS.error;
  } catch {
    return LEVELS.error;
  }
}

export const log = {
  /**
   * @param {...any} args
   */
  error(...args) {
    if ( threshold() >= LEVELS.error ) console.error(PREFIX, ...args);
  },

  /**
   * @param {...any} args
   */
  warn(...args) {
    if ( threshold() >= LEVELS.warn ) console.warn(PREFIX, ...args);
  },

  /**
   * @param {...any} args
   */
  debug(...args) {
    if ( threshold() >= LEVELS.debug ) console.log(PREFIX, ...args);
  },

  /**
   * Log an unexpected failure without letting it escape into the caller. Optional integrations
   * use this so a broken third-party module can never take the session down with it.
   * @param {string} context  Where the failure happened.
   * @param {Error} err       The caught error.
   */
  failure(context, err) {
    console.error(`${PREFIX} ${context}`, err);
  }
};

/**
 * Localize a module key.
 * @param {string} key             Key relative to the module's i18n namespace.
 * @param {object} [data]          Interpolation data.
 * @returns {string}
 */
export function t(key, data) {
  const full = `GRITTY.${key}`;
  return data ? game.i18n.format(full, data) : game.i18n.localize(full);
}
