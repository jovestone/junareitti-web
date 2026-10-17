# JunaReitti (web)

Train timetables between two Finnish railway stations, as an installable web app.
A web port of [JunaReitti](https://github.com/suunta/suunta), the 2018 React Native app.

Data: [Fintraffic / digitraffic.fi](https://www.digitraffic.fi/) open rail API, CC BY 4.0.

## Use on iPhone

Open the GitHub Pages URL in Safari → Share → **Add to Home Screen**.
A link such as `?from=PSL&to=HKI` opens a fixed route, so you can add one icon per commute.

## Development

Plain HTML/CSS/JS in `web/`, no build step:

```
python -m http.server 8000 --directory web
```

Pushing to `main` deploys `web/` via `.github/workflows/pages.yml`.
The service worker serves files network-first, so installed apps pick up changes on the next
launch while online; the cached copy is only used offline.
