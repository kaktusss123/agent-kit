# Public report publishing

The bundled publisher uploads an already-finished standalone HTML report to an S3-compatible bucket and then verifies the public website URL. The current setup target is Cloud.ru Evolution Object Storage.

Publication is intentionally not automatic. The agent must follow the approval rules in `SKILL.md` before calling the script.

## One-time setup

1. Create a dedicated Object Storage bucket and assign it a domain name.
2. Enable static website hosting for the bucket.
3. Allow anonymous read only (`GetObject` and `HeadObject`). Do not grant public `PutObject`.
4. Create an Object Storage access key, preferably for a service account scoped to the reports bucket.
5. Configure an AWS CLI profile:

```bash
aws configure --profile cloudru-reports
```

Use the Cloud.ru Object Storage access key and set the region to `ru-central-1`. AWS CLI stores the credentials in its normal credential store; do not copy them into agent-kit configuration.

6. Create `${XDG_CONFIG_HOME:-$HOME/.config}/agent-kit/reports.env`:

```bash
AWS_PROFILE=cloudru-reports
REPORTS_ENDPOINT_URL=https://s3.cloud.ru
REPORTS_BUCKET=agent-reports
REPORTS_PUBLIC_URL=https://<bucket-dns-name>.s3-website.cloud.ru
```

`reports.env` contains destination metadata only. Keep access keys in the AWS CLI credential store.

Cloud.ru requires the S3 API endpoint `https://s3.cloud.ru`; the publisher passes it explicitly with `--endpoint-url`. The public URL must use the static website endpoint, not the authenticated S3 API endpoint.

## Publish

Run the bundled script from the skill package:

```bash
bash scripts/publish-report.sh --project zavod /path/to/report.html
```

`--project` is optional and defaults to `reports`. The script:

- validates the local HTML path and required configuration;
- generates a collision-resistant object key under `<project>/<UTC-date>/...`;
- uploads with `Content-Type: text/html; charset=utf-8`;
- performs an anonymous public GET against the website URL;
- verifies that the response is served as `text/html`;
- prints the final public URL to stdout.

The script does not configure the bucket, change public access, or delete the local file.

## Failure semantics

If the upload command fails, the script exits non-zero without claiming publication succeeded.

If upload succeeds but the public GET or `Content-Type` check fails, the script exits with status `1`, prints the candidate URL to stdout, and explains on stderr that the object may already have been uploaded. Treat that as a partial side effect: report it to the user and do not retry blindly.

## Cloud.ru references

- AWS CLI: https://cloud.ru/docs/s3e/ug/topics/tools__aws-cli
- Static website hosting: https://cloud.ru/docs/s3e/ug/topics/guides__hosting__setup
- Public bucket access: https://cloud.ru/docs/s3e/ug/topics/guides__public-access-for-bucket
