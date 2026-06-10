import { type ChangeEvent, useCallback, useEffect, useRef, useState } from "react";
import jsQR from "jsqr";
import { useViewTransitionNavigate } from "../hooks/useNav";

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

type BarcodeDetectorLike = {
  detect: (source: DetectableSource) => Promise<DetectedBarcodeLike[]>;
};

type BarcodeDetectorConstructorLike = {
  new (options?: { formats?: string[] }): BarcodeDetectorLike;
  getSupportedFormats?: () => Promise<string[]>;
};

type WindowWithBarcodeDetector = Window & {
  BarcodeDetector?: BarcodeDetectorConstructorLike;
};

const APP_URL = import.meta.env.VITE_APP_URL || "https://parmelia.me";
const SCAN_INTERVAL_MS = 180;
const MAX_LIVE_ANALYSIS_WIDTH = 1280;
const MAX_IMAGE_ANALYSIS_WIDTH = 1600;
const QR_SCAN_CROP_RATIOS = [1, 0.72] as const;

function decodeWithJsQR(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  maxAnalysisWidth: number,
) {
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
      inversionAttempts: "attemptBoth",
    });

    if (code?.data) {
      return code.data;
    }
  }

  return null;
}

async function createBarcodeDetector() {
  const BarcodeDetectorCtor = (window as WindowWithBarcodeDetector)
    .BarcodeDetector;

  if (!BarcodeDetectorCtor) {
    return null;
  }

  try {
    const supportedFormats =
      typeof BarcodeDetectorCtor.getSupportedFormats === "function"
        ? await BarcodeDetectorCtor.getSupportedFormats()
        : null;

    if (supportedFormats && !supportedFormats.includes("qr_code")) {
      return null;
    }

    return new BarcodeDetectorCtor({ formats: ["qr_code"] });
  } catch {
    try {
      return new BarcodeDetectorCtor({ formats: ["qr_code"] });
    } catch {
      return null;
    }
  }
}

async function detectWithBarcodeDetector(
  detector: BarcodeDetectorLike | null,
  source: DetectableSource,
) {
  if (!detector) {
    return null;
  }

  try {
    const barcodes = await detector.detect(source);
    const rawValue = barcodes.find((barcode) => barcode.rawValue?.trim())
      ?.rawValue;

    return rawValue?.trim() || null;
  } catch {
    return null;
  }
}

function loadImageFromFile(file: File) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();

    image.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(image);
    };

    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("No se pudo cargar la imagen"));
    };

    image.src = objectUrl;
  });
}

function isTrustedParmeliaHost(hostname: string) {
  const trustedHosts = new Set<string>();

  try {
    trustedHosts.add(new URL(APP_URL).hostname);
  } catch {
    // ignore invalid env value
  }

  if (typeof window !== "undefined") {
    trustedHosts.add(window.location.hostname);
  }

  return trustedHosts.has(hostname) || hostname.includes("parmelia");
}

function getNavigationTargetFromQr(rawValue: string) {
  const value = rawValue.trim();

  if (!value) {
    return null;
  }

  if (value.startsWith("/")) {
    return value;
  }

  try {
    const parsed = new URL(value, window.location.origin);

    if (
      parsed.origin === window.location.origin ||
      isTrustedParmeliaHost(parsed.hostname)
    ) {
      return parsed.pathname + parsed.search + parsed.hash;
    }
  } catch {
    return null;
  }

  return null;
}

