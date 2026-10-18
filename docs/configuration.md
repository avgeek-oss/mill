# Configuration

For Docker Compose, copy `.env.example` to `.env` and edit the values for your installation. With Towbar, add them to the corresponding workload’s runtime secrets.

## Required settings

The API needs a PostgreSQL connection, a secret and the public URLs of your UI and API:

```dotenv
DATABASE_URL=postgres://mill:your-database-password@postgres:5432/mill
MILL_SECRET=replace-with-a-random-secret-of-at-least-32-characters
MILL_WEB_URL=https://tasks.example.com
MILL_API_URL=https://tasks-api.example.com
```

Use your database’s actual hostname. The `postgres` hostname above is for [bundled PostgreSQL with Compose](installation/docker-compose.md#choose-your-database). Encode special characters in the database username and password.

The UI needs only the API URL:

```dotenv
MILL_API_URL=https://tasks-api.example.com
```

For bundled PostgreSQL, set its password separately and use that same password in `DATABASE_URL`:

```dotenv
POSTGRES_USER=mill
POSTGRES_DB=mill
POSTGRES_PASSWORD=your-database-password
```

Use HTTPS for remote installations. Keep the UI and API on the same site, such as `tasks.example.com` and `tasks-api.example.com`. Configure these URLs before creating passkeys or connecting MCP clients.

Keep `MILL_SECRET` private and preserve it across upgrades and restores. Never add database credentials or `MILL_SECRET` to the UI.

## S3 source

An S3-compatible bucket stores task images and PDFs. You can use a service such as Cloudflare R2 or another compatible provider. Without an S3 source, Mill works normally with the attachment controls hidden.

Add these values to the API:

```dotenv
MILL_S3_ENDPOINT=https://your-account.r2.cloudflarestorage.com
MILL_S3_REGION=auto
MILL_S3_BUCKET=mill-attachments
MILL_S3_ACCESS_KEY_ID=your-bucket-access-key
MILL_S3_SECRET_ACCESS_KEY=your-bucket-secret-key
```

Add the endpoint to the UI as well:

```dotenv
MILL_S3_ENDPOINT=https://your-account.r2.cloudflarestorage.com
```

Use a private bucket and a credential with read, write and delete access to that bucket. Follow your provider’s instructions for the endpoint and region. The endpoint must be reachable by people using Mill, since uploads use signed URLs.

Allow your UI origin in the bucket’s CORS settings:

```json
[
  {
    "AllowedOrigins": ["https://tasks.example.com"],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["Content-Type", "Content-Length"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

Use your exact UI origin rather than a wildcard. See [task attachments](task-attachments.md) for supported files and [backup and recovery](backup.md) for protecting the bucket alongside PostgreSQL.

## SMTP

SMTP enables invitation, verification and password-reset email. Get the connection details from your email provider and add them to the API:

```dotenv
MILL_SMTP_HOST=smtp.example.com
MILL_SMTP_PORT=587
MILL_SMTP_SECURE=false
MILL_SMTP_USER=your-smtp-username
MILL_SMTP_PASSWORD=your-smtp-password
MILL_SMTP_FROM=Mill <noreply@example.com>
```

Use `MILL_SMTP_SECURE=true` when your provider requires direct TLS, commonly on port 465. Leave the username and password unset if your SMTP service does not require authentication.

Without SMTP, administrators can share invitation links privately. Server operators can also help with [account recovery](authentication.md#recover-an-account). Task assignment and mention notifications appear inside Mill rather than in email.

## Apply changes

Recreate the affected services after changing their environment. A restart alone keeps the existing environment. With Towbar, save the runtime secrets and redeploy the affected workloads.

Store environment files and backup copies securely. Keep image versions and published ports in your installation’s Compose file or Towbar manifests.
