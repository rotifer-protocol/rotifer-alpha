-- Event-family cooldown parameters (Phase 1 → evolvable, 2026-05-19)
--
-- Replaces the calendar-day count gate (getDailyEventFamilyEntryCounts +
-- todayStart) with a per-fund rolling cooldown window.
--
-- Semantics:
--   "At most max_same_event_positions entries per fund per event family
--    within the last event_family_cooldown_hours hours."
--
-- Default values deliberately replicate pre-migration behaviour:
--   max_same_event_positions = 1  (same ceiling as before)
--   event_family_cooldown_hours  = 6  (replaces UTC midnight reset;
--                                      allows re-entry later in the day
--                                      without the James Bond bypass risk)
--
-- Both columns are now wired into evolve.ts so PBT can independently
-- tune concentration tolerance per fund.

ALTER TABLE fund_configs ADD COLUMN max_same_event_positions    INTEGER NOT NULL DEFAULT 1;
ALTER TABLE fund_configs ADD COLUMN event_family_cooldown_hours INTEGER NOT NULL DEFAULT 6;