export default function ScanQR() {
  const navigate = useViewTransitionNavigate();

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const scanningRef = useRef(true);
  const frameRequestRef = useRef<number | null>(null);
  const lastScanTimeRef = useRef(0);
  const audioContextRef = useRef<AudioContext | null>(null);
  const detectedRef = useRef(false);
  const isDetectingRef = useRef(false);
  const barcodeDetectorRef = useRef<BarcodeDetectorLike | null>(null);
  const barcodeDetectorCheckedRef = useRef(false);

  const [cameraError, setCameraError] = useState("");
  const [message, setMessage] = useState("");
  const [isImporting, setIsImporting] = useState(false);
  const [scannerVersion, setScannerVersion] = useState(0);

  const getOrCreateBarcodeDetector = useCallback(async () => {
    if (barcodeDetectorRef.current) {
      return barcodeDetectorRef.current;
    }

    if (barcodeDetectorCheckedRef.current) {
      return null;
    }

    const detector = await createBarcodeDetector();
    barcodeDetectorRef.current = detector;
    barcodeDetectorCheckedRef.current = true;
    return detector;
  }, []);

  const cleanupFrameCallback = useCallback(() => {
    const video = videoRef.current;
    const frameId = frameRequestRef.current;

    if (!video || frameId === null) return;

    if (typeof video.cancelVideoFrameCallback === "function") {
      video.cancelVideoFrameCallback(frameId);
    } else {
      cancelAnimationFrame(frameId);
    }

    frameRequestRef.current = null;
  }, []);

  const stopCamera = useCallback(() => {
    cleanupFrameCallback();
    isDetectingRef.current = false;

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }

    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.srcObject = null;
    }
  }, [cleanupFrameCallback]);

  const restartScanner = useCallback(() => {
    setCameraError("");
    setMessage("");
    setScannerVersion((version) => version + 1);
  }, []);

  const playDetectedFeedback = useCallback(async () => {
    try {
      if ("vibrate" in navigator) {
        navigator.vibrate(120);
      }
    } catch {
      // ignore
    }

    try {
      const AudioCtx =
        window.AudioContext ||
        (window as typeof window & { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;

      if (!AudioCtx) return;

      if (!audioContextRef.current) {
        audioContextRef.current = new AudioCtx();
      }

      const audioContext = audioContextRef.current;

      if (audioContext.state === "suspended") {
        await audioContext.resume();
      }

      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();

      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(1046.5, audioContext.currentTime);

      gain.gain.setValueAtTime(0.0001, audioContext.currentTime);
      gain.gain.exponentialRampToValueAtTime(
        0.12,
        audioContext.currentTime + 0.01,
      );
      gain.gain.exponentialRampToValueAtTime(
        0.0001,
        audioContext.currentTime + 0.14,
      );

      oscillator.connect(gain);
      gain.connect(audioContext.destination);

      oscillator.start(audioContext.currentTime);
      oscillator.stop(audioContext.currentTime + 0.15);

      oscillator.onended = () => {
        oscillator.disconnect();
        gain.disconnect();
      };
    } catch {
      // ignore autoplay / audio restrictions
    }
  }, []);

  const handleQRResult = useCallback(
    async (rawValue: string) => {
      if (!scanningRef.current || detectedRef.current) return;

      detectedRef.current = true;
      scanningRef.current = false;
      setMessage("");
      setCameraError("");

      await playDetectedFeedback();
      stopCamera();

      const navigationTarget = getNavigationTargetFromQr(rawValue);

      if (navigationTarget) {
        navigate(navigationTarget);
        return;
      }

      setMessage("El QR no pertenece a Parmelia");
    },
    [navigate, playDetectedFeedback, stopCamera],
  );

  const handleImportFile = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";

      if (!file) return;

      const canvas = canvasRef.current;
      if (!canvas) {
        setMessage("No se pudo preparar el lector de imágenes");
        return;
      }

      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) {
        setMessage("No se pudo preparar el lector de imágenes");
        return;
      }

      setIsImporting(true);
      setMessage("");

      try {
        const image = await loadImageFromFile(file);
        const detector = await getOrCreateBarcodeDetector();

        const detectedFromImage = await detectWithBarcodeDetector(
          detector,
          image,
        );

        if (detectedFromImage) {
          await handleQRResult(detectedFromImage);
          return;
        }

        const detectedFromJsQR = decodeWithJsQR(
          image,
          image.naturalWidth || image.width,
          image.naturalHeight || image.height,
          canvas,
          ctx,
          MAX_IMAGE_ANALYSIS_WIDTH,
        );

        if (detectedFromJsQR) {
          await handleQRResult(detectedFromJsQR);
          return;
        }

        setMessage("No pudimos leer el QR de esa imagen");
      } catch (err) {
        console.error(err);
        setMessage("No pudimos analizar esa imagen");
      } finally {
        setIsImporting(false);
      }
    },
    [getOrCreateBarcodeDetector, handleQRResult],
  );

  useEffect(() => {
    let cancelled = false;

    function scheduleNextFrame(
      video: HTMLVideoElement,
      callback: (now: number) => void,
    ) {
      if (typeof video.requestVideoFrameCallback === "function") {
        frameRequestRef.current = video.requestVideoFrameCallback((now) => {
          callback(now);
        });
      } else {
        frameRequestRef.current = requestAnimationFrame((now) => {
          callback(now);
        });
      }
    }

    async function processVideoFrame(
      video: HTMLVideoElement,
      canvas: HTMLCanvasElement,
      ctx: CanvasRenderingContext2D,
    ) {
      const sourceWidth = video.videoWidth;
      const sourceHeight = video.videoHeight;

      if (sourceWidth <= 0 || sourceHeight <= 0) {
        return;
      }

      const detector = await getOrCreateBarcodeDetector();
      const nativeResult = await detectWithBarcodeDetector(detector, video);

      if (nativeResult) {
        await handleQRResult(nativeResult);
        return;
      }

      const fallbackResult = decodeWithJsQR(
        video,
        sourceWidth,
        sourceHeight,
        canvas,
        ctx,
        MAX_LIVE_ANALYSIS_WIDTH,
      );

      if (fallbackResult) {
        await handleQRResult(fallbackResult);
      }
    }

    function startScanLoop() {
      const video = videoRef.current;
      const canvas = canvasRef.current;

      if (!video || !canvas) return;

      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) {
        setCameraError("No se pudo inicializar el escáner");
        return;
      }

      const tick = (now: number) => {
        if (cancelled || !scanningRef.current || detectedRef.current) return;

        const videoEl = videoRef.current;
        const canvasEl = canvasRef.current;

        if (!videoEl || !canvasEl) return;

        const shouldScan =
          videoEl.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
          now - lastScanTimeRef.current >= SCAN_INTERVAL_MS &&
          !isDetectingRef.current;

        if (!shouldScan) {
          scheduleNextFrame(videoEl, tick);
          return;
        }

        lastScanTimeRef.current = now;
        isDetectingRef.current = true;

        void processVideoFrame(videoEl, canvasEl, ctx).finally(() => {
          isDetectingRef.current = false;

          if (!cancelled && scanningRef.current && !detectedRef.current) {
            scheduleNextFrame(videoEl, tick);
          }
        });
      };

      scheduleNextFrame(video, tick);
    }

    async function selectMainCamera(): Promise<MediaTrackConstraints> {
      const defaultConstraints: MediaTrackConstraints = {
        facingMode: { ideal: "environment" },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 30, max: 30 },
      };

      try {
        let devices = await navigator.mediaDevices.enumerateDevices();
        let videoDevices = devices.filter((device) => device.kind === "videoinput");
        const hasLabels = videoDevices.some((device) => device.label);

        if (!hasLabels) {
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

          return (
            label.includes("back") ||
            label.includes("rear") ||
            label.includes("trasera") ||
            label.includes("environment") ||
            label.includes("posterior")
          );
        });

        if (backCameras.length > 1) {
          const mainCamera = backCameras.find((device) => {
            const label = device.label.toLowerCase();
            return label.includes("0, facing back") || label.includes("camera2 0");
          });

          const fallbackCamera = backCameras.find((device) => {
            const label = device.label.toLowerCase();

            return (
              !label.includes("macro") &&
              !label.includes("telephoto") &&
              !label.includes("ultra")
            );
          });

          const selectedId =
            mainCamera?.deviceId ||
            fallbackCamera?.deviceId ||
            backCameras[0].deviceId;

          return {
            deviceId: { exact: selectedId },
            width: { ideal: 1920, min: 1280 },
            height: { ideal: 1080, min: 720 },
            frameRate: { ideal: 30, max: 60 },
          };
        }
      } catch {
        // enumerate failed
      }

      return defaultConstraints;
    }

    async function startCamera() {
      try {
        setCameraError("");
        const videoConstraints = await selectMainCamera();

        const stream = await navigator.mediaDevices.getUserMedia({
          video: videoConstraints,
          audio: false,
        });

        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }

        streamRef.current = stream;

        const track = stream.getVideoTracks()[0];

        try {
          const capabilities =
            typeof track.getCapabilities === "function"
              ? (track.getCapabilities() as FocusCapabilities)
              : null;

          if (capabilities?.focusMode?.includes("continuous")) {
            await track.applyConstraints({
              advanced: [
                {
                  focusMode: "continuous",
                } as FocusConstraintSet,
              ],
            });
          }
        } catch {
          // ignore unsupported focus constraints
        }

        const video = videoRef.current;
        if (!video) return;

        video.srcObject = stream;
        await video.play();

        startScanLoop();
      } catch (err) {
        console.error(err);
        if (!cancelled) {
          setCameraError("No se pudo acceder a la cámara");
        }
      }
    }

    scanningRef.current = true;
    detectedRef.current = false;
    isDetectingRef.current = false;
    lastScanTimeRef.current = 0;
    setMessage("");
    void getOrCreateBarcodeDetector();
    void startCamera();

    return () => {
      cancelled = true;
      scanningRef.current = false;
      detectedRef.current = false;
      isDetectingRef.current = false;
      stopCamera();

      const audioContext = audioContextRef.current;
      if (audioContext) {
        void audioContext.close();
        audioContextRef.current = null;
      }
    };
  }, [getOrCreateBarcodeDetector, handleQRResult, scannerVersion, stopCamera]);

  return (
    <div className="flex flex-col min-h-dvh px-5 pt-6 pb-10 w-full max-w-[460px] mx-auto animate-fade-up">
      <header className="flex items-center gap-3 mb-7">
        <button
          onClick={() => navigate(-1)}
          aria-label="Volver"
          className="w-10 h-10 -ml-1 rounded-full flex items-center justify-center text-text-muted hover:text-text hover:bg-surface transition-colors"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 12H5" />
            <path d="M12 19l-7-7 7-7" />
          </svg>
        </button>
        <h1 className="text-[22px]">Escanear QR</h1>
      </header>

      <div className="flex-1 flex flex-col items-center">
        {cameraError ? (
          <div className="w-full max-w-[340px] aspect-square rounded-[22px] overflow-hidden border border-glow-pink/40 mb-6 bg-surface flex items-center justify-center px-8 text-center">
            <p className="text-glow-pink text-[15px]">{cameraError}</p>
          </div>
        ) : (
          <div className="w-full max-w-[340px] aspect-square rounded-[22px] overflow-hidden mb-6 relative bg-black shadow-e2">
            <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover" />

            {/* Brand scan frame */}
            <div className="pointer-events-none absolute inset-0">
              <span className="absolute top-4 left-4 w-7 h-7 border-t-2 border-l-2 border-glow-sky rounded-tl-lg" />
              <span className="absolute top-4 right-4 w-7 h-7 border-t-2 border-r-2 border-glow-sky rounded-tr-lg" />
              <span className="absolute bottom-4 left-4 w-7 h-7 border-b-2 border-l-2 border-glow-sky rounded-bl-lg" />
              <span className="absolute bottom-4 right-4 w-7 h-7 border-b-2 border-r-2 border-glow-sky rounded-br-lg" />
              {!isImporting && (
                <div
                  className="absolute left-5 right-5 h-[2px] rounded-full animate-qr-scan"
                  style={{ background: "linear-gradient(90deg, transparent, #f4a9cf, #9ce3f4, transparent)" }}
                />
              )}
            </div>

            {isImporting && (
              <div className="absolute inset-0 bg-bg/75 backdrop-blur-sm flex items-center justify-center px-6">
                <p className="text-[14px] text-text text-center">Analizando el QR…</p>
              </div>
            )}
          </div>
        )}

        <canvas ref={canvasRef} className="hidden" />

        <p className={`text-[14px] text-center min-h-10 ${cameraError || message ? "text-glow-pink" : "text-text-muted"}`}>
          {message || "Apunta la cámara a un QR de Parmelia"}
        </p>

        {cameraError && (
          <button onClick={restartScanner} className="mt-1 text-sky text-[14px]">
            Reintentar cámara
          </button>
        )}

        <div className="mt-7 w-full max-w-[340px] flex flex-col gap-3">
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={isImporting}
            className="btn btn-primary btn-block"
          >
            {isImporting ? "Analizando…" : "Importar QR desde una imagen"}
          </button>
          <button
            onClick={() => navigate("/pagar")}
            className="btn btn-ghost btn-block"
          >
            Ingresar datos manualmente
          </button>
        </div>

        <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleImportFile} />
      </div>
    </div>
  );
}

