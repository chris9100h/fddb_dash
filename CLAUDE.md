# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

FDDB Dash (internal name "FDDB Check") is a PWA for daily calorie and macro tracking. It pulls food diary data from fddb.info via a GitHub Actions scraper and displays it as a checklist with adherence tracking, a timeline view, stats charts, and a recipe library.

## Pflichtregeln

- **DB-Migrationen**: Wenn eine Änderung eine neue Tabelle, Spalte, Index oder sonstiges Schema-Update in Supabase erfordert, muss das explizit kommuniziert werden — inklusive dem genauen SQL, das im Supabase SQL Editor ausgeführt werden muss. Niemals stillschweigend davon ausgehen, dass das Schema bereits passt.
- **CLAUDE.md aktuell halten**: Wenn eine neue Spalte oder Tabelle hinzukommt, muss der Abschnitt „DB schema" in dieser Datei im selben Commit aktualisiert werden.

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

Main DB tables and their columns:

**`fddb_daily_macros`** — one row per food item per day
`id`, `date`, `meal` (slot key), `item_name`, `kcal`, `protein`, `carbs`, `fat`, `serving_index` (0-based for multi-serving recipes), `sort_order` (int, drag-reorder position), `fddb_group_id` (UUID grouping servings of the same recipe on a day)

**`fddb_checklist_status`** — checkbox state
`date`, `item_key` (composite key format `meal::item_name` or `meal::recipe_name::serving_index`), `checked` (bool) — unique on `(date, item_key)`

**`fddb_item_times`** — timeline drag positions
`date`, `item_key`, `minutes` (int, minutes since midnight; 0–1439 for real times, sentinels above 1439) — unique on `(date, item_key)`

**`fddb_day_type`** — training vs rest classification
`date` (PK), `type` (`'training'` | `'rest'`)

**`fddb_day_finalized`** — adherence history and streak data
`date` (PK), `adherence` (float 0–100; 0 for non-counted statuses), `counted` (bool), `goal_used` (float), `status` (`'counted'` | `'freeze'` | `'sick'` | `'vacation'`), `kcal`, `protein`, `carbs`, `fat`

**`fddb_coach_targets`** — macro goals, versioned
`id`, `type` (`'training'` | `'rest'`), `valid_from` (date), `kcal`, `protein`, `carbs`, `fat` — the most recent row with `valid_from ≤ today` wins

**`fddb_settings`** — per-user app settings
`key` (snake_case string, PK), `value` (JSON-encoded) — see `SETTING_DB_KEYS` in `app.js:170` for all keys

**`fddb_config`** — scraper credentials
`key`, `value` — stores `gh_token` and `gh_repo` for triggering the GitHub Actions scraper

**`fddb_recipes`** — recipe definitions
`id`, `name`, `servings` (int), `is_template` (bool), `template_id` (FK → `fddb_recipes.id`, null if standalone), `expires_at` (timestamptz, null = permanent; set = temporary recipe, purged on next app load after expiry)

**`fddb_recipe_items`** — ingredient list per recipe
`recipe_id` (FK), `item_name` (string matching names in `fddb_daily_macros`)

**`fddb_recipe_categories`** — category tags per recipe
`recipe_id` (FK), `category_id` (FK → `fddb_categories.id`)

**`fddb_categories`** — user-defined recipe categories
`id`, `name`

**`fddb_units`** — units recognised by the strip-amount regex
`unit` (string, e.g. `'g'`, `'ml'`, `'stk'`)

Water DB (separate Supabase project):

**`water_logs`** — daily water intake entries
`date`, `amount` (ml)

**`water_settings`** — water goal config
`id` (always 1), `goal` (ml)

**`weight_entries`** — body weight log (read-only in stats)
`date`, `weight` (float)

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
