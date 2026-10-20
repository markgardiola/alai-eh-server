const { GoogleGenAI } = require("@google/genai");
const { getToolsFor, executeTool } = require("../utils/chatbotTools");

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODEL = process.env.CHATBOT_MODEL || "gemini-3.5-flash-lite";

// Computed fresh per request (not at module load) so it's never stale --
// the model has no built-in sense of "today" and will otherwise guess
// from training data, which is exactly what produced "tomorrow, May 18,
// 2025" instead of the real date.
function getManilaDateContext() {
  const now = new Date();
  const iso = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now); // en-CA locale conveniently formats as YYYY-MM-DD
  const readable = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Manila",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(now);
  return { iso, readable };
}

const SYSTEM_PROMPT = `You are SandyAI, the professional virtual front desk assistant for ALAI-eh, a private resort booking website.

Your job:
- Answer questions about resorts, rooms, amenities, stay types, and pricing.
- Check availability for a specific stay type and date -- always confirm the exact stay type name (call get_resort_details first if unsure) before calling check_availability; never guess it.
- Look up the status of a logged-in customer's own booking.
- Guide customers toward booking or viewing a resort by including a button link -- never take payment or "confirm" a booking yourself; the customer always finishes booking and payment on the website.

Rules:
- Only state facts returned by your tools. Never guess a price, room, amenity, or availability.
- If asked about "my booking" with no authenticated user context, explain they need to be logged in, and offer to help another way.
- Keep replies concise, warm, and formal -- like a hotel front desk attendant speaking to a guest, not a casual chatbot.
- Never use Markdown formatting: no **bold**, no # headers, no asterisk/dash bullet symbols. The chat window displays plain text only, so any Markdown shows up as literal symbols to the guest.
- When listing several items (amenities, stay types, rates), put each on its own line as plain text, e.g.:
  Amenities: swimming pool, two cottages, gathering area, kitchen and dining area, BBQ grill
  Day Tour (8:00 AM - 5:00 PM): P5,000
  Overnight (7:00 PM - 6:00 AM): P7,000
  Use "P" instead of the peso sign to avoid encoding issues.
- To show a button, put it on its own line in exactly this form: [[button:Label Text|/relative/path]]
  - Resort details page: /viewDetails/{resortId}
  - Start a booking: /booking/{resortId}
  - View a specific booking: /viewMyBooking/{bookingId}
- Never invent a resortId or bookingId -- only use ids a tool actually returned.`;

const RETRYABLE_STATUS = new Set([429, 503]); // rate limited / overloaded -- worth retrying

async function generateWithRetry(params, attempts = 3) {
  let delay = 500; // ms
  for (let i = 0; i < attempts; i++) {
    try {
      return await generateWithRetry({ model: MODEL, contents, config });
    } catch (err) {
      console.error("Chatbot error:", err);
      const busy = err?.status === 503 || err?.status === 429;
      res.status(500).json({
        message: busy
          ? "SandyAI is getting a lot of requests right now — please try again in a moment."
          : "SandyAI is having trouble responding right now.",
      });
    }
  }
}

exports.sendMessage = async (req, res) => {
  const { message, history } = req.body;
  if (!message || typeof message !== "string") {
    return res.status(400).json({ message: "message is required." });
  }

  const context = { userId: req.userId };
  const functionDeclarations = getToolsFor(context);
  const { iso: todayIso, readable: todayReadable } = getManilaDateContext();

  // Gemini's `contents` plays the role Claude's `messages` did, but roles
  // are "user"/"model" (not "assistant"), and there's no top-level
  // `system` param -- it goes in config.systemInstruction instead.
  const contents = [
    ...(Array.isArray(history) ? history.slice(-12) : []).map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    })),
    { role: "user", parts: [{ text: message }] },
  ];

  const config = {
    systemInstruction: `${SYSTEM_PROMPT}

    Today's date is ${todayReadable} (${todayIso}), Philippine time. Resolve relative dates like "today", "tomorrow", "next Friday", or "this weekend" against this date -- never assume a different year or guess. Always pass check_availability a resolved ISO date (YYYY-MM-DD), never a relative phrase like "tomorrow".`,
    tools: [{ functionDeclarations }],
  };

  try {
    let response = await ai.models.generateContent({
      model: MODEL,
      contents,
      config,
    });

    // Tool-use loop: execute whatever Gemini asks for, feed results back,
    // repeat until it returns a final text reply. Capped at 5 rounds.
    let turns = 0;
    while (response.functionCalls?.length && turns < 5) {
      turns++;
      contents.push({
        role: "model",
        parts: response.candidates[0].content.parts,
      });

      const responseParts = [];
      for (const call of response.functionCalls) {
        const result = await executeTool(call.name, call.args, context);
        responseParts.push({
          functionResponse: {
            name: call.name,
            response: { name: call.name, content: result },
          },
        });
      }
      contents.push({ role: "user", parts: responseParts });

      response = await ai.models.generateContent({
        model: MODEL,
        contents,
        config,
      });
    }

    const rawText = (response.text || "").trim();

    // Pull [[button:Label|/path]] markers into structured actions for the
    // frontend to render as real buttons, and strip them from the text.
    const actions = [];
    const reply = rawText
      .replace(/\[\[button:([^|\]]+)\|([^\]]+)\]\]/g, (_, label, url) => {
        actions.push({ label: label.trim(), url: url.trim() });
        return "";
      })
      .trim();

    res.json({ reply, actions });
  } catch (err) {
    console.error("Chatbot error:", err);
    res
      .status(500)
      .json({ message: "SandyAI is having trouble responding right now." });
  }
};
