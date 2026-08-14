# Contributing to JobTracker

Thank you for helping improve JobTracker.

## Development setup

Use Node.js 22.13 or newer. The project has no package dependencies or build step.

```bash
npm start
```

Run the tests before submitting a change:

```bash
npm test
```

## Pull requests

- Keep changes focused and explain the user-facing behavior they affect.
- Add or update tests for parser changes and bug fixes.
- Preserve the local-first, no-build design unless a change has been discussed first.
- Do not commit a SQLite database, JSON export, real email, personal notes, or unredacted LinkedIn links. LinkedIn email URLs can contain temporary tokens and tracking identifiers.
- Use invented names, companies, job IDs, and URLs in fixtures. Check every fixture manually for personal information before committing it.
- Avoid adding dependencies when the Node.js standard library is sufficient.

By contributing, you agree that your contribution will be licensed under the MIT License.
