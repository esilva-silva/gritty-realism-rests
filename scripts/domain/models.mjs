import { SCHEMA_VERSION, ORIGINS, RESOURCE_KINDS } from "../constants.mjs";

/**
 * @typedef {object} RecoveryResource
 * @property {string} kind          One of {@link RESOURCE_KINDS}.
 * @property {string} keyPath       Document-relative path of the value that changed.
 * @property {string} key           Short stable key, used to group entries in the UI.
 * @property {string} [itemId]      Owning item, for item- and activity-scoped resources.
 * @property {string} [activityId]  Owning activity, for activity uses.
 */

/**
 * @typedef {object} RecoveryPolicy
 * @property {string} period     dnd5e recovery period that produced this policy (`sr`, `lr`, ...).
 * @property {number} restCount  Number of rests before the expenditure returns.
 * @property {string} source     `"override" | "system" | "default"` — why this policy was chosen.
 */

/**
 * @typedef {object} RecoveryEntry
 * @property {string} id
 * @property {RecoveryResource} resource
 * @property {number} amount               Units to give back. Always a positive integer.
 * @property {RecoveryPolicy} policy
 * @property {number} spentAtRestIndex
 * @property {number} recoverAtRestIndex
 * @property {{worldTime: number, timestamp: number}} spentAt
 * @property {string} origin               One of {@link ORIGINS}.
 * @property {string} label                Human label for summaries.
 * @property {string} [img]
 * @property {string} [dedupeKey]          Guards against the same expenditure being recorded twice.
 */

/**
 * @typedef {object} DebtEntry
 * @property {string} id
 * @property {number} amount               Hit points originally lost.
 * @property {number} remaining            Hit points still owed after healing paid some back.
 * @property {number} incurredAtRestIndex
 * @property {number} recoverAtRestIndex
 * @property {string} label
 */

/**
 * @typedef {object} RestState
 * @property {number} schemaVersion
 * @property {number} restIndex
 * @property {string|null} lastRestId
 * @property {RecoveryEntry[]} entries
 * @property {DebtEntry[]} debt
 */

/**
 * A brand new, empty state.
 * @returns {RestState}
 */
export function blankState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    restIndex: 0,
    lastRestId: null,
    entries: [],
    debt: []
  };
}

/**
 * Coerce a value to a non-negative integer, defaulting when it is not usable.
 * @param {any} value
 * @param {number} [fallback=0]
 * @returns {number}
 */
