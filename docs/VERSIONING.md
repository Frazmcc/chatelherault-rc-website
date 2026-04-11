# Versioning and Snapshots

## Versioning policy

- Semantic Versioning is used: `MAJOR.MINOR.PATCH`.
- Source of truth: `package.json` `version`.
- Bump rules:
  - `PATCH`: fixes and small safe improvements.
  - `MINOR`: backward-compatible new features.
  - `MAJOR`: breaking behavior or URL/content contract changes.

## Commands

- `npm run verify`: Run SEO correctness checks.
- `npm run verify:routes`: Run live route and redirect health checks.
- `npm run snapshot`: Create a point-in-time repository snapshot.
- `npm run release:patch`: Bump patch, verify, snapshot, tag, publish GitHub release, deploy.
- `npm run release:minor`: Bump minor, verify, snapshot, tag, publish GitHub release, deploy.
- `npm run release:major`: Bump major, verify, snapshot, tag, publish GitHub release, deploy.
- `npm run version:patch`: Bump patch version, run verification, then snapshot.
- `npm run version:minor`: Bump minor version, run verification, then snapshot.
- `npm run version:major`: Bump major version, run verification, then snapshot.

## Snapshot outputs

- `snapshots/latest.md`: Most recent snapshot.
- `snapshots/history/*.md`: Timestamped historical snapshots.

Each snapshot contains timestamp, version, branch, commit, and working tree status.

## Release checklist

1. Run one of the version bump commands.
2. Review `CHANGELOG.md` and update `Unreleased` section.
3. Commit all version and content changes.
4. Push to `main`.
5. Publish GitHub Release for the matching `vX.Y.Z` tag.
6. Deploy with Wrangler.
7. Validate production endpoints.
