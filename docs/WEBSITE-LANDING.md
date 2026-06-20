# Website Landing Shell

This doc covers the public `website/index.html` landing page and the shared browser shell that hosts both the marketing content and the hash-routed explorer; read it when changing the homepage hero, SEO/social metadata, landing navigation, reveal animations, mobile menu, Tailwind theme tokens, or the boundary between `#landing-content` and `#explorer-main`.

The QubitCoin website is one Vite entrypoint with two user-facing modes. The bare `/` URL shows the static landing page: hero, About, Technology, How It Works, CTA, and footer. Hash routes such as `/#/mempool`, `/#/docs`, and `/#/blog` keep the same HTML document and nav shell but reveal the explorer container. Search terms that should land here include `landing-content`, `explorer-main`, `mobile-menu-btn`, `reveal.visible`, `grid-bg`, `quantum-orb`, `nav-landing`, `og-banner.png`, `TAILWIND_VIEWPORTS`, and "landing screenshot".

## Why It Exists

The landing page is not a separate app from the explorer. It shares `website/index.html`, `website/src/style.css`, and two loaded TypeScript modules with the live block explorer. That keeps deployment simple: Vite builds one static site, nginx serves it, and explorer API calls proxy under `/api`. It also means homepage changes can accidentally affect explorer layout, search visibility, nav behavior, or screenshot coverage.

The implementation deliberately stays framework-free. Static homepage sections are plain HTML in `index.html`. The only landing-specific TypeScript in `main.ts` observes `.reveal` nodes, toggles the mobile menu, and highlights in-page nav links while scrolling. Explorer state, routing, API fetches, and docs/blog rendering remain in `explorer-main.ts` and the explorer docs modules.

This split matters because the same nav links mix three route styles:

- Same-page anchors such as `#about`, `#technology`, and `#how-it-works`.
- Explorer hash routes such as `/#/docs`, `/#/blog`, and `/#/mempool`.
- External social/source links in the CTA and footer.

A maintainer changing any one of those paths needs to preserve the contract between static HTML, landing script behavior, and the explorer router.

## Key Files

| Anchor | Role |
|---|---|
| `website/index.html:14` | Page title and primary SEO title. |
| `website/index.html:15` | Meta description used by search previews. |
| `website/index.html:18` | Open Graph metadata block begins. |
| `website/index.html:41` | JSON-LD `SoftwareApplication` structured data. |
| `website/index.html:63` | Fixed nav shell shared by landing and explorer routes. |
| `website/index.html:80` | `#mobile-menu-btn`, the button wired by `main.ts`. |
| `website/index.html:87` | `#mobile-menu`, hidden until the button toggles it. |
| `website/index.html:101` | `#landing-content`, the homepage wrapper hidden by explorer routes. |
| `website/index.html:103` | Hero section and grid background. |
| `website/index.html:141` | About section targeted by `#about`. |
| `website/index.html:194` | Technology section targeted by `#technology`. |
| `website/index.html:304` | How It Works section targeted by `#how-it-works`. |
| `website/index.html:421` | `#explorer-main`, hidden on `/` and shown on explorer hashes. |
| `website/index.html:426` | Explorer search input, not a landing search box. |
| `website/index.html:462` | Landing script module load: `/src/main.ts`. |
| `website/index.html:463` | Explorer script module load: `/src/explorer-main.ts`. |
| `website/src/main.ts:1` | IntersectionObserver setup for `.reveal` sections. |
| `website/src/main.ts:13` | Mobile hamburger menu behavior. |
| `website/src/main.ts:37` | Scroll-based active nav highlighting for anchor links. |
| `website/src/style.css:3` | Tailwind v4 `@theme` tokens for website colors and fonts. |
| `website/src/style.css:69` | `.grid-bg` background used by the hero. |
| `website/src/style.css:77` | `.quantum-orb` hero glow element. |
| `website/src/style.css:98` | `.reveal` transition state consumed by `main.ts`. |
| `website/vite.config.ts:5` | Vite config with Tailwind plugin and single HTML input. |
| `website/playwright.config.ts:3` | Visual viewport matrix for website screenshots. |
| `website/e2e/visual.spec.ts:70` | Screenshot route list, including `landing`. |

## How It Works

### One HTML Document, Two Modes

`website/index.html` contains both the static landing page and the explorer shell:

