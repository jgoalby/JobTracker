# JobTracker

JobTracker is a local-first web application for turning pasted LinkedIn job-alert emails into a structured job-search workspace.

It intentionally does not scrape LinkedIn. Alert emails are imported by pasting them into the application. For a promising role, open its saved LinkedIn link, copy the expanded job posting, and use **Paste additional details** inside that job.

## Start the application

JobTracker requires Node.js 22.13 or newer. It has no package dependencies and no build step.

```bash
git clone <repository-url>
cd <repository-directory>
npm start
```

Then open [http://127.0.0.1:3210](http://127.0.0.1:3210). Stop the application with `Control-C` in the terminal.

Node 22 may print an `ExperimentalWarning` for its built-in SQLite module. The application still runs normally; newer Node releases classify the module as a release candidate.

## Typical workflow

1. Choose **Import LinkedIn alert**.
2. Copy an alert email from your inbox and paste it into the import area.
3. Review and correct the jobs detected by the parser.
4. Import the selected jobs. Repeated LinkedIn job IDs are updated rather than duplicated.
5. Open a job card and use **Open job ↗** to view its listing in a new tab.
6. Copy the expanded listing and paste it into **Add job details**. For an existing description, choose **Paste additional details**.
7. Review **Job market insights** for recurring skills, experience expectations, work models, and data coverage. Insight chips filter the tracked jobs.
8. Sort jobs by date added, posting date, update date, company, or title; company grouping can remain on with any sort.
9. Record an application status separately from initial interest. Mark a role **Follow up** or **Not interested** and optionally keep a short reason.
10. Click the summary cards to filter saved, applied, or in-progress jobs, or use the toolbar’s status and interest filters together.
11. Add notes or create custom fields for anything else you want to track.
12. Use **Export backup** periodically to download a readable JSON backup.

Job-seeker insights are extracted locally with transparent keyword and text-pattern matching. They update when full job details are applied and do not send posting content to an external service.

## Local data

The SQLite database is stored at:

```text
data/jobs.sqlite
```

The original pasted text and HTML are retained as source history. Copy the SQLite file while JobTracker is stopped, or use the built-in JSON export, when making backups.

### Privacy and security

JobTracker listens only on the loopback interface by default, has no telemetry, and does not send pasted content to an external service. It is a personal local application and does not include user accounts or authentication. Do not expose it to a local network or the public internet.

Pasted email source history can contain your name, email content, and temporary LinkedIn tracking or sign-in tokens. The database and JSON exports are therefore private data. They are ignored by Git, but you should still inspect staged files before every commit and store exports securely.

Setting `HOST` to a non-loopback address is refused unless `JOBTRACKER_ALLOW_REMOTE=1` is also set. That override does not add authentication or TLS and is not recommended for normal use; securing a remote deployment is outside this project's current scope.

## Project structure

```text
server.mjs             Local HTTP server and API routes
db.mjs                 SQLite access and duplicate matching
linkedin-parser.mjs    LinkedIn alert and job-detail extraction
parser.mjs             Shared text and HTML utilities
schema.sql             Database schema
public/                No-build browser interface
test/                  Parser tests and anonymized fixtures
data/                  Local SQLite database
```

## Tests

```bash
npm test
```

The anonymized fixtures cover alert-confirmation emails, recurring job-alert digests, and several full job-posting layouts.

## Contributing and security reports

Before opening a pull request, read [CONTRIBUTING.md](CONTRIBUTING.md). Please report security issues privately as described in [SECURITY.md](SECURITY.md), rather than opening a public issue.

## License

JobTracker is available under the [MIT License](LICENSE).
