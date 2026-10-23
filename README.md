# Nexa eBay Connector for Claude

Lets Claude read and manage your eBay store directly: listings, prices,
item specifics, handling time, orders, traffic reports, competitor search,
and Promoted Listings ad rates.

**Safety built in**
- Every change tool shows a **preview first**. Nothing changes on eBay until
  Claude calls it again with `confirm: true` (Claude will ask you first).
- Your **Baratza burr holders are locked**: any listing in `PROTECTED_ITEM_IDS`
  or with "Baratza" / "Burr Holder" in the title can be read but never changed.
- Your eBay keys live only in your Render settings. Never paste them into chat.
- The connector address contains a long random secret, so nobody else can use it.

## Tools Claude gets

| Tool | What it does |
|---|---|
| list_active_listings | All active listings: price, qty, sold, watchers, shipping cost |
| get_listing | Full detail for one listing incl. item specifics, variations, shipping |
| update_price_quantity | Change price / quantity (works on variations by SKU) |
| revise_listing | Change title, handling days, Best Offer, item specifics (merged) |
| get_orders | Recent orders (no buyer addresses) |
| get_traffic_report | Impressions, views, CTR, sales, conversion per listing (up to 90 days) |
| search_market | Live competitor listings: price, shipping, seller (no sold counts; eBay's API doesn't offer them) |
| get_promoted_listings | Campaigns and the ad rate on every listing |
| update_ad_rate | Change ad rate on listings in a campaign |

Not included yet: switching a listing to free shipping (eBay replaces the
whole shipping policy on that call, so it needs more care). Ask Claude to add it.

---

## Setup (about 45 minutes, all free)

### Step 1: eBay developer account and keys
1. Go to **developer.ebay.com** and click **Register**. Approval can take up
   to 1 business day.
2. Open **Hi [name] > Application Keysets** and create a **Production** keyset.
   eBay asks about "Marketplace Account Deletion" notifications. Choose
   **"I do not persist eBay data" (exemption)**. This connector stores nothing.
3. Note your **App ID (Client ID)** and **Cert ID (Client Secret)**. Keep them private.

### Step 2: Create your redirect name (RuName)
1. On the keyset page click **User Tokens**, then
   **Get a Token from eBay via Your Application > Add eBay Redirect URL**.
2. Fill in any display title. For **"Your auth accepted URL"** enter
   `https://www.ebay.com` (any https page works). Save.
3. Copy the **RuName** it shows (looks like `Michael_Kostes-NexaMfg-PRD-abc123-xyz`).

### Step 3: Get your refresh token (on your own computer)
1. Install **Node.js 20+** from nodejs.org if you don't have it.
2. Unzip this folder, open **Terminal** in it, and run (one line, your values):
   ```
   EBAY_APP_ID=YourAppId EBAY_CERT_ID=YourCertId EBAY_RUNAME=YourRuName node scripts/get-refresh-token.mjs
   ```
3. Open the link it prints, sign in with your **seller account**, click **Agree**.
4. Copy the address your browser lands on and paste it into Terminal.
5. It prints your **refresh token** (valid about 18 months). Keep it private.

### Step 4: Put the code on GitHub
1. Create a free account at **github.com** > **New repository**, name it
   `nexa-ebay-connector`, set it to **Private**, create.
2. Click **uploading an existing file** and drag in everything from this folder
   **except** any `.env` file. Commit.

### Step 5: Deploy on Render (free)
1. Create a free account at **render.com** and connect your GitHub.
2. **New > Blueprint**, pick the `nexa-ebay-connector` repo. Render reads
   `render.yaml` and creates the service.
3. When asked for environment values, enter:
   - `EBAY_APP_ID`: from step 1
   - `EBAY_CERT_ID`: from step 1
   - `EBAY_REFRESH_TOKEN`: from step 3
   (`CONNECTOR_SECRET` is generated for you; the burr holder protection is pre-filled.)
4. Deploy. When it says **Live**, open the service's **Environment** tab and
   copy the value of `CONNECTOR_SECRET`.

Your connector address is:
```
https://<your-service-name>.onrender.com/mcp/<CONNECTOR_SECRET>
```
(The service URL is shown at the top of the Render page.)

### Step 6: Add it to Claude
1. In Claude: **Settings > Connectors > Add custom connector**.
2. Name it `eBay (Nexa)` and paste the address from step 5.
3. Turn it on in your chat, then ask: *"List my active eBay listings."*

**Note:** Render's free plan sleeps after 15 minutes idle, so the first
request after a break takes 30-60 seconds. The $7/month plan stays awake.

### Every ~18 months
Re-run step 3 and paste the new refresh token into Render > Environment.

## Changing protected listings
Edit `PROTECTED_ITEM_IDS` (comma-separated item numbers) or
`PROTECTED_TITLE_KEYWORDS` in Render > Environment, then redeploy.