```text
/
  nav
  #landing-content
    hero
    #about
    #technology
    #how-it-works
    CTA
  #explorer-main.hidden
    #search-input
    #explorer-content
  footer
```

The landing wrapper is visible in the HTML source. The explorer wrapper starts with the Tailwind `hidden` class. `explorer-main.ts` owns switching between them when the hash is an explorer route; this doc only records the static-side contract. If a homepage change renames `#landing-content` or `#explorer-main`, the explorer router loses the DOM handles it needs to toggle modes.

The footer is outside both wrappers, so it remains visible for landing and explorer routes. That is intentional: social links and the open-source identity are site-wide, while the search input belongs only to the explorer.

### Metadata And First Paint

The document head is part of the landing surface, not an afterthought. The title, description, canonical link, Open Graph image, Twitter card, favicons, Google font preconnects, and JSON-LD all live in `index.html` before the body. The current page identifies QubitCoin as a post-quantum Bitcoin fork using ML-DSA-65 and points social previews at `https://qubitcoin.finance/og-banner.png`.

Because Vite builds a static site, these tags are available to crawlers and social scrapers without waiting for client-side routing. Do not move them into `main.ts` or an explorer renderer. The explorer's hash routes are client-side views inside the same document; the root document metadata remains the public preview metadata for the site.

### Navigation Shape

The desktop nav has three landing anchors followed by three explorer links. The landing anchors use `href="#about"`, `href="#technology"`, and `href="#how-it-works"`. The explorer links use absolute root-hash paths such as `href="/#/docs"` rather than local anchors.

That distinction is load-bearing:

- Anchor links keep the user on the landing page and let `html { scroll-behavior: smooth; }` handle scrolling.
- Explorer links hand control to `explorer-main.ts`, which parses `location.hash` and renders into `#explorer-content`.
- `nav a[href^="#"]` in `main.ts` intentionally selects only same-page anchors for active-section highlighting.

The mobile menu mirrors the same destination set inside `#mobile-menu`. If nav destinations change, update both desktop and mobile lists together.

### Landing Interactivity

`main.ts` is small and landing-focused. On module load, it creates an `IntersectionObserver` with a `0.1` threshold and observes every `.reveal` element. When a reveal target intersects, the script adds `visible`; CSS then transitions opacity and vertical offset.

The mobile menu behavior is defensive: it checks that `#mobile-menu-btn` and `#mobile-menu` exist before registering listeners. A button click toggles `hidden`; any mobile-menu link click adds `hidden`; scrolling also closes the menu if it is open. There is no global menu state object.

The scroll highlighter computes the current section by scanning `section[id]` elements and comparing each section's `offsetTop` to `window.scrollY - 200`. It then toggles `text-qubit-400` and `text-text-muted` on `nav a[href^="#"]`. Because it targets all `section[id]` elements, adding a new landing section with an id can change which anchor is considered active during scroll.

### Visual System

The website uses Tailwind v4 with design tokens defined in `style.css` under `@theme`. The current palette is dark purple with cyan/blue accents: `bg`, `surface`, `border`, `text-*`, `qubit-*`, `entropy-blue`, and `entropy-cyan`. Those token names are used directly as utility classes throughout `index.html`.

Custom CSS is limited to site-wide effects that Tailwind utilities do not express succinctly:

- `.glow-text`, `.glow-box`, and `.glow-border` for luminous emphasis.
- `.grid-bg` for the hero grid.
- `.quantum-orb` for the blurred hero glow.
- `.reveal` / `.reveal.visible` for scroll entrance transitions.
- `.feature-card:hover` for landing card lift.
- `.gradient-text` for the QubitCoin hero wordmark effect.
- `.prose-blog strong` for blog content generated by helpers.
- WebKit scrollbar colors.

Because `style.css` is loaded for the whole site, these classes are shared by landing, explorer, docs, and blog pages. A visual change meant only for the landing page should use a landing-specific class or a tightly scoped selector so it does not alter explorer cards or docs prose by accident.

### Content Flow

The landing content explains the project in three layers:

1. Hero: brand, post-quantum positioning, and calls to the Technology and How It Works sections.
2. About and Technology: user-facing reasons, ML-DSA-65 dimensions, Bitcoin UTXO snapshot facts, and architecture tiles.
3. How It Works and CTA: the BTC snapshot -> claim proof -> quantum-safe UTXO migration story, followed by GitHub and in-page navigation.

