"use client";

import { ChangeEvent, useCallback, useMemo, useRef, useState } from "react";
import { openaiAuthHeaders, useSignInWithChatGPT } from "@openai-oauth/react";
import MemeCanvas, { MemeCanvasHandle, TextLayer } from "./meme-canvas";

const moods = [
  ["😂", "Unhinged"],
  ["😭", "Crying"],
  ["💀", "Dead"],
  ["🤨", "Suspicious"],
  ["🔥", "Hyped"],
  ["😎", "Cool"],
];

type Sticker = {
  id: number;
  image?: string;
  emoji?: string;
  text?: string;
  tone?: string;
  reaction?: string;
  exact?: boolean;
};

type PendingGeneration = {
  prompt: string;
  mood: string;
  count: number;
  mode: "single" | "pack";
  caption?: string;
  images?: string[];
};

const PENDING_GENERATION_KEY = "stikky:pending-generation";

// Downscale + re-encode to keep request payloads under Vercel's body limit (413).
async function prepareImage(src: string, maxDim = 768): Promise<string> {
  const img = await loadImage(src);
  const w = img.naturalWidth || 0;
  const h = img.naturalHeight || 0;
  if (!w || !h) return src;
  const scale = Math.min(1, maxDim / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * scale));
  const ch = Math.max(1, Math.round(h * scale));
  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d");
  if (!ctx) return src;
  ctx.drawImage(img, 0, 0, cw, ch);
  return canvas.toDataURL("image/jpeg", 0.75);
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

