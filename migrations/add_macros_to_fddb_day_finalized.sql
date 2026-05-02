-- Add macro columns to fddb_day_finalized so each finalized day also stores
-- the actual intake (kcal, protein, carbs, fat). These are set when a day is
-- finalized (auto or manual) and can be NULL for freeze/sick days.

ALTER TABLE fddb_day_finalized
  ADD COLUMN IF NOT EXISTS kcal     REAL,
  ADD COLUMN IF NOT EXISTS protein  REAL,
  ADD COLUMN IF NOT EXISTS carbs    REAL,
  ADD COLUMN IF NOT EXISTS fat      REAL;
