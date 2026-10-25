-- CreateEnum
CREATE TYPE "NoteSyncStatus" AS ENUM ('PENDING', 'SYNCED', 'FAILED');

-- CreateTable
CREATE TABLE "HubSpotConnection" (
    "id" TEXT NOT NULL,
    "hubspotPortalId" TEXT NOT NULL,
    "accessTokenEncrypted" TEXT NOT NULL,
    "refreshTokenEncrypted" TEXT NOT NULL,
    "tokenExpiresAt" TIMESTAMP(3),
    "syncCursor" TEXT,
    "lastSyncAt" TIMESTAMP(3),
    "syncStatus" TEXT NOT NULL DEFAULT 'IDLE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HubSpotConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Contact" (
    "id" TEXT NOT NULL,
    "hubspotContactId" TEXT NOT NULL,
    "email" TEXT,
    "firstName" TEXT,
    "lastName" TEXT,
    "properties" JSONB,
    "connectionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Note" (
    "id" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "hubspotNoteId" TEXT,
    "syncStatus" "NoteSyncStatus" NOT NULL DEFAULT 'PENDING',
    "lastSyncError" TEXT,
    "syncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Note_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "HubSpotConnection_hubspotPortalId_key" ON "HubSpotConnection"("hubspotPortalId");

-- CreateIndex
CREATE INDEX "Contact_connectionId_email_idx" ON "Contact"("connectionId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "Contact_connectionId_hubspotContactId_key" ON "Contact"("connectionId", "hubspotContactId");

-- CreateIndex
CREATE INDEX "Note_contactId_syncStatus_idx" ON "Note"("contactId", "syncStatus");

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "HubSpotConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Note" ADD CONSTRAINT "Note_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
