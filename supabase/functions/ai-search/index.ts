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

// Common words that aren't useful as search keywords
const STOPWORDS = new Set([
  "how","much","many","for","the","is","a","an","of","to","in","on","do",
  "does","did","we","us","our","pay","paid","price","prices","priced",
  "pricing","cost","costs","what","whats","was","were","are","and","or",
  "with","from","that","this","have","has","had","been","be","can","could",
  "would","should","will","get","got","give","tell","me","please","show",
  "find","need","want","any","all","there","which","who","about"
]);

function extractKeywords(question: string): string[] {
  const words = question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  return Array.from(new Set(words));
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS });
  }

  try {
    if (!ANTHROPIC_API_KEY) {
      return new Response(
        JSON.stringify({
          answer:
            "The AI assistant isn't switched on yet — it needs an ANTHROPIC_API_KEY secret added to this Supabase project first.",
          matches: [],
        }),
        { headers: { ...CORS, "Content-Type": "application/json" } }
      );
    }

    const body = await req.json().catch(() => ({}));
    const question = (body?.question || "").toString().trim();

    if (!question) {
      return new Response(JSON.stringify({ answer: "Ask me something like \"how much for silicone?\"", matches: [] }), {
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // ---- Who's asking? Decode the caller's email from their JWT so we can
    // decide whether invoice documents are allowed in their context. ----
    let callerEmail = "";
    try {
      const authHeader = req.headers.get("Authorization") || "";
      const jwt = authHeader.replace(/^Bearer\s+/i, "");
      const payloadB64 = jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      const payload = JSON.parse(atob(payloadB64));
      callerEmail = (payload.email || "").toLowerCase();
    } catch {
      callerEmail = "";
    }

    // ---- Retrieval: only pull documents relevant to this question, instead
    // of dumping the entire corpus into every request. This keeps cost and
    // latency roughly constant no matter how many quotes/invoices/data
    // sheets get added over time, and gives the model a smaller, more
    // relevant haystack to answer from. ----
    const keywords = extractKeywords(question);
    const DOC_LIMIT = 60;
    const MAX_CHARS_PER_DOC = 4000; // generous enough that pricing further down a long doc isn't cut off

    async function fetchDocs(): Promise<any[]> {
      if (keywords.length > 0) {
        // Strict pass: a doc must contain EVERY keyword somewhere (AND across
        // keywords, OR across columns per keyword — chaining .or() calls ANDs
        // the OR-groups together). This is what keeps a specific question like
        // "how much for black silicone" from pulling in every other silicone
        // colour just because they all contain the word "silicone".
        let strictQuery = supabase
          .from("document_search_index")
          .select("kind, company, file_name, extracted_text")
          .order("created_at", { ascending: false })
          .limit(DOC_LIMIT);
        for (const k of keywords) {
          strictQuery = strictQuery.or(`extracted_text.ilike.%${k}%,company.ilike.%${k}%,file_name.ilike.%${k}%`);
        }
        const { data: strictData } = await strictQuery;
        if (strictData && strictData.length > 0) return strictData;

        // Loosen only if the strict AND pass found nothing at all — any
        // single keyword match, so a broad/generic question still surfaces
        // multiple options instead of an empty result.
        const orFilter = keywords
          .map((k) => `extracted_text.ilike.%${k}%,company.ilike.%${k}%,file_name.ilike.%${k}%`)
          .join(",");
        const { data } = await supabase
          .from("document_search_index")
          .select("kind, company, file_name, extracted_text")
          .or(orFilter)
          .order("created_at", { ascending: false })
          .limit(DOC_LIMIT);
        if (data && data.length > 0) return data;
      }
      // Fallback: no keywords extracted, or keyword search found nothing —
      // fall back to a capped recent-documents pull rather than either
      // failing outright or sending the whole corpus unbounded.
      const { data } = await supabase
        .from("document_search_index")
        .select("kind, company, file_name, extracted_text")
        .order("created_at", { ascending: false })
        .limit(DOC_LIMIT);
      return data || [];
    }

    // Run the document lookup, supplier lookup, and invoice-access check in
    // parallel instead of one after another — shaves round-trips off every request.
    const [allDocs, suppliersResult, invoiceAccessResult] = await Promise.all([
      fetchDocs(),
      supabase.from("suppliers").select("name, contact, category, phone, email"),
      callerEmail
        ? supabase.from("invoice_access_emails").select("email").ilike("email", callerEmail).maybeSingle()
        : Promise.resolve({ data: null }),
    ]);
    const suppliers = suppliersResult.data;
    const hasInvoiceAccess = !!invoiceAccessResult.data;

    // Invoices carry sensitive cost data restricted to a specific list of
    // people — if the person asking isn't on that list, strip invoice
    // documents out of the context entirely so the assistant literally
    // cannot see or repeat pricing from them, rather than just being asked
    // politely not to.
    const docs = hasInvoiceAccess ? allDocs : allDocs.filter((d) => d.kind !== "invoice");

    const docsContext = docs
      .map((d, i) => {
        const text = (d.extracted_text || "").slice(0, MAX_CHARS_PER_DOC);
        return `[DOC ${i + 1}] kind=${d.kind} company="${d.company}" file="${d.file_name}"\n${text}`;
      })
      .join("\n\n---\n\n");

    const suppliersContext = (suppliers || [])
      .map((s) => `${s.name} | ${s.category} | ${s.contact || ""} | ${s.phone || ""} | ${s.email || ""}`)
      .join("\n");

    const systemPrompt = `You are the AI assistant embedded in ProSup, Proline Group's internal supplier directory. Project managers ask you quick questions on site — most often about pricing, but also invoice numbers, reference/PO numbers, dates, quantities, payment terms, and other details found on quotes, invoices, and data sheets.

Answer ONLY using the DOCUMENTS and SUPPLIER LIST below — never guess or invent a price, number, or date. The DOCUMENTS below have already been pre-filtered to the ones most likely relevant to this question, out of a larger archive.

CRITICAL: When you find the answer — whether it's a price, an invoice/reference number, a date, a quantity, or any other specific detail — state it directly and exactly in your answer sentence (e.g. "Black silicone from Soudal is $14.20 per tube, ex GST" or "That invoice's reference number is 00476161, dated 12-Jun-2026"). Never just tell the user to go check a document or a section of the app instead of answering — the written answer must already contain the concrete information. This app never opens or displays the source PDF from this assistant — your written answer is the only place the user will ever see the information, so it must be complete on its own.

SPECIFIC vs BROAD questions: if the question names a specific variant, colour, size, or type (e.g. "black silicone"), answer and list matches for ONLY that specific item — do not mention or include other variants of the same product (e.g. don't bring up Jasper or Midnight when asked about black) unless the user asked broadly (e.g. "how much for silicone?"). For a broad question, list each distinct option you found clearly inside the "answer" text itself, so the user can see the choices and ask a tighter follow-up.

NEVER include banking details, account numbers, BSB numbers, IBAN/SWIFT codes, or any other payment-account information in your answer, even if they appear in a document — pricing, reference numbers, dates and quantities are fine to state, financial account details are not.

The "matches" you return are the specific items your answer is about — the app uses them to offer one-tap follow-up questions for a more precise price, not to open the source document.

If truly nothing relevant is found in the documents below, say so plainly and suggest checking the Quotes or Data Sheets section directly.

Respond with ONLY a JSON object, no other text, in this exact shape:
{"answer": "<a short, direct, spoken-style answer, citing specific prices and companies>", "matches": [{"company": "...", "file_name": "...", "kind": "quote|invoice|datasheet"}]}

If nothing matches, return {"answer": "...", "matches": []}.

SUPPLIER LIST (name | category | contact | phone | email):
${suppliersContext}

DOCUMENTS:
${docsContext}`;

    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1200,
        system: systemPrompt,
        messages: [{ role: "user", content: question }],
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return new Response(
        JSON.stringify({ answer: "The AI request failed: " + errText, matches: [] }),
        { headers: { ...CORS, "Content-Type": "application/json" } }
      );
    }

    const data = await resp.json();
    const rawText = data?.content?.[0]?.text || "";

    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      parsed = { answer: rawText, matches: [] };
    }

    // Fire-and-forget usage log for the admin analytics page — never let a
    // logging failure affect the actual answer sent back to the user.
    supabase
      .from("ai_query_log")
      .insert({
        question,
        asked_by: callerEmail || null,
        answer_preview: (parsed?.answer || "").toString().slice(0, 300),
        match_count: Array.isArray(parsed?.matches) ? parsed.matches.length : 0,
      })
      .then(() => {})
      .catch(() => {});

    return new Response(JSON.stringify(parsed), {
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ answer: "Something went wrong: " + String(e), matches: [] }), {
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
