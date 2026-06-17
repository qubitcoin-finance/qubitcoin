# Explorer Content Architecture

This doc covers the explorer's embedded documentation and blog content system; read it when adding `#/docs/*` sections, `#/blog/*` posts, or debugging why static explorer content does not appear in navigation.

The explorer has two content lanes that look similar in the UI but have different contracts. `DOC_SECTIONS` is a table of trusted documentation renderers, each reachable through `#/docs/<section>`. `BLOG_POSTS` is an ordered list of dated article modules, each reachable through `#/blog/<slug>`. Both lanes are compiled into the Vite bundle as TypeScript modules and rendered by `website/src/explorer-main.ts`; neither lane fetches markdown, JSON, or remote CMS content at runtime.

## Why It Exists

The block explorer is a vanilla TypeScript app with hash-based routing. It needs to show live chain views that fetch `/api/v1` data, but it also needs stable user-facing explanations for running a node, BTC claims, consensus, API usage, and development posts. Keeping docs and blog content in static TypeScript modules makes that content deploy with the website build and avoids adding a client-side markdown parser, frontend router, or CMS.

The tradeoff is that every content module returns HTML strings. The code relies on static, maintainer-authored strings and a small set of helper functions instead of runtime sanitization. That boundary matters: the docs renderer explicitly notes that the docs sidebar and content interpolate static section metadata, not user-provided data.

## Key Files

| Path | Role |
| --- | --- |
| `website/src/explorer-main.ts:46` | Defines the explorer `Route` union, including `docs` and `blog` route shapes. |
| `website/src/explorer-main.ts:55` | Parses `location.hash` into explorer routes, including `#/docs/<section>` and `#/blog/<slug>`. |
| `website/src/explorer-main.ts:613` | Renders one blog post by looking up `BLOG_POSTS` by slug. |
| `website/src/explorer-main.ts:650` | Renders one docs section by looking up `DOC_SECTIONS` by section id. |
| `website/src/explorer-main.ts:654` | Builds the docs sidebar from `DOC_SECTIONS`. |
| `website/src/explorer-main.ts:673` | Documents the static-content XSS assumption for embedded docs. |
| `website/src/explorer-main.ts:788` | Hides search and widens the explorer container for docs/blog routes. |
| `website/src/explorer-main.ts:803` | Dispatches parsed routes to live views, docs, or blog renderers. |
| `website/src/explorer-docs.ts:16` | Registers all docs sections and their sidebar child anchors. |
| `website/src/explorer-docs-helpers.ts:5` | Defines `DocSection`, the registry shape used by `DOC_SECTIONS`. |
| `website/src/explorer-docs-helpers.ts:13` | Provides shared docs HTML helpers such as `docCode`, `docJson`, `docSteps`, `docH2`, `docH3`, and `docP`. |
| `website/src/explorer-docs-api.ts:8` | Example docs renderer that composes endpoint tables, prose, JSON examples, and code blocks. |
| `website/src/blog/types.ts:1` | Defines the `BlogPost` module contract. |
| `website/src/blog/types.ts:10` | Defines tag color classes used by blog list and post views. |
| `website/src/blog-posts.ts:22` | Orders the blog archive by importing each post module into `BLOG_POSTS`. |
| `website/src/blog/run-a-node.ts:3` | Example blog post module implementing the `BlogPost` contract. |

## How It Works

### Route Selection

`parseRoute()` treats the hash after `#/` as the explorer route. For static content, only the first two path segments matter:

```text
#/docs                -> { view: 'docs', section: undefined }
#/docs/api            -> { view: 'docs', section: 'api' }
#/blog                -> { view: 'blog', slug: undefined }
#/blog/run-a-node     -> { view: 'blog', slug: 'run-a-node' }
```

The dispatcher handles docs and blog differently from live chain views. For live views, it renders a loading state before awaiting RPC-backed renderers. For docs and blog, it skips the loading state and calls the static renderer directly. It also hides the search bar and widens `#explorer-main` for both docs and blog routes, because the docs layout has a sidebar and the blog archive uses wider cards.

### Docs Registry

`DOC_SECTIONS` is the docs table of contents. Each entry contains:

- `id`: the route segment under `#/docs/`.
- `title`: the sidebar label.
- `icon`: SVG path markup passed into `docIcon()`.
- `render`: a no-argument function returning the section's HTML string.
- `children`: optional in-page anchors for the active section.

The registry imports renderer functions from topic modules such as `explorer-docs-intro.ts`, `explorer-docs-architecture.ts`, `explorer-docs-claims.ts`, `explorer-docs-api.ts`, and `explorer-docs-faq.ts`. Adding a new docs page is therefore a two-step wiring change: create or extend a renderer module, then add a `DocSection` entry to `DOC_SECTIONS`.

### Docs Rendering

`renderDocs(section)` defaults to `overview`, then finds the matching section by id. If the section id is unknown, it falls back to the first registry entry instead of showing a 404. The sidebar is regenerated from the full registry every time the docs view renders, so section order in `DOC_SECTIONS` is also navigation order.

When the active section has `children`, each child becomes an in-page link. The click handler prevents normal navigation, scrolls to `document.getElementById(child.id)`, and keeps the URL at `#/docs/<section>` with `history.replaceState`. The child ids must match DOM ids produced by the renderer. In normal docs prose, `docH2(text)` creates ids by lowercasing the heading text, replacing non-alphanumeric runs with `-`, and trimming leading/trailing dashes.

### Docs Helpers

The docs helpers are intentionally small string builders:

