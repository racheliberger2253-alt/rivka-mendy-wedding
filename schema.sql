CREATE TABLE IF NOT EXISTS responses (
  token      TEXT PRIMARY KEY,
  name       TEXT NOT NULL DEFAULT '',
  answers    TEXT NOT NULL DEFAULT '{}',
  count      INTEGER NOT NULL DEFAULT 0,
  men        INTEGER NOT NULL DEFAULT 0,
  women      INTEGER NOT NULL DEFAULT 0,
  note       TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS docs (
  col        TEXT NOT NULL,
  id         TEXT NOT NULL,
  data       TEXT NOT NULL DEFAULT '{}',
  deleted    INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (col, id)
);
CREATE INDEX IF NOT EXISTS docs_updated ON docs(updated_at);

-- תמונות וסרטונים מהאורחים (נוצר גם אוטומטית בפעם הראשונה שמשתמשים)
CREATE TABLE IF NOT EXISTS photos (
  id TEXT PRIMARY KEY, event TEXT NOT NULL, r2key TEXT NOT NULL, name TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT '', size INTEGER NOT NULL DEFAULT 0, uploader TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '', upload_id TEXT, thumb INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS photos_ev ON photos(event, status, created_at);
CREATE TABLE IF NOT EXISTS photo_events (slug TEXT PRIMARY KEY, open INTEGER NOT NULL DEFAULT 1);
