import { RECOVERY_GROUPS, SETTINGS, t } from "../constants.mjs";
import { setting } from "../settings.mjs";
import { mutate } from "../domain/rest-service.mjs";

const { DialogV2 } = foundry.applications.api;

/**
 * Dialogs for putting something on cooldown by hand.
 *
 * Two shapes of the same idea: a free-standing entry that stands for a condition with no
 * document behind it — a lingering wound, a curse — and a cooldown attached to an item the
 * character already owns, for the small corrections that come up mid-session.
 */

/** Groups offered when choosing by hand, in the order they read best. */
const OFFERED_GROUPS = [RECOVERY_GROUPS.short, RECOVERY_GROUPS.long, RECOVERY_GROUPS.day];

/**
 * Build the `<select>` of cooldown types.
 * @param {string} selected
 * @returns {string}
 */
function groupOptions(selected) {
  return OFFERED_GROUPS.map(group => {
    const rests = defaultRests(group);
    const label = `${t(`Group.${group}`)} (${rests})`;
    return `<option value="${group}" ${group === selected ? "selected" : ""}>${label}</option>`;
  }).join("");
}

/**
 * The configured cooldown length for a group, used to prefill the rest count.
 * @param {string} group
 * @returns {number}
 */
function defaultRests(group) {
  switch ( group ) {
    case RECOVERY_GROUPS.short: return setting(SETTINGS.shortRestCount);
    case RECOVERY_GROUPS.day: return setting(SETTINGS.dailyRestCount);
    default: return setting(SETTINGS.longRestCount);
  }
}

/* -------------------------------------------- */

/**
 * Prompt for a free-standing cooldown entry and record it.
 * @param {Actor} actor
 * @returns {Promise<boolean>}  Whether an entry was added.
 */
export async function promptNewEntry(actor) {
  const group = RECOVERY_GROUPS.long;

  const content = `
    <div class="gritty-entry-form">
      <div class="form-group">
        <label for="gritty-entry-label">${t("Entry.Name")}</label>
        <div class="form-fields">
          <input type="text" id="gritty-entry-label" name="label" autofocus
                 placeholder="${t("Entry.NamePlaceholder")}">
        </div>
      </div>
      <div class="form-group">
        <label for="gritty-entry-description">${t("Entry.Description")}</label>
        <div class="form-fields">
          <textarea id="gritty-entry-description" name="description" rows="2"
                    placeholder="${t("Entry.DescriptionPlaceholder")}"></textarea>
        </div>
      </div>
      <div class="form-group">
        <label for="gritty-entry-group">${t("Entry.Type")}</label>
        <div class="form-fields">
          <select id="gritty-entry-group" name="group">${groupOptions(group)}</select>
        </div>
        <p class="hint">${t("Entry.TypeHint")}</p>
      </div>
      <div class="form-group">
        <label for="gritty-entry-rests">${t("Entry.Rests")}</label>
        <div class="form-fields">
          <input type="number" id="gritty-entry-rests" name="restCount" min="0" step="1"
                 value="${defaultRests(group)}">
        </div>
      </div>
    </div>`;

  const data = await DialogV2.wait({
    window: { title: t("Entry.Add"), icon: "fa-solid fa-plus" },
    classes: ["gritty-realism", "gritty-entry-dialog"],
    position: { width: 420 },
    content,
    buttons: [
      {
        action: "add",
        label: t("Entry.Confirm"),
        icon: "fa-solid fa-check",
        default: true,
        callback: (event, button) => new foundry.applications.ux.FormDataExtended(button.form).object
      },
      { action: "cancel", label: t("Rest.Cancel"), icon: "fa-solid fa-xmark" }
    ],
    render: (event, dialog) => {
      // Re-prefill the rest count whenever the type changes, but leave a hand-typed number alone.
      const form = dialog.element.querySelector("form") ?? dialog.element;
      const select = form.querySelector('[name="group"]');
      const rests = form.querySelector('[name="restCount"]');
      let touched = false;
      rests?.addEventListener("input", () => { touched = true; });
      select?.addEventListener("change", () => {
        if ( !touched ) rests.value = defaultRests(select.value);
      });
    },
    rejectClose: false
  });

  if ( !data || !data.label?.trim() ) return false;

  await mutate(actor, "addEntry", {
    label: data.label.trim(),
    description: data.description?.trim() || undefined,
    group: data.group,
    restCount: Number(data.restCount) || 0
  });
  return true;
}

