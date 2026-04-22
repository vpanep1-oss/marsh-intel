import { useState, useEffect, useRef } from "react";
import L from "leaflet";
import { auth, provider, db } from "./firebase.js";
import { signInWithPopup, signOut, onAuthStateChanged } from "firebase/auth";
import { collection, doc, setDoc, getDoc, getDocs, deleteDoc, query, orderBy, limit } from "firebase/firestore";

// ─── CONSTANTS ───────────────────────────────────────────────────────────────
const WIND_DIRS = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];

const ZONES = [
  { id: "lake-st-catherine",   label: "Lake St. Catherine",           lat: 30.128471, lng: -89.732639 },
  { id: "lake-catherine-cuts", label: "Lake Catherine Cuts / Trenasses", lat: 30.100468, lng: -89.716792 },
  { id: "chef-pass",           label: "Chef Pass / IWW",              lat: 30.055496, lng: -89.779941 },
  { id: "lake-borgne",         label: "Lake Borgne",                  lat: 30.025261, lng: -89.640657 },
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
function generatePlan(blocks, zones, allRules, riverFt, salinityPpt, pearlRiverFt, moonPhase, pressureTrend, waterTempF, tripDate) {
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
    const avoid = activeRules.filter(r => r.flag === "avoid").map(r => r.reason);
    const caution = activeRules.filter(r => r.flag === "caution").map(r => r.reason);
    const hasWind = !!windDir;
    const isStrongWind = hasWind && windSpeed >= 10;
    const isModerateWind = hasWind && windSpeed > 7;
    const isLightWind = hasWind && windSpeed <= 7;
    const windFromSouth = hasWind && ["S","SSE","SSW"].includes(windDir);
    const windFromNorth = hasWind && ["N","NNE","NNW","NE","NW"].includes(windDir);
    const windFromEast  = hasWind && ["E","ESE","SE","NE","ENE"].includes(windDir);
    const windFromWest  = hasWind && ["W","WNW","WSW","SW","NW"].includes(windDir);
    const highRiver     = riverFt !== null && riverFt !== undefined && riverFt > 12;
    const highPearlRiver = pearlRiverFt !== null && pearlRiverFt !== undefined && pearlRiverFt > 10;
    const lowSalinity = salinityPpt !== null && salinityPpt !== undefined && salinityPpt < 5;
    const troutAvailable = (!highRiver && !lowSalinity) || zones.includes("lake-borgne");

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

    if (highRiver || lowSalinity) {
      const reason = highRiver
        ? `Mississippi River at ${riverFt.toFixed(1)}ft — freshwater suppressing salinity.`
        : `Salinity at ${salinityPpt.toFixed(1)} ppt — below trout threshold.`;
      strategy.push(`⚠ ${reason} Trout displaced toward open Lake Borgne.`);
      if (zones.includes("lake-borgne")) {
        strategy.push("Lake Borgne in your zones — trout holding on shell reef edges in cleaner water on the east end.");
      } else {
        strategy.push("Your zones don't cover Lake Borgne — trout are not a realistic target today. Focus on redfish, black drum, and bass.");
      }
    }

    if (tideDir === "slack") {
      strategy.push("Slack water — tidal current near zero. Fish are transitioning, not ambushing.");
      if (isModerateWind) {
        strategy.push(`Wind at ${windSpeed}mph is now the dominant current — treat this like a wind tide.`);
        strategy.push(`Fish the ${windwardBank} where bait is being pushed and stacked. Work the grass edge and any points that break the wind line.`);
        if (isStrongWind) strategy.push(`Avoid exposed open water — stay in protected cuts and behind-island shorelines to manage the chop.`);
        strategy.push(`${leewardBank.charAt(0).toUpperCase() + leewardBank.slice(1)} is calm but dead — bait is on the opposite side.`);
      } else {
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
        highRiver ? "Largemouth Bass — grass lines and wood structure in low-salinity backwaters" : "Largemouth Bass — shaded structure, points, and grass edges near cuts",
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
        highRiver ? "Largemouth Bass — moving shallower with the tide in freshwater-pushed areas" : "Largemouth Bass — grass pockets, points, and upcurrent structure edges",
        ...(troutAvailable ? ["Speckled Trout — wind-blown bait lines, shell reef edges, points"] : []),
        ...(tideChange >= 0.15 ? ["Flounder — staging near structure edges waiting for the drop"] : []),
        "Black Drum — shell reefs and oyster pads as water covers them on the rise",
      ];
    }

    // ─── ZONE TIPS ───────────────────────────────────────────────────────────
    if (zones.includes("lake-st-catherine")) {
      if (isStrongWind) zt("Lake St. Catherine", `⚠ ${windSpeed}mph ${windDir} — stay tight to the ${windwardBank} and avoid open mid-lake drifts. Chop builds fast on this shallow system.`);
      if (tideDir === "falling") {
        zt("Lake St. Catherine", "Shell reef edges and cut mouths on south end where current exits toward Borgne. Watch for birds.");
        zt("Lake St. Catherine", "Black drum stacked on shell pads as current moves bait across them — slow-roll or dead-stick a crab.");
      }
      if (tideDir === "rising" && windFromSouth) zt("Lake St. Catherine", `South wind piles bait on north shoreline — work those grass edges for reds${troutAvailable ? " and trout" : ""}.`);
      if (tideDir === "rising" && !windFromSouth) zt("Lake St. Catherine", "Drift shell reefs and grass points as water refills from Borgne side. Black drum active on the reefs.");
      if (tideDir === "slack" && isModerateWind) zt("Lake St. Catherine", `Slack tide but ${windSpeed}mph ${windDir} — fish the ${windwardBank}. Wind is the only current right now.`);
      if (season === "winter") zt("Lake St. Catherine", "Winter: reds schooled on dark mud bottom on the east and south banks absorbing solar heat. Trout off this lake — too shallow and cold. Bass on deeper grass edge transitions.");
      if (season === "spring") zt("Lake St. Catherine", "Spring: reds starting to show in potholes along the north grass edge. Bass spawning on hard bottom near grass transitions. Trout active in early morning on shell.");
      if (season === "summer") zt("Lake St. Catherine", "Summer: this shallow lake heats up fast — arrive at first light. Reds tolerate the heat better than trout. Work the deeper south-end channel edges midday.");
      if (season === "fall") zt("Lake St. Catherine", "Fall prime: trout on shell reef edges and grass points responding to topwater. Reds schooling near the south end cuts. Bass very active along grass transitions.");
    }
    if (zones.includes("lake-catherine-cuts")) {
      if (tideDir === "falling") zt("Lake Catherine Cuts / Trenasses", `Position just outside the exit on the downcurrent side — ${troutAvailable ? "flounder and trout" : "flounder and reds"} both stack here. Even 0.25ft of drop creates a strong current through a tight throat.`);
      if (tideDir === "rising") zt("Lake Catherine Cuts / Trenasses", "Fish the inside face of the cut as water pushes in — reds and flounder hold on the upcurrent edge.");
      if (tideDir === "slack" && isModerateWind) zt("Lake Catherine Cuts / Trenasses", `No tidal current but ${windDir} wind at ${windSpeed}mph — cuts aligned with the wind will still have some push. Check which cuts face ${windDir} and work those.`);
      if (isStrongWind) zt("Lake Catherine Cuts / Trenasses", "⚠ Strong wind creates standing waves at cut exits in open exposure — approach from the leeward side and anchor before the mouth.");
      if (season === "winter") zt("Lake Catherine Cuts / Trenasses", "Winter: cuts are the warmest water in the system — current keeps temps slightly higher than the open lake. Reds stacked in the deeper cut throats. Bass on the inside grass edges.");
      if (season === "fall") zt("Lake Catherine Cuts / Trenasses", "Fall: flounder stacking at cut exits ahead of their Gulf migration — one of the best flounder windows of the year. Also prime for reds ambushing from the cut edges.");
    }
    if (zones.includes("lake-borgne")) {
      if (isStrongWind) zt("Lake Borgne", `⚠ ${windSpeed}mph ${windDir} — open water gets dangerous fast. Stay inside 1 mile of the shoreline and keep a bailout route to the cut system.`);
      if (tideDir === "falling") zt("Lake Borgne", "Work shell reef edges and points on the west end where current pushes bait out. Trout active in cleaner water — look for birds.");
      if (tideDir === "rising") zt("Lake Borgne", "Shell reefs on the north and west shoreline as water rises. Trout and reds stacking on the upcurrent face.");
      if (tideDir === "slack" && isModerateWind) zt("Lake Borgne", `Slack tide — wind at ${windSpeed}mph is driving bait onto the ${windwardBank} shell reefs. Work those edges.`);
      if (highRiver) zt("Lake Borgne", "Best salinity refuge in the system right now — cleaner water than the interior marsh. Trout pushed here from the west.");
      if (season === "winter") zt("Lake Borgne", "Winter: trout concentrated on deep shell reef edges (8–12ft) on the west end. Reds on mud flats along the north shore warming in sun. Not a bass lake — focus on trout and reds.");
      if (season === "fall") zt("Lake Borgne", "Fall: best trout bite of the year on shell reefs. Look for birds and slicks over bait schools. Reds schooling in large pods — nervous water on open flats signals fish underneath. Topwater productive early.");
      if (season === "summer") zt("Lake Borgne", "Summer: open water heats fast. Fish the deeper shell reef edges at first light — trout go deep by 9 AM. East wind days give you cleaner, slightly cooler water.");
    }
    if (zones.includes("chef-pass")) {
      if (tideDir === "falling" && isLightWind) {
        zt("Chef Pass", "Good window — work cut edges and grass points along IWW. Flounder prime here on falling tide — target the sandy transition bottom just outside the grass.");
      }
      if (tideDir === "falling" && isModerateWind) zt("Chef Pass", `Falling tide with ${windSpeed}mph ${windDir} — position on the downtide/downwind corner of cut mouths where both current and wind funnel bait to the same point.`);
      if (tideDir === "rising" && !(windFromSouth && isStrongWind)) zt("Chef Pass", "Rising tide, manageable wind — north bank of the pass for reds and black drum on grass and shell edges.");
      if (tideDir === "rising" && windFromSouth && isStrongWind) zt("Chef Pass", "⚠ Skip this window — come back on next falling tide or when wind lightens.");
      if (tideDir === "slack" && isModerateWind) zt("Chef Pass", `⚠ Slack tide but ${windDir} wind at ${windSpeed}mph — IWW corridor acts as a wind funnel. Fish the bank the wind hits directly.`);
      if (season === "winter") zt("Chef Pass", "Winter: IWW holds some of the warmest moving water in the area — current prevents hard temperature swings. Bass on wood structure inside the IWW. Reds schooled at the pass mouth.");
      if (season === "spring") zt("Chef Pass", "Spring: bass spawning on hard bottom just inside the cuts off IWW — look for beds in 1–3ft of clear water. Reds and trout moving back in as water warms.");
      if (season === "fall") zt("Chef Pass", "Fall: flounder stacking at the Chef Pass mouth and IWW intersections. Work the sandy transition bottom — this is one of the top fall flounder spots in the system.");
    }
    if (zones.includes("mrgo-interior")) {
      if (tideDir === "falling") zt("MRGO Marsh", "Interior pond edges and drain mouths. Gardner Island tide runs ~4hrs ahead of Shell Beach — verify which tide phase you're actually on.");
      if (tideDir === "rising") zt("MRGO Marsh", "Shallow pond edges and grass lines as water rises. Look for tailing reds and black drum rooting on shell.");
      if (isModerateWind) zt("MRGO Marsh", `Interior ponds are protected — use the marsh as a wind break. Fish the ${windwardBank} of each pond for stacked bait.`);
      if (season === "winter") zt("MRGO Marsh", "Winter: interior ponds can be very cold and slow. Look for dark mud bottom on south-facing pond edges that absorb sun — reds stack there on calm sunny days. Bass very slow.");
      if (season === "spring") zt("MRGO Marsh", "Spring: interior marsh comes alive — reds showing in every pothole and pond edge as water warms. Bass on structure edges. Best time to explore new ponds.");
      if (season === "summer") zt("MRGO Marsh", "Summer: interior ponds superheat — water temps can exceed the lake by 5°F. Get in and out before 9 AM. The MRGO channel itself stays cooler and holds fish through mid-morning.");
      if (season === "fall") zt("MRGO Marsh", "Fall: reds schooling in large pods in the interior ponds — sight fishing with topwater or gold spoons. Some of the best action of the year if you find the schools.");
    }
    if (zones.includes("pearl-river")) {
      if (highPearlRiver) {
        zt("Pearl River", "Pearl River running high — salinity very low near the mouth. Largemouth bass along wood structure and hydrilla edges. Reds possible on the lower brackish stretch.");
        zt("Pearl River", "Skip trout entirely — target bass on reaction baits and reds near the mouth.");
      } else {
        zt("Pearl River", "Brackish transition zone — redfish and black drum near the mouth. Largemouth bass further upriver in fresher water.");
      }
      if (isStrongWind) zt("Pearl River", "River corridor is well-sheltered from wind — good fallback zone when open water gets rough.");
      if (season === "winter") zt("Pearl River", "Winter: bass in deeper river bends on wood structure — slow presentation critical. Reds concentrated at the lower mouth where salinity is highest. River temps stay slightly warmer than open marsh.");
      if (season === "spring") zt("Pearl River", "Spring: bass spawning on shallow hard bottom and submerged wood in 2–4ft. Reds moving upriver as temps rise. Good topwater bass bite as water reaches 65°F.");
      if (season === "summer") zt("Pearl River", "Summer: river corridor offers shade and slightly cooler water than open marsh. Bass on shaded banks and under overhanging vegetation. Fish very early — river bass go lockjaw after 9 AM in summer.");
      if (season === "fall") zt("Pearl River", "Fall: bass very active as temps drop — reaction baits and moving lures productive. Reds stacking near the mouth. One of the better bass fisheries in the system this time of year.");
    }

    const zoneTips = Object.entries(zoneMap).map(([label, tips]) => ({ label, tips }));

    return { startTime, endTime, tideDir, tideChange, windDir, windSpeed, strategy, primarySpecies, zoneTips, avoid, caution };
  });
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

