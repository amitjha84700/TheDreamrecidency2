# The Dream Residency — Hotel Management

A full hotel management website with public site + admin panel.

## Stack
- Node.js + Express (server.js)
- better-sqlite3 (data.db)
- Vanilla HTML/CSS/JS frontend (public/)
- multer for file uploads (uploads/)
- nodemailer for booking confirmation emails

## Run
- Workflow "Start application" runs `node server.js` on port 5000.

## Admin login
- URL: `/admin-dream/login`
- User: `Harsh@2003`
- Password: `Dream@2010`

## Public site features
- Editable hotel content (name, tagline, about, dining, contact, images)
- 3 fixed room categories (Suite / Deluxe / Twin Bed) with admin-controlled image,
  description and feature list — NO prices shown to guests
- "Read More" modal per room type
- Booking request form with:
  - Country-code phone selector (per-country length validation)
  - Future-only check-in/out dates
  - **+/- quantity steppers for "Guests" and "Rooms Required"**
  - Dynamic per-guest fields — **name + age only**
    (ID type & ID number are NOT collected here; they are captured at check-in)
  - "Rooms required" toggle when guests > 2
  - Polished UI: gold accent, card border-top, focus rings, hover lift on submit
  - Animated SVG success overlay on submit

## Admin panel features
- **Dashboard** — KPIs and quick stats
- **Booking Requests** — view guest details (with multi-guest modal), confirm
  (assigns room, auto-emails customer, total auto-calculated as
  nights × room price × rooms_required), reject, delete
- **Walk-In / Check-In** — search returning guests by name/phone/ID, see full
  history (visits, nights, revenue), inline new-customer registration
- **Visitors** — anonymous visitor analytics
- **Site Content** — text fields, image upload OR public URL (Google Drive,
  Dropbox links auto-normalised), SMTP settings (host/port auto-detected from
  email domain — Gmail / Outlook / Yahoo / Zoho / iCloud / Office365)
- **Room Types** — edit name, image (file or URL), short tagline, full
  description, feature list, internal price for the 3 fixed categories
- **Rooms** — inventory CRUD with category dropdown bound to Room Types
- **Customers** — edit-only (no delete to preserve history); ID Proof number
  mandatory; per-customer history modal
- **Bookings** — multi-guest field, inline new-customer creation toggle,
  **per-guest check-in modal** that renders one card per guest with its own
  Document Type selector and multi-file upload (front+back, image/PDF).
  One click: "Upload All & Mark Checked-In" loops through every guest card
  and uploads in sequence, showing per-guest status. Auto-calculated total
  (server-side, not editable on client), payments tracking.
- **Reports** — weekly / monthly / yearly + custom range, CSV export

## Data model highlights
- `room_types` (slug, name, image, short_desc, description, features, price)
- `rooms` (number, category → room_types.slug, price, status, image, features)
- `customers` (name, contact, email, id_proof, document)
- `bookings` (customer_id, room_id, dates, guests, guest_details JSON,
  rooms_count, total auto-computed)
- `booking_requests` (+ guest_details JSON, rooms_required, country_code)
- `booking_documents` (+ guest_index, guest_name for per-guest mapping)
- `payments`, `visitors`, `visits`, `site_content`

## Auto-pricing rule
`total = nights × room.price × rooms_count`, computed server-side on every
booking POST and confirmation. Admin cannot override the total from the UI.

## Image URL normalisation
`normalizeImageUrl()` rewrites `drive.google.com/file/d/<id>/view` and
`drive.google.com/open?id=<id>` to direct `uc?export=view&id=<id>` links, and
swaps `?dl=0` → `?raw=1` on Dropbox shares so images load inline.

## SMTP auto-detection
On saving Email Settings, if `smtp_host` is empty or generic, the server reads
the username's domain and fills in host/port from a built-in provider table
(Gmail, Outlook/Office365, Yahoo, Zoho, iCloud).

## Sessions / auth
Session-based cookie auth (express-session). All write APIs are guarded by
`requireAdmin` middleware.

## UI animations (admin)
The admin panel has rich entrance + interaction animations defined in
`public/styles.css` ("Admin: animations & polish" section):
fade-in-up panel/cards, animated tab underline, stat-card hover lift,
table-row slide-in on hover, button press feedback, modal pop-in,
login-card scale-in + bobbing logo. All animations honor
`prefers-reduced-motion`.
