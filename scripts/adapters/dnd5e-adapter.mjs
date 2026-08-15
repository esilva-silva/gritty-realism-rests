import { REST_TYPE, RESOURCE_KINDS, SETTINGS, log, t } from "../constants.mjs";
import { setting } from "../settings.mjs";
import { internalContext } from "../data/actor-store.mjs";

/**
 * D&D5e Adapter.
 *
 * Everything that knows about dnd5e's data shapes lives here: how a consumption delta maps
 * onto a recoverable resource, how a recovery turns back into document updates, and how a
 * rest is actually executed. The domain layer never sees a key path.
 *
 * Key paths were verified against dnd5e 5.2.5:
 *   - spell slots    actor  `system.spells.<key>.value`            (decreases when spent)
 *   - item uses      item   `system.uses.spent`                    (increases when spent)
 *   - activity uses  item   `system.activities.<id>.uses.spent`    (increases when spent)
 *   - hit dice       item   `system.hd.spent` on the class item    (increases when spent)
 *   - attribute      actor  `system.<target>` or its `.spent` twin
 */

/** Item key paths that represent a consumable being used up rather than a charge being spent. */
const IGNORED_ITEM_PATHS = new Set(["system.quantity"]);

/* -------------------------------------------- */
/*  Rest type registration                      */
/* -------------------------------------------- */

/**
 * Register the module's rest type into `CONFIG.DND5E.restTypes`.
 *
 * The type deliberately recovers nothing: `recoverPeriods` is empty, no spell slot types are
 * listed, and hit points/dice are left alone. That makes every `_getRest*Recovery` helper in
 * `Actor5e#_rest` a no-op, so the recoveries the module computes are the only ones applied,
 * while the system still builds the chat card, fires `dnd5e.restCompleted` and advances time.
 */
export function registerRestType() {
  if ( !CONFIG.DND5E?.restTypes ) {
    log.error("CONFIG.DND5E.restTypes is unavailable; the dnd5e system may not be active.");
    return;
  }

  const duration = setting(SETTINGS.restDuration);
  CONFIG.DND5E.restTypes[REST_TYPE] = {
    // dnd5e pre-localizes its own rest labels during startup and never revisits the config, so
    // a type added afterwards has to arrive already localized or the chat flavor shows the key.
    label: t("Rest.Label"),
    icon: "fa-solid fa-moon",
    duration: { normal: duration, gritty: duration, epic: duration },
    activationPeriods: [],
    recoverPeriods: [],
    recoverSpellSlotTypes: new Set(),
    recoverHitDice: false,
    recoverHitPoints: false,
    recoverTemp: false,
    recoverTempMax: false
  };

  log.debug(`Registered rest type "${REST_TYPE}".`);
}

/**
 * Whether this dnd5e build exposes the internal rest routine the module prefers to drive.
 * @returns {boolean}
 */
export function supportsNativeRest() {
  return typeof CONFIG.Actor?.documentClass?.prototype?._rest === "function";
}

/* -------------------------------------------- */
/*  Consumption -> resource                     */
/* -------------------------------------------- */

/**
 * @typedef {object} ResourceDescriptor
 * @property {import("../domain/models.mjs").RecoveryResource} resource
 * @property {string} label
 * @property {string} [img]
 * @property {Item} [item]
 * @property {object} [activity]
 */

/**
 * Describe an actor-level key path as a recoverable resource.
 * @param {Actor} actor
 * @param {string} keyPath
 * @returns {ResourceDescriptor|null}  `null` when the path is not something the module tracks.
 */
export function describeActorPath(actor, keyPath) {
  // Spell slots — every `system.spells.<key>.value`, which covers spell1..9 and pact alike
  // without hardcoding the key set.
  const slotMatch = keyPath.match(/^system\.spells\.([^.]+)\.value$/);
  if ( slotMatch ) {
    const key = slotMatch[1];
    const slot = actor.system?.spells?.[key];
    if ( !slot ) return null;
    return {
      resource: { kind: RESOURCE_KINDS.spellSlot, keyPath, key },
      label: spellSlotLabel(key, slot)
    };
  }

  // Legacy per-actor resources.
  const resourceMatch = keyPath.match(/^system\.resources\.([^.]+)\.value$/);
  if ( resourceMatch ) {
    const key = resourceMatch[1];
    const resource = actor.system?.resources?.[key];
    if ( !resource ) return null;
    return {
      resource: { kind: RESOURCE_KINDS.resource, keyPath, key },
      label: resource.label || t("Resource.Resource", { key })
    };
  }

  // Hit points are handled by the debt system, never by the ledger.
  if ( keyPath.startsWith("system.attributes.hp") ) return null;

  // Anything else under `system.` reached through attribute consumption.
  if ( keyPath.startsWith("system.") ) {
    const key = keyPath.slice("system.".length);
    return {
      resource: { kind: RESOURCE_KINDS.attribute, keyPath, key },
      label: t("Resource.Attribute", { key })
    };
  }

  return null;
}

