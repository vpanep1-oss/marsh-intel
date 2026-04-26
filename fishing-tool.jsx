import { useState, useEffect, useRef } from "react";
import L from "leaflet";
import { auth, provider, db } from "./firebase.js";
import { signInWithPopup, signOut, onAuthStateChanged } from "firebase/auth";
import { collection, doc, setDoc, getDoc, getDocs, deleteDoc, query, orderBy, limit } from "firebase/firestore";

// ─── CONSTANTS ───────────────────────────────────────────────────────────────
const WIND_DIRS = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];

const WIND_DIR_DEG = { N:0, NNE:22.5, NE:45, ENE:67.5, E:90, ESE:112.5, SE:135, SSE:157.5, S:180, SSW:202.5, SW:225, WSW:247.5, W:270, WNW:292.5, NW:315, NNW:337.5 };

const cap = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : "";

// Accepts HH:MM, HHMM, HMM — always returns "HH:MM" (24-hr) or null
function parseTimeInput(raw) {
  const s = (raw || "").trim().replace(/\s/g, "");
  const withColon = s.match(/^(\d{1,2}):(\d{2})$/);
  if (withColon) {
    const h = parseInt(withColon[1], 10), m = parseInt(withColon[2], 10);
    if (h < 24 && m < 60) return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}`;
  }
  const plain4 = s.match(/^(\d{2})(\d{2})$/);
  if (plain4) {
    const h = parseInt(plain4[1], 10), m = parseInt(plain4[2], 10);
    if (h < 24 && m < 60) return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}`;
  }
  const plain3 = s.match(/^(\d)(\d{2})$/);
  if (plain3) {
    const h = parseInt(plain3[1], 10), m = parseInt(plain3[2], 10);
    if (h < 24 && m < 60) return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}`;
  }
  return null;
}

function formatTime12(hhmm) {
  if (!hhmm || !hhmm.includes(":")) return hhmm;
  const [h, m] = hhmm.split(":").map(Number);
  if (isNaN(h) || isNaN(m)) return hhmm;
  const period = h < 12 ? "AM" : "PM";
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${h12}:${String(m).padStart(2,"0")} ${period}`;
}

function TimeInput({ value, onChange, placeholder = "HH:MM", style }) {
  const [focused, setFocused] = useState(false);
  return (
    <input
      type="text"
      placeholder={placeholder}
      style={style}
      value={focused ? value : (value ? formatTime12(value) : "")}
      onChange={e => onChange(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={e => { const t = parseTimeInput(e.target.value); if (t) onChange(t); setFocused(false); }}
    />
  );
}

function fixRuleText(text) {
  if (!text) return "";
  let t = cap(text);
  t = t.replace(/\blake st\.\s*catherine\s+cuts\/trenasses\b/gi, "Lake St. Catherine Cuts/Trenasses");
  t = t.replace(/\blake st\.\s*catherine\s+cuts\b/gi, "Lake St. Catherine Cuts");
  t = t.replace(/\blake st\.\s*catherine\b/gi, "Lake St. Catherine");
  t = t.replace(/\blake catherine\s+cuts\/trenasses\b/gi, "Lake Catherine Cuts/Trenasses");
  t = t.replace(/\blake catherine\s+cuts\b/gi, "Lake Catherine Cuts");
  t = t.replace(/\blake catherine\b/gi, "Lake Catherine");
  t = t.replace(/\bchef\s+pass\b/gi, "Chef Pass");
  t = t.replace(/\blake borgne\b/gi, "Lake Borgne");
  t = t.replace(/\bmrgo\s+interior\s+marsh\b/gi, "MRGO Interior Marsh");
  t = t.replace(/\bmrgo\b/gi, "MRGO");
  t = t.replace(/\bpearl\s+river\b/gi, "Pearl River");
  t = t.replace(/\biww\b/gi, "IWW");
  return t;
}

// Bearing (degrees) that water flows TOWARD during each tide phase per zone
const ZONE_TIDE_BEARINGS = {
  "lake-st-catherine":    { flood: 270, ebb: 90  }, // floods in from Borgne (W into lake), ebbs E back to Borgne
  "lake-catherine-cuts":  { flood: 0,   ebb: 180 }, // floods N into interior marsh, ebbs S to open lake
  "chef-pass":            { flood: 270, ebb: 90  }, // IWW/pass floods W toward Pontchartrain, ebbs E toward Gulf
  "mrgo-interior":        { flood: 315, ebb: 135 }, // MRGO corridor: floods NW up channel, ebbs SE toward Gulf
  "pearl-river":          { flood: 0,   ebb: 180 }, // tide floods N up river, river+ebb flows S to Gulf
};

const ZONES = [
  { id: "lake-st-catherine",   label: "Lake St. Catherine",           lat: 30.128471, lng: -89.732639 },
  { id: "lake-catherine-cuts", label: "Lake Catherine Cuts / Trenasses", lat: 30.100468, lng: -89.716792 },
  { id: "chef-pass",           label: "Chef Pass / IWW",              lat: 30.055496, lng: -89.779941 },
  { id: "mrgo-interior",       label: "MRGO Interior Marsh",          lat: 29.913747, lng: -89.775867 },
  { id: "pearl-river",         label: "Pearl River Marsh",            lat: 30.197734, lng: -89.614093 },
];

const TIDE_STATIONS = [
  { id: "8761305", label: "Shell Beach, Lake Borgne" },
  { id: "8761927", label: "New Canal Station, Lake Pontchartrain" },
  { id: "8761487", label: "Chef Menteur Pass" },
  { id: "8761402", label: "The Rigolets" },
  { id: "8761724", label: "Grand Isle" },
  { id: "8762075", label: "Port Sulphur" },
  { id: "8747437", label: "Bay Waveland Yacht Club" },
  { id: "8749704", label: "Pearl River" },
];

const BUILTIN_RULES = [
  {
    id: "chef-pass-s-wind-incoming",
    label: "Chef Pass / IWW — S Wind + Incoming",
    zones: ["chef-pass"],
    conditions: { windDirs: ["S","SSW","SSE"], windSpeedMin: 10, tideDir: "rising" },
    flag: "avoid",
    source: "trip",
    date: "April 2026",
    reason: "South wind 10+ mph with incoming tide makes Chef Pass/IWW edges too muddy and north-side IWW current too fast to fish effectively.",
  },
];

function pointInPolygon(point, polygon) {
  let inside = false;
  const x = point.lng, y = point.lat;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].lng, yi = polygon[i].lat;
    const xj = polygon[j].lng, yj = polygon[j].lat;
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

function haversineMiles(p1, p2) {
  const R = 3958.8;
  const dLat = (p2.lat - p1.lat) * Math.PI / 180;
  const dLng = (p2.lng - p1.lng) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(p1.lat*Math.PI/180) * Math.cos(p2.lat*Math.PI/180) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function distToPolygonEdge(point, polygon) {
  let min = Infinity;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j], b = polygon[i];
    const dx = b.lng - a.lng, dy = b.lat - a.lat;
    const lenSq = dx*dx + dy*dy;
    const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((point.lng-a.lng)*dx + (point.lat-a.lat)*dy) / lenSq));
    min = Math.min(min, haversineMiles(point, { lat: a.lat + t*dy, lng: a.lng + t*dx }));
  }
  return min;
}

function getMoonPhase(dateStr) {
  const date = new Date(dateStr + "T12:00:00");
  const knownNewMoon = new Date("2000-01-06T12:00:00");
  const daysSince = (date - knownNewMoon) / 86400000;
  const lunarCycle = 29.53059;
  const age = ((daysSince % lunarCycle) + lunarCycle) % lunarCycle;
  const illumination = Math.round((1 - Math.cos(2 * Math.PI * age / lunarCycle)) / 2 * 100);
  let phase;
  if (age < 1.85)       phase = "New Moon";
  else if (age < 7.38)  phase = "Waxing Crescent";
  else if (age < 9.22)  phase = "First Quarter";
  else if (age < 14.77) phase = "Waxing Gibbous";
  else if (age < 16.62) phase = "Full Moon";
  else if (age < 22.15) phase = "Waning Gibbous";
  else if (age < 23.99) phase = "Last Quarter";
  else                  phase = "Waning Crescent";
  return { phase, illumination, age };
}

// ─── WIND-TIDE INTERACTION ────────────────────────────────────────────────────
// Returns how much wind reinforces or opposes tidal current in a zone.
// factor: -1 (fully opposing) to +1 (fully reinforcing), 0 = crossing/slack
function windTideEffect(windDir, windSpeed, tideDir, zoneId, { windwardBank = "", leewardBank = "" } = {}) {
  const zb = ZONE_TIDE_BEARINGS[zoneId];
  if (!zb || !windDir || !windSpeed) return { label: "minimal", factor: 0, color: "#2a4060", note: "" };
  if (tideDir === "slack") {
    const bankNote = windwardBank
      ? ` Fish the ${windwardBank}${leewardBank ? `; ${leewardBank} is calm but dead` : ""}.`
      : " Fish the bank the wind hits directly.";
    return { label: "wind-driven", factor: 0, color: "#4ab0ff",
      note: `Slack tide — ${windDir} ${windSpeed}mph is the primary current.${bankNote}` };
  }
  const currentBearing = tideDir === "falling" ? zb.ebb : zb.flood;
  const windToDeg = (WIND_DIR_DEG[windDir] + 180) % 360;
  const angleDiff = ((windToDeg - currentBearing + 360) % 360);
  const cosAngle = Math.cos(angleDiff * Math.PI / 180);
  const speedFactor = windSpeed <= 5 ? 0.12 : windSpeed <= 10 ? 0.35 : windSpeed <= 15 ? 0.62 : 0.90;
  const factor = cosAngle * speedFactor;

  if (windSpeed <= 5) return { label: "minimal", factor, color: "#2a4060",
    note: `Light wind (${windSpeed}mph) — tidal current drives the bite.` };

  if (factor > 0.25) return { label: "reinforcing", factor, color: "#00c8a0",
    note: windSpeed > 15
      ? `${windDir} wind (${windSpeed}mph) reinforcing the ${tideDir} current — strong combined push. Bait concentrated hard at pinch points and cut exits.`
      : `${windDir} wind (${windSpeed}mph) aligned with the ${tideDir} current — boosted push.${windwardBank ? ` ${cap(windwardBank)} gets both wind and tide — fish that bank first.` : " Better concentration at drain mouths and cut exits."}` };

  if (factor < -0.25) return { label: "opposing", factor, color: "#e05a2b",
    note: windSpeed > 15
      ? `${windDir} wind (${windSpeed}mph) opposing the ${tideDir} tide — current suppressed. Chop without productive current.`
      : `${windDir} wind (${windSpeed}mph) opposing the ${tideDir} current — tide weakened. Fish spread out on structure; don't expect them stacked at drain exits.` };

  return { label: "crossing", factor, color: "#4ab0ff",
    note: `${windDir} wind (${windSpeed}mph) crossing the tidal flow — current intact, wind stacking bait onto the ${windwardBank || "windward bank"} alongside the tide.` };
}

// ─── ZONE SCORING ─────────────────────────────────────────────────────────────
function scoreZone(zoneId, { tideDir, windDir, windSpeed, season, highRiver, highPearlRiver, rigoletsSal }) {
  const sBadWind  = ["S","SSW","SSE"].includes(windDir) && windSpeed >= 10;
  const nWind     = ["N","NNW","NNE","NW","NE"].includes(windDir);
  const roughWind = windSpeed >= 15;
  const modWind   = windSpeed >= 8 && windSpeed < 15;
  const lowRigoletsSal = rigoletsSal !== null && rigoletsSal !== undefined && rigoletsSal < 5;
  let s = 5;

  if (zoneId === "lake-st-catherine") {
    if (tideDir === "falling") s += 3; else if (tideDir === "rising") s += 2; else s -= 1;
    if (roughWind) s -= 4; else if (modWind) s += 1;
    if (season === "fall" || season === "spring") s += 1;
    if (lowRigoletsSal) s -= 1;

  } else if (zoneId === "lake-catherine-cuts") {
    // Best falling-tide zone in the system — current rips through tight throats
    if (tideDir === "falling") s += 5; else if (tideDir === "rising") s += 2; else s -= 3;
    if (roughWind) s -= 1;
    if (season === "fall") s += 2;

  } else if (zoneId === "chef-pass") {
    if (tideDir === "falling") s += 3;
    else if (tideDir === "rising" && !sBadWind) s += 1;
    if (sBadWind) s -= 4;
    else if (roughWind && nWind) s += 1; // N wind — IWW corridor is sheltered
    else if (roughWind) s -= 2;
    if (season === "spring" || season === "fall") s += 1;

  } else if (zoneId === "mrgo-interior") {
    if (tideDir === "rising") s += 3; else if (tideDir === "falling") s += 2;
    // Sheltered ponds — rough wind is an advantage, not a penalty
    if (roughWind) s += 2; else if (modWind) s += 1;
    if (season === "fall") s += 2; else if (season === "spring") s += 1; else if (season === "summer") s -= 1;

  } else if (zoneId === "pearl-river") {
    if (highPearlRiver) s += 2;
    // Most sheltered zone in the system — rough wind is the best time to be here
    if (roughWind) s += 3; else if (modWind) s += 1;
    if (season === "fall" || season === "spring") s += 1;
    else if (season === "summer") s -= 1;
  }

  return Math.max(0, Math.min(10, s));
}

function getBestSpot(zoneId, { tideDir, windwardBank, highPearlRiver }) {
  if (zoneId === "lake-st-catherine") {
    if (tideDir === "falling") return { spot: "South-end shell reef edges and cut mouths", reason: "Falling tide pulls bait toward Borgne — predators stack at the exits" };
    if (tideDir === "rising")  return { spot: `${cap(windwardBank)} shoreline grass edge and potholes`, reason: "Water refilling from the east, wind concentrating bait on the windward bank" };
    return { spot: `${cap(windwardBank)} grass edge`, reason: "Slack water — wind is the only current, fish the windward side" };
  }
  if (zoneId === "lake-catherine-cuts") {
    if (tideDir === "falling") return { spot: "Downcurrent face of cut exits", reason: "Bait funnels out — flounder, trout, and reds stack just outside the mouth" };
    if (tideDir === "rising")  return { spot: "Inside (upcurrent) face of cut throats", reason: "Reds and flounder hold on the upcurrent lip as water pushes in" };
    return { spot: "Cuts aligned with the wind", reason: "No tidal push — wind-aligned cuts still have current through the throat" };
  }
  if (zoneId === "chef-pass") {
    if (tideDir === "falling") return { spot: "Cut mouth intersections with the IWW channel", reason: "Current rips form at junctions — predators ambush bait pushed out by the tide" };
    if (tideDir === "rising")  return { spot: "North bank grass and shell edges inside the pass", reason: "Rising tide activates grass edges along the north bank" };
    return { spot: `${cap(windwardBank)} of the IWW corridor`, reason: "Wind funnels through the IWW — fish the bank the wind hits directly" };
  }
  if (zoneId === "mrgo-interior") {
    if (tideDir === "rising") return { spot: "Shallow pond edges and grass lines", reason: "Water fills the interior — tailing reds and drum rooting on the grass edge" };
    return { spot: "Interior pond drain mouths and channel edges", reason: "Falling tide concentrates fish at drain exits and ledges" };
  }
  if (zoneId === "pearl-river") {
    if (highPearlRiver) return { spot: "Wood structure and hydrilla edges in river bends", reason: "High water activates largemouth — work structure tight with reaction baits" };
    return { spot: "Lower brackish stretch near the river mouth", reason: "Transition zone holds both reds and bass — most productive stretch in normal conditions" };
  }
  return null;
}

// ─── RULE MATCHING ────────────────────────────────────────────────────────────
function matchRule(rule, { windDir, windSpeed, tideDir }) {
  const c = rule.conditions;
  if (c.tideDir && c.tideDir !== tideDir) return false;
  if (c.windDirs && !c.windDirs.includes(windDir)) return false;
  if (c.windSpeedMin !== undefined && windSpeed < c.windSpeedMin) return false;
  if (c.windSpeedMax !== undefined && windSpeed > c.windSpeedMax) return false;
  return true;
}

