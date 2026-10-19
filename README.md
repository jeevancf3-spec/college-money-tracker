# My College Money Tracker

Node.js + Express app using PostgreSQL for persistent tracker data.

## Run locally
1. Install Node.js LTS.
2. Extract this ZIP.
3. In this folder run `npm install`.
4. Copy `.env.example` to `.env` and fill in your own private values.
5. Run `npm start`.
6. Open `http://localhost:3000`.

Keep `.env` private. Never commit it to GitHub or send your database connection string/passwords in chat. This package does not include your local financial-data JSON or `node_modules`; keep your own backup safe.

See `TEST-RESULTS.md` for what was and was not tested. This is not yet the full family-registration/Parent-Student feature update.


## Individual accounts and private data

The login page now supports account creation. Each new account receives its own PostgreSQL data row and can only read or change its own tracker records. Passwords are stored as salted scrypt hashes.

On the first deployment of this version, existing records in `college_money_tracker_state` are copied (not deleted) into the account named by `ADMIN_USERNAME`. The legacy row remains intact as a safety copy. The existing environment-configured accounts are retained; new sign-ups use a username and a password of at least 8 characters.

Before deploying, take a Neon database backup/snapshot if available. Deploy this version without changing `DATABASE_URL` or `SESSION_SECRET`. After deploy, log in with the existing `ADMIN_USERNAME` account and verify the existing records are present before using other accounts. New accounts start with empty data.
