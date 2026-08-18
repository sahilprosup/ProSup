import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function bufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS });
  }

  try {
    const { bucket, path, company, file_name, kind } = await req.json();

    if (!bucket || !path || !company || !file_name || !kind) {
      return new Response(JSON.stringify({ error: "Missing required fields." }), {
        status: 400,
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    if (!ANTHROPIC_API_KEY) {
      // Not configured yet — quietly no-op so uploads still succeed.
      return new Response(JSON.stringify({ skipped: true, reason: "No ANTHROPIC_API_KEY set." }), {
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const { data: fileBlob, error: dlError } = await supabase.storage.from(bucket).download(path);
    if (dlError || !fileBlob) {
      return new Response(JSON.stringify({ error: "Could not download file: " + (dlError?.message || "unknown") }), {
        status: 200,
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    const arrayBuffer = await fileBlob.arrayBuffer();
    const base64Pdf = bufferToBase64(arrayBuffer);

    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 4096,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "document",
                source: { type: "base64", media_type: "application/pdf", data: base64Pdf },
              },
              {
                type: "text",
                text: "Transcribe all readable text from this document as plain text. Pay special attention to item descriptions, quantities, unit prices, totals, dates, and company names — preserve numbers exactly as shown. No commentary, just the transcribed content.",
              },
            ],
          },
        ],
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return new Response(JSON.stringify({ error: "AI extraction failed: " + errText }), {
        status: 200,
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    const data = await resp.json();
    const extractedText = data?.content?.[0]?.text || "";

    const { error: insertError } = await supabase.from("document_search_index").insert({
      kind,
      company,
      file_name,
      extracted_text: extractedText,
    });

    if (insertError) {
      return new Response(JSON.stringify({ error: insertError.message }), {
        status: 200,
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    // ---- Price comparison view support: for quotes specifically, pull out
    // structured (item, price, unit) line items so different suppliers'
    // prices for the same material can be compared side by side, instead of
    // only being searchable as free text. Non-fatal if this part fails —
    // the quote itself is already uploaded and searchable either way. ----
    let priceLinesExtracted = 0;
    if (kind === "quote") {
      try {
        const linePrompt = `Extract every distinct priced product or material line item from this quote text. Ignore freight, delivery, GST, subtotal and total lines. For each real item return: item (a short, clean product description), price (the unit price as a plain number with no currency symbol or commas), unit (e.g. "per m2", "per tube", "per length", "per coil", "per pack", "each" — infer the most sensible unit from context), and date (the quote date shown in the document, in the same format it appears, or "" if none is shown).

Respond with ONLY a JSON array, no other text, in this exact shape:
[{"item": "...", "price": "...", "unit": "...", "date": "..."}]

If nothing qualifies, return [].

QUOTE TEXT:
${extractedText}`;

        const priceResp = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 800,
            messages: [{ role: "user", content: linePrompt }],
          }),
        });

        if (priceResp.ok) {
          const priceData = await priceResp.json();
          const rawLines = priceData?.content?.[0]?.text || "[]";
          let lines: any[] = [];
          try {
            lines = JSON.parse(rawLines);
          } catch {
            lines = [];
          }

          if (Array.isArray(lines) && lines.length > 0) {
            const rows = lines
              .filter((l) => l && l.item && l.price)
              .map((l) => ({
                company,
                item: String(l.item).slice(0, 300),
                price: String(l.price).replace(/[^0-9.]/g, ""),
                unit: (l.unit || "").toString().slice(0, 50),
                date: (l.date || "").toString().slice(0, 30),
                source_file_name: file_name,
              }))
              .filter((r) => r.price.length > 0);

            if (rows.length > 0) {
              await supabase.from("price_line_items").insert(rows);
              priceLinesExtracted = rows.length;
            }
          }
        }
      } catch {
        // Price-line extraction is a bonus feature — swallow errors here so a
        // hiccup in this step never affects the main text-extraction result.
      }
    }

    return new Response(JSON.stringify({ success: true, text_length: extractedText.length, price_lines_extracted: priceLinesExtracted }), {
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 200,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
