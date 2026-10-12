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
