---
title: Configuration
description: Environment variables for the server.
---

Environment variables configure the server, and are set by whoever runs it.
Nothing a user chooses is an environment variable.

| Variable | Default |
|---|---|
| `STORAGE_DATA_DIR` | `./.storage-data` |
| `STORAGE_DATABASE_URL` | `sqlite:<data dir>/storage.db`. Also accepts `postgres://user:password@host:5432/db`. |
| `STORAGE_BLOB_DRIVER` | `fs`, or `s3` for any S3-compatible bucket |
| `STORAGE_BLOB_DIR` | `<data dir>/blobs` (`fs` driver) |
| `STORAGE_S3_BUCKET` | Required for `s3`. The bucket must not be public. |
| `STORAGE_S3_REGION` | `AWS_REGION`, else `us-east-1` |
| `STORAGE_S3_ENDPOINT` | Unset for AWS S3. Set for RustFS, MinIO, R2 and others. |
| `STORAGE_S3_PUBLIC_ENDPOINT` | `STORAGE_S3_ENDPOINT`. The address clients use in presigned URLs, when it differs from the server's. |
| `STORAGE_S3_FORCE_PATH_STYLE` | `true` when an endpoint is set, else `false` |
| `STORAGE_S3_ACCESS_KEY_ID` / `STORAGE_S3_SECRET_ACCESS_KEY` | Unset to use the AWS SDK's default credential chain |
| `STORAGE_S3_CREATE_BUCKET` | `false`. Set to `true` to create the bucket on startup. |
| `STORAGE_PUBLIC_URL` | `http://localhost:<port>` |
| `STORAGE_HOST` / `STORAGE_PORT` | `127.0.0.1` / `8787` |
| `STORAGE_SIGNING_SECRET` | Generated into `<data dir>/signing-secret` on first run |
| `STORAGE_MAX_FILE_SIZE` | 5 GiB |
| `STORAGE_DOWNLOAD_TTL_SECONDS` | 300. How long signed download URLs last. |
| `STORAGE_MCP_MAX_UPLOAD_BYTES` | 10 MiB. Largest file the hosted MCP `put` accepts. |
| `STORAGE_INLINE_MAX_BYTES` | 1 MiB. Largest object the hosted MCP `get` returns inline. |
| `STORAGE_LINK_MAX_DAYS` | 30. Longest a share link can last. `0` disables share links. |
| `STORAGE_DELETE_GRACE_DAYS` | 7. How long a deleted object can be restored with `storage restore`. After that the maintenance worker purges it. `0` disables restore. |
| `STORAGE_WORKER` | `true`. `serve` runs the maintenance worker in-process. Set to `false` when running `storage-server worker` separately. |
| `STORAGE_WORKER_INTERVAL_SECONDS` | 300. Time between maintenance passes. |
| `STORAGE_GITHUB_CLIENT_ID`, `STORAGE_GITHUB_CLIENT_SECRET` | Unset. A GitHub OAuth app for connecting GitHub accounts (see [Share files](/docs/guides/sharing/)). They don't enable sign-in, and need Google sign-in. |
| `STORAGE_GITHUB_APP_ID`, `STORAGE_GITHUB_APP_SLUG`, `STORAGE_GITHUB_APP_CLIENT_ID`, `STORAGE_GITHUB_APP_CLIENT_SECRET`, `STORAGE_GITHUB_APP_WEBHOOK_SECRET` | Unset. The GitHub App for pull request bindings (see [GitHub App](#github-app)). Set all or none. The webhook secret is at least 16 characters. |
| `STORAGE_GITHUB_APP_PRIVATE_KEY` or `STORAGE_GITHUB_APP_PRIVATE_KEY_FILE` | The app's PEM private key, inline (`\n` escapes accepted) or as a file path. |
| `STORAGE_GITHUB_POLL_INTERVAL_SECONDS` | 900. How often the worker re-checks each bound pull request, as a backstop for missed webhook deliveries. |
| `STORAGE_GITHUB_MEMBERSHIP_TTL_SECONDS` | 3600. How long a user's GitHub org and team memberships are cached before they are checked again. |
| `STORAGE_CONSUMER_DOMAINS` | Unset. Comma-separated email domains to refuse as `google-domain:` principals, on top of the built-in list (`gmail.com`, `outlook.com`, `yahoo.com`, …). |
| `STORAGE_GOOGLE_CLIENT_ID`, `STORAGE_GOOGLE_CLIENT_SECRET` | Unset. A Google OAuth client for sign-in (see [Sign-in](/docs/self-hosting/sign-in/)). |
| `STORAGE_GOOGLE_ALLOWED_DOMAINS` | Unset. Comma-separated Google Workspace domains. When set, only Workspace accounts whose ID token carries one of them in `hd` can sign in, so Gmail accounts are refused. |

## GitHub App

Pull request bindings need a GitHub App, set up once per server:

1. Register a GitHub App (Settings → Developer settings → GitHub Apps) with
   the repository permission **Pull requests: read**, the **Pull request**
   and **Installation** events, webhook URL
   `<STORAGE_PUBLIC_URL>/v1/github/webhook` with a secret, callback URL
   `<STORAGE_PUBLIC_URL>/github/install/callback`, and **Request user
   authorization (OAuth) during installation** turned on.
2. Generate a private key and a client secret, and set the
   `STORAGE_GITHUB_APP_*` variables above. Installing needs Google sign-in.

Then org admins link it to their orgs; see [Pull requests](/docs/guides/pull-requests/).