---

## Store bots (run 3x a day on their own)

A Render cron job (`nexa-store-bots`) runs five bots at 7am, 1pm and 7pm
(Indiana time; 6am/noon/6pm in winter). Your burr holders are never changed by any bot.

| Bot | What it does on its own | What it sends to your phone |
|---|---|---|
| Listing & inventory | Tops print-on-demand listings back up to 10 when they drop below 3. Listings you set to 0 (sold out) are left alone, and anything in `inventory.never_restock` is never touched | Burr holder stock low (you restock those); each morning, listings with views but no sales |
| Pricing & competition | Every morning, for each item in `bots.config.json` (and every listing when the brain is on): raises to 1¢ under the cheapest true competitor when you're cheaper; raises 3%/day while an item sells fast (5+ in 30 days) and nobody undercuts you; cuts only items with 0 sales in 30 days when a competitor is cheaper; otherwise holds. Never below your profit floor (40% after fees, label and material), never outside the item's min/max, never more than 10% per day; prices change only on the morning run so you don't start price wars | Every price change |
| Marketing | Keeps your own ad rates. Only ads above `max_ad_rate` (5%) are capped; listings in `marketing.ad_rates` are set to exactly that rate | Each change listed; a warning if a campaign uses eBay's dynamic rate |
| Customer service | Never replies for you | New unread buyer messages, negative/neutral feedback, orders due within 18h or late |
| Product finder (Mondays) | Searches eBay for 3D-printed parts with 100+ sold that you don't sell yet, finds a CAD file you can legally sell (CC0/CC BY/CC BY-SA/GPL; never NC) and sends each idea with listing title, seller, sold count, price and CAD link. Run it any time with **Find new products now** on the dashboard | The weekly idea list |
| Production | Builds the print queue from unshipped orders, soonest ship date first | Full queue every morning; new orders on later runs |

You get a push only when something changed or needs you, plus a morning summary.

### The business brain (Claude)
With `ANTHROPIC_API_KEY` set, the bots get a brain:
- **Prices every listing**, not just the ones in `bots.config.json`. Claude Haiku writes the right
  eBay search for each part, then checks every competitor listing and keeps only true matches (same part,
  same model; adjusts for pack size). It needs 2+ verified competitors before it touches a price.
- **Won't cut prices on items already selling** (5+ sales in 30 days); it only raises those.
- **Drafts a reply** to each new buyer message (Claude Sonnet) and puts it in your push. You paste and send.
- **Morning "Today's moves"**: Claude Sonnet reads your whole store (sales, traffic, prices, stock) and
  sends the 3–5 highest-profit actions for the day.

The brain only advises; the hard limits (40% profit floor, 10% max move per run, burr holder lock) are
enforced in code and the brain can't override them. Expected cost: about $1–3 a month in Claude API usage.
Turn it off any time by setting `BRAIN` to `off`.

### Phone alerts (2 minutes)
1. Install the free **ntfy** app (App Store / Google Play).
2. In Render > nexa-ebay-connector > Environment, copy the value of `NTFY_TOPIC` (Render generated it).
3. In the app tap **+** and subscribe to that topic. Treat it like a password.

### Adding an item to auto-pricing
Add its item number to `pricing.rules` in `bots.config.json` with a search
`query`, `must_include` words (so only true competitors count), and `min`/`max`.

### Pause or test
- Pause everything: Render > nexa-store-bots > **Suspend**.
- Test without changing anything: set `DRY_RUN` to `1` and click **Trigger Run**.
- Offline self-test: `npm run test-bots`.

### Live dashboard
Open `https://<your-service>.onrender.com/dashboard/<CONNECTOR_SECRET>` (same secret as your connector
address). It shows every bot run, orders to ship, late shipments, low stock, ads above 5%, the print queue
and the auto-priced items. It refreshes every minute and never changes anything. Bookmark it on your phone.
On Render's free plan the first load after a quiet spell takes 30–60 seconds.

### Product ideas in Google Sheets
Every finder run adds new ideas to the **Nexa Product Ideas** sheet (tab "Product Ideas") through the Apps Script in
`sheets/ProductIdeas.gs` (its web app URL is in Render as `SHEETS_WEBHOOK_URL`). Existing rows only get their sold count refreshed.
CAD search covers Printables, plus Thingiverse when `THINGIVERSE_TOKEN` is set (free app token from thingiverse.com/developers).
Only licenses that allow selling prints are used (CC0, CC BY, CC BY-SA, CC BY-ND, GPL, BSD); NonCommercial files are never offered.
With `ANTHROPIC_API_KEY` set, Claude confirms each CAD file is the same part; without it, matches are marked "Possible CAD - check".
