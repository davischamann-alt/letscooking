# 🍳 Let's Cooking

Type a craving, get recipes, rate what you cook — and get better ideas over time.

A small static site (plain HTML/CSS/JS, no build step). Recipes come from the free
[TheMealDB](https://www.themealdb.com) API. Saved recipes, ratings and notes are kept in the
visitor's own browser (`localStorage`), so there is no server, account or database.

Usage instructions live inside the site under **How it works**.

## Put it online with GitHub Pages

1. On GitHub, open this repository → **Settings** → **Pages**.
2. Under **Build and deployment**, set **Source** to **Deploy from a branch**.
3. Pick the branch that contains `index.html`, folder **/ (root)**, and press **Save**.
4. After a minute the site is live at `https://<your-username>.github.io/letscooking/`.

## Run it locally

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000>.

## Files

- `index.html` — page shell and navigation
- `style.css` — styling (light and dark)
- `app.js` — search, recipe pages, reviews, and the taste profile that drives suggestions
