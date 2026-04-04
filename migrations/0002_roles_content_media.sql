-- Migration 0002: Add 'mod' role, content table, and media table

-- Recreate users table to allow 'mod' as a valid role (SQLite CHECK cannot be altered in-place)
PRAGMA foreign_keys = OFF;
ALTER TABLE users RENAME TO users_backup_v1;
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('admin', 'mod', 'owner')),
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_iterations INTEGER NOT NULL DEFAULT 310000,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO users SELECT * FROM users_backup_v1;
DROP TABLE users_backup_v1;
PRAGMA foreign_keys = ON;

CREATE INDEX IF NOT EXISTS idx_users_username_ci ON users(username COLLATE NOCASE);

-- Editable page content stored as page + key + value triples
CREATE TABLE IF NOT EXISTS content (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  page TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL DEFAULT '',
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(page, key)
);

-- Media library: images and videos added by URL
CREATE TABLE IF NOT EXISTS media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'image' CHECK (type IN ('image', 'video')),
  added_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
