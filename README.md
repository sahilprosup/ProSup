# ProSup — Proline Group Supplier Directory

Single-file HTML web app (no build step) for browsing suppliers, filing quotes/invoices/data sheets, comparing prices, and an AI assistant that answers questions from filed documents. Used internally by Proline Metal Cladding / Proline Facades / Proline Fabrication.

- **Live site:** https://prosupp.netlify.app/
- **Main file:** `index.html` — this is the entire app (HTML/CSS/JS in one file). `supplier-directory.html` is an identical mirror kept in sync alongside it.
- **Backend:** Supabase project `ceujwwyciamljjgfygyd`
- **Admin login:** sahil@prolinegroup.au

## How the file is structured

`index.html` is large (~9.5MB) because roughly 650 legacy suppliers and their quote/invoice/data-sheet PDFs are embedded directly in the file as JS object literals with base64-encoded `data:` URLs (search for `const suppliers =`, `const quoteFiles =`, `const invoiceFiles =`, `const dataSheetFiles =`, `const salesConfirmationFiles =`, `const pricing =`). This was a deliberate original design choice — the file is self-contained and needs no separate hosting for those legacy PDFs — but it's also flagged as the top performance issue if this project continues to grow (a migration into Supabase Storage was scoped but explicitly deferred by the client, see "Known open items" below).

Anything added **through the app itself** (via "+ Add supplier" / "+ Add quote" etc.) goes into real Supabase tables and Storage, not into the embedded arrays.

### Legacy data override system (important)

Because ~650 suppliers/files are baked into the HTML rather than the database, editing or deleting them can't just be a DB write — the next person who loads the page still gets the old embedded value unless two things happen:

1. **The source file itself gets edited** (the array literal in `index.html`) — takes effect on next deploy.
2. **A live override is written to the DB** so the currently-deployed file reflects the change immediately, without waiting for a redeploy:
   - Editing a legacy supplier's fields → upsert into `public.edited_suppliers`, keyed by `item_key = lower(trim(name + "|" + contact))` using the **currently-live** name/contact (not the new value) until the file is actually redeployed.
   - Deleting a legacy supplier/file → tombstone insert into `public.deleted_items` (`kind`, `item_key`).
   - Renaming/moving a legacy quote/invoice/data-sheet file → upsert into `public.renamed_items` (`kind`, `item_key`, `new_company`, `new_name`).

There is currently **no live-override mechanism for moving a legacy file between kinds** (e.g. invoice → quote) or for any change that involves the actual embedded binary/PDF data — those require an actual file edit + redeploy, since doing it live would mean uploading binary data to Supabase Storage.

On page load, `syncWithServer()` merges: embedded legacy data → apply `edited_suppliers` / `renamed_items` overrides → filter out anything in `deleted_items` → merge in real DB rows (suppliers, quote_files, invoice_files, data_sheet_files, sales_confirmation_files).

## Supabase project reference

**Project ID:** `ceujwwyciamljjgfygyd`

### Tables (public schema, all RLS-enabled)
- `profiles`
- `suppliers` — real (non-legacy) supplier rows
- `quote_files`, `invoice_files`, `data_sheet_files`, `sales_confirmation_files` — real (non-legacy) file rows, `storage_path` points into the matching Storage bucket
- `price_line_items` — structured (item, price, unit, date) rows extracted from quotes for the Compare Prices view
- `document_search_index` — extracted plain text per document, used by the AI assistant/search
- `allowed_emails` — signup allowlist (enforced by trigger `enforce_allowed_email` → `check_allowed_email()`)
- `invoice_access_emails` — who can see/add/edit/delete invoices and other privileged actions (see permissions below)
- `audit_log` — recent add/edit/delete trail, shown on the Admin page
- `ai_query_log` — recent AI assistant questions, shown on the Admin page
- `deleted_items`, `renamed_items`, `edited_suppliers` — legacy-data override tables described above

