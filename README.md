# apps.mysecondwish.com

The public pages for each app, one folder per app. Each folder has a landing
page plus the privacy policy, terms and support pages that the stores require
to be reachable at a public URL.

| Folder | App | Pages |
| --- | --- | --- |
| `teleprompter/` | Teleprompter Deck (Android) | privacy, terms, support, delete-account |
| `dimlock/` | DimLock (Android, `com.mysecondwish.blackscreen`) | privacy, terms, support, delete-account |
| `signvel/` | SignVel (Android, `com.mysecondwish.signvel`) | privacy, terms, support |
| `responsive-lens/` | Responsive Lens (Chrome extension) | privacy, support |
| `wa-sendervel/` | Wa SenderVel (Chrome extension) | privacy, support |

`style.css` is shared. Each app's pages set their own `--accent` colour.
`app-ads.txt` at the root lists the AdMob publisher IDs: pub-3748438999340132 is the current account (SignVel); pub-6821159100234374 is the earlier, rejected account, kept until no app uses it.

This repository is public **only** because GitHub Pages needs it to be on the
free plan. It holds nothing but these pages — the apps' source lives in
private repositories.

## Do not edit `privacy-policy.html` here

It is generated from `play/PRIVACY-POLICY.md` in the app repository by
`tool/build_privacy_page.py`. Edit the markdown there and run
`tool/publish_site.sh`, which regenerates the page and pushes it here.

Editing this copy by hand makes the policy disagree with the one the app is
built against, and a privacy policy that disagrees with itself is something
Play rejects for.
