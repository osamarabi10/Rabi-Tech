-- A subscriber's phone number is unknown until the WhatsApp QR is scanned.
ALTER TABLE "WhatsappSession" ALTER COLUMN "phoneNumber" DROP NOT NULL;
