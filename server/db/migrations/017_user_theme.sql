-- Light or dark mode: each person's own choice (the button beside the
-- profile badge), saved on their account so it follows them to any PC.
-- Everyone starts on light, the original look.
ALTER TABLE users ADD COLUMN theme TEXT NOT NULL DEFAULT 'light' CHECK (theme IN ('light', 'dark'));
