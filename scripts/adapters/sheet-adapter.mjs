import { MODULE_ID, SETTINGS, log, t } from "../constants.mjs";
import { setting } from "../settings.mjs";
import { canRest } from "../data/actor-store.mjs";
import { getRecoveryState, canTakeRest, takeRest } from "../domain/rest-service.mjs";
import RestDialog from "../ui/rest-dialog.mjs";
import LedgerApp from "../ui/ledger-app.mjs";

/**
 * Character sheet integration.
 *
 * The dnd5e sheets are ApplicationV2 subclasses, and ApplicationV2 fires a render hook for
 * every class in the inheritance chain — so hooking `renderBaseActorSheet` covers the
 * character, NPC and every other sheet derived from it in one place.
 *
 * The system's own classes are left untouched. The native rest buttons carry
 * `[data-action="rest"]`, so they are removed from the rendered element and the module's own
 * button is inserted alongside with its own listener, rather than by patching the sheet's
 * `DEFAULT_OPTIONS.actions`.
 */

/**
 * Run the full Take Rest flow for an actor: preview dialog, then the rest itself.
 * @param {Actor} actor
 * @returns {Promise<void>}
 */
export async function promptRest(actor) {
  const check = canTakeRest(actor);
  if ( !check.allowed ) {
    ui.notifications.warn(check.reason);
    return;
  }

  const confirmed = await RestDialog.prompt(actor);
  if ( !confirmed ) return;

  // One id per confirmed dialog, so a retry of the same rest is recognised as a repeat.
  await takeRest(actor, { restId: foundry.utils.randomID() });
}

/* -------------------------------------------- */

/**
 * @param {Application} app
 * @param {HTMLElement} element
 */
function onRenderActorSheet(app, element) {
  const actor = app.actor;
  if ( !canRest(actor) || !actor.isOwner ) return;

  try {
    if ( setting(SETTINGS.hideNativeRests) ) removeNativeRestButtons(element);
    injectRestButton(app, element);
    injectPanel(app, element);
  } catch(err) {
    log.failure(`Could not decorate the sheet for "${actor.name}".`, err);
  }
}

/**
 * Strip the system's Short and Long Rest buttons.
 * @param {HTMLElement} element
 */
function removeNativeRestButtons(element) {
  for ( const button of element.querySelectorAll('[data-action="rest"]') ) button.remove();
}

/**
 * Insert the Take Rest button into the sheet header.
 * @param {Application} app
 * @param {HTMLElement} element
 */
function injectRestButton(app, element) {
  if ( element.querySelector(".gritty-take-rest") ) return;

  // The header keeps its own button row; fall back to the header itself on sheets that lack one.
  const container = element.querySelector(".sheet-header-buttons")
    ?? element.querySelector(".window-content header")
    ?? element.querySelector("header");
  if ( !container ) return;

  const button = document.createElement("button");
  button.type = "button";
  button.classList.add("gritty-take-rest", "gold-button");
  button.dataset.tooltip = t("Rest.Tooltip");
  button.setAttribute("aria-label", t("Rest.Label"));
  button.innerHTML = '<i class="fa-solid fa-moon" inert></i>';
  button.addEventListener("click", event => {
    event.preventDefault();
    promptRest(app.actor);
  });

  container.append(button);
}

/**
 * Render the recovery panel into the sheet.
 * @param {Application} app
 * @param {HTMLElement} element
 */
async function injectPanel(app, element) {
  // The dnd5e sheets render each tab as `<section class="tab ..." data-tab="details">`, so the
  // tab id lives in the attribute — `.tab.details` would only match by accident.
  const anchor = element.querySelector('[data-tab="details"]')
    ?? element.querySelector('[data-tab="biography"]')
    ?? element.querySelector(".sheet-body");
  if ( !anchor ) return;

  // Claim the slot synchronously. Rendering the template is async, and overlapping renders
  // would otherwise each pass the "is it already there?" check and append a second panel.
  if ( element.querySelector(".gritty-panel") ) return;
  const wrapper = document.createElement("section");
  wrapper.classList.add("gritty-realism", "gritty-panel");
  anchor.prepend(wrapper);

  const state = getRecoveryState(app.actor);
  const html = await foundry.applications.handlebars.renderTemplate(
    `modules/${MODULE_ID}/templates/rest-panel.hbs`,
    {
      restIndex: state.restIndex,
      ready: state.ready.map(line => ({ ...line, showAmount: line.amount > 1 })),
      recovering: state.recovering.map(line => ({
        ...line,
        showAmount: line.amount > 1,
        rests: (line.remaining === 1)
          ? t("Rest.OneRestRemaining")
          : t("Rest.RestsRemaining", { count: line.remaining })
      })),
      debt: state.debt,
      debtTotal: state.debtTotal,
      hasReady: state.ready.length > 0,
      hasRecovering: state.recovering.length > 0,
      isEmpty: !state.ready.length && !state.recovering.length && !state.debtTotal,
      isGM: game.user.isGM
    }
  );

  wrapper.innerHTML = html;

  wrapper.querySelector('[data-action="openLedger"]')?.addEventListener("click", event => {
    event.preventDefault();
    new LedgerApp(app.actor).render({ force: true });
  });
}

/* -------------------------------------------- */

/**
 * Re-render open sheets when a ledger changes, so the panel never shows stale cooldowns.
 * @param {Actor} actor
 * @param {object} changed
 */
function onUpdateActor(actor, changed) {
  if ( !foundry.utils.hasProperty(changed, `flags.${MODULE_ID}`) ) return;
  if ( actor.sheet?.rendered ) actor.sheet.render(false);
}

/**
 * Attach the sheet hooks. Called once during `ready`.
 */
export function registerSheetAdapter() {
  Hooks.on("renderBaseActorSheet", onRenderActorSheet);
  Hooks.on("updateActor", onUpdateActor);
  log.debug("Sheet adapter attached.");
}
