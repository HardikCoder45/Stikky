"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";

export type TextLayer = {
  id: number;
  text: string;
  x: number; // fraction 0..1 of canvas width
  y: number; // fraction 0..1 of canvas height
  size: number; // px relative to a 1000px-wide canvas
  color: string;
  bold: boolean;
  stroke: boolean;
};

export type MemeCanvasHandle = { exportDataUrl: () => string };

type Props = {
  baseImage: string; // data URL
  layers: TextLayer[];
  onChange: (layers: TextLayer[]) => void;
};

const CANVAS_W = 1000;

const MemeCanvas = forwardRef<MemeCanvasHandle, Props>(function MemeCanvas(
  { baseImage, layers, onChange },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const idRef = useRef(0);
  const dragRef = useRef<{ id: number; dx: number; dy: number } | null>(null);
  const [selected, setSelected] = useState<number | null>(null);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img) return;
    const h = Math.round((CANVAS_W * (img.naturalHeight || 1)) / (img.naturalWidth || 1));
    canvas.width = CANVAS_W;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const scale = canvas.width / 1000;
    for (const layer of layers) {
      const fontSize = layer.size * scale;
      ctx.font = `${layer.bold ? "800" : "600"} ${fontSize}px "Space Grotesk", Arial, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const x = layer.x * canvas.width;
      const y = layer.y * canvas.height;
      if (layer.stroke) {
        ctx.lineWidth = Math.max(2, fontSize / 8);
        ctx.strokeStyle = "black";
        ctx.lineJoin = "round";
        ctx.strokeText(layer.text, x, y);
      }
      ctx.fillStyle = layer.color;
      ctx.fillText(layer.text, x, y);
    }
  }, [layers]);

  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      imgRef.current = img;
      draw();
    };
    img.src = baseImage;
  }, [baseImage, draw]);

  useEffect(() => {
    draw();
  }, [draw]);

  useImperativeHandle(ref, () => ({
    exportDataUrl: () => {
      const canvas = canvasRef.current;
      if (!canvas) return baseImage;
      return canvas.toDataURL("image/png");
    },
  }), [baseImage]);

  function pointerPos(e: React.PointerEvent<HTMLCanvasElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) / rect.width,
      y: (e.clientY - rect.top) / rect.height,
    };
  }

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    const p = pointerPos(e);
    let hit: number | null = null;
    for (let i = layers.length - 1; i >= 0; i--) {
      const l = layers[i];
      const dx = Math.abs(p.x - l.x);
      const dy = Math.abs(p.y - l.y);
      if (dx < 0.12 && dy < 0.08) {
        hit = l.id;
        break;
      }
    }
    setSelected(hit);
    if (hit != null) {
      const l = layers.find((x) => x.id === hit)!;
      dragRef.current = { id: hit, dx: p.x - l.x, dy: p.y - l.y };
      (e.target as Element).setPointerCapture(e.pointerId);
    }
  }

  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!dragRef.current) return;
    const p = pointerPos(e);
    const { id, dx, dy } = dragRef.current;
    onChange(
      layers.map((l) =>
        l.id === id ? { ...l, x: Math.min(1, Math.max(0, p.x - dx)), y: Math.min(1, Math.max(0, p.y - dy)) } : l,
      ),
    );
  }

  function onPointerUp() {
    dragRef.current = null;
  }

  function update(id: number, patch: Partial<TextLayer>) {
    onChange(layers.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  }

  function addLayer() {
    const id = ++idRef.current;
    onChange([...layers, { id, text: "NEW TEXT", x: 0.5, y: 0.82, size: 64, color: "#ffffff", bold: true, stroke: true }]);
    setSelected(id);
  }

  function remove(id: number) {
    onChange(layers.filter((l) => l.id !== id));
    setSelected(null);
  }

  const sel = layers.find((l) => l.id === selected) ?? null;

  return (
    <div className="meme-canvas-wrap">
      <div className="meme-canvas-stage">
        <canvas
          ref={canvasRef}
          className="meme-canvas"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        />
      </div>
      <div className="meme-canvas-tools">
        <button className="mc-btn" onClick={addLayer}>+ Add text</button>
        {sel ? (
          <div className="mc-edit">
            <input
              className="mc-text-input"
              value={sel.text}
              onChange={(e) => update(sel.id, { text: e.target.value })}
              placeholder="caption"
            />
            <div className="mc-row">
              <label>Size
                <input type="range" min={20} max={140} value={sel.size} onChange={(e) => update(sel.id, { size: Number(e.target.value) })} />
              </label>
              <input type="color" value={sel.color} onChange={(e) => update(sel.id, { color: e.target.value })} />
              <button className={`mc-toggle ${sel.bold ? "on" : ""}`} onClick={() => update(sel.id, { bold: !sel.bold })}>B</button>
              <button className={`mc-toggle ${sel.stroke ? "on" : ""}`} onClick={() => update(sel.id, { stroke: !sel.stroke })}>S</button>
              <button className="mc-del" onClick={() => remove(sel.id)}>🗑</button>
            </div>
            <p className="mc-hint">Drag text on the image to position it.</p>
          </div>
        ) : (
          <p className="mc-hint">Click a text block on the image to edit it, or add new text.</p>
        )}
      </div>
    </div>
  );
});

export default MemeCanvas;
