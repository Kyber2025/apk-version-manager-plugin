---
description: Scaffold APK distribution + Android auto-update into this project. Adds a backend route module, Android updater class, nginx snippet, and optional admin UI.
---

Invoke the `install-apk-manager` skill from this plugin. The skill will:

1. Survey your project (backend framework, Android source layout, frontend stack, public URL).
2. Confirm choices with you before writing files.
3. Copy + customize templates (backend route, Kotlin updater, nginx snippet, optional admin React page).
4. Wire them into your existing app (route registration, manifest merge, docker-compose volume).
5. Walk you through your first APK upload + smoke test.

Reference templates live in `skills/install-apk-manager/templates/`. The pattern is in production use at https://ai.applehappy.net/apks/manifest.

Begin now.
