# apk-version-manager — Claude Code Plugin

Self-host APK distribution + Android auto-update in any project, **without Google Play**, with zero infrastructure beyond your existing backend.

Use case: internal-tool Android apps that need to push updates to a small fleet of devices without going through Play's review cycle, alpha tracks, or signing key escrow.

---

## What you get

When you install this plugin and invoke `/install-apk-manager` (or just ask Claude "add APK auto-update to this project"), Claude scaffolds:

1. **Backend route module** (Fastify TypeScript today; Express adaptable):
   - `GET  /apks/manifest` — list all available APKs (public, JSON)
   - `GET  /apks/:filename` — download an APK (public, streams binary)
   - `GET  /apks/device/version` — Android polling endpoint (public, JSON)
   - `POST /apks/upload` — upload new APK (admin auth)
   - `DELETE /apks/:filename` — remove APK (admin auth)

   Filename convention: `<package>-v<semver>.apk` (e.g. `myapp-v1.2.3.apk`). **Directory listing IS the source of truth** — no DB needed.

2. **Android Kotlin updater** (`ApkUpdater.kt`):
   - Polls `/apks/device/version` (throttled to once per 30 min)
   - Shows install dialog when new version available
   - Downloads via `DownloadManager`
   - Triggers install intent via FileProvider
   - Handles Android 8+ `REQUEST_INSTALL_PACKAGES` flow
   - Optional WorkManager periodic check

3. **Nginx snippet** for the `/apks/` route block (raises `client_max_body_size`, disables proxy buffering for large APK streaming).

4. **React admin page** (production-grade, [live demo](https://ai.applehappy.net/admin/apks)):
   - Drag-target upload with client-side filename regex validation
   - Per-package grouped table, "Latest" badge on highest version
   - sha256 truncated display + copy-URL button + download link per row
   - Delete with confirmation modal
   - Auto-refresh every 30s so newly uploaded APKs (via scp / second tab) appear without manual reload
   - Imports marked `// CUSTOMIZE:` for easy swap to any UI kit (Tailwind/shadcn/MUI/Chakra/etc) and any auth store (Zustand/Redux/Context)
   - Minimal-deps fallback stubs included if your project doesn't have a design system yet

5. **Docker-compose volume + env hint** so the backend container can see your host's APK directory.

All templates were extracted from a production deployment ([KyberRouter](https://github.com/Kyber2025/openrouter-ai-project)), so they're already battle-tested.

---

## Install

### Via Claude Code CLI

```bash
claude plugin install https://github.com/Kyber2025/apk-version-manager-plugin
```

### Then in any project

```
/install-apk-manager
```

or just say:

> add APK auto-update to this project

Claude will survey your project layout, customize the templates (paths, package names, public URL), wire them into your bootstrap file, and walk you through a smoke test.

---

## Live reference

The production deployment that this plugin's templates were extracted from:

- **Admin UI**: https://ai.applehappy.net/admin/apks (admin login required)
- **Manifest endpoint**: https://ai.applehappy.net/apks/manifest (public)
- **Sample APK**: https://ai.applehappy.net/apks/kyber-phone-proxy-v3.5.0.apk (public)

```bash
$ curl https://ai.applehappy.net/apks/manifest | jq .
{
  "apks": [
    {
      "filename": "kyber-phone-proxy-v3.5.0.apk",
      "package": "kyber-phone-proxy",
      "version": "3.5.0",
      "sizeBytes": 5715005,
      "sha256": "87abd23e96d34ddf7861366b2c19358b5bf0511075177ee31d5039dbe404222a",
      "uploadedAt": "2026-05-26T01:54:40.541Z",
      "downloadUrl": "https://ai.applehappy.net/apks/kyber-phone-proxy-v3.5.0.apk"
    }
  ],
  "latest": { ... }
}
```

---

## Architecture choices, briefly

- **Why no DB?** A `readdir()` is fast enough for tens of versions, and the file system IS the source of truth — there's no consistency problem.
- **Why no auth on download?** Most Android update intents can't carry auth headers. URL obscurity is sufficient for internal-tool distribution. If you need true private distribution, put an HTTP basic-auth in front of `/apks/`.
- **Why poll instead of FCM push?** Zero infra (no Firebase project, no service account). Battery cost of one HTTP GET per 30 min is negligible.
- **Why not Play?** Internal tools that need fast iteration without Play's review cycle, or that need APIs Play would flag (background location, accessibility services, etc).

---

## Plugin structure

```
apk-version-manager/
├── .claude-plugin/
│   └── plugin.json
├── skills/
│   └── install-apk-manager/
│       ├── SKILL.md                          # Scaffolding instructions for Claude
│       └── templates/
│           ├── backend-fastify-route.ts      # Fastify route module
│           ├── android-ApkUpdater.kt         # Kotlin updater class
│           ├── android-fileprovider.xml      # FileProvider paths config
│           ├── android-manifest-snippet.xml  # Permissions + provider declaration
│           ├── nginx-snippet.conf            # Optional nginx route
│           └── admin-react-page.tsx          # Optional React admin UI
├── commands/
│   └── install-apk-manager.md                # Slash command
└── README.md                                  # This file
```

---

## License

MIT
