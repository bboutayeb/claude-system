# Étape 6 — Rebuild binaire + CI (moyen terme, ~30 min)

> **Branche :** `feat/rebuild-binary-v0.2.0` depuis `integ`  
> **Contexte complet :** `@docs/plans/2026-04-13_2259_roadmap-implementation.md`

---

## Problème

Le binaire distribué est en `0.1.x`. Les étapes 1–5 ont ajouté plusieurs fonctionnalités significatives (quality scorer auto, dashboard sessions, métriques Haiku, feedback FP). Il faut tagguer une release `v0.2.0` propre avec un binaire compilé à jour.

---

## Fichiers

- `src/config.ts` — bumper `VERSION`
- `scripts/build.sh` — vérifier la compilation 3 targets
- `.github/workflows/release.yml` — déclenché par le tag `v0.2.0`

---

## Changements

1. Bumper `VERSION` dans `src/config.ts` → `"0.2.0"`
2. Vérifier que `scripts/build.sh` produit les 3 binaires localement (linux-x64, darwin-arm64, darwin-x64)
3. Tagger `v0.2.0` et pousser le tag → déclenche le workflow GitHub Actions
4. Vérifier que la release GitHub contient les 3 binaires
5. Mettre à jour les notes de release avec le changelog des étapes 1–5

---

## Vérification

```bash
# Build local
bash scripts/build.sh

# Tester le binaire
./dist/claude-monitor-linux-x64 version  # → 0.2.0

# Tag + push
git tag v0.2.0 && git push origin v0.2.0

# Vérifier la release
gh release view v0.2.0
```

---

## Changelog pour la release

**v0.2.0 — 2026-04-14**

- Allowlist automatique des slash commands (`/compact`, `/help`, etc.)
- Quality scoring automatique à la fin de chaque session (Haiku, fire-and-forget)
- Dashboard : table sessions avec score moyen, ambiguïtés et lien transcript
- Métriques de coût Haiku : tracking par source (ambiguity/scoring), alerte configurable
- Feedback faux positifs : bouton dashboard → allowlist persistée en DB
