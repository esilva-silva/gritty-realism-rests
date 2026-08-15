import { log } from "../constants.mjs";

/**
 * Midi-QOL Adapter.
 *
 * Deliberately thin. Midi-QOL's activity mixin delegates to the dnd5e `ActivityMixin#use`,
 * which calls `consume()` and therefore fires `dnd5e.preActivityConsumption`,
 * `dnd5e.activityConsumption` and `dnd5e.postActivityConsumption` exactly once per usage —
 * with or without Midi installed. Verified against midi-qol v13.
 *
 * That means the consumption watcher needs no Midi-specific code path, and adding one would
 * be the very thing that causes the double-processing this module has to avoid. Midi's own
 * "other activity" consumption goes through `otherActivity.consume()` as well, so it is
 * recorded correctly as a genuine second expenditure.
 *
 * Undo is handled implicitly too: Midi restores resources with ordinary document updates, and
 * the watcher's refund branch reconciles the ledger from the resulting positive deltas without
 * reaching into any Midi internals.
 */

/**
 * Is Midi-QOL active in this world?
 * @returns {boolean}
 */
export function isMidiActive() {
  return game.modules.get("midi-qol")?.active === true;
}

/**
 * Report the detected integration so a mis-set world is diagnosable from the log rather than
 * from missing ledger entries.
 */
export function registerMidiAdapter() {
  if ( !isMidiActive() ) {
    log.debug("Midi-QOL is not active; consumption is read from the dnd5e activity hooks.");
    return;
  }

  const version = game.modules.get("midi-qol")?.version ?? "unknown";
  log.debug(
    `Midi-QOL ${version} detected. Consumption is still read from dnd5e's activity hooks, which `
    + "Midi routes through, so no additional integration is registered."
  );
}
