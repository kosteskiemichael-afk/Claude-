// Nexa Product Ideas: receives weekly product ideas from the Nexa bots.
// Deploy > New deployment > Web app (Execute as: Me, Who has access: Anyone).
// Put the web app URL in Render as SHEETS_WEBHOOK_URL.
var HEADERS = ["Found", "eBay listing", "Seller", "Sold", "Price", "eBay link", "CAD link", "CAD license", "CAD file name", "Status", "My decision"];

function doPost(e) {
  var sheet = getSheet_();
  var rows = (JSON.parse(e.postData.contents || "{}").rows) || [];
  var last = sheet.getLastRow();
  var links = last > 1 ? sheet.getRange(2, 6, last - 1, 1).getValues().map(function (r) { return String(r[0]); }) : [];
  var added = 0, updated = 0;
  rows.forEach(function (r) {
    var i = links.indexOf(r.ebay_url);
    if (i >= 0) { sheet.getRange(i + 2, 4).setValue(r.sold); updated++; return; }
    sheet.appendRow([r.found, r.title, r.seller, r.sold, r.price, r.ebay_url, r.cad_url, r.cad_license, r.cad_name, r.status, ""]);
    links.push(r.ebay_url); added++;
  });
  return ContentService.createTextOutput(added + " new, " + updated + " updated");
}

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
