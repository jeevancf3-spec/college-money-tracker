# My College Money Tracker

A Node.js/Express app for tracking money received from Dad, personal expenses, and semester fees.

## Login setup (local)

1. Install Node.js LTS if it is not already installed.
2. In this project folder, copy `.env.example` and name the copy `.env`.
3. Edit `.env` and set a unique `SESSION_SECRET` (at least 32 characters), `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `DAD_USERNAME`, and `DAD_PASSWORD`. Use different usernames and strong, unique passwords. Do not share or upload `.env`.
4. Open a terminal in this folder and run `npm install`.
5. Run `npm start` and open `http://localhost:3000`.
6. Sign in using the credentials you set in `.env`.

The app now requires a login session for all `/api` data endpoints and the tracker page. Both accounts access the same shared tracker, as intended for the student and Dad.

## Important before public hosting

- The current transactions are still stored in `money-tracker-data.json`. Keep a separate backup.
- Do not upload `.env` or `money-tracker-data.json` to GitHub. `.gitignore` excludes both, but check your repository before pushing.
- This version adds login but does **not** yet migrate transaction storage to a managed persistent database. Do not deploy it publicly until persistent storage and a production session store are configured. The default Express session store is in-memory and is not suitable for production.
- Use HTTPS for any public deployment and set `NODE_ENV=production` on the host.