/**
 * Describe an item-level key path as a recoverable resource.
 * @param {Actor} actor
 * @param {Item} item
 * @param {string} keyPath
 * @returns {ResourceDescriptor|null}
 */
export function describeItemPath(actor, item, keyPath) {
  if ( !item || IGNORED_ITEM_PATHS.has(keyPath) ) return null;

  if ( keyPath === "system.uses.spent" ) {
    return {
      resource: { kind: RESOURCE_KINDS.itemUses, keyPath, key: item.id, itemId: item.id },
      label: item.name,
      img: item.img,
      item
    };
  }

  const activityMatch = keyPath.match(/^system\.activities\.([^.]+)\.uses\.spent$/);
  if ( activityMatch ) {
    const activityId = activityMatch[1];
    const activity = item.system?.activities?.get?.(activityId);
    return {
      resource: {
        kind: RESOURCE_KINDS.activityUses,
        keyPath,
        key: `${item.id}.${activityId}`,
        itemId: item.id,
        activityId
      },
      label: activity?.name ? `${item.name}: ${activity.name}` : item.name,
      img: activity?.img ?? item.img,
      item,
      activity
    };
  }

  if ( keyPath === "system.hd.spent" ) {
    const denomination = item.system?.hd?.denomination ?? "";
    return {
      resource: { kind: RESOURCE_KINDS.hitDice, keyPath, key: item.id, itemId: item.id },
      label: t("Resource.HitDice", { denomination }),
      img: item.img,
      item
    };
  }

  return null;
}

/**
 * Human label for a spell slot key.
 * @param {string} key
 * @param {object} slot
 * @returns {string}
 */
function spellSlotLabel(key, slot) {
  const level = slot.level ?? Number(key.replace("spell", "")) ?? 0;
  if ( slot.type === "pact" ) return t("Resource.PactSlot", { level });
  return t("Resource.SpellSlot", { level });
}

/**
 * Does a delta on this key path represent spending (as opposed to regaining)?
 *
 * dnd5e tracks some resources as remaining (`value`, which falls when spent) and others as
 * consumed (`spent`, which rises when spent), so the sign alone is not enough.
 *
 * @param {string} keyPath
 * @param {number} delta
 * @returns {boolean}
 */
export function isExpenditure(keyPath, delta) {
  return countsUpWhenSpent(keyPath) ? (delta > 0) : (delta < 0);
}

/**
 * How many units a delta represents, regardless of which direction the field counts.
 * @param {number} delta
 * @returns {number}
 */
export function unitsOf(delta) {
  return Math.abs(Math.trunc(delta));
}

/**
 * Whether the field at this key path increases as the resource is used up.
 * @param {string} keyPath
 * @returns {boolean}
 */
function countsUpWhenSpent(keyPath) {
  return keyPath.endsWith(".spent");
}

/* -------------------------------------------- */
/*  Recovery -> document updates                */
/* -------------------------------------------- */

/**
 * Translate matured ledger groups into document update payloads.
 *
 * Recovery is always clamped to the actor's current maximum, so a ledger that has drifted out
 * of sync — an entry left over after a level-up shrank a resource, say — can never push a
 * value above its cap.
 *
 * @param {Actor} actor
 * @param {Array<{resource: object, amount: number, label: string}>} groups
 * @returns {{updateData: object, updateItems: object[], applied: Array<{label: string, amount: number}>}}
 */
