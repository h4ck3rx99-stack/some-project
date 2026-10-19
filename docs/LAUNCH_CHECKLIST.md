# Launch checklist

- [ ] Buy the domain; add it as a Cloudflare zone
- [ ] Upgrade to Workers Paid ($5/month)
- [ ] `wrangler d1 create cartprobe` → put the id in `wrangler.toml`; `wrangler r2 bucket create cartprobe-captures`
- [ ] Set `APP_URL`, `APP_DOMAIN`, `EMAIL_FROM`, `ADMIN_EMAILS` in `wrangler.toml` `[vars]`
- [ ] Set secrets: `SESSION_SECRET`, `IP_HASH_SALT`, `ENCRYPTION_KEY`, `EMAIL_API_KEY`, `BILLING_WEBHOOK_SECRET`
- [ ] `npm run db:migrate:remote`, then `npm run deploy`; attach the custom domain to the Worker
- [ ] Email: verify the sending domain with the provider; SPF, DKIM, DMARC records; test a magic link to Gmail and Outlook
- [ ] Merchant of record: create products for Store/Agency/Vendor (monthly + annual), sandbox checkout links in `CHECKOUT_URL_*`, translation to CartProbe's webhook format, sandbox webhooks tested end to end (create, renew, cancel, duplicate)
- [ ] Switch `BILLING_PROVIDER=webhook` only after the sandbox test passes
- [ ] Have a lawyer review /terms, /privacy, /aup (placeholder text today)
- [ ] `/bot` page live; abuse/opt-out contact address published on /bot and /aup
- [ ] Verify rate limits in production (6th anonymous scan per hour returns 429)
- [ ] Install WordPress + WooCommerce locally with "UCP Ready" and, separately, "WebToffee Universal Commerce Protocol Enabler"; scan each; fix false positives
- [ ] Run `npm run market-count` on a few hundred store domains; draft a "State of agent readiness" post from the CSV
- [ ] Watch `/admin/health` (cron runs, backlog) for a week before announcing
- [ ] Pick Product Hunt / Show HN timing (a weekday morning US time; not the week of a UCP release)
