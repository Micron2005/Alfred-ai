#!/usr/bin/env node
/**
 * Mirror of detectCancelIntent + youtubeSearchUrl from
 * ChatWindow.tsx / lib/desktop.ts. Run as a regression guard
 * when changing either:
 *
 *   node alfred-web/scripts/test-intents.mjs
 *
 * Exits non-zero on failure so it can be wired into CI later.
 */

function detectCancelIntent(raw) {
  const text = raw.trim().toLowerCase().replace(/[.?!,]+$/, "");
  if (!text) return false;
  const stripped = text
    .replace(/^(?:hey\s+|ok\s+)?alfred[,\s]+/, "")
    .replace(/[,\s]+alfred[.,!?\s]*$/, "")
    .replace(/[,.!?]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!stripped) return false;
  if (stripped.split(/\s+/).length > 6) return false;
  const patterns = [
    /^(?:stop|shh|shush|shut\s+up|be\s+quiet|silence|enough|cancel(?:\s+that)?|nevermind|never\s*mind|wait|hold\s+on|pause|quiet)$/,
    /^(?:stop\s+(?:talking|speaking|it))$/,
    /^(?:that[' ]?s\s+enough)$/,
    /^(?:i\s+got\s+it)$/,
    /^(?:cut\s+it(?:\s+out)?)$/,
    /^(?:knock\s+it\s+off)$/,
    /^(?:zip\s+it)$/,
    /^(?:hush(?:\s+(?:up|now))?)$/,
    /^(?:quit\s+(?:it|talking))$/,
    /^(?:can\s+it)$/,
  ];
  return patterns.some((rx) => rx.test(stripped));
}

function youtubeSearchUrl(query) {
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&autoplay=1`;
}

function detectMyLocationIntent(raw) {
  const text = raw.trim();
  if (!text) return false;
  const stripped = text
    .toLowerCase()
    .replace(/[.?!]+$/, "")
    .replace(/^(?:hey\s+|ok\s+)?alfred[,\s]+/, "")
    .replace(/[,\s]+alfred[.,!?\s]*$/, "")
    .trim();
  if (!stripped) return false;
  if (stripped.split(/\s+/).length > 10) return false;
  const patterns = [
    /^(?:where\s+am\s+i|where\s+(?:am\s+)?i\s+(?:right\s+)?now)(?:\s+on\s+(?:the\s+)?(?:map|earth|globe|hologram))?$/,
    /^(?:show|pull\s+up|bring\s+up|track|find|locate|put\s+up|open|fly\s+to|zoom\s+to|where(?:'s|\s+is))\s+(?:me\s+)?(?:up\s+)?(?:my\s+)?(?:current\s+)?location(?:\s+on\s+(?:the\s+)?(?:map|earth|globe|hologram))?$/,
    /^(?:where\s+is\s+(?:my\s+)?(?:phone|iphone)|locate\s+(?:my\s+)?(?:phone|iphone))$/,
    /^(?:show\s+me\s+on\s+(?:the\s+)?(?:map|earth|globe)|put\s+me\s+on\s+(?:the\s+)?(?:map|earth|globe))$/,
    /^(?:show\s+me\s+(?:where\s+i\s+am|my\s+position)|find\s+me)(?:\s+on\s+(?:the\s+)?(?:map|earth|globe|hologram))?$/,
    /^(?:locate\s+me|center\s+(?:the\s+)?(?:earth|map|globe)\s+on\s+me)$/,
    /^(?:pull\s+up|put\s+up)\s+(?:the\s+)?(?:earth|map|globe)\s+(?:on|at|to)\s+my\s+location$/,
  ];
  return patterns.some((rx) => rx.test(stripped));
}

// ─── Valhalla routing intents ─────────────────────────────────────

function detectRouteIntent(raw) {
  const text = raw.trim();
  if (!text) return null;
  const stripped = text
    .toLowerCase()
    .replace(/[.?!]+$/, "")
    .replace(/^(?:hey\s+|ok\s+)?alfred[,\s]+/, "")
    .replace(/[,\s]+alfred[.,!?\s]*$/, "")
    .trim();
  if (!stripped) return null;
  if (stripped.split(/\s+/).length > 18) return null;
  let costing = "auto";
  let s = stripped;
  if (/\b(?:walking|on\s+foot|by\s+foot|pedestrian)\b/.test(stripped)) {
    costing = "pedestrian";
    s = stripped.replace(/\b(?:walking|on\s+foot|by\s+foot|pedestrian)\b/g, "");
  } else if (/\b(?:cycling|by\s+bike|biking|on\s+a\s+bike|on\s+my\s+bike|by\s+bicycle)\b/.test(stripped)) {
    costing = "bicycle";
    s = stripped.replace(/\b(?:cycling|by\s+bike|biking|on\s+a\s+bike|on\s+my\s+bike|by\s+bicycle)\b/g, "");
  } else if (/\b(?:by\s+motorcycle|on\s+my\s+motorcycle)\b/.test(stripped)) {
    costing = "motorcycle";
    s = stripped.replace(/\b(?:by\s+motorcycle|on\s+my\s+motorcycle)\b/g, "");
  }
  s = s.replace(/\s+/g, " ").trim();
  const patterns = [
    /^(?:route|navigate|drive|plot(?:\s+a\s+course)?|chart(?:\s+a\s+course)?|set(?:\s+a)?\s+course|take|get|guide|direct|walk|bike|cycle|ride)\s+(?:me\s+|us\s+)?(?:to|toward|towards)\s+(.+)$/i,
    /^(?:directions|route)\s+(?:from\s+here\s+)?to\s+(.+)$/i,
    /^(?:how\s+(?:do\s+i|to)\s+get\s+(?:to|from\s+here\s+to))\s+(.+)$/i,
    /^(?:show\s+me|give\s+me)\s+(?:a\s+|the\s+)?(?:route|directions|way)\s+to\s+(.+)$/i,
  ];
  for (const rx of patterns) {
    const m = s.match(rx);
    if (m && m[1]) {
      const dest = m[1].replace(/^(?:a\s+|the\s+)/, "").replace(/\s+please$/, "").trim();
      if (dest.length >= 2 && dest.length <= 200) {
        let c = costing;
        const verb = s.match(/^(\w+)/)?.[1] ?? "";
        if (c === "auto") {
          if (verb === "walk") c = "pedestrian";
          else if (verb === "bike" || verb === "cycle" || verb === "ride") c = "bicycle";
        }
        return { destination: dest, costing: c };
      }
    }
  }
  return null;
}

function detectIsochroneIntent(raw) {
  const text = raw.trim();
  if (!text) return null;
  const stripped = text
    .toLowerCase()
    .replace(/[.?!]+$/, "")
    .replace(/^(?:hey\s+|ok\s+)?alfred[,\s]+/, "")
    .replace(/[,\s]+alfred[.,!?\s]*$/, "")
    .trim();
  if (!stripped) return null;
  if (stripped.split(/\s+/).length > 16) return null;
  const minMatch = stripped.match(/(\d{1,3})\s*(?:minute|minutes|min|mins)\b/);
  if (!minMatch) return null;
  const minutes = parseInt(minMatch[1], 10);
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 180) return null;
  let costing = "auto";
  if (/\b(?:walk|walking|on\s+foot|pedestrian)\b/.test(stripped)) costing = "pedestrian";
  else if (/\b(?:cycle|cycling|bike|biking|bicycle)\b/.test(stripped)) costing = "bicycle";
  const patterns = [
    /\b(?:what|where)\s+(?:can\s+(?:i|we)\s+(?:reach|get\s+to|travel\s+to)|is\s+within)\b/,
    /\b(?:show\s+me\s+)?(?:every\s*(?:where|place)|the\s+area)\s+(?:within|reachable\s+in)\b/,
    /\b(?:isochrone|reachability)\b/,
    /\b(?:within|in\s+a)\s+\d{1,3}\s*(?:minute|minutes|min|mins)\b/,
  ];
  if (!patterns.some((rx) => rx.test(stripped))) return null;
  return { minutes, costing };
}

function detectClearRouteIntent(raw) {
  const text = raw.trim().toLowerCase().replace(/[.?!]+$/, "");
  if (!text) return false;
  const stripped = text
    .replace(/^(?:hey\s+|ok\s+)?alfred[,\s]+/, "")
    .replace(/[,\s]+alfred[.,!?\s]*$/, "")
    .trim();
  if (!stripped) return false;
  if (stripped.split(/\s+/).length > 8) return false;
  return /^(?:clear|wipe|remove|delete|hide|erase|dismiss|cancel)\s+(?:the\s+|my\s+)?(?:route|path|directions|line|trip|course|isochrone|reachability)$/i.test(stripped);
}

function decodePolyline6(encoded) {
  let index = 0, lat = 0, lon = 0;
  const coords = [];
  while (index < encoded.length) {
    let result = 0, shift = 0, b;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;
    result = 0; shift = 0;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lon += result & 1 ? ~(result >> 1) : result >> 1;
    coords.push([lon / 1e6, lat / 1e6]);
  }
  return coords;
}

const wantCancel = [
  "stop", "Stop.", "stop talking", "Stop talking!", "stop it",
  "Stop speaking", "Shut up", "Alfred, shut up", "be quiet",
  "Be quiet, Alfred", "Alfred be quiet", "cut it", "cut it out",
  "enough", "that's enough", "Alfred, that's enough", "knock it off",
  "hush", "Hush, Alfred", "hush up", "hush now", "zip it", "quiet",
  "can it", "quit it", "quit talking", "pause", "hold on", "wait",
  "cancel", "Cancel that",
];

const wantPassThrough = [
  "hello", "hi alfred", "what's the weather",
  "tell me a joke", "play iron man on youtube",
  "search for cookies", "go to chat",
  "stop being so helpful and tell me the truth",
  "shut the door",
];

let failed = 0;
for (const t of wantCancel) {
  if (!detectCancelIntent(t)) {
    console.log("FAIL: should cancel:", JSON.stringify(t));
    failed++;
  }
}
for (const t of wantPassThrough) {
  if (detectCancelIntent(t)) {
    console.log("FAIL: should NOT cancel:", JSON.stringify(t));
    failed++;
  }
}

// YouTube URL always carries the autoplay flag — even though
// YouTube ignores it on the search-results page, we want the
// flag present so that when (a) the user pastes the URL into
// the URL bar of a tab already playing YouTube, or (b) future
// YouTube clients honour it, the first result starts playing.
const ytUrl = youtubeSearchUrl("iron man mark 50 reveal");
if (!ytUrl.includes("autoplay=1")) {
  console.log("FAIL: youtubeSearchUrl missing autoplay=1:", ytUrl);
  failed++;
}
if (!ytUrl.startsWith("https://www.youtube.com/results?search_query=")) {
  console.log("FAIL: youtubeSearchUrl wrong prefix:", ytUrl);
  failed++;
}

// "My location" intent — voice-driven "pull up my location" hits the
// browser's Geolocation API and re-fires openEarth with the GPS fix.
const wantLocation = [
  "pull up my location",
  "Alfred, pull up my location",
  "Show me my location",
  "show me my current location",
  "find my location",
  "find me",
  "where am I",
  "where am I on the map",
  "Where am I, Alfred",
  "where am I right now",
  "show me where I am",
  "show me my position",
  "locate me",
  "Alfred, locate me",
  "fly to my location",
  "zoom to my location",
  "track my location",
  "show me on the map",
  "put me on the globe",
  "where is my phone",
  "locate my iphone",
  "pull up the earth at my location",
  "put up the map on my location",
];

// These must NOT match — they belong to other intents (earth, chat
// fall-through, etc.).
const wantNotLocation = [
  "show me Tokyo",
  "show me the earth",
  "pull up the earth",
  "what's the weather",
  "open chat",
  "hello",
  "tell me where I left my keys yesterday on the desk",
];

for (const t of wantLocation) {
  if (!detectMyLocationIntent(t)) {
    console.log("FAIL: should match location:", JSON.stringify(t));
    failed++;
  }
}
for (const t of wantNotLocation) {
  if (detectMyLocationIntent(t)) {
    console.log("FAIL: should NOT match location:", JSON.stringify(t));
    failed++;
  }
}

// ─── Valhalla routing intents ─────────────────────────────────────

const routeWant = [
  ["route me to JFK Airport", "jfk airport", "auto"],
  ["Alfred, route me to JFK", "jfk", "auto"],
  ["navigate to Whole Foods", "whole foods", "auto"],
  ["directions to Times Square", "times square", "auto"],
  ["how do I get to the airport", "airport", "auto"],
  ["plot a course to Boston", "boston", "auto"],
  ["plot a course to Boston by bike", "boston", "bicycle"],
  ["chart a course to Atlantic City", "atlantic city", "auto"],
  ["set a course to Tokyo", "tokyo", "auto"],
  ["take me to the nearest coffee shop", "nearest coffee shop", "auto"],
  ["show me a route to LaGuardia", "laguardia", "auto"],
  ["give me directions to Penn Station", "penn station", "auto"],
  ["route to JFK Airport", "jfk airport", "auto"],
  ["walk me to the gym", "gym", "pedestrian"],
  ["bike me to the park", "park", "bicycle"],
  ["route me to the park walking", "park", "pedestrian"],
];
const routeDont = [
  "hello",
  "what's the weather",
  "go to chat",
  "show me Tokyo",
  "where am I",
  "play iron man on youtube",
];

for (const [t, dest, c] of routeWant) {
  const r = detectRouteIntent(t);
  if (!r) {
    console.log("FAIL: should match route:", JSON.stringify(t));
    failed++;
    continue;
  }
  if (r.destination.toLowerCase() !== dest.toLowerCase()) {
    console.log(
      "FAIL: route dest:", JSON.stringify(t), "->",
      r.destination, "want", dest,
    );
    failed++;
  }
  if (r.costing !== c) {
    console.log(
      "FAIL: route costing:", JSON.stringify(t), "->",
      r.costing, "want", c,
    );
    failed++;
  }
}
for (const t of routeDont) {
  if (detectRouteIntent(t)) {
    console.log("FAIL: should NOT match route:", JSON.stringify(t));
    failed++;
  }
}

const isoWant = [
  ["what can I reach in 15 minutes", 15, "auto"],
  ["where can I get to in 10 minutes walking", 10, "pedestrian"],
  ["show me every place reachable in 30 minutes", 30, "auto"],
  ["isochrone 25 minutes biking", 25, "bicycle"],
  ["reachability within 15 minutes", 15, "auto"],
  ["where can we travel to in 45 minutes", 45, "auto"],
];
const isoDont = ["hello", "set a 15 minute timer", "what's the weather"];

for (const [t, mins, c] of isoWant) {
  const r = detectIsochroneIntent(t);
  if (!r) {
    console.log("FAIL: should match iso:", JSON.stringify(t));
    failed++;
    continue;
  }
  if (r.minutes !== mins) {
    console.log("FAIL: iso minutes:", JSON.stringify(t), "->", r.minutes, "want", mins);
    failed++;
  }
  if (r.costing !== c) {
    console.log("FAIL: iso costing:", JSON.stringify(t), "->", r.costing, "want", c);
    failed++;
  }
}
for (const t of isoDont) {
  if (detectIsochroneIntent(t)) {
    console.log("FAIL: should NOT match iso:", JSON.stringify(t));
    failed++;
  }
}

const clearWant = [
  "clear the route",
  "Alfred, clear the route",
  "wipe the route",
  "remove the route",
  "hide the path",
  "clear the line",
  "delete the directions",
  "clear my route",
  "clear the isochrone",
  "cancel the trip",
  "dismiss the course",
];
const clearDont = ["clear", "hello", "wipe my disk"];

for (const t of clearWant) {
  if (!detectClearRouteIntent(t)) {
    console.log("FAIL: should match clear:", JSON.stringify(t));
    failed++;
  }
}
for (const t of clearDont) {
  if (detectClearRouteIntent(t)) {
    console.log("FAIL: should NOT match clear:", JSON.stringify(t));
    failed++;
  }
}

// ─── polyline6 decoder round-trip ─────────────────────────────────

function encodePolyline6(coords) {
  let prevLat = 0, prevLon = 0, out = "";
  function enc(n) {
    n = n < 0 ? ~(n << 1) : n << 1;
    while (n >= 0x20) {
      out += String.fromCharCode((0x20 | (n & 0x1f)) + 63);
      n >>= 5;
    }
    out += String.fromCharCode(n + 63);
  }
  for (const [lon, lat] of coords) {
    const lat6 = Math.round(lat * 1e6);
    const lon6 = Math.round(lon * 1e6);
    enc(lat6 - prevLat);
    enc(lon6 - prevLon);
    prevLat = lat6;
    prevLon = lon6;
  }
  return out;
}

const polyTest = [
  [-73.9864, 40.7486],
  [-73.9352, 40.7306],
  [-74.006, 40.7128],
];
const polyEnc = encodePolyline6(polyTest);
const polyDec = decodePolyline6(polyEnc);
let polyOk = polyTest.length === polyDec.length;
if (polyOk) {
  for (let i = 0; i < polyTest.length; i++) {
    if (
      Math.abs(polyTest[i][0] - polyDec[i][0]) > 1e-5 ||
      Math.abs(polyTest[i][1] - polyDec[i][1]) > 1e-5
    ) {
      polyOk = false;
      break;
    }
  }
}
if (!polyOk) {
  console.log("FAIL: polyline6 round-trip");
  failed++;
}

if (failed) {
  console.error(`${failed} INTENT TESTS FAILED`);
  process.exit(1);
}
console.log(
  `OK · ${wantCancel.length + wantPassThrough.length} cancel · ${wantLocation.length + wantNotLocation.length} location · ${routeWant.length + routeDont.length} route · ${isoWant.length + isoDont.length} isochrone · ${clearWant.length + clearDont.length} clear-route · polyline6 roundtrip · 2 youtubeSearchUrl · ALL PASS`,
);
