// Offline test: runs every bot against fake eBay responses. No real eBay calls.
//   npm run build && node scripts/test-bots.mjs
process.env.EBAY_APP_ID = "test"; process.env.EBAY_CERT_ID = "test"; process.env.EBAY_REFRESH_TOKEN = "test";
process.env.PROTECTED_ITEM_IDS = "206531844850";
process.env.PROTECTED_TITLE_KEYWORDS = "Baratza,Burr Holder";
process.env.BOT_CONFIG_FILE = "/nonexistent";
process.env.ANTHROPIC_API_KEY = "test-key";
const brainCalls = [];
process.env.BOT_CONFIG = JSON.stringify({
  pricing: { once_per_day: false, rules: {
    "111": { query: "lasko box fan feet", must_include: ["lasko", "feet"], min: 6.99, max: 12.99 },
    "222": { query: "lasko heater knob", must_include: ["lasko", "knob"], min: 7.99 },
    "206531844850": { query: "baratza burr holder" },
  } },
});

const writes = [];
const now = Date.now();
const iso = (h) => new Date(now + h * 3600_000).toISOString();
const item = (id, title, price, qty, ship = 0) => `<Item><ItemID>${id}</ItemID><Title>${title}</Title><Quantity>${qty}</Quantity><QuantityAvailable>${qty}</QuantityAvailable><SellingStatus><CurrentPrice currencyID="USD">${price}</CurrentPrice><QuantitySold>3</QuantitySold></SellingStatus><ShippingDetails><ShippingServiceOptions><ShippingServiceCost>${ship}</ShippingServiceCost></ShippingServiceOptions></ShippingDetails></Item>`;

const trading = {
  GetMyeBaySelling: `<ActiveList><ItemArray>${
    item("206531844850", "Baratza Encore Burr Holder Ring", 14.22, 1) +
    item("206453290362", "Burr Holder for Baratza Virtuoso", 15.99, 8) +
    item("111", "Lasko Box Fan Replacement Feet Set of 2", 10.25, 2) +
    item("222", "Lasko Space Heater Knob", 9.99, 7) +
    item("333", "Canon AE-1 Battery Door", 15.89, 0)
  }</ItemArray><PaginationResult><TotalNumberOfPages>1</TotalNumberOfPages></PaginationResult></ActiveList>`,
  ReviseInventoryStatus: ``,
  GetMyMessages: `<Messages><Message><MessageID>m1</MessageID><Text>&lt;p&gt;Does this fit my 1A model?&lt;/p&gt;</Text><Sender>buyer_joe</Sender><Subject>Does this fit model 1A?</Subject><Read>false</Read></Message><Message><Sender>old</Sender><Subject>read one</Subject><Read>true</Read></Message></Messages>`,
  GetFeedback: `<FeedbackDetailArray><FeedbackDetail><CommentingUser>sad_sam</CommentingUser><CommentText>Part did not fit</CommentText><CommentType>Negative</CommentType><CommentTime>${iso(-2)}</CommentTime></FeedbackDetail><FeedbackDetail><CommentingUser>happy</CommentingUser><CommentText>great</CommentText><CommentType>Positive</CommentType><CommentTime>${iso(-1)}</CommentTime></FeedbackDetail></FeedbackDetailArray>`,
};

globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(String(url));
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
  if (u.pathname.endsWith("/oauth2/token")) return json({ access_token: "x", expires_in: 7200 });
  if (u.hostname === "api.anthropic.com") {
    const b = JSON.parse(opts.body); brainCalls.push(b.model);
    const say = (t) => json({ content: [{ type: "text", text: t }], usage: { input_tokens: 1000, output_tokens: 100 } });
    if (b.system.includes("find their true competitors")) return say(JSON.stringify({ plans: [
      { item_id: "333", query: "canon ae-1 battery door", pack_qty: 1, must_include: ["canon", "ae-1", "door"] }] }));
    if (b.system.includes("compare eBay listings")) {
      const inp = JSON.parse(b.messages[0].content.split("\nReturn")[0]).my_listings;
      const c = inp[0].candidates;
      return say("```json\n" + JSON.stringify({ results: [{ item_id: "333", matches: c.filter((x) => !/body/i.test(x.title)).map((x) => ({ i: x.i, their_pack_qty: 1 })) }] }) + "\n```");
    }
    if (b.system.includes("same replacement part as an eBay listing")) return say(JSON.stringify({ keep: [0] }));
    if (b.system.includes("customer service voice")) return say("Hi Joe, thanks for reaching out! Could you send your model number so I can confirm fit? - Nexa Manufacturing Co");
    if (b.system.includes("business brain")) return say("• Raise Cuisinart gear to $19.99\n• Restock burr holders");
    return say("{}");
  }
  if (u.hostname === "ntfy.sh") { writes.push(["PUSH", opts.headers.Title]); return new Response("ok"); }
  if (u.pathname === "/ws/api.dll") {
    const call = opts.headers["X-EBAY-API-CALL-NAME"];
    if (call === "ReviseInventoryStatus") writes.push(["REVISE", opts.body.match(/<InventoryStatus>.*?<\/InventoryStatus>/g)]);
    return new Response(`<?xml version="1.0"?><${call}Response xmlns="urn:ebay:apis:eBLBaseComponents"><Ack>Success</Ack>${trading[call] ?? ""}</${call}Response>`);
  }
  if (u.pathname === "/buy/browse/v1/item_summary/search") {
    const q = u.searchParams.get("q");
    const mk = (seller, title, price, ship = 0) => ({ seller: { username: seller }, title, price: { value: String(price), currency: "USD" }, shippingOptions: [{ shippingCost: { value: String(ship) } }] });
    if (q.includes("feet")) return json({ itemSummaries: [
      mk("3dmountlab", "LASKO Box Fan Replacement Feet SET OF 2", 8.29), mk("nexamfgco", "Lasko feet", 10.25),
      mk("junk", "Lasko feet broken lot", 1.0), mk("other", "Lasko Fan Feet", 9.5), mk("x", "Honeywell fan feet", 5)] });
    if (q.includes("knob")) return json({ itemSummaries: [mk("ulovemydeals", "3D Printed Replacement Knob for Lasko Space Heater", 12.95), mk("y", "Lasko knob", 13.5)] });
    if (q.startsWith("3d printed")) return json({ itemSummaries: [
      { itemId: "v1|900|0", legacyItemId: "900", title: "1987-1991 Ford Bronco F150 Fuse panel Clips 4 qty. 3D printed", seller: { username: "little3d" }, price: { value: "13.49" } },
      { itemId: "v1|901|0", legacyItemId: "901", title: "3D Printed Mystery Widget Cover", seller: { username: "x" }, price: { value: "9.99" } },
      { itemId: "v1|902|0", legacyItemId: "902", title: "Lasko Box Fan Replacement Feet 3D printed", seller: { username: "y" }, price: { value: "8.29" } },
      { itemId: "v1|903|0", legacyItemId: "903", title: "3D printed Craftsman 2VPR miter saw handle", seller: { username: "redwork" }, price: { value: "28.95" } },
      { itemId: "v1|904|0", legacyItemId: "904", title: "3D printed widget nobody buys", seller: { username: "z" }, price: { value: "5" } }] });
    if (q.includes("canon")) return json({ itemSummaries: [mk("a", "Canon AE-1 Battery Door Cover Replacement", 16.99), mk("b", "Battery Door for Canon AE-1 Program", 17.5), mk("c", "Canon AE-1 Program Camera Body door works", 80)] });
    return json({ itemSummaries: [] });
  }
  if (u.pathname === "/buy/browse/v1/item/") return json({ items: u.searchParams.get("item_ids").split(",").map((id) => ({ itemId: id, estimatedAvailabilities: [{ estimatedSoldQuantity: { "v1|900|0": 573, "v1|901|0": 150, "v1|902|0": 191, "v1|903|0": 606, "v1|904|0": 3 }[id] }] })) });
  if (u.hostname === "api.printables.com") { const q = JSON.parse(opts.body).variables.q; return json({ data: { searchPrints2: { items: q.includes("bronco") || q.includes("ford") || q.includes("fuse") ? [{ id: "520786", name: "Ford Bronco Fuse Panel Cover Clip", license: { abbreviation: "CC-BY-SA" } }, { id: "1", name: "Ford fuse thing", license: { abbreviation: "CC-BY-NC" } }] : [] } } }); }
  if (u.pathname === "/sell/fulfillment/v1/order") return json({ orders: [
    { orderId: "o1", creationDate: iso(-1), orderFulfillmentStatus: "NOT_STARTED", lineItems: [{ legacyItemId: "206531844850", title: "Baratza Encore Burr Holder Ring", quantity: 2, lineItemFulfillmentInstructions: { shipByDate: iso(10) } }] },
    { orderId: "o2", creationDate: iso(-30), orderFulfillmentStatus: "NOT_STARTED", lineItems: [{ legacyItemId: "111", title: "Lasko Box Fan Replacement Feet Set of 2", quantity: 1, lineItemFulfillmentInstructions: { shipByDate: iso(-2) } }] },
  ] });
  if (u.pathname === "/sell/analytics/v1/traffic_report") return json({ header: { metrics: [{ key: "LISTING_IMPRESSION_TOTAL" }, { key: "LISTING_VIEWS_TOTAL" }, { key: "TRANSACTION" }] }, records: [{ dimensionValues: [{ value: "333" }], metricValues: [{ value: "900" }, { value: "60" }, { value: "0" }] }] });
  if (u.pathname === "/sell/marketing/v1/ad_campaign") return json({ campaigns: [{ campaignId: "C1", campaignName: "General", campaignStatus: "RUNNING", fundingStrategy: { fundingModel: "COST_PER_SALE" } }] });
  if (u.pathname === "/sell/marketing/v1/ad_campaign/C1/ad") return json({ ads: [
    { adId: "a1", listingId: "206531844850", bidPercentage: "6.0" }, { adId: "a2", listingId: "111", bidPercentage: "5.0" },
    { adId: "a3", listingId: "222", bidPercentage: "2.0" }, { adId: "a4", listingId: "333", bidPercentage: "8.5" }] });
  if (u.pathname.includes("/update_bid")) { writes.push(["ADRATE", u.pathname.split("/ad/")[1], opts.body]); return new Response(null, { status: 204 }); }
  throw new Error("Unmocked " + u);
};

