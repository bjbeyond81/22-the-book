# The first 22 get 22

Deploy worker.mjs as a Cloudflare Worker on first22.bjbeyond.it. GitHub Pages serves the root HTML.

- Bind a private D1 database with EU jurisdiction as SIGNUPS and apply schema.sql.
- Bind Cloudflare Email Sending as MAILER. Set MAIL_FROM to an onboarded sender. Sending to public recipients requires Workers Paid.
- Configure a managed Turnstile widget for 22.bjbeyond.it. Set TURNSTILE_SITE_KEY and store TURNSTILE_SECRET as a Worker secret.
- Set API_ORIGIN to https://first22.bjbeyond.it. Add a daily Cron Trigger. Test with a separate database and a controlled mailbox. Before merging, verify a real Turnstile response and email round trip on Cloudflare. Set ACCEPTING to true when ready to open entries.
- Run node _first22/verify.mjs with Node 24 for the SQLite integration checks.

At publication, use the private D1 dashboard to select the recipients below. Send the eBook individually and set delivered_at to the timestamp in milliseconds after each successful delivery. The daily job removes their addresses after 30 days and retains anonymous allocation rows.

    SELECT slot, email, language FROM first22 WHERE slot IS NOT NULL AND email IS NOT NULL AND delivered_at IS NULL ORDER BY slot;
