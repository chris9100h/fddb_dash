# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

FDDB Dash (internal name "FDDB Check") is a PWA for daily calorie and macro tracking. It pulls food diary data from fddb.info via a GitHub Actions scraper and displays it as a checklist with adherence tracking, a timeline view, stats charts, and a recipe library.

## No build step

This is a vanilla HTML/CSS/JS project with no bundler or framework. There are no `npm install`, `build`, `lint`, or `test` commands. To develop:

1. Serve the repo root over any static HTTP server, e.g.:
   ```
   python3 -m http.server 8080
   ```
2. Open `http://localhost:8080` in a browser.
3. Sign in with a Supabase-authenticated email/password.

After any change to `index.html`, `styles.css`, `app.js`, or icons, **bump `CACHE_VERSION`** in `sw.js` (e.g. `v177` → `v178`). This purges the Service Worker cache so the browser picks up changes instead of serving stale shell assets from cache-first storage.

## Architecture

Everything lives in four files:

| File | Role |
|------|------|
| `index.html` | All views (Today, Recipes, Stats, Settings) and all modal markup in one file |
| `app.js` | All application logic (~5800 lines, plain ES2020, no modules) |
| `styles.css` | All styles |
| `sw.js` | Service Worker — cache-first for shell/CDN assets, network-only for Supabase and GitHub API |

### Views

`index.html` contains four `<section class="view">` elements. `showView(id)` in `app.js` swaps the active class. Tab bar buttons reference these view IDs directly. There is no router.

The **Today** view has two sub-modes toggled by `setTodayView(mode)`:
- `'dashboard'` — meal cards with checkboxes, hero adherence ring
- `'timeline'` — time-slotted drag-and-drop blocks (`renderTimelineDashboard`)

### Data layer — two Supabase projects

```js
const db = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);       // main food DB
const dbWater = supabase.createClient(WATER_URL, WATER_KEY);         // separate water-tracking DB
```

Main DB tables used at runtime:

| Table | Purpose |
|-------|---------|
| `fddb_daily_macros` | Raw food entries per date/meal |
| `fddb_checklist_status` | item_key → checked state per date |
| `fddb_coach_targets` | Training/rest macro targets (versioned by `valid_from`) |
| `fddb_day_type` | `training` or `rest` per date |
| `fddb_item_times` | Minute-of-day assignments for timeline drag positions |
| `fddb_finalized_days` | Adherence scores, streaks, freeze/sick/vacation status |
| `fddb_settings` | User settings (keyed by snake_case string, JSON values) |
| `fddb_config` | `gh_token` and `gh_repo` used to trigger the scraper workflow |
| `fddb_recipes` | Recipe definitions (ingredients, categories, servings) |

Water DB tables: `water_logs`, `water_settings`.

### Sync / scraper

The Sync button calls `triggerScraper()`, which dispatches the `scrape.yml` GitHub Actions workflow via the GitHub REST API. The token and repo slug come from `fddb_config` in Supabase, not from the frontend source code.

### Settings

Settings have three layers: `SETTINGS_DEFAULTS` (in `app.js`) → `localStorage` cache (key `fddb.settings.cache.v1`) → `fddb_settings` Supabase table. On load, the cache is applied synchronously (no flash), then `loadSettingsFromDb()` merges any remote changes.

The `SETTING_DB_KEYS` map at `app.js:170` defines the camelCase ↔ snake_case translation.

### Meal naming

Meal slots use German keys from FDDB internally; `LABELS` maps them to English for display:

```js
const ORDER = ['frühstück','zwischenmahlzeit 1','snack_2','mittagessen',
               'zwischenmahlzeit 2','snack_4','abendbrot','abendessen'];
```

Special synthetic meals: `weekly_treat`, `meal_of_choice`, `unplanned`.

### Timeline sentinels

Items placed in special slots use out-of-range minute values so they don't collide with clock-time slots (normal range 180–1320):

| Constant | Value | Meaning |
|----------|-------|---------|
| `INTRA_WORKOUT_SLOT` / `_2` | 1440 / 1441 | Training intra-workout rows |
| `INTRA_CARDIO_SLOT` / `_2` | 1470 / 1471 | Cardio intra-cardio rows |

### Tweaks / theming

`TWEAK_DEFAULTS` in `app.js` (marked with `/*EDITMODE-BEGIN*/` … `/*EDITMODE-END*/` comments) controls accent color, border radius, density, and blur. `applyTweaks()` writes CSS custom properties to `:root`. The Tweaks panel is opened via `postMessage` (`__activate_edit_mode`) from a parent frame.

### Drag & drop

Implemented in an IIFE at `app.js:4944`. Uses long-press (260 ms) on touch and a move-threshold on mouse. Drop targets are meal cards. Positions persist to `fddb_item_times` in Supabase.