The same technical facts have deeper implementation docs elsewhere. The landing page should stay concise and user-facing; detailed behavior belongs in docs such as `CLAIM-FLOW.md`, `SNAPSHOT-PIPELINE.md`, `CRYPTO-PRIMITIVES.md`, and `DUMPTXOUTSET-FORMAT.md`. Duplicating full protocol explanations in `index.html` makes the homepage harder to maintain and more likely to drift.

### Build And QA Boundary

The website project is built from `website/` with `pnpm build`. The root script `pnpm run website:build` delegates to that command, while `pnpm run website:screenshots` delegates to `website`'s Playwright screenshot flow.

`website/playwright.config.ts` builds and previews the site on port `4173`, then runs the same screenshot spec across six viewport projects: `mobile`, `sm`, `md`, `lg`, `xl`, and `2xl`. `website/e2e/visual.spec.ts` includes `{ name: 'landing', hash: '' }`, so homepage visual regressions are part of the existing screenshot suite.

The screenshot spec stabilizes the landing page by disabling animation and forcing `.reveal` elements visible before capturing. That means screenshots review layout and content, not animation timing. If a homepage change depends on animation or intersection timing, it needs manual browser review in addition to the screenshot artifact.

## Invariants And Edge Cases

### Element IDs Are Cross-Module API

`#mobile-menu-btn`, `#mobile-menu`, `#landing-content`, `#explorer-main`, `#search-input`, and `#explorer-content` are not decorative ids. They are lookup points for `main.ts` and `explorer-main.ts`. Renaming them requires updating the consuming TypeScript in the same change.

### Landing Anchors Are Not Explorer Routes

`#about` is an in-page anchor, while `#/docs` is an explorer route. Do not convert landing links to `/#/about` unless an explorer route is actually added. Conversely, do not point docs/blog/mempool links at local anchors; the explorer router expects hash segments after `#/`.

### Both Scripts Load On Every Page

`main.ts` and `explorer-main.ts` are both loaded at the end of `index.html`. Landing code must tolerate explorer routes, and explorer code must tolerate the root landing route. Keep landing behavior guarded by DOM checks when it depends on optional elements.

### Reveal Depends On Initial Markup

Elements with `.reveal` start hidden through CSS until `main.ts` adds `.visible`. If JavaScript fails before the observer runs, those elements can remain hidden. Do not put essential first-viewport hero content behind `.reveal`; the current hero is visible without observer state.

### Mobile And Desktop Markup Can Drift

The nav destination list is duplicated between the desktop nav and the mobile menu. A new top-level destination needs both entries, and the mobile copy should still close the menu on click through the existing `mobileMenu.querySelectorAll('a')` listener.

### SEO Metadata Is Static

The root document metadata is not route-specific. A social share of `/#/tx/<id>` still starts from the same `index.html` metadata unless a crawler executes the SPA and supports hash routes. Treat the metadata as site-level landing metadata.

### Visual Tests Mock APIs

The landing screenshot does not need API fixtures, but the screenshot spec installs the same `/api/v1` route mocks for all routes. A homepage-only change should still pass with mocked APIs because both scripts load and the explorer module may initialize route handling in the same document.

## Cross-References

- [Explorer Data Flow](./EXPLORER-DATA-FLOW.md) for the hash router, `showLanding()` / `showExplorer()` behavior, live explorer views, and `/api/v1` fetch helpers.
- [Explorer Content Architecture](./EXPLORER-CONTENT.md) for embedded `#/docs/*` and `#/blog/*` rendering.
- [Website QA Workflow](./WEBSITE-QA.md) for Playwright screenshot, API-error, block-height, and XSS coverage.
- [Deployment Surfaces](./DEPLOYMENT-SURFACES.md) for how Vite output is built and copied into production static hosting.
- [Claim Flow](./CLAIM-FLOW.md) for the full BTC -> QBTC claim proof model summarized by the landing page.
- [Snapshot Pipeline](./SNAPSHOT-PIPELINE.md) for the snapshot commitment behind the landing "Snapshot Bitcoin" section.
- [Crypto Primitives Map](./CRYPTO-PRIMITIVES.md) for ML-DSA-65 and secp256k1 primitives named on the homepage.
