ALTER TABLE "User"
ADD COLUMN "avatarUrl" TEXT,
ADD COLUMN "locale" TEXT NOT NULL DEFAULT 'ar',
ADD COLUMN "theme" TEXT NOT NULL DEFAULT 'system';

ALTER TABLE "User"
ADD CONSTRAINT "User_locale_check" CHECK ("locale" IN ('ar', 'he', 'en')),
ADD CONSTRAINT "User_theme_check" CHECK ("theme" IN ('light', 'dark', 'system'));
