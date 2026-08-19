// Renders every downloadable QR / receipt with the same Meli visual grammar:
// Milk paper, Ink frame, Cat Fire pixels and a hard Cat Shadow offset. The DOM
// card remains the source of truth, so on-screen and downloaded information
// cannot drift apart.

const PAPER = "#fff8f0";
const INK = "#0b0b0f";
const CAT_FIRE = "#f85239";
const CAT_SHADOW = "#cf3433";
const PAD = 32;
const FRAME = 2;
const SHADOW_OFFSET = 10;

function loadImage(src: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.onload = () => resolve(img);
		img.onerror = () => reject(new Error("image load failed"));
		img.src = src;
	});
}

function drawExportPaper(ctx: CanvasRenderingContext2D, w: number, h: number, scale: number) {
	ctx.save();
	ctx.fillStyle = PAPER;
	ctx.fillRect(0, 0, w, h);

	// Quiet, deterministic pixel grid. It remains visible around the card only.
	ctx.fillStyle = "rgba(207,52,51,0.09)";
	const step = 32 * scale;
	const pixel = 2 * scale;
	for (let y = 18 * scale, row = 0; y < h; y += step, row += 1) {
		for (let x = (row % 2 === 0 ? 18 : 34) * scale; x < w; x += step * 2) {
			ctx.fillRect(x, y, pixel, pixel);
		}
	}

	// The same asymmetric corner rail used by the app shell.
	ctx.fillStyle = CAT_FIRE;
	ctx.fillRect(w - 44 * scale, 0, 30 * scale, 4 * scale);
	ctx.fillStyle = CAT_SHADOW;
	ctx.fillRect(w - 14 * scale, 0, 14 * scale, 4 * scale);
	ctx.fillRect(0, h - 8 * scale, 8 * scale, 8 * scale);
	ctx.fillStyle = CAT_FIRE;
	ctx.fillRect(8 * scale, h - 4 * scale, 16 * scale, 4 * scale);
	ctx.restore();
}

function pause(timeoutMs: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, timeoutMs));
}

async function waitForExportAssets(node: HTMLElement): Promise<void> {
	const imageWork = Array.from(node.querySelectorAll("img")).map(async (image) => {
		if (!image.complete) {
			await new Promise<void>((resolve) => {
				image.addEventListener("load", () => resolve(), { once: true });
				image.addEventListener("error", () => resolve(), { once: true });
			});
		}
		if (typeof image.decode === "function") await image.decode().catch(() => undefined);
	});
	const fontWork = document.fonts?.ready ?? Promise.resolve();
	await Promise.race([Promise.allSettled([fontWork, ...imageWork]), pause(1600)]);
}

async function renderCardToBlob(node: HTMLElement): Promise<Blob> {
	const { toPng } = await import("html-to-image");
	await waitForExportAssets(node);

	const scale = 2;
	node.dataset.exporting = "true";
	let cardUrl: string;
	try {
		cardUrl = await toPng(node, {
			pixelRatio: scale,
			backgroundColor: PAPER,
			cacheBust: true,
			style: {
				animation: "none",
				boxShadow: "none",
				transform: "none",
				transition: "none",
			},
		});
	} finally {
		delete node.dataset.exporting;
	}
	const card = await loadImage(cardUrl);

	const pad = PAD * scale;
	const frame = FRAME * scale;
	const shadow = SHADOW_OFFSET * scale;
	const canvas = document.createElement("canvas");
	canvas.width = card.width + pad * 2 + shadow;
	canvas.height = card.height + pad * 2 + shadow;
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("canvas not supported");

	drawExportPaper(ctx, canvas.width, canvas.height, scale);

	const x = pad;
	const y = pad;
	const w = card.width;
	const h = card.height;

	// Meli depth is geometric: one hard offset, never blur or rounded clipping.
	ctx.fillStyle = CAT_SHADOW;
	ctx.fillRect(x + shadow - frame, y + shadow - frame, w + frame * 2, h + frame * 2);
	ctx.fillStyle = INK;
	ctx.fillRect(x - frame, y - frame, w + frame * 2, h + frame * 2);
	ctx.drawImage(card, x, y);

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
	setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export async function downloadCard(node: HTMLElement | null, filename: string): Promise<void> {
	if (!node) throw new Error("export card unavailable");
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
		// user cancelled or share unsupported - caller falls back
	}
	return false;
}
