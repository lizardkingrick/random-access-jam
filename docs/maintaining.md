# Maintaining the live site

[← Back to the README](../README.md)

## Updating the site

The site is hosted on **Cloudflare Workers static assets**, the successor to Cloudflare Pages.
The Worker is named `dream-chamber-remixed` and serves the domain `dreamchamberremixed.xyz`.
Both are set in `wrangler.jsonc`. The stems are uploaded straight from your machine; they never
go through git. Unchanged files are skipped on each deploy, so updates that touch only the code
are quick. You need [Node.js](https://nodejs.org) 18+, plus [ffmpeg](https://ffmpeg.org) on your
PATH to build the Ogg stems (`npm run stems`) the first time or when the stems change.

```
# one time only
npm install
npm run stems -- --stems "D:\path\to\Stems"   # Ogg copies + stems.json
npx wrangler login           # or set CLOUDFLARE_API_TOKEN (template: Edit Cloudflare Workers)

# every release
git add -A && git commit -m "What changed"
git push
npm run deploy               # goes live on dreamchamberremixed.xyz
npm run deploy -- preview    # or: upload a preview version first; the live site is unchanged
```

`npx wrangler login` needs a browser on the same machine. Where that doesn't work (a remote
server, or a browser that fails Cloudflare's bot check), create an API token in the dashboard
(My Profile → API Tokens, template **Edit Cloudflare Workers**, limited to your account and the
`dreamchamberremixed.xyz` zone) and set it as the `CLOUDFLARE_API_TOKEN` environment variable.

To undo a bad release, roll back to the previous version in the Cloudflare dashboard
(Workers & Pages → dream-chamber-remixed → Deployments) or run `npx wrangler rollback`.

## Releasing a new version

1. Bump the version in `package.json` and `js/version.js`. The app shows the version in the
   top bar and the help screen.
2. Add a section to `CHANGELOG.md`.
3. Commit, then tag the release: `git tag v1.1.0 && git push --follow-tags`
4. Run `npm run deploy`.
5. Publish the release on GitHub: open **Releases → Draft a new release**, pick the tag, and paste
   that version's `CHANGELOG.md` section as the notes.
