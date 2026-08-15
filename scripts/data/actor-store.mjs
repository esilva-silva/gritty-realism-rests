import { MODULE_ID, STATE_FLAG, STATE_PATH, log } from "../constants.mjs";
import { normalizeState, blankState } from "../domain/models.mjs";
import { execute, registerHandler, isAuthority } from "./authority.mjs";

/**
 * The Actor Flag Repository.
 *
 * All persisted module state lives under `flags.gritty-realism-rests.state` and is only ever
 * read through {@link readState}, which normalizes it, and only ever written through
 * {@link writeState}, which serializes the write and routes it to the authoritative client.
 * No other module's data is touched.
 */

/** Name of the authority operation that persists state. */
const OP_WRITE = "writeState";

/** @type {Map<string, Promise<any>>} Per-actor promise chain, serializing writes. */
const queues = new Map();

/**
 * Run `fn` after every previously queued operation for this actor has settled.
 *
 * This is what makes a double-clicked Take Rest button safe: the second click's read of the
 * state happens after the first click's write, so it sees the already-incremented rest index
 * and the idempotency check catches it.
 *
 * @template T
 * @param {string} actorId
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function queue(actorId, fn) {
  const previous = queues.get(actorId) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(fn);
  queues.set(actorId, next);
  next.catch(() => {}).finally(() => {
    if ( queues.get(actorId) === next ) queues.delete(actorId);
  });
  return next;
}

/**
 * Read an actor's module state, normalized and safe to mutate by the caller.
 * @param {Actor} actor
 * @returns {import("../domain/models.mjs").RestState}
 */
export function readState(actor) {
  if ( !actor ) return blankState();
  return normalizeState(foundry.utils.getProperty(actor, STATE_PATH));
}

/**
 * Does this actor have persisted state yet?
 * @param {Actor} actor
 * @returns {boolean}
 */
export function hasState(actor) {
  return foundry.utils.getProperty(actor, STATE_PATH) !== undefined;
}

/**
 * Persist state, optionally alongside other actor changes in the same update.
 *
 * @param {Actor} actor
 * @param {import("../domain/models.mjs").RestState} state
 * @param {object} [options]
 * @param {object} [options.updateData]  Additional actor update data merged into the same write.
 * @param {object} [options.context]     Extra document update context.
 * @returns {Promise<void>}
 */
export async function writeState(actor, state, { updateData = {}, context = {} } = {}) {
  return execute(OP_WRITE, {
    actorUuid: actor.uuid,
    state,
    updateData,
    context
  });
}

/**
 * Clear all module state from an actor.
 * @param {Actor} actor
 * @returns {Promise<void>}
 */
export async function clearState(actor) {
  return writeState(actor, blankState());
}

/**
 * Mark an update as originating from this module so the consumption watcher ignores it.
 * Without this, every recovery we apply would look like a resource change worth tracking.
 * @param {object} [context={}]
 * @returns {object}
 */
export function internalContext(context = {}) {
  return foundry.utils.mergeObject(context, { [MODULE_ID]: { internal: true } }, { inplace: false });
}

/**
 * Was this document update produced by the module itself?
 * @param {object} options  Document update options.
 * @returns {boolean}
 */
export function isInternal(options) {
  return options?.[MODULE_ID]?.internal === true;
}

/**
 * Register the authoritative write handler. Called once during `init`.
 */
export function registerStoreHandlers() {
  registerHandler(OP_WRITE, async ({ actorUuid, state, updateData, context }) => {
    const actor = await fromUuid(actorUuid);
    if ( !actor ) throw new Error(`${MODULE_ID}: actor ${actorUuid} not found.`);

    const update = foundry.utils.mergeObject(
      { [`flags.${MODULE_ID}.${STATE_FLAG}`]: state },
      updateData ?? {},
      { inplace: false }
    );

    await actor.update(update, internalContext(context ?? {}));
    log.debug(`State written for ${actor.name}.`, state);
  });
}

/**
 * Actors the current user may take a rest for.
 * @returns {Actor[]}
 */
export function ownedActors() {
  return game.actors.filter(a => a.isOwner && canRest(a));
}

/**
 * Is this actor a valid target for the rest system? Vehicles have no rest flow in dnd5e and
 * groups are containers rather than creatures.
 * @param {Actor} actor
 * @returns {boolean}
 */
export function canRest(actor) {
  return !!actor && !["vehicle", "group", "encounter"].includes(actor.type);
}

/**
 * Whether the state write will happen locally, which lets callers skip an await round-trip
 * in hot paths such as damage tracking.
 * @returns {boolean}
 */
export { isAuthority };
