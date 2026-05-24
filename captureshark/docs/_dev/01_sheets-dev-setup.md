# Sheets dev setup — service account path

**Last updated:** 2026-05-15 — added Intent / Timeline / Financing Status columns to the dev sheet schema. Audited 2026-05-23, no further changes needed.

This is the **dev / demo** way to write to a Google Sheet without OAuth.
It exists so the team can smoke-test the write mechanics end-to-end
without going through the full user-OAuth round-trip on every reload.

Real users never touch this — they sign in with Google and pick a
sheet via the Picker. This doc is just for the developer.

---

## Live values (for the current setup)

Recording the non-secret identifiers here so future-me doesn't have to dig
through Cloud Console to find them. The actual JSON key file and any
secrets stay OUT of git (in `.env` + the secrets folder).

- **Cloud project:** `<your-project>`
- **Cloud account that owns the project:** `dev@captureshark.com`
- **Service account email:** `<sa-name>@<project>.iam.gserviceaccount.com`
  - This is the email you share the dev test sheet with (as Editor).
- **JSON key file location:** `secrets/<your-project>-sa.json` *(in-repo path, gitignored — pointed at by `GOOGLE_SERVICE_ACCOUNT_PATH` in `.env`)*
- **Dev test sheet ID:** `<dev-sheet-id>`
  - Sheet name: "CaptureShark Dev Leads"
  - Direct link: https://docs.google.com/spreadsheets/d/<dev-sheet-id>/edit

> The service account email is a public identifier (Google shows it on the
> Cloud Console UI; sharing it doesn't grant anyone anything). The JSON key
> is the secret — keep that file out of git, out of screenshots, out of
> chats with anyone.

---

## What you'll set up

1. A throwaway "CaptureShark Dev" Google Cloud project.
2. The Sheets API enabled on it.
3. A **service account** — a non-human Google identity with its own email.
4. A JSON private-key file the backend authenticates with.
5. A test Google Sheet shared with that service account as **Editor**.
6. Three env vars in `.env`.

Total: ~5 minutes.

---

## Step-by-step

### 1. Create or pick a Google Cloud project
- Go to https://console.cloud.google.com
- Top bar → project picker → **New Project** → name it "CaptureShark Dev"
  (or reuse any project — doesn't matter)

### 2. Enable the Sheets API
- Left nav → **APIs & Services** → **Library**
- Search "Google Sheets API" → click it → **Enable**

### 3. Create a service account
- Left nav → **IAM & Admin** → **Service Accounts** → **Create service account**
- Name: `<your-project>`
- Skip "grant access" (not needed for this)
- **Done**

### 4. Download the JSON key
- Click the new service account
- **Keys** tab → **Add key** → **Create new key** → **JSON** → **Create**
- A `*.json` file downloads. Save it somewhere outside the repo, e.g.
  `<local-path> **Never commit this file.**

### 5. Note the service account email
- Looks like `<your-project>@<your-project>-XXXXXX.iam.gserviceaccount.com`
- Copy it.

### 6. Create or open a test Google Sheet
- https://sheets.new — make a new blank sheet
- Name it something memorable, e.g. **"CaptureShark Dev Leads"**
- In row 1, paste these headers exactly (tab-separated, one per cell):

  ```
  Name    Phone   Email   Has Agent   Intent   Timeline   Financing Status   Budget   Area   Follow Up   Notes   Date Captured   Source
  ```

  > `Intent`, `Timeline`, and `Financing Status` were added 2026-05-15
  > as page-2 prioritisation fields (constrained-enum values). Valid
  > values written to the sheet:
  >   * Intent: `buyer`, `seller`, `both`, `browsing` (or blank).
  >   * Timeline: `now`, `3mo`, `6mo`, `12mo+` (or blank).
  >   * Financing Status: `cash`, `pre_approved`, `needs_lender`,
  >     `unknown` (or blank).
  > `Has Agent` (added 2026-05-12) is page 1: `yes` (optionally
  > `yes - Jane Smith` with the agent's name) / `no` / blank.
  >
  > If your existing dev sheet predates these adds, insert the new
  > columns at positions 5–7 (between `Has Agent` and `Budget`)
  > BEFORE saving any more captures — the fixed-order dev writer
  > assumes columns line up with this header order, so a missing
  > column will shift every following cell one column to the left.

- Copy the spreadsheet ID from the URL — the long random string between
  `/d/` and `/edit`. e.g. for
  `https://docs.google.com/spreadsheets/d/1ABCdefGHIJklmNOP/edit#gid=0`
  the ID is `1ABCdefGHIJklmNOP`.

### 7. Share the sheet with the service account
- In the sheet → **Share** button (top-right)
- Paste the service account email → set role to **Editor** → uncheck
  "Notify people" → **Share**

### 8. Add env vars to `.env`
Open `<repo>/.env` and add:

```
GOOGLE_SERVICE_ACCOUNT_PATH=<local-path>
DEV_TEST_SHEET_ID=1ABCdefGHIJklmNOP
DEV_TEST_SHEET_TAB=Sheet1
```

(Leave `DEV_TEST_SHEET_NAME=` blank — the backend will fetch the real
title and show it in the save confirmation card.)

### 9. Restart the backend
The uvicorn process needs to re-read `.env`. With `--reload` on, saving
the file may auto-pick it up; if not, kill and restart.

### 10. Smoke test from the browser
- Open http://localhost:5174
- Type a note (e.g. "Maria 555-0192 looking 3BR under 600k")
- **Extract details** → review the fields
- **Save to sheet**
- You should see "Saved to CaptureShark Dev Leads ✅" with an
  "Open in Google Sheets" link.
- Open the sheet — the row should be there.

---

## Common gotchas

- **403 / "no permission"** → you forgot to share the sheet with the
  service account email, or shared with the wrong role.
- **404 / "sheet not found"** → wrong `DEV_TEST_SHEET_ID`, or the sheet
  was deleted.
- **"Google service account is not configured"** (503) → the env vars
  weren't picked up. Restart the backend, or double-check the path on
  Windows uses forward slashes (or escaped backslashes).
- **Headers in the wrong order** → the row will land in the wrong
  columns. The dev path hardcodes the column order; the real-user path
  goes through the column-mapping confirmation in the sign-in flow.