// ─── FISHING LOGIC ENGINE ─────────────────────────────────────────────────────
function generatePlan(blocks, zones, allRules, riverFt, rigoletsSal, pearlRiverFt, moonPhase, pressureTrend, waterTempF, tripDate) {
  const month = tripDate ? new Date(tripDate + "T12:00:00").getMonth() + 1 : null;
  const season = month
    ? month <= 2 || month === 12 ? "winter"
    : month <= 5 ? "spring"
    : month <= 8 ? "summer"
    : "fall"
    : null;

  return blocks.map((block, blockIndex) => {
    const { startTime, endTime, tideDir, tideChange, windDir, windSpeed } = block;
    const activeRules = allRules.filter(r =>
      zones.some(z => r.zones.includes(z)) && matchRule(r, { windDir, windSpeed, tideDir })
    );
    const avoid = activeRules.filter(r => r.flag === "avoid").map(r => fixRuleText(r.reason));
    const caution = activeRules.filter(r => r.flag === "caution").map(r => fixRuleText(r.reason));
    const hasWind = !!windDir;
    const isStrongWind = hasWind && windSpeed >= 10;
    const isModerateWind = hasWind && windSpeed >= 7;
    const isLightWind = hasWind && windSpeed <= 7;
    const windFromSouth = hasWind && ["S","SSE","SSW"].includes(windDir);
    const windFromNorth = hasWind && ["N","NNE","NNW","NE","NW"].includes(windDir);
    const windFromEast  = hasWind && ["E","ESE","SE","NE","ENE"].includes(windDir);
    const windFromWest  = hasWind && ["W","WNW","WSW","SW","NW"].includes(windDir);
    const highRiver     = riverFt !== null && riverFt !== undefined && riverFt > 12;
    const highPearlRiver = pearlRiverFt !== null && pearlRiverFt !== undefined && pearlRiverFt > 10;
    const lowRigoletsSal = rigoletsSal !== null && rigoletsSal !== undefined && rigoletsSal < 5;
    // MRGO connects directly to Mississippi at IHNC/Lower 9th Ward — Carrollton gauge drives freshwater into mrgo-interior and chef-pass
    const highRiverAffects = highRiver && (zones.includes("mrgo-interior") || zones.includes("chef-pass"));
    // Eastern corridor freshwater via Rigolets/Pontchartrain route — affects lake-st-catherine and lake-catherine-cuts
    const easternFreshwater = lowRigoletsSal && (zones.includes("lake-st-catherine") || zones.includes("lake-catherine-cuts"));
    const troutAvailable = !highRiverAffects && !easternFreshwater;
    // Calm enough to work exposed open-water edges (Borgne shoreline, MRGO channel, river mouth)
    const calmedge = windSpeed < 6;

    // Bank wind pushes bait against (downwind accumulation)
    const windwardBank = windFromSouth ? "north bank" : windFromNorth ? "south bank" : windFromEast ? "west bank" : "east bank";
    const leewardBank  = windFromSouth ? "south bank" : windFromNorth ? "north bank" : windFromEast ? "east bank" : "west bank";

    let strategy = [], primarySpecies = [];
    const zoneMap = {};
    const zt = (label, tip) => { if (!zoneMap[label]) zoneMap[label] = []; zoneMap[label].push(tip); };

    if (blockIndex === 0) {
      if (moonPhase) {
        const isMajorMoon = moonPhase.phase === "New Moon" || moonPhase.phase === "Full Moon";
        const isQuarter   = moonPhase.phase === "First Quarter" || moonPhase.phase === "Last Quarter";
        if (isMajorMoon) strategy.push(`${moonPhase.phase} (${moonPhase.illumination}% illuminated) — peak solunar period. Expect heightened feeding activity, especially at dawn and dusk windows.`);
        else if (isQuarter) strategy.push(`${moonPhase.phase} (${moonPhase.illumination}% illuminated) — moderate solunar influence. Productive windows around sunrise and sunset.`);
        else strategy.push(`${moonPhase.phase} (${moonPhase.illumination}% illuminated) — minor solunar influence. Tidal current and wind will drive bite windows more than moon today.`);
      }
      if (pressureTrend === "falling") strategy.push("Falling barometric pressure — fish often feed aggressively ahead of an approaching front. Strong bite window now, but may shut down as the front arrives.");
      else if (pressureTrend === "rising") strategy.push("Rising pressure — system clearing after a front. Expect a slow start with improving bite through the afternoon as fish recover.");
      if (waterTempF !== null && waterTempF !== undefined) {
        if (waterTempF < 55)                          strategy.push(`Water ${waterTempF.toFixed(1)}°F — cold. Trout lethargic and deep. Slow bottom presentations required. Reds still active on dark sun-warmed mud flats. Bass on deeper wood structure.`);
        else if (waterTempF >= 55 && waterTempF < 65) strategy.push(`Water ${waterTempF.toFixed(1)}°F — cool and prime. Ideal trout temperature — suspending lures and topwater near bait. Reds tailing on sun-warmed flats. Full species mix active.`);
        else if (waterTempF >= 65 && waterTempF <= 82) strategy.push(`Water ${waterTempF.toFixed(1)}°F — warm and productive. All target species available. Bait concentration matters more than structure type.`);
        else                                           strategy.push(`Water ${waterTempF.toFixed(1)}°F — very warm. Fish stressed and seeking depth, shade, or higher-flow areas. Early morning bite window critical — shallows go lockjaw by mid-morning.`);
      }
      if (season === "winter") {
        strategy.push("Winter pattern — trout have moved off grass edges onto channel ledges and deep holes (8–14ft). Find the bottom of the water column with a slow-sinking suspending lure. Reds schooled tight on dark mud flats absorbing solar heat — look south-facing banks on sunny days. Bass very slow on deep wood structure; small natural presentations.");
        if (month === 1 || month === 2) strategy.push("Jan–Feb: flounder offshore for spawn — not a realistic inshore target. Focus on reds, trout, and bass.");
      } else if (season === "spring") {
        strategy.push("Spring transition — trout moving back to grass edges as water warms. Reds showing up in potholes and on shallow flats. Look for bait activity near structure.");
        if (month === 3 || month === 4) strategy.push("Mar–Apr: bass on beds near hard bottom and grass edges — sight-fishing opportunity in clear, shallow water. Post-spawn reds grouping near shell.");
        if (month === 5) strategy.push("May: full species mix active. Trout on grass edge mornings, reds schooling on flats midday, flounder back in the cuts.");
      } else if (season === "summer") {
        strategy.push("Summer pattern — beat the heat with an early start. Trout and bass are most active 6–9 AM before water temps climb. Reds are more heat-tolerant but still most productive early.");
        if (waterTempF === null || waterTempF > 82) strategy.push("Mid-summer heat: trout pushed off shallow grass entirely by mid-morning. If you're fishing past 10 AM, target deeper current-swept edges and shade structure for reds and bass.");
      } else if (season === "fall") {
        strategy.push("Fall prime time — best bite of the year for this fishery. Trout aggressive on grass edges and shell reefs, responding to topwater and fast-moving lures. Reds schooling in large pods on open flats — look for nervous water and rolling fish. Bass and flounder also very active.");
        if (month === 10 || month === 11) strategy.push("Oct–Nov: flounder staging at pass mouths and cut exits ahead of their Gulf migration — concentrate at pinch points with current. Don't miss this window.");
      }
    }

    if (highRiverAffects || easternFreshwater) {
      const reason = highRiverAffects && easternFreshwater
        ? `Mississippi R. at ${riverFt.toFixed(1)}ft pushing through MRGO corridor; Rigolets at ${rigoletsSal.toFixed(1)} ppt — freshwater impacting multiple zones.`
        : highRiverAffects
        ? `Mississippi R. at ${riverFt.toFixed(1)}ft — freshwater pushing through MRGO into Chef Pass and interior marsh.`
        : `Rigolets at ${rigoletsSal.toFixed(1)} ppt — freshwater suppressing salinity in the eastern corridor.`;
      strategy.push(`⚠ ${reason} Trout seeking deeper, saltier water — not a realistic target today. Focus on redfish, black drum, and bass.`);
    }

    if (tideDir === "slack") {
      if (isModerateWind) {
        // Zone tips carry the bank-specific advice; only keep safety warning here
        if (isStrongWind) strategy.push(`Avoid exposed open water — stay in protected cuts and behind-island shorelines to manage the chop.`);
      } else {
        strategy.push("Slack water — tidal current near zero. Fish are transitioning, not ambushing.");
        strategy.push("Light wind and no tidal push — use this window to run to your next location and scout structure on the depth finder.");
        strategy.push("Expect 30–60 min of slow action depending on tidal amplitude.");
      }
    } else if (tideDir === "falling") {
      strategy.push("Falling tide pulling bait toward lake edges — prime ambush conditions.");
      strategy.push("Set up on drain mouths and cut exits on the downcurrent side. Fish are staging, not roaming.");
      strategy.push("Work a drain for 10 min — if no bite, move to the next one. Stay mobile.");
      if (tideChange <= 0.5) strategy.push("Weak drop — current subtle. Focus on tightest pinch points for maximum bait concentration.");
      if (isModerateWind) {
        strategy.push(`${windSpeed}mph ${windDir} wind adding chop — position so the wind pushes bait into the drain mouth alongside the tide.`);
        strategy.push(`${windwardBank.charAt(0).toUpperCase() + windwardBank.slice(1)} edges will hold the most bait. Target cut exits on that side first.`);
        if (isStrongWind) strategy.push("Strong wind can override weak tidal current — prioritize cuts that are aligned with wind direction for maximum bait push.");
      } else {
        if (windFromSouth) strategy.push("Light S wind reinforcing outflow — slight boost to current through cuts.");
        if (windFromEast) strategy.push("East wind favorable — cleaner water on the Borgne side.");
      }
      primarySpecies = [
        "Redfish — grass edges and points adjacent to drains",
        (highRiverAffects || easternFreshwater) ? "Largemouth Bass — grass lines and wood structure in low-salinity backwaters" : "Largemouth Bass — shaded structure, points, and grass edges near cuts",
        ...(troutAvailable ? ["Speckled Trout — cut mouths, current rips, downcurrent of points"] : []),
        "Flounder — flat just downcurrent of cut exits, ambushing bait pushed out by the tide",
        "Black Drum — shell reef edges and hard bottom near drain mouths",
      ];
    } else if (tideDir === "rising") {
      strategy.push("Rising tide pushing bait into marsh — fish moving from drain mouths onto shallow flats and grass edges.");
      strategy.push("Don't sit on drain mouths — fish have moved up. Follow them shallower.");
      if (tideChange <= 0.5) strategy.push("Weak rise — wind-driven current is your friend. Work windward banks where bait is piling up.");
      if (isModerateWind) {
        strategy.push(`${windSpeed}mph ${windDir} wind stacking bait on the ${windwardBank} — prioritize that bank over neutral structure.`);
        if (isStrongWind) strategy.push(`Avoid the ${leewardBank} exposed open water. Stay in protected cuts and wind-shadow edges where fish are comfortable.`);
        if (windFromEast) {
          if (troutAvailable) strategy.push("East wind keeps this system clean — favorable for trout on shell reef edges and windward points.");
          else strategy.push("East wind keeps this system clean — favorable visibility, but salinity too low for trout. Work reds and drum on shell.");
        }
      } else {
        if (windFromEast && troutAvailable) strategy.push("East wind keeps this system clean — favorable for trout on shell reef edges.");
        if (windFromEast && !troutAvailable) strategy.push("East wind keeps this system clean — favorable visibility, but salinity too low for trout. Work reds and drum on shell.");
      }
      primarySpecies = [
        "Redfish — tailing on shallow flats, grass edges, pockets",
        (highRiverAffects || easternFreshwater) ? "Largemouth Bass — moving shallower with the tide in freshwater-pushed areas" : "Largemouth Bass — grass pockets, points, and upcurrent structure edges",
        ...(troutAvailable ? ["Speckled Trout — wind-blown bait lines, shell reef edges, points"] : []),
        ...(tideChange >= 0.15 ? ["Flounder — staging near structure edges waiting for the drop"] : []),
        "Black Drum — shell reefs and oyster pads as water covers them on the rise",
      ];
    }

    // ─── ZONE TIPS ───────────────────────────────────────────────────────────
    if (zones.includes("lake-st-catherine")) {
      if (isStrongWind) zt("Lake St. Catherine", `⚠ ${windSpeed}mph ${windDir} — chop builds fast on this shallow system. Stay tight to the ${windwardBank} and avoid open mid-lake drifts.`);
      if (tideDir === "falling") {
        zt("Lake St. Catherine", `South-end shell reef edges and cut mouths — falling tide pulls bait out toward Borgne. Black drum stacked on shell pads; slow-roll a crab. Watch for birds over the exits.`);
        if (calmedge) zt("Lake St. Catherine", `Wind under 5mph — the rocky Borgne-facing south shoreline is accessible. Fish the leeward side of the rock points and shell edges; trout${troutAvailable ? " and reds" : ""} hold in the current seam just off the rocks.`);
      } else if (tideDir === "rising" && windFromSouth) {
        zt("Lake St. Catherine", `South wind piling bait on the north shoreline — work the grass edges and potholes for reds${troutAvailable ? " and trout" : ""}. South bank has no action right now.`);
      } else if (tideDir === "rising") {
        zt("Lake St. Catherine", `Shell reefs and grass points as water refills from the east.${isModerateWind ? ` ${cap(windwardBank)} edges hold the most bait — ${windDir} wind stacking here alongside the rising tide.` : " Black drum active on the reefs; trout on shell edges at first light."}`);
        if (calmedge) zt("Lake St. Catherine", `Calm enough to work the south Borgne edge — leeward rock points and shell reef lips as water pushes in. Fish face upcurrent on the rocky drop-off.`);
      } else if (tideDir === "slack" && isModerateWind) {
        zt("Lake St. Catherine", `${cap(windwardBank)} grass edge and potholes — ${windDir} wind at ${windSpeed}mph is the only current. Work grass points and structure that breaks the wind line. ${cap(leewardBank)} is calm but dead.`);
      } else {
        zt("Lake St. Catherine", "Slack with no wind — fish are transitioning. Scout structure on the depth finder; expect slow action for 30–60 min.");
        if (calmedge) zt("Lake St. Catherine", "Dead calm — run the south edge and scout the rocky Borgne shoreline. Trout hold along the rock/shell transition in this light; early morning topwater over the reef lip.");
      }
      if (season === "winter") zt("Lake St. Catherine", "Winter: reds schooled on dark mud on east and south banks absorbing solar heat. Trout off this lake — too shallow and cold. Bass on deeper grass edge transitions.");
      if (season === "spring") zt("Lake St. Catherine", "Spring: reds showing in potholes along the north grass edge. Bass spawning on hard bottom near grass transitions. Trout active on shell at first light.");
      if (season === "summer") zt("Lake St. Catherine", "Summer: shallow lake heats up fast — arrive at first light. Work the deeper south-end channel edges midday.");
      if (season === "fall") zt("Lake St. Catherine", "Fall prime: trout on shell reef edges and grass points responding to topwater. Reds schooling near south-end cuts. Bass very active along grass transitions.");
    }
    if (zones.includes("lake-catherine-cuts")) {
      if (isStrongWind) zt("Lake Catherine Cuts / Trenasses", "⚠ Strong wind creates standing waves at the Borgne-facing cut exits — approach from the leeward side and anchor up before the mouth.");
      if (tideDir === "falling") {
        zt("Lake Catherine Cuts / Trenasses", `Downcurrent face of the cut exits — ${troutAvailable ? "flounder, trout, and reds" : "flounder and reds"} stacking just outside the mouth. Even 0.25ft of drop creates a strong rip through a tight throat. Position on the downtide side and let the current do the work.`);
        if (calmedge) zt("Lake Catherine Cuts / Trenasses", `Calm enough to work the open Borgne side of the cut mouths — the rocky points and shell edges just outside each exit hold fish in the current seam. Fish face into the outflow; position off the leeward rock point.`);
      } else if (tideDir === "rising") {
        zt("Lake Catherine Cuts / Trenasses", `Inside (upcurrent) face of cut throats — reds and flounder hold on the upcurrent lip as water pushes in. Don't sit outside the mouth; fish have moved to the upcurrent edge.`);
      } else if (tideDir === "slack" && isModerateWind) {
        zt("Lake Catherine Cuts / Trenasses", `No tidal current — find cuts aligned with ${windDir} wind and work those first. ${windSpeed}mph through a tight throat still pushes bait. ${cap(windwardBank)} face of each cut gets the most push.`);
      } else {
        zt("Lake Catherine Cuts / Trenasses", "Slack with no wind — cuts are dead right now. Reposition for the next tide phase.");
      }
      if (season === "winter") zt("Lake Catherine Cuts / Trenasses", "Winter: cuts hold the warmest water in the system — current keeps temps above the open lake. Reds stacked in deeper cut throats. Bass on inside grass edges.");
      if (season === "fall") zt("Lake Catherine Cuts / Trenasses", "Fall: flounder staging at the Borgne-side cut exits ahead of Gulf migration — one of the best flounder windows of the year. Also prime for reds ambushing from cut edges.");
    }
    if (zones.includes("chef-pass")) {
      if (tideDir === "rising" && windFromSouth && isStrongWind) {
        zt("Chef Pass / IWW", "⚠ Skip this window — rising tide with strong south wind makes this zone unfishable. Come back on the next falling tide or when wind lightens.");
      } else if (tideDir === "slack" && isModerateWind) {
        zt("Chef Pass / IWW", "⚠ IWW acts as a wind funnel — wind channels through the corridor and is amplified. Avoid open-water mid-corridor drifts.");
        zt("Chef Pass / IWW", `Fish the ${windwardBank}; ${leewardBank} has no current and no fish.`);
      } else if (tideDir === "falling") {
        zt("Chef Pass / IWW", isModerateWind
          ? `Downtide/downwind corner of cut mouths — ${windDir} wind and falling tide funneling bait to the same point. ${cap(windwardBank)} edges first. Flounder, reds, and trout all stack here.`
          : "Cut edges and grass points along IWW — flounder prime here on falling tide. Target the sandy transition bottom just outside the grass, where flounder ambush bait pushed out by the current.");
      } else if (tideDir === "rising") {
        zt("Chef Pass / IWW", `North bank grass and shell edges inside the pass — reds and black drum on the rise.${isModerateWind ? ` ${windDir} wind at ${windSpeed}mph adding bait push to the ${windwardBank}.` : ""}`);
      }
      if (season === "winter") zt("Chef Pass / IWW", "Winter: IWW holds the warmest moving water in the area. Bass on wood structure inside the IWW. Reds schooled at the pass mouth.");
      if (season === "spring") zt("Chef Pass / IWW", "Spring: bass spawning on hard bottom just inside the cuts off IWW — beds in 1–3ft of clear water. Reds and trout moving back in as water warms.");
      if (season === "fall") zt("Chef Pass / IWW", "Fall: flounder stacking at Chef Pass mouth and IWW intersections. Work the sandy transition bottom — top fall flounder spot in the system.");
    }
    if (zones.includes("mrgo-interior")) {
      if (tideDir === "falling") {
        zt("MRGO Interior Marsh", `Interior pond edges and drain mouths as water drops.${isModerateWind ? ` Fish the ${windwardBank} of each pond where wind and tide push bait to the same corner.` : ""} Gardner Island tide runs ~4hrs ahead of Shell Beach — verify your actual tide phase.`);
        if (calmedge) zt("MRGO Interior Marsh", `Calm enough to work the MRGO channel edge — rocky channel margins hold reds and drum in slightly deeper, saltier water than the interior ponds. Fish the ${tideDir === "falling" ? "downcurrent" : "upcurrent"} side of any structure along the channel wall.`);
      } else if (tideDir === "rising") {
        zt("MRGO Interior Marsh", `Shallow pond edges and grass lines — tailing reds and black drum rooting on shell as water fills in.${isModerateWind ? ` ${cap(windwardBank)} of each pond gets the most bait push.` : ""}`);
        if (calmedge) zt("MRGO Interior Marsh", `Calm enough for the MRGO channel edge — fish the upcurrent rocky margins as water rises. Cleaner and slightly saltier than the interior; trout possible along the channel wall on calm days.`);
      } else if (tideDir === "slack" && isModerateWind) {
        zt("MRGO Interior Marsh", `Interior ponds are protected from wind. Fish the ${windwardBank} of each pond — ${windDir} wind is the only current and bait is stacking on that bank. ${cap(leewardBank)} is dead.`);
      } else {
        zt("MRGO Interior Marsh", "Slack with no wind — use this window to run to new ponds and scout the MRGO channel edge with the depth finder.");
      }
      if (highRiver) zt("MRGO Interior Marsh", "High river pushing freshwater into interior ponds — fish the MRGO channel itself rather than the shallow ponds; the channel holds slightly cleaner water and concentrates fish pushed off the flats.");
      if (season === "winter") zt("MRGO Interior Marsh", "Winter: interior ponds cold and slow. Look for dark mud on south-facing pond edges absorbing sun — reds stack there on calm sunny days.");
      if (season === "spring") zt("MRGO Interior Marsh", "Spring: reds in every pothole and pond edge as water warms. Bass on structure edges. Best time to explore new ponds.");
      if (season === "summer") zt("MRGO Interior Marsh", "Summer: interior ponds superheat — get in and out before 9 AM. The MRGO channel itself stays cooler and holds fish through mid-morning.");
      if (season === "fall") zt("MRGO Interior Marsh", "Fall: reds schooling in large pods in the interior ponds — sight fishing with topwater or gold spoons. Best action of the year if you find the schools.");
    }
    if (zones.includes("pearl-river")) {
      if (highPearlRiver) {
        zt("Pearl River Marsh", `High water — largemouth bass on wood structure and hydrilla edges in river bends. Reds possible on the lower brackish stretch. Skip trout — salinity too low near the mouth.${isStrongWind ? " River corridor is sheltered from wind." : ""}`);
      } else {
        zt("Pearl River Marsh", `Brackish transition zone — reds and black drum near the mouth, largemouth bass further upriver in fresh water.${isStrongWind ? " River corridor is well-sheltered from wind — good fallback when open water is rough." : ""}`);
        if (calmedge) zt("Pearl River Marsh", `Calm enough to work the open river mouth point — reds and drum stack at the exposed tip where river current meets the open lake. Fish the leeward side of the point; the windward side gets muddy even in light wind. Trout possible on the saltier Gulf side of the mouth.`);
      }
      if (season === "winter") zt("Pearl River Marsh", "Winter: bass in deeper river bends on wood structure — slow presentations critical. Reds concentrated at the lower mouth where salinity is highest.");
      if (season === "spring") zt("Pearl River Marsh", "Spring: bass spawning on shallow hard bottom and submerged wood in 2–4ft. Reds moving upriver as temps rise. Topwater bass bite when water hits 65°F.");
      if (season === "summer") zt("Pearl River Marsh", "Summer: river corridor offers shade and cooler water. Bass on shaded banks and under overhanging vegetation. Fish very early — river bass go lockjaw after 9 AM.");
      if (season === "fall") zt("Pearl River Marsh", "Fall: bass very active as temps drop — reaction baits and moving lures productive. Reds stacking near the mouth.");
    }

    const zoneTips = Object.entries(zoneMap).map(([label, tips]) => ({ label, tips }));

    // ── Where to fish + cross-zone recommendations ──────────────────────────
    const blockCond = { tideDir, windDir, windSpeed, season, highRiver, highPearlRiver, rigoletsSal };
    const spotCond  = { tideDir, windwardBank, highPearlRiver };

    const avoidZoneIds = new Set(activeRules.filter(r => r.flag === "avoid").flatMap(r => r.zones));

    const whereToFish = zones
      .map(zid => {
        const z = ZONES.find(x => x.id === zid);
        const spot = getBestSpot(zid, spotCond);
        return spot ? { zoneId: zid, zone: z?.label ?? zid, score: scoreZone(zid, blockCond), ...spot } : null;
      })
      .filter(Boolean)
      .filter(w => !avoidZoneIds.has(w.zoneId))
      .sort((a, b) => b.score - a.score);

    const bestScore = whereToFish[0]?.score ?? 0;
    const betterZones = ZONES
      .filter(z => !zones.includes(z.id))
      .map(z => {
        const spot = getBestSpot(z.id, spotCond);
        return spot ? { zoneId: z.id, zone: z.label, score: scoreZone(z.id, blockCond), ...spot } : null;
      })
      .filter(z => z && z.score >= bestScore + 2)
      .sort((a, b) => b.score - a.score)
      .slice(0, 2);

    const topZoneId = whereToFish[0]?.zoneId ?? zones[0] ?? null;
    const windTide = topZoneId ? windTideEffect(windDir, windSpeed, tideDir, topZoneId, { windwardBank, leewardBank }) : null;
    return { startTime, endTime, tideDir, tideChange, windDir, windSpeed, strategy, primarySpecies, zoneTips, whereToFish, betterZones, avoid, caution, windTide };
  });
}

