# teleprompter deck — site

The public pages for the **Teleprompter Deck** Android app: a landing page and
the privacy policy that Google Play requires to be reachable at a public URL.

This repository is public **only** because GitHub Pages needs it to be on the
free plan. It holds nothing but these two pages — the app's source lives in a
private repository.

## Do not edit `privacy-policy.html` here

It is generated from `play/PRIVACY-POLICY.md` in the app repository by
`tool/build_privacy_page.py`. Edit the markdown there and run
`tool/publish_site.sh`, which regenerates the page and pushes it here.

Editing this copy by hand makes the policy disagree with the one the app is
built against, and a privacy policy that disagrees with itself is something
Play rejects for.
