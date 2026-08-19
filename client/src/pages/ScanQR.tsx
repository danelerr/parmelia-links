import { type ChangeEvent, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useViewTransitionNavigate } from "../hooks/useNav";
import BackHeader from "../components/BackHeader";
import AddressQRCard from "../components/AddressQRCard";
import Screen from "../components/Screen";
import NetworkChips from "../components/NetworkChips";
import { QRCodeSVG } from "qrcode.react";
import type { User } from "../lib/firebase";
import { SERVER_URL } from "../lib/api";
import { fetchWithAuth } from "../lib/authFetch";
import i18n from "../lib/i18n";
import { activeNetwork } from "../lib/activeNetwork";
import { parseQrPayload, type ParsedQrPayload } from "../lib/qrPayload";
import { useAccountProfile } from "../hooks/useAccountProfile";
import NoticeCard from "../components/NoticeCard";
import { MoneyPanel, SectionLabel, TransactionActions } from "../components/finance/FinancialPrimitives";
import { APP_URL } from "../lib/brand";

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

const SCAN_INTERVAL_MS = 180;
// jsQR cost grows ~quadratically with width and it runs on the main thread -
// keep live analysis small so it never starves rendering. QR codes at arm's
// length decode reliably at 640px; imported images get the full-quality pass.
const MAX_LIVE_ANALYSIS_WIDTH = 640;
const MAX_IMAGE_ANALYSIS_WIDTH = 1600;
const QR_SCAN_CROP_RATIOS = [1, 0.72] as const;

type InversionAttempts = "dontInvert" | "onlyInvert" | "attemptBoth" | "invertFirst";

// jsQR (~50 KB) is only a FALLBACK for browsers without a native BarcodeDetector.
// Load it on demand and cache the promise, so devices with native detection
// (most phones) never download it. The camera pipeline is independent of jsQR.
type JsQRFn = typeof import("jsqr")["default"];
let jsQRPromise: Promise<JsQRFn> | null = null;
function loadJsQR() {
  if (!jsQRPromise) {
    jsQRPromise = import("jsqr").then((m) => m.default);
  }
  return jsQRPromise;
}

async function decodeWithJsQR(
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
      reject(new Error(i18n.t("scan.imgLoadError")));
    };

    image.src = objectUrl;
  });
}

type WalletQr = Extract<ParsedQrPayload, { kind: "evm-wallet" }>;
type NetworkOption = { id: number; label: string };