/* -------------------------------------------- */

/**
 * Prompt to put an existing item on cooldown.
 * @param {Item} item
 * @returns {Promise<boolean>}  Whether a cooldown was added.
 */
export async function promptItemCooldown(item) {
  const actor = item.actor;
  if ( !actor ) return false;

  // Start from whatever the item itself declares, so the common case is one click away.
  const period = item.system?.uses?.recovery?.[0]?.period;
  const group = ({ sr: RECOVERY_GROUPS.short, lr: RECOVERY_GROUPS.long, day: RECOVERY_GROUPS.day,
    dawn: RECOVERY_GROUPS.day, dusk: RECOVERY_GROUPS.day })[period] ?? RECOVERY_GROUPS.long;
  const hasUses = !!item.system?.uses?.max;

  const content = `
    <div class="gritty-entry-form">
      <p class="gritty-hint">${t("Entry.ItemHint", { name: item.name })}</p>
      <div class="form-group">
        <label for="gritty-item-group">${t("Entry.Type")}</label>
        <div class="form-fields">
          <select id="gritty-item-group" name="group">${groupOptions(group)}</select>
        </div>
      </div>
      <div class="form-group">
        <label for="gritty-item-rests">${t("Entry.Rests")}</label>
        <div class="form-fields">
          <input type="number" id="gritty-item-rests" name="restCount" min="0" step="1"
                 value="${defaultRests(group)}">
        </div>
      </div>
      ${hasUses ? `
      <div class="form-group">
        <label for="gritty-item-amount">${t("Entry.Amount")}</label>
        <div class="form-fields">
          <input type="number" id="gritty-item-amount" name="amount" min="1" step="1" value="1">
        </div>
      </div>
      <div class="form-group">
        <label for="gritty-item-consume">${t("Entry.Consume")}</label>
        <div class="form-fields">
          <input type="checkbox" id="gritty-item-consume" name="consume" checked>
        </div>
        <p class="hint">${t("Entry.ConsumeHint")}</p>
      </div>` : ""}
    </div>`;

  const data = await DialogV2.wait({
    window: { title: t("Entry.ItemTitle"), icon: "fa-solid fa-hourglass-half" },
    classes: ["gritty-realism", "gritty-entry-dialog"],
    position: { width: 420 },
    content,
    buttons: [
      {
        action: "add",
        label: t("Entry.Confirm"),
        icon: "fa-solid fa-check",
        default: true,
        callback: (event, button) => new foundry.applications.ux.FormDataExtended(button.form).object
      },
      { action: "cancel", label: t("Rest.Cancel"), icon: "fa-solid fa-xmark" }
    ],
    render: (event, dialog) => {
      const form = dialog.element.querySelector("form") ?? dialog.element;
      const select = form.querySelector('[name="group"]');
      const rests = form.querySelector('[name="restCount"]');
      let touched = false;
      rests?.addEventListener("input", () => { touched = true; });
      select?.addEventListener("change", () => {
        if ( !touched ) rests.value = defaultRests(select.value);
      });
    },
    rejectClose: false
  });

  if ( !data ) return false;

  await mutate(actor, "addItemCooldown", {
    itemId: item.id,
    group: data.group,
    restCount: Number(data.restCount) || 0,
    amount: Number(data.amount) || 1,
    consume: !!data.consume
  });
  return true;
}
