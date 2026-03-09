/**
 * Google Apps Script Web App logger + stats API for survey events.
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

function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) ? String(e.parameter.action) : "health";
  if (action === "stats") {
    return statsResponse_(e);
  }
  return jsonResponse({ ok: true, service: "survey-log" });
}

function doPost(e) {
  var nowIso = new Date().toISOString();
  try {
    var body = (e && e.postData && e.postData.contents) ? e.postData.contents : "{}";
    var payload = JSON.parse(body);
    if (!payload || typeof payload !== "object") {
      return jsonResponse({ ok: false, error: "invalid_payload" });
    }

    var sheet = getLogsSheet_();
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
    logError_(String(err), e);
    return jsonResponse({ ok: false, error: String(err) });
  }
}

function statsResponse_(e) {
  var attentionFilter = (e && e.parameter && e.parameter.attention_filter) ? String(e.parameter.attention_filter) : "pass_only";
  var failWeightRaw = (e && e.parameter && e.parameter.attention_fail_weight) ? Number(e.parameter.attention_fail_weight) : 0.35;
  var attentionFailWeight = Math.max(0, Math.min(1, isFinite(failWeightRaw) ? failWeightRaw : 0.35));
  var maxEventsRaw = (e && e.parameter && e.parameter.max_events) ? Number(e.parameter.max_events) : 200;
  var maxEvents = Math.max(1, Math.min(500, isFinite(maxEventsRaw) ? maxEventsRaw : 200));

  var rows = loadLogPayloads_();
  rows = dedupeRows_(rows);

  var checksByPid = {};
  rows.forEach(function (r) {
    var pid = asString_(r.participant_id);
    if (!pid) return;
    var expected = asString_(r.expected_choice) || expectedChoice_(asString_(r.trial_type));
    if (!expected) return;
    if (!checksByPid[pid]) checksByPid[pid] = [];
    checksByPid[pid].push(asString_(r.choice) === expected);
  });

  var passed = {};
  Object.keys(checksByPid).forEach(function (pid) {
    var arr = checksByPid[pid];
    var ok = arr.length > 0 && arr.every(function (x) { return x; });
    if (ok) passed[pid] = true;
  });

  var allPids = {};
  rows.forEach(function (r) {
    var pid = asString_(r.participant_id);
    if (pid) allPids[pid] = true;
  });
  var allPidList = Object.keys(allPids).sort();
  var aliasByPid = {};
  allPidList.forEach(function (pid, idx) {
    aliasByPid[pid] = "user-" + (idx + 1);
  });

  var filtered = rows.filter(function (r) {
    if (attentionFilter !== "pass_only") return true;
    var pid = asString_(r.participant_id);
    return !!passed[pid];
  });

  var weightByPid = {};
  allPidList.forEach(function (pid) {
    var checks = checksByPid[pid] || [];
    if (checks.length === 0) {
      weightByPid[pid] = 1;
    } else if (checks.every(function (x) { return x; })) {
      weightByPid[pid] = 1;
    } else {
      weightByPid[pid] = attentionFailWeight;
    }
  });

  var grouped = {};
  filtered.forEach(function (r) {
    if (asString_(r.trial_type) !== "main") return;
    var profile = asString_(r.candidate_profile);
    var device = asString_(r.device_class);
    var pid = asString_(r.participant_id);
    if (!profile || !device || !pid) return;
    var choice = asString_(r.choice);
    var key = profile + "|||" + device;
    if (!grouped[key]) {
      grouped[key] = {
        candidate_profile: profile,
        device_class: device,
        n_trials_raw: 0,
        n_trials_weighted: 0,
        baseline_w: 0,
        candidate_w: 0,
        nodiff_w: 0,
        bitrate_mbps: extractMbps_(profile),
        size_mb_sum: 0,
        size_mb_n: 0,
        encode_sec_sum: 0,
        encode_sec_n: 0,
        bitrate_sum: 0,
        bitrate_n: 0
      };
    }
    var w = (weightByPid[pid] != null) ? weightByPid[pid] : 1;
    grouped[key].n_trials_raw += 1;
    grouped[key].n_trials_weighted += w;
    if (choice === "baseline") grouped[key].baseline_w += w;
    if (choice === "candidate") grouped[key].candidate_w += w;
    if (choice === "nodiff") grouped[key].nodiff_w += w;
    var sizeMb = parseOptNumber_(r.candidate_size_mb);
    if (sizeMb !== null) {
      grouped[key].size_mb_sum += sizeMb;
      grouped[key].size_mb_n += 1;
    }
    var encSec = parseOptNumber_(r.candidate_encode_sec);
    if (encSec !== null) {
      grouped[key].encode_sec_sum += encSec;
      grouped[key].encode_sec_n += 1;
    }
    var rowBitrate = parseOptNumber_(r.candidate_bitrate_mbps);
    if (rowBitrate !== null && rowBitrate > 0) {
      grouped[key].bitrate_sum += rowBitrate;
      grouped[key].bitrate_n += 1;
    }
  });

  var summary = Object.keys(grouped).sort().map(function (k) {
    var g = grouped[k];
    var nw = g.n_trials_weighted || 1;
    return {
      candidate_profile: g.candidate_profile,
      device_class: g.device_class,
      bitrate_mbps: g.bitrate_n > 0 ? (g.bitrate_sum / g.bitrate_n) : g.bitrate_mbps,
      n_trials_raw: g.n_trials_raw,
      n_trials_weighted: g.n_trials_weighted,
      not_worse_rate: (g.nodiff_w + g.candidate_w) / nw,
      no_diff_rate: g.nodiff_w / nw,
      baseline_better_rate: g.baseline_w / nw,
      better_than_baseline_rate: g.candidate_w / nw,
      candidate_better_rate: g.candidate_w / nw,
      avg_size_mb: g.size_mb_n > 0 ? (g.size_mb_sum / g.size_mb_n) : null,
      avg_encode_sec: g.encode_sec_n > 0 ? (g.encode_sec_sum / g.encode_sec_n) : null
    };
  });

  var events = [];
  var startIdx = Math.max(0, rows.length - maxEvents);
  for (var i = startIdx; i < rows.length; i++) {
    var r = rows[i];
    var pid = asString_(r.participant_id);
    if (!pid) continue;
    var choice = asString_(r.choice);
    var picked = "unknown";
    if (choice === "baseline" || choice === "candidate") picked = choice;
    else if (choice === "nodiff") picked = "no difference";
    events.push({
      text: aliasByPid[pid] + " on " + (asString_(r.device_class) || "unknown_device") + " in trial " + (asString_(r.trial_id) || "unknown_trial") + " chose " + picked,
      timestamp: asString_(r.timestamp)
    });
  }

  var filteredPids = {};
  filtered.forEach(function (r) {
    var pid = asString_(r.participant_id);
    if (pid) filteredPids[pid] = true;
  });
  var mainFilteredCount = filtered.filter(function (r) { return asString_(r.trial_type) === "main"; }).length;

  return jsonResponse({
    ok: true,
    attention_filter: attentionFilter,
    attention_fail_weight: attentionFailWeight,
    totals: {
      events_all: rows.length,
      events_filtered: filtered.length,
      participants_all: allPidList.length,
      participants_pass_attention: Object.keys(passed).length,
      participants_filtered: Object.keys(filteredPids).length,
      main_trials_filtered: mainFilteredCount
    },
    summary: summary,
    events: events
  });
}

function loadLogPayloads_() {
  var sheet = getLogsSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var vals = sheet.getRange(2, 1, lastRow - 1, 6).getValues();
  var out = [];
  vals.forEach(function (row) {
    var payloadJson = row[5];
    if (!payloadJson) return;
    try {
      var obj = JSON.parse(String(payloadJson));
      if (obj && typeof obj === "object") out.push(obj);
    } catch (_) {
      // skip bad row
    }
  });
  return out;
}

function expectedChoice_(trialType) {
  if (trialType === "obvious_low") return "baseline";
  if (trialType === "same_same") return "nodiff";
  return "";
}

function extractMbps_(profile) {
  if (!profile) return null;
  var p = String(profile).toLowerCase();
  var m = p.match(/(\d+(?:\.\d+)?)\s*m/);
  if (p.indexOf("bad") >= 0) return 1;
  if (p.indexOf("same") >= 0) return 10;
  if (p.indexOf("codec") >= 0) return 5;
  if (!m) return null;
  var v = Number(m[1]);
  if (isFinite(v)) return v;
  return null;
}

function dedupeRows_(rows) {
  var out = [];
  var lastSeen = {};
  var windowMs = 15000;
  rows.forEach(function (r) {
    var pid = asString_(r.participant_id);
    var trialId = asString_(r.trial_id);
    if (!pid || !trialId) {
      out.push(r);
      return;
    }
    var k = pid + "||" + trialId;
    var ts = parseIsoMs_(r.timestamp);
    if (!lastSeen[k]) {
      out.push(r);
      lastSeen[k] = { ts: ts, idx: out.length - 1 };
      return;
    }
    var prev = lastSeen[k];
    if (ts !== null && prev.ts !== null && Math.abs(ts - prev.ts) <= windowMs) {
      out[prev.idx] = r;
      lastSeen[k] = { ts: ts, idx: prev.idx };
      return;
    }
    out.push(r);
    lastSeen[k] = { ts: ts, idx: out.length - 1 };
  });
  return out;
}

function parseIsoMs_(v) {
  if (v === null || v === undefined) return null;
  var s = String(v);
  if (!s) return null;
  var ms = Date.parse(s);
  return isFinite(ms) ? ms : null;
}

function asString_(v) {
  return (v === null || v === undefined) ? "" : String(v);
}

function parseOptNumber_(v) {
  if (v === null || v === undefined || v === "") return null;
  var n = Number(v);
  return isFinite(n) ? n : null;
}

function getLogsSheet_() {
  var spreadsheetId = PropertiesService.getScriptProperties().getProperty("SPREADSHEET_ID");
  if (!spreadsheetId) throw new Error("missing SPREADSHEET_ID script property");
  var ss = SpreadsheetApp.openById(spreadsheetId);
  var sheet = ss.getSheetByName("logs");
  if (!sheet) {
    sheet = ss.insertSheet("logs");
    sheet.appendRow(["received_at", "participant_id", "trial_id", "device_class", "choice", "payload_json"]);
  }
  return sheet;
}

function logError_(msg, e) {
  try {
    var spreadsheetId = PropertiesService.getScriptProperties().getProperty("SPREADSHEET_ID");
    if (!spreadsheetId) return;
    var ss = SpreadsheetApp.openById(spreadsheetId);
    var sh = ss.getSheetByName("errors") || ss.insertSheet("errors");
    if (sh.getLastRow() === 0) sh.appendRow(["time", "error", "raw_body"]);
    var raw = (e && e.postData && e.postData.contents) ? e.postData.contents : "";
    sh.appendRow([new Date().toISOString(), msg, raw]);
  } catch (_) {}
}

function valueOrEmpty(v) {
  return (v === null || v === undefined) ? "" : String(v);
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
