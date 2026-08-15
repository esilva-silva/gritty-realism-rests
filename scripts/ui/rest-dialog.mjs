import { MODULE_ID, t } from "../constants.mjs";
import { previewRest } from "../domain/rest-service.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * The Take Rest dialog.
 *
 * Shows the preview described by the rest service — what matures with this rest and what only
 * moves a step closer — and lets the player spend hit dice before committing. Hit dice are
 * rolled through `Actor5e#rollHitDie`, so the system's own roll, chat card and resource
 * bookkeeping all happen normally; the resulting `hd.spent` change is picked up by the
 * consumption watcher like any other expenditure.
 */
export default class RestDialog extends HandlebarsApplicationMixin(ApplicationV2) {

  /** @override */
  static DEFAULT_OPTIONS = {
    classes: ["gritty-realism", "gritty-rest-dialog"],
    tag: "div",
    window: {
      icon: "fa-solid fa-moon",
      resizable: false
    },
    position: { width: 460, height: "auto" },
    actions: {
      confirm: RestDialog.#onConfirm,
      cancel: RestDialog.#onCancel,
      rollHitDie: RestDialog.#onRollHitDie
    }
  };

  /** @override */
  static PARTS = {
    body: { template: `modules/${MODULE_ID}/templates/rest-dialog.hbs` }
  };

  /* -------------------------------------------- */

  /**
   * @param {Actor} actor
   * @param {object} [options]
   */
  constructor(actor, options = {}) {
    super(options);
    this.actor = actor;
  }

  /** The actor about to rest. @type {Actor} */
  actor;

  /** Resolver for the promise handed back by {@link RestDialog.prompt}. @type {Function|null} */
  #resolve = null;

  /** Whether the dialog closed through the confirm button. @type {boolean} */
  #confirmed = false;

  /* -------------------------------------------- */

  /** @override */
  get title() {
    return t("Rest.DialogTitle", { name: this.actor.name });
  }

  /* -------------------------------------------- */

  /**
   * Show the dialog and resolve once the user decides.
   * @param {Actor} actor
   * @returns {Promise<boolean>}  Whether the rest was confirmed.
   */
  static prompt(actor) {
    return new Promise(resolve => {
      const app = new this(actor);
      app.#resolve = resolve;
      app.render({ force: true });
    });
  }

  /* -------------------------------------------- */

  /** @override */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const preview = previewRest(this.actor);
    const hd = this.actor.system?.attributes?.hd;

    return Object.assign(context, {
      actor: this.actor,
      preview,
      hasRecovering: preview.recovering.length > 0,
      hasProgressing: preview.progressing.length > 0,
      recovering: preview.recovering.map(line => ({ ...line, showAmount: line.amount > 1 })),
      progressing: preview.progressing.map(line => ({
        ...line,
        showAmount: line.amount > 1,
        from: line.remaining + 1,
        to: line.remaining
      })),
      hitDice: hd ? {
        value: hd.value,
        max: hd.max,
        available: Object.entries(hd.bySize ?? {})
          .filter(([, count]) => count > 0)
          .map(([denomination, count]) => ({ denomination, count }))
      } : null
    });
  }

  /* -------------------------------------------- */

  /** @override */
  _onClose(options) {
    super._onClose(options);
    this.#resolve?.(this.#confirmed);
    this.#resolve = null;
  }

  /* -------------------------------------------- */
  /*  Actions                                     */
  /* -------------------------------------------- */

  /**
   * @this {RestDialog}
   */
  static #onConfirm() {
    this.#confirmed = true;
    this.close();
  }

  /**
   * @this {RestDialog}
   */
  static #onCancel() {
    this.close();
  }

  /**
   * Spend a hit die and re-render so the remaining count and preview stay accurate.
   * @this {RestDialog}
   * @param {Event} event
   * @param {HTMLElement} target
   */
  static async #onRollHitDie(event, target) {
    const denomination = target.dataset.denomination;
    await this.actor.rollHitDie({ denomination });
    this.render();
  }
}
