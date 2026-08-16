import { MODULE_ID, SETTINGS, SHEET_PLACEMENTS, log, t } from "../constants.mjs";
import { setting } from "../settings.mjs";
import { canRest } from "../data/actor-store.mjs";
import { getRecoveryState, canTakeRest, takeRest, mutate } from "../domain/rest-service.mjs";
import RestDialog from "../ui/rest-dialog.mjs";
import LedgerApp from "../ui/ledger-app.mjs";
import { promptNewEntry, promptItemCooldown } from "../ui/entry-dialog.mjs";

/**
 * Character sheet integration.
 *
 * The dnd5e sheets are ApplicationV2 subclasses, and ApplicationV2 fires a render hook for
 * every class in the inheritance chain — so hooking `renderBaseActorSheet` covers the
 * character, NPC and every other sheet derived from it in one place.
 *
 * Nothing in the system is patched. The recovery display is injected into the rendered DOM,
 * either as its own tab or as a panel on the details tab, and the native rest buttons are
 * removed from the header rather than by overriding the sheet's `DEFAULT_OPTIONS.actions`.
 */

/** Identifier of the injected tab, in the sheet's `primary` tab group. */
const TAB_ID = "gritty";

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

  const { confirmed, quality } = await RestDialog.prompt(actor);
  if ( !confirmed ) return;

  // One id per confirmed dialog, so a retry of the same rest is recognised as a repeat.
  await takeRest(actor, { restId: foundry.utils.randomID(), quality });
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
    removeNativeRestButtons(element);
    injectRestButton(app, element);

    const placement = setting(SETTINGS.sheetPlacement);
    if ( placement === SHEET_PLACEMENTS.tab ) injectTab(app, element);
    else if ( placement === SHEET_PLACEMENTS.panel ) injectPanel(app, element);
  } catch(err) {
    log.failure(`Could not decorate the sheet for "${actor.name}".`, err);
  }
}

/**
 * Strip whichever native rest buttons the world has chosen to hide. The two are independent,
 * so a table can keep short rests as an in-fiction breather while long rests go through the
 * module.
 * @param {HTMLElement} element
 */
function removeNativeRestButtons(element) {
  if ( setting(SETTINGS.hideShortRest) ) {
    element.querySelector('[data-action="rest"][data-type="short"]')?.remove();
  }
  if ( setting(SETTINGS.hideLongRest) ) {
    element.querySelector('[data-action="rest"][data-type="long"]')?.remove();
  }
}

/**
 * Insert the Take Rest button into the sheet header.
 * @param {Application} app
 * @param {HTMLElement} element
 */