- `docCode(code)` wraps plain code/preformatted text.
- `docJson(json)` applies simple regex-based highlighting for keys, values, booleans, null, and `//` comments.
- `docSteps(items)` renders an ordered list inside a highlighted panel.
- `docH2(text)` renders a scroll-target heading with a deterministic id.
- `docH3(text)` renders a lower-level heading without an id.
- `docP(text)` renders a paragraph.
- `docIcon(paths, cls)` wraps SVG path markup in the shared icon shell.

These helpers do not escape arbitrary input. They are suitable for static maintainer-authored content. If a docs section ever interpolates live API data or user input, it must use existing escape utilities from the explorer formatting layer before inserting values into returned HTML.

### Blog Registry

Blog posts use a separate contract from docs sections. A post module exports a default `BlogPost` object with `slug`, `title`, `date`, `tags`, `excerpt`, and `content()`. The central `BLOG_POSTS` array imports each module and controls archive ordering. The archive treats the first array item as the featured/latest card, so ordering is a visible product decision, not just a data detail.

The blog list view maps `BLOG_POSTS` into one featured card plus a grid of remaining cards. Tag badges use `BLOG_TAG_COLORS`, falling back to muted classes when a tag has no explicit color mapping. The individual post view finds a post by exact slug. Unknown slugs render a static 404 panel with links back to `#/blog` and `#/`.

### Blog Helpers

`website/src/blog/types.ts` provides the blog helper functions, separate from docs helpers:

- `h2(text)` renders a blog heading.
- `p(text)` renders a blog paragraph.
- `steps(items)` renders an ordered list panel.

The blog helpers match the blog typography and card treatment, while docs helpers match the docs section layout. Do not mix them unless the surrounding module already does; visual consistency comes from keeping each content lane on its own helper set.

### Adding A Docs Section

A docs section becomes reachable only when it is registered. The current pattern is:

1. Put the renderer in the closest topic module, or create a new `website/src/explorer-docs-*.ts` module if no existing topic file fits.
2. Export a `renderDocs<Name>(): string` function from that module.
3. Compose the body with `docP`, `docH2`, `docH3`, `docCode`, `docJson`, or local static markup.
4. Import the renderer in `website/src/explorer-docs.ts`.
5. Add a `DocSection` entry to `DOC_SECTIONS`.
6. Add `children` only for headings that really exist in the rendered HTML.

The route is the registry id, not the function name. A renderer named `renderDocsWallet` is reachable at `#/docs/wallet` because the registry entry has `id: 'wallet'`.

### Adding A Blog Post

A blog post follows the opposite shape: it owns its metadata in the post file, then the archive imports it. The current pattern is:

1. Create `website/src/blog/<slug>.ts`.
2. Export a default `BlogPost`.
3. Set `slug` to the same route-safe string used in the filename.
4. Return the article body from `content()`.
5. Import the module in `website/src/blog-posts.ts`.
6. Insert it into `BLOG_POSTS` at the intended archive position.

There is no automatic date sort. The post that appears first in `BLOG_POSTS` becomes the featured card on `#/blog`, even if another post has a newer `date` field.

## Invariants And Edge Cases

### Static HTML Boundary

Docs and blog renderers return HTML strings that are assigned to `root.innerHTML`. That is acceptable only because the content is static and maintained in source control. Renderer modules should not interpolate untrusted route strings, API responses, local storage values, or query parameters directly into HTML.

### Local Import Extensions

The website codebase mostly imports local TypeScript modules without `.js` extensions in explorer entrypoints, while blog post modules import `./types.js`. Follow the surrounding file's existing convention when adding content. Do not introduce path aliases or a framework-style content loader.

### Unknown Routes

An unknown docs section falls back to the first docs section. An unknown blog slug renders a 404 message. This asymmetry is intentional in the current implementation: docs navigation prefers a valid default section, while blog permalinks preserve a missing-content state.

### Child Anchor Coupling

`children` entries in `DOC_SECTIONS` are not discovered from rendered headings. They are hand-maintained. If a heading changes, its generated `docH2()` id can change too, and the sidebar child link can silently stop scrolling to the right element. Keep the `children[].id` values in sync with the renderer's actual heading ids.

### Archive Ordering

`BLOG_POSTS` is manually ordered. A post's `date` is displayed but does not sort the archive. Moving an import inside the array changes the featured post and archive order without changing any dates.

### Search Visibility

Docs and blog routes hide the explorer search bar. Search remains focused on chain objects: blocks, transactions, and addresses. Static docs/blog content is navigated through the docs sidebar, blog archive, direct hash links, and normal in-page anchors.

### Build-Time Content

Because content modules are bundled by Vite, adding a docs renderer or blog post requires import wiring. A file that exists under `website/src/blog/` or `website/src/` is unreachable until it is imported into `BLOG_POSTS` or `DOC_SECTIONS`.

## Cross-References

- [Explorer Data Flow](./EXPLORER-DATA-FLOW.md) for the surrounding hash router, live explorer views, and `/api/v1` fetch helpers.
- [RPC Endpoint Surface](./RPC-ENDPOINTS.md) for the backend routes documented by the embedded API reference.
- [BTC -> QBTC Claim Flow](./CLAIM-FLOW.md) for the claim model summarized in the embedded BTC claims docs.
- [P2P Networking & Initial Block Download](./P2P-SYNC.md) for the peer behavior summarized in the embedded P2P docs.
- [qbtcd Runtime Lifecycle](./QBTCD-RUNTIME.md) for the CLI and startup behavior referenced by user-facing node-running content.
