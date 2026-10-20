# Security policy

## Reporting a vulnerability

Please report security issues privately. Do not open a public issue, discussion or pull request
for a vulnerability.

1. **Preferred: GitHub private vulnerability reporting.**
   Open a private report at <https://github.com/hexuria/opengrok/security/advisories/new>
   (repository **Security** tab → **Report a vulnerability**). The report stays private between you
   and the maintainer until a fix is published.
2. **Email:** codeitlikemiley@gmail.com (Uriah Galang, maintainer), if you cannot use GitHub.

Please include:

- the affected commit (or "latest `main`"),
- steps or a proof of concept to reproduce,
- the impact you observed or expect.

You should get an acknowledgement within 7 days. Please give us a reasonable time to fix the issue
before any public disclosure.

## Supported versions

| Version | Supported |
| --- | --- |
| latest commit on `main` | yes |
| anything older | no |

Fixes land on `main`; there are no maintained release branches.

## Automated scanning

Reports from automated scanners (for example Anthropic's OSS Scanner) go to the same address above.
