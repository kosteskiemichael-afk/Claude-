// Feedback fixer: when a buyer leaves negative or neutral feedback, it
//  1) posts a calm, professional public reply under the feedback (what future buyers read), and
//  2) messages the buyer privately offering a free replacement, so the problem gets solved.
// It never asks the buyer to change or remove feedback (eBay forbids pressuring buyers), never
// argues, never promises a refund. Feedback that already has a reply is skipped.
import { trading } from "../ebay.js";
import { askJson, brainOn, FAST_MODEL } from "./brain.js";
import { BotConfig, Report, short, val } from "./shared.js";

type Cfg = { enabled: boolean; reply_publicly: boolean; message_buyer: boolean; lookback_days: number };
const DEF: Cfg = { enabled: true, reply_publicly: true, message_buyer: true, lookback_days: 3 };
const done = new Set<string>(); // feedback handled while this server stays awake

const FALLBACK = {
  reply: "Thank you for the feedback. We've improved our process on this part and have messaged you to send a free replacement.",
  subject: "Making this right - free replacement",
  message: "Hi, we're sorry this part didn't meet your expectations. We've since improved our printing and quality checks on this item and would like to send you a free replacement. Just reply with anything you noticed (fit, finish, model number) and we'll get one out to you. - Nexa Manufacturing Co",
};

async function draft(fd: { text: string; title: string; type: string }) {
  if (!brainOn()) return FALLBACK;
  try {
    const o = await askJson<{ reply: string; subject: string; message: string }>(FAST_MODEL,
      "You handle negative/neutral eBay feedback for Nexa Manufacturing Co, a small shop selling 3D-printed replacement parts. " +
      "Write (1) a PUBLIC reply under the feedback, max 300 characters: calm, professional, thank them, say specifically what was " +
      "improved or clarified for this kind of complaint, mention we've reached out to make it right. Never argue, never blame the " +
      "buyer, never claim the part is OEM/genuine, never mention refunds. (2) a PRIVATE message to the buyer (subject max 60 chars, " +
      "body max 600 chars): apologize briefly, offer a free replacement, ask one useful question (model number / what didn't fit). " +
      "NEVER ask them to change, revise or remove their feedback and never offer anything in exchange for feedback. Sign the " +
      "message 'Nexa Manufacturing Co'. Return {\"reply\":\"...\",\"subject\":\"...\",\"message\":\"...\"}.",
      JSON.stringify(fd), 700);
    const bad = /feedback.*(revis|remov|change|update)|(revis|remov|change|update).*feedback|refund|\boem\b|genuine/i;
    const reply = String(o.reply || "").trim().slice(0, 300);
    const message = String(o.message || "").trim().slice(0, 1000);
    if (!reply || !message || bad.test(reply) || /feedback.*(revis|remov|change)|(revis|remov|change).*feedback/i.test(message)) return FALLBACK;
    return { reply, subject: String(o.subject || FALLBACK.subject).slice(0, 60), message };
  } catch { return FALLBACK; }
}

export async function feedbackBot(cfg: BotConfig, r: Report) {
  const c: Cfg = { ...DEF, ...((cfg as any).feedback || {}) };
  if (!c.enabled) return;
  const f = await trading("GetFeedback", {
    FeedbackType: "FeedbackReceivedAsSeller", DetailLevel: "ReturnAll",
    Pagination: { EntriesPerPage: 50, PageNumber: 1 },
  });
  const list: any[] = f.FeedbackDetailArray?.FeedbackDetail ? [].concat(f.FeedbackDetailArray.FeedbackDetail) : [];
  const cutoff = Date.now() - c.lookback_days * 86400_000;
  let handled = 0;
  for (const fd of list) {
    const type = String(val(fd.CommentType) || "");
    const id = String(val(fd.FeedbackID) || "");
    if (type === "Positive" || !id || done.has(id)) continue;
    if (Date.parse(String(val(fd.CommentTime) || 0)) < cutoff) continue;
    if (val(fd.FeedbackResponse)) { done.add(id); continue; } // already replied
    const buyer = String(val(fd.CommentingUser) || "");
    const itemId = String(val(fd.ItemID) || "");
    const title = String(val(fd.ItemTitle) || "");
    const text = String(val(fd.CommentText) || "");
    const d = await draft({ text, title, type });
    const did: string[] = [];
    if (c.reply_publicly) {
      try {
        if (!cfg.dry_run) await trading("RespondToFeedback", {
          FeedbackID: id, ItemID: itemId, TransactionID: val(fd.TransactionID) || undefined,
          TargetUserID: buyer, ResponseType: "Reply", ResponseText: d.reply,
        });
        did.push("public reply posted");
      } catch (e) { r.info.push(`Feedback reply failed (${buyer}): ${(e as Error).message.slice(0, 120)}`); }
    }
    if (c.message_buyer && buyer && itemId) {
      try {
        if (!cfg.dry_run) await trading("AddMemberMessageAAQToPartner", {
          ItemID: itemId,
          MemberMessage: { Subject: d.subject, Body: d.message, QuestionType: "General", RecipientID: buyer },
        });
        did.push("buyer messaged with replacement offer");
      } catch (e) { r.info.push(`Couldn't message ${buyer}: ${(e as Error).message.slice(0, 120)}`); }
    }
    done.add(id);
    handled++;
    r.urgent.push(`${type} feedback from ${buyer} on ${short(title, 40)}: "${short(text, 90)}"\n   ✅ ${did.join(", ") || "nothing sent"}. Reply: "${d.reply}"\n   Watch your eBay messages for their answer and send the replacement.`);
  }
  if (!handled) r.info.push("Feedback fixer: no new negative/neutral feedback.");
}
