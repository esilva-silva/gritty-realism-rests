import { MODULE_ID, SOCKET, log } from "../constants.mjs";

/**
 * GM-authority transport.
 *
 * Ledger writes must be serialized and must not race between clients, so every mutation is
 * funnelled through a single authoritative user — the active GM. A client that already has
 * authority runs the handler inline; anyone else ships the request over the module socket and
 * awaits the acknowledgement.
 *
 * Foundry's native socket is used directly rather than socketlib, so the module has no hard
 * dependency on another package for what amounts to one request/response channel.
 */

/** @type {Map<string, (payload: object, userId: string) => Promise<any>>} */
const handlers = new Map();

/** @type {Map<string, {resolve: Function, reject: Function, timeout: number}>} */
const pending = new Map();

/** How long a delegated request may take before the caller gives up. */
const TIMEOUT_MS = 20_000;

/**
 * Is this client the one that performs authoritative writes?
 * `game.users.activeGM` resolves to the same user on every client, which is what makes
 * hooks that fire everywhere (like `dnd5e.damageActor`) safe to act on.
 * @returns {boolean}
 */
export function isAuthority() {
  return game.users?.activeGM?.isSelf === true;
}

/**
 * Is there any GM connected who could service a delegated request?
 * @returns {boolean}
 */
export function hasAuthority() {
  return !!game.users?.activeGM;
}

/**
 * Register a named operation that the authoritative client knows how to perform.
 * @param {string} name                                          Operation name.
 * @param {(payload: object, userId: string) => Promise<any>} fn  Implementation.
 */
export function registerHandler(name, fn) {
  handlers.set(name, fn);
}

/**
 * Run a named operation, locally if possible and via the GM otherwise.
 * @param {string} name     Operation registered with {@link registerHandler}.
 * @param {object} payload  Serializable arguments.
 * @returns {Promise<any>}  Whatever the handler returned.
 */
export async function execute(name, payload) {
  if ( isAuthority() ) return runLocal(name, payload, game.user.id);

  if ( !hasAuthority() ) throw new Error(`${MODULE_ID}: no active GM is available to perform "${name}".`);

  const requestId = foundry.utils.randomID();
  const promise = new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`${MODULE_ID}: request "${name}" timed out.`));
    }, TIMEOUT_MS);
    pending.set(requestId, { resolve, reject, timeout });
  });

  log.debug(`Delegating "${name}" to the active GM.`, payload);
  game.socket.emit(SOCKET, { type: "request", requestId, name, payload, userId: game.user.id });
  return promise;
}

/**
 * @param {string} name
 * @param {object} payload
 * @param {string} userId  User on whose behalf the operation runs.
 * @returns {Promise<any>}
 */
async function runLocal(name, payload, userId) {
  const handler = handlers.get(name);
  if ( !handler ) throw new Error(`${MODULE_ID}: no handler registered for "${name}".`);
  return handler(payload, userId);
}

/**
 * Wire up the socket listener. Safe to call once, from `ready`.
 */
export function registerSocket() {
  game.socket.on(SOCKET, async data => {
    if ( !data?.type ) return;

    if ( (data.type === "request") && isAuthority() ) {
      let response;
      try {
        const result = await runLocal(data.name, data.payload, data.userId);
        response = { type: "response", requestId: data.requestId, result };
      } catch(err) {
        log.failure(`Failed to service "${data.name}" for user ${data.userId}.`, err);
        response = { type: "response", requestId: data.requestId, error: err.message };
      }
      game.socket.emit(SOCKET, response);
      return;
    }

    if ( data.type === "response" ) {
      const entry = pending.get(data.requestId);
      if ( !entry ) return;
      pending.delete(data.requestId);
      window.clearTimeout(entry.timeout);
      if ( data.error ) entry.reject(new Error(data.error));
      else entry.resolve(data.result);
    }
  });
}
