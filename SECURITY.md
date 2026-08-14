# Security policy

## Supported version

Security fixes are made on the latest version of the default branch. This project is an early local-first application and does not currently maintain older release branches.

## Reporting a vulnerability

Please do not disclose a suspected vulnerability in a public issue. Use GitHub's private vulnerability reporting feature when it is available for the repository. Otherwise, contact the maintainer privately using the contact information on their GitHub profile.

Include a description of the issue, reproduction steps, its potential impact, and any suggested mitigation. Remove real job-search data, email contents, and tokens from reports.

## Security model

JobTracker is designed for one person on one computer. It binds to a loopback address by default and does not provide authentication, authorization, TLS, or multi-user isolation. It must not be exposed directly to a LAN or the public internet.

The local database and JSON backups may contain sensitive job-search notes, complete pasted emails, and temporary LinkedIn URL parameters. Keep them private. The repository's ignore rules exclude the normal database, SQLite sidecar files, and JSON exports, but contributors are responsible for reviewing staged files before publishing them.
