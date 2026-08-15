import { MODULE_ID, REST_TYPE, SETTINGS, log, t } from "../constants.mjs";
import { setting } from "../settings.mjs";

/**
 * Rest Summary System.
 *
 * When the system produced its own rest card, the module's summary is attached to that message
 * as a flag and rendered into it, so the player sees one card rather than two. If the rest ran
 * through the fallback path and no card exists, a standalone card is posted instead.
 */

/**
 * Attach or post the rest summary.
 * @param {Actor} actor
 * @param {object} report        The rest report from the rest service.
 * @param {object|null} result   The dnd5e rest result, if one was produced.
 * @returns {Promise<void>}
 */
export async function renderSummary(actor, report, result) {
  const summary = {
    restIndex: report.restIndex,
    recovered: report.recovered,
    pending: report.pending,
    healed: report.healed,
    clearedDebt: report.clearedDebt
  };

  try {
    if ( result?.message instanceof ChatMessage ) {
      await result.message.setFlag(MODULE_ID, "summary", summary);
      return;
    }
    await postStandalone(actor, summary);
  } catch(err) {
    log.failure("Could not post the rest summary.", err);
  }
}

/**
 * Post the summary as its own chat card.
 * @param {Actor} actor
 * @param {object} summary
 * @returns {Promise<ChatMessage>}
 */
async function postStandalone(actor, summary) {
  const content = await renderSummaryHTML(summary);
  const data = {
    content: `<div class="gritty-realism gritty-standalone"><h3>${t("Summary.Title")}</h3>${content}</div>`,
    speaker: ChatMessage.getSpeaker({ actor, alias: actor.name }),
    flags: { [MODULE_ID]: { summary } }
  };
  ChatMessage.applyRollMode(data, game.settings.get("core", "rollMode"));
  return ChatMessage.create(data);
}

/**
 * Render the summary fragment.
 * @param {object} summary
 * @returns {Promise<string>}
 */
function renderSummaryHTML(summary) {
  return foundry.applications.handlebars.renderTemplate(
    `modules/${MODULE_ID}/templates/rest-summary.hbs`,
    {
      restIndex: summary.restIndex,
      recovered: summary.recovered.map(line => ({ ...line, showAmount: line.amount > 1 })),
      pending: summary.pending.map(line => ({
        ...line,
        showAmount: line.amount > 1,
        rests: (line.remaining === 1)
          ? t("Rest.OneRestRemaining")
          : t("Rest.RestsRemaining", { count: line.remaining })
      })),
      hasRecovered: summary.recovered.length > 0,
      hasPending: summary.pending.length > 0,
      healed: summary.healed,
      clearedDebt: summary.clearedDebt
    }
  );
}

/**
 * Inject the summary into a rendered rest card.
 *
 * `renderChatMessageHTML` is the v13 hook and hands over a real element, so the fragment is
 * appended rather than the message content being rewritten.
 *
 * @param {ChatMessage} message
 * @param {HTMLElement} element
 */
async function onRenderChatMessage(message, element) {
  const summary = message.getFlag(MODULE_ID, "summary");
  if ( !summary ) return;
  if ( element.querySelector(".gritty-summary") ) return;

  try {
    const html = await renderSummaryHTML(summary);
    const wrapper = document.createElement("div");
    wrapper.classList.add("gritty-realism", "gritty-summary");
    wrapper.innerHTML = html;
    (element.querySelector(".message-content") ?? element).append(wrapper);
  } catch(err) {
    log.failure("Could not render the rest summary into the chat card.", err);
  }
}

/**
 * Rewrite the body of the system's rest card for the module's rest type.
 *
 * `Actor5e#_displayRestResultMessage` picks its wording from `config.type === "long"`, so any
 * other rest type falls through to the short-rest string and the card would claim the character
 * "takes a short rest". The rest of the card — the deltas, the rolls, the flavor — is correct
 * and worth keeping, so only the sentence is replaced.
 *
 * @param {ChatMessage} message
 * @param {object} data
 */
function onPreCreateChatMessage(message, data) {
  if ( message.system?.type !== REST_TYPE ) return;

  const actor = message.getAssociatedActor?.() ?? ChatMessage.getSpeakerActor(data.speaker ?? {});
  const name = actor?.name ?? data.speaker?.alias ?? "";
  const hours = Math.round(setting(SETTINGS.restDuration) / 60);

  message.updateSource({ content: t("Summary.Content", { name, hours }) });
}

/**
 * Attach the chat hooks. Called once during `ready`.
 */
export function registerChat() {
  Hooks.on("preCreateChatMessage", onPreCreateChatMessage);
  Hooks.on("renderChatMessageHTML", onRenderChatMessage);
}