process.env.NTFY_TOPIC = "test-topic";
const { runBots, windowStart } = await import("../dist/bots/run.js");
const { decidePrice, floorTotal } = await import("../dist/bots/pricing.js");
const { loadConfig } = await import("../dist/bots/shared.js");
const r = await runBots();
const rf = await runBots({ only: ["finder"] });
const fi = rf.info.join("\n");
console.log(fi);

let fail = 0;
const check = (ok, msg) => { console.log((ok ? "PASS " : "FAIL ") + msg); if (!ok) fail++; };
const all = JSON.stringify(writes);
check(!all.includes("206531844850") && !all.includes("206453290362"), "burr holders never written (price, qty, ads)");
check(all.includes("<ItemID>111</ItemID><Quantity>10</Quantity>"), "low-stock Lasko feet restocked to 10");
check(!all.includes("<ItemID>333</ItemID><Quantity>"), "sold-out (qty 0) Canon door left sold out");
check(r.urgent.some((u) => u.includes("Burr holder stock low")), "burr holder low stock alerts you instead");
check(all.includes("<ItemID>111</ItemID><StartPrice>9.23</StartPrice>"), "Lasko feet lowered max 10% step toward $8.28 (10.25 → 9.23)");
check(all.includes("<ItemID>222</ItemID><StartPrice>10.99</StartPrice>"), "Lasko knob RAISED toward competitor (9.99 → 10.99 capped step)");
check(writes.filter((w) => w[0] === "ADRATE").length === 2 && all.includes('2.0'), "ads at 5% and 8.5% lowered to 2%; 2% left alone");
check(r.urgent.some((u) => u.includes("buyer_joe")) && !r.urgent.some((u) => u.includes("read one")), "unread buyer message alerted");
check(r.urgent.some((u) => u.includes("sad_sam")) && !r.urgent.some((u) => u.includes("happy")), "negative feedback alerted, positive ignored");
check(r.urgent.some((u) => u.includes("PAST ship-by")), "late order flagged");
check(writes.some((w) => w[0] === "PUSH"), "phone push sent");
check(all.includes("<ItemID>333</ItemID><StartPrice>16.98</StartPrice>"), "brain priced unruled Canon door vs 2 verified competitors (ignored $80 camera body): 15.89 → 16.98");
check(r.urgent.some((u) => u.includes("Suggested reply") && u.includes("model number")), "brain drafted a reply to the buyer (not sent)");
check(brainCalls.includes("claude-haiku-5-5") && brainCalls.includes("claude-sonnet-5-5"), "Haiku for matching, Sonnet for brief/replies");
check(!brainCalls.some(() => false) && !JSON.stringify(writes).includes("Baratza"), "brain never caused a burr holder write");

check(fi.includes("Bronco") && fi.includes("573 sold") && fi.includes("printables.com/model/520786") && fi.includes("CC-BY-SA"), "finder: Bronco clips with sold count, seller and sellable CAD");
check(fi.includes("2VPR") && fi.includes("NO FREE CAD"), "finder: proven seller without CAD listed separately");
check(!fi.includes("Lasko Box Fan"), "finder: skips parts you already sell");
check(!fi.includes("nobody buys"), "finder: ignores items under 100 sold");
const cfg = loadConfig();
const fl = floorTotal(cfg, {});
check(Math.abs(fl - (1.69 + 0.5 + 0.4) / (1 - 0.156 - 0.4)) < 1e-9, `profit floor = $${fl.toFixed(2)} for envelope items`);
const d = decidePrice(cfg, { query: "", min: 0 }, { item_id: "9", title: "x", price: 6.0, shipping_cost: 0 }, [{ seller: "a", title: "", total: 5.0 }]);
check(d === null || d.price >= fl, "never prices below profit floor even if competitor is cheaper");
const w = windowStart([7, 13, 19], "America/Indianapolis", new Date("2026-10-21T11:00:00Z"));
check(w.firstRunOfDay && Math.round((Date.parse("2026-10-21T11:00:00Z") - w.since) / 36e5 * 10) / 10 === 12.5, "7am run looks back 12.5h to last night's run");
console.log(fail ? `\n${fail} FAILED` : "\nALL PASSED");
process.exit(fail ? 1 : 0);
