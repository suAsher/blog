# Visual system

The interface uses a deep blue canvas, mint for primary actions, violet for connections and blue for supporting information. Dark and light themes share the same semantic token names. System fonts and local SVG assets keep the interface independent of external font and image services.

## Tokens and ownership

`src/styles/tokens.css` is the single source for theme colors, type scale, spacing, corner radii, shadows, content widths, motion timing and layer levels. The dark theme is the default; `data-theme="light"` on the root selects the light palette. Existing `asher-theme` browser preferences remain compatible.

| Role | Token | Use |
| --- | --- | --- |
| Canvas and panels | `--bg`, `--surface`, `--surface-raised`, `--surface-glass` | Quiet canvas, cards, active controls, translucent panels |
| Text hierarchy | `--text`, `--muted`, `--faint` | Titles/body, descriptions, supporting metadata |
| Edges | `--line`, `--line-strong` | Separators and panel outlines |
| Primary action | `--accent`, `--accent-strong`, `--accent-bg` | Main buttons, active states, reading progress |
| Connections | `--violet`, `--violet-bg` | Orbit accents and secondary highlights |
| Information | `--blue`, `--blue-bg` | Context notices and supporting surfaces |
| Feedback | `--danger` | Error text |
| Elevation | `--card`, `--shadow`, `--shadow-raised` | Panel gradients and restrained depth |
| Scale | `--space-1` through `--space-9`, `--text-xs` through `--text-display` | Shared dimensions for new components |
| Shape | `--radius-sm` through `--radius-xl`, `--radius-pill` | Controls, panels, pill navigation |
| Motion | `--duration-fast`, `--duration-normal`, `--duration-reveal`, `--ease-out` | Interaction feedback and cover transitions |

Use semantic variables in new features. Feature-specific dimensions can remain local; the formatted legacy rules intentionally retain their existing cascade while the shared finished surfaces provide the current product appearance.

## Stylesheet structure

`global.css` is an explicit import manifest. Its order is significant:

1. Original home and collection structural rules.
2. Canonical tokens and base elements.
3. Site shell, overlays, information pages and their existing responsive rules.
4. Command menu and motion rules.
5. Shared finished surfaces, discovery page surfaces and final responsive polish.

`home.css` imports hero/orbit structure, cards, original breakpoints and enhancements in their prior order. `manage.css` imports workspace, editor, import dialog, responsive rules, and focus/insertion controls in their prior order. These splits followed a formatting-only pass; they do not introduce cascade layers or reorder media queries.

`article.css`, `reading-tools.css`, `content-blocks.css` and `lab.css` remain feature styles. Reader and editor canvases use the flat background and native scrolling; the decorative canvas belongs to discovery pages. Shared reading defaults remain 19px, a 760px text column and a line height of 2, with existing bounded user preferences taking precedence.

The motion enhancement stylesheet is separate from the structural design system. Decorative scene transforms should stay on their own wrappers so continuous motion, pointer movement and layout transforms do not overwrite each other.

## Login resource boundary

The login document requests only the existing `/login-assets/login.css` URL. Astro's local integration composes `tokens.css` with the login stylesheet for development and production output. Do not add an import from login to an `/_astro/` file, copy theme definitions into the login source, or broaden authentication exceptions. The generated public login CSS must contain the tokens before its structural rules.

## Responsive and accessible behavior

Desktop navigation uses compact pill states. At 700px and below it becomes the existing six-destination second row. Homepage actions precede the decorative scene, and the mobile primary button has a 48px minimum height. Content cards become one column below 500px. About-page values become individual cards on smaller displays.

Reader layouts switch to the disclosure table of contents at 900px, matching the reading-width breakpoint. The fullscreen image dialog explicitly resets generic dialog margins so its top edge starts at the viewport top.

Decorative brand lettering and shortcut badges are rendered through CSS pseudo-elements on empty, accessibility-hidden elements. This keeps decorative characters out of both accessible names and visible-label text matching. Search's visible label matches its accessible name. Native links and controls keep their original identifiers and interactions. Focus outlines use the active accent token.

Native cross-document view transitions remain enabled. Cover transitions use the `article-cover` name only for a real cover. Reduced-motion rules disable the browser's view-transition pseudo-element animations as well as ordinary element animations and transitions.

## Verification

`tests/e2e/visual-design.spec.ts` checks both themes' login/application token parity, fullscreen image viewer geometry, the 860px table of contents layout, and early visibility plus minimum size of the mobile exploration action. The image offset and intermediate-width TOC tests were observed failing before the fixes and passing afterward.

Visual review should include dark and light themes at desktop, tablet and mobile widths, with real sample content and the empty/error states. Use the existing authenticated test fixture when checking a deployed private environment; never include real document content or credentials in public screenshots.
