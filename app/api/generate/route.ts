import { NextResponse } from "next/server";
import { createOpenAIOAuth } from "@openai-oauth/ai-sdk";
import { openaiCredentials } from "@openai-oauth/web/server";
import { openaiCredentials as localCredentials } from "@openai-oauth/local";
import { generateText, generateImage } from "ai";

type Concept = {
  reaction: string;
  caption: string;
  emoji: string;
  tone: string;
  format: string;
  socialUse: string;
};

const TONES = [
  "yellow", "lavender", "mint", "peach", "blue", "pink",
  "cream", "gray", "green", "orange", "cyan", "rose",
];

const FALLBACK_CONCEPTS: Concept[] = [
  { reaction: "deadpan disbelief", caption: "bhai kya chal raha", emoji: "😑", tone: "yellow", format: "reaction+caption", socialUse: "disbelief" },
  { reaction: "laughter roast", caption: "GG WP", emoji: "💀", tone: "lavender", format: "reaction", socialUse: "roast" },
  { reaction: "suspicious side-eye", caption: "hmm interesting", emoji: "🤨", tone: "mint", format: "reaction+caption", socialUse: "suspicion" },
  { reaction: "hyped celebration", caption: "LET HIM COOK", emoji: "🔥", tone: "peach", format: "reaction", socialUse: "celebration" },
  { reaction: "defeated exhaustion", caption: "it's over", emoji: "😭", tone: "blue", format: "reaction+caption", socialUse: "exhaustion" },
  { reaction: "fake confidence", caption: "say less", emoji: "😎", tone: "pink", format: "reaction", socialUse: "confidence" },
  { reaction: "awkward silence", caption: "......", emoji: "🫠", tone: "cream", format: "emoji", socialUse: "awkward" },
  { reaction: "absolute rejection", caption: "absolutely not", emoji: "🗿", tone: "gray", format: "reaction+caption", socialUse: "rejection" },
  { reaction: "panicked realization", caption: "wait what", emoji: "😱", tone: "green", format: "chat-bubble", socialUse: "panic" },
  { reaction: "overthinking confusion", caption: "i don't get it", emoji: "🤯", tone: "orange", format: "reaction+caption", socialUse: "confusion" },
  { reaction: "smug i-told-you", caption: "told you so", emoji: "😏", tone: "cyan", format: "chat-bubble", socialUse: "smug" },
  { reaction: "done moving on", caption: "we move", emoji: "🥲", tone: "rose", format: "reaction", socialUse: "acceptance" },
];

function pickTone(i: number): string {
  return TONES[i % TONES.length];
}

function parseConcepts(raw: string, count: number): Concept[] {
  try {
    const cleaned = raw
      .replace(/^```(?:json)?/i, "")
      .replace(/```$/i, "")
      .trim();
    const parsed = JSON.parse(cleaned);
    const arr = Array.isArray(parsed) ? parsed : parsed.concepts ?? parsed.stickers;
    if (Array.isArray(arr) && arr.length) {
      return arr.slice(0, count).map((c: Partial<Concept>, i: number) => ({
        reaction: String(c.reaction ?? "reaction"),
        caption: String(c.caption ?? ""),
        emoji: String(c.emoji ?? "😂"),
        tone: String(c.tone ?? pickTone(i)),
        format: String(c.format ?? "reaction+caption"),
        socialUse: String(c.socialUse ?? ""),
      }));
    }
  } catch {
    // fall through
  }
  return FALLBACK_CONCEPTS.slice(0, count);
}

function buildConceptPrompt(prompt: string, mood: string, count: number, hasImages: boolean): string {
  const sourceNote = hasImages
    ? "The user supplied SOURCE PHOTOS / SCREENSHOTS. Preserve the distinctive person, pose, expression, object, or UI fragment from those images as the subject. Build meme concepts around the supplied source material; keep the source recognizable."
    : "No source photos supplied — invent original reaction concepts.";

  return `You are a meme-sticker art director. Design a reaction-first sticker vocabulary (NOT uniform artwork). ${sourceNote}

Theme the user described: "${prompt}".
Mood: ${mood}.

Return a JSON array of exactly ${count} objects, one per sticker, following this shape:
{ "reaction": string, "caption": string, "emoji": string, "tone": string, "format": string, "socialUse": string }

Rules:
- reaction = the facial/body reaction primitive (e.g. "deadpan disbelief", "laughter roast", "suspicious side-eye").
- caption = 1-4 words of chat-native text (Hinglish/English mix ok, lowercase ok). Empty string allowed for pure-reaction stickers.
- emoji = a single fitting emoji.
- tone = one of: ${TONES.join(", ")}.
- format = one of: "reaction", "reaction+caption", "chat-bubble", "emoji", "absurd".
- socialUse = the chat situation it replies to (e.g. "disbelief", "roast", "approval").
- Cover a broad emotional range: normal -> confused -> suspicious -> disbelief -> roast -> rejection -> defeat -> absurd finisher.
- Do NOT repeat the same formula. Vary crops, captions, and formats.
- Output ONLY the JSON array, no markdown fences.`;
}