### Storage buckets
`quote-files`, `invoice-files`, `sales-confirmation-files`, `data-sheet-files` — only used for files added through the app; legacy PDFs are embedded in the HTML, not in Storage.

### Permission model
- `is_admin()` SQL function = `lower(auth.email()) = 'sahil@prolinegroup.au'` — **hardcoded to one person**, gates the Admin page/nav only.
- `has_invoice_access()` = `is_admin() OR` email exists in `invoice_access_emails` — gates all edit/delete actions across suppliers, quotes, invoices, data sheets, sales confirmations.
- Client-side mirrors: `window.isAdmin` (Admin nav visibility only) vs `window.hasInvoiceAccess` (all edit/delete buttons and functions).
- Current `invoice_access_emails` list: cam, claudio, daniel, jake, lachlan, luka, mary, sahil, salman (all `@prolinegroup.au`).

### Edge functions (see `supabase/functions/`)
- **ai-search** — powers the home-page "Ask" box. Keyword-filters `document_search_index`, builds a prompt from matching docs + supplier list, calls Claude (`claude-haiku-4-5-20251001`), strips invoice documents out of context entirely if the caller isn't in `invoice_access_emails`. Logs to `ai_query_log`.
- **extract-pdf-text** — fired after every quote/invoice/data-sheet upload. Downloads the PDF from Storage, sends it to Claude for transcription, writes the result to `document_search_index`. For quotes specifically, also runs a second pass to extract structured `price_line_items` for the Compare Prices view.
- **compare-price-match** — used by the Compare Prices tab to AI-match a search query (e.g. "jasper sealant") against `price_line_items` across all suppliers, with a local JS fallback in the frontend if this call fails.
- **app-help-chat** — powers the in-app support chat bubble. Answers questions about how to use ProSup itself (not a general assistant). **Known issue:** was returning fallback messages instead of real replies; diagnostic logging (console.error/console.log at every failure point) was added and deployed as v2, but never confirmed fixed by the user — check `query_logs` (source `function_logs` / `function_edge_logs`) for this function's recent invocations to see what's actually failing.

All four functions require `ANTHROPIC_API_KEY` set as a Supabase Edge Function secret.

## Known open items (from most recent working session)

- **app-help-chat bug** — see above, not yet confirmed fixed.
- **Migration of legacy embedded data into real Supabase tables/Storage** — scoped but explicitly deferred by the client ("lets maybe hold off for now as i dont see it needing to be done"). Would fix the 9.5MB file size but is a real chunk of work (~650 suppliers × PDFs).
- **Direct file upload to Supabase Storage from a sandboxed tool environment is blocked** — outbound requests to `*.supabase.co` were blocked by network allowlist in the environment this was built in; the Postgres `http` extension was ruled out for binary uploads (only accepts `character varying`, unsafe for PDF bytes); a service-role edge-function workaround was blocked by a safety classifier. This may or may not apply in Claude Code's environment — worth testing directly rather than assuming the same limitation applies.
- **Supabase Auth → "Leaked password protection"** is currently off — recommended to enable, but only available via the Supabase dashboard UI, no MCP/API tool exposes it.
- **Minor RLS performance lints** — `auth_rls_initplan` warnings on `profiles` and `sales_confirmation_files` (low priority, functionally fine).
- **Test account** for QA: `prosup.tester@example.com` — decide whether to keep or delete.

## Deploying

This is a static file — no build step. Whatever hosting is in front of it (Netlify, Vercel, etc.) just needs to serve `index.html` from the repo root. Supabase is entirely decoupled from hosting — the project URL and public/anon key are embedded directly in the HTML, so which host serves the file doesn't affect the backend at all.

Always verify syntax before treating a change as done — extract the 3 inline `<script>` blocks and run each through `new Function(body)` to catch syntax errors before deploying, since a single typo anywhere in this file breaks the entire app.