function injectRestButton(app, element) {
  if ( element.querySelector(".gritty-take-rest") ) return;

  // The header keeps its own button row; fall back to the header itself on sheets without one.
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

/* -------------------------------------------- */
/*  Tab placement                               */
/* -------------------------------------------- */

/**
 * Add the recovery display as its own sheet tab.
 *
 * The dnd5e sheets render their tab strip from a static `TABS` array, which is class-level data
 * belonging to the system — mutating it would reach into another package and would also require
 * adding a template part. Instead the nav entry and body section are appended to the rendered
 * DOM next to the system's own. ApplicationV2 dispatches `[data-action="tab"]` clicks by
 * delegation from the application root, so the injected entry is picked up by the framework's
 * own tab handling without any extra listener.
 *
 * @param {Application} app
 * @param {HTMLElement} element
 */
async function injectTab(app, element) {
  const nav = element.querySelector('nav.tabs[data-group="primary"]');
  const sibling = element.querySelector('[data-tab="details"][data-group="primary"]')
    ?? element.querySelector('section.tab[data-group="primary"]');
  if ( !nav || !sibling?.parentElement ) return;

  const isActive = app.tabGroups?.primary === TAB_ID;

  // Nav entry.
  if ( !nav.querySelector(`[data-tab="${TAB_ID}"]`) ) {
    const item = document.createElement("a");
    item.className = `item control gritty-tab-item${isActive ? " active" : ""}`;
    item.dataset.action = "tab";
    item.dataset.group = "primary";
    item.dataset.tab = TAB_ID;
    item.dataset.tooltip = "";
    item.setAttribute("aria-label", t("Panel.Title"));
    item.innerHTML = '<i class="fa-solid fa-moon" inert></i>';
    nav.append(item);
  }

  // Body section. It lives outside every ApplicationV2 part, so a re-render leaves it standing
  // rather than replacing it — which means its contents have to be refreshed explicitly on each
  // render, or the ledger would only ever update when the sheet was closed and reopened.
  let section = element.querySelector(`section.tab[data-tab="${TAB_ID}"]`);
  if ( !section ) {
    section = document.createElement("section");
    section.className = "tab gritty-realism gritty-tab";
    section.dataset.tab = TAB_ID;
    section.dataset.group = "primary";
    sibling.parentElement.append(section);
  }
  section.classList.toggle("active", isActive);

  await refreshDisplay(app, section);
}

/* -------------------------------------------- */
/*  Panel placement                             */
/* -------------------------------------------- */

/**
 * Render the recovery display inline at the top of the details tab.
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

  // As with the tab, the panel outlives a re-render, so refresh it in place instead of
  // bailing out when it already exists.
  let wrapper = element.querySelector(".gritty-panel");
  if ( !wrapper ) {
    wrapper = document.createElement("section");
    wrapper.classList.add("gritty-realism", "gritty-panel");
    anchor.prepend(wrapper);
  }

  await refreshDisplay(app, wrapper);
}

/* -------------------------------------------- */
/*  Shared rendering                            */
/* -------------------------------------------- */

/** Monotonic counter used to discard the results of superseded renders. */
let renderToken = 0;

/**
 * Render the recovery display into a container, replacing whatever was there.
 *
 * Template rendering is asynchronous, so two renders firing in quick succession — a rest
 * completing while the sheet is already refreshing, say — could otherwise resolve out of order
 * and leave the older markup on screen. Each call claims a token and drops its result if a
 * newer one has started in the meantime.
 *
 * @param {Application} app
 * @param {HTMLElement} container
 * @returns {Promise<void>}
 */
async function refreshDisplay(app, container) {
  const token = ++renderToken;
  const html = await renderDisplay(app.actor);
  if ( token !== renderToken ) return;
  if ( !container.isConnected ) return;

  container.innerHTML = html;
  attachDisplayListeners(app, container);
}

/**
 * Render the recovery display for an actor.
 * @param {Actor} actor
 * @returns {Promise<string>}
 */
function renderDisplay(actor) {
  const state = getRecoveryState(actor);
  const mayAdjust = game.user.isGM;

  return foundry.applications.handlebars.renderTemplate(
    `modules/${MODULE_ID}/templates/rest-panel.hbs`,
    {
      restIndex: state.restIndex,
      period: state.period,
      periodModel: !!state.period,
      // Precomputed rather than built with template helpers: Foundry only ships a small set of
      // Handlebars helpers, and neither a range nor a numeric comparison is among them.
      periodPips: state.period
        ? Array.from({ length: state.period.length }, (unused, i) => ({
          spent: i < (state.period.length - state.period.remaining)
        }))
        : [],
      ready: state.ready.map(line => ({
        ...line,
        showAmount: line.amount > 1,
        groupLabel: t(`Group.${line.group}`)
      })),
      recovering: state.recovering.map(line => ({
        ...line,
        showAmount: line.amount > 1,
        groupLabel: t(`Group.${line.group}`),
        // `automatic` means the entry is running a clock of its own — under either model. What
        // it means when it is false differs: under the period model the entry is waiting on the
        // period, whereas on the ledger it is a standing debt nothing will clear but a hand.
        waitsForPeriod: !!state.period && !line.automatic,
        rests: line.automatic
          ? ((line.remaining === 1) ? t("Rest.OneRestRemaining")
            : t("Rest.RestsRemaining", { count: line.remaining }))
          : (state.period ? t("Period.Waiting") : String(line.remaining))
      })),
      debt: state.debt,
      debtTotal: state.debtTotal,
      hasReady: state.ready.length > 0,
      hasRecovering: state.recovering.length > 0,
      isEmpty: !state.ready.length && !state.recovering.length && !state.debtTotal,
      mayAdjust,
      isGM: game.user.isGM
    }
  );
}

/**
 * Wire the controls inside a rendered display.
 * @param {Application} app
 * @param {HTMLElement} root
 */
function attachDisplayListeners(app, root) {
  const actor = app.actor;

  root.querySelector('[data-gritty-action="openLedger"]')?.addEventListener("click", event => {
    event.preventDefault();
    new LedgerApp(actor).render({ force: true });
  });

  root.querySelector('[data-gritty-action="takeRest"]')?.addEventListener("click", event => {
    event.preventDefault();
    promptRest(actor);
  });

  root.querySelector('[data-gritty-action="addEntry"]')?.addEventListener("click", async event => {
    event.preventDefault();
    await promptNewEntry(actor);
  });

  for ( const button of root.querySelectorAll("[data-gritty-adjust]") ) {
    button.addEventListener("click", async event => {
      event.preventDefault();
      const row = button.closest("[data-entry-ids]");
      const entryIds = row?.dataset.entryIds?.split(",").filter(Boolean) ?? [];
      if ( !entryIds.length ) return;

      const adjust = button.dataset.grittyAdjust;
      try {
        if ( adjust === "recover" ) await mutate(actor, "recoverNow", { entryIds });
        else if ( adjust === "delete" ) {
          for ( const entryId of entryIds ) await mutate(actor, "removeEntry", { entryId });
        }
        else await mutate(actor, "shiftEntries", { entryIds, delta: adjust === "later" ? 1 : -1 });
      } catch(err) {
        log.failure(`Could not adjust the recovery for "${actor.name}".`, err);
      }
    });
  }
}

/* -------------------------------------------- */

/**
 * Re-render open sheets when a ledger changes, so the display never shows stale cooldowns.
 * @param {Actor} actor
 * @param {object} changed
 */
function onUpdateActor(actor, changed) {
  if ( !foundry.utils.hasProperty(changed, `flags.${MODULE_ID}`) ) return;
  if ( actor.sheet?.rendered ) actor.sheet.render({ force: false });
}

/**
 * Add "Put on cooldown" to an item's right-click menu.
 *
 * `dnd5e.getItemContextOptions` hands over the live `ui.context.menuItems` array, so appending
 * an entry with the same `{name, icon, condition, callback}` shape the system uses is all that
 * is required — no sheet class is subclassed and no menu is rebuilt.
 *
 * @param {Item} item
 * @param {object[]} options  Menu entries, mutated in place.
 */
function onGetItemContextOptions(item, options) {
  if ( !setting(SETTINGS.contextMenu) ) return;
  const actor = item?.actor;
  if ( !actor || !canRest(actor) || !actor.isOwner ) return;

  options.push({
    name: "GRITTY.Entry.ContextLabel",
    icon: '<i class="fa-solid fa-hourglass-half fa-fw"></i>',
    condition: () => actor.isOwner,
    callback: () => promptItemCooldown(item)
  });
}

/**
 * Attach the sheet hooks. Called once during `ready`.
 */
export function registerSheetAdapter() {
  Hooks.on("renderBaseActorSheet", onRenderActorSheet);
  Hooks.on("updateActor", onUpdateActor);
  Hooks.on("dnd5e.getItemContextOptions", onGetItemContextOptions);
  log.debug("Sheet adapter attached.");
}
