const express = require("express");
const path = require("path");
const GUIDES = require("./guides.json");

const app = express();
app.use(express.json());

function scoreGuide(g, prefs) {
  const interests = prefs.interests || [];
  const hit = g.tags.filter((t) => interests.includes(t));
  const cap = { "2000": 2000, "4000": 2500, "7000": 4000 }[prefs.budget] || 2500;
  let sc = hit.length * 3 + (g.rate <= cap ? 2 : -2) + (g.yrs >= 10 ? 0.5 : 0);
  if (g.id === prefs.focus) sc += 5;
  return sc;
}

app.post("/api/match", async (req, res) => {
  try {
    const prefs = req.body || {};
    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ error: "GEMINI_API_KEY not set on server" });
    }

    const candidates = GUIDES.filter((g) => g.state === prefs.state)
      .map((g) => ({ g, sc: scoreGuide(g, prefs) }))
      .sort((a, b) => b.sc - a.sc)
      .slice(0, 3)
      .map((x) => x.g);

    if (!candidates.length) {
      return res.status(404).json({ error: "no guides found for this state" });
    }

    const days = Math.max(1, Math.min(6, parseInt(prefs.days, 10) || 3));

    const prompt = `You are matching a traveler to the best local guide in India and writing a ${days}-day itinerary.

Traveler preferences:
- interests: ${(prefs.interests || []).join(", ") || "none specified"}
- budget tier: ${prefs.budget || "4000"}
- pace: ${prefs.pace || "Balanced"}
- trip vibe: ${prefs.vibe || "none"}
- days: ${days}

Candidate guides (choose exactly one guideId from this list):
${JSON.stringify(
  candidates.map((g) => ({
    id: g.id,
    name: g.name,
    place: g.place,
    tags: g.tags,
    stops: g.stops,
    rate: g.rate,
    yrs: g.yrs,
  })),
  null,
  2
)}

Pick the single best guideId for this traveler from the candidates above. Then write a ${days}-day itinerary using that guide's own "stops" as the raw material — adapt and sequence them to match the requested pace, do not invent unrelated activities outside the guide's actual stops/specialty.

Respond with ONLY valid JSON (no markdown fences, no extra text), in exactly this shape:
{"guideId":"<one of the candidate ids>","headline":"Meet <FirstName> in <Place>","why":"<1-2 sentence reason tied to the traveler's chosen interests>","days":[{"title":"<short day title>","morning":"<text>","afternoon":"<text>","evening":"<text>"}]}`;

    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: "application/json" },
        }),
      }
    );

    if (!r.ok) {
      const errText = await r.text();
      console.error("Gemini API error:", r.status, errText);
      return res.status(502).json({ error: "AI provider error" });
    }

    const data = await r.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return res.status(502).json({ error: "empty AI response" });

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      return res.status(502).json({ error: "AI returned invalid JSON" });
    }

    const validIds = candidates.map((c) => c.id);
    if (!validIds.includes(parsed.guideId)) {
      parsed.guideId = candidates[0].id;
    }
    if (!Array.isArray(parsed.days) || !parsed.days.length) {
      return res.status(502).json({ error: "AI returned no itinerary days" });
    }

    res.json(parsed);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "match failed" });
  }
});

// serve the frontend (index.html and any other static files in this folder)
app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Banjara server listening on " + PORT));
