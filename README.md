# Marsh Intel

A fishing planning tool for the southeast Louisiana marsh system — Lake St. Catherine, Lake Catherine Cuts/Trenasses, Chef Pass/IWW, MRGO Interior Marsh, and Pearl River Marsh.

## What it does

- Fetches tide predictions, wind forecasts, river levels, salinity, and water temperature
- Scores fishing zones by conditions (tide direction, height, wind, season, freshwater) for each time block
- Generates a time-block plan with zone-specific tips, top pick, strategy context, and species targets
- Renders an interactive tide chart with wind-adjusted height line and wind×tide interaction strip
- **Scout tab** — compare all saved presets for any date, ranked by average score, so you can pick the best location before you go

## Stack

- React 18 + Vite (single-file component: `fishing-tool.jsx`)
- Firebase Auth + Firestore (saved presets, custom rules, trip debriefs)
- Leaflet (wind forecast map point picker)
- Netlify (auto-deploy on push to `main`)

## Data sources

| Data | Source |
|---|---|
| Tide predictions | NOAA CO-OPS API (dual-station blend) |
| Wind forecast | National Weather Service gridpoint API |
| Mississippi River level | USGS gauge 07374000 (Carrollton) |
| Pearl River level | USGS gauge 02492000 (Pearl River, LA) |
| Rigolets salinity | USGS water quality station 301001089442600 |
| Water temperature | USGS |

## Zone scoring model

Each time block is scored 0–10 per zone based on:

- **Tide direction** — rising/falling/slack, weighted per zone character
- **Tide height** — MRGO Interior is ~1ft at slack; falling tide penalties scale with actual height
- **Wind speed/direction** — sheltered zones (MRGO, Pearl River) score higher in rough wind
- **Freshwater** — Carrollton gauge drives MRGO/Chef Pass; Rigolets salinity drives St. Catherine/Cuts; Pearl River gauge drives Pearl River Marsh only
- **Season** — species availability shifts by month

## Local development

```bash
npm install
npm run dev
```

Requires a `.env` file with Firebase config keys (see `.env.example` or existing `.env`).

## Deploy

Push to `main` — Netlify auto-builds and deploys in ~1–2 minutes.

```bash
git add -A && git commit -m "your message" && git push
```
