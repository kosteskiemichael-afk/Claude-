// Nexa Product Ideas: permanent storage for the products the Nexa bots find.
// The dashboard ("Nexa Command") reads and updates it through this web app; you never need to open the sheet.
// Deploy > Manage deployments > edit > Version: New version (same URL). Render keeps it in SHEETS_WEBHOOK_URL.
//   {rows:[...]}                         add new finds (existing ones only get their sold count refreshed)
//   {action:"list"}                      all rows as JSON
//   {action:"decide", ebay_url, decision} set "My decision" (e.g. "added" / "dismissed"; "" to restore)
var HEADERS = ["Found", "eBay listing", "Seller", "Sold", "Price", "eBay link", "CAD link", "CAD license", "CAD file name", "Status", "My decision"];

function doPost(e) {
  var body = JSON.parse((e && e.postData && e.postData.contents) || "{}");
  var sheet = getSheet_();
  var last = sheet.getLastRow();
  var links = last > 1 ? sheet.getRange(2, 6, last - 1, 1).getValues().map(function (r) { return String(r[0]); }) : [];

  if (body.action === "list") {
    var vals = last > 1 ? sheet.getRange(2, 1, last - 1, HEADERS.length).getValues() : [];
    var out = vals.map(function (v) {
      var f = v[0] instanceof Date ? Utilities.formatDate(v[0], "America/Indianapolis", "yyyy-MM-dd") : String(v[0]);
      return { found: f, title: String(v[1]), seller: String(v[2]), sold: Number(v[3]) || 0, price: Number(v[4]) || 0, ebay_url: String(v[5]),
        cad_url: String(v[6]), cad_license: String(v[7]), cad_name: String(v[8]), status: String(v[9]), decision: String(v[10]) };
    });
    return json_({ ok: true, rows: out });
  }

  if (body.action === "decide") {
    var i = links.indexOf(String(body.ebay_url));
    if (i < 0 && body.row) { // a product that isn't stored yet: add it, then set the decision
      var r = body.row;
      sheet.appendRow([r.found, r.title, r.seller, r.sold, r.price, r.ebay_url, r.cad_url, r.cad_license, r.cad_name, r.status, ""]);
      i = links.length; links.push(r.ebay_url);
    }
    if (i < 0) return json_({ ok: false, error: "not found" });
    sheet.getRange(i + 2, 11).setValue(String(body.decision || ""));
    return json_({ ok: true });
  }

  var rows = body.rows || [];
  var added = 0, updated = 0;
  rows.forEach(function (r) {
    var i = links.indexOf(r.ebay_url);
    if (i >= 0) { sheet.getRange(i + 2, 4).setValue(r.sold); updated++; return; }
    sheet.appendRow([r.found, r.title, r.seller, r.sold, r.price, r.ebay_url, r.cad_url, r.cad_license, r.cad_name, r.status, ""]);
    links.push(r.ebay_url); added++;
  });
  return ContentService.createTextOutput(added + " new, " + updated + " updated");
}

function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

function getSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName("Product Ideas") || ss.insertSheet("Product Ideas");
  if (sh.getLastRow() === 0) {
    sh.appendRow(HEADERS);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, HEADERS.length).setFontWeight("bold");
  }
  return sh;
}
