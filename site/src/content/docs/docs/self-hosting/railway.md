---
title: Deploy on Railway
description: Run the server on Railway with Postgres and a Railway bucket, and host the site on Cloudflare Pages.
---

This is how the hosted server runs: the server, Postgres and an
S3-compatible bucket for file contents on [Railway](https://railway.com), and
this site on [Cloudflare Pages](https://pages.cloudflare.com). The server image is the
repository's `Dockerfile`, and `railway.json` holds its build and health check
settings.

The examples use `api.example.com` for the server and `example.com` for the
site. Replace them with your domain.

## 1. Create the Railway project

1. Create a project and add a **PostgreSQL** database to it.
2. Add a **Bucket** named `files`, in the same region as the server. Buckets
   are private; clients get files through short-lived presigned URLs.
3. Add a service from the GitHub repository. Railway reads `railway.json`,
   builds the `Dockerfile`, and redeploys on every push to `main` that touches
   the server.
4. Set the service's variables:

| Variable | Value |
|---|---|
| `PORT` | `8787` |
| `STORAGE_PUBLIC_URL` | `https://api.example.com` |
| `STORAGE_DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
| `STORAGE_SIGNING_SECRET` | A random string of at least 32 characters, from `openssl rand -base64 48`. Keep it stable: changing it invalidates outstanding signed URLs. |
| `STORAGE_BLOB_DRIVER` | `s3` |
| `STORAGE_S3_BUCKET` | `${{files.BUCKET}}` |
| `STORAGE_S3_REGION` | `${{files.REGION}}` |
| `STORAGE_S3_ENDPOINT` | `${{files.ENDPOINT}}` |
| `STORAGE_S3_ACCESS_KEY_ID` / `STORAGE_S3_SECRET_ACCESS_KEY` | `${{files.ACCESS_KEY_ID}}` / `${{files.SECRET_ACCESS_KEY}}` |
| `STORAGE_S3_FORCE_PATH_STYLE` | `false`. Railway buckets use virtual-hosted URLs. |
| `STORAGE_GOOGLE_CLIENT_ID` / `STORAGE_GOOGLE_CLIENT_SECRET` | The Google OAuth client (step 3) |

With `STORAGE_SIGNING_SECRET` set, the server keeps nothing on local disk, so
the service needs no volume. Migrations run when the server starts. The other
settings are under [Configuration](/docs/self-hosting/configuration/).

## 2. Add the domain

In the service's **Networking** settings, add `api.example.com` as a custom
domain on port 8787, and create the CNAME record Railway shows. Check it with:

```sh
curl https://api.example.com/healthz
```

## 3. Set up Google sign-in

Create a Google OAuth client (type "Web application") with these redirect URIs:

- `https://api.example.com/auth/google/callback`
- `https://api.example.com/connect/google/callback`
- `https://api.example.com/github/install/google/callback`

Put its ID and secret in the variables from step 1. See
[Sign-in](/docs/self-hosting/sign-in/) for who can sign in.

## 4. Create the first org

Open a shell in the running service with the Railway CLI and bootstrap an org
and its admin:

```sh
railway ssh
node /app/dist/main.js bootstrap --org acme --email you@example.com
```

Then sign in from your machine:

```sh
STORAGE_SERVER=https://api.example.com storage login
```

## 5. Deploy the site

In Cloudflare, create a Worker from the GitHub repository (**Workers & Pages →
Create → Import a repository**) with:

| Setting | Value |
|---|---|
| Build command | `pnpm --filter @storage/site build` |
| Deploy command | `npx wrangler deploy` |
| Root directory | `/` |

`wrangler.jsonc` at the repository root serves `site/dist` as static assets
and attaches the custom domain. Change its `routes` pattern and `zone_name` to your domain, its
`name` to the Worker's name, and `site` in `site/astro.config.mjs` to the same
address so canonical URLs and `llms.txt` links point at it.

## Backups

Turn on scheduled backups in the Postgres service's settings. Railway buckets
have no snapshots or object versioning: once the maintenance worker purges a
deleted object and its unused blob, the contents are gone, so a database
backup older than that can point at missing files.
