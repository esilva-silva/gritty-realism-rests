import { MODULE_ID, groupOfPeriod, t } from "../constants.mjs";
import { readState } from "../data/actor-store.mjs";
import { mutate, advanceRests } from "../domain/rest-service.mjs";
import { totalDebt } from "../domain/hp-debt.mjs";
import { promptNewEntry } from "./entry-dialog.mjs";

const { ApplicationV2, HandlebarsApplicationMixin, DialogV2 } = foundry.applications.api;

/**
 * The GM's Recovery Ledger.
 *
 * Every correction the GM can make — deleting a stale entry, handing a resource back early,
 * moving the rest index, adjusting hit point debt, advancing several rests at once — is routed
 * through the rest service so it lands inside the same per-actor queue as everything else.
 */
export default class LedgerApp extends HandlebarsApplicationMixin(ApplicationV2) {

  /** @override */
  static DEFAULT_OPTIONS = {
    classes: ["gritty-realism", "gritty-ledger"],
    tag: "div",
    window: { icon: "fa-solid fa-scroll", resizable: true },
    position: { width: 640, height: 620 },
    actions: {
      removeEntry: LedgerApp.#onRemoveEntry,
      recoverNow: LedgerApp.#onRecoverNow,
      removeDebt: LedgerApp.#onRemoveDebt,
      advance: LedgerApp.#onAdvance,
      setRestIndex: LedgerApp.#onSetRestIndex,
      setDebt: LedgerApp.#onSetDebt,
      reset: LedgerApp.#onReset,
      addEntry: LedgerApp.#onAddEntry
    }
  };

  /** @override */
  static PARTS = {
    body: { template: `modules/${MODULE_ID}/templates/ledger.hbs`, scrollable: [".gritty-ledger-scroll"] }
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

  /** @type {Actor} */
  actor;

  /** @override */
  get title() {
    return t("Ledger.Title", { name: this.actor.name });
  }

  /* -------------------------------------------- */

  /** @override */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const state = readState(this.actor);

    return Object.assign(context, {
      actor: this.actor,
      restIndex: state.restIndex,
      entries: state.entries
        .slice()
        .sort((a, b) => a.recoverAtRestIndex - b.recoverAtRestIndex)
        .map(entry => ({
          id: entry.id,
          label: entry.label,
          description: entry.description,
          img: entry.img,
          amount: entry.amount,
          spentAtRestIndex: entry.spentAtRestIndex,
          recoverAtRestIndex: entry.recoverAtRestIndex,
          group: groupOfPeriod(entry.policy.period),
          groupLabel: t(`Group.${groupOfPeriod(entry.policy.period)}`),
          origin: t(`Origin.${entry.origin}`),
          matured: entry.recoverAtRestIndex <= state.restIndex
        })),
      hasEntries: state.entries.length > 0,
      debt: state.debt.map(entry => ({
        id: entry.id,
        remaining: entry.remaining,
        rests: Math.max(0, entry.recoverAtRestIndex - state.restIndex)
      })),
      debtTotal: totalDebt(state)
    });
  }

  /* -------------------------------------------- */

  /**
   * Apply a mutation and refresh.
   * @param {string} kind
   * @param {object} payload
   */
  async #apply(kind, payload) {
    await mutate(this.actor, kind, payload);
    this.render();
  }

  /* -------------------------------------------- */
  /*  Actions                                     */
  /* -------------------------------------------- */

  /**
   * @this {LedgerApp}
   * @param {Event} event
   * @param {HTMLElement} target
   */
  static async #onRemoveEntry(event, target) {
    await this.#apply("removeEntry", { entryId: target.closest("[data-entry-id]").dataset.entryId });
  }

  /**
   * @this {LedgerApp}
   * @param {Event} event
   * @param {HTMLElement} target
   */
  static async #onRecoverNow(event, target) {
    await this.#apply("recoverNow", { entryId: target.closest("[data-entry-id]").dataset.entryId });
  }

  /**
   * @this {LedgerApp}
   * @param {Event} event
   * @param {HTMLElement} target
   */
  static async #onRemoveDebt(event, target) {
    await this.#apply("removeDebt", { debtId: target.closest("[data-debt-id]").dataset.debtId });
  }

  /**
   * @this {LedgerApp}
   */
  static async #onAdvance() {
    const input = this.element.querySelector('[name="advanceCount"]');
    const count = Math.max(1, Math.trunc(Number(input?.value) || 1));
    await advanceRests(this.actor, count);
    this.render();
  }

  /**
   * @this {LedgerApp}
   */
  static async #onSetRestIndex() {
    const input = this.element.querySelector('[name="restIndex"]');
    const restIndex = Math.max(0, Math.trunc(Number(input?.value) || 0));
    await this.#apply("setRestIndex", { restIndex });
  }

  /**
   * @this {LedgerApp}
   */
  static async #onSetDebt() {
    const input = this.element.querySelector('[name="debtTotal"]');
    const amount = Math.max(0, Math.trunc(Number(input?.value) || 0));
    await this.#apply("setDebt", { amount });
  }

  /**
   * @this {LedgerApp}
   */
  static async #onAddEntry() {
    if ( await promptNewEntry(this.actor) ) this.render();
  }

  /**
   * @this {LedgerApp}
   */
  static async #onReset() {
    const confirmed = await DialogV2.confirm({
      window: { title: t("Ledger.Reset") },
      content: `<p>${t("Ledger.ResetConfirm", { name: this.actor.name })}</p>`,
      modal: true
    });
    if ( !confirmed ) return;
    await this.#apply("reset", {});
  }
}
