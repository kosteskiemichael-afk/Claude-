// Google Apps Script for the "Nexa Product Ideas" sheet.
// Extensions > Apps Script, paste this, then Deploy > New deployment > Web app
// (Execute as: Me, Who has access: Anyone). Put the web app URL in Render as SHEETS_WEBHOOK_URL.
const HEADERS = ["Found", "eBay listing", "Seller", "Sold", "Price", "eBay link", "CAD link", "CAD license", "CAD file name", "Status", "My decision"];

function doPost(e) {
  const sheet = getSheet_();
  const data = JSON.parse(e.postData.contents || "{}");
  const rows = data.rows || [];
  const existing = new Set(sheet.getRange(2, 6, Math.max(sheet.getLastRow() - 1, 1), 1).getValues().flat().map(String));
  let added = 0, updated = 0;
  const links = sheet.getRange(2, 6, Math.max(sheet.getLastRow() - 1, 1), 1).getValues().flat().map(String);
  rows.forEach((r) => {
    const i = links.indexOf(r.ebay_url);
    if (i >= 0) { sheet.getRange(i + 2, 4).setValue(r.sold); updated++; return; } // refresh sold count
    if (existing.has(r.ebay_url)) return;
    sheet.appendRow([r.found, r.title, r.seller, r.sold, r.price, r.ebay_url, r.cad_url, r.cad_license, r.cad_name, r.status, ""]);
    existing.add(r.ebay_url); added++;
  });
  return ContentService.createTextOutput(`${added} new, ${updated} updated`);
}

function getSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName("Product Ideas");
  if (!sh) sh = ss.insertSheet("Product Ideas");
  if (sh.getLastRow() === 0) {
    sh.appendRow(HEADERS);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, HEADERS.length).setFontWeight("bold");
  }
  return sh;
}