function buildImagePrompt(concept: Concept, prompt: string, mood: string, hasImages: boolean): string {
  const subject = hasImages
    ? "Use the supplied source image(s) as the subject. Preserve the recognizable person/object/pose and its distinctive reaction. Remove irrelevant background, keep transparent margins tight."
    : "Illustrate an original internet-native reaction character with candid phone-camera energy.";

  const captionLine = concept.caption
    ? `Add a compact, readable caption "${concept.caption}" in white/off-white bold text with a subtle dark outline, placed at the lower torso or in a small bubble — never covering the face or key gesture.`
    : "No caption text unless naturally part of the reaction.";

  return `Create ONE die-cut meme sticker. ${subject}
Reaction: ${concept.reaction}. Mood: ${mood}. Theme: ${prompt}.
Style: messy-but-intentional, internet-native, compact, expressive, slightly chaotic — like a real friend-group sticker tray, not advertising art. Intentional rough edges are good; rectangular background remnants are bad.
${captionLine}
Transparent background, thick white sticker outline, no watermark, no logos. Make the silhouette readable at thumbnail size.`;
}

export async function POST(request: Request) {
  let credentials;
  try {
    credentials = openaiCredentials(request);
  } catch {
    credentials = localCredentials();
  }

  const openai = createOpenAIOAuth(credentials);

  try {
    const body = await request.json().catch(() => ({}));
    const mode: "single" | "pack" = body.mode === "pack" ? "pack" : "single";
    const prompt = String(body.prompt || "chaotic reaction stickers");
    const mood = String(body.mood || "Unhinged");
    const count = mode === "single" ? 1 : Math.min(Math.max(Number(body.count) || 12, 1), 30);
    const images: string[] = Array.isArray(body.images) ? body.images.filter((x: unknown) => typeof x === "string") : [];
    const hasImages = images.length > 0;

    // --- Single-image edit (re-prompt a specific sticker) ---
    if (body.edit && typeof body.edit.image === "string" && typeof body.edit.instruction === "string") {
      const editResult = await generateImage({
        model: openai.image("gpt-image-2"),
        prompt: {
          text: `Edit this sticker. ${body.edit.instruction}. Preserve the subject and transparent background. Keep it die-cut meme style, no watermark, no logo.`,
          images: [body.edit.image],
        },
        n: 1,
        size: "1024x1024",
        providerOptions: { openai: { background: "transparent" } },
      });
      const first = editResult.images?.[0];
      const image = first ? `data:${first.mediaType};base64,${first.base64}` : undefined;
      return NextResponse.json({ mode: "edit", authenticated: true, stickers: [{ id: 0, image }] });
    }

    // --- Design the reaction vocabulary (skill-aligned) ---
    let concepts: Concept[];
    if (mode === "single") {
      concepts = [{
        reaction: "single custom reaction",
        caption: String(body.caption ?? ""),
        emoji: "😂",
        tone: pickTone(0),
        format: body.caption ? "reaction+caption" : "reaction",
        socialUse: "",
      }];
    } else {
      const conceptResult = await generateText({
        model: openai("gpt-5.4-mini"),
        prompt: buildConceptPrompt(prompt, mood, count, hasImages),
      });
      concepts = parseConcepts(conceptResult.text, count);
    }

    const direction = concepts.map((c) => c.caption || c.reaction).filter(Boolean).join(" · ");

    const stickers = await Promise.all(
      concepts.map(async (concept, i) => {
        const imageResult = await generateImage({
          model: openai.image("gpt-image-2"),
          prompt: hasImages
            ? {
                text: buildImagePrompt(concept, prompt, mood, hasImages),
                images,
              }
            : buildImagePrompt(concept, prompt, mood, hasImages),
          n: 1,
          size: "1024x1024",
          providerOptions: { openai: { background: "transparent" } },
        });
        const first = imageResult.images?.[0];
        const image = first ? `data:${first.mediaType};base64,${first.base64}` : undefined;
        return {
          id: i,
          image,
          emoji: concept.emoji,
          text: concept.caption,
          tone: concept.tone,
          reaction: concept.reaction,
        };
      }),
    );

    return NextResponse.json({
      mode,
      authenticated: true,
      direction,
      stickers,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown generation error";
    const isAuthOrQuotaError =
      message.includes("OpenAI OAuth") ||
      message.includes("access token not found") ||
      message.includes("sign in") ||
      message.includes("401") ||
      message.includes("403") ||
      message.toLowerCase().includes("unauthorized") ||
      message.toLowerCase().includes("authentication") ||
      message.toLowerCase().includes("rate limit") ||
      message.toLowerCase().includes("quota") ||
      message.toLowerCase().includes("billing");

    return NextResponse.json(
      {
        error: isAuthOrQuotaError
          ? "ChatGPT OAuth is not connected or the account hit a limit."
          : "Sticker generation failed.",
        detail: message,
        hint: isAuthOrQuotaError
          ? "Sign in with ChatGPT in the browser, or run `npx openai-oauth login` locally."
          : "Please try the generation again.",
      },
      { status: isAuthOrQuotaError ? 401 : 500 },
    );
  }
}
