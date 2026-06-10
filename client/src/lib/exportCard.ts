// Renders a receipt / QR card as a faithful PNG on a white, lightly textured
// background — the dark card sits on "paper", like a shareable comprobante.
//
// Approach: capture the card node directly with html-to-image (reliable), then
// composite it onto a <canvas> we fully control: white paper + a generative
// curved-line texture + soft shadow, and clip the card to a rounded rect so the
// corners come out perfectly clean (html-to-image can leave corner artifacts).

const PAPER = "#faf8f3";
const PAD = 44; // CSS px of paper margin around the card
const CARD_RADIUS = 24; // matches the card's rounded-[24px]

function loadImage(src: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.onload = () => resolve(img);
		img.onerror = () => reject(new Error("image load failed"));
		img.src = src;
	});
}

function roundRectPath(
	ctx: CanvasRenderingContext2D,
	x: number,
	y: number,
	w: number,
	h: number,
	r: number,
) {
	ctx.beginPath();
	if (typeof ctx.roundRect === "function") {
		ctx.roundRect(x, y, w, h, r);
		return;
	}
	ctx.moveTo(x + r, y);
	ctx.arcTo(x + w, y, x + w, y + h, r);
	ctx.arcTo(x + w, y + h, x, y + h, r);
	ctx.arcTo(x, y + h, x, y, r);
	ctx.arcTo(x, y, x + w, y, r);
	ctx.closePath();
}

// Flowing, randomized curved lines — gives the paper an organic, slightly
// noticeable grain that's different on every export.
function drawTexture(ctx: CanvasRenderingContext2D, w: number, h: number, scale: number) {
	const rnd = (a: number, b: number) => a + Math.random() * (b - a);
	ctx.save();
	ctx.strokeStyle = "rgba(20,19,15,0.06)";
	ctx.lineWidth = 1.3 * scale;
	ctx.lineCap = "round";

	const rows = 22;
	const rowGap = h / rows;
	const step = 64 * scale;
	for (let i = -1; i <= rows; i++) {
		const baseY = i * rowGap + rnd(-rowGap * 0.4, rowGap * 0.4);
		ctx.beginPath();
		ctx.moveTo(-step, baseY);
		for (let x = -step; x < w + step; x += step) {
			const cx = x + step / 2;
			const cy = baseY + rnd(-rowGap * 0.9, rowGap * 0.9);
			const ny = baseY + rnd(-rowGap * 0.45, rowGap * 0.45);
			ctx.quadraticCurveTo(cx, cy, x + step, ny);
		}
		ctx.stroke();
	}
	ctx.restore();
}

async function renderCardToBlob(node: HTMLElement): Promise<Blob> {
	const { toPng } = await import("html-to-image");

	// Make sure brand fonts are loaded before capture (best-effort, never hangs).
	if (document.fonts?.ready) {
		await Promise.race([
			document.fonts.ready,
			new Promise((r) => setTimeout(r, 1200)),
		]);
	}

	const scale = 2;
	const cardUrl = await toPng(node, { pixelRatio: scale });
	const card = await loadImage(cardUrl);

	const pad = PAD * scale;
	const radius = CARD_RADIUS * scale;
	const canvas = document.createElement("canvas");
	canvas.width = card.width + pad * 2;
	canvas.height = card.height + pad * 2;
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("canvas not supported");

	// Paper + texture
	ctx.fillStyle = PAPER;
	ctx.fillRect(0, 0, canvas.width, canvas.height);
	drawTexture(ctx, canvas.width, canvas.height, scale);

	const x = pad;
	const y = pad;
	const w = card.width;
	const h = card.height;

	// Soft shadow cast by the card silhouette (rounded).
	ctx.save();
	ctx.shadowColor = "rgba(0,0,0,0.22)";
	ctx.shadowBlur = 36 * scale;
	ctx.shadowOffsetY = 16 * scale;
	roundRectPath(ctx, x, y, w, h, radius);
	ctx.fillStyle = "#141417";
	ctx.fill();
	ctx.restore();

	// The card, clipped to the rounded rect → clean corners (no artifacts).
	ctx.save();
	roundRectPath(ctx, x, y, w, h, radius);
	ctx.clip();
	ctx.drawImage(card, x, y);
	ctx.restore();

	return await new Promise<Blob>((resolve, reject) =>
		canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png"),
	);
}

function triggerDownload(blob: Blob, filename: string) {
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function downloadCard(node: HTMLElement | null, filename: string): Promise<void> {
	if (!node) return;
	const blob = await renderCardToBlob(node);
	triggerDownload(blob, filename);
}

/**
 * Share the card image plus an optional link/text. Returns true if the native
 * share sheet handled it, false if the caller should fall back (e.g. copy link).
 */
export async function shareCard(
	node: HTMLElement | null,
	opts: { filename: string; text?: string; url?: string },
): Promise<boolean> {
	if (!node) return false;
	try {
		const blob = await renderCardToBlob(node);
		const file = new File([blob], opts.filename, { type: "image/png" });
		if (navigator.canShare?.({ files: [file] })) {
			await navigator.share({ files: [file], text: opts.text });
			return true;
		}
		if (navigator.share && (opts.url || opts.text)) {
			await navigator.share({ text: opts.text, url: opts.url });
			return true;
		}
	} catch {
		// user cancelled or share unsupported — caller falls back
	}
	return false;
}