export default function Home() {
  const inputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<MemeCanvasHandle>(null);
  const layerIdRef = useRef(0);
  const [images, setImages] = useState<string[]>([]);
  const [imageNames, setImageNames] = useState<string[]>([]);
  const [prompt, setPrompt] = useState("Make a chaotic school friend-group reaction pack");
  const [caption, setCaption] = useState("");
  const [mode, setMode] = useState<"single" | "pack">("pack");
  const [count, setCount] = useState(12);
  const [selectedMood, setSelectedMood] = useState("Unhinged");
  const [stickers, setStickers] = useState<Sticker[]>([]);
  const [generating, setGenerating] = useState(false);
  const [generated, setGenerated] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [exportFormat, setExportFormat] = useState<"png" | "jpg" | "webp-whatsapp">("png");

  // editing modal
  const [editing, setEditing] = useState<Sticker | null>(null);
  const [editLayers, setEditLayers] = useState<TextLayer[]>([]);
  const [editInstruction, setEditInstruction] = useState("");
  const [editBusy, setEditBusy] = useState(false);

  const displayStickers = useMemo<Sticker[]>(
    () => (stickers.length ? stickers : []),
    [stickers],
  );

  const pendingGeneration = useCallback((): PendingGeneration | null => {
    try {
      const raw = window.sessionStorage.getItem(PENDING_GENERATION_KEY);
      return raw ? (JSON.parse(raw) as PendingGeneration) : null;
    } catch {
      return null;
    }
  }, []);

  const clearPendingGeneration = useCallback(() => {
    window.sessionStorage.removeItem(PENDING_GENERATION_KEY);
  }, []);

  const savePendingGeneration = useCallback((request: PendingGeneration) => {
    window.sessionStorage.setItem(PENDING_GENERATION_KEY, JSON.stringify(request));
  }, []);

  const readFiles = useCallback((fileList: FileList | null) => {
    if (!fileList) return;
    const files = Array.from(fileList).filter((f) => f.type.startsWith("image/"));
    files.forEach((file) => {
      const reader = new FileReader();
      reader.onload = async () => {
        const prepared = await prepareImage(String(reader.result));
        setImages((prev) => [...prev, prepared]);
        setImageNames((prev) => [...prev, file.name]);
      };
      reader.readAsDataURL(file);
    });
  }, []);

  const generateAuthenticatedPack = useCallback(async (request: PendingGeneration) => {
    setGenerating(true);
    setGenerated(false);
    setAuthError(null);

    const estimated = JSON.stringify(request).length;
    if (estimated > 4_000_000) {
      setGenerating(false);
      setAuthError("Images are too large to send (over 4 MB). Remove a few reference images and try again.");
      return;
    }

    try {
      const response = await fetch("/api/generate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(await openaiAuthHeaders()),
        },
        body: JSON.stringify(request),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(data.detail || data.error || "Generation failed.");
        Object.assign(error, { status: response.status });
        throw error;
      }

      const incoming: Sticker[] = (data.stickers ?? []).map((s: Sticker, i: number) => ({
        id: i,
        image: s.image,
        emoji: s.emoji,
        text: s.text,
        tone: s.tone,
        reaction: s.reaction,
      }));
      setStickers(incoming);
      setGenerated(true);
      clearPendingGeneration();
      return true;
    } catch (error) {
      if (error instanceof Error && "status" in error && error.status === 401) {
        savePendingGeneration(request);
        setAuthError("Your ChatGPT session needs to be reconnected. Sign in again and Stikky will retry this pack automatically.");
        return false;
      }
      if (error instanceof Error && error.message === "OpenAI OAuth session not found.") {
        savePendingGeneration(request);
        setAuthError("Sign in with ChatGPT to generate your sticker pack.");
        return false;
      }
      setAuthError(error instanceof Error ? error.message : "Generation failed. Please try again.");
      return false;
    } finally {
      setGenerating(false);
    }
  }, [clearPendingGeneration, savePendingGeneration]);

  const auth = useSignInWithChatGPT({
    openMode: "redirect",
    onSuccess: () => {
      setAuthError(null);
      const pending = pendingGeneration();
      if (pending) void generateAuthenticatedPack(pending);
    },
    onError: (error) => {
      setAuthError(error.message);
      setGenerating(false);
    },
  });

  function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    readFiles(event.target.files);
    event.target.value = "";
  }

  function onDrop(event: React.DragEvent) {
    event.preventDefault();
    setDragOver(false);
    readFiles(event.dataTransfer.files);
  }

  function removeImage(idx: number) {
    setImages((prev) => prev.filter((_, i) => i !== idx));
    setImageNames((prev) => prev.filter((_, i) => i !== idx));
  }

  async function addExactSticker(idx: number) {
    const prepared = await prepareImage(images[idx]);
    setStickers((prev) => [
      ...prev,
      { id: Date.now(), image: prepared, exact: true, tone: "cream" },
    ]);
    setGenerated(true);
  }

  async function generatePack() {
    const request: PendingGeneration = {
      prompt,
      mood: selectedMood,
      count,
      mode,
      caption: mode === "single" ? caption : undefined,
      images: images.length ? images : undefined,
    };
    setAuthError(null);

    if (auth.status === "needs-extension") {
      setAuthError("Install the “Sign in with ChatGPT” browser extension, then click Sign in.");
      return;
    }

    if (!auth.isSignedIn) {
      savePendingGeneration(request);
      setGenerating(true);
      setAuthError("Opening ChatGPT sign-in…");
      await auth.login();
      setGenerating(false);
      return;
    }

    await generateAuthenticatedPack(request);
  }

  function openEditor(sticker: Sticker) {
    setEditing(sticker);
    setEditInstruction("");
    setEditLayers(
      sticker.text
        ? [{ id: ++layerIdRef.current, text: sticker.text, x: 0.5, y: 0.82, size: 64, color: "#ffffff", bold: true, stroke: true }]
        : [],
    );
  }

  function closeEditor() {
    setEditing(null);
  }

  async function regenerateFromPrompt() {
    if (!editing?.image) return;
    setEditBusy(true);
    try {
      const editImage = await prepareImage(editing.image);
      const response = await fetch("/api/generate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(await openaiAuthHeaders()),
        },
        body: JSON.stringify({ edit: { image: editImage, instruction: editInstruction } }),
      });
      const data = await response.json().catch(() => ({}));
      const newImage = data.stickers?.[0]?.image;
      if (newImage && editing) {
        setStickers((prev) => prev.map((s) => (s.id === editing.id ? { ...s, image: newImage } : s)));
        setEditing((prev) => (prev ? { ...prev, image: newImage } : prev));
      }
    } catch {
      setAuthError("Edit failed. Try again.");
    } finally {
      setEditBusy(false);
    }
  }

  function saveCanvasEdits() {
    if (!editing || !canvasRef.current) return;
    const url = canvasRef.current.exportDataUrl();
    setStickers((prev) => prev.map((s) => (s.id === editing.id ? { ...s, image: url } : s)));
    closeEditor();
  }

  function slugify(text?: string, emoji?: string): string {
    const base = (text || emoji || "sticker").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return base.slice(0, 28) || "sticker";
  }

  async function stickerToDataUrl(src: string, format: "png" | "jpg" | "webp-whatsapp"): Promise<{ url: string; ext: string }> {
    const img = await loadImage(src);
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return { url: src, ext: "png" };
    if (format === "webp-whatsapp") {
      canvas.width = 512;
      canvas.height = 512;
      const scale = Math.min(512 / img.naturalWidth, 512 / img.naturalHeight);
      const w = img.naturalWidth * scale;
      const h = img.naturalHeight * scale;
      ctx.drawImage(img, (512 - w) / 2, (512 - h) / 2, w, h);
    } else {
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      if (format === "jpg") {
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      ctx.drawImage(img, 0, 0);
    }
    const mime = format === "jpg" ? "image/jpeg" : format === "webp-whatsapp" ? "image/webp" : "image/png";
    const ext = format === "jpg" ? "jpg" : format === "webp-whatsapp" ? "webp" : "png";
    return { url: canvas.toDataURL(mime, 0.92), ext };
  }

  function triggerDownload(url: string, filename: string) {
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  async function exportOne(sticker: Sticker, index: number) {
    if (!sticker.image) return;
    const { url, ext } = await stickerToDataUrl(sticker.image, exportFormat);
    triggerDownload(url, `sticker-${String(index + 1).padStart(2, "0")}-${slugify(sticker.text, sticker.emoji)}.${ext}`);
  }

  async function exportAll() {
    for (let i = 0; i < displayStickers.length; i++) {
      const s = displayStickers[i];
      if (!s.image) continue;
      const { url, ext } = await stickerToDataUrl(s.image, exportFormat);
      triggerDownload(url, `sticker-${String(i + 1).padStart(2, "0")}-${slugify(s.text, s.emoji)}.${ext}`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  return (
    <main className="min-h-screen overflow-hidden bg-[#f7f4ee] text-[#171717]">
      <div className="grain" />
      <nav className="mx-auto flex max-w-[1420px] items-center justify-between px-6 py-5 lg:px-10">
        <div className="flex items-center gap-3">
          <div className="logo-mark">✦</div>
          <span className="font-display text-xl font-bold tracking-tight">stikky</span>
          <span className="hidden rounded-full border border-black/10 bg-white/60 px-2.5 py-1 text-[10px] font-bold uppercase tracking-[.18em] text-black/50 sm:inline-flex">AI sticker lab</span>
        </div>
        <div className="flex items-center gap-2">
          <button className="nav-pill">⌘ K <span className="hidden sm:inline">Shortcuts</span></button>
          {auth.status === "needs-extension" && auth.installUrl ? (
            <a href={auth.installUrl} target="_blank" rel="noreferrer" className="nav-pill strong">
              Install ChatGPT extension <span>↗</span>
            </a>
          ) : (
            <button
              className="nav-pill strong"
              onClick={() => void (auth.isSignedIn ? auth.logout() : auth.login())}
              disabled={auth.status === "starting" || auth.status === "redirecting"}
            >
              {auth.status === "redirecting" ? "Signing in…" : auth.isSignedIn ? "Connected to ChatGPT" : "Sign in with ChatGPT"}{" "}
              <span>↗</span>
            </button>
          )}
        </div>
      </nav>

      <section className="mx-auto max-w-[1420px] px-6 pb-12 pt-7 lg:px-10 lg:pt-14">
        <div className="grid gap-8 lg:grid-cols-[1.03fr_.97fr] lg:items-end">
          <div>
            <div className="eyebrow"><span className="live-dot" /> BULK MEME ENGINE · 01</div>
            <h1 className="font-display mt-5 max-w-4xl text-[clamp(4rem,9vw,8.7rem)] font-black leading-[.82] tracking-[-.075em]">
              Make it<br /><span className="headline-accent">stick.</span>
            </h1>
            <p className="mt-7 max-w-xl text-lg leading-7 text-black/55 md:text-xl">
              Turn photos, screenshots, or an idea into reaction-first meme stickers. Drop references, generate a pack, then tweak any sticker by re-prompting or editing text on the canvas.
            </p>
          </div>
          <div className="relative hidden min-h-[270px] lg:block">
            <div className="floating-sticker one">NO WAY 😭</div>
            <div className="floating-sticker two">BRO 💀</div>
            <div className="floating-sticker three">LET HIM COOK 🔥</div>
            <div className="orbit" />
          </div>
        </div>

        <div className="mt-12 grid gap-5 lg:grid-cols-[.9fr_1.1fr]">
          <section className="panel upload-panel">
            <div className="panel-head"><span>01 / SOURCE</span><span>{images.length ? `${images.length} loaded` : "OPTIONAL"}</span></div>
            <input ref={inputRef} type="file" accept="image/*" multiple className="hidden" onChange={onFileChange} />
            <button
              onClick={() => inputRef.current?.click()}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
              className={`upload-zone group ${dragOver ? "drag-over" : ""}`}
            >
              <div className="upload-icon">↥</div>
              <div className="mt-4 font-display text-2xl font-bold">Drop references here</div>
              <div className="mt-2 text-sm text-black/40">PNG, JPG, WEBP · multiple allowed · or just describe it</div>
              <span className="upload-hover">CHOOSE IMAGES</span>
            </button>
            {images.length ? (
              <div className="reference-tray">
                {images.map((src, i) => (
                  <div className="reference-thumb" key={i}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={src} alt={imageNames[i] ?? `ref ${i}`} />
                    <button className="ref-add" title="Add as exact sticker" onClick={() => addExactSticker(i)}>＋</button>
                    <button className="ref-remove" title="Remove" onClick={() => removeImage(i)}>×</button>
                    <span className="ref-name">{imageNames[i] ?? `ref ${i + 1}`}</span>
                  </div>
                ))}
              </div>
            ) : null}
            {images.length ? (
              <p className="ref-note">References are used as subjects for generation. Click ＋ to drop an exact copy into your pack for manual text editing.</p>
            ) : null}
          </section>

          <section className="panel prompt-panel">
            <div className="panel-head"><span>02 / DIRECTOR</span><span>AI READY</span></div>
            <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} className="prompt-input" spellCheck={false} />
            <div className="mode-row">
              <button className={`mode ${mode === "pack" ? "active" : ""}`} onClick={() => setMode("pack")}>📦 Pack</button>
              <button className={`mode ${mode === "single" ? "active" : ""}`} onClick={() => setMode("single")}>🎯 Single</button>
            </div>
            {mode === "single" ? (
              <div className="caption-row">
                <input
                  value={caption}
                  onChange={(e) => setCaption(e.target.value)}
                  placeholder="Caption for this single meme (optional)"
                  className="caption-input"
                />
              </div>
            ) : null}
            <div className="mood-row">
              {moods.map(([emoji, label]) => (
                <button key={label} onClick={() => setSelectedMood(label)} className={`mood ${selectedMood === label ? "active" : ""}`}>
                  <span>{emoji}</span><span>{label}</span>
                </button>
              ))}
            </div>
            <div className="controls-row">
              {mode === "pack" ? (
                <label className="count-control"><span>PACK SIZE</span><select value={count} onChange={(e) => setCount(Number(e.target.value))}><option value={6}>6</option><option value={12}>12</option><option value={18}>18</option><option value={24}>24</option></select></label>
              ) : (
                <span className="count-control"><span>SINGLE MEME</span></span>
              )}
              <button onClick={generatePack} disabled={generating} className="generate-button">
                {generating ? <><span className="spinner" /> Brewing chaos…</> : <>Generate {mode === "pack" ? "pack" : "meme"} <span>↗</span></>}
              </button>
            </div>
            {authError ? (
              <div className="auth-message" role="status">
                <span>{authError}</span>
                {auth.status === "needs-extension" && auth.installUrl ? (
                  <a href={auth.installUrl} target="_blank" rel="noreferrer" className="auth-link">Install Sign in with ChatGPT</a>
                ) : null}
              </div>
            ) : null}
          </section>
        </div>
      </section>

      <section className="gallery-wrap">
        <div className="mx-auto max-w-[1420px] px-6 py-10 lg:px-10 lg:py-14">
          <div className="mb-7 flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
            <div>
              <div className="eyebrow">03 / STICKER WALL</div>
              <h2 className="font-display mt-2 text-4xl font-black tracking-[-.05em]">Your pack <span className="text-black/25">{generated ? "is alive." : "starts here."}</span></h2>
            </div>
            {stickers.length ? (
              <div className="export-group">
                <select value={exportFormat} onChange={(e) => setExportFormat(e.target.value as "png" | "jpg" | "webp-whatsapp")} className="export-select" aria-label="Export format">
                  <option value="png">PNG</option>
                  <option value="jpg">JPG</option>
                  <option value="webp-whatsapp">WhatsApp · WebP 512</option>
                </select>
                <button onClick={exportAll} className="export-button">↓ Export pack <span>{displayStickers.length}</span></button>
              </div>
            ) : null}
          </div>
          <div className="sticker-grid">
            {displayStickers.map((sticker, i) => (
              <article key={sticker.id} className={`sticker-card tone-${sticker.tone ?? "cream"}`} style={{ animationDelay: `${i * 35}ms` }}>
                <div className="sticker-no">#{String(i + 1).padStart(2, "0")}</div>
                {sticker.image ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={sticker.image} alt={sticker.text ?? "sticker"} className="generated-image" />
                ) : (
                  <div className="sticker-emoji">{sticker.emoji ?? "😂"}</div>
                )}
                {sticker.text ? <div className="sticker-caption">{sticker.text}</div> : null}
                <div className="mini-actions">
                  <button className="mini-action" aria-label="Edit sticker" onClick={() => openEditor(sticker)}>✎</button>
                  {sticker.image ? (
                    <button className="mini-action" aria-label="Download sticker" onClick={() => void exportOne(sticker, i)}>↓</button>
                  ) : null}
                </div>
                {sticker.exact ? <span className="exact-badge">EXACT</span> : null}
              </article>
            ))}
            {!stickers.length ? (
              <p className="empty-note">Nothing yet. Drop references and generate a pack, or add an exact image from the source tray above.</p>
            ) : null}
          </div>
        </div>
      </section>

      {editing ? (
        <div className="edit-overlay" onClick={closeEditor}>
          <div className="edit-modal" onClick={(e) => e.stopPropagation()}>
            <div className="panel-head"><span>EDIT STICKER</span><button className="edit-close" onClick={closeEditor}>×</button></div>
            {editing.image ? (
              <MemeCanvas ref={canvasRef} baseImage={editing.image} layers={editLayers} onChange={setEditLayers} />
            ) : (
              <p className="mc-hint">This sticker has no image yet.</p>
            )}
            <div className="edit-prompt-row">
              <input
                value={editInstruction}
                onChange={(e) => setEditInstruction(e.target.value)}
                placeholder="Re-prompt: e.g. make it angrier, add sunglasses"
                className="caption-input"
              />
              <button className="mc-btn" disabled={editBusy || !editing.image} onClick={regenerateFromPrompt}>
                {editBusy ? "Working…" : "↻ Regenerate"}
              </button>
            </div>
            <div className="edit-actions">
              <button className="mc-btn ghost" onClick={closeEditor}>Cancel</button>
              <button className="mc-btn primary" onClick={saveCanvasEdits} disabled={!editing.image}>Save text edits</button>
            </div>
          </div>
        </div>
      ) : null}

      <footer className="mx-auto flex max-w-[1420px] items-center justify-between px-6 py-8 text-xs text-black/35 lg:px-10">
        <span>stikky / made for the group chat</span>
        <span>AI generation runs server-side · edit text on canvas</span>
      </footer>
    </main>
  );
}
