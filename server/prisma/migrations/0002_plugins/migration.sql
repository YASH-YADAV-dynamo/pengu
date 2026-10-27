-- Plugins. A person's Slack member id (set by an admin with `user slack`), so a Slack mention acts as that person.
ALTER TABLE "User" ADD COLUMN "slackId" TEXT;
CREATE UNIQUE INDEX "User_slackId_key" ON "User"("slackId");

-- Event ids already handled, so a retried delivery (Slack resends after 3 s without an answer) is done once.
CREATE TABLE "PluginEvent" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PluginEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PluginEvent_at_idx" ON "PluginEvent"("at");
