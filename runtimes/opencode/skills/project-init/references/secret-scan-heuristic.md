# Secret-Scan Heuristic

This heuristic must be applied to all generated documentation before writing or reporting success.

## Scan Order

Apply checks in this order so that recognized placeholders are exempt before pattern-based rejection:

1. **Placeholder exemption** — If the value matches a recognized placeholder pattern (see below), skip all further checks for this value.
2. **Pattern-based detection** — Reject or redact values matching known secret patterns.
3. **Label-based detection** — Scan for common secret labels followed by non-placeholder values.
4. **High-entropy detection** — Flag high-entropy values in assignment context.

## Pattern-Based Detection

Reject or redact any value matching these patterns (after placeholder exemption):

| Pattern | Example |
|---|---|
| `sk-[a-zA-Z0-9]{20,}` | OpenAI secret keys |
| `ghp_[a-zA-Z0-9]{36,}` | GitHub personal access tokens |
| `github_pat_[a-zA-Z0-9]{22,}` | GitHub fine-grained tokens |
| `token=[^\s]{8,}` | Generic token assignments |
| `api_key=[^\s]{8,}` | API key assignments |
| `apikey=[^\s]{8,}` | API key assignments (no underscore) |
| `password=[^\s]{4,}` | Password assignments |
| `secret=[^\s]{8,}` | Secret assignments |
| `private_key=[^\s]{8,}` | Private key assignments |
| `-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----` | PEM-encoded private keys |

## Label-Based Detection

Scan for common secret labels followed by non-placeholder values:

- `token`, `api_key`, `apikey`, `password`, `secret`, `private_key`, `connection_string`, `database_url`, `auth_token`

If a label is followed by a value that is NOT a recognized placeholder, redact the value.

**Recognized placeholders (exempt from all checks):**
- `YOUR_API_KEY`, `YOUR_TOKEN`, `YOUR_SECRET`, `YOUR_PASSWORD`
- `<api-key>`, `<token>`, `<secret>`, `<password>`
- `DATABASE_CONNECTION_STRING`, `PATH_TO_YOUR_FILE`
- Any value wrapped in angle brackets `<...>` or containing `YOUR_` prefix
- Any value matching `^[A-Z_]+$` (all-caps underscore-separated constants, e.g. `REDIS_URL`, `SMTP_HOST`)

## High-Entropy Detection

Flag values with Shannon entropy > 3.5 bits per character that:
- Are longer than 16 characters
- Contain mixed case, digits, and special characters
- Appear in assignment context (e.g., `KEY=value`, `"key": "value"`)

## Action

If a secret-like value is detected:

1. **Redact** the value with a placeholder (e.g., `<REDACTED>` or `YOUR_API_KEY`).
2. **Report** the redaction in the warnings section of the output.
3. **Do not write** the file until all secret-like values are resolved.

## Verification

After scanning:

- [ ] No pattern-based secrets found in generated content
- [ ] No label-based secrets with non-placeholder values
- [ ] No high-entropy credential-like values in assignment context
- [ ] All warnings about redactions are reported to the user
