import { t } from "../constants.mjs";
import { ownedActors } from "../data/actor-store.mjs";
import { partyRest } from "../domain/rest-service.mjs";

const { DialogV2 } = foundry.applications.api;

/**
 * Party Rest.
 *
 * Rests several actors in one go. Each actor still runs through the normal rest pipeline and
 * keeps its own ledger — this only saves the GM from opening five sheets in a row.
 */

/**
 * Prompt for which actors should rest, then rest them.
 * @param {Actor[]} [candidates]  Defaults to every actor the user owns.
 * @returns {Promise<object[]>}   One report per actor that rested.
 */
export async function promptPartyRest(candidates) {
  const actors = candidates ?? ownedActors();
  if ( !actors.length ) {
    ui.notifications.warn(t("Party.NoSelection"));
    return [];
  }

  const rows = actors.map(actor => `
    <li>
      <label>
        <input type="checkbox" name="actors" value="${actor.id}" checked>
        <img src="${actor.img}" alt="" width="24" height="24">
        <span>${foundry.utils.escapeHTML(actor.name)}</span>
      </label>
    </li>
  `).join("");

  const selected = await DialogV2.wait({
    window: { title: t("Party.Title"), icon: "fa-solid fa-campground" },
    classes: ["gritty-realism"],
    content: `<p class="gritty-hint">${t("Party.Hint")}</p><ul class="gritty-party-list">${rows}</ul>`,
    buttons: [
      {
        action: "rest",
        label: t("Party.Confirm"),
        icon: "fa-solid fa-moon",
        default: true,
        callback: (event, button) => Array.from(
          button.form.querySelectorAll('input[name="actors"]:checked')
        ).map(input => input.value)
      },
      { action: "cancel", label: t("Rest.Cancel"), icon: "fa-solid fa-xmark" }
    ],
    rejectClose: false
  });

  if ( !Array.isArray(selected) || !selected.length ) return [];

  const chosen = selected.map(id => game.actors.get(id)).filter(a => a);
  return partyRest(chosen);
}
