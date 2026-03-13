import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import jsQR from "jsqr";
import Logo from "../components/Logo";

type FocusCapabilities = MediaTrackCapabilities & {
  focusMode?: string[];
};

type FocusConstraintSet = MediaTrackConstraintSet & {
  focusMode?: string;
};

export default function ScanQR() {
  const navigate = useNavigate();

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const scanningRef = useRef(true);
  const frameRequestRef = useRef<number | null>(null);
  const lastScanTimeRef = useRef(0);
  const audioContextRef = useRef<AudioContext | null>(null);
  const detectedRef = useRef(false);

  const [error, setError] = useState("");

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

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }

    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.srcObject = null;
    }
  }, [cleanupFrameCallback]);

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
      oscillator.frequency.setValueAtTime(1046.5, audioContext.currentTime); // C6

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

      await playDetectedFeedback();
      stopCamera();

      const value = rawValue.trim();

      try {
        const parsed = new URL(value, window.location.origin);

        if (parsed.origin === window.location.origin) {
          navigate(parsed.pathname + parsed.search + parsed.hash);
          return;
        }

        setError("El QR no pertenece a esta aplicación");
      } catch {
        if (value.startsWith("/")) {
          navigate(value);
          return;
        }

        setError("QR no válido");
      }
    },
    [navigate, playDetectedFeedback, stopCamera],
  );

  useEffect(() => {
    let cancelled = false;

    const SCAN_INTERVAL_MS = 120;
    const MAX_ANALYSIS_WIDTH = 960;

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

    function startScanLoop() {
      const video = videoRef.current;
      const canvas = canvasRef.current;

      if (!video || !canvas) return;

      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) {
        setError("No se pudo inicializar el escáner");
        return;
      }

      const tick = (now: number) => {
        if (cancelled || !scanningRef.current || detectedRef.current) return;

        const videoEl = videoRef.current;
        const canvasEl = canvasRef.current;

        if (!videoEl || !canvasEl) return;

        if (videoEl.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
          const sourceWidth = videoEl.videoWidth;
          const sourceHeight = videoEl.videoHeight;

          if (
            sourceWidth > 0 &&
            sourceHeight > 0 &&
            now - lastScanTimeRef.current >= SCAN_INTERVAL_MS
          ) {
            lastScanTimeRef.current = now;

            const scale = Math.min(1, MAX_ANALYSIS_WIDTH / sourceWidth);
            const targetWidth = Math.max(1, Math.floor(sourceWidth * scale));
            const targetHeight = Math.max(1, Math.floor(sourceHeight * scale));

            if (
              canvasEl.width !== targetWidth ||
              canvasEl.height !== targetHeight
            ) {
              canvasEl.width = targetWidth;
              canvasEl.height = targetHeight;
            }

            ctx.drawImage(videoEl, 0, 0, targetWidth, targetHeight);

            const imageData = ctx.getImageData(0, 0, targetWidth, targetHeight);

            const code = jsQR(
              imageData.data,
              imageData.width,
              imageData.height,
              {
                inversionAttempts: "dontInvert",
              },
            );

            if (code?.data) {
              void handleQRResult(code.data);
              return;
            }
          }
        }

        scheduleNextFrame(videoEl, tick);
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
        // Check if we already have labels (permission previously granted)
        let devices = await navigator.mediaDevices.enumerateDevices();
        let videoDevices = devices.filter(
          (d) => d.kind === "videoinput",
        );
        const hasLabels = videoDevices.some((d) => d.label);

        if (!hasLabels) {
          // Need permission first — get a temp stream
          const tempStream =
            await navigator.mediaDevices.getUserMedia({
              video: { facingMode: "environment" },
              audio: false,
            });
          tempStream
            .getTracks()
            .forEach((t) => t.stop());
          devices =
            await navigator.mediaDevices.enumerateDevices();
          videoDevices = devices.filter(
            (d) => d.kind === "videoinput",
          );
        }

        // Find back-facing cameras by label
        const backCameras = videoDevices.filter((d) => {
          const l = d.label.toLowerCase();
          return (
            l.includes("back") ||
            l.includes("rear") ||
            l.includes("trasera") ||
            l.includes("environment")
          );
        });

        if (backCameras.length > 1) {
          // Multiple back cameras: prefer "camera2 0" pattern (main lens on Samsung/Android)
          // Samsung labels: "camera2 0, facing back" = main, "camera2 1, facing back" = ultra-wide
          const main =
            backCameras.find((d) =>
              /camera2?\s*0/i.test(d.label),
            ) || backCameras[0];
          return {
            deviceId: { exact: main.deviceId },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
            frameRate: { ideal: 30, max: 30 },
          };
        }
      } catch {
        // Could not enumerate, use default
      }

      return defaultConstraints;
    }

    async function startCamera() {
      try {
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
          setError("No se pudo acceder a la cámara");
        }
      }
    }

    scanningRef.current = true;
    detectedRef.current = false;
    lastScanTimeRef.current = 0;

    void startCamera();

    return () => {
      cancelled = true;
      scanningRef.current = false;
      detectedRef.current = false;
      stopCamera();

      const audioContext = audioContextRef.current;
      if (audioContext) {
        void audioContext.close();
        audioContextRef.current = null;
      }
    };
  }, [handleQRResult, stopCamera]);

  return (
    <div className="flex flex-col min-h-dvh px-5 sm:px-8 pt-6 sm:pt-10 pb-8 w-full max-w-lg mx-auto">
      <button
        onClick={() => navigate(-1)}
        className="flex items-center gap-1.5 text-sm text-muted hover:text-white transition-colors self-start mb-6"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M19 12H5" />
          <path d="M12 19l-7-7 7-7" />
        </svg>
        Volver
      </button>

      <div className="bg-surface rounded-2xl p-5 sm:p-6 flex-1 flex flex-col items-center">
        <Logo className="w-12 mb-5" />

        {error ? (
          <p className="text-parmelia-pink text-base text-center py-12">
            {error}
          </p>
        ) : (
          <div className="w-full max-w-sm aspect-square rounded-xl overflow-hidden border-2 border-parmelia-blue mb-5 relative bg-black">
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className="w-full h-full object-cover"
            />
            <canvas ref={canvasRef} className="hidden" />

          </div>
        )}

        <p className="text-muted text-sm text-center">
          Escanea un QR de Parmelia
        </p>

        <button
          onClick={() => navigate("/pagar")}
          className="mt-6 text-parmelia-blue text-sm underline underline-offset-4"
        >
          Ingresar datos manualmente
        </button>
      </div>
    </div>
  );
}
