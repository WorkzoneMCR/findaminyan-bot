var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker.js
var BASE_URL = "https://findaminyan.co.uk";
var LOC_INDIVIDUAL = 1;
var LOC_CAMP = 3;
var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
var worker_default = {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === "/health") {
      return new Response("OK");
    }
    if (pathname === "/sms" && request.method === "POST") {
      try {
        return await handleSms(request, env);
      } catch (err) {
        console.error("Unhandled error:", err);
        return twimlResponse("Sorry, a system error occurred. Please try again shortly.");
      }
    }
    if (pathname === "/checkup" && request.method === "POST") {
      try {
        return await handleSms(request, env);
      } catch (err) {
        console.error("Unhandled error:", err);
        return twimlResponse("Sorry, a system error occurred. Please try again shortly.");
      }
    }
    if (pathname === "/logs") {
      return handleLogsPage(request, env);
    }
    if (pathname === "/review") {
      return handleReview(request, env);
    }
    if (pathname === "/safelist") {
      return handleSafelist(request, env);
    }
    if (pathname === "/apitest") {
      return handleApiTest(request, env);
    }
    return new Response("Not Found", { status: 404 });
  }
};
async function handleSms(request, env) {
  const rawBody = await request.text();
  const params = Object.fromEntries(new URLSearchParams(rawBody));
  const signature = request.headers.get("X-Twilio-Signature") || "";
  if (!await validateTwilioSignature(env.TWILIO_AUTH_TOKEN, request.url, params, signature)) {
    return new Response("Forbidden", { status: 403 });
  }
  const fromNumber = params.From || "";
  const smsBody = (params.Body || "").trim();
  console.log(`[SMS] From: ${fromNumber} | Body: ${smsBody}`);

  // Detect check-up modes
  const isCheckExisting = /^check\s*up\s*existing\s*:/i.test(smsBody);
  const isCheckNew = /^check\s*up\s*new\s*:/i.test(smsBody);
  const isCheckUp = isCheckExisting || isCheckNew;

  // Strip the check-up prefix before parsing
  const bodyToParse = isCheckUp ? smsBody.replace(/^check\s*up\s*(existing|new)\s*:\s*/i, "") : smsBody;

  const parsed = parseSms(bodyToParse, { requireMobile: !isCheckUp });
  if (parsed.missing) {
    const missing = parsed.missing.join(", ");
    console.log(`[SMS] Missing fields: ${missing}`);
    return twimlResponse(`Missing: ${missing}. Please resend with all required details.`);
  }
  const { numPeople, start, end, postcode, maxMiles, contactMobile } = parsed;
  const dateRange = `${displayDate(start)}-${displayDate(end)}`;
  console.log(`[SMS] Parsed: ${numPeople} people, ${displayDate(start)}-${displayDate(end)}, ${postcode}`);
  const geo = await geocodePostcode(postcode);
  if (!geo) {
    console.log(`[SMS] Geocode failed for postcode: ${postcode}`);
    return twimlResponse(
      `Sorry, I couldn't find postcode ${postcode}. Please check and try again.`
    );
  }
  const { lat, lng, address } = geo;
  console.log(`[SMS] Geocoded ${postcode} \u2192 lat:${geo.lat} lng:${geo.lng}`);
  const cookies = await loginToSite(env.FINDAMINYAN_EMAIL, env.FINDAMINYAN_PASSWORD);
  if (!cookies) {
    console.log("[SMS] Login to findaminyan.co.uk FAILED");
    return twimlResponse("Sorry, there was a system error. Please try again in a few minutes.");
  }
  console.log("[SMS] Login OK");
  let senderMobile = fromNumber.startsWith("+44") ? "0" + fromNumber.slice(3) : fromNumber;
  const contactForSite = contactMobile || senderMobile;
  console.log(`[SMS] Contact for site: ${contactForSite}${contactMobile ? " (from SMS body)" : " (sender)"}`);

  // Change 1: search radius = maxMiles directly (no 1.5x multiplier)
  const searchRadius = maxMiles;

  // For check-ups: skip duplicate detection and skip addLocation
  let rawEntries;
  if (isCheckUp) {
    const nearbyDataPre = await searchNearby(cookies, lat, lng, start, end, searchRadius);
    const { entries: preEntries } = countPeopleNearby(nearbyDataPre, start, end);
    if (isCheckExisting) {
      // Check if their entry actually exists
      const normMobile = senderMobile.replace(/\s/g, "");
      const normFrom = fromNumber.replace(/\s/g, "");
      const normContact = contactForSite.replace(/\s/g, "");
      const normPostcode = postcode.replace(/\s/g, "").toUpperCase();
      const exists = preEntries.some((e) => {
        const p = (e.phone || "").replace(/\s/g, "");
        const pc = (e.postcode || "").replace(/\s/g, "").toUpperCase();
        return (p && (p === normMobile || p === normFrom || p === normContact)) || pc === normPostcode;
      });
      if (!exists) {
        console.log(`[SMS] check up existing — listing not found, returning prompt`);
        return twimlResponse(`This address is not registered yet. To check nearby without registering use 'check up new:'. To register, resend without the check up prefix, e.g. 1 man, NE8 1TU, 1-5aug, 07974591907. FindAMinyan`);
      }
      console.log(`[SMS] check up existing — listing found, skipping add`);
      rawEntries = preEntries;
    } else {
      console.log(`[SMS] check up new — skipping add`);
      rawEntries = preEntries;
    }
  } else {
    // Normal registration flow
    const nearbyDataPre = await searchNearby(cookies, lat, lng, start, end, searchRadius);
    const { entries: preEntries } = countPeopleNearby(nearbyDataPre, start, end);
    console.log(`[SMS] Pre-add nearby: ${preEntries.length} entries`);
    const normMobile = senderMobile.replace(/\s/g, "");
    const normFrom = fromNumber.replace(/\s/g, "");
    const normContact = contactForSite.replace(/\s/g, "");
    const normPostcode = postcode.replace(/\s/g, "").toUpperCase();
    // Change 4: duplicate = same phone OR same postcode
    const isDuplicate = preEntries.some((e) => {
      const p = (e.phone || "").replace(/\s/g, "");
      const pc = (e.postcode || "").replace(/\s/g, "").toUpperCase();
      const phoneMatch = p && (p === normMobile || p === normFrom || p === normContact);
      const postcodeMatch = pc === normPostcode;
      return phoneMatch || postcodeMatch;
    });
    if (isDuplicate) {
      console.log(`[SMS] Duplicate detected for ${senderMobile} \u2014 not adding`);
      const dupReply = `Already registered: ${postcode} (${dateRange}). Pending review - admin will be in touch if there is a minyan!`;
      await writeLog(env, {
        id: Date.now() + "-" + Math.random().toString(36).slice(2, 7),
        time: (/* @__PURE__ */ new Date()).toISOString(),
        from: senderMobile,
        body: smsBody,
        postcode,
        dates: dateRange,
        people: numPeople,
        nearby: preEntries.reduce((s, e) => s + e.people, 0),
        status: "DUPLICATE \u2014 PENDING",
        reply: dupReply,
        lat,
        lng,
        address,
        startIso: start.toISOString(),
        endIso: end.toISOString(),
        mobile: senderMobile
      });
      return twimlResponse(dupReply);
    }
    const addResult = await addLocation(
      cookies,
      postcode,
      numPeople,
      start,
      end,
      lat,
      lng,
      address,
      contactForSite,
      env.FINDAMINYAN_EMAIL
    );
    console.log(`[SMS] addLocation response: ${addResult}`);
    const nearbyDataPost = await searchNearby(cookies, lat, lng, start, end, searchRadius);
    const { entries } = countPeopleNearby(nearbyDataPost, start, end);
    rawEntries = entries;
  }
  console.log(`[SMS] Post-add nearby: ${rawEntries.length} entries`);
  const selfPhones = new Set(
    [senderMobile, fromNumber, contactForSite].map(normalizePhone).filter(Boolean)
  );
  const normPostcodeFilter = postcode.replace(/\s/g, "").toUpperCase();
  const otherEntries = rawEntries.filter((e) => {
    const p = normalizePhone(e.phone || "");
    const pc = (e.postcode || "").replace(/\s/g, "").toUpperCase();
    // Exclude user's own entry by phone OR postcode (for check-up existing where entry is already in DB)
    if (isCheckExisting && pc === normPostcodeFilter) return false;
    return !p || !selfPhones.has(p);
  });
  let enriched = otherEntries;
  const destCoords = otherEntries.map((e) => ({ lat: e.lat, lng: e.lng }));
  if (destCoords.some((d) => d.lat && d.lng)) {
    const driveTimes = await getDrivingDistancesOSRM(lat, lng, destCoords);
    enriched = otherEntries.map((e, i) => ({ ...e, driveMiles: driveTimes[i]?.miles ?? null, driveMinutes: driveTimes[i]?.minutes ?? null })).filter((e) => e.driveMiles == null || e.driveMiles <= maxMiles);
  }
  const total = numPeople + enriched.reduce((s, e) => s + e.people, 0);
  const others = total - numPeople;
  const MINYAN = 10;
  let reply;
  const resultStatus = total >= MINYAN ? "MINYAN POSSIBLE" : total >= 8 ? "Getting close" : "Not enough yet";
  console.log(`[SMS] Result: ${resultStatus} (${total} people)`);
  const requesterDays = Math.round((end.getTime() - start.getTime()) / 864e5) + 1;
  if (total >= 8) {
    const contactLines = enriched.slice(0, 5).map((e, i) => {
      const dist    = e.driveMinutes != null ? ` (${Math.round(e.driveMinutes)}min drive)` : "";
      const manmen  = e.people === 1 ? "1 man" : `${e.people} men`;
      const eStart  = parseApiDate(e.startDate);
      const eEnd    = parseApiDate(e.endDate);
      const dates   = eStart && eEnd ? ` ${shortDate(eStart)}-${shortDate(eEnd)}` : "";
      const phone   = e.phone ? ` No. ${e.phone.trim()}` : "";
      return `${i + 1}) ${manmen}${dates} - ${e.postcode}${dist}${phone}.`.trim();
    });
    const minyanLine = total >= MINYAN ? " MINYAN!" : "";
    const includingYou = isCheckUp ? "" : " (including you)";
    const headerCount = isCheckUp ? others : total;
    reply = `There are ${headerCount} people near '${postcode}' for ${dateRange}${includingYou}.\nHere are the details of those nearby\n` + contactLines.join("\n") + `\nCheck back 1-2wks. FindAMinyan.${minyanLine}`;
    if (total >= MINYAN) {
      await notifyAdmin(env, total, postcode, start, end, enriched, senderMobile);
    }
  } else if (others === 0) {
    if (isCheckUp) {
      reply = `No one else is registered nearby for those dates yet - check back in 1-2 wks! FindAMinyan`;
    } else {
      reply = `We have added your details - ${postcode}, ${numPeople} ${numPeople === 1 ? "man" : "men"}, ${dateRange}. No one else is nearby yet for a minyan - check back again in 1-2 wks! Findaminyan`;
    }
  } else {
    if (isCheckUp) {
      reply = `There are ${others} other${others === 1 ? "" : "s"} nearby for those dates, ${total} in total, but not enough yet for a minyan - check back in 1-2 wks! FindAMinyan`;
    } else {
      reply = `We have added your details - ${postcode}, ${numPeople} ${numPeople === 1 ? "man" : "men"}, ${dateRange}. There are ${others} other${others === 1 ? "" : "s"} nearby, ${total} in total, but not enough yet for a minyan - check back again in 1-2 wks! Findaminyan`;
    }
  }

  const logStatus = isCheckExisting ? `CHECK \u2014 EXISTING` : isCheckNew ? `CHECK \u2014 NEW` : resultStatus;
  await writeLog(env, {
    id: Date.now() + "-" + Math.random().toString(36).slice(2, 7),
    time: (/* @__PURE__ */ new Date()).toISOString(),
    from: senderMobile,
    body: smsBody,
    postcode,
    dates: dateRange,
    people: numPeople,
    nearby: total,
    status: logStatus,
    reply
  });
  return twimlResponse(reply);
}
__name(handleSms, "handleSms");
async function validateTwilioSignature(authToken, url, params, signature) {
  const sortedKeys = Object.keys(params).sort();
  let toSign = url;
  for (const key2 of sortedKeys) {
    toSign += key2 + (params[key2] || "");
  }
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(authToken),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, enc.encode(toSign));
  const expected = btoa(String.fromCharCode(...new Uint8Array(sigBuf)));
  return expected === signature;
}
__name(validateTwilioSignature, "validateTwilioSignature");
function twimlResponse(message) {
  const xml = `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escXml(message)}</Message></Response>`;
  return new Response(xml, {
    headers: { "Content-Type": "text/xml; charset=utf-8" }
  });
}
__name(twimlResponse, "twimlResponse");
function escXml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
__name(escXml, "escXml");
function parseSms(text, { requireMobile = true } = {}) {
  const missing = [];

  const WORD_NUMS = { one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9 };
  const peopleMatch = text.match(/(\d+)\s*(?:men?|man|people?|person|ppl|males?)\b/i)
    || text.match(/\b(one|two|three|four|five|six|seven|eight|nine)\s*(?:men?|man|people?|person|ppl|males?)\b/i);
  const numPeople = peopleMatch ? Math.min(parseInt(peopleMatch[1]) || WORD_NUMS[peopleMatch[1].toLowerCase()] || 0, 9) : null;
  if (!numPeople) missing.push("number of men (e.g. '2 men')");

  const dateMatch = text.match(
    /(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4})\s*(?:[-–—]|to)\s*(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4})/i
  );
  let start = dateMatch ? parseDate(dateMatch[1]) : null;
  let end = dateMatch ? parseDate(dateMatch[2]) : null;
  if (!start || !end) {
    const MON = "jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december";
    const natRe = new RegExp(`(\\d{1,2})(?:st|nd|rd|th)?\\s*(${MON})\\s*(\\d{2,4})?\\s*(?:[-–—]|\\bto\\b|\\btill\\b|\\buntil\\b)\\s*(\\d{1,2})(?:st|nd|rd|th)?\\s*(${MON})\\s*(\\d{2,4})?`, "i");
    const nm = text.match(natRe);
    if (nm) { start = parseNatDate(nm[1], nm[2], nm[3]); end = parseNatDate(nm[4], nm[5], nm[6]); }
  }
  if (!start || !end) {
    // "3-10aug" or "3-10 august 26" — same-month day range
    const MON = "jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december";
    const sameMonRe = new RegExp(`(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:[-–—]|\\bto\\b|\\btill\\b|\\buntil\\b)\\s*(\\d{1,2})(?:st|nd|rd|th)?\\s*(${MON})(?:\\s*(\\d{2,4}))?`, "i");
    const sm = text.match(sameMonRe);
    if (sm) { start = parseNatDate(sm[1], sm[3], sm[4]); end = parseNatDate(sm[2], sm[3], sm[4]); }
  }
  if (!start || !end) missing.push("dates");

  const pcMatch = text.match(/\b([A-Z]{1,2}\d[0-9A-Z]?\s*\d[A-Z]{2})\b/i);
  if (!pcMatch) missing.push("postcode");

  const distMatch = text.match(/(\d+)\s*miles?\b/i);
  const maxMiles = distMatch ? Math.min(parseInt(distMatch[1]), 50) : 15;

  const mobileMatch = text.match(/(?<![\d\/])((?:\+44|0)[0-9]{9,10})(?![\d\/])/i);
  const contactMobile = mobileMatch ? mobileMatch[1].replace(/\s/g, "") : null;
  if (requireMobile && !contactMobile) missing.push("mobile number");

  if (missing.length > 0) return { missing };

  return {
    numPeople,
    start,
    end,
    postcode: pcMatch[1].toUpperCase().trim(),
    maxMiles,
    contactMobile
  };
}
__name(parseSms, "parseSms");
function parseApiDate(s) {
  if (!s) return null;
  const m = String(s).match(/\/Date\((-?\d+)\)\//);
  if (!m) return null;
  return new Date(parseInt(m[1]));
}
__name(parseApiDate, "parseApiDate");
function shortDate(d) {
  if (!d) return "";
  return `${String(d.getUTCDate()).padStart(2,"0")}/${String(d.getUTCMonth()+1).padStart(2,"0")}`;
}
__name(shortDate, "shortDate");
function fmtPhone(p) {
  const s = String(p).trim();
  if (!s) return "";
  if (s.startsWith("+447") || s.startsWith("+44 7")) return `Mob ${s}`;
  if (s.startsWith("07")) return `Mob ${s}`;
  return `Tel: ${s}`;
}
__name(fmtPhone, "fmtPhone");
function overlapDays(aStart, aEnd, bStart, bEnd) {
  if (!aStart || !aEnd || !bStart || !bEnd) return null;
  const oStart = Math.max(aStart.getTime(), bStart.getTime());
  const oEnd   = Math.min(aEnd.getTime(),   bEnd.getTime());
  if (oEnd < oStart) return 0;
  return Math.round((oEnd - oStart) / 864e5) + 1;
}
__name(overlapDays, "overlapDays");
function parseNatDate(day, monthStr, yearStr) {
  const MONTH_MAP = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12 };
  const month = MONTH_MAP[String(monthStr).toLowerCase().slice(0, 3)];
  if (!month) return null;
  let year = yearStr ? parseInt(yearStr) : new Date().getUTCFullYear();
  if (year < 100) year += 2000;
  const date = new Date(Date.UTC(year, month - 1, parseInt(day)));
  return isNaN(date.getTime()) ? null : date;
}
__name(parseNatDate, "parseNatDate");
function parseDate(s) {
  s = s.replace(/[.\-]/g, "/");
  const parts = s.split("/");
  if (parts.length !== 3) return null;
  let [d, m, y] = parts.map(Number);
  if (y < 100) y += 2e3;
  const date = new Date(Date.UTC(y, m - 1, d));
  return isNaN(date.getTime()) ? null : date;
}
__name(parseDate, "parseDate");
function apiDate(d) {
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(2)}`;
}
__name(apiDate, "apiDate");
function displayDate(d) {
  const day = String(d.getUTCDate()).padStart(2, "0");
  const mon = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${day}/${mon}/${String(d.getUTCFullYear()).slice(2)}`;
}
__name(displayDate, "displayDate");
async function geocodePostcode(postcode) {
  const clean = postcode.replace(/\s/g, "").toUpperCase();
  try {
    const resp = await fetch(`https://api.postcodes.io/postcodes/${clean}`);
    const data = await resp.json();
    if (data.status === 200) {
      const r = data.result;
      const parts = [r.admin_ward, r.admin_district, r.admin_county, r.country].filter(Boolean);
      const address = (parts.length ? parts.join(", ") + ", " : "") + postcode.toUpperCase() + ", UK";
      return { lat: r.latitude, lng: r.longitude, address };
    }
  } catch (_) {
  }
  return null;
}
__name(geocodePostcode, "geocodePostcode");
async function getDrivingDistancesOSRM(originLat, originLng, destinations) {
  const valid = destinations.map((d, i) => ({ i, lat: d.lat, lng: d.lng })).filter((d) => d.lat && d.lng);
  if (!valid.length) return destinations.map(() => null);
  try {
    const coords = [
      `${originLng},${originLat}`,
      ...valid.map((d) => `${d.lng},${d.lat}`)
    ].join(";");
    const resp = await fetch(
      `https://router.project-osrm.org/table/v1/driving/${coords}?sources=0&annotations=duration,distance`,
      { signal: AbortSignal.timeout(6e3) }
    );
    const data = await resp.json();
    const rawDist = ((data.distances || [[]])[0] || []).slice(1);
    const rawDur  = ((data.durations || [[]])[0] || []).slice(1);
    const result = destinations.map(() => null);
    valid.forEach((d, j) => {
      const miles = rawDist[j] != null ? rawDist[j] / 1609.34 : null;
      const minutes = rawDur[j] != null ? rawDur[j] / 60 : null;
      result[d.i] = { miles, minutes };
    });
    return result;
  } catch (e) {
    console.error("OSRM error:", e);
    return destinations.map(() => null);
  }
}
__name(getDrivingDistancesOSRM, "getDrivingDistancesOSRM");
function extractSetCookies(headers) {
  const cookies = {};
  const list = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : headers.get("set-cookie") ? [headers.get("set-cookie")] : [];
  for (const raw of list) {
    const pair = raw.split(";")[0];
    const eqIdx = pair.indexOf("=");
    if (eqIdx > 0) {
      cookies[pair.slice(0, eqIdx).trim()] = pair.slice(eqIdx + 1).trim();
    }
  }
  return cookies;
}
__name(extractSetCookies, "extractSetCookies");
function cookieHeader(cookieObj) {
  return Object.entries(cookieObj).map(([k, v]) => `${k}=${v}`).join("; ");
}
__name(cookieHeader, "cookieHeader");
async function loginToSite(email, password) {
  const homeResp = await fetch(BASE_URL, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; FindAMinyanBot/1.0)" },
    redirect: "follow"
  });
  let cookies = extractSetCookies(homeResp.headers);
  const loginResp = await fetch(`${BASE_URL}/LogIn`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Requested-With": "XMLHttpRequest",
      "Cookie": cookieHeader(cookies),
      "Referer": BASE_URL
    },
    body: new URLSearchParams({ email, password }),
    redirect: "follow"
  });
  cookies = { ...cookies, ...extractSetCookies(loginResp.headers) };
  const text = await loginResp.text();
  if (["1", "2", "3"].includes(text.trim())) return null;
  return cookies;
}
__name(loginToSite, "loginToSite");
async function addLocation(cookies, postcode, numPeople, start, end, lat, lng, address, mobile, email) {
  const resp = await fetch(`${BASE_URL}/Member/UpdateLocation`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Requested-With": "XMLHttpRequest",
      "Cookie": cookieHeader(cookies),
      "Referer": `${BASE_URL}/AddNew`
    },
    body: new URLSearchParams({
      LocationType: "1",
      Postcode: postcode.toUpperCase(),
      NumberOfPeople: String(numPeople),
      Mobile: mobile,
      Email: email || "",
      StartDate: apiDate(start),
      EndDate: apiDate(end),
      Name: "",
      Address: address,
      Contact: "",
      Latitude: String(lat),
      Longitude: String(lng)
    })
  });
  return resp.text();
}
__name(addLocation, "addLocation");
async function searchNearby(cookies, lat, lng, start, end, distance) {
  const qs = new URLSearchParams({
    from: apiDate(start),
    to: apiDate(end),
    lat: String(lat),
    lng: String(lng),
    address: `${lat},${lng}`,
    distance: String(distance)
  });
  const resp = await fetch(`${BASE_URL}/Home/GetTimeLineData?${qs}`, {
    headers: {
      "X-Requested-With": "XMLHttpRequest",
      "Cookie": cookieHeader(cookies),
      "Referer": `${BASE_URL}/Member`
    }
  });
  return resp.json();
}
__name(searchNearby, "searchNearby");
function normalizePhone(p) {
  p = String(p || "").replace(/[\s\-\.\(\)]/g, "");
  if (p.startsWith("+44")) return "0" + p.slice(3);
  if (p.startsWith("0044")) return "0" + p.slice(4);
  return p;
}
__name(normalizePhone, "normalizePhone");
function countPeopleNearby(data, searchStart, searchEnd) {
  let total = 0;
  const entries = [];
  for (const loc of data.timeLineData || []) {
    if (loc.LocationType === 4 || loc.LocationType === 2) continue; // skip user-pin and shuls
    const n = parseInt(loc.NumberOfPeople) || 0;
    if (n <= 0) continue;
    // Use our own date overlap rather than the site's Here array (Here can be wrong)
    const entryStart = parseApiDate(loc.StartDate);
    const entryEnd   = parseApiDate(loc.EndDate);
    let present;
    if (entryStart && entryEnd && searchStart && searchEnd) {
      present = entryStart <= searchEnd && entryEnd >= searchStart;
    } else {
      present = (loc.Here || []).some((h) => h === true); // fallback
    }
    if (!present) continue;
    total += n;
    entries.push({
      postcode: (loc.Postcode || "").replace(/&nbsp;/g, " ").trim(),
      people: n,
      phone: loc.Mobile || loc.Contact || "",
      email: loc.Email || "",
      lat: parseFloat(loc.Latitude) || null,
      lng: parseFloat(loc.Longitude) || null,
      startDate: loc.StartDate || "",
      endDate: loc.EndDate || ""
    });
  }
  return { total, entries };
}
__name(countPeopleNearby, "countPeopleNearby");
async function notifyAdmin(env, total, postcode, start, end, entries, requesterNumber) {
  const lines = [
    `MINYAN ALERT: ${total} near ${postcode} ${displayDate(start)}-${displayDate(end)}`,
    `Req: ${requesterNumber}`,
    ...entries.slice(0, 8).map((e) => {
      const contact = e.phone || e.email || "no contact";
      const dist = e.driveMinutes != null ? ` (${Math.round(e.driveMinutes)}min)` : "";
      const manmen = e.people === 1 ? "1 man" : `${e.people} men`;
      return `- ${manmen} ${e.postcode}${dist} ${contact}`;
    })
  ];
  await sendSms(
    env.TWILIO_ACCOUNT_SID,
    env.TWILIO_AUTH_TOKEN,
    env.TWILIO_FROM_NUMBER,
    env.ADMIN_PHONE,
    lines.join("\n")
  );
}
__name(notifyAdmin, "notifyAdmin");
async function sendSms(accountSid, authToken, from, to, body) {
  await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
    {
      method: "POST",
      headers: {
        "Authorization": "Basic " + btoa(`${accountSid}:${authToken}`),
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({ From: from, To: to, Body: body })
    }
  );
}
__name(sendSms, "sendSms");
async function writeLog(env, entry) {
  try {
    const raw = await env.LOGS.get("entries");
    const logs = raw ? JSON.parse(raw) : [];
    logs.unshift(entry);
    if (logs.length > 100) logs.length = 100;
    await env.LOGS.put("entries", JSON.stringify(logs));
  } catch (e) {
    console.error("KV write failed:", e);
  }
}
__name(writeLog, "writeLog");
async function handleLogsPage(request, env) {
  const url = new URL(request.url);
  const provided = url.searchParams.get("key") || "";
  const secret = env.LOGS_PASSWORD || "";
  if (!secret || provided !== secret) {
    return new Response(
      '<!DOCTYPE html><html><body style="font-family:sans-serif;padding:2rem"><h2>Access denied</h2><p>Add <code>?key=YOUR_PASSWORD</code> to the URL.</p></body></html>',
      { status: 403, headers: { "Content-Type": "text/html" } }
    );
  }
  const raw = await env.LOGS.get("entries");
  const logs = raw ? JSON.parse(raw) : [];
  const smsSegments = (text) => {
    if (!text) return 0;
    const len = text.length;
    return len <= 160 ? 1 : Math.ceil(len / 153);
  };
  const smsCost = (reply) => {
    const segs = smsSegments(reply);
    return segs * 0.04232 + 0.00567; // £0.04232/outbound segment + £0.00567 inbound
  };
  let totalCost = 0;
  const rows = logs.map((l) => {
    const isPending = l.status === "DUPLICATE \u2014 PENDING";
    const statusColour = l.status.includes("MINYAN") ? "#16a34a" : isPending ? "#7c3aed" : l.status.includes("DUPLICATE") ? "#6b7280" : "#b45309";
    const statusCell = isPending && l.id ? `<a href="/review?id=${encodeURIComponent(l.id)}&key=${encodeURIComponent(secret)}" style="color:#7c3aed;font-weight:600;text-decoration:underline">${escHtml(l.status)} \u2014 Review</a>` : `<span style="color:${statusColour};font-weight:600">${escHtml(l.status)}</span>`;
    const replyCell = l.reply ? `<details><summary style="cursor:pointer;color:#1e3a5f">View SMS</summary><pre style="margin:.4rem 0 0;white-space:pre-wrap;font-size:.8rem;max-width:320px">${escHtml(l.reply)}</pre></details>` : "\u2014";
    const cost = smsCost(l.reply);
    const segs = smsSegments(l.reply);
    totalCost += cost;
    return `<tr>
      <td>${new Date(l.time).toLocaleString("en-GB", { timeZone: "Europe/London" })}</td>
      <td>${escHtml(l.from)}</td>
      <td>${escHtml(l.postcode)}</td>
      <td>${escHtml(l.dates)}</td>
      <td style="text-align:center">${l.people}</td>
      <td style="text-align:center">${l.nearby}</td>
      <td>${statusCell}</td>
      <td>${replyCell}</td>
      <td style="text-align:right;white-space:nowrap">£${cost.toFixed(2)}<br><span style="color:#6b7280;font-size:.75rem">${segs} seg</span></td>
    </tr>`;
  }).join("");
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>FindAMinyan Bot \u2014 Logs</title>
  <style>
    body { font-family: sans-serif; padding: 1.5rem; background: #f9fafb; color: #111; }
    h1   { font-size: 1.4rem; margin-bottom: 1rem; }
    table { border-collapse: collapse; width: 100%; background: #fff;
            box-shadow: 0 1px 4px rgba(0,0,0,.1); border-radius: 8px; overflow: hidden; }
    th   { background: #1e3a5f; color: #fff; padding: .6rem 1rem; text-align: left; font-size: .85rem; }
    td   { padding: .55rem 1rem; font-size: .85rem; border-bottom: 1px solid #e5e7eb; }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: #f0f4ff; }
    .empty { padding: 2rem; text-align: center; color: #6b7280; }
  </style>
</head>
<body>
  <h1>FindAMinyan Bot \u2014 Request Log</h1>
  <p style="color:#6b7280;font-size:.85rem">Showing last ${logs.length} requests \xB7 newest first \xB7 
     <a href="?key=${encodeURIComponent(secret)}">Refresh</a></p>
  <table>
    <thead><tr>
      <th>Time (UK)</th><th>From</th><th>Postcode</th>
      <th>Dates</th><th># Sent</th><th># Nearby</th><th>Result</th><th>Reply</th><th>Est. Cost</th>
    </tr></thead>
    <tbody>${rows || '<tr><td colspan="9" class="empty">No requests yet</td></tr>'}
    ${logs.length ? `<tr style="background:#f0f4ff;font-weight:600">
      <td colspan="8" style="text-align:right;padding:.6rem 1rem">Total estimated cost (${logs.length} SMS):</td>
      <td style="text-align:right;padding:.6rem 1rem;white-space:nowrap">£${totalCost.toFixed(2)}</td>
    </tr>` : ""}</tbody>
  </table>
</body>
</html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}
__name(handleLogsPage, "handleLogsPage");
async function handleReview(request, env) {
  const url = new URL(request.url);
  const provided = url.searchParams.get("key") || "";
  const secret = env.LOGS_PASSWORD || "";
  if (!secret || provided !== secret) {
    return new Response("Forbidden", { status: 403, headers: { "Content-Type": "text/plain" } });
  }
  if (request.method === "POST") {
    const body = await request.text();
    const params = Object.fromEntries(new URLSearchParams(body));
    const id2 = params.id || "";
    const action = params.action || "";
    const raw2 = await env.LOGS.get("entries");
    const logs2 = raw2 ? JSON.parse(raw2) : [];
    const idx = logs2.findIndex((l) => l.id === id2);
    if (idx === -1) {
      return new Response("Entry not found", { status: 404 });
    }
    const entry2 = logs2[idx];
    if (action === "approve") {
      try {
        const cookies = await loginToSite(env.FINDAMINYAN_EMAIL, env.FINDAMINYAN_PASSWORD);
        if (cookies) {
          const start = new Date(entry2.startIso);
          const end = new Date(entry2.endIso);
          await addLocation(
            cookies,
            entry2.postcode,
            entry2.people,
            start,
            end,
            entry2.lat,
            entry2.lng,
            entry2.address,
            entry2.mobile,
            env.FINDAMINYAN_EMAIL
          );
        }
      } catch (e) {
        console.error("Review approve error:", e);
      }
      logs2[idx] = { ...entry2, status: "VERIFIED \u2014 ADDED" };
    } else if (action === "reject") {
      logs2[idx] = { ...entry2, status: "DUPLICATE \u2014 REJECTED" };
    }
    await env.LOGS.put("entries", JSON.stringify(logs2));
    return new Response(null, {
      status: 302,
      headers: { Location: `/logs?key=${encodeURIComponent(secret)}` }
    });
  }
  const id = url.searchParams.get("id") || "";
  const raw = await env.LOGS.get("entries");
  const logs = raw ? JSON.parse(raw) : [];
  const entry = logs.find((l) => l.id === id);
  if (!entry) {
    return new Response("Entry not found", { status: 404 });
  }
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Review Request \u2014 FindAMinyan Bot</title>
  <style>
    body  { font-family: sans-serif; padding: 2rem; background: #f9fafb; color: #111; max-width: 600px; margin: 0 auto; }
    h1    { font-size: 1.3rem; margin-bottom: 1.5rem; }
    table { border-collapse: collapse; width: 100%; margin-bottom: 1.5rem; background:#fff;
            box-shadow: 0 1px 4px rgba(0,0,0,.1); border-radius: 8px; overflow:hidden; }
    th    { background: #1e3a5f; color:#fff; padding: .5rem .9rem; text-align:left; font-size:.85rem; }
    td    { padding: .5rem .9rem; font-size:.85rem; border-bottom:1px solid #e5e7eb; }
    .btn  { display:inline-block; padding:.6rem 1.4rem; border:none; border-radius:6px;
            font-size:.95rem; cursor:pointer; color:#fff; margin-right:.75rem; }
    .approve { background:#16a34a; }
    .reject  { background:#b91c1c; }
    .back    { display:inline-block; margin-top:1rem; font-size:.85rem; color:#1e3a5f; }
    .status  { font-weight:600; color:#7c3aed; }
  </style>
</head>
<body>
  <h1>Review Pending Request</h1>
  <table>
    <tr><th>Field</th><th>Value</th></tr>
    <tr><td>Received</td><td>${new Date(entry.time).toLocaleString("en-GB", { timeZone: "Europe/London" })}</td></tr>
    <tr><td>From (mobile)</td><td>${escHtml(entry.from)}</td></tr>
    <tr><td>Original SMS</td><td>${escHtml(entry.body)}</td></tr>
    <tr><td>Postcode</td><td>${escHtml(entry.postcode)}</td></tr>
    <tr><td>Dates</td><td>${escHtml(entry.dates)}</td></tr>
    <tr><td># People</td><td>${entry.people}</td></tr>
    <tr><td>Status</td><td class="status">${escHtml(entry.status)}</td></tr>
  </table>

  <form method="POST" action="/review?key=${encodeURIComponent(secret)}">
    <input type="hidden" name="id" value="${escHtml(id)}">
    <button class="btn approve" name="action" value="approve">Details verified \u2014 Add data</button>
    <button class="btn reject"  name="action" value="reject">Duplicate \u2014 Do not add</button>
  </form>

  <a class="back" href="/logs?key=${encodeURIComponent(secret)}">&larr; Back to logs</a>
</body>
</html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}
__name(handleReview, "handleReview");
async function handleApiTest(request, env) {
  const url = new URL(request.url);
  const provided = url.searchParams.get("key") || "";
  const secret = env.LOGS_PASSWORD || "";
  if (!secret || provided !== secret) return new Response("Forbidden", { status: 403 });
  const postcode = (url.searchParams.get("postcode") || "M1 1AE").trim();
  const geoResp = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(postcode)}`);
  const geoData = await geoResp.json();
  if (!geoData.result) return new Response(JSON.stringify(geoData), { status: 400, headers: { "Content-Type": "application/json" } });
  const { latitude: lat, longitude: lng } = geoData.result;
  const cookies = await loginToSite(env.FINDAMINYAN_EMAIL, env.FINDAMINYAN_PASSWORD);
  const today = new Date();
  const start = new Date(today); start.setDate(today.getDate() - 7);
  const end = new Date(today); end.setDate(today.getDate() + 60);
  const raw = await searchNearby(cookies, lat, lng, start, end, 50);
  return new Response(JSON.stringify(raw, null, 2), { headers: { "Content-Type": "application/json" } });
}
__name(handleApiTest, "handleApiTest");
async function handleSafelist(request, env) {
  const url = new URL(request.url);
  const provided = url.searchParams.get("key") || "";
  const secret = env.LOGS_PASSWORD || "";
  if (!secret || provided !== secret) {
    return new Response("Forbidden", { status: 403 });
  }
  const number = url.searchParams.get("number") || "";
  if (!number) {
    return new Response(
      `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:2rem">
        <h2>Add to Twilio Safe List</h2>
        <form method="GET">
          <input type="hidden" name="key" value="${escHtml(provided)}">
          <label>Phone number (E.164, e.g. +447341454514):<br>
          <input name="number" style="width:260px;padding:.4rem;margin:.5rem 0" placeholder="+447341454514"></label><br>
          <button type="submit" style="padding:.5rem 1.2rem;background:#1e3a5f;color:#fff;border:none;border-radius:6px;cursor:pointer">Add to Safe List</button>
        </form>
      </body></html>`,
      { status: 200, headers: { "Content-Type": "text/html" } }
    );
  }
  const resp = await fetch("https://accounts.twilio.com/v1/SafeList/Numbers", {
    method: "POST",
    headers: {
      "Authorization": "Basic " + btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`),
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({ PhoneNumber: number })
  });
  const body = await resp.json();
  const ok = resp.status === 200 || resp.status === 201;
  return new Response(
    `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:2rem">
      <h2>${ok ? "✓ Added to Safe List" : "Error"}</h2>
      <p>${ok ? `${escHtml(number)} will no longer be blocked by SMS Pumping Protection.` : escHtml(JSON.stringify(body))}</p>
      <p><a href="/safelist?key=${encodeURIComponent(provided)}">Add another</a> &nbsp;|&nbsp; <a href="/logs?key=${encodeURIComponent(provided)}">Back to logs</a></p>
    </body></html>`,
    { status: ok ? 200 : 400, headers: { "Content-Type": "text/html" } }
  );
}
__name(handleSafelist, "handleSafelist");
function escHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
__name(escHtml, "escHtml");
export {
  worker_default as default
};
//# sourceMappingURL=worker.js.map
