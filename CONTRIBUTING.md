# Contributing to Pengu

Thanks for helping! Five rules:

1. **Open an issue first** for anything bigger than a small fix, so we agree on the approach before you write it.
2. **One change per pull request**, branched from `main`, with a clear title and a short "why" in the description.
3. **Checks must pass:** `npm run typecheck`, and `cd server && npx tsc --noEmit && npm test` if you touched the server.
   Add a test for server behaviour you change.
4. **Never commit secrets or personal data:** no `.env` files, connection strings, passwords, tokens, keys or real user data.
   Report security problems privately (GitHub → Security → *Report a vulnerability*), not in public issues.
5. **Match the existing code and keep the credit:** follow the surrounding style, keep the security settings (sandboxed windows,
   validated IPC, server-side checks), and don't remove the author credit to Yash Yadav in `LICENSE`, `package.json` or the docs.

By contributing you agree your work is released under the MIT license.
