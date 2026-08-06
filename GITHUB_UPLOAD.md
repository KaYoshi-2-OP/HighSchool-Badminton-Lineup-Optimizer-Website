# Uploading the project to GitHub

## Option 1: GitHub website

1. Download and extract the project ZIP.
2. Open your GitHub repository.
3. Select **Add file** and then **Upload files**.
4. Open the extracted project folder.
5. Drag all files and folders into GitHub's upload area.
6. Enter a commit message such as `Add complete lineup optimizer website`.
7. Select **Commit changes**.

GitHub's browser uploader may reject a very large number of files. The supplied ZIP excludes `node_modules`, build output, and local databases, so it should remain manageable.

## Option 2: GitHub Codespaces

1. Open the repository on GitHub.
2. Select **Code** → **Codespaces** → **Create codespace on main**.
3. In Codespaces, upload the extracted project files into the repository root.
4. Open the terminal and run:

```bash
npm install
npm test
git add .
git commit -m "Add complete badminton lineup optimizer"
git push origin main
```

## Option 3: Local command line

From the extracted project folder:

```bash
git init
git add .
git commit -m "Initial badminton lineup optimizer"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/YOUR-REPOSITORY.git
git push -u origin main
```

If the GitHub repository already contains a README or another initial commit, clone that repository first and copy the project contents into the cloned folder before committing.

## Files that should not be uploaded

The `.gitignore` already excludes generated or local-only content, including:

- `node_modules`
- `.next`
- `dist`
- `.wrangler`
- `.sites-runtime`
- environment files
- npm debug logs

Do not force-add those files.