function int(value, fallback = 0) {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Normalize whatever is stored on the actor into a well-formed {@link RestState}.
 *
 * Every read goes through here, so downstream code never has to defend against partially
 * written or hand-edited flags. Unrecognized entries are dropped rather than repaired,
 * because a malformed entry would otherwise recover the wrong resource forever.
 *
 * @param {object} [raw]  Raw flag value.
 * @returns {RestState}
 */
export function normalizeState(raw) {
  const state = blankState();
  if ( !raw || (typeof raw !== "object") ) return state;

  state.schemaVersion = int(raw.schemaVersion, SCHEMA_VERSION);
  state.restIndex = Math.max(0, int(raw.restIndex, 0));
  state.lastRestId = (typeof raw.lastRestId === "string") ? raw.lastRestId : null;
  state.entries = (Array.isArray(raw.entries) ? raw.entries : []).map(normalizeEntry).filter(e => e !== null);
  state.debt = (Array.isArray(raw.debt) ? raw.debt : []).map(normalizeDebt).filter(d => d !== null);

  return state;
}

/**
 * @param {object} raw
 * @returns {RecoveryEntry|null}  `null` when the entry cannot be addressed back to a resource.
 */
function normalizeEntry(raw) {
  if ( !raw || (typeof raw !== "object") ) return null;
  const resource = raw.resource;
  if ( !resource?.kind || !resource?.keyPath ) return null;
  if ( !Object.values(RESOURCE_KINDS).includes(resource.kind) ) return null;

  const amount = int(raw.amount, 0);
  if ( amount <= 0 ) return null;

  const spentAtRestIndex = Math.max(0, int(raw.spentAtRestIndex, 0));
  const restCount = Math.max(0, int(raw.policy?.restCount, 0));

  return {
    id: (typeof raw.id === "string") ? raw.id : foundry.utils.randomID(),
    resource: {
      kind: resource.kind,
      keyPath: String(resource.keyPath),
      key: String(resource.key ?? resource.keyPath),
      itemId: resource.itemId ?? undefined,
      activityId: resource.activityId ?? undefined
    },
    amount,
    policy: {
      period: String(raw.policy?.period ?? "lr"),
      restCount,
      source: String(raw.policy?.source ?? "default")
    },
    spentAtRestIndex,
    recoverAtRestIndex: int(raw.recoverAtRestIndex, spentAtRestIndex + restCount),
    spentAt: {
      worldTime: int(raw.spentAt?.worldTime, 0),
      timestamp: int(raw.spentAt?.timestamp, 0)
    },
    origin: Object.values(ORIGINS).includes(raw.origin) ? raw.origin : ORIGINS.manual,
    label: String(raw.label ?? resource.key ?? resource.keyPath),
    description: (typeof raw.description === "string") ? raw.description : undefined,
    img: (typeof raw.img === "string") ? raw.img : undefined,
    dedupeKey: (typeof raw.dedupeKey === "string") ? raw.dedupeKey : undefined
  };
}

/**
 * @param {object} raw
 * @returns {DebtEntry|null}
 */
function normalizeDebt(raw) {
  if ( !raw || (typeof raw !== "object") ) return null;
  const amount = int(raw.amount, 0);
  const remaining = Math.min(int(raw.remaining, amount), amount);
  if ( (amount <= 0) || (remaining <= 0) ) return null;

  const incurredAtRestIndex = Math.max(0, int(raw.incurredAtRestIndex, 0));
  return {
    id: (typeof raw.id === "string") ? raw.id : foundry.utils.randomID(),
    amount,
    remaining,
    incurredAtRestIndex,
    recoverAtRestIndex: int(raw.recoverAtRestIndex, incurredAtRestIndex),
    label: String(raw.label ?? "")
  };
}

/**
 * Build a ledger entry for a single expenditure.
 *
 * @param {object} data
 * @param {RecoveryResource} data.resource
 * @param {number} data.amount
 * @param {RecoveryPolicy} data.policy
 * @param {number} data.restIndex          Actor's rest index at the moment of spending.
 * @param {string} data.label
 * @param {string} [data.img]
 * @param {string} [data.origin]
 * @param {string} [data.dedupeKey]
 * @returns {RecoveryEntry}
 */
export function makeEntry({ resource, amount, policy, restIndex, label, description, img, origin, dedupeKey }) {
  return {
    id: foundry.utils.randomID(),
    resource,
    amount: Math.max(1, int(amount, 1)),
    policy,
    spentAtRestIndex: restIndex,
    recoverAtRestIndex: restIndex + Math.max(0, policy.restCount),
    spentAt: {
      worldTime: game.time?.worldTime ?? 0,
      timestamp: Date.now()
    },
    origin: origin ?? ORIGINS.manual,
    label,
    description,
    img,
    dedupeKey
  };
}

/**
 * Build a hit-point debt entry.
 * @param {object} data
 * @param {number} data.amount
 * @param {number} data.restIndex
 * @param {number} data.restCount
 * @param {string} [data.label]
 * @returns {DebtEntry}
 */
export function makeDebt({ amount, restIndex, restCount, label }) {
  return {
    id: foundry.utils.randomID(),
    amount,
    remaining: amount,
    incurredAtRestIndex: restIndex,
    recoverAtRestIndex: restIndex + Math.max(0, restCount),
    label: label ?? ""
  };
}

/**
 * Stable identity for a resource, used to match expenditures against refunds and to group
 * entries for display. Two entries sharing an address point at the same underlying number.
 * @param {RecoveryResource} resource
 * @returns {string}
 */
export function resourceAddress(resource) {
  return [resource.kind, resource.itemId ?? "-", resource.activityId ?? "-", resource.keyPath].join("|");
}
