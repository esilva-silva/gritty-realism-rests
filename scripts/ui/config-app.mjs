import { MODULE_ID, t } from "../constants.mjs";
import { SETTING_DEFINITIONS, SETTING_GROUPS, setting, setSetting } from "../settings.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * The module's configuration screen.
 *
 * Grouping the rules into one form — cooldowns, hit points, the rest itself, tracking,
 * integration — keeps related knobs together and leaves room to explain the ones whose
 * consequences are not obvious from their name.
 */
export default class ConfigApp extends HandlebarsApplicationMixin(ApplicationV2) {

  /** @override */
  static DEFAULT_OPTIONS = {
    id: "gritty-realism-config",
    classes: ["gritty-realism", "gritty-config"],
    tag: "form",
    window: { icon: "fa-solid fa-moon", resizable: true, contentClasses: ["standard-form"] },
    position: { width: 620, height: 720 },
    form: {
      handler: ConfigApp.#onSubmit,
      closeOnSubmit: true
    },
    actions: {
      reset: ConfigApp.#onReset
    }
  };

  /** @override */
  static PARTS = {
    body: { template: `modules/${MODULE_ID}/templates/config.hbs`, scrollable: [".gritty-config-scroll"] },
    footer: { template: "templates/generic/form-footer.hbs" }
  };

  /** @override */
  get title() {
    return t("Config.Title");
  }

  /* -------------------------------------------- */

  /** @override */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);

    context.groups = SETTING_GROUPS.map(group => ({
      id: group,
      label: t(`Config.Group.${capitalize(group)}.Label`),
      hint: t(`Config.Group.${capitalize(group)}.Hint`),
      fields: SETTING_DEFINITIONS.filter(d => d.group === group).map(describe)
    })).filter(group => group.fields.length);

    context.buttons = [
      { type: "button", action: "reset", icon: "fa-solid fa-rotate-left", label: t("Config.Reset") },
      { type: "submit", icon: "fa-solid fa-floppy-disk", label: t("Config.Save") }
    ];

    return context;
  }

  /* -------------------------------------------- */

  /**
   * Persist every changed field.
   * @this {ConfigApp}
   * @param {SubmitEvent} event
   * @param {HTMLFormElement} form
   * @param {object} formData
   */
  static async #onSubmit(event, form, formData) {
    const data = foundry.utils.expandObject(formData.object);

    for ( const definition of SETTING_DEFINITIONS ) {
      if ( !(definition.key in data) ) continue;

      let value = data[definition.key];
      if ( definition.type === Number ) {
        value = Number(value);
        if ( !Number.isFinite(value) ) continue;
        if ( definition.range ) value = Math.clamp(Math.trunc(value), definition.range.min, definition.range.max);
      } else if ( definition.type === Boolean ) {
        value = !!value;
      }

      if ( value === setting(definition.key) ) continue;
      await setSetting(definition.key, value);
    }

    // Cooldowns feed straight into how open sheets render their pending lists.
    for ( const app of Object.values(ui.windows ?? {}) ) app.render?.(false);
    for ( const actor of game.actors ) {
      if ( actor.sheet?.rendered ) actor.sheet.render(false);
    }
  }

  /* -------------------------------------------- */

  /**
   * Put every field back to its shipped default without saving, so the choice can still be
   * abandoned by closing the window.
   * @this {ConfigApp}
   */
  static #onReset() {
    for ( const definition of SETTING_DEFINITIONS ) {
      const field = this.element.querySelector(`[name="${definition.key}"]`);
      if ( !field ) continue;
      if ( definition.type === Boolean ) field.checked = definition.default;
      else field.value = definition.default;
    }
  }
}

/* -------------------------------------------- */

/**
 * Turn a setting definition into something the template can render directly.
 * @param {object} definition
 * @returns {object}
 */
function describe(definition) {
  const key = capitalize(definition.key);
  const value = setting(definition.key);

  const field = {
    key: definition.key,
    name: t(`Settings.${key}.Name`),
    hint: t(`Settings.${key}.Hint`),
    value
  };

  if ( definition.choices ) {
    field.isSelect = true;
    field.choices = Object.entries(definition.choices).map(([option, label]) => ({
      value: option,
      label: game.i18n.localize(label),
      selected: option === value
    }));
  } else if ( definition.type === Boolean ) {
    field.isBoolean = true;
    field.checked = !!value;
  } else if ( definition.type === Number ) {
    field.isNumber = true;
    field.min = definition.range?.min;
    field.max = definition.range?.max;
  } else {
    field.isText = true;
  }

  return field;
}

/**
 * @param {string} key
 * @returns {string}
 */
function capitalize(key) {
  return key.charAt(0).toUpperCase() + key.slice(1);
}
