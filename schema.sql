-- Runs automatically at server start; safe to run repeatedly.
-- The number columns (f_l, f_c, f_am, …) are added by server.js from fields.js.
CREATE TABLE IF NOT EXISTS entries (
  id          BIGSERIAL PRIMARY KEY,
  user_oid    UUID        NOT NULL,          -- Entra object id of the person who entered it
  user_name   TEXT        NOT NULL,
  user_email  TEXT,
  club        TEXT        NOT NULL,
  day         DATE        NOT NULL,
  part        TEXT        NOT NULL CHECK (part IN ('VM','NM')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS entries_user_day_idx ON entries (user_oid, day DESC);
CREATE INDEX IF NOT EXISTS entries_club_day_idx ON entries (club, day, part);

-- One entry per person per daypart (whatever the club).
CREATE UNIQUE INDEX IF NOT EXISTS entries_user_daypart_uniq ON entries (user_oid, day, part);
