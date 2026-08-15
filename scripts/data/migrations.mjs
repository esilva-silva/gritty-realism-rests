import { SCHEMA_VERSION, log } from "../constants.mjs";
import { readState, writeState, hasState, canRest } from "./actor-store.mjs";

/**
 * Migration System.
 *
 * Each migration transforms a state object from `version` to `version + 1`. They run in order,
 * so a world several versions behind catches up in one pass. Migrations receive an already
 * normalized state and must return a state — they never touch the document directly.
 *
 * @type {Record<number, (state: object, actor: Actor) => object>}
 */
const MIGRATIONS = {
  // 0 -> 1: reserved. The first shipped schema is version 1; this entry exists so that state
  // written by a pre-release build without a version stamp is brought forward rather than
  // rejected by the normalizer.
  0: state => ({ ...state, schemaVersion: 1 })
};

/**
 * Migrate every actor whose stored state is behind the current schema version.
 * Only the authoritative client should call this.
 * @returns {Promise<number>}  Number of actors migrated.
 */
export async function migrateWorld() {
  const stale = game.actors.filter(a => canRest(a) && hasState(a) && (readState(a).schemaVersion < SCHEMA_VERSION));
  if ( !stale.length ) return 0;

  log.warn(`Migrating ${stale.length} actor(s) to schema version ${SCHEMA_VERSION}.`);

  let migrated = 0;
  for ( const actor of stale ) {
    try {
      const before = readState(actor);
      const after = migrateState(before, actor);
      await writeState(actor, after);
      migrated += 1;
    } catch(err) {
      log.failure(`Migration failed for actor "${actor.name}" (${actor.id}). Its state was left untouched.`, err);
    }
  }

  log.warn(`Migration complete: ${migrated}/${stale.length} actor(s) updated.`);
  return migrated;
}

/**
 * Bring a single state object up to the current schema version.
 * @param {object} state
 * @param {Actor} actor
 * @returns {object}
 */
export function migrateState(state, actor) {
  let current = state;
  let version = current.schemaVersion ?? 0;

  while ( version < SCHEMA_VERSION ) {
    const step = MIGRATIONS[version];
    if ( !step ) {
      // No path forward: stamp the current version rather than looping. The normalizer has
      // already discarded anything malformed, so the data is safe even if unconverted.
      log.warn(`No migration registered from schema version ${version}; stamping ${SCHEMA_VERSION}.`);
      break;
    }
    current = step(current, actor);
    version += 1;
  }

  return { ...current, schemaVersion: SCHEMA_VERSION };
}
