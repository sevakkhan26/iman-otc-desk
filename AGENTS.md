# Agent / collaborator notes

## Parallel work (required)

This repo is shared. **Before any coding, review, commit, deploy, or server change:**

1. `git checkout main` (or the branch you were asked to use)
2. `git pull --rebase origin main` (or `git pull` on a feature branch after fetching)
3. If pull fails due to local dirty state, stash or finish the local work first — do not overwrite a teammate’s commits

Only then start the task. Re-pull if you have been idle a long time or before push/deploy.

## Deploy reminder

Production lives on the LAN Docker host under `docker-projects/iman-otc-desk`. Prefer pull → build → recreate; never `docker compose down -v` (destroys alert volume).
