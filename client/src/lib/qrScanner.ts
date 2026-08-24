import i18n from "./i18n";

type FocusCapabilities = MediaTrackCapabilities & {
	focusMode?: string[];
};

type FocusConstraintSet = MediaTrackConstraintSet & {
	focusMode?: string;
};

type DetectableSource =
	| HTMLCanvasElement
	| HTMLImageElement
	| HTMLVideoElement
	| ImageBitmap
	| ImageData;

type DetectedBarcodeLike = {
	rawValue?: string;
};

export type BarcodeDetectorLike = {
	detect: (source: DetectableSource) => Promise<DetectedBarcodeLike[]>;
};

type BarcodeDetectorConstructorLike = {
	new (options?: { formats?: string[] }): BarcodeDetectorLike;
	getSupportedFormats?: () => Promise<string[]>;
};

type WindowWithBarcodeDetector = Window & {
	BarcodeDetector?: BarcodeDetectorConstructorLike;
};

export const SCAN_INTERVAL_MS = 180;

// jsQR cost grows roughly quadratically with width and runs on the main
// thread. Live analysis remains deliberately smaller than imported images.
export const MAX_LIVE_ANALYSIS_WIDTH = 640;
export const MAX_IMAGE_ANALYSIS_WIDTH = 1600;
const QR_SCAN_CROP_RATIOS = [1, 0.72] as const;

type InversionAttempts = "dontInvert" | "onlyInvert" | "attemptBoth" | "invertFirst";
type JsQRFn = typeof import("jsqr")["default"];

let jsQRPromise: Promise<JsQRFn> | null = null;

function loadJsQR() {
	if (!jsQRPromise) {
		jsQRPromise = import("jsqr").then((module) => module.default);
	}
	return jsQRPromise;
}

/** Decode a centered full/inner crop, limiting work before reading pixels. */
export async function decodeWithJsQR(
	source: CanvasImageSource,
	sourceWidth: number,
	sourceHeight: number,
	canvas: HTMLCanvasElement,
	ctx: CanvasRenderingContext2D,
	maxAnalysisWidth: number,
	inversionAttempts: InversionAttempts = "attemptBoth",
) {
	const jsQR = await loadJsQR();
	for (const cropRatio of QR_SCAN_CROP_RATIOS) {
		const cropWidth = Math.max(1, Math.floor(sourceWidth * cropRatio));
		const cropHeight = Math.max(1, Math.floor(sourceHeight * cropRatio));
		const sx = Math.max(0, Math.floor((sourceWidth - cropWidth) / 2));
		const sy = Math.max(0, Math.floor((sourceHeight - cropHeight) / 2));
		const scale = Math.min(1, maxAnalysisWidth / cropWidth);
		const targetWidth = Math.max(1, Math.floor(cropWidth * scale));
		const targetHeight = Math.max(1, Math.floor(cropHeight * scale));

		if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
			canvas.width = targetWidth;
			canvas.height = targetHeight;
		}

		ctx.drawImage(
			source,
			sx,
			sy,
			cropWidth,
			cropHeight,
			0,
			0,
			targetWidth,
			targetHeight,
		);

		const imageData = ctx.getImageData(0, 0, targetWidth, targetHeight);
		const code = jsQR(imageData.data, imageData.width, imageData.height, {
			inversionAttempts,
		});
		if (code?.data) return code.data;
	}

	return null;
}

export async function createBarcodeDetector() {
	const BarcodeDetectorCtor = (window as WindowWithBarcodeDetector).BarcodeDetector;
	if (!BarcodeDetectorCtor) return null;

	try {
		const supportedFormats =
			typeof BarcodeDetectorCtor.getSupportedFormats === "function"
				? await BarcodeDetectorCtor.getSupportedFormats()
				: null;
		if (supportedFormats && !supportedFormats.includes("qr_code")) return null;
		return new BarcodeDetectorCtor({ formats: ["qr_code"] });
	} catch {
		try {
			return new BarcodeDetectorCtor({ formats: ["qr_code"] });
		} catch {
			return null;
		}
	}
}

export async function detectWithBarcodeDetector(
	detector: BarcodeDetectorLike | null,
	source: DetectableSource,
) {
	if (!detector) return null;
	try {
		const barcodes = await detector.detect(source);
		return barcodes.find((barcode) => barcode.rawValue?.trim())?.rawValue?.trim() || null;
	} catch {
		return null;
	}
}

export function loadQrImage(file: File) {
	return new Promise<HTMLImageElement>((resolve, reject) => {
		const objectUrl = URL.createObjectURL(file);
		const image = new Image();
		image.onload = () => {
			URL.revokeObjectURL(objectUrl);
			resolve(image);
		};
		image.onerror = () => {
			URL.revokeObjectURL(objectUrl);
			reject(new Error(i18n.t("scan.imgLoadError")));
		};
		image.src = objectUrl;
	});
}

/** Prefer the primary rear camera while retaining a portable fallback. */
export async function selectMainCamera(): Promise<MediaTrackConstraints> {
	const defaultConstraints: MediaTrackConstraints = {
		facingMode: { ideal: "environment" },
		width: { ideal: 1920 },
		height: { ideal: 1080 },
		frameRate: { ideal: 30, max: 30 },
	};

	try {
		let devices = await navigator.mediaDevices.enumerateDevices();
		let videoDevices = devices.filter((device) => device.kind === "videoinput");
		if (!videoDevices.some((device) => device.label)) {
			const tempStream = await navigator.mediaDevices.getUserMedia({
				video: { facingMode: "environment" },
				audio: false,
			});
			tempStream.getTracks().forEach((track) => track.stop());
			devices = await navigator.mediaDevices.enumerateDevices();
			videoDevices = devices.filter((device) => device.kind === "videoinput");
		}

		const backCameras = videoDevices.filter((device) => {
			const label = device.label.toLowerCase();
			return ["back", "rear", "trasera", "environment", "posterior"].some((term) =>
				label.includes(term),
			);
		});
		if (backCameras.length > 1) {
			const mainCamera = backCameras.find((device) => {
				const label = device.label.toLowerCase();
				return label.includes("0, facing back") || label.includes("camera2 0");
			});
			const fallbackCamera = backCameras.find((device) => {
				const label = device.label.toLowerCase();
				return !["macro", "telephoto", "ultra"].some((term) => label.includes(term));
			});
			const selectedId = mainCamera?.deviceId || fallbackCamera?.deviceId || backCameras[0].deviceId;
			return {
				deviceId: { exact: selectedId },
				width: { ideal: 1920, min: 1280 },
				height: { ideal: 1080, min: 720 },
				frameRate: { ideal: 30, max: 60 },
			};
		}
	} catch {
		// Device enumeration is optional; getUserMedia can use the fallback.
	}

	return defaultConstraints;
}

export async function enableContinuousFocus(track: MediaStreamTrack) {
	try {
		const capabilities =
			typeof track.getCapabilities === "function"
				? (track.getCapabilities() as FocusCapabilities)
				: null;
		if (capabilities?.focusMode?.includes("continuous")) {
			await track.applyConstraints({
				advanced: [{ focusMode: "continuous" } as FocusConstraintSet],
			});
		}
	} catch {
		// Continuous focus is an optional device capability.
	}
}