// ─── BLOCK BUILDER (pure — used by autoGenerateBlocks and Scout compare) ──────
function buildBlocksFromData(tidePreds1, tidePreds2, blendWeight, windForecast, tripStart, tripEnd) {
  if (!tidePreds1.length || !tripStart || !tripEnd) return [];
  const preds = tidePreds2.length > 0
    ? tidePreds1.map((p,i) => ({ ...p, height: p.height*(1-blendWeight) + (tidePreds2[i]?.height ?? p.height)*blendWeight }))
    : tidePreds1;
  const toMin = t => { const [h,m] = t.slice(-5).split(":").map(Number); return h*60+m; };
  const toTime = m => `${String(Math.floor(m/60)).padStart(2,"0")}:${String(Math.round(m%60)).padStart(2,"0")}`;
  const pts = preds.map(p => ({ min: toMin(p.time), h: p.height })).sort((a,b) => a.min-b.min);
  const heightAt = min => {
    const before = [...pts].reverse().find(p => p.min <= min);
    const after  = pts.find(p => p.min > min);
    if (!before) return after?.h ?? 0;
    if (!after)  return before.h;
    return before.h + (min - before.min) / (after.min - before.min) * (after.h - before.h);
  };
  const windAt = min => {
    if (!windForecast.length) return { windDir: "", windSpeed: 0 };
    const w = windForecast.reduce((b,w) => {
      const [wh,wm] = w.time.split(":").map(Number);
      const d = Math.abs(wh*60+wm - min);
      return d < b.d ? {d, w} : b;
    }, {d:Infinity, w:null}).w;
    return { windDir: w?.dir ?? "", windSpeed: w?.speed ?? 0 };
  };
  const startMin = toMin(tripStart), endMin = toMin(tripEnd);
  const SLACK_HALF = 30, MIN_BLOCK = 20, SPEED_DELTA = 5;
  const hilos = preds.map((p,i,arr) => {
    if (i===0 || i===arr.length-1) return null;
    const isMax = p.height > arr[i-1].height && p.height > arr[i+1].height;
    const isMin = p.height < arr[i-1].height && p.height < arr[i+1].height;
    if (!isMax && !isMin) return null;
    return { ...p, min: toMin(p.time), type: isMax ? "High" : "Low" };
  }).filter(Boolean).filter(p => p.min > startMin+15 && p.min < endMin-15).sort((a,b) => a.min-b.min);
  const slackZones = hilos.map(h => ({ start: Math.max(startMin, h.min-SLACK_HALF), end: Math.min(endMin, h.min+SLACK_HALF) }));
  const splitPoints = new Set();
  slackZones.forEach(sz => { splitPoints.add(sz.start); splitPoints.add(sz.end); });
  if (windForecast.length > 1) {
    const inSlack = min => slackZones.some(sz => min > sz.start && min < sz.end);
    const windInWindow = windForecast.filter(w => { const [wh,wm] = w.time.split(":").map(Number); const m = wh*60+wm; return m >= startMin && m <= endMin; });
    let ref = windInWindow[0];
    for (let i = 1; i < windInWindow.length; i++) {
      const curr = windInWindow[i];
      const [wh,wm] = curr.time.split(":").map(Number); const wMin = wh*60+wm;
      if (inSlack(wMin)) { ref = curr; continue; }
      if (curr.dir !== ref.dir || Math.abs(curr.speed - ref.speed) >= SPEED_DELTA) { splitPoints.add(wMin); ref = curr; }
    }
  }
  const boundaries = [startMin, ...splitPoints, endMin].filter(m => m >= startMin && m <= endMin).sort((a,b) => a-b).filter((m,i,arr) => i===0 || m-arr[i-1] >= MIN_BLOCK);
  const blocks = [];
  for (let i = 0; i < boundaries.length-1; i++) {
    const s = boundaries[i], e = boundaries[i+1], mid = (s+e)/2;
    const isSlack = slackZones.some(sz => s >= sz.start && e <= sz.end);
    let tideDir, tideChange;
    if (isSlack) { tideDir = "slack"; tideChange = 0; }
    else { const net = heightAt(e)-heightAt(s); tideDir = Math.abs(net)<0.08 ? "slack" : net>0 ? "rising" : "falling"; tideChange = parseFloat(Math.abs(net).toFixed(2)); }
    blocks.push({ startTime: toTime(s), endTime: toTime(e), tideDir, tideChange, ...windAt(mid) });
  }
  return blocks;
}

// ─── NOAA TIDE FETCH ──────────────────────────────────────────────────────────
function interpolateHourly(hilos, dateStr) {
  if (!hilos || hilos.length < 1) throw new Error("No hi/lo tide data returned for this station.");
  const parseMin = t => { const [, h, m] = t.match(/(\d+):(\d+)$/); return parseInt(h) * 60 + parseInt(m); };
  const points = hilos.map(p => ({ min: parseMin(p.t), height: parseFloat(p.v), type: p.type }));

  // Pad to at least 2 points using a 6-hour mirror when only 1 hi/lo exists for the day
  if (points.length === 1) {
    const sign = points[0].type === "H" ? -1 : 1;
    points.unshift({ min: points[0].min - 360, height: points[0].height + sign * 1.0, type: points[0].type === "H" ? "L" : "H" });
    points.push({ min: points[points.length - 1].min + 360, height: points[points.length - 1].height + sign * 1.0, type: points[points.length - 1].type === "H" ? "L" : "H" });
  }

  // Anchor with mirrored end points so cosine works at day boundaries
  const extended = [
    { min: points[0].min - (points[1].min - points[0].min), height: points[0].height, type: points[0].type },
    ...points,
    { min: points[points.length-1].min + (points[points.length-1].min - points[points.length-2].min), height: points[points.length-1].height, type: points[points.length-1].type },
  ];

  const hourly = [];
  for (let hr = 0; hr < 24; hr++) {
    const min = hr * 60;
    // Find surrounding pair
    let lo = extended[0], hi2 = extended[extended.length - 1];
    for (let i = 0; i < extended.length - 1; i++) {
      if (extended[i].min <= min && extended[i+1].min > min) { lo = extended[i]; hi2 = extended[i+1]; break; }
    }
    const t = (min - lo.min) / (hi2.min - lo.min);
    const h = (lo.height + hi2.height) / 2 + (lo.height - hi2.height) / 2 * Math.cos(Math.PI * t);
    const timeStr = `${dateStr} ${String(hr).padStart(2,"0")}:00`;
    const exactMatch = points.find(p => Math.abs(p.min - min) < 30 && p.min === min);
    hourly.push({ time: timeStr, height: h, type: exactMatch?.type === "H" ? "High" : exactMatch?.type === "L" ? "Low" : null, isHiLo: !!exactMatch });
  }
  return hourly;
}

async function fetchNOAATides(stationId, date) {
  const d = date.replace(/-/g, "");
  const base = `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?begin_date=${d}&end_date=${d}&station=${stationId}&product=predictions&datum=MLLW&time_zone=lst_ldt&units=english&application=marsh_intel&format=json`;

  // Try hourly first; subordinate stations fall back to hilo + cosine interpolation
  const hourlyRes = await fetch(`${base}&interval=h`);
  const hourlyData = await hourlyRes.json();

  if (!hourlyData.error) {
    const hiloRes = await fetch(`${base}&interval=hilo`);
    const hiloData = await hiloRes.json();
    const hiloTimes = new Set((hiloData.predictions || []).map(p => p.t));
    const hiloTypes = Object.fromEntries((hiloData.predictions || []).map(p => [p.t, p.type === "H" ? "High" : "Low"]));
    return hourlyData.predictions.map(p => ({ time: p.t, height: parseFloat(p.v), type: hiloTypes[p.t] || null, isHiLo: hiloTimes.has(p.t) }));
  }

  // Fallback: hilo only → interpolate
  const hiloRes = await fetch(`${base}&interval=hilo`);
  const hiloData = await hiloRes.json();
  if (hiloData.error) throw new Error(hiloData.error.message);
  if (!hiloData.predictions?.length) throw new Error("No tide predictions returned for this station and date.");
  return interpolateHourly(hiloData.predictions, date);
}

// ─── USGS RIVER GAUGE ─────────────────────────────────────────────────────────
async function fetchRiverGauge(siteId) {
  const url = `https://waterservices.usgs.gov/nwis/iv/?sites=${siteId}&parameterCd=00065&format=json&period=PT6H`;
  const res = await fetch(url);
  const data = await res.json();
  const ts = data.value?.timeSeries;
  if (!ts?.length) throw new Error("No data returned");
  const vals = (ts[0].values?.[0]?.value || []).filter(v => v.value !== "-999999" && v.value !== null);
  if (!vals.length) throw new Error("No valid readings");
  return parseFloat(vals[vals.length - 1].value);
}

// ─── USGS WATER QUALITY ───────────────────────────────────────────────────────
const SALINITY_STATIONS = [
  { id: "301001089442600", label: "Rigolets at Hwy 90", zone: "Rigolets / Lake Pontchartrain East" },
  { id: "073745253",       label: "Reggio Canal / Wills Point", zone: "MRGO Interior / Lake Borgne West" },
];

async function fetchWaterQuality() {
  const ids = SALINITY_STATIONS.map(s => s.id).join(",");
  const url = `https://waterservices.usgs.gov/nwis/iv/?sites=${ids}&parameterCd=00480,00010&format=json&period=PT3H`;
  const res = await fetch(url);
  const data = await res.json();

  const bySite = {};
  data.value.timeSeries.forEach(ts => {
    const siteId = ts.sourceInfo.siteCode[0].value;
    const pCode = ts.variable.variableCode[0].value;
    const vals = ts.values[0].value;
    const recent = vals.filter(v => v.value !== "-999999").slice(-4);
    if (!bySite[siteId]) bySite[siteId] = {};
    if (pCode === "00480") bySite[siteId].salinity = recent.map(v => ({ v: parseFloat(v.value), t: v.dateTime }));
    if (pCode === "00010") bySite[siteId].tempC = recent.map(v => ({ v: parseFloat(v.value), t: v.dateTime }));
  });

  return SALINITY_STATIONS.map(s => {
    const d = bySite[s.id] || {};
    const sal = d.salinity || [];
    const tmp = d.tempC || [];
    const salNow = sal.length ? sal[sal.length - 1].v : null;
    const salPrev = sal.length > 1 ? sal[0].v : null;
    const tempF = tmp.length ? (tmp[tmp.length - 1].v * 9/5 + 32) : null;
    const trend = salNow !== null && salPrev !== null ? (salNow > salPrev + 0.1 ? "rising" : salNow < salPrev - 0.1 ? "falling" : "stable") : null;
    return { ...s, salNow, salPrev, tempF, trend, updatedAt: sal.length ? sal[sal.length-1].t : null };
  });
}

function salinityLabel(ppt) {
  if (ppt === null) return { text: "No data", color: "#5a7a94" };
  if (ppt < 1)  return { text: "Fresh — no trout, reds stressed", color: "#e05a2b" };
  if (ppt < 5)  return { text: "Very low — trout absent, reds possible", color: "#e08030" };
  if (ppt < 10) return { text: "Low — trout unlikely, reds good near structure", color: "#c8a000" };
  if (ppt < 18) return { text: "Moderate — prime conditions for trout & reds", color: "#00c8a0" };
  if (ppt < 25) return { text: "Good — trout & reds active", color: "#00c8a0" };
  return { text: "High salinity — trout, reds, sheepshead", color: "#4ab0ff" };
}

// ─── WIND FORECAST ────────────────────────────────────────────────────────────
const WIND_MODELS = [
  { id: "ecmwf_ifs025", label: "ECMWF IFS (Windy default)" },
  { id: "gfs_seamless", label: "GFS (NOAA)" },
  { id: "icon_seamless", label: "ICON (DWD)" },
];

function degreesToCardinal(deg) {
  const dirs = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
  return dirs[Math.round(deg / 22.5) % 16];
}

async function fetchWindForecast(lat, lng, date, model) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&hourly=wind_speed_10m,wind_direction_10m,wind_gusts_10m,surface_pressure&wind_speed_unit=mph&timezone=America%2FChicago&start_date=${date}&end_date=${date}&models=${model}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.error) throw new Error(data.reason || "Wind forecast unavailable.");
  const h = data.hourly;
  return h.time.map((t, i) => ({
    time: t.slice(11, 16),
    speed: Math.round(h.wind_speed_10m[i]),
    dir: degreesToCardinal(h.wind_direction_10m[i]),
    dirDeg: h.wind_direction_10m[i],
    gust: Math.round(h.wind_gusts_10m[i]),
    pressure: h.surface_pressure?.[i] ?? null,
  }));
}

async function fetchWaterTemp(stationId) {
  const url = `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=water_temperature&station=${stationId}&date=latest&time_zone=lst_ldt&units=english&format=json`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  const readings = data.data;
  if (!readings?.length) throw new Error("No water temp data");
  return parseFloat(readings[readings.length - 1].v);
}

// ─── STORAGE HELPERS ──────────────────────────────────────────────────────────
async function storageGet(key) {
  try { const r = localStorage.getItem(key); return r ? JSON.parse(r) : null; } catch { return null; }
}
async function storageSet(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
}

// ─── MAP COMPONENT ────────────────────────────────────────────────────────────
function MapView({ coords, selectedZones, onCoordsChange }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const coordLayerRef = useRef(null);
  const zoneLayerRef = useRef(null);
  const nextIdxRef = useRef(0);
  const onChangeRef = useRef(onCoordsChange);
  useEffect(() => { onChangeRef.current = onCoordsChange; }, [onCoordsChange]);

  // ── Init map once ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const valid = coords.filter(c => !isNaN(parseFloat(c.lat)) && !isNaN(parseFloat(c.lng)));
    const center = valid.length
      ? [valid.reduce((s,c) => s+parseFloat(c.lat),0)/valid.length, valid.reduce((s,c) => s+parseFloat(c.lng),0)/valid.length]
      : [30.09, -89.73];

    const map = L.map(containerRef.current, { center, zoom: 12, zoomControl: true });
    mapRef.current = map;

    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
      attribution: "Tiles &copy; Esri", maxZoom: 19,
    }).addTo(map);

    zoneLayerRef.current  = L.layerGroup().addTo(map);
    coordLayerRef.current = L.layerGroup().addTo(map);

    // Click to place/replace boundary points
    map.on("click", e => {
      if (!onChangeRef.current) return;
      const pt = { lat: e.latlng.lat.toFixed(6), lng: e.latlng.lng.toFixed(6) };
      onChangeRef.current(prev => {
        const filled = prev.filter(c => c.lat !== "" && c.lng !== "");
        if (filled.length < 4) {
          const next = [...prev];
          const emptyIdx = next.findIndex(c => c.lat === "" || c.lng === "");
          if (emptyIdx !== -1) { next[emptyIdx] = pt; return next; }
          return [...next, pt];
        }
        // All 4 filled — cycle, replacing oldest
        const idx = nextIdxRef.current % 4;
        nextIdxRef.current++;
        const next = [...prev];
        next[idx] = pt;
        return next;
      });
    });

    if (valid.length >= 2) map.fitBounds(L.latLngBounds(valid.map(c => [parseFloat(c.lat), parseFloat(c.lng)])).pad(0.2));

    return () => { map.remove(); mapRef.current = null; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Redraw coord markers + polygon when coords change ───────────────────────
  useEffect(() => {
    const layer = coordLayerRef.current; if (!layer) return;
    layer.clearLayers();
    const valid = coords.filter(c => !isNaN(parseFloat(c.lat)) && !isNaN(parseFloat(c.lng)));
    if (valid.length >= 3) {
      L.polygon(valid.map(c => [parseFloat(c.lat), parseFloat(c.lng)]), {
        color: "#4ab0ff", weight: 1.5, dashArray: "6,4", fillColor: "#4ab0ff", fillOpacity: 0.07,
      }).addTo(layer);
    }
    valid.forEach((c, i) => {
      const lat = parseFloat(c.lat), lng = parseFloat(c.lng);
      L.circleMarker([lat, lng], { radius: 6, color: "#4ab0ff", fillColor: "#4ab0ff", fillOpacity: 1, weight: 1.5 })
        .bindTooltip(`P${i+1} — ${lat.toFixed(5)}, ${lng.toFixed(5)}`, { direction: "top", offset: [0, -8] })
        .addTo(layer);
      L.marker([lat, lng], { icon: L.divIcon({
        className: "",
        html: `<div style="color:#d0e4f0;font-family:'IBM Plex Mono',monospace;font-size:10px;font-weight:700;text-shadow:0 1px 3px #000,0 0 6px #000;pointer-events:none">P${i+1}</div>`,
        iconAnchor: [8, 22],
      })}).addTo(layer);
    });
  }, [coords]);

  // ── Redraw zone circles when selectedZones change ───────────────────────────
  useEffect(() => {
    const layer = zoneLayerRef.current; if (!layer) return;
    layer.clearLayers();
    selectedZones.forEach(zid => {
      const zone = ZONES.find(z => z.id === zid); if (!zone) return;
      L.circle([zone.lat, zone.lng], {
        radius: 1400, color: "#00c8a0", weight: 1.5, dashArray: "4,4", fillColor: "#00c8a0", fillOpacity: 0.08,
      }).addTo(layer);
      L.marker([zone.lat, zone.lng], { icon: L.divIcon({
        className: "",
        html: `<div style="color:#00c8a0;font-family:'IBM Plex Mono',monospace;font-size:10px;font-weight:600;white-space:nowrap;text-shadow:0 1px 3px #000,0 0 6px #000;pointer-events:none">${zone.label}</div>`,
        iconAnchor: [-6, 0],
      })}).addTo(layer);
    });
  }, [selectedZones]);

  const validCount = coords.filter(c => c.lat !== "" && c.lng !== "").length;

  return (
    <div style={{ position: "relative" }}>
      <div ref={containerRef} style={{ width: "100%", height: 480, borderRadius: 8, border: "1px solid #1e3048", overflow: "hidden", cursor: "crosshair" }} />
      {/* HUD */}
      <div style={{ position: "absolute", top: 10, left: 10, zIndex: 1000, display: "flex", gap: 7, alignItems: "center", pointerEvents: "none" }}>
        <div style={{ background: "rgba(10,15,20,0.85)", border: "1px solid #1e3048", borderRadius: 6, padding: "5px 10px", fontFamily: "IBM Plex Mono, monospace", fontSize: "0.65rem", color: "#5a7a94" }}>
          {validCount < 4 ? `Click to place P${validCount + 1}${validCount === 0 ? " — " + (4 - validCount) + " points needed" : " ("+validCount+"/4)"}` : "4/4 points set — click to reposition oldest"}
        </div>
      </div>
      {validCount > 0 && onCoordsChange && (
        <button onClick={() => { nextIdxRef.current = 0; onCoordsChange([{lat:"",lng:""},{lat:"",lng:""},{lat:"",lng:""},{lat:"",lng:""}]); }}
          style={{ position: "absolute", top: 10, right: 10, zIndex: 1000, background: "rgba(10,15,20,0.85)", border: "1px solid #e05a2b", borderRadius: 6, padding: "5px 10px", fontFamily: "IBM Plex Mono, monospace", fontSize: "0.65rem", color: "#e05a2b", cursor: "pointer" }}>
          Clear Points
        </button>
      )}
    </div>
  );
}

// ─── TIDE CHART ───────────────────────────────────────────────────────────────
function buildCurve(pts) {
  if (!pts.length) return "";
  let d = `M ${pts[0][0]} ${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    const cp1x = p1[0] + (p2[0] - p0[0]) / 6, cp1y = p1[1] + (p2[1] - p0[1]) / 6;
    const cp2x = p2[0] - (p3[0] - p1[0]) / 6, cp2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2[0]} ${p2[1]}`;
  }
  return d;
}

