// Customer service bot: alerts you to new buyer messages, bad feedback and
// orders about to ship late. It never replies for you.
import { trading } from "../ebay.js";
import { brainOn, draftReply } from "./brain.js";
import { BotConfig, Order, Report, short, val } from "./shared.js";

export async function serviceBot(cfg: BotConfig, since: Date, unshipped: Order[], r: Report) {
  // 1) New buyer messages in the inbox since the last run.
  try {
    const m = await trading("GetMyMessages", {
      DetailLevel: "ReturnHeaders",
      FolderID: 0,
      StartTime: since.toISOString(),
      EndTime: new Date().toISOString(),
    });
    const msgs = m.Messages?.Message ? [].concat(m.Messages.Message) : [];
    const fresh = msgs.filter((x: any) => val(x.Read) !== "true");
    let bodies = new Map<string, any>();
    if (brainOn() && fresh.length) {
      try {
        const full = await trading("GetMyMessages", {
          DetailLevel: "ReturnMessages",
          MessageIDs: { MessageID: (fresh as any[]).slice(0, 5).map((x) => val(x.MessageID)).filter(Boolean) },
        });
        const list = full.Messages?.Message ? [].concat(full.Messages.Message) : [];
        bodies = new Map(list.map((x: any) => [String(val(x.MessageID)), x]));
      } catch { /* drafts are a bonus; alerts still go out */ }
    }
    for (const x of fresh.slice(0, 8) as any[]) {
      const from = val(x.Sender) || "buyer";
      const subj = short(val(x.Subject) || "(no subject)", 60);
      let line = `Message from ${from}: ${subj}`;
      const b = bodies.get(String(val(x.MessageID)));
      if (b && from.toLowerCase() !== "ebay") {
        const text = String(val(b.Text) || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;|&amp;|&#\d+;/g, " ").replace(/\s+/g, " ").trim().slice(0, 1200);
        try {
          const draft = await draftReply({ from, subject: subj, body: text, item_title: val(b.ItemTitle) });
          line += `\n   ✍️ Suggested reply: ${draft}`;
        } catch { /* skip draft */ }
      }
      r.urgent.push(line);
    }
    if (fresh.length > 8) r.urgent.push(`…and ${fresh.length - 8} more unread messages.`);
  } catch (e) {
    r.info.push(`Couldn't check messages: ${(e as Error).message.slice(0, 120)}`);
  }

  // 2) Negative / neutral feedback since the last run.
  try {
    const f = await trading("GetFeedback", {
      FeedbackType: "FeedbackReceivedAsSeller",
      DetailLevel: "ReturnAll",
      Pagination: { EntriesPerPage: 25, PageNumber: 1 },
    });
    const list = f.FeedbackDetailArray?.FeedbackDetail ? [].concat(f.FeedbackDetailArray.FeedbackDetail) : [];
    for (const fd of list as any[]) {
      const type = val(fd.CommentType);
      const when = new Date(val(fd.CommentTime) || 0);
      if (when < since || type === "Positive") continue;
      r.urgent.push(`${type} feedback from ${val(fd.CommentingUser)}: "${short(val(fd.CommentText) || "", 70)}"`);
    }
  } catch (e) {
    r.info.push(`Couldn't check feedback: ${(e as Error).message.slice(0, 120)}`);
  }

  // 3) Orders that must ship soon or are already late.
  const now = Date.now();
  const soon = now + cfg.service.ship_warning_hours * 3600_000;
  const late = unshipped.filter((o) => o.ship_by && Date.parse(o.ship_by) < now);
  const due = unshipped.filter((o) => o.ship_by && Date.parse(o.ship_by) >= now && Date.parse(o.ship_by) < soon);
  if (late.length) r.urgent.push(`${late.length} order(s) PAST ship-by date — ship and upload tracking now.`);
  if (due.length) r.urgent.push(`${due.length} order(s) must ship within ${cfg.service.ship_warning_hours}h.`);
}
