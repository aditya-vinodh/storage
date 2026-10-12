---
title: Deploy on Railway
description: Run the server on Railway with Postgres, keep files in Cloudflare R2, and host the site on Cloudflare Pages.
---

This is how the hosted server runs: the server and Postgres on
[Railway](https://railway.com), file contents in a
[Cloudflare R2](https://developers.cloudflare.com/r2/) bucket, and this site
on [Cloudflare Pages](https://pages.cloudflare.com). The server image is the
repository's `Dockerfile`, and `railway.json` holds its build and health check
settings.

The examples use `api.example.com` for the server and `example.com` for the
site. Replace them with your domain.

## 1. Create the R2 bucket

1. In the Cloudflare dashboard, open R2 and create a bucket, for example
   `storage`. Leave public access off: clients get files through short-lived
   presigned URLs.
2. Create an R2 API token with **Object Read & Write** on that bucket only.
   Note the access key ID, the secret access key, and the S3 endpoint,
   `https://<account-id>.r2.cloudflarestorage.com`.

## 2. Create the Railway project

1. Create a project and add a **PostgreSQL** database to it.
2. Add a service from the GitHub repository. Railway reads `railway.json`,
   builds the `Dockerfile`, and redeploys on every push to `main` that touches
   the server.
3. Set the service's variables:

| Variable | Value |
|---|---|
| `PORT` | `8787` |
| `STORAGE_PUBLIC_URL` | `https://api.example.com` |
| `STORAGE_DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
| `STORAGE_SIGNING_SECRET` | A random string of at least 32 characters, from `openssl rand -base64 48`. Keep it stable: changing it invalidates outstanding signed URLs. |
| `STORAGE_BLOB_DRIVER` | `s3` |
| `STORAGE_S3_BUCKET` | `storage` |
| `STORAGE_S3_REGION` | `auto` |
| `STORAGE_S3_ENDPOINT` | `https://<account-id>.r2.cloudflarestorage.com` |
| `STORAGE_S3_ACCESS_KEY_ID` / `STORAGE_S3_SECRET_ACCESS_KEY` | The R2 token's keys |
| `STORAGE_GOOGLE_CLIENT_ID` / `STORAGE_GOOGLE_CLIENT_SECRET` | The Google OAuth client (step 4) |

With `STORAGE_SIGNING_SECRET` set, the server keeps nothing on local disk, so
the service needs no volume. Migrations run when the server starts. The other
settings are under [Configuration](/docs/self-hosting/configuration/).

## 3. Add the domain

In the service's **Networking** settings, add `api.example.com` as a custom
domain on port 8787, and create the CNAME record Railway shows. Check it with:

```sh
curl https://api.example.com/healthz
```

## 4. Set up Google sign-in

Create a Google OAuth client (type "Web application") with these redirect URIs:

- `https://api.example.com/auth/google/callback`
- `https://api.example.com/connect/google/callback`
- `https://api.example.com/github/install/google/callback`

Put its ID and secret in the variables from step 2. See
[Sign-in](/docs/self-hosting/sign-in/) for who can sign in.

## 5. Create the first org

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

## 6. Deploy the site

In Cloudflare Pages, create a project from the GitHub repository with:

| Setting | Value |
|---|---|
| Build command | `pnpm --filter @storage/site build` |
| Build output directory | `site/dist` |
| Environment variable | `NODE_VERSION` = `22` |

Add `example.com` as the project's custom domain, and set `site` in
`site/astro.config.mjs` to the same address so canonical URLs and `llms.txt`
links point at it.

## Backups

Turn on scheduled backups in the Postgres service's settings. R2 has no
version history of its own: once the maintenance worker purges a deleted
object and its unused blob, the contents are gone, so a database backup older
than that can point at missing files.
