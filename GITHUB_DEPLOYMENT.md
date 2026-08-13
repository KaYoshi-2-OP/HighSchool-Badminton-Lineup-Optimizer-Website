# Publish the website from GitHub

The repository is the source of the website. A Cloudflare Worker runs the server and D1 database because GitHub Pages cannot run secure login code or a database.

## One-time setup

1. Upload this complete project to your GitHub repository and make sure the default branch is `main`.
2. Create or sign in to a Cloudflare account.
3. In Cloudflare, copy your **Account ID**.
4. Create a Cloudflare API token with permission to edit Workers. Limit it to only your Cloudflare account.
5. In GitHub, open the repository and select **Settings → Secrets and variables → Actions**.
6. Add these two repository secrets:
   - `CLOUDFLARE_ACCOUNT_ID`
   - `CLOUDFLARE_API_TOKEN`
7. Open the repository’s **Actions** tab, select **Test and deploy website**, and run the workflow. It also runs automatically after every push to `main`.

The first deployment automatically provisions the D1 database bound as `DB`. Cloudflare will display a public `workers.dev` address when deployment finishes.

## First account

Open the deployed address and create the first username and password. Then import your home-school roster and historical match CSV files. Every later account receives a separate workspace and cannot read or change another account’s teams, players, matches, or ratings.

## Important security rules

- Never put the Cloudflare API token in a source file or commit it to GitHub.
- Use GitHub Actions secrets exactly as described above.
- Use a unique password of at least eight characters.
- Keep the repository private until you have removed any real student names or confidential match data committed as files. Data uploaded through the running website is stored in D1, not in the GitHub repository.

## Updating the website

Make changes in Codespaces, then commit and push them to `main`. GitHub tests the build and deploys it automatically. A failed test prevents deployment.
