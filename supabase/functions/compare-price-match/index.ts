import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS });
  }

  try {
    const { query, items } = await req.json();

    if (!query || !Array.isArray(items) || items.length === 0) {
      return new Response(JSON.stringify({ ids: [] }), {
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    if (!ANTHROPIC_API_KEY) {
      // Not configured — signal the caller to fall back to local matching
      // rather than silently returning an empty (wrong-looking) result.
      return new Response(JSON.stringify({ ids: null, reason: "No ANTHROPIC_API_KEY set." }), {
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    // Keep the prompt small and cheap regardless of how many quotes have
    // been added over time — cap the candidate list and trim each
    // description, so this scales as the catalog grows instead of the
    // prompt (and cost) growing unbounded with it.
    const MAX_ITEMS = 400;
    const capped = items.slice(0, MAX_ITEMS);
    const itemsList = capped
      .map((it: any) => `${it.id}: ${(it.item || "").slice(0, 160)} (${(it.company || "").slice(0, 60)})`)
      .join("\n");

    const prompt = `A tradesperson is comparing supplier prices and searched for: "${query}"

Below is a numbered list of priced product line items on file (id: description (supplier)). Decide which ones are genuine matches for what they're looking for.

Rules:
- Match on product/material type first — the item must be the same kind of thing the person is asking about, not just something that shares a word with the query.
- If the query names a specific colour, finish, size, gauge, or other variant (e.g. "jasper", "black", "0.55", "10mm"), only include items that are that exact variant. Exclude items of the right product type but a different colour/variant.
- If the query is generic (no colour/variant specified, e.g. just a product name), include every item of that product type regardless of colour/variant, across all suppliers — the point is to compare prices across suppliers for the same thing.
- Different suppliers may describe the same product slightly differently (brand names, abbreviations, capitalisation) — match on meaning, not exact wording.

Items:
${itemsList}

Respond with ONLY a JSON array of the matching ids as strings, e.g. ["id1","id2"]. If nothing matches, return [].`;

    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1500,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return new Response(JSON.stringify({ ids: null, reason: "AI match failed: " + errText }), {
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    const data = await resp.json();
    const rawText = data?.content?.[0]?.text || "[]";
    let ids: string[] = [];
    try {
      const parsed = JSON.parse(rawText);
      if (Array.isArray(parsed)) ids = parsed.map(String);
    } catch {
      ids = [];
    }

    return new Response(JSON.stringify({ ids }), {
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ids: null, reason: String(e) }), {
      status: 200,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
