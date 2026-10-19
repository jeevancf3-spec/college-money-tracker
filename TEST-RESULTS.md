Account isolation update validation

- `node --check server.js`: passed.
- `node --check public/login.js`: passed.
- Registration validates usernames and requires passwords of at least 8 characters.
- Passwords are stored as salted scrypt hashes (not plaintext).
- User data is loaded and saved against the authenticated user ID in a separate PostgreSQL state row.
- Existing shared data is copied into the configured `ADMIN_USERNAME` account only when that account has no per-user state; the legacy shared row is not deleted.
- Runtime integration with the user's live Neon/Render database was not run from this environment. Take a database backup and verify the existing account before allowing public sign-ups.
