# Chatelherault RC Website

This repository contains a normalized, static-site structure generated from Stitch exports.

## Repository format

- `index.html`: Public home page
- `pages/`: Public secondary pages
- `admin/`: Admin and root-access interface pages
- `stitch-archive/`: Reference file copied from the original Stitch export package

## Public routes

- `/index.html`
- `/pages/meetups.html`
- `/pages/media.html`
- `/pages/spotlight.html`
- `/pages/contact.html`

## Admin routes

- `/admin/login.html`
- `/admin/dashboard.html`
- `/admin/root-owner.html`
- `/admin/godmode.html`
- `/admin/root-management.html`
- `/admin/root-login.html`

## Source mapping from Stitch export

- `stitch/home_updated/code.html` -> `index.html`
- `stitch/meetups_checklist_updated/code.html` -> `pages/meetups.html`
- `stitch/media_gallery_reel_update_2/code.html` -> `pages/media.html`
- `stitch/spotlight_2/code.html` -> `pages/spotlight.html`
- `stitch/contact_us_2/code.html` -> `pages/contact.html`
- `stitch/admin_login_tiered_2/code.html` -> `admin/login.html`
- `stitch/standard_admin_dashboard/code.html` -> `admin/dashboard.html`
- `stitch/owner_dashboard_root_access/code.html` -> `admin/root-owner.html`
- `stitch/godmode_admin_dashboard_elevated/code.html` -> `admin/godmode.html`
- `stitch/root_management_dashboard/code.html` -> `admin/root-management.html`
- `stitch/root_access_login/code.html` -> `admin/root-login.html`

## Local preview

Run any static server from the repository root, for example:

```bash
npx serve .
```

Then open `http://localhost:3000/index.html` (or the port reported by your server).

## Notes

- Primary top-navigation links on public pages are wired to internal HTML routes.
- Some footer/social/admin action links are intentionally left as `#` placeholders until final destinations are decided.
- Pages currently load fonts and Tailwind via CDN, matching Stitch output behavior.
