-- Allow a third theme preference, 'system', which follows the user's device
-- (phone / laptop) light-or-dark appearance setting automatically. Without this
-- the users.theme CHECK constraint rejects 'system' and cross-device sync of that
-- choice silently fails (the app still holds it locally via the persisted store).
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_theme_check;
ALTER TABLE users ADD  CONSTRAINT users_theme_check CHECK (theme IN ('light', 'dark', 'system'));