export function buildRecoveryUpdates(actor, groups) {
  const updateData = {};
  /** @type {Map<string, object>} */
  const itemUpdates = new Map();
  const applied = [];

  const itemUpdate = id => {
    let update = itemUpdates.get(id);
    if ( !update ) {
      update = { _id: id };
      itemUpdates.set(id, update);
    }
    return update;
  };

  for ( const group of groups ) {
    const { resource, amount, label } = group;
    try {
      switch ( resource.kind ) {
        case RESOURCE_KINDS.spellSlot: {
          const slot = actor.system?.spells?.[resource.key];
          if ( !slot ) break;
          const restored = Math.min(slot.max ?? 0, (slot.value ?? 0) + amount);
          const gained = restored - (slot.value ?? 0);
          if ( gained <= 0 ) break;
          updateData[resource.keyPath] = restored;
          applied.push({ label, amount: gained });
          break;
        }

        case RESOURCE_KINDS.resource: {
          const res = actor.system?.resources?.[resource.key];
          if ( !res ) break;
          const max = Number(res.max);
          const restored = Number.isFinite(max) ? Math.min(max, (res.value ?? 0) + amount) : (res.value ?? 0) + amount;
          const gained = restored - (res.value ?? 0);
          if ( gained <= 0 ) break;
          updateData[resource.keyPath] = restored;
          applied.push({ label, amount: gained });
          break;
        }

        case RESOURCE_KINDS.attribute: {
          const current = Number(foundry.utils.getProperty(actor, resource.keyPath));
          if ( !Number.isFinite(current) ) break;
          // `.spent`-style attributes count up as they are used, so recovery subtracts.
          const restored = countsUpWhenSpent(resource.keyPath)
            ? Math.max(0, current - amount)
            : current + amount;
          if ( restored === current ) break;
          updateData[resource.keyPath] = restored;
          applied.push({ label, amount });
          break;
        }

        case RESOURCE_KINDS.itemUses: {
          const item = actor.items.get(resource.itemId);
          if ( !item?.system?.uses ) break;
          const spent = item.system.uses.spent ?? 0;
          const restored = Math.clamp(spent - amount, 0, item.system.uses.max ?? spent);
          if ( restored === spent ) break;
          itemUpdate(item.id)["system.uses.spent"] = restored;
          applied.push({ label, amount: spent - restored });
          break;
        }

        case RESOURCE_KINDS.activityUses: {
          const item = actor.items.get(resource.itemId);
          const activity = item?.system?.activities?.get?.(resource.activityId);
          if ( !activity?.uses ) break;
          const spent = activity.uses.spent ?? 0;
          const restored = Math.clamp(spent - amount, 0, activity.uses.max ?? spent);
          if ( restored === spent ) break;
          itemUpdate(item.id)[`system.activities.${resource.activityId}.uses.spent`] = restored;
          applied.push({ label, amount: spent - restored });
          break;
        }

        case RESOURCE_KINDS.hitDice: {
          const item = actor.items.get(resource.itemId);
          if ( !item?.system?.hd ) break;
          const spent = item.system.hd.spent ?? 0;
          const restored = Math.clamp(spent - amount, 0, item.system.hd.max ?? spent);
          if ( restored === spent ) break;
          itemUpdate(item.id)["system.hd.spent"] = restored;
          applied.push({ label, amount: spent - restored });
          break;
        }

        default:
          log.warn(`Unknown resource kind "${resource.kind}"; skipping recovery for "${label}".`);
      }
    } catch(err) {
      log.failure(`Could not build a recovery update for "${label}".`, err);
    }
  }

  return { updateData, updateItems: Array.from(itemUpdates.values()), applied };
}

/* -------------------------------------------- */
/*  Rest execution                              */
/* -------------------------------------------- */

/**
 * Execute the rest against the actor.
 *
 * The preferred path hands a pre-computed result to `Actor5e#_rest`, which applies the updates,
 * posts the native rest card complete with deltas, and fires `dnd5e.restCompleted` so other
 * modules see a real rest. `_rest` is marked `@private` in the dnd5e sources, so the fallback
 * performs the same writes directly and builds an equivalent chat message.
 *
 * @param {Actor} actor
 * @param {object} options
 * @param {object} options.updateData
 * @param {object[]} options.updateItems
 * @param {Roll[]} [options.rolls]
 * @param {boolean} [options.chat]
 * @param {boolean} [options.advanceTime]
 * @returns {Promise<object>}  The dnd5e rest result.
 */
export async function executeRest(actor, { updateData, updateItems, rolls = [], chat = true, advanceTime = false }) {
  const config = {
    type: REST_TYPE,
    dialog: false,
    chat,
    newDay: false,
    advanceTime,
    advanceBastionTurn: false,
    duration: setting(SETTINGS.restDuration),
    exhaustionDelta: setting(SETTINGS.exhaustionDelta) || undefined,
    recoverTemp: false,
    recoverTempMax: false
  };

  if ( supportsNativeRest() ) {
    // `_rest` merges its defaults *under* the result we pass, so these updates survive intact.
    return actor._rest(config, {
      clone: actor.clone(),
      updateData: foundry.utils.deepClone(updateData),
      updateItems: foundry.utils.deepClone(updateItems),
      deleteItems: [],
      rolls
    });
  }

  return restFallback(actor, config, { updateData, updateItems, rolls });
}

/**
 * Apply a rest without the system's internal routine.
 * @param {Actor} actor
 * @param {object} config
 * @param {object} payload
 * @returns {Promise<object>}
 */
async function restFallback(actor, config, { updateData, updateItems, rolls }) {
  const context = internalContext({ isRest: true });

  if ( !foundry.utils.isEmpty(updateData) ) await actor.update(updateData, context);
  if ( updateItems.length ) await actor.updateEmbeddedDocuments("Item", updateItems, context);
  if ( config.advanceTime && (config.duration > 0) && game.user.isGM ) await game.time.advance(60 * config.duration);

  const result = { type: REST_TYPE, updateData, updateItems, deleteItems: [], rolls, newDay: false };
  Hooks.callAll("dnd5e.restCompleted", actor, result, config);
  return result;
}