export default function ScanQR({ user }: { user: User }) {
  const navigate = useViewTransitionNavigate();
  const { t } = useTranslation();

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
  const [scannedWallet, setScannedWallet] = useState<WalletQr | null>(null);
  const [walletIdentity, setWalletIdentity] = useState<{
    isGatoPago: boolean;
    username: string | null;
    lookupFailed?: boolean;
  } | null>(null);
  const [networkOptions, setNetworkOptions] = useState<NetworkOption[]>([
    { id: activeNetwork.chainId, label: activeNetwork.name },
  ]);
  const [selectedChainId, setSelectedChainId] = useState(activeNetwork.chainId);
  const [networksLoading, setNetworksLoading] = useState(false);
  // "Mi QR": the payable profile code lives INSIDE the scanner screen
  // (UX_DESIGN §6bis) — one place for both sides of a QR moment.
  const [view, setView] = useState<"scan" | "myqr">("scan");
  const { profile } = useAccountProfile(user);

  useEffect(() => {
    if (!scannedWallet) return;
    let cancelled = false;
    setWalletIdentity(null);
    setNetworksLoading(true);

    void Promise.all([
      fetchWithAuth(user, `${SERVER_URL}/user/resolve-wallet/${scannedWallet.address}`)
        .then(async (response) => response.ok ? response.json() : null)
        .catch(() => null),
      fetchWithAuth(user, `${SERVER_URL}/crosschain/config`)
        .then(async (response) => response.ok ? response.json() : null)
        .catch(() => null),
    ]).then(([identity, config]) => {
      if (cancelled) return;
      if (identity) {
        setWalletIdentity({
          isGatoPago: Boolean(identity.isGatoPago),
          username: typeof identity.username === "string" ? identity.username : null,
        });
      } else {
        // A connectivity failure is not proof that the address is external.
        // Keep the classification honest while still allowing a reviewed send.
        setWalletIdentity({ isGatoPago: false, username: null, lookupFailed: true });
      }

      const options: NetworkOption[] = [
        { id: activeNetwork.chainId, label: activeNetwork.name },
      ];
      if (config?.enabled && Array.isArray(config.destinations)) {
        for (const destination of config.destinations) {
          if (
            Number.isSafeInteger(destination?.chainId) &&
            typeof destination?.name === "string" &&
            !options.some((option) => option.id === destination.chainId)
          ) {
            options.push({ id: destination.chainId, label: destination.name });
          }
        }
      }
      setNetworkOptions(options);
      const requestedChain = scannedWallet.chainId;
      setSelectedChainId(
        requestedChain && options.some((option) => option.id === requestedChain)
          ? requestedChain
          : activeNetwork.chainId,
      );
      setNetworksLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [scannedWallet, user]);

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
    setScannedWallet(null);
    setWalletIdentity(null);
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

      const payload = parseQrPayload(rawValue, {
        origin: window.location.origin,
        appUrl: APP_URL,
      });

      if (payload?.kind === "gatopago") {
        navigate(payload.target);
        return;
      }

      if (payload?.kind === "evm-wallet") {
        setScannedWallet(payload);
        return;
      }

      setMessage(t("scan.unsupportedQr"));
    },
    [navigate, playDetectedFeedback, stopCamera, t],
  );

  const handleImportFile = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";

      if (!file) return;

      const canvas = canvasRef.current;
      if (!canvas) {
        setMessage(t("scan.readerError"));
        return;
      }

      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) {
        setMessage(t("scan.readerError"));
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

        const detectedFromJsQR = await decodeWithJsQR(
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

        setMessage(t("scan.qrReadError"));
      } catch (err) {
        console.error(err);
        setMessage(t("scan.imgAnalyzeError"));
      } finally {
        setIsImporting(false);
      }
    },
    [getOrCreateBarcodeDetector, handleQRResult, t],
  );

  useEffect(() => {
    // Mi QR tab: camera stays off (the previous run's cleanup stopped it).
    if (view !== "scan") return;
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

      // Live scanning targets GatoPago QRs (dark-on-white plaques): skipping the
      // inverted pass halves the per-frame decode cost.
      const fallbackResult = await decodeWithJsQR(
        video,
        sourceWidth,
        sourceHeight,
        canvas,
        ctx,
        MAX_LIVE_ANALYSIS_WIDTH,
        "dontInvert",
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
        setCameraError(t("scan.scannerInitError"));
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
          setCameraError(t("scan.cameraError"));
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
  }, [getOrCreateBarcodeDetector, handleQRResult, scannerVersion, stopCamera, t, view]);

  if (scannedWallet) {
    const requestedNetworkSupported =
      scannedWallet.chainId === null ||
      networkOptions.some((option) => option.id === scannedWallet.chainId);
    const sourceLabel = scannedWallet.source === "eip681"
      ? "EIP-681"
      : scannedWallet.source === "caip10"
        ? "CAIP-10"
        : t("scan.rawAddress");

    function continueWithWallet() {
      const query = new URLSearchParams({
        recipient: scannedWallet!.address,
        source: "qr",
      });
      if (selectedChainId === activeNetwork.chainId) {
        navigate(`/send?${query.toString()}`);
      } else {
        query.set("chainId", String(selectedChainId));
        navigate(`/crosschain?${query.toString()}`);
      }
    }

    return (
      <Screen>
        <BackHeader onClick={restartScanner} title={t("scan.reviewTitle")} />

        <MoneyPanel className="mb-5">
          <div className="flex items-center justify-between gap-3 mb-4">
            <span className={`meli-chip text-[10px] ${
              walletIdentity?.isGatoPago
				? "border-growth/25 bg-growth/10 text-growth"
                : "text-text-muted bg-surface-2 border-border"
            }`}>
              {walletIdentity === null
                ? t("scan.identifyingWallet")
                : walletIdentity.lookupFailed
                  ? t("scan.walletUnknown")
                  : walletIdentity.isGatoPago
                  ? t("scan.gatoPagoWallet")
                  : t("scan.externalWallet")}
            </span>
            <span className="text-[11px] text-text-faint">{sourceLabel}</span>
          </div>

          {walletIdentity?.username ? (
            <p className="text-[15px] text-text mb-2">@{walletIdentity.username}</p>
          ) : null}
          <p className="font-mono text-[13px] leading-relaxed break-all text-text-muted">
            {scannedWallet.address}
          </p>
        </MoneyPanel>

        <div className="mb-1">
		  <SectionLabel>{t("scan.chooseNetwork")}</SectionLabel>
          <p className="text-[12px] text-text-muted leading-relaxed mb-3">
            {t("scan.chooseNetworkHint")}
          </p>
          <NetworkChips
            options={networkOptions}
            selected={selectedChainId}
            onSelect={setSelectedChainId}
          />
        </div>

        {!requestedNetworkSupported ? (
		  <NoticeCard tone="warning" title={t("scan.walletUnknown")} className="mb-4">
		    {t("scan.unsupportedNetwork", { chainId: scannedWallet.chainId })}
		  </NoticeCard>
        ) : null}

		<NoticeCard title={t("scan.chooseNetwork")} className="mb-6">
		  {selectedChainId === activeNetwork.chainId
		    ? t("scan.sameNetworkHint", { network: activeNetwork.name })
		    : t("scan.crosschainHint")}
		</NoticeCard>

		<TransactionActions>
		  <button
		    onClick={continueWithWallet}
		    disabled={networksLoading}
		    className="btn btn-primary btn-block"
		  >
		    {networksLoading ? t("common.loading") : t("scan.continue")}
		  </button>
		  <button onClick={restartScanner} className="btn btn-ghost btn-block mt-3">
		    {t("scan.scanAnother")}
		  </button>
		</TransactionActions>
      </Screen>
    );
  }

  return (
    <Screen>
      <BackHeader title={t("scan.title")} />

      <div className="seg-track seg-track-block mb-5">
        {(["scan", "myqr"] as const).map((v) => (
          <button
            key={v}
            onClick={() => setView(v)}
            aria-pressed={view === v}
            data-active={view === v}
            className="seg-item"
          >
            {v === "scan" ? t("scan.tabScan") : t("scan.tabMyQr")}
          </button>
        ))}
      </div>

      {view === "myqr" ? (
        <div className="flex-1 flex flex-col items-center">
		  <MoneyPanel className="w-full max-w-[340px] p-6">
            {!profile ? (
              <p className="text-[13px] text-text-muted text-center py-10">{t("common.loading")}</p>
            ) : profile.username ? (
              <>
                <div className="flex justify-center mb-4">
                  <div className="border-2 border-text bg-white p-3 shadow-[6px_6px_0_var(--color-cat-700)]">
                    <QRCodeSVG
                      value={`${APP_URL}/${profile.username}`}
                      size={200}
                      bgColor="#ffffff"
                      fgColor="#0A0A0B"
                      level="M"
                    />
                  </div>
                </div>
                <p className="text-center font-display text-[18px] mb-1">@{profile.username}</p>
                <p className="text-[12px] text-text-muted text-center leading-relaxed">{t("scan.myQrHint")}</p>
              </>
            ) : profile.walletAddress ? (
              <AddressQRCard address={profile.walletAddress} qrSize={200} label={t("scan.myQrAddressHint")} />
            ) : (
              <p className="text-[13px] text-text-muted text-center py-10">{t("scan.myQrError")}</p>
            )}
		  </MoneyPanel>
        </div>
      ) : (
      <div className="flex-1 flex flex-col items-center">
        {cameraError ? (
		  <div className="mb-6 flex aspect-square w-full max-w-[340px] items-center justify-center overflow-hidden border-2 border-danger bg-surface px-8 text-center shadow-[6px_6px_0_var(--color-danger)]">
			<p className="text-[15px] text-danger">{cameraError}</p>
          </div>
        ) : (
          <div className="relative mb-6 aspect-square w-full max-w-[340px] overflow-hidden border-2 border-text bg-black shadow-[7px_7px_0_var(--color-cat-700)]">
            <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover" />

            {/* Brand scan frame */}
            <div className="pointer-events-none absolute inset-0">
			  <span className="absolute left-4 top-4 h-7 w-7 border-l-2 border-t-2 border-cat-500" />
			  <span className="absolute right-4 top-4 h-7 w-7 border-r-2 border-t-2 border-cat-500" />
			  <span className="absolute bottom-4 left-4 h-7 w-7 border-b-2 border-l-2 border-cat-500" />
			  <span className="absolute bottom-4 right-4 h-7 w-7 border-b-2 border-r-2 border-cat-500" />
              {!isImporting && (
                <div className="absolute inset-x-5 top-4 bottom-4 overflow-hidden">
                  {/* Full-height runner with a 2px gradient strip at its top:
                      translateY runs on the compositor, so the sweep stays
                      smooth even while jsQR is busy on the main thread. */}
				  <div className="scan-line h-full w-full animate-qr-scan" style={{ willChange: "transform" }} />
                </div>
              )}
            </div>

            {isImporting && (
              <div className="absolute inset-0 bg-canvas/75 backdrop-blur-sm flex items-center justify-center px-6">
                <p className="text-[14px] text-text text-center">{t("scan.analyzing")}</p>
              </div>
            )}
          </div>
        )}

        <canvas ref={canvasRef} className="hidden" />

		<p className={`min-h-10 text-center text-[14px] ${cameraError || message ? "text-danger" : "text-text-muted"}`}>
          {message || t("scan.aim")}
        </p>

        {(cameraError || message) && (
		  <button onClick={restartScanner} className="mt-1 text-[14px] font-semibold text-cat-300">
            {cameraError ? t("scan.retryCamera") : t("scan.scanAnother")}
          </button>
        )}

        <div className="mt-7 w-full max-w-[340px] flex flex-col gap-3">
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={isImporting}
            className="btn btn-primary btn-block"
          >
            {isImporting ? t("scan.analyzingShort") : t("scan.importFromImage")}
          </button>
          <button
            onClick={() => navigate("/send")}
            className="btn btn-ghost btn-block"
          >
            {t("scan.enterManually")}
          </button>
        </div>

        <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleImportFile} />
      </div>
      )}
    </Screen>
  );
}
