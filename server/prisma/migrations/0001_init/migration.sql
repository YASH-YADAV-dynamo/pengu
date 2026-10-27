-- Pengu sync schema. One sequence orders every change across all tables, so an app can pull "everything after N".
CREATE SEQUENCE IF NOT EXISTS sync_seq;

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Discussion" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "meetAt" TIMESTAMP(3),
    "tagged" TEXT[],
    "doc" TEXT NOT NULL,
    "design" JSONB NOT NULL DEFAULT '[]',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "seq" BIGINT NOT NULL DEFAULT nextval('sync_seq'),

    CONSTRAINT "Discussion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ticket" (
    "id" TEXT NOT NULL,
    "discussionId" TEXT,
    "title" TEXT NOT NULL,
    "assignee" TEXT NOT NULL,
    "deadline" TEXT,
    "status" TEXT NOT NULL,
    "notes" TEXT NOT NULL DEFAULT '',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "seq" BIGINT NOT NULL DEFAULT nextval('sync_seq'),

    CONSTRAINT "Ticket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Roadmap" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "discussionIds" TEXT[],
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "seq" BIGINT NOT NULL DEFAULT nextval('sync_seq'),

    CONSTRAINT "Roadmap_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Note" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "seq" BIGINT NOT NULL DEFAULT nextval('sync_seq'),

    CONSTRAINT "Note_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoginFailure" (
    "id" SERIAL NOT NULL,
    "ip" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoginFailure_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Discussion_seq_idx" ON "Discussion"("seq");

-- CreateIndex
CREATE INDEX "Ticket_seq_idx" ON "Ticket"("seq");

-- CreateIndex
CREATE INDEX "Ticket_assignee_status_idx" ON "Ticket"("assignee", "status");

-- CreateIndex
CREATE INDEX "Roadmap_seq_idx" ON "Roadmap"("seq");

-- CreateIndex
CREATE INDEX "Note_seq_idx" ON "Note"("seq");

-- CreateIndex
CREATE INDEX "LoginFailure_ip_at_idx" ON "LoginFailure"("ip", "at");


-- Live document editing: one row per Yjs update (see lib/doc.ts).
CREATE TABLE "DocUpdate" (
    "id" BIGSERIAL NOT NULL,
    "docId" TEXT NOT NULL,
    "update" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocUpdate_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DocUpdate_docId_id_idx" ON "DocUpdate"("docId", "id");
