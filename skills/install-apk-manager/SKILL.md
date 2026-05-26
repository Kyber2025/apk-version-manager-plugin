---
name: install-apk-manager
description: Scaffold APK distribution + Android auto-update functionality into an existing project. Use when the user says "add APK manager", "add APK distribution", "let the Android app self-update from my server", or shows interest in hosting their own APK release channel (i.e. without Google Play). Adds a backend route module (Fastify/Express), an Android Kotlin updater class, an nginx snippet, and an optional admin upload page. Customizes paths, package names, and URLs to fit the user's project.
---

# APK Version Manager — Scaffolding Skill

You are helping the user add **self-hosted APK distribution + auto-update** to their project. This pattern lets their Android app fetch updates from THEIR OWN server instead of Google Play, polling a manifest endpoint every N minutes.

## Pattern Overview

```
APK files on server disk: /opt/{project}/apks/{package}-v{version}.apk

   ┌────────────────────┐     poll every 30min    ┌────────────────────┐
   │  Android device    │ ───────────────────────▶│  Backend route     │
   │  ApkUpdater.kt     │                          │  /apks/manifest    │
   └────────────────────┘ ◀───────────────────────│  /apks/:filename   │
            │                latest+sha256+url    │  /apks/device/...  │
            │                                     └────────────────────┘
            │ if hasUpdate
            ▼
       download APK
            │
            ▼
       prompt install (FileProvider intent)
```

Filename convention: `<package-prefix>-v<semver>.apk` (e.g. `myapp-v1.2.3.apk`). The directory listing IS the source of truth — no database needed.

## Files in this skill

Templates live in `./templates/`:

| File | Where it goes in user's project | Notes |
|---|---|---|
| `backend-fastify-route.ts` | `{backend}/src/routes/apks.ts` | Production-grade. Customize APK_DIR + PUBLIC_BASE_URL |
| `android-ApkUpdater.kt` | `{android}/app/src/main/java/.../ApkUpdater.kt` | Pure Kotlin, no extra deps |
| `android-fileprovider.xml` | `{android}/app/src/main/res/xml/file_paths.xml` | Required for install intent on Android 7+ |
| `android-manifest-snippet.xml` | Snippet to merge into `AndroidManifest.xml` | Permissions + FileProvider declaration |
| `nginx-snippet.conf` | `/etc/nginx/conf.d/<site>.conf` (manual) | If user uses nginx; raise client_max_body_size for uploads |
| `admin-react-page.tsx` | `{frontend}/src/pages/admin/ApksAdminPage.tsx` (optional) | React admin UI with upload + version list + QR code |

## Procedure

Follow this checklist. Use TodoWrite to track items as you complete them.

### 1. Discover the user's project structure

Before touching files, learn:
- **Backend framework**: Fastify? Express? Other? (read package.json)
- **Backend layout**: where do routes live? (`src/routes/`, `routes/`, `api/`, etc)
- **Backend auth**: is there an existing requireAdmin / requireAuth middleware? Path?
- **Android project**: where's the app module? Package name? minSdk?
- **Frontend** (optional): React? Vue? Where do admin pages live?
- **Public URL**: what's the production hostname?
- **APK storage**: where on the server should APKs live? (default: `/opt/{project}/apks/`)

Ask the user ONLY the things you genuinely can't infer from the project. Default sensibly.

### 2. Backend route scaffold

- If Fastify: copy `templates/backend-fastify-route.ts` to the user's routes dir.
- If Express: there's no Express template yet — adapt the Fastify one (it's simple — manifest, download stream, multipart upload, device-version-check).
- Wire it into the app: register the route module with prefix `/apks`. Show the user the exact line to add in their bootstrap file.
- Customize the constants at the top:
  - `APK_DIR` → server path
  - `PUBLIC_BASE_URL` → user's domain
  - `APK_FILENAME_PATTERN` → if their naming convention differs, update the regex
- Replace `requireAdmin` import path with the user's actual middleware path.

### 3. Docker compose / runtime config

If the user uses docker-compose, add to the backend service:
```yaml
volumes:
  - ./apks:/app/apks
environment:
  - APK_DIR=/app/apks
  - PUBLIC_BASE_URL=https://example.com
```

Without this, the in-container APK_DIR won't see the host's APK files.

### 4. Nginx (if used)

Show the user `templates/nginx-snippet.conf`. Critical points:
- `client_max_body_size 100m` so large APK uploads don't 413
- `proxy_buffering off` so big downloads stream
- Insert this `location /apks/` block in their existing server block.

### 5. Android client

Copy `templates/android-ApkUpdater.kt` to their app's source tree. Customize:
- `API_BASE_URL` constant → user's domain
- `PACKAGE_PREFIX` → matches the filename convention used by backend
- `CURRENT_VERSION` → pull from `BuildConfig.VERSION_NAME`
- `POLL_INTERVAL_MIN` → default 30 min; adjust if user wants more/less frequent

Required Android changes:
- Merge `templates/android-manifest-snippet.xml` into AndroidManifest:
  - Permissions: `INSTALL_PACKAGES`, `REQUEST_INSTALL_PACKAGES`
  - `<provider>` declaration for FileProvider
- Copy `templates/android-fileprovider.xml` to `res/xml/file_paths.xml`
- Set the FileProvider authority to `${applicationId}.fileprovider`
- In a top-level Activity (e.g. MainActivity) call `ApkUpdater.checkOnStart(this)` in onResume
- Optionally start a WorkManager periodic check (described in the template's comments)

### 6. Admin upload UI (optional)

If user has a React admin area, offer `templates/admin-react-page.tsx`. Customize the API base URL + auth token source.

### 7. Initial upload + smoke test

Walk the user through their FIRST upload:
1. Build their APK with the right filename: `<pkg>-v<version>.apk`
2. Upload via `scp` to `{APK_DIR}` on server OR via the admin UI
3. `curl https://example.com/apks/manifest` to confirm it appears
4. On Android, hit `curl https://example.com/apks/device/version?currentVersion=0.0.0&package=<pkg>` to confirm hasUpdate=true
5. Trigger the in-app update flow (or wait for the poll interval)

### 8. Document for the user

After scaffolding, write a short integration summary in their project root (e.g. `APK_RELEASE.md`) explaining:
- How to bump a version + upload
- The naming convention
- Where APK files live on the server
- How to roll back (delete the newer .apk file)

## Anti-patterns to warn about

- **Don't** put APKs behind authentication. Most Android update intents can't carry headers. The URL being "obscure but known" is fine for internal apps.
- **Don't** check for updates more often than every 15 minutes — battery drain.
- **Don't** auto-install without user consent — Android requires REQUEST_INSTALL_PACKAGES permission and a system prompt; surface it gracefully.
- **Don't** put the version DB in Postgres — directory listing is faster, simpler, and the source of truth IS the file system.

## When NOT to use this skill

- User just wants to share an APK once — use a generic file host (GitHub Releases, S3) instead.
- User's app is Play-Store-distributed only — Play handles updates.
- User is on iOS — this is Android-specific.

## Reference implementation

A fully working production deployment exists in the KyberRouter project:
- Backend: `https://github.com/Kyber2025/openrouter-ai-project/blob/main/backend/src/routes/apks.ts`
- Live manifest: `https://ai.applehappy.net/apks/manifest`
- Live download: `https://ai.applehappy.net/apks/kyber-phone-proxy-v3.5.0.apk`

The templates in this skill were extracted directly from that deployment, so they're already battle-tested.