function TideChart({ predictions, predictions2 = [], blendWeight = 0.5, label1 = "Station 1", label2 = "Station 2" }) {
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

      <div style={{ display: "flex", gap: 14, marginTop: 2, flexWrap: "wrap" }}>
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
        <input type="time" value={block.startTime} onChange={e => onChange(index, "startTime", e.target.value)} />
        <label>End</label>
        <input type="time" value={block.endTime} onChange={e => onChange(index, "endTime", e.target.value)} />
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
function BlockCard({ block }) {
  const [open, setOpen] = useState(true);
  const hasAvoid = block.avoid.length > 0;
  const hasCaution = block.caution.length > 0;
  const hasZoneWarning = block.zoneTips.some(z => z.tips.some(t => t.includes("⚠")));
  return (
    <div className={`bc ${block.tideDir}${hasAvoid ? " bw" : ""}`}>
      <div className="bh" onClick={() => setOpen(o => !o)}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span className="bt">{block.startTime} – {block.endTime}</span>
          <span className={`ti ${block.tideDir}`}>{block.tideDir === "falling" ? "↓" : block.tideDir === "rising" ? "↑" : "—"}</span>
          <span className={`badge tb-${block.tideDir}`}>{block.tideDir}</span>
          <span className="badge wb">{block.windDir} {block.windSpeed}mph</span>
          {block.tideChange > 0 && <span className="badge" style={{ background: "rgba(255,255,255,0.04)", color: "#5a7a94" }}>Δ{block.tideChange}ft</span>}
          {hasAvoid && <span className="badge" style={{ background: "rgba(224,90,43,0.15)", color: "#e05a2b" }}>⚠ Rule Triggered</span>}
          {hasZoneWarning && !hasAvoid && <span className="badge" style={{ background: "rgba(224,90,43,0.15)", color: "#e05a2b" }}>⚠ Zone Warning</span>}
          {hasCaution && !hasAvoid && !hasZoneWarning && <span className="badge" style={{ background: "rgba(200,160,0,0.12)", color: "#c8a000" }}>⚡ Caution</span>}
        </div>
        <span style={{ fontSize: "0.65rem", color: "#5a7a94" }}>{open ? "▲" : "▼"}</span>
      </div>
      {open && (
        <div className="bb">
          {block.strategy.length > 0 && <Section title="Strategy" items={block.strategy} />}
          {block.primarySpecies.length > 0 && <Section title="Target Species" items={block.primarySpecies} color="#00c8a0" />}
          {block.zoneTips.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontFamily: "IBM Plex Mono, monospace", fontSize: "0.6rem", letterSpacing: 2, textTransform: "uppercase", color: "#5a7a94", marginBottom: 7 }}>Zone Tips</div>
              <ul style={{ listStyle: "none" }}>
                {block.zoneTips.map(({ label, tips }, i) => (
                  <li key={i} style={{ fontSize: "0.855rem", lineHeight: 1.55, paddingLeft: 13, position: "relative", marginBottom: 4 }}>
                    <span style={{ position: "absolute", left: 0, color: "#00c8a0" }}>›</span>
                    <span style={{ color: "#d0e4f0" }}>{label}: </span>
                    {tips.map((tip, j) => {
                      const isWarn = tip.includes("⚠");
                      return (
                        <span key={j} style={{ color: isWarn ? "#f08070" : "#d0e4f0" }}>
                          {j > 0 && " "}{tip}
                        </span>
                      );
                    })}
                  </li>
                ))}
              </ul>
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
  const [zones, setZones] = useState(["lake-borgne"]);
  const [tripStart, setTripStart] = useState("");
  const [tripEnd,   setTripEnd]   = useState("");
  const [blocks, setBlocks] = useState([]);
  const [notes, setNotes] = useState("");
  const [plan, setPlan] = useState(null);
  const [userRules, setUserRules] = useState([]);
  const [trips, setTrips] = useState([]);
  const [currentUser, setCurrentUser] = useState(null);
  const [showFeedback, setShowFeedback] = useState(false);

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

  const handleCoordsChange = (newCoords) => {
    setCoords(newCoords);
    const poly = newCoords
      .filter(c => c.lat !== "" && c.lng !== "" && !isNaN(parseFloat(c.lat)) && !isNaN(parseFloat(c.lng)))
      .map(c => ({ lat: parseFloat(c.lat), lng: parseFloat(c.lng) }));
    const auto = poly.length >= 3
      ? ZONES.filter(z => z.id === "lake-borgne" || pointInPolygon({ lat: z.lat, lng: z.lng }, poly)).map(z => z.id)
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
    const status = [];
    const log = msg => { status.push(msg); setFetchStatus([...status]); };

    const validCoords = coords.filter(c => !isNaN(parseFloat(c.lat)) && !isNaN(parseFloat(c.lng)));
    const lat = (validCoords.reduce((s,c) => s + parseFloat(c.lat), 0) / validCoords.length).toFixed(4);
    const lng = (validCoords.reduce((s,c) => s + parseFloat(c.lng), 0) / validCoords.length).toFixed(4);

    await Promise.allSettled([
      (async () => {
        try {
          log("Fetching tides…");
          const p1 = await fetchNOAATides(tideStation, tideDate);
          setTidePreds(p1); setTidePreds2([]);
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

    const preds = tidePreds2.length > 0
      ? tidePreds.map((p,i) => ({ ...p, height: p.height*(1-blendWeight) + (tidePreds2[i]?.height ?? p.height)*blendWeight }))
      : tidePreds;

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
    const SLACK_HALF = 30;
    const MIN_BLOCK = 20;
    const SPEED_DELTA = 5; // mph cumulative change from segment start

    // ── detect tide turning points algorithmically from hourly curve ─────────
    const hilos = preds
      .map((p, i, arr) => {
        if (i === 0 || i === arr.length - 1) return null;
        const isMax = p.height > arr[i-1].height && p.height > arr[i+1].height;
        const isMin = p.height < arr[i-1].height && p.height < arr[i+1].height;
        if (!isMax && !isMin) return null;
        return { ...p, min: toMin(p.time), type: isMax ? "High" : "Low" };
      })
      .filter(Boolean)
      .filter(p => p.min > startMin + 15 && p.min < endMin - 15)
      .sort((a,b) => a.min - b.min);

    const slackZones = hilos.map(h => ({
      start: Math.max(startMin, h.min - SLACK_HALF),
      end:   Math.min(endMin,   h.min + SLACK_HALF),
      hilo:  h,
    }));

    // ── collect all split points within non-slack segments ───────────────────
    const splitPoints = new Set();
    slackZones.forEach(sz => { splitPoints.add(sz.start); splitPoints.add(sz.end); });

    if (windForecast.length > 1) {
      const inSlack = min => slackZones.some(sz => min > sz.start && min < sz.end);
      const windInWindow = windForecast.filter(w => {
        const [wh,wm] = w.time.split(":").map(Number);
        const m = wh*60+wm;
        return m >= startMin && m <= endMin;
      });

      // Compare each hour against the reference at the START of the current
      // segment so gradual cumulative changes (e.g. +2mph/hr) still split.
      let ref = windInWindow[0];
      for (let i = 1; i < windInWindow.length; i++) {
        const curr = windInWindow[i];
        const [wh,wm] = curr.time.split(":").map(Number);
        const wMin = wh*60+wm;
        if (inSlack(wMin)) { ref = curr; continue; }

        const dirShift = curr.dir !== ref.dir;
        const spdShift = Math.abs(curr.speed - ref.speed) >= SPEED_DELTA;
        if (dirShift || spdShift) {
          splitPoints.add(wMin);
          ref = curr; // reset reference to this new segment start
        }
      }
    }

    // ── build ordered list of all boundaries ─────────────────────────────────
    const boundaries = [startMin, ...splitPoints, endMin]
      .filter(m => m >= startMin && m <= endMin)
      .sort((a, b) => a - b)
      .filter((m, i, arr) => i === 0 || m - arr[i - 1] >= MIN_BLOCK); // drop too-close splits

    // ── create one block per adjacent pair of boundaries ─────────────────────
    const newBlocks = [];
    for (let i = 0; i < boundaries.length - 1; i++) {
      const s = boundaries[i], e = boundaries[i + 1];
      const mid = (s + e) / 2;
      const isSlack = slackZones.some(sz => s >= sz.start && e <= sz.end);

      let tideDir, tideChange;
      if (isSlack) {
        tideDir = "slack"; tideChange = 0;
      } else {
        const net = heightAt(e) - heightAt(s);
        tideDir = Math.abs(net) < 0.08 ? "slack" : net > 0 ? "rising" : "falling";
        tideChange = parseFloat(Math.abs(net).toFixed(2));
      }

      newBlocks.push({ startTime: toTime(s), endTime: toTime(e), tideDir, tideChange, ...windAt(mid) });
    }

    if (newBlocks.length) setBlocks(newBlocks);
  };

  const generate = () => {
    const salReadings = waterQuality.filter(s => s.salNow !== null).map(s => s.salNow);
    const minSalinity = salReadings.length ? Math.min(...salReadings) : null;
    const moon = tideDate ? getMoonPhase(tideDate) : null;
    const pressures = windForecast.map(w => w.pressure).filter(Boolean);
    const pressureTrend = pressures.length >= 6
      ? (() => { const e = pressures.slice(0,3).reduce((a,b)=>a+b,0)/3; const l = pressures.slice(-3).reduce((a,b)=>a+b,0)/3; return l - e > 1 ? "rising" : l - e < -1 ? "falling" : "steady"; })()
      : "steady";
    setPlan(generatePlan(blocks, zones, allRules, riverFt, minSalinity, pearlRiverFt, moon, pressureTrend, waterTempF, tideDate));
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
          {[["setup","Trip Setup"],["plan","Game Plan"],["map","Map"],["rules","Rules DB"],["history","History"]].map(([id, lbl]) => (
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
                    <input type="time" value={tripStart} onChange={e => setTripStart(e.target.value)} />
                  </div>
                  <div>
                    <div style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.62rem", color:"var(--mu)", textTransform:"uppercase", letterSpacing:1, marginBottom:5 }}>Trip End</div>
                    <input type="time" value={tripEnd} onChange={e => setTripEnd(e.target.value)} />
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

              <div className="two">
                {/* LEFT: Coords + Zones + Wind Forecast */}
                <div>
                  <div className="sl">Boundary Coordinates</div>
                  <div className="card">
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

                  <div className="sl">Zones in Area</div>
                  <div className="card">
                    <div className="zpills">
                      {ZONES.map(z => <div key={z.id} className={`zp ${zones.includes(z.id)?"on":""}`} onClick={() => togZone(z.id)}>{z.label}</div>)}
                    </div>
                  </div>

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

                {/* RIGHT: River + Water Quality + Tide Chart */}
                <div>
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
              {riverFt !== null && riverFt > 12 && (
                <div className="card" style={{ borderColor:"var(--wn)", borderLeft:"3px solid var(--wn)", marginBottom:14 }}>
                  <div style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.68rem", color:"var(--wn)", marginBottom:4, textTransform:"uppercase", letterSpacing:1 }}>⚠ River Level Alert</div>
                  <div style={{ fontSize:"0.84rem" }}>Mississippi R. at {riverFt.toFixed(1)}ft — elevated freshwater. Trout likely displaced toward Lake Borgne. Prioritize redfish.</div>
                </div>
              )}
              {waterQuality.length > 0 && waterQuality.some(s => s.salNow !== null && s.salNow < 10) && (() => {
                const lowSal = waterQuality.some(s => s.salNow !== null && s.salNow < 5);
                const hasBorgne = zones.includes("lake-borgne");
                return (
                  <div className="card" style={{ borderColor:"#c8a000", borderLeft:"3px solid #c8a000", marginBottom:14 }}>
                    <div style={{ fontFamily:"IBM Plex Mono,monospace", fontSize:"0.68rem", color:"#c8a000", marginBottom:6, textTransform:"uppercase", letterSpacing:1 }}>⚡ Salinity Alert</div>
                    {waterQuality.filter(s => s.salNow !== null).map(s => (
                      <div key={s.id} style={{ fontSize:"0.84rem", marginBottom:3 }}>
                        <span style={{ color: salinityLabel(s.salNow).color }}>{s.salNow.toFixed(1)} ppt</span>
                        <span style={{ color:"var(--mu)" }}> at {s.label} — {salinityLabel(s.salNow).text}</span>
                      </div>
                    ))}
                    {lowSal && (
                      <div style={{ fontSize:"0.82rem", color:"#c8a000", marginTop:8, paddingTop:8, borderTop:"1px solid var(--bd)" }}>
                        {hasBorgne
                          ? "Trout displaced to open Lake Borgne — target shell reef edges in cleaner water on the east end."
                          : "Trout displaced to open Lake Borgne — not in your zones. Add Lake Borgne to target them, or focus on redfish, black drum, and bass."}
                      </div>
                    )}
                  </div>
                );
              })()}
              {plan.map((b,i) => <BlockCard key={i} block={b} />)}
              {notes && (
                <>
                  <div className="sl" style={{ marginTop:18 }}>Trip Notes</div>
                  <div className="card"><p style={{ fontSize:"0.87rem", lineHeight:1.6 }}>{notes}</p></div>
                </>
              )}
            </>
          )}
          {tab === "plan" && !plan && <p style={{ color:"var(--mu)", fontFamily:"IBM Plex Mono,monospace", fontSize:"0.8rem" }}>Complete Trip Setup and generate a plan first.</p>}

          {/* MAP */}
          {tab === "map" && (
            <>
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
