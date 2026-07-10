# PaiM Desktop Astryx Frame Plan

Last checked: 2026-07-08

## Goal

PaiM desktop should use the Astryx frame model first, then patch product-specific details.

The current custom grid shell caused repeated fixes around sidebars, titlebar controls, panel lines, and animation. The new baseline is:

```tsx
<Theme>
  <AppShell sideNav={...} contentPadding={0}>
    <Layout
      start={leftNav}
      content={mainContent}
      end={rightInspector}
    />
  </AppShell>
</Theme>
```

Use Astryx structure unless PaiM needs Tauri-specific behavior that Astryx does not own.

## Sources

- Astryx Layout guide: https://astryx.atmeta.com/docs/layout
- Astryx AppShell: https://astryx.atmeta.com/components/AppShell
- Astryx SideNav: https://astryx.atmeta.com/components/SideNav
- Astryx LayoutPanel: https://astryx.atmeta.com/components/LayoutPanel
- Astryx useResizable: https://astryx.atmeta.com/components/useResizable
- Astryx MobileNav: https://astryx.atmeta.com/components/MobileNav

Before changing frame/layout behavior, re-check the Astryx docs. Do not rely only on memory.

## Frame Contract

### Desktop

- Root: `AppShell`
- Left navigation: `SideNav`
- Main area: `LayoutContent`
- Right project tools: `LayoutPanel` in the `end` slot
- Resizing: `useResizable` + `ResizeHandle` or `LayoutPanel resizable`
- Panel states:
  - closed: right panel does not take content width
  - open: right `LayoutPanel` visible at saved width
  - maximized: right tool panel overlays the content region, not the left nav/titlebar controls

### Narrow Widths

- Left nav should move toward Astryx `MobileNav` behavior.
- Right inspector should overlay content instead of compressing it.
- Do not invent a second custom mobile shell unless Astryx cannot express the case.

## Mapping

| Current Area | New Astryx Owner | Keep Custom Only For |
| --- | --- | --- |
| `.app-shell` grid | `AppShell` + `Layout` | Tauri frameless window wrapper |
| `.sidebar` | `SideNav` | Project/session tree data rendering |
| sidebar collapse button | `SideNavCollapseButton` where possible | macOS traffic-light placement |
| `.chat` main column | `LayoutContent` | Chat scroll anchoring and composer position |
| `.project-panel` | `LayoutPanel` end slot | `closed/open/maximized` state glue |
| project panel resize | `useResizable` | Maximize mode toggle |
| file tree resize | `useResizable` if practical | File preview split details |
| settings layout | `LayoutContent` + `Section`/`FormLayout` | Back navigation rule |

## What To Delete Eventually

- Custom shell grid transitions based on `grid-template-columns`.
- Separate sidebar/panel resize state when `useResizable` can own it.
- One-off border line fixes created to patch old shell overlap.
- Manual mobile sidebar overlay rules if `MobileNav` covers the behavior.

## What To Keep

- Tauri titlebar/window controls integration.
- macOS traffic-light visual controls implemented in React.
- Project/session data model and local persistence.
- Chat message rendering, upload flow, GitHub flow, memory flow.
- Product-specific right panel tools: memory, files, GitHub.

## Migration Order

1. Wrap the app frame with Astryx `AppShell`.
2. Move the left navigation into `SideNav` without changing project/session behavior.
3. Move central chat/project-home/settings into `LayoutContent`.
4. Move right tools into `LayoutPanel`.
5. Replace custom panel resizing with `useResizable`.
6. Recreate closed/open/maximized as thin state glue around `LayoutPanel`.
7. Remove old grid/line/overlap CSS after visual parity.

Do not start by restyling individual rows. Frame first, then details.

## Expected Breakage

- Layout smoke selectors will need updates because DOM structure changes.
- Some recent CSS fixes will be deleted, not ported.
- LocalStorage keys for panel widths may change.
- Right panel maximize needs one small custom wrapper because Astryx handles panels, not PaiM's exact three-state inspector model.
- Titlebar/traffic-light alignment must be checked on macOS after every frame change.

## Verification

Minimum checks after each step:

```bash
git diff --check -- desktop/src
npx tsc --noEmit
```

Visual checks:

- left nav closed/open
- right panel closed/open/maximized
- settings with left nav closed/open
- project home before analysis
- chat after briefing
- files, memory, GitHub tool panels

## Rule

If Astryx has a component or hook for the frame behavior, use it first. Custom CSS is allowed only for Tauri/window chrome, product-specific panel states, or gaps Astryx does not cover.
