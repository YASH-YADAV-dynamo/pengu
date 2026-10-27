import { defineConfig } from 'prisma/config'

try {
  process.loadEnvFile('.env')
} catch {
  /* no .env: use the real environment */
}

// `prisma migrate deploy` (run by `npm run setup` for a hosted database) uses DIRECT_URL when set, else DATABASE_URL.
// Neon users: DIRECT_URL is the non-pooled string, because migrations need a real session. The running API uses DATABASE_URL (lib/db.ts).
// Loaded here because the Prisma CLI does not read server/.env on its own with a config file.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? 'postgresql://user:password@localhost:5432/pengu' }
})
