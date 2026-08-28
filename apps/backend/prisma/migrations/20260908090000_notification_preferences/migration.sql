CREATE TYPE "NotificationDelivery" AS ENUM ('IN_APP', 'OFF');

ALTER TABLE "User"
ADD COLUMN "notificationNewMessage" "NotificationDelivery" NOT NULL DEFAULT 'IN_APP',
ADD COLUMN "notificationAssignment" "NotificationDelivery" NOT NULL DEFAULT 'IN_APP',
ADD COLUMN "notificationMention" "NotificationDelivery" NOT NULL DEFAULT 'IN_APP',
ADD COLUMN "notificationResolution" "NotificationDelivery" NOT NULL DEFAULT 'IN_APP',
ADD COLUMN "notificationEscalation" "NotificationDelivery" NOT NULL DEFAULT 'IN_APP',
ADD COLUMN "notificationSound" BOOLEAN NOT NULL DEFAULT true;
