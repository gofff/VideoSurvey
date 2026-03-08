/**
 * Google Apps Script Web App logger for survey events.
 *
 * Setup:
 * 1) Create a Google Sheet and copy its ID from URL.
 * 2) In Apps Script project, set SCRIPT PROPERTY:
 *    SPREADSHEET_ID = <your_sheet_id>
 * 3) Deploy as Web App:
 *    - Execute as: Me
 *    - Who has access: Anyone with the link
 * 4) Put deployment URL into config.json -> google_log_endpoint
 */

function doPost(e) {
  var nowIso = new Date().toISOString();
  try {
    var body = (e && e.postData && e.postData.contents) ? e.postData.contents : "{}";
    var payload = JSON.parse(body);
    if (!payload || typeof payload !== "object") {
      return jsonResponse({ ok: false, error: "invalid_payload" });
    }

    var spreadsheetId = PropertiesService.getScriptProperties().getProperty("SPREADSHEET_ID");
    if (!spreadsheetId) {
      return jsonResponse({ ok: false, error: "missing_spreadsheet_id" });
    }

    var ss = SpreadsheetApp.openById(spreadsheetId);
    var sheet = ss.getSheetByName("logs");
    if (!sheet) {
      sheet = ss.insertSheet("logs");
      sheet.appendRow(["received_at", "participant_id", "trial_id", "device_class", "choice", "payload_json"]);
    }

    sheet.appendRow([
      nowIso,
      valueOrEmpty(payload.participant_id),
      valueOrEmpty(payload.trial_id),
      valueOrEmpty(payload.device_class),
      valueOrEmpty(payload.choice),
      JSON.stringify(payload)
    ]);

    return jsonResponse({ ok: true });
  } catch (err) {
    return jsonResponse({ ok: false, error: String(err) });
  }
}

function valueOrEmpty(v) {
  return (v === null || v === undefined) ? "" : String(v);
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