function TideChart({ predictions, predictions2 = [], blendWeight = 0.5, label1 = "Station 1", label2 = "Station 2", windForecast = [], primaryZoneId = null }) {
  if (!predictions.length) return null;
  const W = 400, H = 150, padL = 32, padR = 10, padT = 18, padB = 22;
  const cW = W - padL - padR, cH = H - padT - padB;

  const hasBlend = predictions2.length > 0;
  const n = predictions.length;

  // Compute blended heights
  const blended = predictions.map((p, i) => {
    if (!hasBlend || !predictions2[i]) return p.height;
    return p.height * (1 - blendWeight) + predictions2[i].height * blendWeight;
  });

  const allHeights = [...predictions.map(p => p.height), ...(hasBlend ? predictions2.map(p => p.height) : []), ...blended];
  const maxH = Math.max(...allHeights) + 0.2;
  const minH = Math.min(0, ...allHeights) - 0.1;
  const range = maxH - minH;

  const toX = i => padL + (i / (n - 1)) * cW;
  const toY = h => padT + cH - ((h - minH) / range) * cH;

  const pts1 = predictions.map((p, i) => [toX(i), toY(p.height)]);
  const pts2 = hasBlend ? predictions2.map((p, i) => [toX(i), toY(p.height)]) : [];
  const ptsB = blended.map((h, i) => [toX(i), toY(h)]);

  const d1 = buildCurve(pts1);
  const d2 = hasBlend ? buildCurve(pts2) : "";
  const dB = buildCurve(ptsB);
  const fillB = `${dB} L ${ptsB[ptsB.length-1][0]} ${toY(0)} L ${ptsB[0][0]} ${toY(0)} Z`;

  const yTicks = [];
  const tickStep = range <= 1.5 ? 0.5 : range <= 3 ? 1 : 1.5;
  for (let v = Math.ceil(minH / tickStep) * tickStep; v <= maxH; v = Math.round((v + tickStep) * 100) / 100) yTicks.push(v);

  const xLabels = predictions.filter((_, i) => i % 3 === 0);

  // Find hi/lo on blended curve
  const blendedPreds = blended.map((h, i) => ({ height: h, time: predictions[i].time }));
  const hiloBlended = blendedPreds.filter((_, i, arr) => {
    if (i === 0 || i === arr.length - 1) return false;
    const h = arr[i].height;
    return (h > arr[i-1].height && h > arr[i+1].height) || (h < arr[i-1].height && h < arr[i+1].height);
  });

  return (
    <div style={{ marginTop: 12 }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: H }}>
        <defs>
          <linearGradient id="tideGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#00c8a0" stopOpacity="0.22" />
            <stop offset="100%" stopColor="#00c8a0" stopOpacity="0.02" />
          </linearGradient>
        </defs>

        {/* grid */}
        {yTicks.map(v => (
          <g key={v}>
            <line x1={padL} y1={toY(v)} x2={W - padR} y2={toY(v)} stroke="#1a2a3a" strokeWidth="0.5" />
            <text x={padL - 4} y={toY(v) + 3} textAnchor="end" fill="#3a5a74" fontSize="7" fontFamily="IBM Plex Mono, monospace">{v.toFixed(1)}</text>
          </g>
        ))}
        <line x1={padL} y1={toY(0)} x2={W - padR} y2={toY(0)} stroke="#1e3048" strokeWidth="1" strokeDasharray="3,3" />

        {/* station guide curves (dim, dashed) */}
        {hasBlend && <path d={d1} fill="none" stroke="#00c8a0" strokeWidth="1" strokeDasharray="4,3" strokeOpacity="0.35" />}
        {hasBlend && <path d={d2} fill="none" stroke="#4ab0ff" strokeWidth="1" strokeDasharray="4,3" strokeOpacity="0.35" />}

        {/* blended fill + curve */}
        <path d={fillB} fill="url(#tideGrad)" />
        <path d={dB} fill="none" stroke="#00c8a0" strokeWidth="2.5" strokeLinejoin="round" />

        {/* hi/lo markers on blended curve */}
        {hiloBlended.map((p, i) => {
          const idx = blendedPreds.indexOf(p);
          const x = toX(idx), y = toY(p.height);
          const isHigh = i > 0 && hiloBlended[i-1] ? p.height > hiloBlended[i-1].height : p.height > (blendedPreds[idx-1]?.height ?? 0);
          const peak = blended[idx] >= blended[idx-1] && blended[idx] >= blended[idx+1];
          return (
            <g key={i}>
              <circle cx={x} cy={y} r="3.5" fill={peak ? "#00c8a0" : "#4ab0ff"} />
              <text x={x} y={peak ? y - 7 : y + 14} textAnchor="middle" fill={peak ? "#00c8a0" : "#4ab0ff"} fontSize="8" fontFamily="IBM Plex Mono, monospace">{p.height.toFixed(1)}ft</text>
            </g>
          );
        })}

        {/* x-axis labels */}
        {xLabels.map((p, i) => {
          const idx = predictions.indexOf(p);
          return <text key={i} x={toX(idx)} y={H - 4} textAnchor="middle" fill="#3a5a74" fontSize="7" fontFamily="IBM Plex Mono, monospace">{p.time.slice(-5)}</text>;
        })}
      </svg>

      {/* WIND-TIDE INTERACTION STRIP */}
      {windForecast.length > 0 && primaryZoneId && (() => {
        const lPct = (padL / W * 100).toFixed(1);
        const rPct = (padR / W * 100).toFixed(1);
        const stripData = predictions.map((p, i) => {
          const currH = blended[i];
          const prevH = i > 0 ? blended[i - 1] : blended[i + 1];
          const tDir = currH > prevH ? "rising" : currH < prevH ? "falling" : "slack";
          const hr = parseInt(p.time.slice(-5).split(":")[0], 10);
          const wind = windForecast.reduce((best, w) => {
            const wHr = parseInt(w.time.split(":")[0], 10);
            return Math.abs(wHr - hr) < Math.abs(parseInt(best.time.split(":")[0], 10) - hr) ? w : best;
          }, windForecast[0]);
          const effect = windTideEffect(wind.dir, wind.speed, tDir, primaryZoneId);
          const bg = effect.label === "reinforcing" ? "rgba(0,200,160,0.65)"
            : effect.label === "opposing"    ? "rgba(224,90,43,0.65)"
            : effect.label === "crossing"    ? "rgba(74,176,255,0.5)"
            : effect.label === "wind-driven" ? "rgba(74,176,255,0.35)"
            : "rgba(30,48,72,0.5)";
          return { bg, note: effect.note, label: effect.label };
        });
        const zoneLabel = ZONES.find(z => z.id === primaryZoneId)?.label ?? primaryZoneId;
        return (
          <div style={{ marginTop: 6, marginBottom: 2 }}>
            <div style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.57rem", letterSpacing:1.5, textTransform:"uppercase", color:"#3a5a74", marginBottom:3 }}>
              Wind × Tide — {zoneLabel}
            </div>
            <div style={{ display:"flex", marginLeft:`${lPct}%`, marginRight:`${rPct}%`, height:9, borderRadius:4, overflow:"hidden" }}>
              {stripData.map((d, i) => (
                <div key={i} title={d.note} style={{ flex:1, background:d.bg, cursor:"default" }} />
              ))}
            </div>
          </div>
        );
      })()}

      <div style={{ display: "flex", gap: 14, marginTop: 6, flexWrap: "wrap" }}>
        {hasBlend ? (
          <>
            <span style={{ fontFamily: "IBM Plex Mono, monospace", fontSize: "0.68rem", color: "#5a7a94", display: "flex", alignItems: "center", gap: 5 }}>
              <span style={{ width: 18, height: 2, background: "#00c8a0", opacity: 0.4, display: "inline-block", borderRadius: 1, borderTop: "1px dashed #00c8a0" }} />{label1}
            </span>
            <span style={{ fontFamily: "IBM Plex Mono, monospace", fontSize: "0.68rem", color: "#5a7a94", display: "flex", alignItems: "center", gap: 5 }}>
              <span style={{ width: 18, height: 2, background: "#4ab0ff", opacity: 0.4, display: "inline-block", borderRadius: 1, borderTop: "1px dashed #4ab0ff" }} />{label2}
            </span>
            <span style={{ fontFamily: "IBM Plex Mono, monospace", fontSize: "0.68rem", color: "#00c8a0", display: "flex", alignItems: "center", gap: 5 }}>
              <span style={{ width: 18, height: 2, background: "#00c8a0", display: "inline-block", borderRadius: 1 }} />Blended estimate
            </span>
          </>
        ) : (
          [["#00c8a0","High"],["#4ab0ff","Low"]].map(([color, label]) => (
            <span key={label} style={{ fontFamily: "IBM Plex Mono, monospace", fontSize: "0.68rem", color: "#5a7a94", display: "flex", alignItems: "center", gap: 5 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: color, display: "inline-block" }} />{label}
            </span>
          ))
        )}
        {windForecast.length > 0 && primaryZoneId && (
          <>
            {[["rgba(0,200,160,0.65)","Reinforcing"],["rgba(224,90,43,0.65)","Opposing"],["rgba(74,176,255,0.5)","Crossing"],["rgba(30,48,72,0.5)","Minimal wind"]].map(([bg, lbl]) => (
              <span key={lbl} style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.65rem", color:"#5a7a94", display:"flex", alignItems:"center", gap:5 }}>
                <span style={{ width:14, height:7, borderRadius:2, background:bg, display:"inline-block" }} />{lbl}
              </span>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

// ─── TIME BLOCK FORM ──────────────────────────────────────────────────────────
function TimeBlockForm({ block, index, onChange, onRemove }) {
  return (
    <div className="tbf">
      <div className="fr">
        <label>Start</label>
        <TimeInput value={block.startTime} onChange={v => onChange(index, "startTime", v)} />
        <label>End</label>
        <TimeInput value={block.endTime} onChange={v => onChange(index, "endTime", v)} />
      </div>
      <div className="fr">
        <label>Tide</label>
        <select value={block.tideDir} onChange={e => onChange(index, "tideDir", e.target.value)}>
          <option value="falling">Falling</option>
          <option value="slack">Slack</option>
          <option value="rising">Rising</option>
        </select>
        <label>Δft</label>
        <input type="number" step="0.05" min="0" max="3" value={block.tideChange} onChange={e => onChange(index, "tideChange", parseFloat(e.target.value) || 0)} style={{ maxWidth: 70 }} />
      </div>
      <div className="fr">
        <label>Wind</label>
        <select value={block.windDir} onChange={e => onChange(index, "windDir", e.target.value)}>
          {WIND_DIRS.map(d => <option key={d}>{d}</option>)}
        </select>
        <input type="number" min="0" max="50" value={block.windSpeed} onChange={e => onChange(index, "windSpeed", parseInt(e.target.value) || 0)} style={{ maxWidth: 60 }} />
        <span style={{ fontFamily: "IBM Plex Mono, monospace", fontSize: "0.7rem", color: "#5a7a94" }}>mph</span>
      </div>
      {index > 0 && <button className="rm-btn" onClick={() => onRemove(index)}>Remove block</button>}
    </div>
  );
}

// ─── BLOCK CARD ───────────────────────────────────────────────────────────────
function BlockCard({ block, onSwitchZone }) {
  const [open, setOpen] = useState(true);
  const hasAvoid = block.avoid.length > 0;
  const hasCaution = block.caution.length > 0;

  const topSpot = block.whereToFish?.[0];

  const topZoneLabel = topSpot?.zone ?? null;
  const primaryTips = block.zoneTips.find(z => z.label === topZoneLabel) ?? null;
  const hasZoneWarning = primaryTips?.tips.some(t => t.includes("⚠")) ?? false;
  const fallbackSpots = block.whereToFish?.slice(1) ?? [];

  // Strategy lines (non-warning) for context
  const strategyLines = block.strategy.filter(s => !s.includes("⚠") && !s.includes("△"));
  // Lead: top spot sentence + first tactic line
  const leadParts = [];
  if (topSpot) leadParts.push(`${cap(topSpot.spot)} in ${topSpot.zone} — ${topSpot.reason}.`);
  if (strategyLines[0]) leadParts.push(strategyLines[0]);
  const leadText = leadParts.join(" ");

  return (
    <div className={`bc ${block.tideDir}${hasAvoid ? " bw" : ""}`}>
      <div className="bh" onClick={() => setOpen(o => !o)}>
        <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
          <div style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" }}>
            <span className="bt">{block.startTime} – {block.endTime}</span>
            {topSpot && <span style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.72rem", color:"#00c8a0" }}>| {topSpot.zone}</span>}
          </div>
          <div style={{ display:"flex", alignItems:"center", gap:6, flexWrap:"wrap" }}>
            <span className={`badge tb-${block.tideDir}`}>{block.tideDir === "falling" ? "↓" : block.tideDir === "rising" ? "↑" : "—"} {block.tideDir}</span>
            {block.windDir && <span className="badge wb">{block.windDir} {block.windSpeed}mph</span>}
            {block.tideChange > 0 && <span className="badge" style={{ background:"rgba(255,255,255,0.04)", color:"#5a7a94" }}>Δ{block.tideChange}ft</span>}
            {hasAvoid && <span className="badge" style={{ background:"rgba(224,90,43,0.15)", color:"#e05a2b" }}>⚠ Rule Triggered</span>}
            {hasZoneWarning && !hasAvoid && <span className="badge" style={{ background:"rgba(224,90,43,0.15)", color:"#e05a2b" }}>⚠ Zone Warning</span>}
            {hasCaution && !hasAvoid && !hasZoneWarning && <span className="badge" style={{ background:"rgba(200,160,0,0.12)", color:"#c8a000" }}>⚡ Caution</span>}
          </div>
        </div>
        <span style={{ fontSize:"0.65rem", color:"#5a7a94" }}>{open ? "▲" : "▼"}</span>
      </div>
      {open && (
        <div className="bb">
          {/* LEAD PARAGRAPH — primary recommendation */}
          {leadText && <p style={{ fontSize:"0.88rem", color:"#d0e4f0", lineHeight:1.75, marginBottom: block.windTide && block.windTide.label !== "minimal" ? 8 : 14 }}>{leadText}</p>}

          {/* WIND-TIDE INTERACTION NOTE */}
          {block.windTide && block.windTide.label !== "minimal" && block.windTide.note && (
            <p style={{ fontSize:"0.82rem", color: block.windTide.color, lineHeight:1.65, marginBottom:14, paddingLeft:10, borderLeft:`2px solid ${block.windTide.color}` }}>
              {block.windTide.note}
            </p>
          )}

          {/* PRIMARY ZONE TIPS */}
          {primaryTips && (() => {
            const normal = primaryTips.tips.filter(t => !t.includes("⚠"));
            const warns  = primaryTips.tips.filter(t => t.includes("⚠"));
            return (
              <div style={{ marginBottom:14 }}>
                {normal.length > 0 && <p style={{ fontSize:"0.84rem", color:"#d0e4f0", lineHeight:1.65, marginBottom: warns.length ? 6 : 0 }}>{normal.join(" ")}</p>}
                {warns.map((t, j) => <p key={j} style={{ fontSize:"0.84rem", color:"#f08070", lineHeight:1.65, marginBottom:0 }}>{t}</p>)}
              </div>
            );
          })()}

          {/* REMAINING KEY STRATEGY LINES */}
          {strategyLines.length > 1 && (
            <div style={{ marginBottom:14 }}>
              {strategyLines.slice(1).map((s, i) => (
                <p key={i} style={{ fontSize:"0.84rem", color:"#a0b8cc", lineHeight:1.65, marginBottom:4 }}>{s}</p>
              ))}
            </div>
          )}

          {/* FALLBACK ZONES — all selected zones beyond the primary */}
          {fallbackSpots.length > 0 && (
            <div style={{ marginBottom:14 }}>
              <div style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.58rem", letterSpacing:2, textTransform:"uppercase", color:"#5a7a94", marginBottom:8 }}>If conditions push you off {topZoneLabel}</div>
              {fallbackSpots.map((spot, idx) => {
                const tips = block.zoneTips.find(z => z.label === spot.zone) ?? null;
                const normal = tips?.tips.filter(t => !t.includes("⚠")) ?? [];
                const warns  = tips?.tips.filter(t => t.includes("⚠")) ?? [];
                return (
                  <div key={idx} style={{ marginBottom: idx < fallbackSpots.length - 1 ? 10 : 0, background:"rgba(255,255,255,0.02)", borderLeft:"2px solid #2a4a6a", paddingLeft:12 }}>
                    <p style={{ fontSize:"0.84rem", color:"#a0b8cc", lineHeight:1.65, marginBottom: tips ? 4 : 0 }}>
                      <span style={{ color:"#d0e4f0" }}>{spot.zone} — {spot.spot}.</span> {spot.reason}.
                    </p>
                    {normal.length > 0 && <p style={{ fontSize:"0.82rem", color:"#8090a0", lineHeight:1.6, marginBottom: warns.length ? 4 : 0 }}>{normal.join(" ")}</p>}
                    {warns.map((t, j) => <p key={j} style={{ fontSize:"0.82rem", color:"#f08070", lineHeight:1.6, marginBottom:0 }}>{t}</p>)}
                  </div>
                );
              })}
            </div>
          )}

          {/* TARGET SPECIES — inline pills */}
          {block.primarySpecies.length > 0 && (
            <div style={{ display:"flex", flexWrap:"wrap", gap:6, marginBottom:12, alignItems:"center" }}>
              <span style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.6rem", color:"#5a7a94" }}>TARGET:</span>
              {block.primarySpecies.map((s, i) => (
                <span key={i} style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.65rem", padding:"3px 9px", borderRadius:12, border:"1px solid rgba(0,200,160,0.3)", color:"#00c8a0", background:"rgba(0,200,160,0.06)" }}>
                  {s.split(" — ")[0]}
                </span>
              ))}
            </div>
          )}

          {/* BETTER ZONE */}
          {block.betterZones?.length > 0 && (
            <div style={{ marginBottom:12, background:"rgba(74,176,255,0.05)", border:"1px solid rgba(74,176,255,0.2)", borderRadius:7, padding:"10px 13px" }}>
              <div style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.6rem", letterSpacing:2, textTransform:"uppercase", color:"#4ab0ff", marginBottom:6 }}>🎯 Better Zone This Block</div>
              {block.betterZones.map((z, i) => (
                <div key={i} style={{ marginBottom: i < block.betterZones.length - 1 ? 10 : 0 }}>
                  <p style={{ fontSize:"0.84rem", color:"#a0c8f0", lineHeight:1.5, marginBottom:6 }}>
                    <span style={{ color:"#4ab0ff", fontWeight:600 }}>{z.zone}</span> — {z.spot}. {z.reason}.
                  </p>
                  {onSwitchZone && (
                    <button
                      onClick={() => onSwitchZone(z.zoneId)}
                      style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.62rem", padding:"4px 12px", borderRadius:6, border:"1px solid rgba(74,176,255,0.4)", color:"#4ab0ff", background:"rgba(74,176,255,0.08)", cursor:"pointer", letterSpacing:0.5 }}
                    >
                      Switch Strategy →
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          {hasCaution && <Section title="⚡ Caution" items={block.caution} color="#c8a000" />}
          {hasAvoid && <Section title="⚠ Avoid" items={block.avoid} color="#e05a2b" textColor="#f08070" />}
        </div>
      )}
    </div>
  );
}

function Section({ title, items, color = "#00c8a0", textColor }) {
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ fontFamily: "IBM Plex Mono, monospace", fontSize: "0.6rem", letterSpacing: 2, textTransform: "uppercase", color: "#5a7a94", marginBottom: 7 }}>{title}</div>
      <ul style={{ listStyle: "none" }}>
        {items.map((s, i) => (
          <li key={i} style={{ fontSize: "0.855rem", color: textColor || "#d0e4f0", lineHeight: 1.55, paddingLeft: 13, position: "relative", marginBottom: 4 }}>
            <span style={{ position: "absolute", left: 0, color }}>{"›"}</span>{s}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ─── FEEDBACK MODAL ───────────────────────────────────────────────────────────
const SPECIES_LIST = ["Redfish", "Bass", "Trout", "Flounder", "Other"];
const SIZE_OPTS    = ["Undersized", "Keeper", "Trophy", "Mixed"];

function FeedbackModal({ plan, zones, onSave, onClose }) {
  const [targetSpecies, setTargetSpecies] = useState([]);
  const [otherSpeciesText, setOtherSpeciesText] = useState("");
  const [catchLog, setCatchLog]   = useState([]);
  const [rating, setRating]       = useState(0);
  const [general, setGeneral]     = useState("");
  const [fbs, setFbs] = useState(plan.map((b, i) => ({ i, worked: "yes", notes: "", createRule: false, ruleZones: [], ruleFlag: "avoid" })));

  const togSpecies = s => setTargetSpecies(p => p.includes(s) ? p.filter(x => x !== s) : [...p, s]);
  const addCatch   = () => setCatchLog(p => [...p, { id: Date.now(), species: "Redfish", count: "", size: "Keeper", bait: "", zone: zones[0] || "" }]);
  const updCatch   = (id, f, v) => setCatchLog(p => p.map(c => c.id === id ? { ...c, [f]: v } : c));
  const remCatch   = id => setCatchLog(p => p.filter(c => c.id !== id));
  const upd = (i, f, v) => setFbs(p => p.map((x, j) => j === i ? { ...x, [f]: v } : x));
  const togZone = (i, zid) => setFbs(p => p.map((x, j) => {
    if (j !== i) return x;
    const rz = x.ruleZones.includes(zid) ? x.ruleZones.filter(z => z !== zid) : [...x.ruleZones, zid];
    return { ...x, ruleZones: rz };
  }));

  const pill = (label, active, onClick) => (
    <div key={label} onClick={onClick} style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.65rem", padding:"4px 11px", borderRadius:16, border:`1px solid ${active ? "#00c8a0" : "#1e3048"}`, color: active ? "#00c8a0" : "#5a7a94", background: active ? "rgba(0,200,160,0.08)" : "transparent", cursor:"pointer", userSelect:"none" }}>{label}</div>
  );

  const submit = () => {
    const newRules = [];
    fbs.forEach((fb, i) => {
      if (fb.createRule && fb.ruleZones.length && fb.notes) {
        const pb = plan[fb.i];
        newRules.push({
          id: `user-${Date.now()}-${i}`,
          label: `${fb.ruleZones.join("+")} — ${pb.windDir} ${pb.tideDir}`,
          zones: fb.ruleZones,
          conditions: { tideDir: pb.tideDir, windDirs: [pb.windDir], windSpeedMin: Math.max(0, pb.windSpeed - 3) },
          flag: fb.ruleFlag,
          source: "trip-feedback",
          date: new Date().toLocaleDateString(),
          reason: fb.notes,
        });
      }
    });
    onSave(newRules, { general, targetSpecies, otherSpeciesText, catchLog, rating }, fbs);
    onClose();
  };

  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.8)", zIndex:200, display:"flex", alignItems:"flex-start", justifyContent:"center", padding:20, overflowY:"auto" }}>
      <div style={{ background:"#111820", border:"1px solid #1e3048", borderRadius:10, width:"100%", maxWidth:620, margin:"auto" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"16px 22px", borderBottom:"1px solid #1e3048" }}>
          <span style={{ fontFamily:"Bebas Neue,sans-serif", fontSize:"1.3rem", letterSpacing:2, color:"#00c8a0" }}>POST-TRIP DEBRIEF</span>
          <button onClick={onClose} style={{ background:"none", border:"none", color:"#5a7a94", fontSize:"1.1rem", cursor:"pointer" }}>✕</button>
        </div>
        <div style={{ padding:"18px 22px" }}>

          {/* TARGET SPECIES */}
          <div style={{ marginBottom:18 }}>
            <div style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.65rem", color:"#5a7a94", textTransform:"uppercase", letterSpacing:1, marginBottom:8 }}>Target Species</div>
            <div style={{ display:"flex", flexWrap:"wrap", gap:6 }}>
              {SPECIES_LIST.map(s => pill(s, targetSpecies.includes(s), () => togSpecies(s)))}
            </div>
            {targetSpecies.includes("Other") && (
              <input value={otherSpeciesText} onChange={e => setOtherSpeciesText(e.target.value)} placeholder="Species name..." style={{ marginTop:8 }} />
            )}
          </div>

          {/* CATCH LOG */}
          <div style={{ marginBottom:18 }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8 }}>
              <div style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.65rem", color:"#5a7a94", textTransform:"uppercase", letterSpacing:1 }}>Catch Log</div>
              <button onClick={addCatch} style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.63rem", background:"transparent", border:"1px solid #00c8a0", color:"#00c8a0", borderRadius:5, padding:"3px 10px", cursor:"pointer" }}>+ Add Entry</button>
            </div>
            {catchLog.length === 0 && <div style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.68rem", color:"#2a4060" }}>No catch entries yet.</div>}
            {catchLog.map(c => (
              <div key={c.id} style={{ background:"#0a0f14", border:"1px solid #1e3048", borderRadius:7, padding:"10px 12px", marginBottom:8 }}>
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginBottom:8 }}>
                  <div>
                    <div style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.6rem", color:"#5a7a94", marginBottom:4 }}>SPECIES</div>
                    <select value={c.species} onChange={e => updCatch(c.id, "species", e.target.value)}>
                      {SPECIES_LIST.map(s => <option key={s}>{s}</option>)}
                    </select>
                  </div>
                  <div>
                    <div style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.6rem", color:"#5a7a94", marginBottom:4 }}>COUNT</div>
                    <input type="number" min="0" value={c.count} onChange={e => updCatch(c.id, "count", e.target.value)} placeholder="0" />
                  </div>
                  <div>
                    <div style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.6rem", color:"#5a7a94", marginBottom:4 }}>SIZE</div>
                    <select value={c.size} onChange={e => updCatch(c.id, "size", e.target.value)}>
                      {SIZE_OPTS.map(s => <option key={s}>{s}</option>)}
                    </select>
                  </div>
                  <div>
                    <div style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.6rem", color:"#5a7a94", marginBottom:4 }}>ZONE</div>
                    <select value={c.zone} onChange={e => updCatch(c.id, "zone", e.target.value)}>
                      {ZONES.map(z => <option key={z.id} value={z.id}>{z.label}</option>)}
                    </select>
                  </div>
                </div>
                <div style={{ marginBottom:6 }}>
                  <div style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.6rem", color:"#5a7a94", marginBottom:4 }}>BAIT / LURE</div>
                  <input value={c.bait} onChange={e => updCatch(c.id, "bait", e.target.value)} placeholder="e.g. Gold spoon, paddle tail, live shrimp..." />
                </div>
                <button onClick={() => remCatch(c.id)} style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.6rem", background:"none", border:"1px solid #1e3048", color:"#5a7a94", borderRadius:4, padding:"2px 8px", cursor:"pointer" }}>Remove</button>
              </div>
            ))}
          </div>

          {/* TRIP RATING */}
          <div style={{ marginBottom:18 }}>
            <div style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.65rem", color:"#5a7a94", textTransform:"uppercase", letterSpacing:1, marginBottom:8 }}>Trip Rating</div>
            <div style={{ display:"flex", gap:6 }}>
              {[1,2,3,4,5].map(n => (
                <div key={n} onClick={() => setRating(n)} style={{ width:32, height:32, borderRadius:6, border:`1px solid ${rating >= n ? "#f0a500" : "#1e3048"}`, background: rating >= n ? "rgba(240,165,0,0.12)" : "transparent", display:"flex", alignItems:"center", justifyContent:"center", cursor:"pointer", fontFamily:"IBM Plex Mono,monospace", fontSize:"0.75rem", color: rating >= n ? "#f0a500" : "#2a4060" }}>{n}</div>
              ))}
            </div>
          </div>

          {/* TIME BLOCK FEEDBACK */}
          <div style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.65rem", color:"#5a7a94", textTransform:"uppercase", letterSpacing:1, marginBottom:8 }}>Time Block Feedback</div>
          {fbs.map((fb, i) => {
            const pb = plan[fb.i];
            return (
              <div key={i} style={{ background:"#0a0f14", border:"1px solid #1e3048", borderRadius:8, padding:14, marginBottom:12 }}>
                <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:10 }}>
                  <span style={{ fontFamily:"Bebas Neue,sans-serif", fontSize:"1.1rem", color:"#d0e4f0" }}>{pb.startTime}–{pb.endTime}</span>
                  <span style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.65rem", background:"rgba(255,255,255,0.05)", color:"#5a7a94", padding:"2px 8px", borderRadius:10 }}>{pb.tideDir} · {pb.windDir} {pb.windSpeed}mph</span>
                </div>
                <div style={{ marginBottom:8 }}>
                  <div style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.65rem", color:"#5a7a94", textTransform:"uppercase", letterSpacing:1, marginBottom:6 }}>Did this window produce?</div>
                  <div style={{ display:"flex", gap:7 }}>
                    {["yes","partial","no"].map(v => (
                      <label key={v} style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.7rem", padding:"5px 13px", borderRadius:16, border:`1px solid ${fb.worked === v ? "#00c8a0" : "#1e3048"}`, color: fb.worked === v ? "#00c8a0" : "#5a7a94", background: fb.worked === v ? "rgba(0,200,160,0.08)" : "transparent", cursor:"pointer", userSelect:"none" }}>
                        <input type="radio" style={{ display:"none" }} checked={fb.worked === v} onChange={() => upd(i, "worked", v)} />{v}
                      </label>
                    ))}
                  </div>
                </div>
                <div style={{ marginBottom:8 }}>
                  <div style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.65rem", color:"#5a7a94", textTransform:"uppercase", letterSpacing:1, marginBottom:5 }}>Notes — what worked / didn't</div>
                  <textarea value={fb.notes} onChange={e => upd(i, "notes", e.target.value)} placeholder="e.g. Drain mouths productive on falling tide..." style={{ minHeight:56 }} />
                </div>
                {fb.worked !== "yes" && fb.notes && (
                  <>
                    <label style={{ display:"flex", alignItems:"center", gap:7, fontFamily:"IBM Plex Mono,monospace", fontSize:"0.68rem", color:"#5a7a94", cursor:"pointer", marginBottom:8 }}>
                      <input type="checkbox" checked={fb.createRule} onChange={e => upd(i, "createRule", e.target.checked)} style={{ width:"auto" }} />
                      Create a rule from this feedback
                    </label>
                    {fb.createRule && (
                      <>
                        <div style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.65rem", color:"#5a7a94", textTransform:"uppercase", letterSpacing:1, marginBottom:6 }}>Affected zones</div>
                        <div style={{ display:"flex", flexWrap:"wrap", gap:6, marginBottom:8 }}>
                          {ZONES.map(z => (
                            <div key={z.id} onClick={() => togZone(i, z.id)} style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.65rem", padding:"4px 10px", borderRadius:16, border:`1px solid ${fb.ruleZones.includes(z.id) ? "#4ab0ff" : "#1e3048"}`, color: fb.ruleZones.includes(z.id) ? "#4ab0ff" : "#5a7a94", background: fb.ruleZones.includes(z.id) ? "rgba(74,176,255,0.08)" : "transparent", cursor:"pointer", userSelect:"none" }}>
                              {z.label.split(" ").slice(0,3).join(" ")}
                            </div>
                          ))}
                        </div>
                        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                          <div style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.65rem", color:"#5a7a94", textTransform:"uppercase", letterSpacing:1 }}>Rule type</div>
                          <select value={fb.ruleFlag} onChange={e => upd(i, "ruleFlag", e.target.value)} style={{ maxWidth:140 }}>
                            <option value="avoid">Avoid</option>
                            <option value="caution">Caution</option>
                          </select>
                        </div>
                      </>
                    )}
                  </>
                )}
              </div>
            );
          })}

          {/* GENERAL NOTES */}
          <div style={{ marginBottom:14 }}>
            <div style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.65rem", color:"#5a7a94", textTransform:"uppercase", letterSpacing:1, marginBottom:6 }}>General Notes</div>
            <textarea value={general} onChange={e => setGeneral(e.target.value)} placeholder="Water clarity, bait activity, anything notable..." style={{ minHeight:64 }} />
          </div>
          <div style={{ display:"flex", gap:10 }}>
            <button className="btn btn-primary" onClick={submit}>Save Debrief & Rules</button>
            <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function FishingTool() {
  const [tab, setTab] = useState("setup");
  const [coords, setCoords] = useState([{lat:"",lng:""},{lat:"",lng:""},{lat:"",lng:""},{lat:"",lng:""}]);
  const coordsRef = useRef([{lat:"",lng:""},{lat:"",lng:""},{lat:"",lng:""},{lat:"",lng:""}]);
  const [zones, setZones] = useState([]);
  const [mapExpanded, setMapExpanded] = useState(true);
  const [tripStart, setTripStart] = useState("");
  const [tripEnd,   setTripEnd]   = useState("");
  const [blocks, setBlocks] = useState([]);
  const [notes, setNotes] = useState("");
  const [plan, setPlan] = useState(null);
  const [userRules, setUserRules] = useState([]);
  const [trips, setTrips] = useState([]);
  const [savedPresets, setSavedPresets] = useState([]);
  const [presetNameInput, setPresetNameInput] = useState("");
  const [showPresetInput, setShowPresetInput] = useState(false);
  const [currentUser, setCurrentUser] = useState(null);
  const [showFeedback, setShowFeedback] = useState(false);

  // Scout / Compare
  const [compareDate, setCompareDate] = useState(new Date().toISOString().slice(0,10));
  const [compareTripStart, setCompareTripStart] = useState("06:30");
  const [compareTripEnd, setCompareTripEnd] = useState("12:00");
  const [compareResults, setCompareResults] = useState([]);
  const [compareLoading, setCompareLoading] = useState(false);

  // Tide
  const [tideStation, setTideStation] = useState("");
  const [tideStation2, setTideStation2] = useState("");
  const [blendWeight, setBlendWeight] = useState(0.5);
  const [tideDate, setTideDate] = useState(new Date().toISOString().slice(0,10));
  const [tidePreds, setTidePreds] = useState([]);
  const [tidePreds2, setTidePreds2] = useState([]);
  const [tideLoading, setTideLoading] = useState(false);
  const [tideErr, setTideErr] = useState("");

  // River
  const [riverFt, setRiverFt] = useState(null);
  const [pearlRiverFt, setPearlRiverFt] = useState(null);
  const [riverLoading, setRiverLoading] = useState(false);
  const [riverErr, setRiverErr] = useState("");

  // Water temp
  const [waterTempF, setWaterTempF] = useState(null);

  // Water quality
  const [waterQuality, setWaterQuality] = useState([]);
  const [wqLoading, setWqLoading] = useState(false);
  const [wqErr, setWqErr] = useState("");

  // Wind forecast
  const [windForecast, setWindForecast] = useState([]);
  const [windModel, setWindModel] = useState("ecmwf_ifs025");
  const [windLoading, setWindLoading] = useState(false);
  const [windErr, setWindErr] = useState("");

  useEffect(() => {
    (async () => {
      const r = await storageGet("user_rules"); if (r) setUserRules(r);
      const t = await storageGet("saved_trips"); if (t) setTrips(t);
    })();
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user) { setCurrentUser(null); return; }
      try {
        const accessSnap = await getDoc(doc(db, "config", "access"));
        const allowed = accessSnap.data()?.allowedEmails ?? [];
        if (!allowed.includes(user.email)) {
          await signOut(auth);
          setCurrentUser({ denied: true });
          return;
        }
      } catch {}
      setCurrentUser(user);
      try {
        const q = query(collection(db, "users", user.uid, "trips"), orderBy("createdAt", "desc"), limit(30));
        const snap = await getDocs(q);
        const cloud = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        if (cloud.length) setTrips(cloud);
      } catch {}
      try {
        const pSnap = await getDocs(collection(db, "users", user.uid, "savedPresets"));
        const presets = pSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        if (presets.length) setSavedPresets(presets);
      } catch {}
      try {
        const rSnap = await getDocs(collection(db, "sharedRules"));
        const cloudRules = rSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        if (cloudRules.length) {
          setUserRules(cloudRules);
        } else {
          const local = await storageGet("user_rules");
          if (local?.length) {
            setUserRules(local);
            await Promise.all(local.map(r => setDoc(doc(db, "sharedRules", String(r.id)), { ...r, addedBy: user.email })));
          }
        }
      } catch {}
    });
    return () => unsub();
  }, []);

  const allRules = [...BUILTIN_RULES, ...userRules];

  const emptyCoords = [{lat:"",lng:""},{lat:"",lng:""},{lat:"",lng:""},{lat:"",lng:""}];

  const handleCoordsChange = (newCoordsOrUpdater) => {
    const newCoords = typeof newCoordsOrUpdater === "function"
      ? newCoordsOrUpdater(coordsRef.current)
      : newCoordsOrUpdater;
    coordsRef.current = newCoords;
    setCoords(newCoords);
    const poly = newCoords
      .filter(c => c.lat !== "" && c.lng !== "" && !isNaN(parseFloat(c.lat)) && !isNaN(parseFloat(c.lng)))
      .map(c => ({ lat: parseFloat(c.lat), lng: parseFloat(c.lng) }));
    const auto = poly.length >= 3
      ? ZONES.filter(z => z.id === "lake-borgne" || pointInPolygon({ lat: z.lat, lng: z.lng }, poly) || distToPolygonEdge({ lat: z.lat, lng: z.lng }, poly) <= 1).map(z => z.id)
      : ["lake-borgne"];
    setZones(auto);
  };

  const handleSignOut = async () => {
    await signOut(auth);
    setCoords(emptyCoords);
    setZones(["lake-borgne"]);
    setTripStart(""); setTripEnd("");
    setBlocks([]);
    setTideStation(""); setTideStation2("");
    setWaterTempF(null);
    setNotes(""); setPlan(null);
  };

  const upd = (i, f, v) => setBlocks(p => p.map((b, j) => j === i ? { ...b, [f]: v } : b));
  const add = () => { const l = blocks[blocks.length-1]; setBlocks(p => [...p, { startTime: l.endTime, endTime: "16:00", tideDir: "rising", tideChange: 0.25, windDir: "S", windSpeed: 10 }]); };
  const rem = i => setBlocks(p => p.filter((_, j) => j !== i));
  const togZone = zid => setZones(p => p.includes(zid) ? p.filter(z => z !== zid) : [...p, zid]);

  const [fetchLoading, setFetchLoading] = useState(false);
  const [fetchStatus, setFetchStatus] = useState([]);

  const fetchAll = async () => {
    setFetchLoading(true);
    setFetchStatus([]);
    setTidePreds([]);
    setTidePreds2([]);
    const status = [];
    const log = msg => { status.push(msg); setFetchStatus([...status]); };

    const validCoords = coords.filter(c => !isNaN(parseFloat(c.lat)) && !isNaN(parseFloat(c.lng)));
    const hasCoords = validCoords.length > 0;
    const lat = hasCoords ? (validCoords.reduce((s,c) => s + parseFloat(c.lat), 0) / validCoords.length).toFixed(4) : null;
    const lng = hasCoords ? (validCoords.reduce((s,c) => s + parseFloat(c.lng), 0) / validCoords.length).toFixed(4) : null;

    await Promise.allSettled([
      (async () => {
        try {
          log("Fetching tides…");
          const p1 = await fetchNOAATides(tideStation, tideDate);
          setTidePreds(p1);
          log("✓ Tides");
        } catch (e) { log("✗ Tides: " + (e.message || "failed")); }
      })(),
      (async () => {
        if (!tideStation2) return;
        try {
          log("Fetching tides (2nd station)…");
          const p2 = await fetchNOAATides(tideStation2, tideDate);
          setTidePreds2(p2);
          log("✓ Tides (2nd station)");
        } catch (e) { log("✗ Tides (2nd station): " + (e.message || "failed")); }
      })(),
      (async () => {
        if (!hasCoords) { log("✗ Wind: select 4 pts on map for wind forecast"); return; }
        try {
          log("Fetching wind…");
          const wf = await fetchWindForecast(lat, lng, tideDate, windModel);
          setWindForecast(wf);
          log("✓ Wind");
        } catch (e) { log("✗ Wind: " + (e.message || "failed")); }
      })(),
      (async () => {
        // Try stations in order until one returns water temp data
        const fallbacks = [...new Set([tideStation, tideStation2, "8761305", "8761724"].filter(Boolean))];
        let found = false;
        for (const sid of fallbacks) {
          try {
            log("Fetching water temp…");
            setWaterTempF(await fetchWaterTemp(sid));
            log("✓ Water temp");
            found = true;
            break;
          } catch {}
        }
        if (!found) log("✗ Water temp: unavailable");
      })(),
      (async () => {
        try {
          log("Fetching river…");
          setRiverFt(await fetchRiverGauge("07374000"));
          log("✓ River gauge");
        } catch { log("✗ River gauge: failed"); }
      })(),
      (async () => {
        try {
          log("Fetching Pearl River…");
          setPearlRiverFt(await fetchRiverGauge("02492000"));
          log("✓ Pearl River gauge");
        } catch { log("✗ Pearl River gauge: failed"); }
      })(),
      (async () => {
        try {
          log("Fetching water quality…");
          setWaterQuality(await fetchWaterQuality());
          log("✓ Water quality");
        } catch (e) { log("✗ Water quality: " + (e.message || "failed")); }
      })(),
    ]);

    setFetchLoading(false);
  };

  const autoGenerateBlocks = () => {
    if (!tidePreds.length) return;
    const b = buildBlocksFromData(tidePreds, tidePreds2, blendWeight, windForecast, tripStart, tripEnd);
    if (b.length) setBlocks(b);
  };

  const buildPlanArgs = () => {
    const rigoletsSal = waterQuality.find(s => s.id === "301001089442600")?.salNow ?? null;
    const moon = tideDate ? getMoonPhase(tideDate) : null;
    const pressures = windForecast.map(w => w.pressure).filter(Boolean);
    const pressureTrend = pressures.length >= 6
      ? (() => { const e = pressures.slice(0,3).reduce((a,b)=>a+b,0)/3; const l = pressures.slice(-3).reduce((a,b)=>a+b,0)/3; return l - e > 1 ? "rising" : l - e < -1 ? "falling" : "steady"; })()
      : "steady";
    return { rigoletsSal, moon, pressureTrend };
  };

  const generate = () => {
    const { rigoletsSal, moon, pressureTrend } = buildPlanArgs();
    setPlan(generatePlan(blocks, zones, allRules, riverFt, rigoletsSal, pearlRiverFt, moon, pressureTrend, waterTempF, tideDate));
    setTab("plan");
  };

  const switchToZone = (zoneId) => {
    const newZones = zones.includes(zoneId) ? zones : [...zones, zoneId];
    setZones(newZones);
    const { rigoletsSal, moon, pressureTrend } = buildPlanArgs();
    setPlan(generatePlan(blocks, newZones, allRules, riverFt, rigoletsSal, pearlRiverFt, moon, pressureTrend, waterTempF, tideDate));
  };

  const runCompare = async () => {
    if (!compareDate || !compareTripStart || !compareTripEnd || !savedPresets.length) return;
    setCompareLoading(true);
    setCompareResults([]);
    // Fetch shared data once
    let sRiverFt = null, sPearlRiverFt = null, sWaterQuality = [], sWaterTempF = null;
    await Promise.allSettled([
      fetchRiverGauge("07374000").then(v => sRiverFt = v).catch(() => {}),
      fetchRiverGauge("02492000").then(v => sPearlRiverFt = v).catch(() => {}),
      fetchWaterQuality().then(v => sWaterQuality = v).catch(() => {}),
      fetchWaterTemp("8761305").then(v => sWaterTempF = v).catch(() => {}),
    ]);
    const sharedData = { riverFt: sRiverFt, pearlRiverFt: sPearlRiverFt, waterQuality: sWaterQuality, waterTempF: sWaterTempF };
    const month = new Date(compareDate + "T12:00:00").getMonth() + 1;
    const season = month <= 2 || month === 12 ? "winter" : month <= 5 ? "spring" : month <= 8 ? "summer" : "fall";
    const highRiver = sRiverFt !== null && sRiverFt > 12;
    const highPearlRiver = sPearlRiverFt !== null && sPearlRiverFt > 10;
    const rigoletsSal = sWaterQuality.find(s => s.id === "301001089442600")?.salNow ?? null;

    const results = await Promise.all(savedPresets.map(async preset => {
      let tidePreds1 = [], tidePreds2p = [], windForecastP = [];
      await Promise.allSettled([
        fetchNOAATides(preset.tideStation, compareDate).then(v => tidePreds1 = v).catch(() => {}),
        preset.tideStation2 ? fetchNOAATides(preset.tideStation2, compareDate).then(v => tidePreds2p = v).catch(() => {}) : Promise.resolve(),
        (() => {
          const vc = (preset.coords||[]).filter(c => !isNaN(parseFloat(c.lat)) && !isNaN(parseFloat(c.lng)));
          if (!vc.length) return Promise.resolve();
          const lat = (vc.reduce((s,c) => s+parseFloat(c.lat),0)/vc.length).toFixed(4);
          const lng = (vc.reduce((s,c) => s+parseFloat(c.lng),0)/vc.length).toFixed(4);
          return fetchWindForecast(lat, lng, compareDate, windModel).then(v => windForecastP = v).catch(() => {});
        })(),
      ]);
      const pBlocks = buildBlocksFromData(tidePreds1, tidePreds2p, preset.blendWeight ?? 0, windForecastP, compareTripStart, compareTripEnd);
      if (!pBlocks.length) return { preset, sharedData, tidePreds1, tidePreds2p, windForecastP, blocks: pBlocks, blockScores: [], avgScore: 0, peakBlock: null, error: "No tide data" };
      const blockScores = pBlocks.map(block => {
        const zoneScores = (preset.zones||[]).map(zid => ({
          zoneId: zid,
          label: ZONES.find(z => z.id === zid)?.label ?? zid,
          score: scoreZone(zid, { tideDir: block.tideDir, windDir: block.windDir, windSpeed: block.windSpeed, season, highRiver, highPearlRiver, rigoletsSal }),
        })).sort((a,b) => b.score - a.score);
        return { ...block, topZone: zoneScores[0] ?? null, allZones: zoneScores };
      });
      const scores = blockScores.map(b => b.topZone?.score ?? 0);
      const avgScore = scores.reduce((a,b) => a+b, 0) / scores.length;
      const peakBlock = blockScores.reduce((best,b) => (b.topZone?.score ?? 0) >= (best?.topZone?.score ?? 0) ? b : best, blockScores[0]);
      return { preset, sharedData, tidePreds1, tidePreds2p, windForecastP, blocks: pBlocks, blockScores, avgScore, peakBlock };
    }));

    results.sort((a,b) => b.avgScore - a.avgScore);
    setCompareResults(results);
    setCompareLoading(false);
  };

  const loadFromCompare = (result) => {
    loadPreset(result.preset);
    setTidePreds(result.tidePreds1);
    setTidePreds2(result.tidePreds2p);
    setWindForecast(result.windForecastP);
    setTideDate(compareDate);
    setRiverFt(result.sharedData.riverFt);
    setPearlRiverFt(result.sharedData.pearlRiverFt);
    setWaterQuality(result.sharedData.waterQuality);
    setWaterTempF(result.sharedData.waterTempF);
    setBlocks(result.blocks);
    setTripStart(compareTripStart);
    setTripEnd(compareTripEnd);
    const rigoletsSal = result.sharedData.waterQuality.find(s => s.id === "301001089442600")?.salNow ?? null;
    const moon = getMoonPhase(compareDate);
    const pressures = result.windForecastP.map(w => w.pressure).filter(Boolean);
    const pressureTrend = pressures.length >= 6
      ? (() => { const e = pressures.slice(0,3).reduce((a,b)=>a+b,0)/3; const l = pressures.slice(-3).reduce((a,b)=>a+b,0)/3; return l - e > 1 ? "rising" : l - e < -1 ? "falling" : "steady"; })()
      : "steady";
    setPlan(generatePlan(result.blocks, result.preset.zones, allRules, result.sharedData.riverFt, rigoletsSal, result.sharedData.pearlRiverFt, moon, pressureTrend, result.sharedData.waterTempF, compareDate));
    setTab("plan");
  };

  const postToNetlify = (fields) =>
    fetch("/", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ "form-name": "trip-debrief", ...fields }).toString(),
    }).catch(() => {});

  const saveTrip = async () => {
    const tripId = String(Date.now());
    const trip = { id: tripId, date: new Date().toLocaleDateString(), coords, zones, blocks, notes, plan, riverFt, tideStation, tideDate, createdAt: Date.now() };
    const updated = [trip, ...trips].slice(0, 30);
    setTrips(updated); await storageSet("saved_trips", updated);
    if (currentUser) {
      try { await setDoc(doc(db, "users", currentUser.uid, "trips", tripId), trip); } catch {}
    }
    postToNetlify({
      date: trip.date,
      zones: zones.join(", "),
      tide_station: tideStation,
      tide_date: tideDate,
      river_ft: riverFt ?? "",
      pearl_river_ft: pearlRiverFt ?? "",
      plan: plan?.strategy ?? "",
      notes,
      debrief: "",
      new_rules: "",
    });
  };

  const saveFeedback = async (newRules, debrief, blockFeedbacks) => {
    // Compute confidence updates from block feedbacks
    const ruleUpdates = {};
    if (blockFeedbacks?.length && plan) {
      blockFeedbacks.forEach((fb, i) => {
        const block = plan[i];
        if (!block) return;
        userRules.forEach(rule => {
          if (zones.some(z => rule.zones.includes(z)) && matchRule(rule, block)) {
            if (!ruleUpdates[rule.id]) ruleUpdates[rule.id] = { confirms: rule.confirms || 0, contradicts: rule.contradicts || 0 };
            fb.worked === "yes" ? ruleUpdates[rule.id].contradicts++ : ruleUpdates[rule.id].confirms++;
          }
        });
      });
    }

    const newRulesWithCounters = newRules.map(r => ({ ...r, confirms: 0, contradicts: 0 }));
    const updated = [
      ...userRules.map(r => ruleUpdates[r.id] ? { ...r, ...ruleUpdates[r.id] } : r),
      ...newRulesWithCounters,
    ];
    setUserRules(updated); await storageSet("user_rules", updated);
    if (currentUser) {
      try {
        await Promise.all([
          ...newRulesWithCounters.map(r => setDoc(doc(db, "sharedRules", String(r.id)), { ...r, addedBy: currentUser.email })),
          ...Object.entries(ruleUpdates).map(([id, counts]) => setDoc(doc(db, "sharedRules", id), counts, { merge: true })),
        ]);
      } catch {}
    }
    const tripId = String(Date.now());
    const trip = { id: tripId, date: new Date().toLocaleDateString(), coords, zones, blocks, notes, plan, riverFt, tideStation, tideDate, createdAt: Date.now(), debriefed: true, debrief };
    const updatedT = [trip, ...trips].slice(0, 30);
    setTrips(updatedT); await storageSet("saved_trips", updatedT);
    if (currentUser) {
      try { await setDoc(doc(db, "users", currentUser.uid, "trips", tripId), trip); } catch {}
    }
    const catchSummary = (debrief.catchLog || []).map(c => `${c.count} ${c.species} (${c.size}) on ${c.bait} at ${c.zone}`).join("; ");
    postToNetlify({
      date: trip.date,
      zones: zones.join(", "),
      tide_station: tideStation,
      tide_date: tideDate,
      river_ft: riverFt ?? "",
      pearl_river_ft: pearlRiverFt ?? "",
      plan: plan?.strategy ?? "",
      notes,
      debrief: debrief.general ?? "",
      new_rules: newRules.map(r => r.reason).join(" | "),
      target_species: (debrief.targetSpecies || []).join(", "),
      catch_log: catchSummary,
      rating: debrief.rating ?? "",
    });
  };

  const deleteRule = async id => {
    const updated = userRules.filter(r => r.id !== id);
    setUserRules(updated); await storageSet("user_rules", updated);
    if (currentUser) {
      try { await deleteDoc(doc(db, "sharedRules", String(id))); } catch {}
    }
  };

  const savePreset = async () => {
    const name = presetNameInput.trim();
    if (!name || !currentUser) return;
    if (savedPresets.length >= 3) return;
    const preset = { id: `preset-${Date.now()}`, name, coords, zones, tideStation, tideStation2, blendWeight, savedAt: Date.now() };
    const updated = [...savedPresets, preset];
    setSavedPresets(updated);
    setPresetNameInput("");
    setShowPresetInput(false);
    try { await setDoc(doc(db, "users", currentUser.uid, "savedPresets", preset.id), preset); } catch {}
  };

  const loadPreset = p => {
    setCoords(p.coords);
    setZones(p.zones);
    if (p.tideStation) setTideStation(p.tideStation);
    if (p.tideStation2 !== undefined) setTideStation2(p.tideStation2);
    if (p.blendWeight !== undefined) setBlendWeight(p.blendWeight);
  };

  const deletePreset = async id => {
    setSavedPresets(p => p.filter(x => x.id !== id));
    if (currentUser) {
      try { await deleteDoc(doc(db, "users", currentUser.uid, "savedPresets", id)); } catch {}
    }
  };

  const loadTrip = t => {
    setBlocks(t.blocks); setZones(t.zones); setCoords(t.coords); setNotes(t.notes || ""); setPlan(t.plan);
    if (t.riverFt !== undefined) setRiverFt(t.riverFt);
    if (t.tideStation) setTideStation(t.tideStation);
    if (t.tideDate) setTideDate(t.tideDate);
    setTab("plan");
  };

  if (currentUser?.denied) return (
    <div style={{ minHeight:"100vh", background:"#0a0f14", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:16, color:"#d0e4f0", fontFamily:"IBM Plex Mono, monospace" }}>
      <div style={{ fontSize:"1.1rem", color:"#e05a2b" }}>Access Denied</div>
      <div style={{ fontSize:"0.75rem", color:"#5a7a94" }}>Your account is not authorized to use this app.</div>
      <button onClick={() => { setCurrentUser(null); }} style={{ marginTop:8, padding:"8px 20px", background:"transparent", border:"1px solid #5a7a94", borderRadius:6, color:"#5a7a94", cursor:"pointer", fontFamily:"IBM Plex Mono, monospace", fontSize:"0.7rem" }}>Sign Out</button>
    </div>
  );

  const riverColor = riverFt === null ? "#5a7a94" : riverFt > 12 ? "#e05a2b" : "#00c8a0";

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=IBM+Plex+Mono:wght@400;600&family=IBM+Plex+Sans:wght@300;400;600&display=swap');
        *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
        :root{--bg:#0a0f14;--sf:#111820;--bd:#1e3048;--ac:#00c8a0;--ac2:#f0a500;--wn:#e05a2b;--bl:#4ab0ff;--tx:#d0e4f0;--mu:#5a7a94;--r:8px}
        body{background:var(--bg);color:var(--tx);font-family:'IBM Plex Sans',sans-serif}
        .app{max-width:920px;margin:0 auto;padding:0 0 80px;min-height:100vh}
        .hdr{background:linear-gradient(135deg,#0a0f14 0%,#0d1c2e 100%);border-bottom:1px solid var(--bd);padding:22px 30px 16px;position:sticky;top:0;z-index:100;display:flex;align-items:flex-end;justify-content:space-between;gap:12px;flex-wrap:wrap}
        .htitle{font-family:'Bebas Neue',sans-serif;font-size:2.1rem;letter-spacing:3px;color:var(--ac);line-height:1}
        .hsub{font-family:'IBM Plex Mono',monospace;font-size:0.65rem;color:var(--mu);letter-spacing:2px;text-transform:uppercase;margin-top:3px}
        .tabs{display:flex;border-bottom:1px solid var(--bd);padding:0 30px;background:var(--sf);overflow-x:auto}
        .tab{font-family:'IBM Plex Mono',monospace;font-size:0.7rem;letter-spacing:1px;text-transform:uppercase;padding:11px 16px;cursor:pointer;color:var(--mu);border-bottom:2px solid transparent;background:none;border-top:none;border-left:none;border-right:none;transition:all .2s;white-space:nowrap}
        .tab.on{color:var(--ac);border-bottom-color:var(--ac)}
        .tab:hover:not(.on){color:var(--tx)}
        .cnt{padding:22px 30px}
        .sl{font-family:'IBM Plex Mono',monospace;font-size:0.6rem;letter-spacing:3px;text-transform:uppercase;color:var(--ac);margin-bottom:11px;display:flex;align-items:center;gap:10px}
        .sl::after{content:'';flex:1;height:1px;background:var(--bd)}
        .card{background:var(--sf);border:1px solid var(--bd);border-radius:var(--r);padding:16px;margin-bottom:16px}
        .two{display:grid;grid-template-columns:1fr 1fr;gap:16px}
        .cgrid{display:grid;grid-template-columns:1fr 1fr;gap:7px}
        .crow{display:flex;gap:5px;align-items:center}
        .clbl{font-family:'IBM Plex Mono',monospace;font-size:0.65rem;color:var(--mu);width:30px;flex-shrink:0}
        input,select,textarea{background:var(--bg);border:1px solid var(--bd);border-radius:5px;color:var(--tx);font-family:'IBM Plex Mono',monospace;font-size:0.78rem;padding:7px 9px;outline:none;transition:border-color .15s;width:100%}
        input:focus,select:focus,textarea:focus{border-color:var(--ac)}
        textarea{resize:vertical;min-height:68px}
        .zpills{display:flex;flex-wrap:wrap;gap:7px}
        .zp{font-family:'IBM Plex Mono',monospace;font-size:0.68rem;padding:5px 11px;border-radius:16px;cursor:pointer;border:1px solid var(--bd);color:var(--mu);background:var(--bg);transition:all .15s;user-select:none}
        .zp.on{border-color:var(--ac);color:var(--ac);background:rgba(0,200,160,.08)}
        .tbf{background:var(--bg);border:1px solid var(--bd);border-radius:var(--r);padding:13px;margin-bottom:9px}
        .fr{display:flex;align-items:center;gap:7px;margin-bottom:7px;flex-wrap:wrap}
        .fr label{font-family:'IBM Plex Mono',monospace;font-size:0.63rem;color:var(--mu);letter-spacing:1px;text-transform:uppercase;white-space:nowrap;min-width:44px}
        .btn{font-family:'IBM Plex Mono',monospace;font-size:0.76rem;letter-spacing:1.5px;text-transform:uppercase;padding:10px 20px;border-radius:var(--r);cursor:pointer;border:none;transition:all .15s}
        .btn-primary{background:var(--ac);color:#000;font-weight:600}
        .btn-primary:hover{background:#00e0b3}
        .btn-secondary{background:transparent;color:var(--ac);border:1px solid var(--ac)}
        .btn-secondary:hover{background:rgba(0,200,160,.08)}
        .btn-warn{background:transparent;color:var(--wn);border:1px solid var(--wn)}
        .btn-warn:hover{background:rgba(224,90,43,.08)}
        .btn-sm{font-size:0.66rem;padding:6px 13px}
        .brow{display:flex;gap:9px;align-items:center;flex-wrap:wrap}
        .rm-btn{font-family:'IBM Plex Mono',monospace;font-size:0.62rem;color:var(--wn);background:none;border:1px solid var(--wn);border-radius:4px;padding:3px 8px;cursor:pointer;margin-top:3px}
        .bc{background:var(--sf);border:1px solid var(--bd);border-radius:var(--r);margin-bottom:11px;overflow:hidden}
        .bc.falling{border-left:3px solid var(--ac)}
        .bc.rising{border-left:3px solid var(--bl)}
        .bc.slack{border-left:3px solid var(--mu)}
        .bc.bw{border-top:2px solid var(--wn)}
        .bh{display:flex;justify-content:space-between;align-items:center;padding:12px 15px;cursor:pointer;user-select:none}
        .bt{font-family:'Bebas Neue',sans-serif;font-size:1.2rem;letter-spacing:1.5px}
        .ti{font-size:1rem;font-weight:bold}
        .ti.falling{color:var(--ac)}.ti.rising{color:var(--bl)}.ti.slack{color:var(--mu)}
        .badge{font-family:'IBM Plex Mono',monospace;font-size:0.6rem;padding:2px 7px;border-radius:10px;letter-spacing:.5px;text-transform:uppercase}
        .tb-falling{background:rgba(0,200,160,.12);color:var(--ac)}
        .tb-rising{background:rgba(74,176,255,.12);color:var(--bl)}
        .tb-slack{background:rgba(90,122,148,.12);color:var(--mu)}
        .wb{background:rgba(240,165,0,.12);color:var(--ac2)}
        .bb{padding:0 15px 15px;border-top:1px solid var(--bd)}
        .he{background:var(--sf);border:1px solid var(--bd);border-radius:var(--r);padding:13px 15px;margin-bottom:7px;cursor:pointer;transition:border-color .15s}
        .he:hover{border-color:var(--ac)}
        .hd{font-family:'IBM Plex Mono',monospace;font-size:0.68rem;color:var(--ac);margin-bottom:3px}
        .hm{font-size:0.77rem;color:var(--mu)}
        .rc{background:var(--bg);border:1px solid var(--bd);border-radius:var(--r);padding:12px 15px;margin-bottom:8px}
        .rc.bi{border-left:3px solid var(--wn)}
        .rc.ur{border-left:3px solid var(--bl)}
        .rtitle{font-family:'IBM Plex Mono',monospace;font-size:0.65rem;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px}
        .rdesc{font-size:0.8rem;color:var(--tx);line-height:1.5}
        .rmeta{font-family:'IBM Plex Mono',monospace;font-size:0.6rem;color:var(--mu);margin-top:4px}
        .del-btn{font-family:'IBM Plex Mono',monospace;font-size:0.6rem;color:var(--mu);background:none;border:1px solid var(--bd);border-radius:4px;padding:2px 7px;cursor:pointer;flex-shrink:0}
        .del-btn:hover{color:var(--wn);border-color:var(--wn)}
        @media(max-width:640px){.cnt{padding:16px 14px}.hdr{padding:14px 14px}.tabs{padding:0 14px}.two{grid-template-columns:1fr}.cgrid{grid-template-columns:1fr}.htitle{font-size:1.7rem}}
      `}</style>

      <div className="app">
        <div className="hdr">
          <div>
            <div className="htitle">MARSH INTEL</div>
            <div className="hsub">Inshore Fishing Decision Tool — SE Louisiana</div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            {currentUser ? (
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span style={{ fontFamily: "IBM Plex Mono, monospace", fontSize: "0.6rem", color: "var(--mu)" }}>{currentUser.displayName || currentUser.email}</span>
                <button className="btn btn-secondary btn-sm" onClick={handleSignOut}>Sign Out</button>
              </div>
            ) : (
              <button className="btn btn-secondary btn-sm" onClick={() => signInWithPopup(auth, provider)}>Sign in with Google</button>
            )}
            {riverFt !== null && (
              <div style={{ fontFamily: "IBM Plex Mono, monospace", fontSize: "0.7rem", padding: "4px 12px", borderRadius: 20, border: `1px solid ${riverColor}`, color: riverColor, background: `${riverColor}15` }}>
                Mississippi {riverFt.toFixed(1)}ft {riverFt > 12 ? "⚠ HIGH" : "✓ OK"}
              </div>
            )}
            {pearlRiverFt !== null && (() => {
              const c = pearlRiverFt > 10 ? "#e05a2b" : pearlRiverFt > 6 ? "#c8a000" : "#00c8a0";
              return (
                <div style={{ fontFamily: "IBM Plex Mono, monospace", fontSize: "0.7rem", padding: "4px 12px", borderRadius: 20, border: `1px solid ${c}`, color: c, background: `${c}15` }}>
                  Pearl River {pearlRiverFt.toFixed(1)}ft {pearlRiverFt > 10 ? "⚠ HIGH" : "✓ OK"}
                </div>
              );
            })()}
          </div>
        </div>

        <div className="tabs">
          {[["setup","Trip Setup"],["scout","Scout"],["plan","Game Plan"],["map","Map"],["rules","Rules DB"],["history","History"]].map(([id, lbl]) => (
            <button key={id} className={`tab ${tab === id ? "on" : ""}`} onClick={() => {
              if (id === "plan" && !plan) generate();
              else setTab(id);
            }}>{id === "plan" && !plan ? "Game Plan —" : lbl}</button>
          ))}
        </div>

        <div className="cnt">

          {/* SETUP */}
          {tab === "setup" && (
            <>
              {/* ── SAVED PRESETS ─────────────────────────────── */}
              {currentUser && (
                <div style={{ marginBottom:16 }}>
                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8 }}>
                    <div style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.62rem", letterSpacing:2, textTransform:"uppercase", color:"var(--mu)" }}>Saved Zones ({savedPresets.length}/3)</div>
                    {savedPresets.length < 3 && !showPresetInput && (
                      <button className="rm-btn" style={{ color:"var(--ac)", borderColor:"var(--ac)" }} onClick={() => setShowPresetInput(true)}>+ Save Current</button>
                    )}
                  </div>
                  {showPresetInput && (
                    <div style={{ display:"flex", gap:7, marginBottom:8 }}>
                      <input value={presetNameInput} onChange={e => setPresetNameInput(e.target.value)} placeholder="Preset name (e.g. Home Marsh)" onKeyDown={e => e.key === "Enter" && savePreset()} style={{ flex:1 }} />
                      <button className="btn btn-primary" style={{ padding:"6px 14px", fontSize:"0.75rem" }} onClick={savePreset}>Save</button>
                      <button className="btn btn-secondary" style={{ padding:"6px 10px", fontSize:"0.75rem" }} onClick={() => { setShowPresetInput(false); setPresetNameInput(""); }}>✕</button>
                    </div>
                  )}
                  {savedPresets.length > 0 && (
                    <div style={{ display:"flex", flexWrap:"wrap", gap:7 }}>
                      {savedPresets.map(p => (
                        <div key={p.id} style={{ display:"flex", alignItems:"center", gap:0, background:"var(--bg)", border:"1px solid var(--bd)", borderRadius:8, overflow:"hidden" }}>
                          <button onClick={() => loadPreset(p)} style={{ background:"none", border:"none", color:"var(--ac)", fontFamily:"IBM Plex Mono,monospace", fontSize:"0.72rem", padding:"6px 12px", cursor:"pointer" }}>{p.name}</button>
                          <button onClick={() => deletePreset(p.id)} style={{ background:"none", border:"none", borderLeft:"1px solid var(--bd)", color:"#5a7a94", fontSize:"0.7rem", padding:"6px 9px", cursor:"pointer" }}>✕</button>
                        </div>
                      ))}
                    </div>
                  )}
                  {savedPresets.length === 0 && !showPresetInput && (
                    <div style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.72rem", color:"#5a7a94" }}>No presets saved yet. Set up your zones and tide stations, then save.</div>
                  )}
                </div>
              )}

              {/* ── TRIP DETAILS ─────────────────────────────── */}
              <div className="sl">Trip Details</div>
              <div className="card" style={{ marginBottom:18 }}>
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:10, marginBottom:12 }}>
                  <div>
                    <div style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.62rem", color:"var(--mu)", textTransform:"uppercase", letterSpacing:1, marginBottom:5 }}>Date</div>
                    <input type="date" value={tideDate} onChange={e => { setTideDate(e.target.value); setTidePreds([]); setTidePreds2([]); setWindForecast([]); }} />
                  </div>
                  <div>
                    <div style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.62rem", color:"var(--mu)", textTransform:"uppercase", letterSpacing:1, marginBottom:5 }}>Trip Start</div>
                    <TimeInput value={tripStart} onChange={setTripStart} />
                  </div>
                  <div>
                    <div style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.62rem", color:"var(--mu)", textTransform:"uppercase", letterSpacing:1, marginBottom:5 }}>Trip End</div>
                    <TimeInput value={tripEnd} onChange={setTripEnd} />
                  </div>
                </div>
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginBottom:12 }}>
                  <div>
                    <div style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.62rem", color:"var(--mu)", textTransform:"uppercase", letterSpacing:1, marginBottom:5 }}>Tide Station</div>
                    <select value={tideStation} onChange={e => { setTideStation(e.target.value); setTidePreds([]); setTidePreds2([]); }}>
                      <option value="">— Select Station —</option>
                      {TIDE_STATIONS.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
                    </select>
                  </div>
                  <div>
                    <div style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.62rem", color:"var(--mu)", textTransform:"uppercase", letterSpacing:1, marginBottom:5 }}>2nd Station (optional)</div>
                    <select value={tideStation2} onChange={e => { setTideStation2(e.target.value); setTidePreds2([]); }}>
                      <option value="">None</option>
                      {TIDE_STATIONS.filter(s => s.id !== tideStation).map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
                    </select>
                  </div>
                </div>
                {tideStation2 && (
                  <div style={{ marginBottom:12 }}>
                    <div style={{ display:"flex", justifyContent:"space-between", fontFamily:"IBM Plex Mono,monospace", fontSize:"0.62rem", color:"var(--mu)", marginBottom:5 }}>
                      <span style={{ color:"#00c8a0" }}>{TIDE_STATIONS.find(s=>s.id===tideStation)?.label}</span>
                      <span>Blend: {Math.round(blendWeight*100)}%</span>
                      <span style={{ color:"#4ab0ff" }}>{TIDE_STATIONS.find(s=>s.id===tideStation2)?.label}</span>
                    </div>
                    <input type="range" min="0" max="1" step="0.05" value={blendWeight} onChange={e => setBlendWeight(parseFloat(e.target.value))} style={{ width:"100%", accentColor:"var(--ac)", cursor:"pointer" }} />
                  </div>
                )}
                <div style={{ marginBottom:12 }}>
                  <div style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.62rem", color:"var(--mu)", textTransform:"uppercase", letterSpacing:1, marginBottom:5 }}>Wind Model</div>
                  <select value={windModel} onChange={e => setWindModel(e.target.value)}>
                    {WIND_MODELS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
                  </select>
                </div>
                <div style={{ display:"flex", gap:9, flexWrap:"wrap", alignItems:"center" }}>
                  <button className="btn btn-primary" onClick={fetchAll} disabled={fetchLoading}>
                    {fetchLoading ? "Fetching…" : "Fetch All →"}
                  </button>
                  {tidePreds.length > 0 && (
                    <button className="btn btn-secondary" onClick={autoGenerateBlocks}>Auto-Generate Blocks ↓</button>
                  )}
                </div>
                {fetchStatus.length > 0 && (
                  <div style={{ marginTop:10, display:"flex", flexWrap:"wrap", gap:6 }}>
                    {fetchStatus.map((s,i) => (
                      <span key={i} style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.63rem", color: s.startsWith("✓") ? "#00c8a0" : s.startsWith("✗") ? "#e05a2b" : "#5a7a94", background:"var(--bg)", border:"1px solid var(--bd)", borderRadius:10, padding:"2px 8px" }}>{s}</span>
                    ))}
                  </div>
                )}
              </div>

              {/* ── FULL-WIDTH MAP ── */}
              <div
                onClick={() => setMapExpanded(p => !p)}
                style={{ display:"flex", justifyContent:"space-between", alignItems:"center", cursor:"pointer", marginBottom: mapExpanded ? 6 : 0, marginTop:4, marginBottom:8 }}
              >
                <div style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.62rem", letterSpacing:2, textTransform:"uppercase", color:"var(--mu)" }}>
                  {mapExpanded ? "▲ Hide Map" : "▼ Show Map"}
                </div>
                <div style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.6rem", color:"#5a7a94" }}>Click map to add/move points · Edit coords on Map tab</div>
              </div>
              {mapExpanded && (
                <div style={{ marginBottom:16 }}>
                  <MapView coords={coords} selectedZones={zones} onCoordsChange={handleCoordsChange} />
                </div>
              )}

              <div className="two">
                {/* LEFT: Zones + River Gauges + Wind Forecast */}
                <div>
                  <div className="sl">Zones in Area</div>
                  <div className="card">
                    <div className="zpills">
                      {ZONES.map(z => <div key={z.id} className={`zp ${zones.includes(z.id)?"on":""}`} onClick={() => togZone(z.id)}>{z.label}</div>)}
                    </div>
                  </div>

                  {(riverFt !== null || pearlRiverFt !== null) && (
                    <>
                      <div className="sl">River Gauges</div>
                      <div className="card" style={{ display:"flex", flexDirection:"column", gap:10 }}>
                        {riverFt !== null && (() => {
                          const color = riverFt > 12 ? "#e05a2b" : "#00c8a0";
                          return (
                            <div>
                              <div style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.62rem", color:"var(--mu)", textTransform:"uppercase", letterSpacing:1, marginBottom:5 }}>Mississippi River — Carrollton</div>
                              <div style={{ display:"flex", alignItems:"center", gap:12 }}>
                                <div style={{ fontFamily:"Bebas Neue,sans-serif", fontSize:"2rem", color }}>{riverFt.toFixed(1)}<span style={{ fontSize:"1rem", marginLeft:4 }}>ft</span></div>
                                <div style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.7rem", color:"var(--mu)", lineHeight:1.55 }}>
                                  {riverFt > 16 ? "⚠ Very High — major freshwater. Reds only." : riverFt > 12 ? "⚠ Elevated — trout displaced toward Borgne." : riverFt > 8 ? "✓ Moderate — normal salinity expected." : "✓ Low — excellent clarity & salinity."}
                                </div>
                              </div>
                              <div style={{ height:6, background:"var(--bd)", borderRadius:4, overflow:"hidden", marginTop:7 }}>
                                <div style={{ height:"100%", borderRadius:4, width:`${Math.min(100,(riverFt/20)*100)}%`, background:color, transition:"width .6s ease" }} />
                              </div>
                            </div>
                          );
                        })()}
                        {pearlRiverFt !== null && (() => {
                          const color = pearlRiverFt > 10 ? "#e05a2b" : pearlRiverFt > 6 ? "#c8a000" : "#00c8a0";
                          return (
                            <div style={{ borderTop: riverFt !== null ? "1px solid var(--bd)" : "none", paddingTop: riverFt !== null ? 10 : 0 }}>
                              <div style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.62rem", color:"var(--mu)", textTransform:"uppercase", letterSpacing:1, marginBottom:5 }}>Pearl River — W. Pearl at Pearl River, LA</div>
                              <div style={{ display:"flex", alignItems:"center", gap:12 }}>
                                <div style={{ fontFamily:"Bebas Neue,sans-serif", fontSize:"2rem", color }}>{pearlRiverFt.toFixed(1)}<span style={{ fontSize:"1rem", marginLeft:4 }}>ft</span></div>
                                <div style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.7rem", color:"var(--mu)", lineHeight:1.55 }}>
                                  {pearlRiverFt > 10 ? "⚠ High — freshwater flooding Pearl River Marsh." : pearlRiverFt > 6 ? "⚠ Elevated — reduced salinity near river mouth." : "✓ Normal — good salinity at Pearl River mouth."}
                                </div>
                              </div>
                              <div style={{ height:6, background:"var(--bd)", borderRadius:4, overflow:"hidden", marginTop:7 }}>
                                <div style={{ height:"100%", borderRadius:4, width:`${Math.min(100,(pearlRiverFt/15)*100)}%`, background:color, transition:"width .6s ease" }} />
                              </div>
                            </div>
                          );
                        })()}
                      </div>
                    </>
                  )}

                  {windForecast.length > 0 && (
                    <>
                      <div className="sl">Wind Forecast</div>
                      <div className="card">
                        <svg viewBox="0 0 400 70" style={{ width:"100%", height:70, display:"block", marginBottom:4 }}>
                          {windForecast.map((w, i) => {
                            const maxSpd = Math.max(...windForecast.map(x => x.gust), 1);
                            const bW = 400 / windForecast.length;
                            const x = i * bW;
                            const gustH = (w.gust / maxSpd) * 52;
                            const spdH = (w.speed / maxSpd) * 52;
                            return (
                              <g key={i}>
                                <rect x={x + 1} y={60 - gustH} width={bW - 2} height={gustH} fill="rgba(74,176,255,0.15)" rx="1" />
                                <rect x={x + 1} y={60 - spdH} width={bW - 2} height={spdH} fill="#00c8a0" opacity="0.7" rx="1" />
                              </g>
                            );
                          })}
                          {blocks.map((b, bi) => {
                            const [sh, sm] = b.startTime.split(":").map(Number);
                            const [eh, em] = b.endTime.split(":").map(Number);
                            const startFrac = (sh * 60 + sm) / (24 * 60);
                            const endFrac = (eh * 60 + em) / (24 * 60);
                            return <rect key={bi} x={startFrac * 400} y={0} width={(endFrac - startFrac) * 400} height={60} fill="rgba(240,165,0,0.06)" />;
                          })}
                        </svg>
                        <div style={{ display:"flex", justifyContent:"space-between", fontFamily:"IBM Plex Mono,monospace", fontSize:"0.6rem", color:"#2a4060", marginBottom:10, paddingLeft:2 }}>
                          {windForecast.filter((_,i) => i % 3 === 0).map(w => <span key={w.time}>{w.time}</span>)}
                        </div>
                        <div style={{ display:"flex", gap:10, marginBottom:10 }}>
                          {[["#00c8a0","Wind speed"],["rgba(74,176,255,0.5)","Gusts"]].map(([c,l]) => (
                            <span key={l} style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.65rem", color:"var(--mu)", display:"flex", alignItems:"center", gap:5 }}>
                              <span style={{ width:10, height:10, background:c, display:"inline-block", borderRadius:2 }} />{l}
                            </span>
                          ))}
                          <span style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.65rem", color:"#c8a000", display:"flex", alignItems:"center", gap:5 }}>
                            <span style={{ width:10, height:10, background:"rgba(240,165,0,0.2)", display:"inline-block", borderRadius:2 }} />Time blocks
                          </span>
                        </div>
                        <div style={{ maxHeight:252, overflowY:"auto", border:"1px solid var(--bd)", borderRadius:6 }}>
                          {windForecast.map((w, i) => {
                            const highlight = blocks.some(b => {
                              const [sh,sm]=b.startTime.split(":").map(Number), [eh,em]=b.endTime.split(":").map(Number);
                              const [wh,wm]=w.time.split(":").map(Number);
                              return wh*60+wm >= sh*60+sm && wh*60+wm < eh*60+em;
                            });
                            const gustDiff = w.gust - w.speed;
                            return (
                              <div key={i} style={{ display:"grid", gridTemplateColumns:"44px 36px 52px 1fr 56px", alignItems:"center", padding:"5px 10px", borderBottom:"1px solid var(--bd)", background: highlight ? "rgba(240,165,0,0.05)" : "transparent" }}>
                                <span style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.7rem", color: highlight ? "#c8a000" : "var(--mu)" }}>{w.time}</span>
                                <span style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.7rem", color:"var(--ac)", display:"inline-block", transform:`rotate(${w.dirDeg + 180}deg)`, textAlign:"center" }}>↑</span>
                                <span style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.7rem", color:"var(--mu)" }}>{w.dir}</span>
                                <span style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.75rem", color:"var(--tx)", fontWeight:600 }}>{w.speed} mph</span>
                                <span style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.65rem", color:"#4ab0ff", textAlign:"right" }}>↑{gustDiff} gust</span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </>
                  )}
                </div>

                {/* RIGHT: Conditions + (River Gauges | Water Quality) + Tide Chart */}
                <div>
                  {tideDate && (() => {
                    const moon = getMoonPhase(tideDate);
                    const pressures = windForecast.map(w => w.pressure).filter(Boolean);
                    const pTrend = pressures.length >= 6
                      ? (() => { const e = pressures.slice(0,3).reduce((a,b)=>a+b,0)/3; const l = pressures.slice(-3).reduce((a,b)=>a+b,0)/3; return l-e > 1 ? "rising" : l-e < -1 ? "falling" : "steady"; })()
                      : null;
                    const curPressure = pressures.length ? Math.round(pressures[0] * 10) / 10 : null;
                    const moonIcon = { "New Moon":"🌑","Waxing Crescent":"🌒","First Quarter":"🌓","Waxing Gibbous":"🌔","Full Moon":"🌕","Waning Gibbous":"🌖","Last Quarter":"🌗","Waning Crescent":"🌘" }[moon.phase] || "🌙";
                    const tempColor = waterTempF === null ? "#5a7a94" : waterTempF < 55 ? "#4ab0ff" : waterTempF < 65 ? "#00c8a0" : waterTempF <= 82 ? "#f0a500" : "#e05a2b";
                    return (
                      <>
                        <div className="sl">Conditions</div>
                        <div className="card" style={{ marginBottom:16 }}>
                          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:12 }}>
                            <div>
                              <div style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.6rem", color:"var(--mu)", textTransform:"uppercase", letterSpacing:1, marginBottom:5 }}>Moon</div>
                              <div style={{ fontSize:"1.4rem", lineHeight:1 }}>{moonIcon}</div>
                              <div style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.63rem", color:"var(--tx)", marginTop:4 }}>{moon.phase}</div>
                              <div style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.6rem", color:"var(--mu)" }}>{moon.illumination}% lit</div>
                            </div>
                            <div>
                              <div style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.6rem", color:"var(--mu)", textTransform:"uppercase", letterSpacing:1, marginBottom:5 }}>Pressure</div>
                              {curPressure ? (
                                <>
                                  <div style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"1rem", color:"var(--tx)", lineHeight:1 }}>{curPressure} <span style={{ fontSize:"0.6rem", color:"var(--mu)" }}>hPa</span></div>
                                  {pTrend && <div style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.68rem", marginTop:4, color: pTrend==="falling" ? "#e05a2b" : pTrend==="rising" ? "#00c8a0" : "var(--mu)" }}>{pTrend==="falling" ? "▼ Falling" : pTrend==="rising" ? "▲ Rising" : "→ Steady"}</div>}
                                </>
                              ) : <div style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.68rem", color:"var(--mu)" }}>Fetch data</div>}
                            </div>
                            <div>
                              <div style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.6rem", color:"var(--mu)", textTransform:"uppercase", letterSpacing:1, marginBottom:5 }}>Water Temp</div>
                              {waterTempF !== null ? (
                                <>
                                  <div style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"1rem", color:tempColor, lineHeight:1 }}>{waterTempF.toFixed(1)}°F</div>
                                  <div style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.6rem", color:tempColor, marginTop:4 }}>{waterTempF < 55 ? "Cold" : waterTempF < 65 ? "Cool" : waterTempF <= 82 ? "Warm" : "Hot"}</div>
                                </>
                              ) : <div style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.68rem", color:"var(--mu)" }}>Fetch data</div>}
                            </div>
                          </div>
                        </div>
                      </>
                    );
                  })()}

                  {waterQuality.length > 0 && (
                    <>
                      <div className="sl">Water Quality</div>
                      <div className="card">
                        <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
                          {waterQuality.map(s => {
                            const lbl = salinityLabel(s.salNow);
                            const trendIcon = s.trend === "rising" ? "↑" : s.trend === "falling" ? "↓" : "→";
                            const trendColor = s.trend === "rising" ? "#4ab0ff" : s.trend === "falling" ? "#e05a2b" : "#5a7a94";
                            const updated = s.updatedAt ? new Date(s.updatedAt).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"}) : "";
                            return (
                              <div key={s.id} style={{ background:"var(--bg)", border:"1px solid var(--bd)", borderLeft:`3px solid ${lbl.color}`, borderRadius:6, padding:"10px 13px" }}>
                                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:8, marginBottom:5 }}>
                                  <div>
                                    <div style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.65rem", color:"var(--mu)", textTransform:"uppercase", letterSpacing:1 }}>{s.label}</div>
                                    <div style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.6rem", color:"#2a4060", marginTop:1 }}>{s.zone}</div>
                                  </div>
                                  {updated && <div style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.6rem", color:"#2a4060" }}>{updated}</div>}
                                </div>
                                <div style={{ display:"flex", alignItems:"baseline", gap:10 }}>
                                  <span style={{ fontFamily:"Bebas Neue,sans-serif", fontSize:"1.7rem", color:lbl.color, lineHeight:1 }}>{s.salNow !== null ? s.salNow.toFixed(1) : "—"}</span>
                                  <span style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.7rem", color:"var(--mu)" }}>ppt</span>
                                  {s.trend && <span style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.75rem", color:trendColor }}>{trendIcon} {s.trend}</span>}
                                  {s.tempF !== null && <span style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.7rem", color:"var(--mu)", marginLeft:"auto" }}>{s.tempF.toFixed(1)}°F</span>}
                                </div>
                                <div style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.68rem", color:lbl.color, marginTop:5 }}>{lbl.text}</div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </>
                  )}

                  {tidePreds.length > 0 && (
                    <>
                      <div className="sl">Tide Chart</div>
                      <div className="card">
                        <TideChart
                          predictions={tidePreds}
                          predictions2={tidePreds2}
                          blendWeight={blendWeight}
                          label1={TIDE_STATIONS.find(s=>s.id===tideStation)?.label ?? "Station 1"}
                          label2={TIDE_STATIONS.find(s=>s.id===tideStation2)?.label ?? "Station 2"}
                          windForecast={windForecast}
                          primaryZoneId={zones[0] ?? null}
                        />
                      </div>
                    </>
                  )}
                </div>
              </div>

              <div className="sl">Time Blocks — Tide & Wind</div>
              {blocks.map((b,i) => <TimeBlockForm key={i} block={b} index={i} onChange={upd} onRemove={rem} />)}
              <div className="brow" style={{ marginBottom:16 }}>
                <button className="btn btn-secondary btn-sm" onClick={add}>+ Add Block</button>
              </div>

              <div className="sl">Trip Notes</div>
              <div className="card">
                <textarea placeholder="Recent reports, target species, bait, access notes..." value={notes} onChange={e => setNotes(e.target.value)} />
              </div>

              <button className="btn btn-primary" onClick={generate}>Generate Game Plan →</button>
            </>
          )}

          {/* PLAN */}
          {tab === "plan" && plan && (
            <>
              <div className="brow" style={{ marginBottom:18 }}>
                <button className="btn btn-secondary btn-sm" onClick={() => setTab("setup")}>← Edit</button>
                <button className="btn btn-secondary btn-sm" onClick={saveTrip}>Save Trip</button>
                <button className="btn btn-warn btn-sm" onClick={() => setShowFeedback(true)}>Post-Trip Debrief</button>
              </div>
              {riverFt !== null && riverFt > 12 && zones.some(z => z === "mrgo-interior" || z === "chef-pass") && (
                <div className="card" style={{ borderColor:"var(--wn)", borderLeft:"3px solid var(--wn)", marginBottom:14 }}>
                  <div style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.68rem", color:"var(--wn)", marginBottom:4, textTransform:"uppercase", letterSpacing:1 }}>⚠ River Level Alert</div>
                  <div style={{ fontSize:"0.84rem" }}>Mississippi R. at {riverFt.toFixed(1)}ft — freshwater pushing through MRGO into Chef Pass and interior marsh. Trout seeking cleaner, saltier water — prioritize redfish, black drum, and bass.</div>
                </div>
              )}
              {(() => {
                const relevantWQ = waterQuality.filter(s => {
                  if (s.id === "301001089442600") return zones.some(z => z === "lake-st-catherine" || z === "lake-catherine-cuts");
                  return false;
                }).filter(s => s.salNow !== null);
                if (!relevantWQ.length) return null;
                const minSal = Math.min(...relevantWQ.map(s => s.salNow));
                const salFavorable = minSal >= 10;
                const salLow = minSal < 5;
                const borderColor = salFavorable ? "#00c8a0" : salLow ? "#e05a2b" : "#c8a000";
                const summaryText = salFavorable
                  ? "Salinity in the productive range — favorable conditions for trout and reds."
                  : salLow
                  ? "Low salinity in your selected zones — trout pushed to saltier open water. Focus on redfish and black drum on shell and grass edges."
                  : "Salinity below trout threshold — trout unlikely in these zones. Target reds and drum on structure.";
                const summaryColor = salFavorable ? "#00c8a0" : "#c8a000";
                return (
                  <div className="card" style={{ borderColor, borderLeft:`3px solid ${borderColor}`, marginBottom:14 }}>
                    <div style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.68rem", color:borderColor, marginBottom:6, textTransform:"uppercase", letterSpacing:1 }}>⚡ Salinity</div>
                    {relevantWQ.map(s => (
                      <div key={s.id} style={{ fontSize:"0.84rem", marginBottom:3 }}>
                        <span style={{ color: salinityLabel(s.salNow).color }}>{s.salNow.toFixed(1)} ppt</span>
                        <span style={{ color:"var(--mu)" }}> at {s.label} — {salinityLabel(s.salNow).text}</span>
                      </div>
                    ))}
                    <div style={{ fontSize:"0.82rem", color:summaryColor, marginTop:8, paddingTop:8, borderTop:"1px solid var(--bd)" }}>
                      {summaryText}
                    </div>
                  </div>
                );
              })()}
              {plan.map((b,i) => <BlockCard key={i} block={b} onSwitchZone={switchToZone} />)}

              {/* KEY WATCHOUTS */}
              {(() => {
                const watchouts = [];
                plan.forEach(b => {
                  b.zoneTips.forEach(z => z.tips.filter(t => t.includes("⚠")).forEach(t => {
                    const cleaned = fixRuleText(t.replace(/^⚠\s*/, ""));
                    if (!watchouts.includes(cleaned)) watchouts.push(cleaned);
                  }));
                  b.avoid.forEach(a => { if (!watchouts.includes(a)) watchouts.push(a); });
                  b.caution.forEach(c => { const s = `⚡ ${c}`; if (!watchouts.includes(s)) watchouts.push(s); });
                });
                if (!watchouts.length) return null;
                return (
                  <div className="card" style={{ marginTop:18, borderLeft:"3px solid #e05a2b" }}>
                    <div style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.62rem", letterSpacing:2, textTransform:"uppercase", color:"#e05a2b", marginBottom:10 }}>⚠ Key Watchouts</div>
                    {watchouts.map((w, i) => (
                      <p key={i} style={{ fontSize:"0.85rem", color: w.startsWith("⚡") ? "#c8a000" : "#f08070", lineHeight:1.7, marginBottom: i < watchouts.length - 1 ? 7 : 0 }}>
                        {w}
                      </p>
                    ))}
                  </div>
                );
              })()}

              {/* BOTTOM LINE */}
              {(() => {
                const allSpots = plan.flatMap(b => b.whereToFish || []);
                const topSpot = [...allSpots].sort((a, b) => b.score - a.score)[0];
                const bestBlock = topSpot ? plan.find(b => (b.whereToFish || []).some(w => w.spot === topSpot.spot)) : plan[0];
                const anyAvoid = plan.some(b => b.avoid.length > 0);
                const anyFallHigh = plan.some(b => b.strategy.some(s => s.toLowerCase().includes("fall")));
                const species = bestBlock?.primarySpecies?.[0]?.split(" — ")[0] ?? "Redfish";
                const bestWindow = bestBlock ? `${bestBlock.startTime}–${bestBlock.endTime}` : "";
                const tideSentence = bestBlock?.tideDir === "falling"
                  ? "Falling tide is your primary trigger — concentrate at drain mouths and cut exits during the drop."
                  : bestBlock?.tideDir === "rising"
                  ? "Rising tide is pushing bait into the marsh — follow it shallower and work grass edges."
                  : "Slack water mid-day — use that window to run and scout structure.";
                const riverNote = riverFt !== null && riverFt > 12
                  ? ` River running high at ${riverFt.toFixed(1)}ft — salinity suppressed, trout pushed to cleaner open water.`
                  : "";
                const avoidNote = anyAvoid ? " Rule triggered for one or more blocks — check the red ⚠ flags above before committing to those spots." : "";
                const sentences = [
                  topSpot ? `Best window: ${bestWindow} — ${topSpot.spot} in ${topSpot.zone}. ${topSpot.reason}.` : "",
                  tideSentence,
                  `Primary target is ${species}.${riverNote}`,
                  avoidNote,
                ].filter(Boolean);
                return (
                  <div className="card" style={{ marginTop:12, borderLeft:"3px solid #00c8a0" }}>
                    <div style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.62rem", letterSpacing:2, textTransform:"uppercase", color:"#00c8a0", marginBottom:10 }}>✓ Bottom Line</div>
                    {sentences.map((s, i) => (
                      <p key={i} style={{ fontSize:"0.86rem", color: s.startsWith(" Rule") ? "#c8a000" : "#d0e4f0", lineHeight:1.75, marginBottom: i < sentences.length - 1 ? 8 : 0 }}>{s}</p>
                    ))}
                  </div>
                );
              })()}

              {notes && (
                <>
                  <div className="sl" style={{ marginTop:18 }}>Trip Notes</div>
                  <div className="card"><p style={{ fontSize:"0.87rem", lineHeight:1.6 }}>{notes}</p></div>
                </>
              )}
            </>
          )}
          {tab === "plan" && !plan && <p style={{ color:"var(--mu)", fontFamily:"IBM Plex Mono,monospace", fontSize:"0.8rem" }}>Complete Trip Setup and generate a plan first.</p>}

          {/* SCOUT */}
          {tab === "scout" && !currentUser && (
            <div style={{ textAlign:"center", padding:"60px 20px", fontFamily:"IBM Plex Mono,monospace", color:"var(--mu)", fontSize:"0.78rem" }}>Sign in to use Scout.</div>
          )}
          {tab === "scout" && currentUser && savedPresets.length === 0 && (
            <div style={{ textAlign:"center", padding:"60px 20px", fontFamily:"IBM Plex Mono,monospace", color:"var(--mu)", fontSize:"0.78rem" }}>No presets saved. Save up to 3 presets in Trip Setup to use Scout.</div>
          )}
          {tab === "scout" && currentUser && savedPresets.length > 0 && (() => {
            const scoreColor = s => s >= 8 ? "#00c8a0" : s >= 6 ? "#c8a000" : "#e05a2b";
            const tideBadge = d => d === "falling" ? "↓ Falling" : d === "rising" ? "↑ Rising" : "— Slack";
            return (
              <div style={{ paddingBottom: 32 }}>
                <div className="sl" style={{ marginBottom: 14 }}>Scout Conditions</div>
                {/* Controls */}
                <div className="card" style={{ marginBottom: 20 }}>
                  <div style={{ display:"flex", flexWrap:"wrap", gap:10, alignItems:"flex-end" }}>
                    <div>
                      <div style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.65rem", color:"var(--mu)", marginBottom:4, textTransform:"uppercase", letterSpacing:1 }}>Date</div>
                      <input type="date" value={compareDate} onChange={e => setCompareDate(e.target.value)} style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.8rem" }} />
                    </div>
                    <div>
                      <div style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.65rem", color:"var(--mu)", marginBottom:4, textTransform:"uppercase", letterSpacing:1 }}>Trip Start</div>
                      <TimeInput value={compareTripStart} onChange={setCompareTripStart} style={{ width:90, fontFamily:"IBM Plex Mono,monospace", fontSize:"0.8rem" }} />
                    </div>
                    <div>
                      <div style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.65rem", color:"var(--mu)", marginBottom:4, textTransform:"uppercase", letterSpacing:1 }}>Trip End</div>
                      <TimeInput value={compareTripEnd} onChange={setCompareTripEnd} style={{ width:90, fontFamily:"IBM Plex Mono,monospace", fontSize:"0.8rem" }} />
                    </div>
                    <button className="btn btn-primary" onClick={runCompare} disabled={compareLoading} style={{ alignSelf:"flex-end" }}>
                      {compareLoading ? "Fetching…" : "Compare All →"}
                    </button>
                  </div>
                </div>

                {/* Results */}
                {compareResults.map((r, ri) => {
                  const avg = r.avgScore;
                  const peak = r.peakBlock;
                  const borderColor = scoreColor(avg);
                  const tideStation1Label = TIDE_STATIONS.find(s => s.id === r.preset.tideStation)?.label ?? r.preset.tideStation;
                  return (
                    <div key={r.preset.id} className="card" style={{ borderLeft:`3px solid ${borderColor}`, marginBottom:16 }}>
                      {/* Header */}
                      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:10 }}>
                        <div>
                          <div style={{ fontFamily:"Bebas Neue,sans-serif", fontSize:"1.3rem", color:"var(--fg)", letterSpacing:1, lineHeight:1 }}>{r.preset.name}</div>
                          <div style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.65rem", color:"var(--mu)", marginTop:3 }}>{tideStation1Label}</div>
                          <div style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.65rem", color:"var(--mu)", marginTop:2 }}>{(r.preset.zones||[]).map(zid => ZONES.find(z => z.id === zid)?.label ?? zid).join(" · ")}</div>
                        </div>
                        <div style={{ textAlign:"right" }}>
                          <div style={{ fontFamily:"Bebas Neue,sans-serif", fontSize:"2rem", color:borderColor, lineHeight:1 }}>{avg.toFixed(1)}</div>
                          <div style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.6rem", color:"var(--mu)" }}>avg / 10</div>
                        </div>
                      </div>

                      {/* Peak callout */}
                      {peak && peak.topZone && (
                        <div style={{ background:"rgba(255,255,255,0.03)", borderRadius:6, padding:"8px 10px", marginBottom:10, fontFamily:"IBM Plex Mono,monospace", fontSize:"0.74rem" }}>
                          <span style={{ color:"var(--mu)" }}>Peak </span>
                          <span style={{ color:scoreColor(peak.topZone.score), fontWeight:600 }}>{peak.topZone.score}/10</span>
                          <span style={{ color:"var(--mu)" }}> · {peak.startTime}–{peak.endTime} · {tideBadge(peak.tideDir)} · </span>
                          <span style={{ color:"var(--fg)" }}>{peak.topZone.label}</span>
                          {peak.windDir && <span style={{ color:"var(--mu)" }}> · {peak.windDir} {peak.windSpeed}mph</span>}
                        </div>
                      )}

                      {r.error && <div style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.72rem", color:"#e05a2b", marginBottom:8 }}>⚠ {r.error}</div>}

                      {/* Per-block table */}
                      {r.blockScores.length > 0 && (
                        <div style={{ display:"flex", flexDirection:"column", gap:4, marginBottom:12 }}>
                          {r.blockScores.map((b, bi) => (
                            <div key={bi} style={{ display:"flex", alignItems:"center", gap:8, fontFamily:"IBM Plex Mono,monospace", fontSize:"0.7rem" }}>
                              <span style={{ color:"var(--mu)", minWidth:110 }}>{b.startTime}–{b.endTime}</span>
                              <span className={`badge tb-${b.tideDir}`} style={{ fontSize:"0.6rem", padding:"1px 6px" }}>{tideBadge(b.tideDir)}</span>
                              {b.windDir && <span className="badge wb" style={{ fontSize:"0.6rem", padding:"1px 6px" }}>{b.windDir} {b.windSpeed}mph</span>}
                              <span style={{ color:"var(--fg)", flex:1, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{b.topZone?.label ?? "—"}</span>
                              <span style={{ color:scoreColor(b.topZone?.score ?? 0), minWidth:28, textAlign:"right", fontWeight:600 }}>{b.topZone?.score ?? "—"}/10</span>
                            </div>
                          ))}
                        </div>
                      )}

                      <button className="btn btn-primary btn-sm" onClick={() => loadFromCompare(r)}>Load This Plan →</button>
                    </div>
                  );
                })}

                {compareResults.length === 0 && !compareLoading && (
                  <div style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.78rem", color:"var(--mu)", textAlign:"center", padding:"40px 0" }}>
                    Set a date and tap Compare All to score your presets.
                  </div>
                )}
              </div>
            );
          })()}

          {/* MAP */}
          {tab === "map" && (
            <>
              <div className="sl">Boundary Coordinates</div>
              <div className="card" style={{ marginBottom:16 }}>
                <div className="cgrid">
                  {coords.map((c, i) => (
                    <div key={i} className="crow">
                      <span className="clbl">P{i+1}</span>
                      <input placeholder="Lat" value={c.lat} onChange={e => handleCoordsChange(coords.map((x,j) => j===i?{...x,lat:e.target.value}:x))} />
                      <input placeholder="Lng" value={c.lng} onChange={e => handleCoordsChange(coords.map((x,j) => j===i?{...x,lng:e.target.value}:x))} />
                    </div>
                  ))}
                </div>
                <div style={{ display:"flex", gap:7, marginTop:9 }}>
                  <button className="rm-btn" style={{ color:"var(--ac)", borderColor:"var(--ac)" }} onClick={() => setCoords(p => [...p,{lat:"",lng:""}])}>+ Point</button>
                  {coords.length > 2 && <button className="rm-btn" onClick={() => setCoords(p => p.slice(0,-1))}>− Last</button>}
                </div>
              </div>
              <div className="sl">Fishing Zone Map</div>
              <p style={{ fontSize:"0.8rem", color:"var(--mu)", marginBottom:13, lineHeight:1.6 }}>Blue polygon = your coordinate boundary. Teal circles = selected zones.</p>
              <MapView coords={coords} selectedZones={zones} onCoordsChange={handleCoordsChange} />
              <div className="sl" style={{ marginTop:18 }}>Zone Reference</div>
              <div className="card">
                {ZONES.map(z => (
                  <div key={z.id} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"8px 0", borderBottom:"1px solid var(--bd)" }}>
                    <div>
                      <div style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.73rem", color:zones.includes(z.id)?"var(--ac)":"var(--mu)" }}>{zones.includes(z.id)?"● ":"○ "}{z.label}</div>
                      <div style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.62rem", color:"var(--mu)", marginTop:2 }}>{z.lat}°N, {Math.abs(z.lng)}°W</div>
                    </div>
                    <div className={`zp ${zones.includes(z.id)?"on":""}`} onClick={() => togZone(z.id)} style={{ fontSize:"0.62rem" }}>{zones.includes(z.id)?"Selected":"Add"}</div>
                  </div>
                ))}
              </div>
            </>
          )}

          {/* RULES */}
          {tab === "rules" && !currentUser && (
            <div style={{ textAlign:"center", padding:"60px 20px", fontFamily:"IBM Plex Mono,monospace", color:"var(--mu)", fontSize:"0.78rem" }}>Sign in to view the Rules DB.</div>
          )}
          {tab === "rules" && currentUser && (() => {
            const confBadge = r => {
              const t = (r.confirms || 0) + (r.contradicts || 0);
              if (!t) return null;
              const pct = Math.round((r.confirms || 0) / t * 100);
              const color = pct >= 70 ? "#00c8a0" : pct >= 40 ? "#c8a000" : "#e05a2b";
              return { pct, t, color, confirms: r.confirms || 0, contradicts: r.contradicts || 0 };
            };
            const needsReview = userRules.filter(r => {
              const t = (r.confirms || 0) + (r.contradicts || 0);
              return t >= 2 && (r.contradicts || 0) > (r.confirms || 0);
            });
            const RuleCard = ({ r, deletable }) => {
              const cb = confBadge(r);
              return (
                <div className="rc ur">
                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:8 }}>
                    <div style={{ flex:1 }}>
                      <div style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap", marginBottom:3 }}>
                        <span className="rtitle" style={{ color:"var(--bl)" }}>{r.label} — {r.flag.toUpperCase()}</span>
                        {cb && (
                          <span style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.62rem", padding:"2px 8px", borderRadius:10, border:`1px solid ${cb.color}33`, color: cb.color, background:`${cb.color}11` }}>
                            {cb.confirms}↑ {cb.contradicts}↓ · {cb.pct}%
                          </span>
                        )}
                        {cb && cb.pct < 40 && <span style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.62rem", color:"#e05a2b" }}>Needs Review</span>}
                      </div>
                      <div className="rdesc">{r.reason}</div>
                      <div className="rmeta">Added: {r.date} · Zones: {r.zones.join(", ")} · Wind: {r.conditions.windDirs?.join("/")} {r.conditions.windSpeedMin}+mph · Tide: {r.conditions.tideDir}</div>
                    </div>
                    {deletable && <button className="del-btn" onClick={() => deleteRule(r.id)}>✕</button>}
                  </div>
                </div>
              );
            };
            return (
              <>
                {needsReview.length > 0 && (
                  <>
                    <div className="sl" style={{ color:"#e05a2b" }}>⚠ Needs Review</div>
                    <p style={{ color:"var(--mu)", fontFamily:"IBM Plex Mono,monospace", fontSize:"0.73rem", marginBottom:10, lineHeight:1.5 }}>These rules have been contradicted by more trips than they've been confirmed. Consider updating or removing them.</p>
                    {needsReview.map(r => <RuleCard key={r.id} r={r} deletable />)}
                  </>
                )}
                <div className="sl" style={{ marginTop: needsReview.length ? 18 : 0 }}>Built-In Rules</div>
                {BUILTIN_RULES.map(r => (
                  <div key={r.id} className="rc bi">
                    <div className="rtitle" style={{ color:"var(--wn)" }}>{r.label} — {r.flag.toUpperCase()}</div>
                    <div className="rdesc">{r.reason}</div>
                    <div className="rmeta">Source: {r.source} · {r.date} · Zones: {r.zones.join(", ")}</div>
                  </div>
                ))}
                <div className="sl" style={{ marginTop:18 }}>User Rules from Trip Feedback</div>
                {userRules.length === 0 && <p style={{ color:"var(--mu)", fontFamily:"IBM Plex Mono,monospace", fontSize:"0.76rem", marginBottom:14 }}>No user rules yet. Complete a Post-Trip Debrief after your next trip.</p>}
                {userRules.map(r => <RuleCard key={r.id} r={r} deletable />)}
              </>
            );
          })()}

          {/* HISTORY */}
          {tab === "history" && !currentUser && (
            <div style={{ textAlign:"center", padding:"60px 20px", fontFamily:"IBM Plex Mono,monospace", color:"var(--mu)", fontSize:"0.78rem" }}>Sign in to view your trip history.</div>
          )}
          {tab === "history" && currentUser && (
            <>
              <div className="sl">Saved Trips</div>
              {trips.length === 0 && <p style={{ color:"var(--mu)", fontFamily:"IBM Plex Mono,monospace", fontSize:"0.76rem" }}>No trips saved yet. Generate a plan and click Save Trip.</p>}
              {trips.map(t => (
                <div key={t.id} className="he" onClick={() => loadTrip(t)}>
                  <div className="hd">
                    {t.date}
                    {t.debrief?.rating > 0 && <span style={{ marginLeft:8, color:"#f0a500" }}>{"★".repeat(t.debrief.rating)}{"☆".repeat(5 - t.debrief.rating)}</span>}
                    {t.debriefed && !t.debrief?.rating && <span style={{ marginLeft:8, color:"var(--mu)" }}>· Debrief logged</span>}
                  </div>
                  <div className="hm">Zones: {t.zones?.map(z => ZONES.find(x => x.id===z)?.label).filter(Boolean).join(", ")}{t.riverFt ? ` · River: ${t.riverFt.toFixed(1)}ft` : ""}</div>
                  {t.debrief?.targetSpecies?.length > 0 && (
                    <div style={{ display:"flex", flexWrap:"wrap", gap:4, marginTop:5 }}>
                      {t.debrief.targetSpecies.map(s => <span key={s} style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.6rem", padding:"2px 7px", borderRadius:10, border:"1px solid #1e3048", color:"#5a7a94" }}>{s}</span>)}
                    </div>
                  )}
                  {t.debrief?.catchLog?.length > 0 && (
                    <div style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.65rem", color:"var(--ac)", marginTop:5 }}>
                      {t.debrief.catchLog.map(c => `${c.count} ${c.species}`).join(" · ")}
                    </div>
                  )}
                </div>
              ))}
            </>
          )}

        </div>
      </div>

      {showFeedback && plan && <FeedbackModal plan={plan} zones={zones} onSave={saveFeedback} onClose={() => setShowFeedback(false)} />}
    </>
  );
}
